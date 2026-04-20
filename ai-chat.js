// ============================================================
//  RH-Meter AI Chat — ai-chat.js
//  Drop this ONE script tag into any page before </body>:
//  <script src="ai-chat.js"></script>
//
//  Works on: home.html, index.html (detail page), any page
//  Requires: app.js already loaded (for SERVER_URL, DEVICE_NAME_MAP,
//            thresholds, deviceStatusCache)
// ============================================================

(function () {
  'use strict';

  // ── CONFIG ────────────────────────────────────────────────
  const GEMINI_API_KEY = 'AIzaSyAds9YFmkBS3M1H9PBrGA16PwPdLH3VBdc'; // ← Paste your key here
  const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  const LOCATION_DEVICES = {
    samudra: ['Meter_01','Meter_03','Meter_04','Meter_05','Meter_06','Meter_07','Meter_08','Meter_09'],
    bng:     ['Meter_10','Meter_11','Meter_12','Meter_13'],
    rd:      ['Meter_02']
  };

  // Helper: safely get app.js globals
  function getServerUrl()   { return (typeof SERVER_URL        !== 'undefined') ? SERVER_URL        : 'https://rh-meter-production.up.railway.app'; }
  function getDeviceNames() { return (typeof DEVICE_NAME_MAP   !== 'undefined') ? DEVICE_NAME_MAP   : {}; }
  function getThresholds()  { return (typeof thresholds        !== 'undefined') ? thresholds        : { temp: 35, hum: 70 }; }
  function getStatusCache() { return (typeof deviceStatusCache !== 'undefined') ? deviceStatusCache : {}; }

  // Helper: get device name
  function deviceName(id) {
    const map = getDeviceNames();
    return (map && map[id]) ? map[id] : id;
  }

  // ── STATE ─────────────────────────────────────────────────
  let panelOpen    = false;
  let chatHistory  = [];
  let aiState      = { step: 'welcome', location: null, deviceId: null };

  // ── INJECT CSS ────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    /* ── AI FAB ── */
    #rh-ai-fab {
      position: fixed; bottom: 28px; right: 28px; z-index: 9000;
      width: 58px; height: 58px; border-radius: 50%;
      background: linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 100%);
      border: none; cursor: pointer;
      box-shadow: 0 4px 24px rgba(29,78,216,0.45), 0 0 0 0 rgba(29,78,216,0.3);
      display: flex; align-items: center; justify-content: center;
      font-size: 1.5rem; transition: transform 0.3s ease, box-shadow 0.3s ease;
      animation: rh-fab-pulse 3s ease-in-out infinite;
    }
    @keyframes rh-fab-pulse {
      0%,100% { box-shadow: 0 4px 24px rgba(29,78,216,0.45), 0 0 0 0 rgba(29,78,216,0.3); }
      50%      { box-shadow: 0 4px 24px rgba(29,78,216,0.45), 0 0 0 10px rgba(29,78,216,0); }
    }
    #rh-ai-fab:hover { transform: scale(1.1); animation: none; box-shadow: 0 8px 32px rgba(29,78,216,0.6); }
    #rh-ai-fab .rh-fab-badge {
      position: absolute; top: -3px; right: -3px;
      width: 18px; height: 18px; border-radius: 50%;
      background: #ef4444; color: #fff; font-size: 0.6rem; font-weight: 800;
      display: none; align-items: center; justify-content: center;
      border: 2px solid #fff;
    }

    /* ── AI PANEL ── */
    #rh-ai-panel {
      position: fixed; bottom: 100px; right: 28px; z-index: 9000;
      width: 390px; max-height: 600px;
      background: var(--bg-card, #ffffff);
      border: 1px solid var(--border, #e2e8f0);
      border-radius: 22px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08);
      display: none; flex-direction: column; overflow: hidden;
    }
    #rh-ai-panel.rh-open {
      display: flex;
      animation: rh-panel-in 0.28s cubic-bezier(0.34,1.56,0.64,1);
    }
    @keyframes rh-panel-in {
      from { opacity:0; transform: translateY(20px) scale(0.95); }
      to   { opacity:1; transform: translateY(0)    scale(1); }
    }

    /* ── HEADER ── */
    .rh-ai-header {
      background: linear-gradient(135deg, #1e3a5f, #1d4ed8);
      padding: 16px 18px;
      display: flex; align-items: center; justify-content: space-between;
      flex-shrink: 0;
    }
    .rh-ai-header-left { display: flex; align-items: center; gap: 10px; }
    .rh-ai-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(255,255,255,0.15);
      display: flex; align-items: center; justify-content: center;
      font-size: 1.1rem; flex-shrink: 0;
    }
    .rh-ai-title   { color: #fff; font-size: 0.95rem; font-weight: 700; line-height: 1.2; }
    .rh-ai-sub     { color: rgba(255,255,255,0.55); font-size: 0.68rem; margin-top: 1px; }
    .rh-ai-close {
      background: rgba(255,255,255,0.15); border: none; color: #fff;
      width: 30px; height: 30px; border-radius: 8px; cursor: pointer;
      font-size: 1rem; display: flex; align-items: center; justify-content: center;
      transition: background 0.2s; line-height: 1;
    }
    .rh-ai-close:hover { background: rgba(255,255,255,0.28); }

    /* ── MESSAGES ── */
    .rh-ai-msgs {
      flex: 1; overflow-y: auto; padding: 16px;
      display: flex; flex-direction: column; gap: 10px;
      scroll-behavior: smooth;
    }
    .rh-ai-msgs::-webkit-scrollbar { width: 4px; }
    .rh-ai-msgs::-webkit-scrollbar-thumb { background: var(--border, #e2e8f0); border-radius: 4px; }

    /* ── MESSAGES: BOT & USER ── */
    .rh-msg {
      max-width: 90%; font-size: 0.83rem; line-height: 1.58;
      padding: 10px 13px; word-break: break-word;
    }
    .rh-msg.rh-bot {
      background: var(--bg, #f8fafc);
      border: 1px solid var(--border, #e2e8f0);
      color: var(--text, #1e293b);
      border-radius: 4px 16px 16px 16px;
      align-self: flex-start;
    }
    .rh-msg.rh-user {
      background: linear-gradient(135deg, #1e3a5f, #1d4ed8);
      color: #fff;
      border-radius: 16px 16px 4px 16px;
      align-self: flex-end;
    }
    .rh-msg.rh-typing {
      background: var(--bg, #f8fafc);
      border: 1px solid var(--border, #e2e8f0);
      border-radius: 4px 16px 16px 16px;
      align-self: flex-start; padding: 12px 16px;
    }

    /* ── TYPING DOTS ── */
    .rh-dots { display: flex; gap: 5px; align-items: center; }
    .rh-dots span {
      width: 7px; height: 7px; border-radius: 50%;
      background: #3b82f6;
      animation: rh-dot 1.2s ease-in-out infinite;
    }
    .rh-dots span:nth-child(2) { animation-delay: 0.2s; }
    .rh-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes rh-dot {
      0%,80%,100% { transform:scale(0.65); opacity:0.35; }
      40%          { transform:scale(1);    opacity:1; }
    }

    /* ── QUICK BUTTONS ── */
    .rh-btns { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
    .rh-btn {
      padding: 6px 13px; border-radius: 20px;
      font-size: 0.76rem; font-weight: 600; cursor: pointer;
      border: 1px solid var(--border, #e2e8f0);
      background: var(--bg-card, #fff);
      color: var(--text-dim, #475569);
      transition: all 0.2s ease;
    }
    .rh-btn:hover { border-color: #3b82f6; color: #3b82f6; background: rgba(59,130,246,0.06); }
    .rh-btn.loc-s { border-color:rgba(59,130,246,0.4);  color:#3b82f6;  background:rgba(59,130,246,0.06); }
    .rh-btn.loc-b { border-color:rgba(6,182,212,0.4);   color:#06b6d4;  background:rgba(6,182,212,0.06); }
    .rh-btn.loc-r { border-color:rgba(168,85,247,0.4);  color:#a855f7;  background:rgba(168,85,247,0.06); }
    .rh-btn.dev   { border-color:rgba(59,130,246,0.3);  color:#3b82f6; }
    .rh-btn.date  { border-color:rgba(16,185,129,0.3);  color:#10b981; }
    .rh-btn.danger{ border-color:rgba(239,68,68,0.3);   color:#ef4444; }

    /* ── DATA CARD ── */
    .rh-data-card {
      background: var(--bg, #f8fafc);
      border: 1px solid var(--border, #e2e8f0);
      border-radius: 10px; padding: 10px 12px;
      margin-top: 8px; font-size: 0.78rem;
    }
    .rh-data-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 5px 0; border-bottom: 1px solid var(--border, #e2e8f0);
    }
    .rh-data-row:last-child { border-bottom: none; }
    .rh-data-label { color: var(--text-muted, #94a3b8); font-weight: 600; }
    .rh-data-val   { font-weight: 800; font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; }
    .rh-data-val.ok    { color: #10b981; }
    .rh-data-val.warn  { color: #ef4444; }

    /* ── CHART IN CHAT ── */
    .rh-chart-wrap {
      margin-top: 10px; border-radius: 10px; overflow: hidden;
      border: 1px solid var(--border, #e2e8f0);
      background: var(--bg, #f8fafc); padding: 8px;
    }
    .rh-chart-wrap canvas { max-height: 140px; }

    /* ── INPUT ROW ── */
    .rh-ai-input-row {
      display: flex; gap: 8px; padding: 12px 14px;
      border-top: 1px solid var(--border, #e2e8f0);
      flex-shrink: 0; background: var(--bg-card, #fff);
    }
    .rh-ai-input {
      flex: 1; padding: 9px 14px;
      border: 1.5px solid var(--border, #e2e8f0);
      border-radius: 22px; font-size: 0.83rem;
      outline: none; background: var(--bg, #f8fafc);
      color: var(--text, #1e293b);
      transition: border-color 0.2s;
      font-family: inherit;
    }
    .rh-ai-input:focus { border-color: #3b82f6; }
    .rh-ai-send {
      width: 38px; height: 38px; border-radius: 50%;
      background: linear-gradient(135deg, #1e3a5f, #1d4ed8);
      border: none; cursor: pointer; color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 1rem; flex-shrink: 0; transition: transform 0.2s;
    }
    .rh-ai-send:hover { transform: scale(1.1); }

    @media (max-width: 480px) {
      #rh-ai-panel  { width: calc(100vw - 24px); right: 12px; bottom: 90px; }
      #rh-voice-panel { width: calc(100vw - 24px); right: 12px; bottom: 90px; }
      #rh-mode-panel  { width: calc(100vw - 24px); right: 12px; bottom: 90px; }
      #rh-ai-fab    { bottom: 18px; right: 18px; }
    }

    /* ── MODE SELECTOR PANEL ── */
    #rh-mode-panel {
      position: fixed; bottom: 100px; right: 28px; z-index: 9000;
      width: 320px;
      background: var(--bg-card, #ffffff);
      border: 1px solid var(--border, #e2e8f0);
      border-radius: 22px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08);
      display: none; flex-direction: column; overflow: hidden;
    }
    #rh-mode-panel.rh-open {
      display: flex;
      animation: rh-panel-in 0.28s cubic-bezier(0.34,1.56,0.64,1);
    }
    .rh-mode-body {
      display: flex; gap: 14px; padding: 22px 18px;
    }
    .rh-mode-btn {
      flex: 1; display: flex; flex-direction: column; align-items: center;
      gap: 8px; padding: 18px 10px;
      border: 2px solid var(--border, #e2e8f0);
      border-radius: 16px; background: var(--bg, #f8fafc);
      cursor: pointer; transition: all 0.2s ease;
    }
    .rh-mode-btn:hover {
      border-color: #3b82f6;
      background: rgba(59,130,246,0.06);
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(59,130,246,0.15);
    }
    .rh-mode-icon  { font-size: 2rem; }
    .rh-mode-label { font-size: 0.9rem; font-weight: 700; color: var(--text, #1e293b); }
    .rh-mode-desc  { font-size: 0.72rem; color: var(--text-muted, #94a3b8); }

    /* ── VOICE PANEL ── */
    #rh-voice-panel {
      position: fixed; bottom: 100px; right: 28px; z-index: 9000;
      width: 390px; max-height: 600px;
      background: var(--bg-card, #ffffff);
      border: 1px solid var(--border, #e2e8f0);
      border-radius: 22px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08);
      display: none; flex-direction: column; overflow: hidden;
    }
    #rh-voice-panel.rh-open {
      display: flex;
      animation: rh-panel-in 0.28s cubic-bezier(0.34,1.56,0.64,1);
    }
    .rh-voice-transcript {
      flex: 1; overflow-y: auto; padding: 18px;
      display: flex; flex-direction: column; gap: 10px;
      min-height: 160px; max-height: 260px;
      scroll-behavior: smooth;
    }
    .rh-voice-bot-text {
      font-size: 0.88rem; line-height: 1.6;
      color: var(--text, #1e293b);
      background: var(--bg, #f8fafc);
      border: 1px solid var(--border, #e2e8f0);
      border-radius: 4px 16px 16px 16px;
      padding: 12px 15px; align-self: flex-start;
      max-width: 92%;
    }
    .rh-voice-user-text {
      font-size: 0.85rem; line-height: 1.5;
      color: #fff;
      background: linear-gradient(135deg, #1e3a5f, #1d4ed8);
      border-radius: 16px 16px 4px 16px;
      padding: 10px 14px; align-self: flex-end;
      max-width: 85%;
    }
    .rh-voice-mic-row {
      display: flex; flex-direction: column; align-items: center;
      gap: 8px; padding: 16px 14px 20px;
      border-top: 1px solid var(--border, #e2e8f0);
      flex-shrink: 0;
    }
    .rh-voice-status {
      font-size: 0.78rem; font-weight: 600;
      color: var(--text-muted, #94a3b8); letter-spacing: 0.03em;
    }
    .rh-mic-btn {
      width: 68px; height: 68px; border-radius: 50%;
      background: linear-gradient(135deg, #1e3a5f, #1d4ed8);
      border: none; cursor: pointer; font-size: 1.8rem;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 20px rgba(29,78,216,0.4);
      transition: all 0.2s ease;
    }
    .rh-mic-btn:hover { transform: scale(1.08); }
    .rh-mic-btn.listening {
      background: linear-gradient(135deg, #dc2626, #ef4444);
      animation: rh-mic-pulse 1.2s ease-in-out infinite;
      box-shadow: 0 4px 20px rgba(239,68,68,0.5);
    }
    .rh-mic-btn.speaking {
      background: linear-gradient(135deg, #059669, #10b981);
      box-shadow: 0 4px 20px rgba(16,185,129,0.4);
    }
    @keyframes rh-mic-pulse {
      0%,100% { box-shadow: 0 4px 20px rgba(239,68,68,0.5), 0 0 0 0 rgba(239,68,68,0.3); }
      50%      { box-shadow: 0 4px 20px rgba(239,68,68,0.5), 0 0 0 14px rgba(239,68,68,0); }
    }
    .rh-voice-hint {
      font-size: 0.7rem; color: var(--text-muted, #94a3b8);
    }
  `;
  document.head.appendChild(style);

  // ── INJECT HTML ───────────────────────────────────────────
  const wrap = document.createElement('div');
 wrap.innerHTML = `
    <!-- FAB -->
    <button id="rh-ai-fab" title="Ask RH-Meter AI" onclick="rhAI.toggle()">
      ✨
      <span class="rh-fab-badge" id="rh-fab-badge">1</span>
    </button>

    <!-- Mode Selector -->
    <div id="rh-mode-panel">
      <div class="rh-ai-header">
        <div class="rh-ai-header-left">
          <div class="rh-ai-avatar">✨</div>
          <div>
            <div class="rh-ai-title">RH-Meter Assistant</div>
            <div class="rh-ai-sub">How would you like to interact?</div>
          </div>
        </div>
        <button class="rh-ai-close" onclick="rhAI.toggle()">✕</button>
      </div>
      <div class="rh-mode-body">
        <button class="rh-mode-btn" onclick="rhAI.openChat()">
          <span class="rh-mode-icon">💬</span>
          <div class="rh-mode-label">Chat Bot</div>
          <div class="rh-mode-desc">Type your questions</div>
        </button>
        <button class="rh-mode-btn" onclick="rhAI.openVoice()">
          <span class="rh-mode-icon">🎙️</span>
          <div class="rh-mode-label">Voice Bot</div>
          <div class="rh-mode-desc">Speak hands-free</div>
        </button>
      </div>
    </div>

    <!-- Chat Panel -->
    <div id="rh-ai-panel">
      <div class="rh-ai-header">
        <div class="rh-ai-header-left">
          <div class="rh-ai-avatar">💬</div>
          <div>
            <div class="rh-ai-title">RH-Meter AI</div>
            <div class="rh-ai-sub">Powered by Gemini</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="rh-ai-close" title="Back" onclick="rhAI.backToSelect()">←</button>
          <button class="rh-ai-close" onclick="rhAI.toggle()">✕</button>
        </div>
      </div>
      <div class="rh-ai-msgs" id="rh-msgs"></div>
      <div class="rh-ai-input-row">
        <input
          class="rh-ai-input" id="rh-input"
          placeholder="Ask about any device or date..."
          onkeydown="if(event.key==='Enter') rhAI.send()"
        >
        <button class="rh-ai-send" onclick="rhAI.send()">➤</button>
      </div>
    </div>

    <!-- Voice Panel -->
    <div id="rh-voice-panel">
      <div class="rh-ai-header">
        <div class="rh-ai-header-left">
          <div class="rh-ai-avatar">🎙️</div>
          <div>
            <div class="rh-ai-title">Voice Bot</div>
            <div class="rh-ai-sub" id="rh-voice-sub">Ready</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="rh-ai-close" title="Back" onclick="rhAI.backToSelect()">←</button>
          <button class="rh-ai-close" onclick="rhAI.toggle()">✕</button>
        </div>
      </div>

      <!-- Voice transcript area -->
      <div class="rh-voice-transcript" id="rh-voice-transcript">
        <div class="rh-voice-bot-text" id="rh-voice-bot-text">Press the mic and start talking!</div>
      </div>

      <!-- Voice quick buttons (backup) -->
      <div class="rh-btns" id="rh-voice-btns" style="padding:10px 14px;flex-wrap:wrap;display:flex;gap:7px;"></div>

      <!-- Mic button -->
      <div class="rh-voice-mic-row">
        <div class="rh-voice-status" id="rh-voice-status">Tap mic to start</div>
        <button class="rh-mic-btn" id="rh-mic-btn" onclick="rhAI.toggleMic()">🎙️</button>
        <div class="rh-voice-hint">Say "bye" to exit voice mode</div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  // ── CORE AI OBJECT (exposed as window.rhAI) ───────────────
  window.rhAI = {

    // ── Toggle panel open/close ──────────────────────────────
    toggle() {
      panelOpen = !panelOpen;
      document.getElementById('rh-fab-badge').style.display = 'none';
      if (!panelOpen) {
        document.getElementById('rh-mode-panel').classList.remove('rh-open');
        document.getElementById('rh-ai-panel').classList.remove('rh-open');
        document.getElementById('rh-voice-panel').classList.remove('rh-open');
        voiceStop();
      } else {
        document.getElementById('rh-mode-panel').classList.add('rh-open');
      }
    },

    // ── Open mode selector ───────────────────────────────────
    backToSelect() {
      voiceStop();
      document.getElementById('rh-ai-panel').classList.remove('rh-open');
      document.getElementById('rh-voice-panel').classList.remove('rh-open');
      document.getElementById('rh-mode-panel').classList.add('rh-open');
    },

    openChat() {
      document.getElementById('rh-mode-panel').classList.remove('rh-open');
      document.getElementById('rh-ai-panel').classList.add('rh-open');
      if (aiState.step === 'welcome') this.start();
      setTimeout(() => document.getElementById('rh-input')?.focus(), 300);
    },

    openVoice() {
      document.getElementById('rh-mode-panel').classList.remove('rh-open');
      document.getElementById('rh-voice-panel').classList.add('rh-open');
      voiceStart();
    },

    toggleMic() {
      if (voiceState.listening) {
        voiceStopListening();
      } else {
        voiceStartListening();
      }
    },

    // ── Start / restart conversation ─────────────────────────
    start() {
      aiState      = { step: 'location', location: null, deviceId: null };
      chatHistory  = [];
      document.getElementById('rh-msgs').innerHTML = '';
      addBot(
        `👋 Hi! I'm your <b>RH-Meter AI</b> assistant.\n\nI can fetch <b>live readings</b>, <b>historical data</b> for any date range, <b>threshold breaches</b>, and <b>daily stats</b> for any device.\n\nWhich location would you like to check?`,
        [
          { label: '🏭 Samudra', cls: 'loc-s', fn: () => selectLoc('samudra') },
          { label: '🏢 BNG',     cls: 'loc-b', fn: () => selectLoc('bng') },
          { label: '🔬 R&D',     cls: 'loc-r', fn: () => selectLoc('rd') },
        ]
      );
    },

    // ── Send typed message ───────────────────────────────────
    async send() {
      const inp  = document.getElementById('rh-input');
      const text = inp.value.trim();
      if (!text) return;
      inp.value = '';
      addUser(text);

      const tl = text.toLowerCase();

      // ── 1. Awaiting date input ────────────────────────────
      if (aiState.step === 'awaitDate' || aiState.step === 'awaitBreachDate') {
        const prevStep = aiState.step;
        // Try any date format (DD-MM-YYYY, YYYY-MM-DD, DD/MM/YYYY, etc.)
        const dates = extractDates(text);
        if (dates.length) {
          const from = dates[0];
          const to   = dates[1] || dates[0];
          aiState.step = 'action';
          if (prevStep === 'awaitBreachDate') fetchBreaches(aiState.deviceId, from, to);
          else fetchDateRange(aiState.deviceId, from, to);
          return;
        }
        // Try natural language phrases
        const parsed = parseDatePhrase(tl);
        if (parsed) {
          aiState.step = 'action';
          if (prevStep === 'awaitBreachDate') fetchBreaches(aiState.deviceId, parsed.from, parsed.to);
          else fetchDateRange(aiState.deviceId, parsed.from, parsed.to);
          return;
        }
        // Still in date-await — fall through to intent detection
      }

      // ── 2. Smart intent detection (no API call needed) ────
      const today = isoDate(new Date());
      const id    = aiState.deviceId;

      // Greeting
      if (/^(hi|hello|hey|good\s*(morning|evening|afternoon)|how are you|sup|what'?s up)/i.test(tl)) {
        addBot(`👋 Hello! I'm your RH-Meter AI assistant. I can help you check <b>live readings</b>, <b>historical data</b>, <b>threshold breaches</b> and more for any factory device.\n\nWhat would you like to check?`, [
          { label:'🏭 Samudra', cls:'loc-s', fn:()=>selectLoc('samudra') },
          { label:'🏢 BNG',     cls:'loc-b', fn:()=>selectLoc('bng') },
          { label:'🔬 R&D',     cls:'loc-r', fn:()=>selectLoc('rd') },
        ]);
        return;
      }

      // Live / current reading
      if (/live|current|now|real.?time|latest|right now/i.test(tl)) {
        if (id) { fetchLive(id); return; }
        addBot('Which device do you want the live reading for?', deviceBtns());
        return;
      }

      // Today's stats
      if (/today|daily|this day|today.?s/i.test(tl) && !/breach|alert|exceed/i.test(tl)) {
        if (id) { fetchToday(id); return; }
        addBot("Which device do you want today's stats for?", deviceBtns());
        return;
      }

      // Temperature specific
      if (/\btemp(erature)?\b/i.test(tl) && !/breach|alert|exceed/i.test(tl)) {
        if (id) {
          addBot(`You want temperature data for <b>${deviceName(id)}</b>. Which period?`, [
            { label:'⚡ Live now',       cls:'dev',  fn:()=>fetchLive(id) },
            { label:"📊 Today's stats",  cls:'dev',  fn:()=>fetchToday(id) },
            { label:'📅 Date range',     cls:'date', fn:()=>askDate(id) },
          ]);
        } else {
          addBot('Which device do you want temperature data for?', deviceBtns());
        }
        return;
      }

      // Humidity specific
      if (/\bhumid(ity)?\b/i.test(tl) && !/breach|alert|exceed/i.test(tl)) {
        if (id) {
          addBot(`You want humidity data for <b>${deviceName(id)}</b>. Which period?`, [
            { label:'⚡ Live now',       cls:'dev',  fn:()=>fetchLive(id) },
            { label:"📊 Today's stats",  cls:'dev',  fn:()=>fetchToday(id) },
            { label:'📅 Date range',     cls:'date', fn:()=>askDate(id) },
          ]);
        } else {
          addBot('Which device do you want humidity data for?', deviceBtns());
        }
        return;
      }

      // Breaches / alerts / exceeded
      if (/breach|alert|exceed|threshold|warning|alarm/i.test(tl)) {
        if (id) { askBreachDate(id); return; }
        addBot('Which device do you want breach data for?', deviceBtns());
        return;
      }

      // History / data by date
      if (/histor|date|range|week|month|last \d|yesterday|data for|fetch|report/i.test(tl)) {
        if (id) { askDate(id); return; }
        addBot('Which device do you want historical data for?', deviceBtns());
        return;
      }

      // Status / online / offline
      if (/status|online|offline|working|active|down/i.test(tl)) {
        const cache = getStatusCache();
        if (id) {
          const s  = cache[id] || {};
          const nm = deviceName(id);
          const statusTxt = s.online === true
            ? `✅ <b>${nm}</b> is <b style="color:#10b981">Online</b>. Last reading: T=${parseFloat(s.temp||0).toFixed(1)}°C, H=${parseFloat(s.hum||0).toFixed(1)}%`
            : s.online === false
            ? `🔴 <b>${nm}</b> is currently <b style="color:#ef4444">Offline</b>.`
            : `⏳ <b>${nm}</b> status is still being checked...`;
          addBot(statusTxt, moreBtns(id));
        } else {
          // Show status of all devices
          const lines = Object.keys(getDeviceNames()).map(did => {
            const s  = cache[did] || {};
            const nm = deviceName(did);
            const icon = s.online === true ? '🟢' : s.online === false ? '🔴' : '⏳';
            return `${icon} <b>${nm}</b> (${did})`;
          }).join('<br>');
          addBot(`<b>Device Status Overview:</b><br>${lines}`, [
            { label:'🏭 Samudra', cls:'loc-s', fn:()=>selectLoc('samudra') },
            { label:'🏢 BNG',     cls:'loc-b', fn:()=>selectLoc('bng') },
            { label:'🔬 R&D',     cls:'loc-r', fn:()=>selectLoc('rd') },
          ]);
        }
        return;
      }

      // Which devices / list devices
      if (/which device|list device|all device|show device|devices/i.test(tl)) {
        addBot('Here are all devices by location:', [
          { label:'🏭 Samudra', cls:'loc-s', fn:()=>selectLoc('samudra') },
          { label:'🏢 BNG',     cls:'loc-b', fn:()=>selectLoc('bng') },
          { label:'🔬 R&D',     cls:'loc-r', fn:()=>selectLoc('rd') },
        ]);
        return;
      }

      // Help / what can you do
      if (/help|what can|capabilities|features|guide|how to use/i.test(tl)) {
        addBot(
          `🤖 <b>Here's what I can do:</b><br><br>` +
          `⚡ <b>Live reading</b> — real-time temp & humidity<br>` +
          `📊 <b>Today's stats</b> — min/avg/max for today<br>` +
          `📅 <b>Date range data</b> — any past dates (e.g. 2025-03-01 to 2025-03-15)<br>` +
          `⚠️ <b>Threshold breaches</b> — when readings exceeded limits<br>` +
          `📶 <b>Device status</b> — online/offline check<br><br>` +
          `Just pick a location to get started!`,
          [
            { label:'🏭 Samudra', cls:'loc-s', fn:()=>selectLoc('samudra') },
            { label:'🏢 BNG',     cls:'loc-b', fn:()=>selectLoc('bng') },
            { label:'🔬 R&D',     cls:'loc-r', fn:()=>selectLoc('rd') },
          ]
        );
        return;
      }

      // Device name mentioned in text — auto-select it
      const allIds = Object.keys(getDeviceNames());
      const mentionedId = allIds.find(did => {
        const nm = deviceName(did).toLowerCase();
        return tl.includes(did.toLowerCase()) || tl.includes(nm);
      });
      if (mentionedId) {
        selectDevice(mentionedId);
        return;
      }

      // Location mentioned
      if (/samudra/i.test(tl)) { selectLoc('samudra'); return; }
      if (/\bbng\b/i.test(tl))  { selectLoc('bng');     return; }
      if (/r&d|r and d|rd\b/i.test(tl)) { selectLoc('rd'); return; }

      // ── 3. Fallback → Gemini conversational ──────────────
      const typing = addTyping();
      const cache  = getStatusCache();
      const th     = getThresholds();

      const deviceCtx = Object.entries(cache).map(([did, s]) => {
        const nm = deviceName(did);
        return s.online
          ? `${nm}(${did}): online T=${parseFloat(s.temp||0).toFixed(1)}°C H=${parseFloat(s.hum||0).toFixed(1)}%`
          : `${nm}(${did}): offline`;
      }).join('; ');

      chatHistory.push({ role: 'user', parts: [{ text }] });

      try {
        const res  = await fetch(GEMINI_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text:
              `You are RH-Meter AI, a smart factory humidity & temperature monitoring assistant for Aquarelle India Pvt. Ltd. ` +
              `Factory locations: Samudra, BNG, R&D. ` +
              `Current device statuses: ${deviceCtx || 'not loaded yet'}. ` +
              `Temperature threshold: ${th.temp}°C. Humidity threshold: ${th.hum}%. ` +
              `Current device context: ${id ? deviceName(id)+' ('+id+')' : 'none selected'}. ` +
              `IMPORTANT: Always answer helpfully. If asked about temperature/humidity/data, guide the user to select a device and use the chat buttons. ` +
              `Keep answers under 3 sentences. Be friendly and practical.`
            }] },
            contents: chatHistory,
            generationConfig: { maxOutputTokens: 200, temperature: 0.5 }
          })
        });
        const data  = await res.json();
        const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!reply) {
          removeEl(typing);
          addBot(
            `🤔 I didn't quite understand that. Here's what I can help with:`,
            [
              { label:'⚡ Live reading',   cls:'dev',    fn: id ? ()=>fetchLive(id)    : ()=>addBot('Pick a location first:',locBtns()) },
              { label:"📊 Today's stats",  cls:'dev',    fn: id ? ()=>fetchToday(id)   : ()=>addBot('Pick a location first:',locBtns()) },
              { label:'📅 Date range',     cls:'date',   fn: id ? ()=>askDate(id)      : ()=>addBot('Pick a location first:',locBtns()) },
              { label:'⚠️ Breaches',       cls:'danger', fn: id ? ()=>askBreachDate(id): ()=>addBot('Pick a location first:',locBtns()) },
              { label:'🏠 Start over',     cls:'',       fn: ()=>rhAI.start() },
            ]
          );
          return;
        }

        chatHistory.push({ role: 'model', parts: [{ text: reply }] });
        removeEl(typing);
        addBot(reply, id ? moreBtns(id) : locBtns());
      } catch (e) {
        removeEl(typing);
        addBot(
          `🤔 I didn't understand that. Try asking about a specific device or pick an option:`,
          [
            { label:'🏭 Samudra', cls:'loc-s', fn:()=>selectLoc('samudra') },
            { label:'🏢 BNG',     cls:'loc-b', fn:()=>selectLoc('bng') },
            { label:'🔬 R&D',     cls:'loc-r', fn:()=>selectLoc('rd') },
          ]
        );
      }
    }
  };

  // ── _pick / _pickCustom — standalone functions called from date picker HTML ──
  window.rhAI._pick = function(id, from, to) {
    aiState.step     = 'action';
    aiState.deviceId = id;
    fetchDateRange(id, from, to);
  };

  window.rhAI._pickCustom = function(id, pid) {
    const fromEl = document.getElementById(pid + '-from');
    const toEl   = document.getElementById(pid + '-to');
    if (!fromEl || !toEl) return;
    const from = normalizeDate(fromEl.value) || fromEl.value;
    const to   = normalizeDate(toEl.value)   || toEl.value;
    if (!from || !to) { addBot('⚠️ Please select both From and To dates.'); return; }
    if (from > to)    { addBot('⚠️ "From" date must be before "To" date.'); return; }
    aiState.step     = 'action';
    aiState.deviceId = id;
    addUser('📅 ' + (from === to ? from : from + ' → ' + to));
    fetchDateRange(id, from, to);
  };

  // ── Location selection ────────────────────────────────────
  function selectLoc(loc) {
    aiState.location = loc;
    aiState.step     = 'device';
    const label = { samudra:'Samudra', bng:'BNG', rd:'R&D' }[loc];
    addUser(`📍 ${label}`);

    const ids  = LOCATION_DEVICES[loc] || [];
    const btns = ids.map(id => ({
      label: `${id} — ${deviceName(id)}`,
      cls:   'dev',
      fn:    () => selectDevice(id)
    }));
    addBot(`Here are the devices in <b>${label}</b>. Which one do you want to check?`, btns);
  }

  // ── Device selection ──────────────────────────────────────
  function selectDevice(id) {
    aiState.deviceId = id;
    aiState.step     = 'action';
    const nm = deviceName(id);
    addUser(`📟 ${id} — ${nm}`);
    addBot(
      `What would you like to know about <b>${nm}</b>?`,
      [
        { label:'⚡ Live reading',       cls:'dev',    fn:()=>fetchLive(id) },
        { label:"📊 Today's stats",      cls:'dev',    fn:()=>fetchToday(id) },
        { label:'📅 Data by date range', cls:'date',   fn:()=>askDate(id) },
        { label:'⚠️ Threshold breaches', cls:'danger', fn:()=>askBreachDate(id) },
        { label:'🔄 Different device',   cls:'',       fn:()=>selectLoc(aiState.location) },
      ]
    );
  }

  // ── Live reading ──────────────────────────────────────────
async function fetchLive(id) {
    addUser('⚡ Live reading');
    const t  = addTyping();
    const SV = getServerUrl();
    const th = getThresholds();
    try {
      const res  = await fetch(`${SV}/api/data?deviceId=${id}&_t=${Date.now()}`);
      const data = await res.json();
      removeEl(t);
      const temp = data.temperature ?? data.temp;
      const hum  = data.humidity    ?? data.hum;
      const nm   = deviceName(id);
      if (temp == null) {
        addBot(`⚠️ No live data for <b>${nm}</b> — device may be offline.`, moreBtns(id));
        return;
      }
      const tA  = temp > th.temp;
      const hA  = hum  > th.hum;
      const ts  = data.timestamp
        ? new Date(new Date(data.timestamp).getTime() + 5.5*3600000)
            .toUTCString().slice(17,22) + ' IST'
        : 'just now';
      const sum = await gemini(
        `Device: ${nm} (${id}). Live reading: Temp=${temp}°C (threshold ${th.temp}°C), Hum=${hum}% (threshold ${th.hum}%). ${tA?'Temperature ABOVE threshold!':''} ${hA?'Humidity ABOVE threshold!':''} Give a 2-sentence status summary.`
      );
      addBot(`📡 <b>Live — ${nm}</b>${sum ? '<br><br>' + sum : ''}`, null,
        dataCard([
          { label:'🌡️ Temperature', val:`${parseFloat(temp).toFixed(1)} °C`, alert:tA },
          { label:'💧 Humidity',    val:`${parseFloat(hum).toFixed(1)} %`,   alert:hA },
          { label:'🕐 Time',        val:ts,                                  alert:false },
          { label:'📶 Status',      val:tA||hA?'⚠️ Alert':'✅ Normal',       alert:tA||hA },
        ])
      );
      showMore(id);
    } catch {
      removeEl(t);
      addBot('❌ Failed to fetch live data.', moreBtns(id));
    }
  }

  // ── Today stats ───────────────────────────────────────────
  async function fetchToday(id) {
    addUser("📊 Today's stats");
    const t    = addTyping();
    const today = isoDate(new Date());
    await fetchDateRange(id, today, today, t, true);
  }

  // ── Ask for date range — with date picker UI ────────────
  function askDate(id) {
    addUser('📅 Data by date range');
    const today = isoDate(new Date());
    const yest  = isoDate(new Date(Date.now()-86400000));
    const w7    = isoDate(new Date(Date.now()-6*86400000));
    const d30   = isoDate(new Date(Date.now()-29*86400000));

    const msgs = document.getElementById('rh-msgs');
    const div  = document.createElement('div');
    div.className = 'rh-msg rh-bot';

    // Unique ID for this picker
    const pid = 'rhpick-' + Date.now();
    div.innerHTML = `
      <div style="font-weight:600;margin-bottom:10px;">📅 Select a date range for <b>${deviceName(id)}</b>:</div>
      <div class="rh-btns" style="margin-bottom:12px;">
        <button class="rh-btn date" onclick="rhAI._pick('${id}','${today}','${today}')">📅 Today</button>
        <button class="rh-btn date" onclick="rhAI._pick('${id}','${yest}','${yest}')">📅 Yesterday</button>
        <button class="rh-btn date" onclick="rhAI._pick('${id}','${w7}','${today}')">📅 Last 7 days</button>
        <button class="rh-btn date" onclick="rhAI._pick('${id}','${d30}','${today}')">📅 Last 30 days</button>
      </div>
      <div style="font-size:0.78rem;color:var(--text-muted,#94a3b8);font-weight:600;margin-bottom:6px;">OR PICK CUSTOM DATES:</div>
      <div id="${pid}" style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:0.75rem;color:var(--text-dim,#475569);font-weight:600;width:28px;">From</span>
          <input type="date" id="${pid}-from" value="${today}"
            style="flex:1;padding:6px 10px;border:1.5px solid var(--border,#e2e8f0);border-radius:8px;
                   font-size:0.8rem;background:var(--bg,#f8fafc);color:var(--text,#1e293b);outline:none;">
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:0.75rem;color:var(--text-dim,#475569);font-weight:600;width:28px;">To</span>
          <input type="date" id="${pid}-to" value="${today}"
            style="flex:1;padding:6px 10px;border:1.5px solid var(--border,#e2e8f0);border-radius:8px;
                   font-size:0.8rem;background:var(--bg,#f8fafc);color:var(--text,#1e293b);outline:none;">
        </div>
        <button onclick="rhAI._pickCustom('${id}','${pid}')"
          style="padding:8px 16px;background:linear-gradient(135deg,#1e3a5f,#1d4ed8);color:#fff;
                 border:none;border-radius:10px;font-size:0.82rem;font-weight:700;cursor:pointer;
                 transition:opacity 0.2s;" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
          🔍 Fetch Data
        </button>
      </div>
      <div style="font-size:0.72rem;color:var(--text-muted,#94a3b8);margin-top:8px;">
        💡 You can also type: <b>20-02-2026</b> or <b>20/02/2026 to 02/04/2026</b>
      </div>
    `;

    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;

    aiState.step     = 'awaitDate';
    aiState.deviceId = id;
  }

  // ── Ask for breach date range ─────────────────────────────
  function askBreachDate(id) {
    addUser('⚠️ Threshold breaches');
    const today = isoDate(new Date());
    addBot(
      `Which date range for breach data?`,
      [
        { label:'📅 Today',        cls:'date',   fn:()=>{ aiState.step='action'; fetchBreaches(id,today,today); } },
        { label:'📅 Last 7 days',  cls:'date',   fn:()=>{ aiState.step='action'; fetchBreaches(id,isoDate(new Date(Date.now()-6*86400000)),today); } },
        { label:'📅 Last 30 days', cls:'danger', fn:()=>{ aiState.step='action'; fetchBreaches(id,isoDate(new Date(Date.now()-29*86400000)),today); } },
      ]
    );
    aiState.step     = 'awaitBreachDate';
    aiState.prevStep = 'awaitBreachDate';
    aiState.deviceId = id;
  }

  // ── Fetch data for a date range ───────────────────────────
async function fetchDateRange(id, from, to, existingTyping, isToday) {
    if (!existingTyping) addUser(`📅 ${from === to ? from : from + ' → ' + to}`);
    const t  = existingTyping || addTyping();
    const SV = getServerUrl();
    const th = getThresholds();
    const nm = deviceName(id);
    try {
      const res     = await fetch(`${SV}/api/history?deviceId=${id}&from=${from}&to=${to}&_t=${Date.now()}`);
      const records = await res.json();
      removeEl(t);

      if (!records.length) {
        addBot(`📭 No data found for <b>${nm}</b> between <b>${from}</b> and <b>${to}</b>. The device may not have recorded anything in this period.`, moreBtns(id));
        return;
      }

      const isSingleDay = from === to;
      const avg = arr => (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1);

      if (isSingleDay || isToday) {
        const temps = records.map(r => r.temperature ?? r.temp).filter(v => v != null);
        const hums  = records.map(r => r.humidity    ?? r.hum ).filter(v => v != null);
        const minT  = Math.min(...temps).toFixed(1), maxT = Math.max(...temps).toFixed(1), avgT = avg(temps);
        const minH  = Math.min(...hums).toFixed(1),  maxH = Math.max(...hums).toFixed(1),  avgH = avg(hums);
        const tB    = temps.filter(v => v > th.temp).length;
        const hB    = hums.filter(v  => v > th.hum ).length;
        const sum   = await gemini(`Device: ${nm}. ${isToday?'Today':'Date '+from} stats (${records.length} readings): Temp min=${minT} avg=${avgT} max=${maxT}°C. Hum min=${minH} avg=${avgH} max=${maxH}%. Thresholds temp=${th.temp}°C hum=${th.hum}%. 2-sentence summary.`);
        addBot(`${isToday?'📊 Today':'📅 '+from} — <b>${nm}</b>${sum ? '<br><br>' + sum : ''}`, null,
          dataCard([
            { label:'🌡️ Min / Avg / Max Temp', val:`${minT} / ${avgT} / ${maxT} °C`, alert: parseFloat(maxT) > th.temp },
            { label:'💧 Min / Avg / Max Hum',  val:`${minH} / ${avgH} / ${maxH} %`,  alert: parseFloat(maxH) > th.hum  },
            { label:'📦 Readings',             val: records.length,  alert:false },
            { label:'⚠️ Temp Breaches',        val: tB,              alert: tB > 0 },
            { label:'⚠️ Hum Breaches',         val: hB,              alert: hB > 0 },
          ])
        );
      } else {
        const dayMap = {};
        records.forEach(r => {
          const d   = new Date(r.timestamp);
          const ist = new Date(d.getTime() + 5.5*3600000);
          const key = ist.getUTCFullYear() + '-' +
            String(ist.getUTCMonth()+1).padStart(2,'0') + '-' +
            String(ist.getUTCDate()).padStart(2,'0');
          if (!dayMap[key]) dayMap[key] = { temps:[], hums:[] };
          const tv = r.temperature ?? r.temp;
          const hv = r.humidity    ?? r.hum;
          if (tv != null) dayMap[key].temps.push(tv);
          if (hv != null) dayMap[key].hums.push(hv);
        });

        const days    = Object.keys(dayMap).sort();
        const allT    = records.map(r => r.temperature ?? r.temp).filter(v => v != null);
        const allH    = records.map(r => r.humidity    ?? r.hum).filter(v => v != null);
        const totalTB = allT.filter(v => v > th.temp).length;
        const totalHB = allH.filter(v => v > th.hum ).length;

        const sum = await gemini(`Device: ${nm}. Range ${from} to ${to} (${days.length} days, ${records.length} readings). Overall temp avg=${avg(allT)}°C max=${Math.max(...allT).toFixed(1)}°C. Hum avg=${avg(allH)}% max=${Math.max(...allH).toFixed(1)}%. ${totalTB} temp breaches, ${totalHB} hum breaches. 2-sentence overview.`);
        addBot(`📅 <b>${nm}</b> · ${from} → ${to} · ${days.length} days${sum ? '<br><br>' + sum : ''}`);

        days.forEach(day => {
          const d    = dayMap[day];
          if (!d.temps.length) return;
          const minT = Math.min(...d.temps).toFixed(1), maxT = Math.max(...d.temps).toFixed(1), avgT = avg(d.temps);
          const minH = Math.min(...d.hums).toFixed(1),  maxH = Math.max(...d.hums).toFixed(1),  avgH = avg(d.hums);
          const tB   = d.temps.filter(v => v > th.temp).length;
          const hB   = d.hums.filter(v  => v > th.hum ).length;
          const anyAlert = tB > 0 || hB > 0;

          const msgs = document.getElementById('rh-msgs');
          const wrap = document.createElement('div');
          wrap.className = 'rh-msg rh-bot';
          wrap.style.cssText = anyAlert
            ? 'border-left:3px solid #ef4444;background:rgba(254,242,242,0.6);'
            : 'border-left:3px solid #10b981;';

          const dateLabel = new Date(day + 'T12:00:00Z')
            .toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' });

          wrap.innerHTML = `<div style="font-size:0.78rem;font-weight:700;color:${anyAlert?'#ef4444':'#10b981'};margin-bottom:6px;">
            ${anyAlert?'⚠️':'✅'} ${dateLabel} &nbsp;<span style="font-size:0.68rem;font-weight:500;color:var(--text-muted,#94a3b8);">(${d.temps.length} readings)</span>
          </div>`;
          wrap.appendChild(dataCard([
            { label:'🌡️ Min / Avg / Max Temp', val:`${minT} / ${avgT} / ${maxT} °C`, alert: parseFloat(maxT) > th.temp },
            { label:'💧 Min / Avg / Max Hum',  val:`${minH} / ${avgH} / ${maxH} %`,  alert: parseFloat(maxH) > th.hum  },
            { label:'⚠️ Temp / Hum Breaches',  val:`${tB} / ${hB}`,                  alert: anyAlert },
          ]));
          msgs.appendChild(wrap);
          msgs.scrollTop = msgs.scrollHeight;
        });
      }

      showMore(id);
    } catch(e) {
      removeEl(t);
      addBot('❌ Failed to fetch data. Please try again.', moreBtns(id));
    }
  }

  // ── Fetch breach data ─────────────────────────────────────
async function fetchBreaches(id, from, to) {
    addUser(`⚠️ Breaches ${from === to ? from : from+' → '+to}`);
    const t  = addTyping();
    const SV = getServerUrl();
    const th = getThresholds();
    const nm = deviceName(id);
    try {
      const res     = await fetch(`${SV}/api/history?deviceId=${id}&from=${from}&to=${to}&_t=${Date.now()}`);
      const records = await res.json();
      removeEl(t);

      if (!records.length) {
        addBot(`📭 No data found for <b>${nm}</b> in this range.`, moreBtns(id));
        return;
      }

      const breaches = records.filter(r =>
        (r.temperature ?? r.temp) > th.temp || (r.humidity ?? r.hum) > th.hum
      );

      if (!breaches.length) {
        addBot(`✅ <b>No breaches</b> for <b>${nm}</b> between ${from} and ${to}. All readings were within safe limits!`, moreBtns(id));
        return;
      }

      const bRate = ((breaches.length / records.length) * 100).toFixed(1);
      const sum   = await gemini(
        `Device: ${nm}. ${from} to ${to}: ${records.length} total readings, ${breaches.length} breached thresholds (temp>${th.temp}°C or hum>${th.hum}%). Breach rate: ${bRate}%. Give a 2-sentence alert summary.`
      );

      addBot(`⚠️ <b>Breach Report — ${nm}</b>${sum ? '<br><br>' + sum : ''}`, null,
        dataCard([
          { label:'📦 Total Readings',  val:records.length,  alert:false },
          { label:'⚠️ Breached',        val:breaches.length, alert:true  },
          { label:'✅ Normal',          val:records.length - breaches.length, alert:false },
          { label:'📊 Breach Rate',     val:`${bRate}%`,     alert:parseFloat(bRate) > 10 },
        ])
      );
      showMore(id);
    } catch {
      removeEl(t);
      addBot('❌ Failed to fetch breach data.', moreBtns(id));
    }
  }

  // ── Gemini API call — via server proxy ───────────────────

const geminiQueue = {
  lastCall:    0,
  minGap:      4500,          // max ~13 calls/min, well under the 15/min free limit
  blocked:     false,         // true when we know we're rate-limited
  blockedUntil: 0,
};

async function gemini(prompt) {
  if (geminiQueue.blocked && Date.now() < geminiQueue.blockedUntil) {
    return '';
  }
  geminiQueue.blocked = false;

  const now  = Date.now();
  const wait = geminiQueue.minGap - (now - geminiQueue.lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  geminiQueue.lastCall = Date.now();

  try {
    const res = await fetch(`${getServerUrl()}/api/gemini`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ prompt })
    });

    if (!res.ok) {
      if (res.status === 429) {
        geminiQueue.blocked      = true;
        geminiQueue.blockedUntil = Date.now() + 60000;
      }
      return '';
    }

    const data = await res.json();
    return data?.text || '';

  } catch {
    return '';
  }
}

  // ── Voice transcription — Gemini audio via server proxy ───
  async function transcribeWithWhisper(audioBlob) {
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const uint8Array  = new Uint8Array(arrayBuffer);
      let binary = '';
      uint8Array.forEach(b => binary += String.fromCharCode(b));
      const base64Audio = btoa(binary);

      const now  = Date.now();
      const wait = geminiQueue.minGap - (now - geminiQueue.lastCall);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      geminiQueue.lastCall = Date.now();

      for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await fetch(`${getServerUrl()}/api/gemini`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parts: [
              {
                inline_data: {
                  mime_type: 'audio/webm',
                  data:      base64Audio
                }
              },
              {
                text: `Transcribe exactly what is spoken in this audio.
This is a factory monitoring voice assistant.
Possible words: Samudra, BNG, R&D, Meter 01 to Meter 13,
live reading, today, yesterday, last 7 days, last 30 days,
threshold breaches, date range, bye.
Return ONLY the transcribed text, nothing else.`
              }
            ]
          })
        });

        if (res.status === 429) {
          await new Promise(r => setTimeout(r, attempt * 4000));
          continue;
        }

        const data  = await res.json();
        if (data.error) throw new Error(data.error);
        const clean = (data.text || '').trim().replace(/^["']|["']$/g, '');
        console.log('🎙️ [Gemini STT]:', clean);
        return clean;
      }
      return '';
    } catch (err) {
      console.error('Transcribe error:', err);
      return '';
    }
  }

  // ── Date helpers ──────────────────────────────────────────
  function isoDate(d) { return d.toISOString().slice(0, 10); }

  // Accept ANY date format: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, D.M.YYYY etc.
  function normalizeDate(str) {
    if (!str) return null;
    str = str.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    if (/^\d{4}\/\d{2}\/\d{2}$/.test(str)) return str.replace(/\//g, '-');
    const dmy = str.match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{4})$/);
    if (dmy) {
      const [, d, m, y] = dmy;
      return y + '-' + m.padStart(2,'0') + '-' + d.padStart(2,'0');
    }
    return null;
  }

  function extractDates(text) {
    const pattern = /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}|\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{4})/g;
    const matches = [];
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const norm = normalizeDate(m[1]);
      if (norm) matches.push(norm);
    }
    return matches;
  }

  function parseDatePhrase(text) {
    const t     = text.toLowerCase();
    const today = isoDate(new Date());
    if (t.includes('today'))      return { from: today, to: today };
    if (t.includes('yesterday'))  { const y = isoDate(new Date(Date.now()-86400000)); return { from:y, to:y }; }
    if (t.includes('last 7'))     return { from: isoDate(new Date(Date.now()-6*86400000)), to: today };
    if (t.includes('last 30'))    return { from: isoDate(new Date(Date.now()-29*86400000)), to: today };
    if (t.includes('this week'))  return { from: isoDate(new Date(Date.now()-6*86400000)), to: today };
    if (t.includes('this month')) {
      const n = new Date(); return { from: isoDate(new Date(n.getFullYear(), n.getMonth(), 1)), to: today };
    }
    const dates = extractDates(text);
    if (dates.length >= 2) return { from: dates[0], to: dates[1] };
    if (dates.length === 1) return { from: dates[0], to: dates[0] };
    return null;
  }

  // ── UI helpers ────────────────────────────────────────────
  function addBot(html, btns, extra) {
    const msgs = document.getElementById('rh-msgs');
    const div  = document.createElement('div');
    div.className = 'rh-msg rh-bot';
    div.innerHTML = html.replace(/\n/g, '<br>');
    if (extra) div.appendChild(extra);
    if (btns && btns.length) {
      const row = document.createElement('div');
      row.className = 'rh-btns';
      btns.forEach(b => {
        const btn = document.createElement('button');
        btn.className   = `rh-btn ${b.cls || ''}`;
        btn.textContent = b.label;
        btn.onclick     = b.fn;
        row.appendChild(btn);
      });
      div.appendChild(row);
    }
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }

  function addUser(text) {
    const msgs = document.getElementById('rh-msgs');
    const div  = document.createElement('div');
    div.className   = 'rh-msg rh-user';
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function addTyping() {
    const msgs = document.getElementById('rh-msgs');
    const div  = document.createElement('div');
    div.className = 'rh-msg rh-typing';
    div.innerHTML = '<div class="rh-dots"><span></span><span></span><span></span></div>';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }

  function removeEl(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

  function dataCard(rows) {
    const card = document.createElement('div');
    card.className = 'rh-data-card';
    rows.forEach(r => {
      const row = document.createElement('div');
      row.className = 'rh-data-row';
      const lbl = document.createElement('span');
      lbl.className   = 'rh-data-label';
      lbl.textContent = r.label;
      const val = document.createElement('span');
      val.className   = `rh-data-val ${r.alert ? 'warn' : 'ok'}`;
      val.textContent = r.val;
      row.appendChild(lbl);
      row.appendChild(val);
      card.appendChild(row);
    });
    return card;
  }

  // ── All devices as quick buttons ──────────────────────────
  function deviceBtns() {
    return Object.keys(getDeviceNames()).map(did => ({
      label: `${did} — ${deviceName(did)}`,
      cls:   'dev',
      fn:    () => selectDevice(did)
    }));
  }

  // ── Location buttons ──────────────────────────────────────
  function locBtns() {
    return [
      { label:'🏭 Samudra', cls:'loc-s', fn:()=>selectLoc('samudra') },
      { label:'🏢 BNG',     cls:'loc-b', fn:()=>selectLoc('bng') },
      { label:'🔬 R&D',     cls:'loc-r', fn:()=>selectLoc('rd') },
    ];
  }

  function showMore(id) {
    const today = isoDate(new Date());
    addBot('What else would you like to check?', [
      { label:'⚡ Live reading',       cls:'dev',    fn:()=>fetchLive(id) },
      { label:"📊 Today's stats",      cls:'dev',    fn:()=>fetchToday(id) },
      { label:'📅 Data by date range', cls:'date',   fn:()=>askDate(id) },
      { label:'⚠️ Breaches',           cls:'danger', fn:()=>askBreachDate(id) },
      { label:'🔄 Different device',   cls:'',       fn:()=>selectLoc(aiState.location) },
      { label:'🏠 Start over',         cls:'',       fn:()=>rhAI.start() },
    ]);
  }

  function moreBtns(id) {
    if (!id) return [{ label:'🏠 Start over', cls:'', fn:()=>rhAI.start() }];
    return [
      { label:'🔄 Try again',   cls:'dev', fn:()=>selectDevice(id) },
      { label:'🏠 Start over',  cls:'',    fn:()=>rhAI.start() },
    ];
  }

  // ══════════════════════════════════════════════════════════
  //  VOICE ENGINE
  // ══════════════════════════════════════════════════════════

  const voiceState = {
    listening:   false,
    speaking:    false,
    recognition: null,
    location:    null,
    deviceId:    null,
    step:        'location',   // location → device → action
  };

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ── Speak a text out loud (short responses only) ──────────
  function voiceSpeak(text, onDone) {
    if (!text) { if (onDone) onDone(); return; }
    window.speechSynthesis.cancel();

    // Strip HTML tags for TTS
    const clean = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    // Keep it short: max 180 chars
    const short = clean.length > 180 ? clean.slice(0, 177) + '...' : clean;

    const utter = new SpeechSynthesisUtterance(short);
    utter.lang  = 'en-IN';
    utter.rate  = 0.95;
    utter.pitch = 1;

    setMicState('speaking');
    setVoiceStatus('Speaking...');

    utter.onend = () => {
      setMicState('idle');
      if (onDone) onDone();
    };
    utter.onerror = () => {
      setMicState('idle');
      if (onDone) onDone();
    };

    window.speechSynthesis.speak(utter);
  }

  // ── Add message to voice transcript ──────────────────────
  function voiceAddBot(text, btns) {
    const area = document.getElementById('rh-voice-transcript');
    const div  = document.createElement('div');
    div.className = 'rh-voice-bot-text';
    div.innerHTML = text.replace(/<[^>]+>/g, '').replace(/\n/g, '<br>');
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;

    // Update backup buttons
    const btnArea = document.getElementById('rh-voice-btns');
    btnArea.innerHTML = '';
    if (btns && btns.length) {
      btns.forEach(b => {
        const btn = document.createElement('button');
        btn.className   = `rh-btn ${b.cls || ''}`;
        btn.textContent = b.label;
        btn.onclick     = () => {
          voiceStopListening();
          b.fn();
        };
        btnArea.appendChild(btn);
      });
    }

    document.getElementById('rh-voice-sub').textContent = 'Listening...';
    setVoiceStatus('Listening...');
  }

  function voiceAddUser(text) {
    const area = document.getElementById('rh-voice-transcript');
    const div  = document.createElement('div');
    div.className   = 'rh-voice-user-text';
    div.textContent = text;
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
  }

  // ── Mic UI state ──────────────────────────────────────────
  function setMicState(state) {
    const btn = document.getElementById('rh-mic-btn');
    if (!btn) return;
    btn.classList.remove('listening', 'speaking');
    if (state === 'listening') { btn.classList.add('listening'); btn.textContent = '🔴'; }
    else if (state === 'speaking') { btn.classList.add('speaking'); btn.textContent = '🔊'; }
    else { btn.textContent = '🎙️'; }
    voiceState.listening = (state === 'listening');
  }

  function setVoiceStatus(txt) {
    const el = document.getElementById('rh-voice-status');
    if (el) el.textContent = txt;
  }

  // ── Start voice session ───────────────────────────────────
  function voiceStart() {
    voiceState.step     = 'location';
    voiceState.location = null;
    voiceState.deviceId = null;

    document.getElementById('rh-voice-transcript').innerHTML = '';
    document.getElementById('rh-voice-btns').innerHTML = '';

    const welcome = `Hi! I'm your RH-Meter Voice Assistant. Which location? Say Samudra, BNG, or R&D.`;
    voiceAddBot(welcome, [
      { label:'🏭 Samudra', cls:'loc-s', fn:()=>voiceSelectLoc('samudra') },
      { label:'🏢 BNG',     cls:'loc-b', fn:()=>voiceSelectLoc('bng') },
      { label:'🔬 R&D',     cls:'loc-r', fn:()=>voiceSelectLoc('rd') },
    ]);

    voiceSpeak(welcome, () => voiceStartListening());
  }

  // ── Stop voice session completely ─────────────────────────
  function voiceStop() {
    voiceStopListening();
    window.speechSynthesis.cancel();
    setMicState('idle');
    setVoiceStatus('Tap mic to start');
  }

  // ── Start listening ───────────────────────────────────────
  function voiceStartListening() {
    if (!SpeechRecognition) {
      voiceAddBot('Sorry, your browser does not support voice recognition. Please use Chrome.');
      return;
    }
    if (voiceState.listening) return;

    const rec = new SpeechRecognition();
    rec.lang       = 'en-IN';
    rec.continuous = false;
    rec.interimResults = false;
    voiceState.recognition = rec;

    rec.onstart = () => {
      setMicState('listening');
      setVoiceStatus('Listening...');
    };

    rec.onresult = (e) => {
      const said = e.results[0][0].transcript.trim();
      voiceAddUser(said);
      voiceHandleInput(said);
    };

    rec.onerror = (e) => {
      setMicState('idle');
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        setVoiceStatus('Mic error — tap to retry');
      } else {
        setVoiceStatus('Tap mic to speak');
      }
    };

    rec.onend = () => {
      // Only restart if we didn't handle it yet and are still in listening mode
      if (voiceState.listening) setMicState('idle');
    };

    try { rec.start(); } catch(e) {}
  }

  // ── Stop listening ────────────────────────────────────────
  function voiceStopListening() {
    voiceState.listening = false;
    if (voiceState.recognition) {
      try { voiceState.recognition.stop(); } catch(e) {}
      voiceState.recognition = null;
    }
    setMicState('idle');
  }

  // ── Handle what the user said ─────────────────────────────
  async function voiceHandleInput(said) {
    voiceStopListening();
    const tl = said.toLowerCase();

    // BYE → exit voice mode
    if (/\b(bye|goodbye|exit|close|quit|stop)\b/i.test(tl)) {
      const msg = 'Goodbye! Returning to the main menu.';
      voiceAddBot(msg);
      voiceSpeak(msg, () => {
        window.rhAI.backToSelect();
      });
      return;
    }

    // ── STEP: location ────────────────────────────────────
    if (voiceState.step === 'location') {
      if (/samudra/i.test(tl))              { voiceSelectLoc('samudra'); return; }
      if (/\bbng\b|bangalore/i.test(tl))    { voiceSelectLoc('bng');     return; }
      if (/r&d|r and d|\brd\b|research/i.test(tl)) { voiceSelectLoc('rd'); return; }
      const msg = `I didn't catch that. Please say Samudra, BNG, or R and D.`;
      voiceAddBot(msg, [
        { label:'🏭 Samudra', cls:'loc-s', fn:()=>voiceSelectLoc('samudra') },
        { label:'🏢 BNG',     cls:'loc-b', fn:()=>voiceSelectLoc('bng') },
        { label:'🔬 R&D',     cls:'loc-r', fn:()=>voiceSelectLoc('rd') },
      ]);
      voiceSpeak(msg, () => voiceStartListening());
      return;
    }

    // ── STEP: device ──────────────────────────────────────
    if (voiceState.step === 'device') {
      const ids = LOCATION_DEVICES[voiceState.location] || [];
      // Match "meter 1", "meter one", "01", device ID, or device name
      const matched = ids.find(id => {
        const nm   = deviceName(id).toLowerCase();
        const num  = id.replace(/\D/g,'');             // e.g. "01" from "Meter_01"
        const numW = numberToWords(parseInt(num, 10)); // "one", "two", etc.
        return tl.includes(id.toLowerCase()) ||
               tl.includes(nm) ||
               tl.includes('meter ' + parseInt(num,10)) ||
               tl.includes('meter ' + numW) ||
               tl.includes(parseInt(num,10).toString());
      });
      if (matched) { voiceSelectDevice(matched); return; }

      const locLabel = { samudra:'Samudra', bng:'BNG', rd:'R and D' }[voiceState.location];
      const devList  = ids.map(id => deviceName(id)).join(', ');
      const msg = `I didn't catch the device. Available devices in ${locLabel}: ${devList}. Please say the device name.`;
      voiceAddBot(msg, ids.map(id => ({
        label: `${id} — ${deviceName(id)}`, cls:'dev', fn:()=>voiceSelectDevice(id)
      })));
      voiceSpeak(msg, () => voiceStartListening());
      return;
    }

    // ── STEP: action ──────────────────────────────────────
    if (voiceState.step === 'action') {
      const id = voiceState.deviceId;

      if (/live|current|now|real.?time|latest/i.test(tl)) { voiceFetchLive(id);    return; }
      if (/today|daily|this day/i.test(tl))                { voiceFetchToday(id);   return; }
      if (/breach|alert|exceed|threshold/i.test(tl))       { voiceFetchBreaches(id,'today'); return; }
      if (/different|change|another|back/i.test(tl))       { voiceGoBack();         return; }

      // Date mentioned
      const parsed = parseDatePhrase(tl);
      if (parsed) { voiceFetchRange(id, parsed.from, parsed.to); return; }

      const nm  = deviceName(id);
      const msg = `What would you like for ${nm}? Say live reading, today's stats, date range, or threshold breaches.`;
      voiceAddBot(msg, [
        { label:'⚡ Live',      cls:'dev',    fn:()=>voiceFetchLive(id) },
        { label:"📊 Today",    cls:'dev',    fn:()=>voiceFetchToday(id) },
        { label:'⚠️ Breaches', cls:'danger', fn:()=>voiceFetchBreaches(id,'today') },
        { label:'🔄 Back',     cls:'',       fn:()=>voiceGoBack() },
      ]);
      voiceSpeak(msg, () => voiceStartListening());
      return;
    }
  }

  // ── Voice: select location ────────────────────────────────
  function voiceSelectLoc(loc) {
    voiceState.location = loc;
    voiceState.step     = 'device';
    const label  = { samudra:'Samudra', bng:'BNG', rd:'R and D' }[loc];
    const ids    = LOCATION_DEVICES[loc] || [];
    const names  = ids.map(id => deviceName(id)).join(', ');
    const msg    = `${label} selected. Available devices: ${names}. Which device?`;
    voiceAddBot(msg, ids.map(id => ({
      label: `${id} — ${deviceName(id)}`, cls:'dev', fn:()=>voiceSelectDevice(id)
    })));
    voiceSpeak(msg, () => voiceStartListening());
  }

  // ── Voice: select device ──────────────────────────────────
  function voiceSelectDevice(id) {
    voiceState.deviceId = id;
    voiceState.step     = 'action';
    const nm  = deviceName(id);
    const msg = `${nm} selected. Say live reading, today's stats, date range, or threshold breaches.`;
    voiceAddBot(msg, [
      { label:'⚡ Live reading',  cls:'dev',    fn:()=>voiceFetchLive(id) },
      { label:"📊 Today's stats", cls:'dev',    fn:()=>voiceFetchToday(id) },
      { label:'📅 Date range',    cls:'date',   fn:()=>voiceAskDate(id) },
      { label:'⚠️ Breaches',     cls:'danger', fn:()=>voiceFetchBreaches(id,'today') },
      { label:'🔄 Different device', cls:'',   fn:()=>voiceGoBack() },
    ]);
    voiceSpeak(msg, () => voiceStartListening());
  }

  // ── Voice: go back to location step ──────────────────────
  function voiceGoBack() {
    voiceState.step     = 'location';
    voiceState.deviceId = null;
    const msg = 'Going back. Which location? Say Samudra, BNG, or R and D.';
    voiceAddBot(msg, [
      { label:'🏭 Samudra', cls:'loc-s', fn:()=>voiceSelectLoc('samudra') },
      { label:'🏢 BNG',     cls:'loc-b', fn:()=>voiceSelectLoc('bng') },
      { label:'🔬 R&D',     cls:'loc-r', fn:()=>voiceSelectLoc('rd') },
    ]);
    voiceSpeak(msg, () => voiceStartListening());
  }

  // ── Voice: fetch live ─────────────────────────────────────
  async function voiceFetchLive(id) {
    const SV = getServerUrl();
    const th = getThresholds();
    const nm = deviceName(id);
    voiceAddBot(`Fetching live reading for ${nm}...`);
    setVoiceStatus('Fetching data...');
    try {
      const res  = await fetch(`${SV}/api/data?deviceId=${id}&_t=${Date.now()}`);
      const data = await res.json();
      const temp = data.temperature ?? data.temp;
      const hum  = data.humidity    ?? data.hum;
      if (temp == null) {
        const msg = `${nm} appears to be offline. No live data available.`;
        voiceAddBot(msg);
        voiceSpeak(msg, () => voiceStartListening());
        return;
      }
      const tA  = temp > th.temp;
      const hA  = hum  > th.hum;
      const sum = await gemini(`Device: ${nm}. Live: Temp=${temp}°C (threshold ${th.temp}°C), Hum=${hum}% (threshold ${th.hum}%). ${tA?'Temp ABOVE threshold!':''} ${hA?'Hum ABOVE threshold!':''} 1-sentence status.`);
      const msg = `Live reading for ${nm}: Temperature ${parseFloat(temp).toFixed(1)} degrees, Humidity ${parseFloat(hum).toFixed(1)} percent. ${sum}`;
      voiceAddBot(msg, [
        { label:'📊 Today',     cls:'dev',    fn:()=>voiceFetchToday(id) },
        { label:'⚠️ Breaches', cls:'danger', fn:()=>voiceFetchBreaches(id,'today') },
        { label:'🔄 Back',     cls:'',       fn:()=>voiceGoBack() },
      ]);
      voiceSpeak(msg, () => voiceStartListening());
    } catch {
      const msg = `Sorry, failed to fetch live data for ${nm}.`;
      voiceAddBot(msg);
      voiceSpeak(msg, () => voiceStartListening());
    }
  }

  // ── Voice: fetch today ────────────────────────────────────
  async function voiceFetchToday(id) {
    const today = isoDate(new Date());
    voiceFetchRange(id, today, today, true);
  }

  // ── Voice: ask for date (fallback to buttons) ─────────────
  function voiceAskDate(id) {
    const today = isoDate(new Date());
    const yest  = isoDate(new Date(Date.now()-86400000));
    const w7    = isoDate(new Date(Date.now()-6*86400000));
    const d30   = isoDate(new Date(Date.now()-29*86400000));
    const msg   = `Which date range? Say today, yesterday, last 7 days, or last 30 days.`;
    voiceAddBot(msg, [
      { label:'📅 Today',        cls:'date', fn:()=>voiceFetchRange(id,today,today,true) },
      { label:'📅 Yesterday',    cls:'date', fn:()=>voiceFetchRange(id,yest,yest) },
      { label:'📅 Last 7 days',  cls:'date', fn:()=>voiceFetchRange(id,w7,today) },
      { label:'📅 Last 30 days', cls:'date', fn:()=>voiceFetchRange(id,d30,today) },
    ]);
    voiceSpeak(msg, () => voiceStartListening());
  }

  // ── Voice: fetch date range ───────────────────────────────
  async function voiceFetchRange(id, from, to, isToday) {
    const SV = getServerUrl();
    const th = getThresholds();
    const nm = deviceName(id);
    const label = isToday ? "today" : (from === to ? from : `${from} to ${to}`);
    voiceAddBot(`Fetching data for ${nm}, ${label}...`);
    setVoiceStatus('Fetching data...');
    try {
      const res     = await fetch(`${SV}/api/history?deviceId=${id}&from=${from}&to=${to}&_t=${Date.now()}`);
      const records = await res.json();
      if (!records.length) {
        const msg = `No data found for ${nm} on ${label}.`;
        voiceAddBot(msg);
        voiceSpeak(msg, () => voiceStartListening());
        return;
      }
      const avg  = arr => (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1);
      const temps = records.map(r => r.temperature ?? r.temp).filter(v => v!=null);
      const hums  = records.map(r => r.humidity    ?? r.hum ).filter(v => v!=null);
      const avgT  = avg(temps), maxT = Math.max(...temps).toFixed(1);
      const avgH  = avg(hums),  maxH = Math.max(...hums).toFixed(1);
      const tB    = temps.filter(v => v > th.temp).length;
      const hB    = hums.filter(v  => v > th.hum ).length;
      const sum   = await gemini(`Device: ${nm}. ${label} stats (${records.length} readings): Temp avg=${avgT} max=${maxT}°C. Hum avg=${avgH} max=${maxH}%. ${tB} temp breaches, ${hB} hum breaches. 1-sentence summary.`);
      const msg   = `${nm} — ${label}: Average temperature ${avgT} degrees, max ${maxT}. Average humidity ${avgH} percent, max ${maxH}. ${tB} temperature breaches, ${hB} humidity breaches. ${sum}`;
      voiceAddBot(msg, [
        { label:'⚡ Live now',  cls:'dev',    fn:()=>voiceFetchLive(id) },
        { label:'⚠️ Breaches', cls:'danger', fn:()=>voiceFetchBreaches(id, from === to ? 'today' : from) },
        { label:'🔄 Back',     cls:'',       fn:()=>voiceGoBack() },
      ]);
      voiceSpeak(msg, () => voiceStartListening());
    } catch {
      const msg = `Sorry, failed to fetch data for ${nm}.`;
      voiceAddBot(msg);
      voiceSpeak(msg, () => voiceStartListening());
    }
  }

  // ── Voice: fetch breaches ─────────────────────────────────
  async function voiceFetchBreaches(id, period) {
    const today = isoDate(new Date());
    const from  = period === 'today' ? today : isoDate(new Date(Date.now()-6*86400000));
    const to    = today;
    const SV    = getServerUrl();
    const th    = getThresholds();
    const nm    = deviceName(id);
    voiceAddBot(`Checking threshold breaches for ${nm}...`);
    setVoiceStatus('Fetching data...');
    try {
      const res     = await fetch(`${SV}/api/history?deviceId=${id}&from=${from}&to=${to}&_t=${Date.now()}`);
      const records = await res.json();
      if (!records.length) {
        const msg = `No data found for ${nm} in this period.`;
        voiceAddBot(msg);
        voiceSpeak(msg, () => voiceStartListening());
        return;
      }
      const breaches = records.filter(r =>
        (r.temperature ?? r.temp) > th.temp || (r.humidity ?? r.hum) > th.hum
      );
      let msg;
      if (!breaches.length) {
        msg = `Great news! No threshold breaches for ${nm}. All readings were within safe limits.`;
      } else {
        const rate = ((breaches.length/records.length)*100).toFixed(1);
        msg = `${nm} had ${breaches.length} breaches out of ${records.length} readings. Breach rate: ${rate} percent.`;
      }
      voiceAddBot(msg, [
        { label:'⚡ Live now',   cls:'dev',  fn:()=>voiceFetchLive(id) },
        { label:"📊 Today",     cls:'dev',  fn:()=>voiceFetchToday(id) },
        { label:'🔄 Back',      cls:'',     fn:()=>voiceGoBack() },
      ]);
      voiceSpeak(msg, () => voiceStartListening());
    } catch {
      const msg = `Sorry, failed to fetch breach data for ${nm}.`;
      voiceAddBot(msg);
      voiceSpeak(msg, () => voiceStartListening());
    }
  }

  // ── Helper: number to words (1→"one" etc.) ────────────────
  function numberToWords(n) {
    const w = ['zero','one','two','three','four','five','six','seven','eight','nine',
               'ten','eleven','twelve','thirteen'];
    return w[n] || String(n);
  }

})();