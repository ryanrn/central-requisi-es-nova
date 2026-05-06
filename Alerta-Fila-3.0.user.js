// ==UserScript==
// @name         Alerta-Fila
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Monitor de fila com alertas sonoros (WebAudio) e visuais — CR ATT
// @author       Ryan
// @match        *://centralderequisicoes-root.telemedicinaeinstein.com.br/*
// @match        *://centralderequisicoes-root-qas.telemedicinaeinstein.com.br/*
// @run-at       document-end
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/ryanrn/meus-userscripts/main/Alerta-Fila-3.0.user.js
// @updateURL    https://raw.githubusercontent.com/ryanrn/meus-userscripts/main/Alerta-Fila-3.0.user.js
// ==/UserScript==

/*
 * v3.0 — Correções críticas:
 *  1. Áudio: substituído HTML Audio + URL externa por WebAudio API (oscilador).
 *     Elimina dependência de rede, CORS e URLs mortas.
 *  2. Desbloqueio de áudio: AudioContext.resume() no primeiro clique/tecla.
 *  3. Detecção de novo paciente: removido !patientAlertHistory[pid] que
 *     bloqueava alertas após reload de página (histórico do localStorage).
 *  4. Seletores: mantidos os específicos + 6 fallbacks estruturais + diagnóstico.
 *  5. Notificações Web: Notification API integrada.
 *  6. Alertas visuais desacoplados do áudio (banner dispara mesmo sem som).
 *  7. Botão "Diagnosticar DOM" no painel para depuração de seletores.
 *  8. Simulação de alerta independente dos seletores para testar pipeline.
 */

