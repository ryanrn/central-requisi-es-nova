// ==UserScript==
// @name         Alerta-Fila
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Painel completo - Nova CR (v2.0 - bugs corrigidos)
// @author       Ryan
// @match        *://centralderequisicoes-root.telemedicinaeinstein.com.br/*
// @match        *://centralderequisicoes-root-qas.telemedicinaeinstein.com.br/*
// @run-at       document-end
// @grant        none
// @updateURL    https://github.com/ryanrn/central-requisi-es-nova/raw/refs/heads/main/Alerta%20Fila-2.0.user.js 
// @downloadURL  https://github.com/ryanrn/central-requisi-es-nova/raw/refs/heads/main/Alerta%20Fila-2.0.user.js
// ==/UserScript==

(function() {
    'use strict';
     
// ========================
// === CONFIGURAÇÕES
// ========================
const VERSAO                 = '2.0';
const QUANTIDADE_DE_BEEPS    = 3;
const BEEP_INTERVAL_MS       = 1000;
const soundUrl               = 'https://actions.google.com/sounds/v1/alarms/beep_short.ogg';
const TIME_SLA_SECONDS       = 60;
const TIME_30S_SECONDS       = 30;
const CHECK_INTERVAL_MS      = 2000;
const PERSISTENT_INTERVAL_MS = 5000;
const HISTORY_MAX_AGE_MS     = 4 * 60 * 60 * 1000; // 4 horas
const CLEANUP_INTERVAL_MS    = 5 * 60 * 1000;       // limpa a cada 5 min

// Seletores em ordem de prioridade
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

// ► Detecção de novo paciente via comparação de ciclo
let previousPids         = new Set(); // PIDs do ciclo anterior
let isFirstCycle         = true;      // true até o primeiro ciclo com dados

let patientAlertHistory  = {};
let alertQueue           = [];
let isProcessingQueue    = false;

// ► Map para lookup rápido pid→node (reconstruído em cada ciclo)
let currentPidMap        = new Map();

let persistentAlerts         = new Map();
let persistentVisualElements = new Map();
let persistentAlertInterval  = null;

let dailyStats  = { atendidosHoje: 0, slaEstourados: 0 };
let dashboardEl = null;
let eventLog    = [];

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

// === CSS ===
(function injectCss() {
    const s = document.createElement('style');
    s.textContent = `
        @keyframes persistentPulse {
            0%,100% { transform: scale(1); box-shadow: 0 4px 20px rgba(197,11,11,.5); }
            50%      { transform: scale(1.03); box-shadow: 0 6px 28px rgba(197,11,11,.8); }
        }
        @keyframes slideDown {
            from { opacity: 0; top: 0px; }
            to   { opacity: 1; top: 14px; }
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-6px); }
            to   { opacity: 1; transform: translateY(0); }
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
        // Seletor sumiu — pode ser navegação ou redesign
        console.warn(`[Fila v${VERSAO}] ⚠️ Nenhum seletor encontrou linhas. Aguardando...`);
        activeSelector = null;
    }
    return [];
}

// ========================
// === EXTRAÇÃO DE DADOS
// ========================

/**
 * getPatientName: tenta seletores específicos, depois fallback genérico.
 */
function getPatientName(node) {
    // Seletor principal da CR ZDS
    const el = node.querySelector('.sc-dUWDJJ.kJwCqO p.sc-eqUAAy.kFxsPh');
    if (el) return el.textContent.trim();

    // Fallback: placeholder200 (filtra valores que não são nomes)
    const IGNORE = new Set([
        'Produto','Contrato','Espera recepção','Masculino','Feminino','|',
        'Aps Digital','Aps Digital Assinatura',''
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

/**
 * getPatientDocument: busca CPF ou código único do paciente.
 */
function getPatientDocument(node) {
    // Container específico
    const c = node.querySelector('.sc-aNeao.hVGonf');
    if (c) {
        const el = c.querySelector('p.sc-eqUAAy.dVxBaO');
        if (el) return el.textContent.trim();
    }
    // Regex CPF em qualquer parágrafo
    for (const p of node.querySelectorAll('p')) {
        const t = p.textContent.trim();
        if (/^\d{11}$/.test(t) || /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(t)) return t;
    }
    return null;
}

/**
 * getWaitingTime: retorna string HH:MM:SS ou MM:SS, ou null.
 * [v2.0] Regex mais permissivo (\d{1,2}), busca também em <p>.
 */
function getWaitingTime(node) {
    // Seletor ZdsBadge (mais confiável)
    const badge = node.querySelector('[data-zds-id="ZdsBadge"] span');
    if (badge) {
        const t = badge.textContent.trim();
        const m = t.match(/\d{1,2}:\d{2}(:\d{2})?/);
        if (m) return m[0];
    }

    // Fallback: qualquer <span> ou <p> com formato de tempo
    const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
    for (const el of node.querySelectorAll('span, p')) {
        const t = el.textContent.trim();
        if (TIME_RE.test(t)) return t;
    }

    return null;
}

/**
 * isPatientBeingAttended: só relevante se attendedCheckEnabled = true.
 */
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

/**
 * getPatientId: nome + documento.
 * [v2.0] Se documento indisponível, usa "noDoc" + aviso no console.
 *         Isso evita IDs flutuantes "Name|unknown" vs "Name|123456".
 */
function getPatientId(node) {
    const name = getPatientName(node);
    if (!name) return null;

    const doc = getPatientDocument(node);
    if (!doc) {
        // Aviso para debug — se aparecer muito, o seletor de doc precisa de ajuste
        console.debug(`[Fila v${VERSAO}] ⚠️ Doc não encontrado para "${name}" — usando "noDoc"`);
        return `${name}|noDoc`;
    }
    return `${name}|${doc}`;
}

/**
 * toSeconds: converte "MM:SS" ou "HH:MM:SS" em segundos inteiros.
 */
function toSeconds(t) {
    if (!t) return 0;
    const p = t.split(':').map(Number);
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60  + p[1];
    return 0;
}

// ========================
// === ÁUDIO
// ========================
function primeAudio() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const g   = ctx.createGain();
        g.gain.value = 0;
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.001);
        console.log(`[Fila v${VERSAO}] 🔊 AudioContext iniciado.`);
    } catch (e) {
        console.warn(`[Fila v${VERSAO}] Erro ao iniciar AudioContext:`, e);
    }
}

function playBeeps(vol) {
    if (!audioEnabled) {
        console.debug(`[Fila v${VERSAO}] 🔇 Áudio desabilitado — beep ignorado.`);
        return;
    }
    const v = (typeof vol === 'number') ? vol : volume;
    console.log(`[Fila v${VERSAO}] 🔊 Tocando ${QUANTIDADE_DE_BEEPS} beep(s) vol=${v}`);
    for (let i = 0; i < QUANTIDADE_DE_BEEPS; i++) {
        setTimeout(() => {
            const a = new Audio(soundUrl);
            a.volume = v;
            a.play().catch(e => console.warn(`[Fila v${VERSAO}] Erro audio:`, e.message));
        }, i * BEEP_INTERVAL_MS);
    }
}

// ========================
// === NOTIFICAÇÕES
// ========================
let bannerTimeout = null;

function showTopBanner(icon, title, subtitle, bgColor) {
    const old = document.getElementById('fila_topbanner');
    if (old) old.remove();
    if (bannerTimeout) clearTimeout(bannerTimeout);

    const n = document.createElement('div');
    n.id = 'fila_topbanner';
    Object.assign(n.style, {
        position:      'fixed',
        top:           '14px',
        left:          '50%',
        transform:     'translateX(-50%)',
        background:    bgColor,
        color:         '#fff',
        padding:       '14px 28px',
        borderRadius:  '14px',
        fontSize:      '15px',
        fontWeight:    '800',
        zIndex:        1000002,
        boxShadow:     '0 8px 28px rgba(0,0,0,.30)',
        textAlign:     'center',
        animation:     'slideDown .2s ease forwards',
        minWidth:      '260px',
        pointerEvents: 'none'
    });
    n.innerHTML = `
        <div style="font-size:26px;margin-bottom:4px;">${icon}</div>
        <div style="font-size:15px;">${title}</div>
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
        position:  'fixed', top: '14px', left: '50%',
        transform: 'translateX(-50%)',
        background: color || '#333', color: '#fff',
        padding: '10px 20px', borderRadius: '10px',
        fontSize: '13px', fontWeight: '700',
        zIndex: 1000003, pointerEvents: 'none',
        animation: 'fadeIn .2s ease forwards'
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

/**
 * loadState: carrega configurações e histórico.
 * [v2.0] Limpa entradas de dias anteriores ou > 4h ao iniciar.
 */
function loadState() {
    try {
        audioEnabled         = localStorage.getItem('fila_audio') === 'true';
        attendedCheckEnabled = localStorage.getItem('fila_attended') === 'true';
        isPanelVisible       = localStorage.getItem('fila_panel') !== 'false';
        const v = parseFloat(localStorage.getItem('fila_vol') || '1');
        volume = isNaN(v) ? 1 : Math.max(0, Math.min(1, v));

        // Stats — reseta se for outro dia
        const rawStats = localStorage.getItem('fila_stats');
        if (rawStats) {
            const p = JSON.parse(rawStats);
            if (p.date === new Date().toDateString()) dailyStats = p.stats;
            else dailyStats = { atendidosHoje: 0, slaEstourados: 0 };
        }

        // Histórico — descarta entradas antigas (outro dia ou > 4h)
        const hist = localStorage.getItem('fila_hist');
        if (hist) {
            const raw = JSON.parse(hist);
            const now = Date.now();
            const todayStr = new Date().toDateString();
            const clean = {};
            for (const [pid, entry] of Object.entries(raw)) {
                const age = now - (entry.firstSeen || 0);
                const sameDay = entry.date === todayStr;
                if (age < HISTORY_MAX_AGE_MS && sameDay) {
                    clean[pid] = entry;
                }
            }
            patientAlertHistory = clean;
            const removed = Object.keys(raw).length - Object.keys(clean).length;
            if (removed > 0)
                console.log(`[Fila v${VERSAO}] 🧹 Histórico: ${removed} entradas antigas removidas.`);
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
    try {
        localStorage.setItem('fila_hist', JSON.stringify(patientAlertHistory));
    } catch (_) {}
}

/**
 * cleanOldHistory: remove entradas com > 4h ou de outro dia.
 * Chamado a cada CLEANUP_INTERVAL_MS.
 */
function cleanOldHistory() {
    const now = Date.now();
    const todayStr = new Date().toDateString();
    let removed = 0;
    for (const [pid, entry] of Object.entries(patientAlertHistory)) {
        const age = now - (entry.firstSeen || 0);
        if (age > HISTORY_MAX_AGE_MS || entry.date !== todayStr) {
            delete patientAlertHistory[pid];
            removed++;
        }
    }
    if (removed > 0) {
        console.log(`[Fila v${VERSAO}] 🧹 Limpeza periódica: ${removed} entradas antigas removidas.`);
        saveHistory();
    }
}

function resetDailyStats() {
    dailyStats = { atendidosHoje: 0, slaEstourados: 0 };
    saveStats();
    updateDashboard();
}

function updateDashboard() {
    if (!dashboardEl) return;
    dashboardEl.innerHTML = `
        <div style="font-size:12px;color:#666;margin-bottom:8px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">📊 Estatísticas de Hoje</div>
        <div style="display:flex;justify-content:space-around;">
            <div style="text-align:center;">
                <div style="font-size:28px;font-weight:900;color:#0096D2;">${dailyStats.atendidosHoje}</div>
                <div style="font-size:11px;color:#888;">Atendidos</div>
            </div>
            <div style="text-align:center;">
                <div style="font-size:28px;font-weight:900;color:#c50b0b;">${dailyStats.slaEstourados}</div>
                <div style="font-size:11px;color:#888;">SLA Crítico</div>
            </div>
        </div>
    `;
}

// ========================
// === ALERTAS PERSISTENTES
// ========================
function addPersistentAlert(pid, name, time) {
    persistentAlerts.set(pid, { name, lastAlert: Date.now(), time });
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
    console.log(`[Fila v${VERSAO}] ▶ Iniciando loop de alertas persistentes.`);
    persistentAlertInterval = setInterval(() => {
        if (!audioEnabled || persistentAlerts.size === 0) return;
        const now = Date.now();
        persistentAlerts.forEach((data, pid) => {
            // [v2.0] Usa currentPidMap para lookup O(1) em vez de querySelectorAll
            const node = currentPidMap.get(pid) || null;
            if (!node || isPatientBeingAttended(node)) {
                console.log(`[Fila v${VERSAO}] ✅ Alerta persistente removido: "${data.name}" (sumiu ou atendido)`);
                removePersistentAlert(pid);
                return;
            }
            if (now - data.lastAlert >= PERSISTENT_INTERVAL_MS) {
                data.lastAlert = now;
                playBeeps(volume * 0.7);
                showPersistentCard(pid, data.name);
            }
        });
    }, 1500);
}

function stopPersistent() {
    clearInterval(persistentAlertInterval);
    persistentAlertInterval = null;
    persistentVisualElements.forEach(v => v.remove());
    persistentVisualElements.clear();
    console.log(`[Fila v${VERSAO}] ⏹ Loop de alertas persistentes parado.`);
}

function showPersistentCard(pid, name) {
    if (persistentVisualElements.has(pid)) persistentVisualElements.get(pid).remove();
    const el = document.createElement('div');
    Object.assign(el.style, {
        position:    'fixed',
        top:         '80px',
        right:       '14px',
        background:  'linear-gradient(135deg, #c50b0b, #ff4444)',
        color:       '#fff',
        padding:     '14px 18px',
        borderRadius:'12px',
        fontSize:    '14px',
        fontWeight:  '800',
        zIndex:      1000000,
        border:      '2px solid rgba(255,255,255,.25)',
        minWidth:    '240px',
        animation:   'persistentPulse 2s infinite',
        pointerEvents: 'none'
    });
    el.innerHTML = `
        <div style="font-size:18px;">🚨 SLA CRÍTICO</div>
        <div style="font-size:12px;margin-top:4px;opacity:.9;">${name}</div>
    `;
    document.body.appendChild(el);
    persistentVisualElements.set(pid, el);
    // [v2.0] Corrigido: era 200000 ms (3,3 min), agora 20000 ms (20 s)
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
function enqueue(kind, name, time) {
    console.log(`[Fila v${VERSAO}] 📥 enqueue → kind=${kind} name="${name}" time="${time}"`);
    alertQueue.push({ kind, name, time });
    if (!isProcessingQueue) drainQueue();
}

function drainQueue() {
    if (alertQueue.length === 0) {
        isProcessingQueue = false;
        return;
    }
    isProcessingQueue = true;
    const a = alertQueue.shift();

    playBeeps(volume);

    if (a.kind === 'novo') {
        showTopBanner('🆕', 'Novo paciente na fila!', a.name, '#2e7d32');
    } else if (a.kind === '30s') {
        showTopBanner('⚠️', a.name, `Aguardando: ${a.time}`, '#e65100');
    } else if (a.kind === '60s') {
        showTopBanner('🚨', `SLA — ${a.name}`, `Tempo: ${a.time}`, '#b71c1c');
    }

    // Aguarda beeps terminarem antes do próximo
    setTimeout(() => drainQueue(), QUANTIDADE_DE_BEEPS * BEEP_INTERVAL_MS + 500);
}

// ========================
// === MONITORAMENTO PRINCIPAL
// ========================

/**
 * checkWaitTimes: roda a cada CHECK_INTERVAL_MS.
 *
 * [v2.0] Detecta novo paciente comparando PIDs do ciclo atual
 *        com previousPids (ciclo anterior). MutationObserver
 *        era não-confiável porque disparava antes do nó estar
 *        totalmente renderizado.
 *
 * [v2.0] Reconstrói currentPidMap para lookup O(1) em alertas
 *        persistentes.
 */
function checkWaitTimes() {
    const rows = getRowNodes();

    if (rows.length === 0) return;

    // Reconstrói o mapa pid→node para uso neste ciclo
    currentPidMap = new Map();
    const currentPids = new Set();

    rows.forEach(node => {
        const pid = getPatientId(node);
        if (!pid) return;
        currentPidMap.set(pid, node);
        currentPids.add(pid);
    });

    // ─────────────────────────────────────────────
    // Detecta novos pacientes por comparação de Set
    // ─────────────────────────────────────────────
    if (!isFirstCycle) {
        currentPids.forEach(pid => {
            if (!previousPids.has(pid)) {
                // Paciente apareceu neste ciclo e não estava no anterior → NOVO
                const node = currentPidMap.get(pid);
                const name = getPatientName(node);
                if (!patientAlertHistory[pid]) {
                    patientAlertHistory[pid] = {
                        alerted30: false, alerted60: false,
                        wasAttended: false,
                        firstSeen: Date.now(),
                        date: new Date().toDateString()
                    };
                    enqueue('novo', name || pid, '');
                    logEvent(name, 'novo', pid);
                    console.log(`[Fila v${VERSAO}] 🆕 Novo paciente: "${name}" (${pid})`);
                }
            }
        });
    } else {
        // Primeiro ciclo: registra todos silenciosamente
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
        console.log(`[Fila v${VERSAO}] 🔒 Carga inicial: ${currentPids.size} paciente(s) registrados silenciosamente.`);
    }

    // Atualiza previousPids para o próximo ciclo
    previousPids = currentPids;

    // ─────────────────────────────────────────────
    // Verifica tempos de espera
    // ─────────────────────────────────────────────
    rows.forEach(node => {
        const pid  = getPatientId(node);
        const name = getPatientName(node);
        const time = getWaitingTime(node);

        if (!pid || !name) return;

        // Garante que a entrada existe (pode ter sido criada acima já)
        if (!patientAlertHistory[pid]) {
            patientAlertHistory[pid] = {
                alerted30: false, alerted60: false,
                wasAttended: false,
                firstSeen: Date.now(),
                date: new Date().toDateString()
            };
            return; // aguarda próximo ciclo para garantir estabilidade
        }

        if (!time) {
            console.debug(`[Fila v${VERSAO}] ⏱️ Tempo não encontrado para "${name}" — pulando.`);
            return;
        }

        const h        = patientAlertHistory[pid];
        const attended = isPatientBeingAttended(node);
        const secs     = toSeconds(time);

        console.debug(`[Fila v${VERSAO}] 👤 "${name}" | time="${time}" secs=${secs} | a30=${h.alerted30} a60=${h.alerted60} att=${attended}`);

        if (attended && !h.wasAttended) {
            h.wasAttended = true;
            dailyStats.atendidosHoje++;
            saveStats();
            updateDashboard();
            removePersistentAlert(pid);
            delete patientAlertHistory[pid];
            console.log(`[Fila v${VERSAO}] ✅ Atendido + removido: "${name}"`);
            return;
        }

        if (!attended) {
            if (secs >= TIME_SLA_SECONDS && !h.alerted60) {
                h.alerted60 = true;
                dailyStats.slaEstourados++;
                saveStats();
                updateDashboard();
                enqueue('60s', name, time);
                addPersistentAlert(pid, name, time);
                logEvent(name, 'sla60', time);
                console.log(`[Fila v${VERSAO}] 🚨 SLA 60s: "${name}" — ${time}`);

            } else if (secs >= TIME_30S_SECONDS && secs < TIME_SLA_SECONDS && !h.alerted30) {
                h.alerted30 = true;
                enqueue('30s', name, time);
                logEvent(name, 'alerta30', time);
                console.log(`[Fila v${VERSAO}] ⚠️ 30s: "${name}" — ${time}`);
            }
        }
    });

    saveHistory();
}

// ========================
// === DEBUG CONSOLE (Ctrl+Alt+D)
// ========================
function printDebugState() {
    console.group(`[Fila v${VERSAO}] 🔍 Estado atual`);
    console.log('audioEnabled:', audioEnabled, '| volume:', volume);
    console.log('attendedCheckEnabled:', attendedCheckEnabled);
    console.log('isFirstCycle:', isFirstCycle);
    console.log('previousPids:', [...previousPids]);
    console.log('patientAlertHistory:', JSON.parse(JSON.stringify(patientAlertHistory)));
    console.log('persistentAlerts:', [...persistentAlerts.entries()]);
    console.log('alertQueue:', [...alertQueue]);
    console.log('isProcessingQueue:', isProcessingQueue);
    console.log('activeSelector:', activeSelector);
    console.log('dailyStats:', dailyStats);
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
    track.style.cssText = `position:absolute;inset:0;background:${checked ? '#0096D2' : '#ccc'};
        border-radius:24px;transition:.3s;`;

    const knob = document.createElement('span');
    knob.style.cssText = `position:absolute;width:18px;height:18px;border-radius:50%;
        background:#fff;bottom:3px;left:${checked ? '27px' : '3px'};transition:.3s;`;

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
        position:   'fixed',
        top:        '12px',
        right:      '12px',
        width:      '290px',
        background: '#fff',
        border:     '2px solid #e0e0e0',
        borderRadius: '16px',
        padding:    '18px',
        zIndex:     999998,
        boxShadow:  '0 8px 32px rgba(0,0,0,.14)',
        fontFamily: '"Segoe UI", Roboto, Arial, sans-serif'
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
            showToast('🔇 Áudio desativado', '#e65100');
        }
    }));
    ctrl.appendChild(mkToggle('👤 Verificar Atendidos', 'fila_att', attendedCheckEnabled, inp => {
        attendedCheckEnabled = inp.checked;
        saveState();
        showToast(inp.checked ? '✅ Verificação ON' : '❌ Verificação OFF', '#333');
    }));
    panel.appendChild(ctrl);

    // Controle de volume
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

    const bTest = document.createElement('button');
    bTest.textContent = '🔊 Testar Som';
    bTest.style.cssText = bs + 'background:linear-gradient(135deg,#0096D2,#00539A);';
    bTest.onclick = () => {
        if (!audioEnabled) { showToast('⚠️ Ative o áudio primeiro!', '#e65100'); return; }
        playBeeps(volume);
        showToast('🔊 Testando...', '#0096D2');
    };
    btns.appendChild(bTest);

    const bSim = document.createElement('button');
    bSim.textContent = '🧪 Simular Alertas';
    bSim.style.cssText = bs + 'background:linear-gradient(135deg,#7b1fa2,#ab47bc);';
    bSim.onclick = () => {
        if (!audioEnabled) { showToast('⚠️ Ative o áudio primeiro!', '#e65100'); return; }
        showToast('🧪 Simulando...', '#7b1fa2');
        setTimeout(() => enqueue('novo',  'Paciente Teste', ''),     200);
        setTimeout(() => enqueue('30s',   'Paciente Teste', '00:30'), 4500);
        setTimeout(() => enqueue('60s',   'Paciente Teste', '01:00'), 9000);
        setTimeout(() => {
            addPersistentAlert('__sim__', 'Paciente Teste', '01:00');
            setTimeout(() => removePersistentAlert('__sim__'), 10000);
        }, 13500);
    };
    btns.appendChild(bSim);

    const bReset = document.createElement('button');
    bReset.textContent = '🔄 Resetar Estatísticas';
    bReset.style.cssText = bs + 'background:linear-gradient(135deg,#ff6b35,#f7931e);';
    bReset.onclick = () => {
        if (confirm('Resetar estatísticas de hoje?')) {
            resetDailyStats();
            showToast('✅ Resetado!', '#2e7d32');
        }
    };
    btns.appendChild(bReset);

    const bClearHist = document.createElement('button');
    bClearHist.textContent = '🗑️ Limpar Histórico';
    bClearHist.style.cssText = bs + 'background:linear-gradient(135deg,#546e7a,#78909c);';
    bClearHist.onclick = () => {
        if (confirm('Limpar histórico de pacientes? (força re-alerta na próxima detecção)')) {
            patientAlertHistory = {};
            previousPids = new Set();
            isFirstCycle = true;
            saveHistory();
            showToast('✅ Histórico limpo!', '#2e7d32');
        }
    };
    btns.appendChild(bClearHist);

    panel.appendChild(btns);

    // Atalhos
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

    // Atalhos de teclado
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
    if (audioEnabled) primeAudio();
    buildPanel();

    // Loop principal
    setInterval(checkWaitTimes, CHECK_INTERVAL_MS);

    // Limpeza periódica do histórico
    setInterval(cleanOldHistory, CLEANUP_INTERVAL_MS);

    console.log(`[Fila v${VERSAO}] 🚀 Iniciado!`);
    console.log(`[Fila v${VERSAO}] Atalhos: Ctrl+Alt+F = painel | Ctrl+Alt+S = parar alertas | Ctrl+Alt+D = debug`);
})();

})();
