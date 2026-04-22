// ==UserScript==
// @name         Alerta-Fila
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  CR ATT
// @author       Ryan
// @match        *://centralderequisicoes-root.telemedicinaeinstein.com.br/*
// @match        *://centralderequisicoes-root-qas.telemedicinaeinstein.com.br/*
// @run-at       document-end
// @grant        none
// @downloadURL   https://raw.githubusercontent.com/ryanrn/central-requisi-es-nova/main/Alerta-Fila-2.4.user.js
// @updateURL     https://raw.githubusercontent.com/ryanrn/central-requisi-es-nova/main/Alerta-Fila-2.4.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ========================
    // === CONFIGURAÇÕES
    // ========================
    const VERSAO                 = '2.4';
    const QUANTIDADE_DE_BEEPS    = 3;
    const BEEP_INTERVAL_MS       = 1000;
    const soundUrl               = 'https://actions.google.com/sounds/v1/alarms/beep_short.ogg';
    const TIME_SLA_SECONDS       = 60;
    const TIME_30S_SECONDS       = 30;
    const CHECK_INTERVAL_MS      = 2000;
    const PERSISTENT_INTERVAL_MS = 5000;
    const HISTORY_MAX_AGE_MS     = 4 * 60 * 60 * 1000;   // 4h
    const CLEANUP_INTERVAL_MS    = 5 * 60 * 1000;         // 5min

    // [v2.4] Após este tempo a partir de quando o alerta persistente foi
    // ADICIONADO (não do SLA), ele para sozinho para a sessão atual.
    // Na TV, cada reload de 30s re-adiciona o alerta, então continua alertando.
    // Em uso normal, para em 2 minutos — evita o loop infinito do feedback.
    const PERSISTENT_SESSION_MAX_MS = 2 * 60 * 1000;     // 2 min por sessão

    // [v2.4] Ao carregar a página, restaura SLA ativo do histórico
    // apenas se o SLA foi disparado há menos de X minutos.
    // Garante que a TV continue alertando após o reload de 30s.
    const SLA_RESTORE_MAX_AGE_MS = 10 * 60 * 1000;       // 10 min

    const ROW_SELECTORS = [
        '.sc-bXWnss.ehsfmy',
        '.ehsfmy',
        'tr.QueueItem',
        '.QueueItem'
    ];

    // ========================
    // === ESTADO
    // ========================
    let audioEnabled         = false;
    let attendedCheckEnabled = false;
    let isPanelVisible       = true;
    let volume               = 1.0;
    let activeSelector       = null;

    let previousPids         = new Set();
    let isFirstCycle         = true;

    let patientAlertHistory  = {};
    let alertQueue           = [];
    let isProcessingQueue    = false;
    let currentPidMap        = new Map();

    let persistentAlerts         = new Map();
    let persistentVisualElements = new Map();
    let persistentAlertInterval  = null;

    let dailyStats  = { atendidosHoje: 0, slaEstourados: 0 };
    let dashboardEl = null;
    let eventLog    = [];

    // [v2.4] Áudio simplificado: apenas new Audio() + keep-alive direto
    let keepAliveAudio   = null;
    let keepAliveStarted = false;

    let titleFlashInterval = null;
    const originalTitle    = document.title;

    // ========================
    // === BADGE DE VERSÃO
    // ========================
    (function badge() {
        const b = document.createElement('div');
        b.textContent = `Alerta Fila v${VERSAO} ✅`;
        Object.assign(b.style, {
            position: 'fixed', left: '12px', bottom: '12px', zIndex: 999999,
            background: 'rgba(0,0,0,.85)', color: '#fff',
            padding: '6px 12px', borderRadius: '10px',
            fontSize: '12px', fontWeight: '700', pointerEvents: 'none'
        });
        document.body.appendChild(b);
        setTimeout(() => b.remove(), 4000);
    })();

    (function injectCss() {
        const s = document.createElement('style');
        s.textContent = `
            @keyframes persistentPulse {
                0%,100% { transform:scale(1); box-shadow:0 4px 20px rgba(197,11,11,.5); }
                50%      { transform:scale(1.03); box-shadow:0 6px 28px rgba(197,11,11,.8); }
            }
            @keyframes slideDown {
                from { opacity:0; top:0px; }
                to   { opacity:1; top:14px; }
            }
            @keyframes fadeIn {
                from { opacity:0; transform:translateY(-6px); }
                to   { opacity:1; transform:translateY(0); }
            }
        `;
        document.head.appendChild(s);
    })();

    // ========================
    // === SELETOR ROBUSTO
    // ========================
    function getRowNodes() {
        for (const sel of ROW_SELECTORS) {
            const nodes = document.querySelectorAll(sel);
            if (nodes.length > 0) {
                if (activeSelector !== sel) {
                    activeSelector = sel;
                    console.log(`[Fila v${VERSAO}] ✅ Seletor ativo: "${sel}" (${nodes.length} itens)`);
                }
                return Array.from(nodes);
            }
        }
        if (activeSelector !== null) {
            console.warn(`[Fila v${VERSAO}] ⚠️ Nenhum seletor encontrou linhas.`);
            activeSelector = null;
        }
        return [];
    }

    // ========================
    // === EXTRAÇÃO DE DADOS
    // ========================
    function getPatientName(node) {
        const el = node.querySelector('.sc-dUWDJJ.kJwCqO p.sc-eqUAAy.kFxsPh');
        if (el) return el.textContent.trim();
        const IGNORE = new Set([
            'Produto','Contrato','Espera recepção','Masculino','Feminino','|',
            'Aps Digital','Aps Digital Assinatura',''
        ]);
        for (const p of node.querySelectorAll('p[data-variant="placeholder200"]')) {
            const t = p.textContent.trim();
            if (!IGNORE.has(t) && !/^\d/.test(t) && !/\d{2}:\d{2}/.test(t) && t.length > 3)
                return t;
        }
        const old = node.querySelector('#profileName');
        return old ? old.textContent.trim() : null;
    }

    function getPatientDocument(node) {
        const c = node.querySelector('.sc-aNeao.hVGonf');
        if (c) {
            const el = c.querySelector('p.sc-eqUAAy.dVxBaO');
            if (el) return el.textContent.trim();
        }
        for (const p of node.querySelectorAll('p')) {
            const t = p.textContent.trim();
            if (/^\d{11}$/.test(t) || /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(t)) return t;
        }
        return null;
    }

    function getWaitingTime(node) {
        const badge = node.querySelector('[data-zds-id="ZdsBadge"] span');
        if (badge) {
            const m = badge.textContent.trim().match(/\d{1,2}:\d{2}(:\d{2})?/);
            if (m) return m[0];
        }
        const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
        for (const el of node.querySelectorAll('span, p')) {
            const t = el.textContent.trim();
            if (TIME_RE.test(t)) return t;
        }
        return null;
    }

    function isPatientBeingAttended(node) {
        if (!attendedCheckEnabled) return false;
        const statusEl = node.querySelector(
            '.VirtualReceptionStatus p.sc-eqUAAy.dVxBaO, ' +
            '.sc-inyXkq.hkEliH p.sc-eqUAAy.dVxBaO'
        );
        if (statusEl) {
            const t = statusEl.textContent.trim().toLowerCase();
            if (t && t !== 'espera recepção' && t !== '-') return true;
        }
        return false;
    }

    function getPatientId(node) {
        const name = getPatientName(node);
        if (!name) return null;
        const doc = getPatientDocument(node);
        if (!doc) return `${name}|noDoc`;
        return `${name}|${doc}`;
    }

    function toSeconds(t) {
        if (!t) return 0;
        const p = t.split(':').map(Number);
        if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
        if (p.length === 2) return p[0] * 60 + p[1];
        return 0;
    }

    // ========================
    // === ÁUDIO (v2.4)
    //
    // ABORDAGEM SIMPLIFICADA:
    // - primeAudio(): toca 1x em volume baixo para desbloquear autoplay,
    //   depois inicia keep-alive em loop silencioso usando o MESMO
    //   mecanismo (new Audio), sem depender de AudioContext/WAV/Blob.
    // - Keep-alive: new Audio(soundUrl) em loop com volume 0.
    //   Mantém a permissão de autoplay ativa e evita throttling da aba.
    // - playBeeps(): new Audio(soundUrl) — funciona em background
    //   desde que o keep-alive esteja rodando.
    // ========================

    function primeAudio() {
        const unlock = new Audio(soundUrl);
        unlock.volume = 0.01;
        unlock.play()
            .then(() => {
                unlock.pause();
                unlock.currentTime = 0;
                console.log(`[Fila v${VERSAO}] 🔊 Áudio desbloqueado.`);
                startKeepAlive();
            })
            .catch(err => {
                console.warn(`[Fila v${VERSAO}] ⚠️ primeAudio falhou (sem interação?):`, err.message);
                // Tenta novamente na primeira interação do usuário com a página
                const retry = () => {
                    document.removeEventListener('click',   retry);
                    document.removeEventListener('keydown', retry);
                    primeAudio();
                };
                document.addEventListener('click',   retry, { once: true });
                document.addEventListener('keydown', retry, { once: true });
            });
    }

    function startKeepAlive() {
        if (keepAliveStarted) return;
        keepAliveAudio = new Audio(soundUrl);
        keepAliveAudio.loop   = true;
        keepAliveAudio.volume = 0;        // silencioso — só mantém permissão ativa
        keepAliveAudio.play()
            .then(() => {
                keepAliveStarted = true;
                console.log(`[Fila v${VERSAO}] 🔇 Keep-alive silencioso iniciado.`);
            })
            .catch(err => {
                console.warn(`[Fila v${VERSAO}] Keep-alive falhou:`, err.message);
            });
    }

    function stopKeepAlive() {
        if (keepAliveAudio) { keepAliveAudio.pause(); keepAliveAudio = null; }
        keepAliveStarted = false;
    }

    function playBeeps(vol) {
        if (!audioEnabled) return;
        const v = typeof vol === 'number' ? vol : volume;
        console.log(`[Fila v${VERSAO}] 🔊 Beep x${QUANTIDADE_DE_BEEPS} vol=${v}`);
        for (let i = 0; i < QUANTIDADE_DE_BEEPS; i++) {
            setTimeout(() => {
                const a = new Audio(soundUrl);
                a.volume = v;
                a.play().catch(err => {
                    console.warn(`[Fila v${VERSAO}] Beep falhou:`, err.message);
                    // keep-alive pode ter morrido — tenta reativar
                    if (!keepAliveStarted) startKeepAlive();
                });
            }, i * BEEP_INTERVAL_MS);
        }
    }

    // ========================
    // === NOTIFICAÇÕES BROWSER
    // ========================
    async function requestNotificationPermission() {
        if (!('Notification' in window)) return 'unsupported';
        if (Notification.permission !== 'default') return Notification.permission;
        try { return await Notification.requestPermission(); }
        catch (e) { return 'error'; }
    }

    function showBrowserNotification(title, body, tag) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        try {
            const n = new Notification(title, {
                body, tag: tag || 'fila-alerta', renotify: true,
                requireInteraction: false,
                icon: 'https://centralderequisicoes-root.telemedicinaeinstein.com.br/favicon.ico'
            });
            n.onclick = () => { window.focus(); n.close(); };
            setTimeout(() => n.close(), 8000);
        } catch (_) {}
    }

    // ========================
    // === PISCADA NO TÍTULO
    // ========================
    function startTitleFlash(text) {
        if (titleFlashInterval) clearInterval(titleFlashInterval);
        let t = false;
        titleFlashInterval = setInterval(() => {
            document.title = t ? `🚨 ${text}` : originalTitle;
            t = !t;
        }, 800);
    }

    function stopTitleFlash() {
        if (titleFlashInterval) { clearInterval(titleFlashInterval); titleFlashInterval = null; }
        document.title = originalTitle;
    }

    document.addEventListener('visibilitychange', () => { if (!document.hidden) stopTitleFlash(); });

    // ========================
    // === NOTIFICAÇÕES VISUAIS
    // ========================
    let bannerTimeout = null;

    function showTopBanner(icon, title, subtitle, bgColor) {
        const old = document.getElementById('fila_topbanner');
        if (old) old.remove();
        if (bannerTimeout) clearTimeout(bannerTimeout);
        const n = document.createElement('div');
        n.id = 'fila_topbanner';
        Object.assign(n.style, {
            position:'fixed', top:'14px', left:'50%', transform:'translateX(-50%)',
            background:bgColor, color:'#fff', padding:'14px 28px',
            borderRadius:'14px', fontSize:'15px', fontWeight:'800',
            zIndex:1000002, boxShadow:'0 8px 28px rgba(0,0,0,.30)',
            textAlign:'center', animation:'slideDown .2s ease forwards',
            minWidth:'260px', pointerEvents:'none'
        });
        n.innerHTML = `
            <div style="font-size:26px;margin-bottom:4px;">${icon}</div>
            <div>${title}</div>
            ${subtitle ? `<div style="font-size:12px;opacity:.85;margin-top:2px;">${subtitle}</div>` : ''}
        `;
        document.body.appendChild(n);
        bannerTimeout = setTimeout(() => { if (n.parentNode) n.remove(); }, 3500);
    }

    function showToast(msg, color) {
        const old = document.getElementById('fila_toast');
        if (old) old.remove();
        const n = document.createElement('div');
        n.id = 'fila_toast';
        n.textContent = msg;
        Object.assign(n.style, {
            position:'fixed', top:'14px', left:'50%', transform:'translateX(-50%)',
            background:color||'#333', color:'#fff', padding:'10px 20px',
            borderRadius:'10px', fontSize:'13px', fontWeight:'700',
            zIndex:1000003, pointerEvents:'none', animation:'fadeIn .2s ease forwards'
        });
        document.body.appendChild(n);
        setTimeout(() => { if (n.parentNode) n.remove(); }, 2000);
    }

    // ========================
    // === LOG / ESTADO
    // ========================
    function logEvent(name, type, detail) {
        eventLog.push({ ts: Date.now(), name, type, detail });
        if (eventLog.length > 500) eventLog = eventLog.slice(-500);
    }

    function loadState() {
        try {
            audioEnabled         = localStorage.getItem('fila_audio') === 'true';
            attendedCheckEnabled = localStorage.getItem('fila_attended') === 'true';
            isPanelVisible       = localStorage.getItem('fila_panel') !== 'false';
            const v = parseFloat(localStorage.getItem('fila_vol') || '1');
            volume = isNaN(v) ? 1 : Math.max(0, Math.min(1, v));

            const rawStats = localStorage.getItem('fila_stats');
            if (rawStats) {
                const p = JSON.parse(rawStats);
                dailyStats = p.date === new Date().toDateString()
                    ? p.stats
                    : { atendidosHoje: 0, slaEstourados: 0 };
            }

            const hist = localStorage.getItem('fila_hist');
            if (hist) {
                const raw  = JSON.parse(hist);
                const now  = Date.now();
                const today = new Date().toDateString();
                const clean = {};
                for (const [pid, entry] of Object.entries(raw)) {
                    if ((now - (entry.firstSeen || 0)) < HISTORY_MAX_AGE_MS && entry.date === today)
                        clean[pid] = entry;
                }
                patientAlertHistory = clean;
                const removed = Object.keys(raw).length - Object.keys(clean).length;
                if (removed > 0) console.log(`[Fila v${VERSAO}] 🧹 ${removed} entradas antigas removidas.`);
            }
        } catch (e) {
            console.warn(`[Fila v${VERSAO}] Erro ao carregar estado:`, e);
        }
    }

    function saveState() {
        try {
            localStorage.setItem('fila_audio',    String(audioEnabled));
            localStorage.setItem('fila_attended', String(attendedCheckEnabled));
            localStorage.setItem('fila_panel',    String(isPanelVisible));
            localStorage.setItem('fila_vol',      String(volume));
        } catch (_) {}
    }

    function saveStats() {
        try {
            localStorage.setItem('fila_stats', JSON.stringify({
                date: new Date().toDateString(), stats: dailyStats
            }));
        } catch (_) {}
    }

    function saveHistory() {
        try { localStorage.setItem('fila_hist', JSON.stringify(patientAlertHistory)); }
        catch (_) {}
    }

    function cleanOldHistory() {
        const now   = Date.now();
        const today = new Date().toDateString();
        let removed = 0;
        for (const [pid, entry] of Object.entries(patientAlertHistory)) {
            if ((now - (entry.firstSeen || 0)) > HISTORY_MAX_AGE_MS || entry.date !== today) {
                delete patientAlertHistory[pid];
                removed++;
            }
        }
        if (removed > 0) { console.log(`[Fila v${VERSAO}] 🧹 Limpeza: ${removed} removidas.`); saveHistory(); }
    }

    function resetTudo() {
        dailyStats = { atendidosHoje: 0, slaEstourados: 0 };
        patientAlertHistory = {};
        previousPids  = new Set();
        isFirstCycle  = true;
        saveStats();
        saveHistory();
        updateDashboard();
    }

    function updateDashboard() {
        if (!dashboardEl) return;
        const notifStatus = !('Notification' in window)
            ? '<span style="color:#e65100;">❌ N/A</span>'
            : Notification.permission === 'granted'
                ? '<span style="color:#2e7d32;">✅ Ativo</span>'
                : Notification.permission === 'denied'
                    ? '<span style="color:#c50b0b;">🚫 Bloqueado</span>'
                    : '<span style="color:#e65100;">⚠️ Pendente</span>';
        dashboardEl.innerHTML = `
            <div style="font-size:12px;color:#666;margin-bottom:8px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">📊 Estatísticas de Hoje</div>
            <div style="display:flex;justify-content:space-around;margin-bottom:8px;">
                <div style="text-align:center;">
                    <div style="font-size:28px;font-weight:900;color:#0096D2;">${dailyStats.atendidosHoje}</div>
                    <div style="font-size:11px;color:#888;">Atendidos</div>
                </div>
                <div style="text-align:center;">
                    <div style="font-size:28px;font-weight:900;color:#c50b0b;">${dailyStats.slaEstourados}</div>
                    <div style="font-size:11px;color:#888;">SLA Crítico</div>
                </div>
            </div>
            <div style="font-size:11px;color:#666;border-top:1px solid #eee;padding-top:6px;">
                🔔 Notificações: ${notifStatus}
            </div>
        `;
    }

    // ========================
    // === ALERTAS PERSISTENTES (v2.4)
    //
    // Cada entrada agora tem `addedAt` (momento em que foi criada
    // nesta sessão). Após PERSISTENT_SESSION_MAX_MS (2min) sem que
    // o paciente saia ou seja atendido, o alerta para NESTA sessão.
    //
    // Na TV (reload a cada 30s): a cada reload, `addedAt` é
    // resetado via restorePersistentAlertsFromHistory(), então os
    // alertas continuam enquanto o SLA estiver ativo.
    //
    // Em uso normal: para em até 2 min — evita o "não parava de tocar".
    // ========================

    function addPersistentAlert(pid, name, time) {
        persistentAlerts.set(pid, {
            name,
            time,
            lastAlert: Date.now(),
            addedAt:   Date.now()     // [v2.4] marca início desta sessão
        });
        console.log(`[Fila v${VERSAO}] 🚨 Alerta persistente: "${name}"`);
        if (!persistentAlertInterval) startPersistent();
    }

    function removePersistentAlert(pid) {
        persistentAlerts.delete(pid);
        if (persistentVisualElements.has(pid)) {
            persistentVisualElements.get(pid).remove();
            persistentVisualElements.delete(pid);
        }
        if (persistentAlerts.size === 0) stopPersistent();
    }

    function startPersistent() {
        persistentAlertInterval = setInterval(() => {
            if (!audioEnabled || persistentAlerts.size === 0) return;
            const now = Date.now();
            persistentAlerts.forEach((data, pid) => {

                // [v2.4] FIX RUNAWAY: para após PERSISTENT_SESSION_MAX_MS
                // (2 minutos) na mesma sessão, mesmo sem detecção de atendimento.
                if (now - data.addedAt > PERSISTENT_SESSION_MAX_MS) {
                    console.log(`[Fila v${VERSAO}] ⏰ Alerta persistente expirou (2min): "${data.name}"`);
                    removePersistentAlert(pid);
                    return;
                }

                // Para se o paciente sumiu do DOM ou está sendo atendido
                const node = currentPidMap.get(pid) || null;
                if (!node || isPatientBeingAttended(node)) {
                    console.log(`[Fila v${VERSAO}] ✅ Alerta persistente removido: "${data.name}"`);
                    removePersistentAlert(pid);
                    return;
                }

                if (now - data.lastAlert >= PERSISTENT_INTERVAL_MS) {
                    data.lastAlert = now;
                    playBeeps(volume * 0.7);
                    showPersistentCard(pid, data.name);
                    showBrowserNotification(
                        `🚨 SLA CRÍTICO — ${data.name}`,
                        `Aguardando há mais de ${TIME_SLA_SECONDS}s`,
                        `sla-${pid}`
                    );
                    if (document.hidden) startTitleFlash(`SLA: ${data.name}`);
                }
            });
        }, 1500);
    }

    function stopPersistent() {
        clearInterval(persistentAlertInterval);
        persistentAlertInterval = null;
        persistentVisualElements.forEach(v => v.remove());
        persistentVisualElements.clear();
        stopTitleFlash();
    }

    function showPersistentCard(pid, name) {
        if (persistentVisualElements.has(pid)) persistentVisualElements.get(pid).remove();
        const el = document.createElement('div');
        Object.assign(el.style, {
            position:'fixed', top:'80px', right:'14px',
            background:'linear-gradient(135deg,#c50b0b,#ff4444)',
            color:'#fff', padding:'14px 18px', borderRadius:'12px',
            fontSize:'14px', fontWeight:'800', zIndex:1000000,
            border:'2px solid rgba(255,255,255,.25)', minWidth:'240px',
            animation:'persistentPulse 2s infinite', pointerEvents:'none'
        });
        el.innerHTML = `
            <div style="font-size:18px;">🚨 SLA CRÍTICO</div>
            <div style="font-size:12px;margin-top:4px;opacity:.9;">${name}</div>
        `;
        document.body.appendChild(el);
        persistentVisualElements.set(pid, el);
        setTimeout(() => {
            if (persistentVisualElements.get(pid) === el) {
                el.remove(); persistentVisualElements.delete(pid);
            }
        }, 20000);
    }

    // ========================
    // === RESTAURAÇÃO DE SLA APÓS RELOAD (v2.4)
    //
    // Chamado após loadState(). Verifica o histórico salvo:
    // pacientes com alerted60=true, wasAttended=false e SLA
    // disparado há menos de SLA_RESTORE_MAX_AGE_MS (10min)
    // são re-adicionados ao mapa de alertas persistentes.
    //
    // Garante que a TV continue alertando após o reload de 30s:
    // cada reload re-adiciona o alerta com addedAt=agora,
    // recomeçando o timer de 2 min.
    // ========================
    function restorePersistentAlertsFromHistory() {
        const now   = Date.now();
        let restored = 0;
        for (const [pid, entry] of Object.entries(patientAlertHistory)) {
            if (!entry.alerted60 || entry.wasAttended) continue;
            const slaAge = now - (entry.alerted60At || 0);
            if (slaAge < SLA_RESTORE_MAX_AGE_MS) {
                const name = pid.split('|')[0];
                addPersistentAlert(pid, name, '');
                restored++;
            }
        }
        if (restored > 0)
            console.log(`[Fila v${VERSAO}] 🔄 ${restored} alerta(s) SLA restaurados do histórico (TV reload).`);
    }

    // ========================
    // === FILA DE ALERTAS
    // ========================
    function enqueue(kind, name, time) {
        alertQueue.push({ kind, name, time });
        if (!isProcessingQueue) drainQueue();
    }

    function drainQueue() {
        if (alertQueue.length === 0) { isProcessingQueue = false; return; }
        isProcessingQueue = true;
        const a = alertQueue.shift();
        playBeeps(volume);
        if (a.kind === 'novo') {
            showTopBanner('🆕', 'Novo paciente na fila!', a.name, '#2e7d32');
            showBrowserNotification('🆕 Novo paciente na fila!', a.name || '', 'novo-paciente');
            if (document.hidden) startTitleFlash('Novo paciente!');
        } else if (a.kind === '30s') {
            showTopBanner('⚠️', a.name, `Aguardando: ${a.time}`, '#e65100');
            showBrowserNotification(`⚠️ Atenção — ${a.name}`, `Aguardando há ${a.time}`, `alerta30-${a.name}`);
            if (document.hidden) startTitleFlash(`Atenção: ${a.name}`);
        } else if (a.kind === '60s') {
            showTopBanner('🚨', `SLA — ${a.name}`, `Tempo: ${a.time}`, '#b71c1c');
            showBrowserNotification(`🚨 SLA ESTOURADO — ${a.name}`, `Aguardando: ${a.time}`, `sla60-${a.name}`);
            if (document.hidden) startTitleFlash(`SLA: ${a.name}`);
        }
        setTimeout(() => drainQueue(), QUANTIDADE_DE_BEEPS * BEEP_INTERVAL_MS + 500);
    }

    // ========================
    // === MONITORAMENTO PRINCIPAL
    // ========================
    function checkWaitTimes() {
        const rows = getRowNodes();
        if (rows.length === 0) return;

        currentPidMap = new Map();
        const currentPids = new Set();
        rows.forEach(node => {
            const pid = getPatientId(node);
            if (!pid) return;
            currentPidMap.set(pid, node);
            currentPids.add(pid);
        });

        // Detecção de novos pacientes
        if (!isFirstCycle) {
            currentPids.forEach(pid => {
                if (!previousPids.has(pid) && !patientAlertHistory[pid]) {
                    const name = getPatientName(currentPidMap.get(pid));
                    patientAlertHistory[pid] = {
                        alerted30: false, alerted60: false,
                        wasAttended: false,
                        firstSeen: Date.now(),
                        date: new Date().toDateString()
                    };
                    enqueue('novo', name || pid, '');
                    logEvent(name, 'novo', pid);
                    console.log(`[Fila v${VERSAO}] 🆕 Novo paciente: "${name}"`);
                }
            });
        } else {
            currentPids.forEach(pid => {
                if (!patientAlertHistory[pid]) {
                    patientAlertHistory[pid] = {
                        alerted30: false, alerted60: false,
                        wasAttended: false,
                        firstSeen: Date.now(),
                        date: new Date().toDateString()
                    };
                }
            });
            isFirstCycle = false;
            console.log(`[Fila v${VERSAO}] 🔒 Carga inicial: ${currentPids.size} paciente(s).`);
        }

        previousPids = currentPids;

        // Verifica tempos de espera
        rows.forEach(node => {
            const pid  = getPatientId(node);
            const name = getPatientName(node);
            const time = getWaitingTime(node);
            if (!pid || !name) return;

            if (!patientAlertHistory[pid]) {
                patientAlertHistory[pid] = {
                    alerted30: false, alerted60: false,
                    wasAttended: false,
                    firstSeen: Date.now(),
                    date: new Date().toDateString()
                };
                return;
            }

            const h = patientAlertHistory[pid];

            // FIX v2.2: mantém entrada com wasAttended=true para evitar loop
            if (h.wasAttended) return;
            if (!time) return;

            const attended = isPatientBeingAttended(node);
            const secs     = toSeconds(time);

            if (attended) {
                h.wasAttended = true;
                dailyStats.atendidosHoje++;
                saveStats();
                updateDashboard();
                removePersistentAlert(pid);
                saveHistory();
                console.log(`[Fila v${VERSAO}] ✅ Atendido: "${name}"`);
                return;
            }

            if (secs >= TIME_SLA_SECONDS && !h.alerted60) {
                h.alerted60   = true;
                h.alerted60At = Date.now();   // [v2.4] salva timestamp para restauração
                dailyStats.slaEstourados++;
                saveStats();
                updateDashboard();
                enqueue('60s', name, time);
                addPersistentAlert(pid, name, time);
                logEvent(name, 'sla60', time);
                saveHistory();
                console.log(`[Fila v${VERSAO}] 🚨 SLA 60s: "${name}" — ${time}`);
            } else if (secs >= TIME_30S_SECONDS && secs < TIME_SLA_SECONDS && !h.alerted30) {
                h.alerted30 = true;
                enqueue('30s', name, time);
                logEvent(name, 'alerta30', time);
                console.log(`[Fila v${VERSAO}] ⚠️ 30s: "${name}" — ${time}`);
            }
        });

        saveHistory();
    }

    // ========================
    // === DEBUG (Ctrl+Alt+D)
    // ========================
    function printDebugState() {
        console.group(`[Fila v${VERSAO}] 🔍 Estado`);
        console.log('audioEnabled:', audioEnabled, '| volume:', volume);
        console.log('keepAliveStarted:', keepAliveStarted, '| paused:', keepAliveAudio?.paused);
        console.log('attendedCheckEnabled:', attendedCheckEnabled);
        console.log('isFirstCycle:', isFirstCycle);
        console.log('previousPids:', [...previousPids]);
        console.log('persistentAlerts:', [...persistentAlerts.entries()]);
        console.log('patientAlertHistory:', JSON.parse(JSON.stringify(patientAlertHistory)));
        console.log('dailyStats:', dailyStats);
        console.log('Notification.permission:', ('Notification' in window) ? Notification.permission : 'N/A');
        console.groupEnd();
    }

    // ========================
    // === PAINEL
    // ========================
    function mkToggle(label, id, checked, onChange) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin:8px 0;';
        const lbl = document.createElement('span');
        lbl.textContent = label;
        lbl.style.cssText = 'font-size:13px;color:#333;font-weight:600;';
        const wrap = document.createElement('label');
        wrap.style.cssText = 'position:relative;display:inline-block;width:48px;height:24px;cursor:pointer;';
        const inp = document.createElement('input');
        inp.type = 'checkbox'; inp.id = id; inp.checked = checked;
        inp.style.cssText = 'opacity:0;width:0;height:0;';
        const track = document.createElement('span');
        track.style.cssText = `position:absolute;inset:0;background:${checked?'#0096D2':'#ccc'};border-radius:24px;transition:.3s;`;
        const knob = document.createElement('span');
        knob.style.cssText = `position:absolute;width:18px;height:18px;border-radius:50%;background:#fff;bottom:3px;left:${checked?'27px':'3px'};transition:.3s;`;
        track.appendChild(knob);
        wrap.appendChild(inp);
        wrap.appendChild(track);
        inp.addEventListener('change', () => {
            track.style.background = inp.checked ? '#0096D2' : '#ccc';
            knob.style.left = inp.checked ? '27px' : '3px';
            onChange(inp);
        });
        row.appendChild(lbl);
        row.appendChild(wrap);
        return row;
    }

    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = 'tm_fila_panel';
        Object.assign(panel.style, {
            position:'fixed', top:'12px', right:'12px', width:'290px',
            background:'#fff', border:'2px solid #e0e0e0', borderRadius:'16px',
            padding:'18px', zIndex:999998,
            boxShadow:'0 8px 32px rgba(0,0,0,.14)',
            fontFamily:'"Segoe UI",Roboto,Arial,sans-serif'
        });

        // Cabeçalho
        const hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding-bottom:12px;border-bottom:2px solid #eee;';
        hdr.innerHTML = `
            <span style="font-size:16px;font-weight:900;color:#0096D2;">
                🔔 Alerta Fila
                <span style="font-size:12px;background:#e3f2fd;color:#0096D2;padding:2px 7px;border-radius:20px;margin-left:4px;">v${VERSAO}</span>
            </span>
            <button id="fila_min" style="background:#f0f0f0;border:none;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:14px;" title="Ctrl+Alt+F">➖</button>
        `;
        panel.appendChild(hdr);

        // Dashboard
        dashboardEl = document.createElement('div');
        dashboardEl.style.cssText = 'background:#f8f8f8;padding:12px;border-radius:10px;margin-bottom:14px;';
        panel.appendChild(dashboardEl);
        updateDashboard();

        // Toggles
        const ctrl = document.createElement('div');
        ctrl.appendChild(mkToggle('🔊 Áudio', 'fila_audio', audioEnabled, inp => {
            audioEnabled = inp.checked;
            saveState();
            if (audioEnabled) {
                primeAudio();
                showToast('🔊 Áudio ativado', '#0096D2');
            } else {
                stopPersistent();
                stopKeepAlive();
                showToast('🔇 Áudio desativado', '#e65100');
            }
        }));
        ctrl.appendChild(mkToggle('👤 Verificar Atendidos', 'fila_att', attendedCheckEnabled, inp => {
            attendedCheckEnabled = inp.checked;
            saveState();
            showToast(inp.checked ? '✅ Verificação ON' : '❌ Verificação OFF', '#333');
        }));
        panel.appendChild(ctrl);

        // Volume
        const volRow = document.createElement('div');
        volRow.style.cssText = 'margin:12px 0 4px;';
        volRow.innerHTML = `
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="font-size:12px;font-weight:700;color:#555;">🔉 Volume</span>
                <span id="fila_vol_label" style="font-size:12px;color:#0096D2;font-weight:700;">${Math.round(volume*100)}%</span>
            </div>
            <input id="fila_vol_slider" type="range" min="0" max="100" value="${Math.round(volume*100)}"
                style="width:100%;accent-color:#0096D2;cursor:pointer;">
        `;
        panel.appendChild(volRow);
        setTimeout(() => {
            const sl = document.getElementById('fila_vol_slider');
            const lb = document.getElementById('fila_vol_label');
            if (sl && lb) sl.addEventListener('input', () => {
                volume = sl.value / 100;
                lb.textContent = `${sl.value}%`;
                saveState();
            });
        }, 0);

        // Botões
        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:14px;';
        const bs = 'border:none;border-radius:9px;padding:10px;font-size:13px;font-weight:800;cursor:pointer;width:100%;color:#fff;';

        // Notificações nativas
        const notifPerm = ('Notification' in window) ? Notification.permission : 'unsupported';
        const bNotif = document.createElement('button');
        bNotif.textContent = notifPerm === 'granted' ? '✅ Notificações Ativas'
            : notifPerm === 'denied' ? '🚫 Notificações Bloqueadas'
            : '🔔 Ativar Notificações';
        bNotif.style.cssText = bs + (notifPerm === 'granted'
            ? 'background:linear-gradient(135deg,#2e7d32,#43a047);'
            : notifPerm === 'denied'
                ? 'background:linear-gradient(135deg,#757575,#9e9e9e);cursor:not-allowed;'
                : 'background:linear-gradient(135deg,#f57c00,#ffa726);');
        bNotif.onclick = async () => {
            if (Notification.permission === 'denied') { showToast('🚫 Desbloqueie nas configurações do browser', '#c50b0b'); return; }
            const r = await requestNotificationPermission();
            if (r === 'granted') {
                bNotif.textContent = '✅ Notificações Ativas';
                bNotif.style.background = 'linear-gradient(135deg,#2e7d32,#43a047)';
                updateDashboard();
                showToast('✅ Notificações ativadas!', '#2e7d32');
                showBrowserNotification('🔔 Alerta Fila', 'Notificações ativadas!', 'teste');
            } else { showToast('⚠️ Permissão negada', '#e65100'); }
        };
        btns.appendChild(bNotif);

        // Testar som
        const bTest = document.createElement('button');
        bTest.textContent = '🔊 Testar Som';
        bTest.style.cssText = bs + 'background:linear-gradient(135deg,#0096D2,#00539A);';
        bTest.onclick = () => {
            if (!audioEnabled) { showToast('⚠️ Ative o áudio primeiro!', '#e65100'); return; }
            playBeeps(volume);
            showToast('🔊 Testando...', '#0096D2');
        };
        btns.appendChild(bTest);

        // Simular alertas
        const bSim = document.createElement('button');
        bSim.textContent = '🧪 Simular Alertas';
        bSim.style.cssText = bs + 'background:linear-gradient(135deg,#7b1fa2,#ab47bc);';
        bSim.onclick = () => {
            if (!audioEnabled) { showToast('⚠️ Ative o áudio primeiro!', '#e65100'); return; }
            showToast('🧪 Simulando...', '#7b1fa2');
            setTimeout(() => enqueue('novo',  'Paciente Teste', ''),      200);
            setTimeout(() => enqueue('30s',   'Paciente Teste', '00:30'), 4500);
            setTimeout(() => enqueue('60s',   'Paciente Teste', '01:00'), 9000);
            setTimeout(() => {
                addPersistentAlert('__sim__', 'Paciente Teste', '01:00');
                setTimeout(() => removePersistentAlert('__sim__'), 10000);
            }, 13500);
        };
        btns.appendChild(bSim);

        // Resetar tudo
        const bReset = document.createElement('button');
        bReset.textContent = '🔄 Resetar Estatísticas e Histórico';
        bReset.style.cssText = bs + 'background:linear-gradient(135deg,#ff6b35,#f7931e);';
        bReset.onclick = () => {
            if (confirm('Resetar estatísticas do dia e limpar histórico de pacientes?')) {
                resetTudo();
                showToast('✅ Resetado!', '#2e7d32');
            }
        };
        btns.appendChild(bReset);

        panel.appendChild(btns);

        const hint = document.createElement('div');
        hint.style.cssText = 'margin-top:12px;font-size:10px;color:#aaa;text-align:center;';
        hint.textContent = 'Ctrl+Alt+F = painel | Ctrl+Alt+S = parar alertas | Ctrl+Alt+D = debug';
        panel.appendChild(hint);

        document.body.appendChild(panel);

        document.getElementById('fila_min').onclick = () => {
            isPanelVisible = !isPanelVisible;
            saveState();
            panel.style.display = isPanelVisible ? 'block' : 'none';
        };
        panel.style.display = isPanelVisible ? 'block' : 'none';

        document.addEventListener('keydown', e => {
            if (!e.ctrlKey || !e.altKey) return;
            switch (e.key.toLowerCase()) {
                case 'f':
                    e.preventDefault();
                    isPanelVisible = !isPanelVisible;
                    saveState();
                    panel.style.display = isPanelVisible ? 'block' : 'none';
                    break;
                case 's':
                    e.preventDefault();
                    persistentAlerts.clear();
                    stopPersistent();
                    showToast('🔕 Alertas persistentes parados', '#e65100');
                    break;
                case 'd':
                    e.preventDefault();
                    printDebugState();
                    showToast('🔍 Debug no console (F12)', '#333');
                    break;
            }
        });
    }

    // ========================
    // === INIT
    // ========================
    function ready(fn) {
        if (document.readyState !== 'loading') fn();
        else document.addEventListener('DOMContentLoaded', fn);
    }

    ready(() => {
        loadState();

        // [v2.4] Restaura alertas SLA ativos antes de construir o painel
        // Importante: roda ANTES de primeAudio para que os alertas
        // já estejam no mapa quando o áudio estiver pronto
        if (audioEnabled) restorePersistentAlertsFromHistory();

        if (audioEnabled) primeAudio();

        buildPanel();

        if ('Notification' in window && Notification.permission === 'default') {
            setTimeout(() => requestNotificationPermission().then(updateDashboard), 1500);
        }

        setInterval(checkWaitTimes, CHECK_INTERVAL_MS);
        setInterval(cleanOldHistory, CLEANUP_INTERVAL_MS);

        console.log(`[Fila v${VERSAO}] 🚀 Iniciado!`);
        console.log(`[Fila v${VERSAO}] Atalhos: Ctrl+Alt+F | Ctrl+Alt+S | Ctrl+Alt+D`);
    });

})();