(function () {
    'use strict';

    // ========================
    // === CONFIGURAÇÕES
    // ========================
    const VERSAO                    = '3.0';
    const QUANTIDADE_DE_BEEPS       = 3;
    const BEEP_INTERVAL_S           = 0.7;   // segundos entre beeps (WebAudio usa segundos)
    const BEEP_FREQ_HZ              = 880;   // frequência do beep (Lá5)
    const BEEP_DURATION_S           = 0.25;  // duração de cada beep
    const TIME_SLA_SECONDS          = 60;
    const TIME_30S_SECONDS          = 30;
    const CHECK_INTERVAL_MS         = 2000;
    const PERSISTENT_INTERVAL_MS    = 5000;
    const HISTORY_MAX_AGE_MS        = 4 * 60 * 60 * 1000;
    const CLEANUP_INTERVAL_MS       = 5 * 60 * 1000;
    const PERSISTENT_SESSION_MAX_MS = 2 * 60 * 1000;

    // Seletores em ordem de prioridade.
    // Os CSS-in-JS (ex: .ehsfmy) mudam a cada deploy; os estruturais são fallback.
    const ROW_SELECTORS = [
        '.sc-bXWnss.ehsfmy',              // v2.5 — específico
        '.ehsfmy',                         // v2.5 — sem combinador
        'tr.QueueItem',
        '.QueueItem',
        '[data-testid*="queue-item"]',
        '[data-testid*="patient-row"]',
        'table tbody tr[class]',           // fallback estrutural 1
        '[role="row"][aria-rowindex]',     // fallback estrutural 2
        'table tbody tr',                  // fallback estrutural genérico
    ];

    // ========================
    // === ESTADO
    // ========================
    let audioEnabled         = false;
    let attendedCheckEnabled = false;
    let isPanelVisible       = true;
    let volume               = 1.0;
    let debugMode            = false;

    let activeSelector       = null;
    let audioCtx             = null;
    let audioUnlocked        = false;

    let previousPids         = new Set();
    let isFirstCycle         = true;

    let patientAlertHistory  = {};
    let alertQueue           = [];
    let isProcessingQueue    = false;
    let currentPidMap        = new Map();

    let persistentAlerts         = new Map();
    let persistentVisualElements = new Map();
    let persistentAlertInterval  = null;

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
                from { opacity:0; transform:translateX(-50%) translateY(-8px); }
                to   { opacity:1; transform:translateX(-50%) translateY(0); }
            }
            @keyframes fadeIn {
                from { opacity:0; transform:translateX(-50%) translateY(-4px); }
                to   { opacity:1; transform:translateX(-50%) translateY(0); }
            }
        `;
        document.head.appendChild(s);
    })();

    // ========================
    // === ÁUDIO — WebAudio API
    // ========================
    // FIX: Toda a lógica de som foi migrada de HTML Audio + URL externa
    // para WebAudio API com oscilador. Isso elimina:
    //   - Dependência de rede / CORS
    //   - URLs mortas (actions.google.com/sounds pode ser bloqueado por proxies)
    //   - Keep-alive com loop silencioso (desnecessário com AudioContext)

    function getAudioCtx() {
        if (!audioCtx || audioCtx.state === 'closed') {
            try {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            } catch (err) {
                console.error(`[Fila v${VERSAO}] ❌ WebAudio não suportado:`, err.message);
                return null;
            }
        }
        return audioCtx;
    }

    function primeAudio() {
        // Browsers modernos suspendem AudioContext até interação do usuário.
        // Tentamos resume() imediatamente; se falhar, aguardamos um evento.
        const ctx = getAudioCtx();
        if (!ctx) return;

        if (ctx.state === 'running') {
            audioUnlocked = true;
            console.log(`[Fila v${VERSAO}] ✅ AudioContext já ativo.`);
            requestNotificationPermission();
            return;
        }

        ctx.resume()
            .then(() => {
                audioUnlocked = true;
                console.log(`[Fila v${VERSAO}] ✅ AudioContext desbloqueado.`);
                requestNotificationPermission();
            })
            .catch(() => {
                // Precisa de interação — registra listener no capture phase para
                // garantir disparo antes que qualquer outro handler do site consuma o evento
                console.log(`[Fila v${VERSAO}] ⏸️ Áudio suspenso. Clique ou pressione uma tecla para ativar.`);
                showToast('🔇 Clique na página para ativar o áudio', '#e65100');
                setupInteractionUnlock();
            });
    }

    function setupInteractionUnlock() {
        const unlock = () => {
            const ctx = getAudioCtx();
            if (!ctx) return;
            ctx.resume().then(() => {
                audioUnlocked = true;
                console.log(`[Fila v${VERSAO}] ✅ AudioContext desbloqueado via interação.`);
                showToast('🔊 Áudio desbloqueado!', '#2e7d32');
                requestNotificationPermission();
            });
        };
        document.addEventListener('click',   unlock, { once: true, capture: true });
        document.addEventListener('keydown', unlock, { once: true, capture: true });
    }

    /**
     * Toca N beeps em sequência usando oscilador WebAudio.
     * Todos os beeps são agendados na mesma chamada, sem setTimeout.
     */
    function playBeeps(vol) {
        if (!audioEnabled) return;

        const ctx = getAudioCtx();
        if (!ctx) {
            console.warn(`[Fila v${VERSAO}] ⚠️ AudioContext indisponível.`);
            return;
        }
        if (ctx.state !== 'running') {
            console.warn(`[Fila v${VERSAO}] ⚠️ AudioContext suspenso (state: ${ctx.state}). Clique na página.`);
            setupInteractionUnlock(); // re-registra caso o usuário ainda não tenha clicado
            return;
        }

        const v = (typeof vol === 'number' && !isNaN(vol))
            ? Math.max(0, Math.min(1, vol))
            : volume;

        for (let i = 0; i < QUANTIDADE_DE_BEEPS; i++) {
            const startAt = ctx.currentTime + i * BEEP_INTERVAL_S;
            try {
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.type = 'sine';
                osc.frequency.setValueAtTime(BEEP_FREQ_HZ, startAt);

                // Envelope suave: ataque rápido → decaimento exponencial
                gain.gain.setValueAtTime(0, startAt);
                gain.gain.linearRampToValueAtTime(v * 0.6, startAt + 0.015);
                gain.gain.exponentialRampToValueAtTime(0.001, startAt + BEEP_DURATION_S);

                osc.start(startAt);
                osc.stop(startAt + BEEP_DURATION_S + 0.05);
            } catch (err) {
                console.warn(`[Fila v${VERSAO}] ❌ Erro no beep ${i + 1}:`, err.message);
            }
        }
        console.log(`[Fila v${VERSAO}] 🔊 ${QUANTIDADE_DE_BEEPS} beep(s) agendados (vol=${Math.round(v * 100)}%)`);
    }

    // ========================
    // === NOTIFICAÇÕES WEB
    // ========================
    function requestNotificationPermission() {
        if (!('Notification' in window)) return;
        if (Notification.permission === 'default') {
            Notification.requestPermission().then(p => {
                console.log(`[Fila v${VERSAO}] 🔔 Permissão de notificação: ${p}`);
            });
        }
    }

    function showBrowserNotification(title, body) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        try {
            const n = new Notification(title, {
                body,
                tag: 'alerta-fila',   // tag igual substitui notificação anterior (evita spam)
                renotify: true,
                silent: false
            });
            setTimeout(() => n.close(), 6000);
        } catch (err) {
            console.warn(`[Fila v${VERSAO}] ⚠️ Notificação web falhou:`, err.message);
        }
    }

    // ========================
    // === NOTIFICAÇÕES VISUAIS
    // ========================
    // FIX: slideDown animation usava top:0px → top:14px, causando conflito com
    // transform:translateX(-50%). Corrigido para usar translateY no keyframe.

    let bannerTimeout = null;

    function showTopBanner(icon, title, subtitle, bgColor) {
        const old = document.getElementById('fila_topbanner');
        if (old) old.remove();
        if (bannerTimeout) clearTimeout(bannerTimeout);

        const n = document.createElement('div');
        n.id = 'fila_topbanner';
        Object.assign(n.style, {
            position: 'fixed', top: '14px', left: '50%',
            transform: 'translateX(-50%)',
            background: bgColor, color: '#fff',
            padding: '14px 28px', borderRadius: '14px',
            fontSize: '15px', fontWeight: '800',
            zIndex: '1000002',
            boxShadow: '0 8px 28px rgba(0,0,0,.30)',
            textAlign: 'center',
            animation: 'slideDown .2s ease forwards',
            minWidth: '260px', pointerEvents: 'none'
        });
        n.innerHTML = `
            <div style="font-size:26px;margin-bottom:4px;">${icon}</div>
            <div>${title}</div>
            ${subtitle ? `<div style="font-size:12px;opacity:.85;margin-top:2px;">${subtitle}</div>` : ''}
        `;
        document.body.appendChild(n);
        bannerTimeout = setTimeout(() => { if (n.parentNode) n.remove(); }, 4000);
    }

    function showToast(msg, color) {
        const old = document.getElementById('fila_toast');
        if (old) old.remove();
        const n = document.createElement('div');
        n.id = 'fila_toast';
        n.textContent = msg;
        Object.assign(n.style, {
            position: 'fixed', top: '76px', left: '50%',
            transform: 'translateX(-50%)',
            background: color || '#333', color: '#fff',
            padding: '10px 20px', borderRadius: '10px',
            fontSize: '13px', fontWeight: '700',
            zIndex: '1000003', pointerEvents: 'none',
            animation: 'fadeIn .2s ease forwards'
        });
        document.body.appendChild(n);
        setTimeout(() => { if (n.parentNode) n.remove(); }, 2500);
    }

    // ========================
    // === SELETOR ROBUSTO
    // ========================
    function getRowNodes() {
        for (const sel of ROW_SELECTORS) {
            const nodes = document.querySelectorAll(sel);
            if (nodes.length > 0) {
                if (activeSelector !== sel) {
                    activeSelector = sel;
                    console.log(`[Fila v${VERSAO}] ✅ Seletor ativo: "${sel}" (${nodes.length} item(s))`);
                }
                return Array.from(nodes);
            }
        }
        if (activeSelector !== null) {
            console.warn(`[Fila v${VERSAO}] ⚠️ Seletor "${activeSelector}" perdeu elementos.`);
            activeSelector = null;
        }
        return [];
    }

    // Diagnóstico acessível pelo painel — lista todos os seletores e o que encontram.
    // Também inspeciona as classes dos primeiros <tr> para ajudar a atualizar os seletores.
    function diagnoseDOM() {
        console.group(`[Fila v${VERSAO}] 🔍 Diagnóstico DOM`);
        console.log('--- Resultado por seletor ---');
        ROW_SELECTORS.forEach(sel => {
            const n = document.querySelectorAll(sel).length;
            console.log(`  ${n > 0 ? '✅' : '❌'} "${sel}"  →  ${n} elemento(s)`);
        });

        const trs = Array.from(document.querySelectorAll('tr'));
        if (trs.length > 0) {
            console.log(`\n--- Primeiros <tr> no DOM (${trs.length} total) ---`);
            trs.slice(0, 5).forEach((r, i) => {
                console.log(`  [${i}] className: "${r.className}" | id: "${r.id}"`);
            });
        }

        const allDivs = Array.from(document.querySelectorAll('div[class]'));
        const candidates = allDivs.filter(d => {
            const c = d.className;
            return typeof c === 'string' && c.length > 5 && d.children.length >= 2;
        });
        if (candidates.length > 0) {
            console.log(`\n--- Candidatos a itens de fila (divs com ≥2 filhos) ---`);
            candidates.slice(0, 5).forEach((d, i) => {
                console.log(`  [${i}] className: "${d.className.slice(0, 80)}" | filhos: ${d.children.length}`);
            });
        }
        console.groupEnd();
        showToast('🔍 Diagnóstico no console (F12)', '#555');
    }

    // ========================
    // === EXTRAÇÃO DE DADOS
    // ========================
    function getPatientName(node) {
        // Seletor específico v2.5
        const el = node.querySelector('.sc-dUWDJJ.kJwCqO p.sc-eqUAAy.kFxsPh');
        if (el) return el.textContent.trim();

        // Fallback por variante de placeholder
        const IGNORE = new Set([
            'Produto', 'Contrato', 'Espera recepção', 'Masculino', 'Feminino', '|',
            'Aps Digital', 'Aps Digital Assinatura', ''
        ]);
        for (const p of node.querySelectorAll('p[data-variant="placeholder200"]')) {
            const t = p.textContent.trim();
            if (!IGNORE.has(t) && !/^\d/.test(t) && !/\d{2}:\d{2}/.test(t) && t.length > 3)
                return t;
        }

        // Fallback legado
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
        return doc ? `${name}|${doc}` : `${name}|noDoc`;
    }

    function toSeconds(t) {
        if (!t) return 0;
        const p = t.split(':').map(Number);
        if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
        if (p.length === 2) return p[0] * 60 + p[1];
        return 0;
    }

    // ========================
    // === ESTADO / PERSISTÊNCIA
    // ========================
    function loadState() {
        try {
            audioEnabled         = localStorage.getItem('fila_audio')    === 'true';
            attendedCheckEnabled = localStorage.getItem('fila_attended') === 'true';
            isPanelVisible       = localStorage.getItem('fila_panel')    !== 'false';
            const v = parseFloat(localStorage.getItem('fila_vol') || '1');
            volume = isNaN(v) ? 1 : Math.max(0, Math.min(1, v));

            const hist = localStorage.getItem('fila_hist');
            if (hist) {
                const raw   = JSON.parse(hist);
                const now   = Date.now();
                const today = new Date().toDateString();
                const clean = {};
                for (const [pid, entry] of Object.entries(raw)) {
                    if ((now - (entry.firstSeen || 0)) < HISTORY_MAX_AGE_MS && entry.date === today)
                        clean[pid] = entry;
                }
                patientAlertHistory = clean;
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
        if (removed > 0) {
            saveHistory();
            console.log(`[Fila v${VERSAO}] 🧹 Histórico: ${removed} entrada(s) removida(s).`);
        }
    }

    // ========================
    // === ALERTAS PERSISTENTES
    // ========================
    function addPersistentAlert(pid, name, time) {
        persistentAlerts.set(pid, {
            name,
            time,
            lastAlert: 0,          // força disparo imediato na primeira iteração
            addedAt: Date.now()
        });
        console.log(`[Fila v${VERSAO}] 🚨 Alerta persistente adicionado: "${name}"`);
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
        if (persistentAlertInterval) return;
        persistentAlertInterval = setInterval(() => {
            if (persistentAlerts.size === 0) { stopPersistent(); return; }
            const now = Date.now();

            persistentAlerts.forEach((data, pid) => {
                // Expira após PERSISTENT_SESSION_MAX_MS
                if (now - data.addedAt > PERSISTENT_SESSION_MAX_MS) {
                    console.log(`[Fila v${VERSAO}] ⏰ Persistente expirou (2min): "${data.name}"`);
                    removePersistentAlert(pid);
                    return;
                }

                // Remove se paciente saiu do DOM ou foi atendido
                const node = currentPidMap.get(pid) || null;
                if (!node || isPatientBeingAttended(node)) {
                    console.log(`[Fila v${VERSAO}] ✅ Persistente removido: "${data.name}"`);
                    removePersistentAlert(pid);
                    return;
                }

                if (now - data.lastAlert >= PERSISTENT_INTERVAL_MS) {
                    data.lastAlert = now;
                    if (audioEnabled) playBeeps(volume * 0.7);
                    showPersistentCard(pid, data.name);
                }
            });
        }, 1500);
    }

    function stopPersistent() {
        clearInterval(persistentAlertInterval);
        persistentAlertInterval = null;
        persistentVisualElements.forEach(el => el.remove());
        persistentVisualElements.clear();
    }

    function showPersistentCard(pid, name) {
        if (persistentVisualElements.has(pid)) persistentVisualElements.get(pid).remove();
        const el = document.createElement('div');
        Object.assign(el.style, {
            position: 'fixed', top: '80px', right: '14px',
            background: 'linear-gradient(135deg,#c50b0b,#ff4444)',
            color: '#fff', padding: '14px 18px', borderRadius: '12px',
            fontSize: '14px', fontWeight: '800', zIndex: '1000000',
            border: '2px solid rgba(255,255,255,.25)', minWidth: '240px',
            animation: 'persistentPulse 2s infinite', pointerEvents: 'none'
        });
        el.innerHTML = `
            <div style="font-size:18px;">🚨 SLA CRÍTICO</div>
            <div style="font-size:12px;margin-top:4px;opacity:.9;">${name}</div>
        `;
        document.body.appendChild(el);
        persistentVisualElements.set(pid, el);
        setTimeout(() => {
            if (persistentVisualElements.get(pid) === el) {
                el.remove();
                persistentVisualElements.delete(pid);
            }
        }, 20000);
    }

    // ========================
    // === FILA DE ALERTAS
    // ========================
    // FIX: Alertas visuais (showTopBanner) são sempre exibidos independente do
    // estado do áudio. O audioEnabled controla apenas o playBeeps().

    function enqueue(kind, name, time) {
        alertQueue.push({ kind, name, time });
        if (!isProcessingQueue) drainQueue();
    }

    function drainQueue() {
        if (alertQueue.length === 0) { isProcessingQueue = false; return; }
        isProcessingQueue = true;
        const a = alertQueue.shift();

        // Som: só se áudio ativado
        if (audioEnabled) playBeeps(volume);

        // Visual: sempre
        if (a.kind === 'novo') {
            showTopBanner('🆕', 'Novo paciente na fila!', a.name, '#2e7d32');
            showBrowserNotification('🆕 Novo paciente', a.name || 'Paciente na fila');
        } else if (a.kind === '30s') {
            showTopBanner('⚠️', a.name, `Aguardando: ${a.time}`, '#e65100');
            showBrowserNotification('⚠️ Atenção', `${a.name} — aguardando ${a.time}`);
        } else if (a.kind === '60s') {
            showTopBanner('🚨', `SLA — ${a.name}`, `Tempo: ${a.time}`, '#b71c1c');
            showBrowserNotification('🚨 SLA Crítico', `${a.name} — ${a.time} sem atendimento`);
        }

        const delay = audioEnabled
            ? QUANTIDADE_DE_BEEPS * BEEP_INTERVAL_S * 1000 + 500
            : 500;
        setTimeout(() => drainQueue(), delay);
    }

    // ========================
    // === MONITORAMENTO PRINCIPAL
    // ========================
    function makeHistoryEntry() {
        return {
            alerted30: false,
            alerted60: false,
            wasAttended: false,
            firstSeen: Date.now(),
            date: new Date().toDateString()
        };
    }

    function checkWaitTimes() {
        const rows = getRowNodes();

        if (rows.length === 0) {
            if (debugMode) console.log(`[Fila v${VERSAO}] 🔍 checkWaitTimes: nenhuma linha encontrada.`);
            return;
        }

        // Reconstrói mapa PID → node
        currentPidMap = new Map();
        const currentPids = new Set();
        rows.forEach(node => {
            const pid = getPatientId(node);
            if (!pid) return;
            currentPidMap.set(pid, node);
            currentPids.add(pid);
        });

        if (debugMode) {
            console.log(`[Fila v${VERSAO}] 📋 ${currentPids.size} PID(s) detectados | 1ºCiclo=${isFirstCycle}`);
        }

        if (isFirstCycle) {
            // Carga inicial: registra todos os pacientes existentes sem alertar.
            // Alerta de "novo" SÓ dispara para pacientes que chegarem APÓS este ciclo.
            currentPids.forEach(pid => {
                if (!patientAlertHistory[pid]) {
                    patientAlertHistory[pid] = makeHistoryEntry();
                }
            });
            isFirstCycle = false;
            previousPids = new Set(currentPids);
            console.log(`[Fila v${VERSAO}] 🔒 Carga inicial: ${currentPids.size} paciente(s) registrado(s).`);
            saveHistory();
            return; // Sai sem verificar SLA no primeiro ciclo
        }

        // ── Detecção de novos pacientes ──────────────────────────────────────────
        // FIX v3.0: Removida a condição `&& !patientAlertHistory[pid]`.
        // Antes, se o histórico já continha o PID (carregado do localStorage após
        // reload), o alerta de "novo" nunca disparava, mesmo sendo um paciente
        // genuinamente novo nesta sessão. Agora basta não estar em previousPids.
        currentPids.forEach(pid => {
            if (!previousPids.has(pid)) {
                const name = getPatientName(currentPidMap.get(pid));
                // Preserva histórico existente (para não redefinir alerted30/alerted60)
                if (!patientAlertHistory[pid]) {
                    patientAlertHistory[pid] = makeHistoryEntry();
                }
                enqueue('novo', name || pid, '');
                console.log(`[Fila v${VERSAO}] 🆕 Novo paciente: "${name}" (${pid})`);
            }
        });

        previousPids = new Set(currentPids);

        // ── Verificação de tempos de espera / SLA ────────────────────────────────
        rows.forEach(node => {
            const pid  = getPatientId(node);
            const name = getPatientName(node);
            const time = getWaitingTime(node);
            if (!pid || !name) return;

            // Garante entrada no histórico (pacientes que vieram de ciclos anteriores)
            if (!patientAlertHistory[pid]) {
                patientAlertHistory[pid] = makeHistoryEntry();
                return; // Aguarda próximo ciclo para ter dados de tempo
            }

            const h = patientAlertHistory[pid];
            if (h.wasAttended) return;
            if (!time) return;

            const attended = isPatientBeingAttended(node);
            const secs     = toSeconds(time);

            if (attended) {
                h.wasAttended = true;
                removePersistentAlert(pid);
                saveHistory();
                console.log(`[Fila v${VERSAO}] ✅ Atendido: "${name}"`);
                return;
            }

            if (secs >= TIME_SLA_SECONDS && !h.alerted60) {
                h.alerted60 = true;
                enqueue('60s', name, time);
                addPersistentAlert(pid, name, time);
                saveHistory();
                console.log(`[Fila v${VERSAO}] 🚨 SLA 60s: "${name}" — ${time}`);
            } else if (secs >= TIME_30S_SECONDS && secs < TIME_SLA_SECONDS && !h.alerted30) {
                h.alerted30 = true;
                enqueue('30s', name, time);
                saveHistory();
                console.log(`[Fila v${VERSAO}] ⚠️ 30s: "${name}" — ${time}`);
            }
        });

        saveHistory();
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
        track.style.cssText = `position:absolute;inset:0;background:${checked ? '#0096D2' : '#ccc'};border-radius:24px;transition:.3s;`;
        const knob = document.createElement('span');
        knob.style.cssText = `position:absolute;width:18px;height:18px;border-radius:50%;background:#fff;bottom:3px;left:${checked ? '27px' : '3px'};transition:.3s;`;
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
            position: 'fixed', top: '12px', right: '12px', width: '270px',
            background: '#fff', border: '2px solid #e0e0e0', borderRadius: '16px',
            padding: '18px', zIndex: '999998',
            boxShadow: '0 8px 32px rgba(0,0,0,.14)',
            fontFamily: '"Segoe UI",Roboto,Arial,sans-serif'
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
                showToast('🔇 Áudio desativado', '#e65100');
            }
        }));
        ctrl.appendChild(mkToggle('👤 Verificar Atendidos', 'fila_att', attendedCheckEnabled, inp => {
            attendedCheckEnabled = inp.checked;
            saveState();
            showToast(inp.checked ? '✅ Verificação ON' : '❌ Verificação OFF', '#333');
        }));
        ctrl.appendChild(mkToggle('🐛 Debug', 'fila_debug', debugMode, inp => {
            debugMode = inp.checked;
            showToast(inp.checked ? '🐛 Debug ON (ver console F12)' : '🐛 Debug OFF', '#555');
            if (inp.checked) diagnoseDOM();
        }));
        panel.appendChild(ctrl);

        // Volume
        const volRow = document.createElement('div');
        volRow.style.cssText = 'margin:12px 0 4px;';
        volRow.innerHTML = `
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="font-size:12px;font-weight:700;color:#555;">🔉 Volume</span>
                <span id="fila_vol_label" style="font-size:12px;color:#0096D2;font-weight:700;">${Math.round(volume * 100)}%</span>
            </div>
            <input id="fila_vol_slider" type="range" min="0" max="100" value="${Math.round(volume * 100)}"
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
        btns.style.cssText = 'margin-top:14px;display:flex;flex-direction:column;gap:8px;';
        const bs = 'border:none;border-radius:9px;padding:10px;font-size:13px;font-weight:800;cursor:pointer;width:100%;color:#fff;';

        const bTest = document.createElement('button');
        bTest.textContent = '🔊 Testar Som';
        bTest.style.cssText = bs + 'background:linear-gradient(135deg,#0096D2,#00539A);';
        bTest.onclick = () => {
            if (!audioEnabled) { showToast('⚠️ Ative o áudio primeiro!', '#e65100'); return; }
            playBeeps(volume);
            showTopBanner('🔊', 'Teste de som', 'Se não ouviu, veja o console (F12)', '#0096D2');
        };

        const bSim = document.createElement('button');
        bSim.textContent = '🧪 Simular Alerta';
        bSim.style.cssText = bs + 'background:linear-gradient(135deg,#7b1fa2,#4a148c);';
        bSim.onclick = () => {
            enqueue('novo', '🧪 Paciente Simulado', '');
            setTimeout(() => enqueue('30s', '🧪 Paciente Simulado', '0:35'), 4000);
            setTimeout(() => enqueue('60s', '🧪 Paciente Simulado', '1:05'), 8000);
            showToast('🧪 Simulação iniciada!', '#7b1fa2');
        };

        const bDiag = document.createElement('button');
        bDiag.textContent = '🔍 Diagnosticar DOM';
        bDiag.style.cssText = bs + 'background:linear-gradient(135deg,#455a64,#263238);';
        bDiag.onclick = () => diagnoseDOM();

        btns.appendChild(bTest);
        btns.appendChild(bSim);
        btns.appendChild(bDiag);
        panel.appendChild(btns);

        // Status
        const statusDiv = document.createElement('div');
        statusDiv.id = 'fila_status';
        statusDiv.style.cssText = 'margin-top:10px;font-size:10px;color:#aaa;text-align:center;';
        statusDiv.textContent = 'Iniciando...';
        panel.appendChild(statusDiv);

        // Hint atalhos
        const hint = document.createElement('div');
        hint.style.cssText = 'margin-top:4px;font-size:10px;color:#bbb;text-align:center;';
        hint.textContent = 'Ctrl+Alt+F = painel | Ctrl+Alt+S = parar alertas';
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
            }
        });

        // Atualiza status a cada 3s
        setInterval(() => {
            const s = document.getElementById('fila_status');
            if (!s) return;
            const ctx = getAudioCtx();
            const ctxState = ctx ? ctx.state : 'N/A';
            const sel = activeSelector ? `"${activeSelector.slice(0, 30)}"` : 'nenhum';
            s.textContent = `Audio: ${ctxState} | Seletor: ${sel}`;
        }, 3000);
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
        if (audioEnabled) primeAudio();
        buildPanel();
        setInterval(checkWaitTimes, CHECK_INTERVAL_MS);
        setInterval(cleanOldHistory, CLEANUP_INTERVAL_MS);

        console.log(`[Fila v${VERSAO}] 🚀 Iniciado!`);
        console.log(`[Fila v${VERSAO}] Atalhos: Ctrl+Alt+F (painel) | Ctrl+Alt+S (parar alertas)`);
        console.log(`[Fila v${VERSAO}] Seletores configurados:`, ROW_SELECTORS);
        console.log(`[Fila v${VERSAO}] 💡 Dica: ative o modo 🐛 Debug no painel para diagnosticar seletores.`);
    });

})();
