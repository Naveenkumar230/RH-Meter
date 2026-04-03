// ============================================================
//  Factory Monitor Pro — app.js  v3.0
//  Multi-device | DEVICE_NAME_MAP | Dynamic URL params
// ============================================================
const SERVER_URL = 'https://rh-meter-production.up.railway.app';
// const SERVER_URL = 'http://localhost:3000';

// ════════════════════════════════════════════════════════════
//  DEVICE NAME MAP
//  Keys   → technical IDs (never change, match MQTT/MongoDB)
//  Values → friendly factory names (editable via Settings UI)
//
//  TO RENAME A DEVICE IN THE FUTURE:
//  → Open Settings panel (⚙️ icon on home.html)
//  → Find the device row and edit the name
//  → Click "Save Names" — saved to localStorage automatically
// ════════════════════════════════════════════════════════════
const DEFAULT_DEVICE_NAME_MAP = {
  "Meter_01": "Production Floor - A",
  "Meter_02": "CT-PAT Area",
  "Meter_03": "Quality Control Lab",
  "Meter_04": "Warehouse - North",
  "Meter_05": "Warehouse - South",
  "Meter_06": "Packaging Unit - 1",
  "Meter_07": "Packaging Unit - 2",
  "Meter_08": "Cold Storage - A",
  "Meter_09": "Cold Storage - B",
  "Meter_10": "Server Room",
  "Meter_11": "Assembly Line - 1",
  "Meter_12": "Assembly Line - 2",
  "Meter_13": "Dispatch Area"
};

// ── Load names from MongoDB (globally shared across all users) ──
async function loadDeviceNameMap() {
  try {
    const res = await fetch(`${SERVER_URL}/api/device-names`);
    if (!res.ok) throw new Error('Not OK');
    const data = await res.json();
    if (data.names && typeof data.names === 'object') {
      // Merge: server names override defaults, defaults fill missing keys
      DEVICE_NAME_MAP = Object.assign({}, DEFAULT_DEVICE_NAME_MAP, data.names);
      console.log('[Names] Loaded from MongoDB ✅');
      return;
    }
  } catch (e) {
    console.warn('[Names] Failed to load from server, using defaults:', e.message);
  }
  DEVICE_NAME_MAP = { ...DEFAULT_DEVICE_NAME_MAP };
}

async function saveDeviceNameMap(map) {
  try {
    const res = await fetch(`${SERVER_URL}/api/device-names`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: map })
    });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    console.log('[Names] Saved to MongoDB ✅');
  } catch (e) {
    console.error('[Names] Failed to save:', e.message);
    throw e;
  }
}

let DEVICE_RECIPIENTS_MAP = {}; // { "Meter_01": "a@b.com,c@d.com", ... }

async function loadDeviceRecipients() {
  try {
    const res = await fetch(`${SERVER_URL}/api/device-recipients`);
    if (!res.ok) throw new Error('Not OK');
    const data = await res.json();
    if (data.recipients && typeof data.recipients === 'object') {
      DEVICE_RECIPIENTS_MAP = data.recipients;
    }
  } catch(e) {
    console.warn('[DeviceRecipients] Failed to load:', e.message);
    DEVICE_RECIPIENTS_MAP = {};
  }
}

async function saveDeviceRecipients(map) {
  try {
    const res = await fetch(`${SERVER_URL}/api/device-recipients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: map })
    });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    console.log('[DeviceRecipients] Saved ✅');
  } catch(e) {
    console.error('[DeviceRecipients] Failed to save:', e.message);
    throw e;
  }
}

// Live map — starts with defaults, gets overwritten from MongoDB on init
let DEVICE_NAME_MAP = { ...DEFAULT_DEVICE_NAME_MAP };

// Helper: get friendly name for a deviceId
function getFriendlyName(deviceId) {
  return DEVICE_NAME_MAP[deviceId] || deviceId;
}

// ════════════════════════════════════════════════════════════
//  CURRENT DEVICE (index.html — detail page)
//  Read from URL param: ?id=Meter_02
// ════════════════════════════════════════════════════════════
function getCurrentDeviceId() {
  const params = new URLSearchParams(window.location.search);
  return params.get('id') || 'Meter_02';
}

// ════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════
let allData         = [];
let chartTempToday  = null;
let chartHumToday   = null;
let chartTempDetail = null;
let chartHumDetail  = null;
let failCount       = 0;
let lastTemp        = null;
let lastHum         = null;

// ── Thresholds ────────────────────────────────────────────────
let thresholds = { temp: 35, hum: 70, recipients: '' };

// ════════════════════════════════════════════════════════════
//  UTILITY
// ════════════════════════════════════════════════════════════
function pad(n)     { return n < 10 ? '0' + n : '' + n; }
function dateStr(d) { return d.toISOString().slice(0, 10); }

function filterDate(ds)       { return allData.filter(r => dateStr(new Date(r.timestamp)) === ds); }
function filterRange(from,to) { return allData.filter(r => { const d = dateStr(new Date(r.timestamp)); return d >= from && d <= to; }); }

function toIST(d) {
  const ist = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
  return pad(ist.getUTCHours()) + ':' + pad(ist.getUTCMinutes());
}

function bucket30min(arr) {
  const map = {};
  arr.forEach(r => {
    const d   = new Date(r.timestamp);
    const ist = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
    const m   = ist.getUTCMinutes() < 30 ? '00' : '30';
    const key = dateStr(d) + ' ' + pad(ist.getUTCHours()) + ':' + m;
    if (!map[key]) map[key] = { temps:[], hums:[], key };
    map[key].temps.push(r.temp);
    map[key].hums.push(r.hum);
  });
  return Object.keys(map).sort().map(k => {
    const b = map[k];
    return {
      label: b.key.split(' ')[1],
      temp:  +(b.temps.reduce((a,v)=>a+v,0)/b.temps.length).toFixed(1),
      hum:   +(b.hums.reduce((a,v)=>a+v,0)/b.hums.length).toFixed(1)
    };
  });
}

function bucket5min(arr) {
  const map = {};
  arr.forEach(r => {
    const d   = new Date(r.timestamp);
    const ist = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
    const m   = pad(Math.floor(ist.getUTCMinutes() / 5) * 5);
    const key = dateStr(d) + ' ' + pad(ist.getUTCHours()) + ':' + m;
    if (!map[key]) map[key] = { temps:[], hums:[], key };
    map[key].temps.push(r.temp);
    map[key].hums.push(r.hum);
  });
  return Object.keys(map).sort().map(k => {
    const b = map[k];
    return {
      label: b.key.split(' ')[1],
      temp:  +(b.temps.reduce((a,v)=>a+v,0)/b.temps.length).toFixed(1),
      hum:   +(b.hums.reduce((a,v)=>a+v,0)/b.hums.length).toFixed(1)
    };
  });
}

function bucketHourly(arr) {
  const map = {};
  arr.forEach(r => {
    const d   = new Date(r.timestamp);
    const ist = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
    const key = dateStr(d) + ' ' + pad(ist.getUTCHours()) + ':00';
    if (!map[key]) map[key] = { temps:[], hums:[], key };
    map[key].temps.push(r.temp);
    map[key].hums.push(r.hum);
  });
  return Object.keys(map).sort().map(k => {
    const b = map[k];
    return {
      timestamp: k,
      temp: +(b.temps.reduce((a,v)=>a+v,0)/b.temps.length).toFixed(1),
      hum:  +(b.hums.reduce((a,v)=>a+v,0)/b.hums.length).toFixed(1)
    };
  });
}

function groupByDay(arr) {
  const map = {};
  arr.forEach(r => {
    const ds = dateStr(new Date(r.timestamp));
    if (!map[ds]) map[ds] = { temps:[], hums:[] };
    map[ds].temps.push(r.temp); map[ds].hums.push(r.hum);
  });
  return Object.keys(map).sort().map(ds => {
    const g = map[ds];
    return { date: ds,
      tempAvg: +(g.temps.reduce((a,v)=>a+v,0)/g.temps.length).toFixed(1),
      tempMin: +Math.min(...g.temps).toFixed(1), tempMax: +Math.max(...g.temps).toFixed(1),
      humAvg:  +(g.hums.reduce((a,v)=>a+v,0)/g.hums.length).toFixed(1),
      humMin:  +Math.min(...g.hums).toFixed(1),  humMax:  +Math.max(...g.hums).toFixed(1) };
  });
}

function stats(arr, key) {
  if (!arr.length) return { min:'--', max:'--', avg:'--' };
  const v = arr.map(r => r[key]);
  return { min: Math.min(...v).toFixed(1), max: Math.max(...v).toFixed(1), avg: (v.reduce((a,b)=>a+b,0)/v.length).toFixed(1) };
}

function getTempLevel(t) { return t <= 27 ? 'normal' : (t <= 35 ? 'warning' : 'critical'); }
function getHumLevel(h)  { return h < 40  ? 'critical' : (h <= 70 ? 'normal'  : 'warning'); }

// ════════════════════════════════════════════════════════════
//  STATUS BADGE  (detail page)
// ════════════════════════════════════════════════════════════
function updateStatusBadge(isOnline) {
  const badge = document.getElementById('statusBadge');
  const text  = document.getElementById('statusText');
  if (!badge || !text) return;
  badge.classList.toggle('offline', !isOnline);
  text.textContent = isOnline ? 'Online' : 'Offline';
}

// ════════════════════════════════════════════════════════════
//  FETCH CURRENT READING  (detail page — uses URL device ID)
// ════════════════════════════════════════════════════════════
async function fetchCurrent() {
  try {
    const deviceId = getCurrentDeviceId();
    const res = await fetch(`${SERVER_URL}/api/data?deviceId=${deviceId}&_t=${Date.now()}`);
    if (!res.ok) throw new Error('Server returned ' + res.status);
    const d = await res.json();

    const t = d.temperature !== undefined ? parseFloat(d.temperature) : (d.temp !== undefined ? parseFloat(d.temp) : null);
    const h = d.humidity    !== undefined ? parseFloat(d.humidity)    : (d.hum  !== undefined ? parseFloat(d.hum)  : null);

    if (t === null || h === null) { updateStatusBadge(false); return; }

    failCount = 0;
    updateStatusBadge(true);

    document.getElementById('tempValue').textContent = t.toFixed(1);
    document.getElementById('humValue').textContent  = h.toFixed(1);

    if (lastTemp !== null) {
      const diff = t - lastTemp;
      document.getElementById('tempTrend').textContent = diff > 0.1 ? '↑' : diff < -0.1 ? '↓' : '→';
    }
    lastTemp = t;
    lastHum  = h;
  } catch (err) {
    failCount++;
    if (failCount >= 3) updateStatusBadge(false);
    console.warn('[fetchCurrent] Error:', err.message);
  }
}

async function fetchRangeData(from, to) {
  try {
    const deviceId = getCurrentDeviceId();
    const res = await fetch(
      `${SERVER_URL}/api/history?deviceId=${deviceId}&from=${from}&to=${to}&_t=${Date.now()}`
    );
    if (!res.ok) throw new Error('Range fetch failed: ' + res.status);
    const records = await res.json();
    return records.map(r => ({
      timestamp: r.timestamp,
      temp: r.temperature !== undefined ? r.temperature : r.temp,
      hum:  r.humidity    !== undefined ? r.humidity    : r.hum
    })).filter(r => r.temp != null && r.hum != null);
  } catch (e) {
    console.error('fetchRangeData failed:', e.message);
    return [];
  }
}

// ════════════════════════════════════════════════════════════
//  FETCH HISTORY  (detail page)
// ════════════════════════════════════════════════════════════
async function fetchAllData() {
  try {
    const deviceId = getCurrentDeviceId();

    // IST midnight = previous UTC day at 18:30:00
    // So fetch from yesterday to today (UTC) to cover full IST day
    const now     = new Date();
    const todayUTC = now.toISOString().slice(0, 10);

    // Yesterday's date string
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayUTC = yesterday.toISOString().slice(0, 10);

    const res = await fetch(
      `${SERVER_URL}/api/history?deviceId=${deviceId}&from=${yesterdayUTC}&to=${todayUTC}&_t=${Date.now()}`
    );
    if (!res.ok) throw new Error('History fetch failed: ' + res.status);
    const records = await res.json();

    const allFetched = records.map(r => ({
      timestamp: r.timestamp,
      temp: r.temperature !== undefined ? r.temperature : r.temp,
      hum:  r.humidity    !== undefined ? r.humidity    : r.hum
    })).filter(r => r.temp != null && r.hum != null);

    // ── Filter to only today's IST day (00:00 IST to now) ──
    const istMidnightToday = new Date();
    istMidnightToday.setUTCHours(0, 0, 0, 0);
    // IST midnight = 18:30 UTC previous day
    const istMidnightUTC = new Date(istMidnightToday.getTime() - (5.5 * 60 * 60 * 1000));

    allData = allFetched.filter(r => new Date(r.timestamp) >= istMidnightUTC);
    allData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const countEl = document.getElementById('dataCount');
    if (countEl) countEl.textContent = allData.length;

    renderTodayCharts();
    updateStats();
  } catch (e) {
    console.error('fetchAllData failed:', e.message);
  }
}

// ════════════════════════════════════════════════════════════
//  SETTINGS — LOAD & SAVE
// ════════════════════════════════════════════════════════════
async function loadSettings() {
  try {
    const res  = await fetch(`${SERVER_URL}/api/settings`);
    if (!res.ok) throw new Error('Not OK');
    const data = await res.json();
    thresholds.temp       = data.tempThreshold ?? 35;
    thresholds.hum        = data.humThreshold  ?? 70;
    thresholds.recipients = data.recipients    ?? '';
    syncThresholdUI();
  } catch (e) {
    console.warn('Settings load failed, using defaults:', e.message);
    syncThresholdUI();
  }
}

function syncThresholdUI() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('thresholdTempInput', thresholds.temp);
  set('thresholdHumInput',  thresholds.hum);

  const tb = document.getElementById('tempThresholdBadge');
  const hb = document.getElementById('humThresholdBadge');
  if (tb) tb.textContent = thresholds.temp + ' °C';
  if (hb) hb.textContent = thresholds.hum  + ' %';

  initRecipientChips();
  initCharts();
  renderTodayCharts();
}

async function saveThresholdSettings() {
  const tv = parseFloat(document.getElementById('thresholdTempInput')?.value);
  const hv = parseFloat(document.getElementById('thresholdHumInput')?.value);
  if (isNaN(tv)) return showToast('Enter a valid temperature threshold', 'error');
  if (isNaN(hv)) return showToast('Enter a valid humidity threshold', 'error');

  const chips = document.querySelectorAll('.recipient-chip');
  const recipientList = Array.from(chips).map(c => c.dataset.email).filter(Boolean).join(',');
  if (!recipientList) return showToast('Add at least one recipient email', 'error');

  try {
    const res = await fetch(`${SERVER_URL}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempThreshold: tv, humThreshold: hv, recipients: recipientList })
    });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    const json = await res.json();

    thresholds.temp       = json.settings?.tempThreshold ?? tv;
    thresholds.hum        = json.settings?.humThreshold  ?? hv;
    thresholds.recipients = recipientList;

    syncThresholdUI();
    renderTodayCharts();
    if (chartTempDetail) renderTempDetail();
    if (chartHumDetail)  renderHumDetail();

    showToast('✅ Settings saved! Threshold lines updated.', 'success');
  } catch (e) {
    showToast('❌ Failed to save: ' + e.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════
//  TEST EMAIL
// ════════════════════════════════════════════════════════════
async function sendTestEmail() {
  const chips = document.querySelectorAll('.recipient-chip');
  const recipientList = Array.from(chips).map(c => c.dataset.email).filter(Boolean).join(',');
  if (!recipientList) return showToast('Add at least one recipient email first', 'error');

  document.querySelectorAll('.btn-test-email').forEach(b => { b.disabled = true; b.textContent = '📨 Sending...'; });

  try {
    await fetch(`${SERVER_URL}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: recipientList })
    });
    const res  = await fetch(`${SERVER_URL}/api/test-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: recipientList })
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) showToast('✅ Test email sent! Check your inbox.', 'success');
    else showToast('❌ Email failed: ' + (json.error || `Status ${res.status}`), 'error');
  } catch (e) {
    showToast('❌ Could not reach server: ' + e.message, 'error');
  } finally {
    document.querySelectorAll('.btn-test-email').forEach(b => { b.disabled = false; b.textContent = '📨 Send Test Email'; });
  }
}

// ════════════════════════════════════════════════════════════
//  CHIP UI
// ════════════════════════════════════════════════════════════
function initRecipientChips() {
  const container = document.getElementById('recipientChipsContainer');
  if (!container) return;
  container.innerHTML = '';
  if (thresholds.recipients) {
    thresholds.recipients.split(',').map(e => e.trim()).filter(Boolean).forEach(addChipToDOM);
  }
}

function addChipToDOM(email) {
  const container = document.getElementById('recipientChipsContainer');
  if (!container) return;
  const chip = document.createElement('div');
  chip.className     = 'recipient-chip';
  chip.dataset.email = email;
  chip.innerHTML = `<span class="chip-email">✉️ ${email}</span><button class="chip-remove" onclick="removeChip(this)">✕ Delete</button>`;
  container.appendChild(chip);
}

function addChip() {
  const input = document.getElementById('recipientEmailInput');
  if (!input) return;
  const email = input.value.trim().toLowerCase();
  if (!email) return showToast('Please enter an email first', 'error');
  if (!email.includes('@') || !email.includes('.')) return showToast('Enter a valid email address', 'error');
  const existing = Array.from(document.querySelectorAll('.recipient-chip')).map(c => c.dataset.email);
  if (existing.includes(email)) return showToast('This email is already added', 'error');
  addChipToDOM(email);
  input.value = '';
  input.focus();
}

function removeChip(btn) { btn.closest('.recipient-chip').remove(); }
function handleRecipientKeydown(e) { if (e.key === 'Enter') { e.preventDefault(); addChip(); } }

// ════════════════════════════════════════════════════════════
//  TOAST
// ════════════════════════════════════════════════════════════
function showToast(msg, type = 'success') {
  const old = document.getElementById('toastNotif');
  if (old) old.remove();
  const t = document.createElement('div');
  t.id = 'toastNotif';
  Object.assign(t.style, {
    position:'fixed', bottom:'28px', right:'28px', zIndex:'9999',
    padding:'14px 22px', borderRadius:'12px', fontSize:'0.875rem', fontWeight:'600',
    boxShadow:'0 8px 32px rgba(0,0,0,0.15)', transition:'opacity 0.4s ease',
    background: type === 'success' ? '#f0fdf4' : '#fff5f5',
    color:       type === 'success' ? '#16a34a' : '#dc2626',
    border:      '1px solid ' + (type === 'success' ? '#bbf7d0' : '#fca5a5'),
  });
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 3500);
}

// ════════════════════════════════════════════════════════════
//  STATS  (detail page)
// ════════════════════════════════════════════════════════════
function updateStats() {
  const today     = filterDate(dateStr(new Date()));
  const tempStats = stats(today, 'temp');
  const humStats  = stats(today, 'hum');
  document.getElementById('statMinTemp').textContent = tempStats.min;
  document.getElementById('statMaxTemp').textContent = tempStats.max;
  document.getElementById('statAvgTemp').textContent = tempStats.avg;
  document.getElementById('statMinHum').textContent  = humStats.min;
  document.getElementById('statMaxHum').textContent  = humStats.max;
  document.getElementById('statAvgHum').textContent  = humStats.avg;
}

// ════════════════════════════════════════════════════════════
//  THRESHOLD LINE PLUGIN
// ════════════════════════════════════════════════════════════
function makeThresholdPlugin(getVal, color, label) {
  return {
    id: 'thresholdLine_' + label,
    afterDraw(chart) {
      const value = getVal();
      if (value == null || isNaN(value)) return;
      const { ctx, chartArea, scales } = chart;
      if (!scales.y || !chartArea) return;
      const y = scales.y.getPixelForValue(value);
      if (y < chartArea.top || y > chartArea.bottom) return;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      ctx.setLineDash([8, 5]);
      ctx.stroke();
      ctx.setLineDash([]);

      const text    = `${label}: ${value}`;
      ctx.font      = 'bold 11px Inter, sans-serif';
      const tw      = ctx.measureText(text).width;
      const px      = chartArea.right - tw - 20;
      const py      = y - 20;
      const pw      = tw + 16;
      const ph      = 18;
      const pr      = 4;

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(px + pr, py);
      ctx.lineTo(px + pw - pr, py);
      ctx.quadraticCurveTo(px + pw, py, px + pw, py + pr);
      ctx.lineTo(px + pw, py + ph - pr);
      ctx.quadraticCurveTo(px + pw, py + ph, px + pw - pr, py + ph);
      ctx.lineTo(px + pr, py + ph);
      ctx.quadraticCurveTo(px, py + ph, px, py + ph - pr);
      ctx.lineTo(px, py + pr);
      ctx.quadraticCurveTo(px, py, px + pr, py);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle    = '#ffffff';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, px + 8, py + ph / 2);
      ctx.restore();
    }
  };
}

const tempThresholdPlugin = makeThresholdPlugin(() => thresholds.temp, '#ef4444', 'Temp Alert');
const humThresholdPlugin  = makeThresholdPlugin(() => thresholds.hum,  '#f59e0b', 'Hum Alert');

// ════════════════════════════════════════════════════════════
//  CHART OPTIONS
// ════════════════════════════════════════════════════════════
function getChartOptions(thresholdVal, isTemp) {
  const yAxis = isTemp
    ? { min: 15, max: 40, grid: { color: '#e2e8f0' }, ticks: { color: '#64748b' }, beginAtZero: false }
    : { suggestedMax: thresholdVal + 10, grid: { color: '#e2e8f0' }, ticks: { color: '#64748b' }, beginAtZero: false };
  return {
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 400 },
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: '#e2e8f0' }, ticks: { color: '#64748b', maxRotation: 0 } },
      y: yAxis
    }
  };
}

// ════════════════════════════════════════════════════════════
//  INIT CHARTS
// ════════════════════════════════════════════════════════════
function initCharts() {
  if (chartTempToday)  { chartTempToday.destroy();  chartTempToday  = null; }
  if (chartHumToday)   { chartHumToday.destroy();   chartHumToday   = null; }
  if (chartTempDetail) { chartTempDetail.destroy();  chartTempDetail = null; }
  if (chartHumDetail)  { chartHumDetail.destroy();   chartHumDetail  = null; }

  const tempCanvas = document.getElementById('chartTempToday');
  const humCanvas  = document.getElementById('chartHumToday');
  if (!tempCanvas || !humCanvas) return;

  chartTempToday = new Chart(tempCanvas.getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }] },
    plugins: [tempThresholdPlugin],
    options: getChartOptions(thresholds.temp, true)
  });

  chartHumToday = new Chart(humCanvas.getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,0.1)', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }] },
    plugins: [humThresholdPlugin],
    options: getChartOptions(thresholds.hum, false)
  });
}

// ════════════════════════════════════════════════════════════
//  RENDER TODAY CHARTS
// ════════════════════════════════════════════════════════════
function renderTodayCharts() {
  if (!chartTempToday || !chartHumToday) return;

  // Build full 24-hour skeleton: 00:00, 00:30, 01:00 ... 23:30
  const allSlots = [];
  for (let h = 0; h < 24; h++) {
    allSlots.push(pad(h) + ':00');
    allSlots.push(pad(h) + ':30');
  }

  // Bucket today's data into 30-min IST slots
  const todayData = filterDate(dateStr(new Date()));
  const bucketMap = {};
  todayData.forEach(r => {
    const ist = new Date(new Date(r.timestamp).getTime() + 5.5 * 60 * 60 * 1000);
    const m   = ist.getUTCMinutes() < 30 ? '00' : '30';
    const key = pad(ist.getUTCHours()) + ':' + m;
    if (!bucketMap[key]) bucketMap[key] = { temps: [], hums: [] };
    bucketMap[key].temps.push(r.temp);
    bucketMap[key].hums.push(r.hum);
  });

  const tempData = allSlots.map(slot =>
    bucketMap[slot] ? +(bucketMap[slot].temps.reduce((a,v)=>a+v,0)/bucketMap[slot].temps.length).toFixed(1) : null
  );
  const humData = allSlots.map(slot =>
    bucketMap[slot] ? +(bucketMap[slot].hums.reduce((a,v)=>a+v,0)/bucketMap[slot].hums.length).toFixed(1) : null
  );

  chartTempToday.data.labels           = allSlots;
  chartTempToday.data.datasets[0].data = tempData;
  chartTempToday.data.datasets[0].spanGaps = false;
  chartTempToday.update();

  chartHumToday.data.labels            = allSlots;
  chartHumToday.data.datasets[0].data  = humData;
  chartHumToday.data.datasets[0].spanGaps = false;
  chartHumToday.update();
}

// ════════════════════════════════════════════════════════════
//  NAVIGATION  (detail page)
// ════════════════════════════════════════════════════════════
function showDetailPage(type) {
  document.getElementById('dashboardView').style.display = 'none';
  const today = dateStr(new Date());
  if (type === 'temperature') {
    document.getElementById('temperatureDetail').classList.add('active');
    document.getElementById('tempDateFrom').value = today;
    document.getElementById('tempDateTo').value   = today;
    renderTempDetail();
  } else {
    document.getElementById('humidityDetail').classList.add('active');
    document.getElementById('humDateFrom').value = today;
    document.getElementById('humDateTo').value   = today;
    renderHumDetail();
  }
}

function showDashboard() {
  document.getElementById('dashboardView').style.display = 'block';
  document.getElementById('temperatureDetail').classList.remove('active');
  document.getElementById('humidityDetail').classList.remove('active');
  if (chartTempDetail) { chartTempDetail.destroy(); chartTempDetail = null; }
  if (chartHumDetail)  { chartHumDetail.destroy();  chartHumDetail  = null; }
}

// ════════════════════════════════════════════════════════════
//  TEMPERATURE DETAIL
// ════════════════════════════════════════════════════════════
function setTodayTemp() {
  const today = dateStr(new Date());
  document.getElementById('tempDateFrom').value = today;
  document.getElementById('tempDateTo').value   = today;
  renderTempDetail();
}

async function renderTempDetail() {
  const from      = document.getElementById('tempDateFrom').value;
  const to        = document.getElementById('tempDateTo').value;
  const subset    = await fetchRangeData(from, to);
  const isSameDay = from === to;

  const s = stats(subset, 'temp');
  document.getElementById('tempDetailMin').textContent = s.min;
  document.getElementById('tempDetailMax').textContent = s.max;
  document.getElementById('tempDetailAvg').textContent = s.avg;

  if (chartTempDetail) chartTempDetail.destroy();
  const oldTable = document.getElementById('tempDayTable');
  if (oldTable) oldTable.remove();

  if (isSameDay) {
    document.getElementById('tempChartTitle').textContent = '📈 Temperature — Single Day';
    const bucketed = bucket5min(subset);
    chartTempDetail = new Chart(document.getElementById('chartTempDetail').getContext('2d'), {
      type: 'line',
      data: { labels: bucketed.map(b => b.label), datasets: [{ label: 'Temperature (°C)', data: bucketed.map(b => b.temp), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 2, borderWidth: 2 }] },
      plugins: [tempThresholdPlugin],
      options: { ...getChartOptions(thresholds.temp, true), plugins: { legend: { display: true, labels: { color:'#475569' } } } }
    });
  } else {
    document.getElementById('tempChartTitle').textContent = '📊 Temperature — Daily Summary';
    const days = groupByDay(subset);
    document.querySelector('#temperatureDetail .chart-section').insertAdjacentHTML('beforeend',
      `<div id="tempDayTable" style="overflow-x:auto;margin-top:20px;">
        <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
          <thead><tr style="background:#f1f5f9;">
            <th style="padding:10px 16px;text-align:left;border:1px solid #e2e8f0;color:#475569;">Date</th>
            <th style="padding:10px 16px;text-align:center;border:1px solid #e2e8f0;color:#3b82f6;">Avg °C</th>
            <th style="padding:10px 16px;text-align:center;border:1px solid #e2e8f0;color:#10b981;">Min °C</th>
            <th style="padding:10px 16px;text-align:center;border:1px solid #e2e8f0;color:#ef4444;">Max °C</th>
          </tr></thead>
          <tbody>${days.map(d=>`<tr>
            <td style="padding:10px 16px;border:1px solid #e2e8f0;font-weight:600;">${d.date}</td>
            <td style="padding:10px 16px;border:1px solid #e2e8f0;text-align:center;color:#3b82f6;font-weight:700;">${d.tempAvg}</td>
            <td style="padding:10px 16px;border:1px solid #e2e8f0;text-align:center;color:#10b981;font-weight:700;">${d.tempMin}</td>
            <td style="padding:10px 16px;border:1px solid #e2e8f0;text-align:center;color:#ef4444;font-weight:700;">${d.tempMax}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`);
    chartTempDetail = new Chart(document.getElementById('chartTempDetail').getContext('2d'), {
      type: 'bar',
      data: { labels: days.map(d => d.date), datasets: [
        { label:'Min',     data: days.map(d=>d.tempMin), backgroundColor:'rgba(16,185,129,0.7)',  borderColor:'#10b981', borderWidth:2, borderRadius:6 },
        { label:'Average', data: days.map(d=>d.tempAvg), backgroundColor:'rgba(59,130,246,0.7)',  borderColor:'#3b82f6', borderWidth:2, borderRadius:6 },
        { label:'Max',     data: days.map(d=>d.tempMax), backgroundColor:'rgba(239,68,68,0.7)',   borderColor:'#ef4444', borderWidth:2, borderRadius:6 }
      ]},
      plugins: [tempThresholdPlugin],
      options: { ...getChartOptions(thresholds.hum, false), plugins: { legend: { display: true, labels: { color:'#475569' } } } }
    });
  }
}

// ════════════════════════════════════════════════════════════
//  HUMIDITY DETAIL
// ════════════════════════════════════════════════════════════
function setTodayHum() {
  const today = dateStr(new Date());
  document.getElementById('humDateFrom').value = today;
  document.getElementById('humDateTo').value   = today;
  renderHumDetail();
}

async function renderHumDetail() {
  const from      = document.getElementById('humDateFrom').value;
  const to        = document.getElementById('humDateTo').value;
  const subset    = await fetchRangeData(from, to);
  const isSameDay = from === to;

  const s = stats(subset, 'hum');
  document.getElementById('humDetailMin').textContent = s.min;
  document.getElementById('humDetailMax').textContent = s.max;
  document.getElementById('humDetailAvg').textContent = s.avg;

  if (chartHumDetail) chartHumDetail.destroy();
  const oldTable = document.getElementById('humDayTable');
  if (oldTable) oldTable.remove();

  if (isSameDay) {
    document.getElementById('humChartTitle').textContent = '💧 Humidity — Single Day';
    const bucketed = bucket5min(subset);
    chartHumDetail = new Chart(document.getElementById('chartHumDetail').getContext('2d'), {
      type: 'line',
      data: { labels: bucketed.map(b => b.label), datasets: [{ label: 'Humidity (%)', data: bucketed.map(b => b.hum), borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,0.1)', fill: true, tension: 0.4, pointRadius: 2, borderWidth: 2 }] },
      plugins: [humThresholdPlugin],
      options: { ...getChartOptions(thresholds.hum, false), plugins: { legend: { display: true, labels: { color:'#475569' } } } }
    });
  } else {
    document.getElementById('humChartTitle').textContent = '📊 Humidity — Daily Summary';
    const days = groupByDay(subset);
    document.querySelector('#humidityDetail .chart-section').insertAdjacentHTML('beforeend',
      `<div id="humDayTable" style="overflow-x:auto;margin-top:20px;">
        <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
          <thead><tr style="background:#f1f5f9;">
            <th style="padding:10px 16px;text-align:left;border:1px solid #e2e8f0;color:#475569;">Date</th>
            <th style="padding:10px 16px;text-align:center;border:1px solid #e2e8f0;color:#06b6d4;">Avg %</th>
            <th style="padding:10px 16px;text-align:center;border:1px solid #e2e8f0;color:#10b981;">Min %</th>
            <th style="padding:10px 16px;text-align:center;border:1px solid #e2e8f0;color:#ef4444;">Max %</th>
          </tr></thead>
          <tbody>${days.map(d=>`<tr>
            <td style="padding:10px 16px;border:1px solid #e2e8f0;font-weight:600;">${d.date}</td>
            <td style="padding:10px 16px;border:1px solid #e2e8f0;text-align:center;color:#06b6d4;font-weight:700;">${d.humAvg}</td>
            <td style="padding:10px 16px;border:1px solid #e2e8f0;text-align:center;color:#10b981;font-weight:700;">${d.humMin}</td>
            <td style="padding:10px 16px;border:1px solid #e2e8f0;text-align:center;color:#ef4444;font-weight:700;">${d.humMax}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`);
    chartHumDetail = new Chart(document.getElementById('chartHumDetail').getContext('2d'), {
      type: 'bar',
      data: { labels: days.map(d => d.date), datasets: [
        { label:'Min',     data: days.map(d=>d.humMin), backgroundColor:'rgba(16,185,129,0.7)',  borderColor:'#10b981', borderWidth:2, borderRadius:6 },
        { label:'Average', data: days.map(d=>d.humAvg), backgroundColor:'rgba(6,182,212,0.7)',   borderColor:'#06b6d4', borderWidth:2, borderRadius:6 },
        { label:'Max',     data: days.map(d=>d.humMax), backgroundColor:'rgba(239,68,68,0.7)',   borderColor:'#ef4444', borderWidth:2, borderRadius:6 }
      ]},
      plugins: [humThresholdPlugin],
      options: { ...getChartOptions(thresholds.hum, false), plugins: { legend: { display: true, labels: { color:'#475569' } } } }
    });
  }
}

// ════════════════════════════════════════════════════════════
//  EXPORT  (detail page — uses friendly name in filename)
// ════════════════════════════════════════════════════════════
function setExportToday() {
  const today = dateStr(new Date());
  document.getElementById('exportDateFrom').value = today;
  document.getElementById('exportDateTo').value   = today;
}

async function exportExcelFiltered() {
  const from       = document.getElementById('exportDateFrom').value;
  const to         = document.getElementById('exportDateTo').value;
  if (!from || !to) return alert('Please select a date range.');

  const raw = await fetchRangeData(from, to);
  if (!raw.length) return alert(`No data between ${from} and ${to}.`);

  const deviceId     = getCurrentDeviceId();
  const friendlyName = getFriendlyName(deviceId);
  const isSameDay    = from === to;
  const wb           = XLSX.utils.book_new();
  const tempThresh   = thresholds.temp;
  const humThresh    = thresholds.hum;

  // ── Style builders ─────────────────────────────────────────
  function headerStyle(bgHex) {
    return {
      font:      { bold: true, color: { rgb: 'FFFFFFFF' }, sz: 11 },
      fill:      { patternType: 'solid', fgColor: { rgb: bgHex } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: { top:{style:'medium',color:{rgb:'FFD1D5DB'}}, bottom:{style:'medium',color:{rgb:'FFD1D5DB'}}, left:{style:'medium',color:{rgb:'FFD1D5DB'}}, right:{style:'medium',color:{rgb:'FFD1D5DB'}} }
    };
  }
  function labelStyle() {
    return {
      font:      { bold: true, color: { rgb: 'FF1F2937' }, sz: 10 },
      fill:      { patternType: 'solid', fgColor: { rgb: 'FFF3F4F6' } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: { top:{style:'thin',color:{rgb:'FFE5E7EB'}}, bottom:{style:'thin',color:{rgb:'FFE5E7EB'}}, left:{style:'thin',color:{rgb:'FFE5E7EB'}}, right:{style:'thin',color:{rgb:'FFE5E7EB'}} }
    };
  }
  function areaStyle() {
    return {
      font:      { bold: true, color: { rgb: 'FF1E3A5F' }, sz: 10 },
      fill:      { patternType: 'solid', fgColor: { rgb: 'FFE0F2FE' } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: { top:{style:'thin',color:{rgb:'FFE5E7EB'}}, bottom:{style:'thin',color:{rgb:'FFE5E7EB'}}, left:{style:'thin',color:{rgb:'FFE5E7EB'}}, right:{style:'thin',color:{rgb:'FFE5E7EB'}} }
    };
  }
  function dataStyle(val, thresh) {
    const alert = val > thresh;
    const warn  = !alert && val > thresh * 0.9;
    let fgColor, fontColor;
    if (alert)     { fgColor = 'FFFFF1F2'; fontColor = 'FFBE123C'; }
    else if (warn) { fgColor = 'FFFEFCE8'; fontColor = 'FFB45309'; }
    else           { fgColor = 'FFF0FDF4'; fontColor = 'FF15803D'; }
    return {
      font:      { bold: alert, color: { rgb: fontColor }, sz: 10 },
      fill:      { patternType: 'solid', fgColor: { rgb: fgColor } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: { top:{style:'thin',color:{rgb:'FFE5E7EB'}}, bottom:{style:'thin',color:{rgb:'FFE5E7EB'}}, left:{style:'thin',color:{rgb:'FFE5E7EB'}}, right:{style:'thin',color:{rgb:'FFE5E7EB'}} }
    };
  }
  function makeCell(v, s) { return { v, s, t: typeof v === 'number' ? 'n' : 's' }; }

  // ── Header row — Factory Area column added first ───────────
  const H = [
    makeCell('Factory Area',        headerStyle('FF0F4C81')),  // navy
    makeCell('Hour / Date',         headerStyle('FF1E3A5F')),
    makeCell('Min Temp (°C)',        headerStyle('FF059669')),
    makeCell('Avg Temp (°C)',        headerStyle('FF2563EB')),
    makeCell('Max Temp (°C)',        headerStyle('FFDC2626')),
    makeCell('Min Humidity (%)',     headerStyle('FF059669')),
    makeCell('Avg Humidity (%)',     headerStyle('FF0891B2')),
    makeCell('Max Humidity (%)',     headerStyle('FFDC2626')),
  ];

  const dataRows = [];

  if (isSameDay) {
    const map = {};
    raw.forEach(r => {
      const d   = new Date(r.timestamp);
      const ist = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
      const key = dateStr(d) + ' ' + pad(ist.getUTCHours()) + ':00';
      if (!map[key]) map[key] = { temps: [], hums: [] };
      map[key].temps.push(r.temp);
      map[key].hums.push(r.hum);
    });
    Object.keys(map).sort().forEach(key => {
      const b       = map[key];
      const avg     = arr => +(arr.reduce((a,v)=>a+v,0)/arr.length).toFixed(1);
      const minTemp = +Math.min(...b.temps).toFixed(1);
      const avgTemp = avg(b.temps);
      const maxTemp = +Math.max(...b.temps).toFixed(1);
      const minHum  = +Math.min(...b.hums).toFixed(1);
      const avgHum  = avg(b.hums);
      const maxHum  = +Math.max(...b.hums).toFixed(1);
      dataRows.push([
        makeCell(friendlyName, areaStyle()),
        makeCell(key,          labelStyle()),
        makeCell(minTemp,      dataStyle(minTemp, tempThresh)),
        makeCell(avgTemp,      dataStyle(avgTemp, tempThresh)),
        makeCell(maxTemp,      dataStyle(maxTemp, tempThresh)),
        makeCell(minHum,       dataStyle(minHum,  humThresh)),
        makeCell(avgHum,       dataStyle(avgHum,  humThresh)),
        makeCell(maxHum,       dataStyle(maxHum,  humThresh)),
      ]);
    });
  } else {
    const days = groupByDay(raw);
    days.forEach(d => {
      dataRows.push([
        makeCell(friendlyName, areaStyle()),
        makeCell(d.date,       labelStyle()),
        makeCell(d.tempMin,    dataStyle(d.tempMin, tempThresh)),
        makeCell(d.tempAvg,    dataStyle(d.tempAvg, tempThresh)),
        makeCell(d.tempMax,    dataStyle(d.tempMax, tempThresh)),
        makeCell(d.humMin,     dataStyle(d.humMin,  humThresh)),
        makeCell(d.humAvg,     dataStyle(d.humAvg,  humThresh)),
        makeCell(d.humMax,     dataStyle(d.humMax,  humThresh)),
      ]);
    });
  }

  const allRows = [H, ...dataRows];
  const ws      = XLSX.utils.aoa_to_sheet(allRows);
  ws['!cols']   = [{ wch: 22 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
  ws['!rows']   = [{ hpt: 36 }, ...dataRows.map(() => ({ hpt: 22 }))];

  const sheetName = isSameDay ? from : `${from} to ${to}`;
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  // ── Filename uses friendly name ────────────────────────────
  const safeName = friendlyName.replace(/[^a-zA-Z0-9]/g, '');
  const filename = isSameDay
    ? `${safeName}_HistoricalData_${from}.xlsx`
    : `${safeName}_HistoricalData_${from}_to_${to}.xlsx`;

  const url = URL.createObjectURL(new Blob(
    [XLSX.write(wb, { bookType: 'xlsx', type: 'array' })],
    { type: 'application/octet-stream' }
  ));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

async function exportCSVFiltered() {
  const from       = document.getElementById('exportDateFrom').value;
  const to         = document.getElementById('exportDateTo').value;
  if (!from || !to) return alert('Please select a date range.');

  const raw          = await fetchRangeData(from, to);
  if (!raw.length)   return alert(`No data between ${from} and ${to}.`);

  const deviceId     = getCurrentDeviceId();
  const friendlyName = getFriendlyName(deviceId);
  const isSameDay    = from === to;
  let csv            = '';

  if (isSameDay) {
    const hourly = bucketHourly(raw);
    csv = `Factory Area,Hour,Avg Temperature (°C),Avg Humidity (%)\n`;
    hourly.forEach(r => { csv += `${friendlyName},${r.timestamp},${r.temp},${r.hum}\n`; });
  } else {
    const days = groupByDay(raw);
    csv = `Factory Area,Date,Min Temp (°C),Avg Temp (°C),Max Temp (°C),Min Humidity (%),Avg Humidity (%),Max Humidity (%)\n`;
    days.forEach(d => { csv += `${friendlyName},${d.date},${d.tempMin},${d.tempAvg},${d.tempMax},${d.humMin},${d.humAvg},${d.humMax}\n`; });
  }

  const safeName = friendlyName.replace(/[^a-zA-Z0-9]/g, '');
  const filename = isSameDay
    ? `${safeName}_Data_${from}.csv`
    : `${safeName}_Data_${from}_to_${to}.csv`;

  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: filename
  });
  a.click();
}

// ════════════════════════════════════════════════════════════
//  THRESHOLD PANEL TOGGLE  (detail page)
// ════════════════════════════════════════════════════════════
function toggleThresholdPanel(id) {
  const body = document.getElementById(id);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  if (isOpen) {
    body.style.display = 'none';
    const btn = body.previousElementSibling?.querySelector('.threshold-toggle');
    if (btn) btn.textContent = '▼ Configure';
    return;
  }
  const entered = prompt('🔒 Enter admin password to configure settings:');
  if (entered === null) return;
  if (entered !== 'Rhmeter12345') { alert('❌ Incorrect password. Access denied.'); return; }
  body.style.display = 'block';
  const btn = body.previousElementSibling?.querySelector('.threshold-toggle');
  if (btn) btn.textContent = '▲ Close';
}

// ════════════════════════════════════════════════════════════
//  SETTINGS DRAWER  (home.html)
// ════════════════════════════════════════════════════════════
const ADMIN_PASSWORD = 'Rhmeter12345';
let settingsUnlocked = false;

function openSettingsDrawer() {
  document.getElementById('settingsOverlay')?.classList.add('open');
  document.getElementById('settingsDrawer')?.classList.add('open');
  if (!settingsUnlocked) showPasswordGate();
}

function closeSettingsDrawer() {
  document.getElementById('settingsOverlay')?.classList.remove('open');
  document.getElementById('settingsDrawer')?.classList.remove('open');
}

function showPasswordGate() {
  const gate    = document.getElementById('settingsPasswordGate');
  const content = document.getElementById('settingsContent');
  if (gate)    gate.style.display    = 'flex';
  if (content) content.style.display = 'none';
  const inp = document.getElementById('settingsPasswordInput');
  if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 350); }
}

function unlockSettings() {
  const inp = document.getElementById('settingsPasswordInput');
  const err = document.getElementById('settingsPasswordError');
  if (!inp) return;
  if (inp.value === ADMIN_PASSWORD) {
    settingsUnlocked = true;
    document.getElementById('settingsPasswordGate').style.display = 'none';
    document.getElementById('settingsContent').style.display      = 'block';
    populateSettingsDrawer();
  } else {
    if (err) { err.textContent = '❌ Incorrect password. Try again.'; err.classList.add('visible'); }
    inp.value = '';
    inp.focus();
    setTimeout(() => err?.classList.remove('visible'), 3000);
  }
}

function handleSettingsPasswordKeydown(e) {
  if (e.key === 'Enter') unlockSettings();
}

async function populateSettingsDrawer() {
  const tempInp = document.getElementById('drawerTempThreshold');
  const humInp  = document.getElementById('drawerHumThreshold');
  if (tempInp) tempInp.value = thresholds.temp;
  if (humInp)  humInp.value  = thresholds.hum;

  const container = document.getElementById('drawerRecipientChips');
  if (container) {
    container.innerHTML = '';
    if (thresholds.recipients) {
      thresholds.recipients.split(',').map(e => e.trim()).filter(Boolean).forEach(email => {
        const chip = document.createElement('div');
        chip.className     = 'recipient-chip';
        chip.dataset.email = email;
        chip.innerHTML     = `<span class="chip-email">✉️ ${email}</span><button class="chip-remove" onclick="removeDrawerChip(this)">✕</button>`;
        container.appendChild(chip);
      });
    }
  }

  await loadDeviceRecipients();
  populateNameEditor();
}

function populateNameEditor() {
  const list = document.getElementById('nameEditorList');
  if (!list) return;
  list.innerHTML = '';

  // ── Location recipient cards ──────────────────────────────
  const locationGroups = [
    {
      key: 'samudra',
      label: 'Samudra',
      color: 'var(--accent-blue)',
      devices: ['Meter_01','Meter_03','Meter_04','Meter_05','Meter_06','Meter_07','Meter_08','Meter_09']
    },
    {
      key: 'bng',
      label: 'BNG',
      color: 'var(--accent-cyan)',
      devices: ['Meter_10','Meter_11','Meter_12','Meter_13']
    },
    {
      key: 'rd',
      label: 'R&D',
      color: '#a855f7',
      devices: ['Meter_02']
    }
  ];

  // ── Location recipient section ────────────────────────────
  const locHeader = document.createElement('div');
  locHeader.innerHTML = `
    <div style="font-size:0.72rem;font-weight:700;color:var(--text-muted);
      text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px;margin-top:4px;">
      📧 Location-Based Alert Recipients
    </div>
    <p style="font-size:0.78rem;color:var(--text-muted);margin-bottom:16px;line-height:1.5;">
      Alerts for devices in each location group will go to that group's recipients.
    </p>
  `;
  list.appendChild(locHeader);

  locationGroups.forEach(group => {
    const currentEmails = (DEVICE_RECIPIENTS_MAP[`loc_${group.key}`] || '');
    const chipsHtml = currentEmails
      ? currentEmails.split(',').map(e => e.trim()).filter(Boolean).map(email =>
          `<div class="recipient-chip" data-email="${email}">
            <span class="chip-email">✉️ ${email}</span>
            <button class="chip-remove" onclick="removeDeviceChip(this)">✕ Delete</button>
          </div>`
        ).join('')
      : `<div style="font-size:0.78rem;color:var(--text-muted);padding:4px 0;">No recipients added yet</div>`;

    const card = document.createElement('div');
    card.style.cssText = `
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px 18px;
      margin-bottom: 12px;
    `;
    card.innerHTML = `
      <!-- Location label + device list -->
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
        <span style="
          font-size:0.8rem;font-weight:800;padding:4px 12px;border-radius:8px;
          color:${group.color};background:${group.color}18;
          border:1px solid ${group.color}35;letter-spacing:0.5px;">
          ${group.label}
        </span>
        <span style="font-size:0.7rem;color:var(--text-muted);">
          ${group.devices.join(', ')}
        </span>
      </div>

      <!-- Divider -->
      <div style="height:1px;background:var(--border);margin-bottom:12px;"></div>

      <!-- Recipients label -->
      <div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);
        text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;">
        📧 Recipients for ${group.label}
      </div>

      <!-- Chips -->
      <div class="chips-container device-chips" id="chips-loc_${group.key}"
        style="margin-bottom:10px;">${chipsHtml}</div>

      <!-- Add email row -->
      <div style="display:flex;gap:8px;align-items:center;">
        <input
          type="email"
          class="threshold-input-wide device-email-input"
          id="emailInput-loc_${group.key}"
          placeholder="Add email for ${group.label}"
          style="flex:1;font-size:0.8rem;"
          onkeydown="handleDeviceEmailKeydown(event,'loc_${group.key}')">
        <button class="btn-add-chip" onclick="addDeviceChip('loc_${group.key}')">+ Add</button>
      </div>
    `;
    list.appendChild(card);
  });

  // ── Divider before device name editor ────────────────────
  const divider = document.createElement('div');
  divider.innerHTML = `
    <div style="height:1px;background:var(--border);margin:20px 0 16px;"></div>
    <div style="font-size:0.72rem;font-weight:700;color:var(--text-muted);
      text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px;">
      🏭 Device Friendly Names
    </div>
  `;
  list.appendChild(divider);

  // ── Device name editor (same as before) ──────────────────
  Object.keys(DEVICE_NAME_MAP).forEach(deviceId => {
    const friendlyName = DEVICE_NAME_MAP[deviceId];
    const isSamudra = ['Meter_01','Meter_03','Meter_04','Meter_05','Meter_06','Meter_07','Meter_08','Meter_09'].includes(deviceId);
    const isRD      = ['Meter_02'].includes(deviceId);
    const locLabel  = isSamudra ? 'Samudra' : isRD ? 'R&D' : 'BNG';
    const locColor  = isSamudra ? 'var(--accent-blue)' : isRD ? '#a855f7' : 'var(--accent-cyan)';

    const card = document.createElement('div');
    card.style.cssText = `
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px 18px;
      margin-bottom: 12px;
    `;
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="
          font-size:0.7rem;font-family:'JetBrains Mono',monospace;font-weight:600;
          color:var(--text-muted);background:var(--bg);border:1px solid var(--border);
          border-radius:6px;padding:3px 9px;white-space:nowrap;flex-shrink:0;">
          ${deviceId}
        </span>
        <input
          class="name-editor-input"
          type="text"
          data-device="${deviceId}"
          value="${friendlyName}"
          placeholder="Enter area name"
          style="flex:1;padding:7px 11px;border:1px solid var(--border);
            border-radius:8px;background:var(--bg);color:var(--text);
            font-size:0.875rem;outline:none;"
        >
        <span style="
          font-size:0.65rem;font-weight:700;padding:3px 9px;border-radius:6px;
          border:1px solid;white-space:nowrap;flex-shrink:0;
          color:${locColor};border-color:${locColor}30;background:${locColor}15;">
          ${locLabel}
        </span>
      </div>
    `;
    list.appendChild(card);
  });
}
async function saveDeviceNames() {
  // Collect updated device names
  const inputs = document.querySelectorAll('.name-editor-input');
  inputs.forEach(inp => {
    const deviceId = inp.dataset.device;
    const newName  = inp.value.trim();
    if (deviceId && newName) DEVICE_NAME_MAP[deviceId] = newName;
  });

  // Collect location-based recipients (loc_samudra, loc_bng, loc_rd)
  const newRecipientsMap = {};
  ['loc_samudra', 'loc_bng', 'loc_rd'].forEach(key => {
    const container = document.getElementById(`chips-${key}`);
    if (container) {
      const emails = Array.from(container.querySelectorAll('.recipient-chip'))
        .map(c => c.dataset.email).filter(Boolean).join(',');
      if (emails) newRecipientsMap[key] = emails;
    }
  });
  DEVICE_RECIPIENTS_MAP = newRecipientsMap;

  try {
    await saveDeviceNameMap(DEVICE_NAME_MAP);
    await saveDeviceRecipients(DEVICE_RECIPIENTS_MAP);
    showToast('✅ Device names & recipients saved!', 'success');
    if (typeof renderDeviceGrid === 'function') renderDeviceGrid();
  } catch(e) {
    showToast('❌ Failed to save: ' + e.message, 'error');
  }
}

function addDrawerChip() {
  const input = document.getElementById('drawerEmailInput');
  if (!input) return;
  const email = input.value.trim().toLowerCase();
  if (!email) return showToast('Please enter an email first', 'error');
  if (!email.includes('@') || !email.includes('.')) return showToast('Enter a valid email address', 'error');
  const container  = document.getElementById('drawerRecipientChips');
  const existing   = Array.from(container.querySelectorAll('.recipient-chip')).map(c => c.dataset.email);
  if (existing.includes(email)) return showToast('Email already added', 'error');
  const chip = document.createElement('div');
  chip.className     = 'recipient-chip';
  chip.dataset.email = email;
  chip.innerHTML     = `<span class="chip-email">✉️ ${email}</span><button class="chip-remove" onclick="removeDrawerChip(this)">✕</button>`;
  container.appendChild(chip);
  input.value = '';
  input.focus();
}

function removeDrawerChip(btn) { btn.closest('.recipient-chip').remove(); }

// ── Per-device recipient helpers ──────────────────────────────
// let DEVICE_RECIPIENTS_MAP = {};

async function loadDeviceRecipients() {
  try {
    const res = await fetch(`${SERVER_URL}/api/device-recipients`);
    if (!res.ok) throw new Error('Not OK');
    const data = await res.json();
    if (data.recipients && typeof data.recipients === 'object') {
      DEVICE_RECIPIENTS_MAP = data.recipients;
    }
  } catch(e) {
    console.warn('[DeviceRecipients] Failed to load:', e.message);
    DEVICE_RECIPIENTS_MAP = {};
  }
}

async function saveDeviceRecipients(map) {
  const res = await fetch(`${SERVER_URL}/api/device-recipients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipients: map })
  });
  if (!res.ok) throw new Error('Server returned ' + res.status);
}

function addDeviceChip(deviceId) {
  const input = document.getElementById(`emailInput-${deviceId}`);
  if (!input) return;
  const email = input.value.trim().toLowerCase();
  if (!email) return showToast('Please enter an email', 'error');
  if (!email.includes('@') || !email.includes('.')) return showToast('Enter a valid email', 'error');
  const container = document.getElementById(`chips-${deviceId}`);
  // clear "no recipients" placeholder if present
  const placeholder = container.querySelector('div');
  if (placeholder && !placeholder.classList.contains('recipient-chip')) placeholder.remove();
  const existing = Array.from(container.querySelectorAll('.recipient-chip')).map(c => c.dataset.email);
  if (existing.includes(email)) return showToast('Email already added', 'error');
  const chip = document.createElement('div');
  chip.className     = 'recipient-chip';
  chip.dataset.email = email;
  chip.innerHTML     = `<span class="chip-email">✉️ ${email}</span><button class="chip-remove" onclick="removeDeviceChip(this)">✕ Delete</button>`;
  container.appendChild(chip);
  input.value = '';
  input.focus();
}

function removeDeviceChip(btn) { btn.closest('.recipient-chip').remove(); }

function handleDeviceEmailKeydown(e, deviceId) {
  if (e.key === 'Enter') { e.preventDefault(); addDeviceChip(deviceId); }
}

function addDeviceChip(deviceId) {
  const input = document.getElementById(`emailInput-${deviceId}`);
  if (!input) return;
  const email = input.value.trim().toLowerCase();
  if (!email) return showToast('Please enter an email', 'error');
  if (!email.includes('@') || !email.includes('.')) return showToast('Enter a valid email', 'error');
  const container = document.getElementById(`chips-${deviceId}`);
  const existing  = Array.from(container.querySelectorAll('.recipient-chip')).map(c => c.dataset.email);
  if (existing.includes(email)) return showToast('Email already added', 'error');
  const chip = document.createElement('div');
  chip.className     = 'recipient-chip';
  chip.dataset.email = email;
  chip.innerHTML     = `<span class="chip-email">✉️ ${email}</span><button class="chip-remove" onclick="removeDeviceChip(this)">✕</button>`;
  container.appendChild(chip);
  input.value = '';
  input.focus();
}

function removeDeviceChip(btn) { btn.closest('.recipient-chip').remove(); }

function handleDeviceEmailKeydown(e, deviceId) {
  if (e.key === 'Enter') { e.preventDefault(); addDeviceChip(deviceId); }
}

function handleDrawerEmailKeydown(e) { if (e.key === 'Enter') { e.preventDefault(); addDrawerChip(); } }

async function saveDrawerSettings() {
  const tv = parseFloat(document.getElementById('drawerTempThreshold')?.value);
  const hv = parseFloat(document.getElementById('drawerHumThreshold')?.value);
  if (isNaN(tv)) return showToast('Enter a valid temperature threshold', 'error');
  if (isNaN(hv)) return showToast('Enter a valid humidity threshold', 'error');

  const chips        = document.querySelectorAll('#drawerRecipientChips .recipient-chip');
  const recipientList = Array.from(chips).map(c => c.dataset.email).filter(Boolean).join(',');
  if (!recipientList) return showToast('Add at least one recipient email', 'error');

  try {
    const res = await fetch(`${SERVER_URL}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempThreshold: tv, humThreshold: hv, recipients: recipientList })
    });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    thresholds.temp       = tv;
    thresholds.hum        = hv;
    thresholds.recipients = recipientList;
    showToast('✅ Alert settings saved!', 'success');
  } catch (e) {
    showToast('❌ Failed to save: ' + e.message, 'error');
  }
}

async function sendDrawerTestEmail() {
  const chips        = document.querySelectorAll('#drawerRecipientChips .recipient-chip');
  const recipientList = Array.from(chips).map(c => c.dataset.email).filter(Boolean).join(',');
  if (!recipientList) return showToast('Add at least one recipient email first', 'error');

  const btn = document.getElementById('drawerTestEmailBtn');
  if (btn) { btn.disabled = true; btn.textContent = '📨 Sending...'; }

  try {
    const res  = await fetch(`${SERVER_URL}/api/test-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: recipientList })
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) showToast('✅ Test email sent!', 'success');
    else showToast('❌ Email failed: ' + (json.error || `Status ${res.status}`), 'error');
  } catch (e) {
    showToast('❌ Could not reach server: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📨 Send Test Email'; }
  }
}

// ════════════════════════════════════════════════════════════
//  HOME PAGE — DEVICE GRID  (home.html)
// ════════════════════════════════════════════════════════════
let deviceStatusCache = {};   // { Meter_01: { online, lastSeen, temp, hum } }
let filterActive      = false;
let filteredDeviceIds = [];

function renderDeviceGrid(filterIds = null) {
  const grid = document.getElementById('deviceGrid');
  if (!grid) return;

  const keys      = Object.keys(DEVICE_NAME_MAP);
  const useFilter = filterIds !== null;
  grid.innerHTML  = '';
  let visibleCount = 0;

  keys.forEach((deviceId, index) => {
    const friendlyName = DEVICE_NAME_MAP[deviceId];
    const status       = deviceStatusCache[deviceId] || {};
    const isOnline     = status.online === true;
    const isChecking   = status.online === undefined;
    const isOffline    = status.online === false;
    const lastSeen     = status.lastSeen || null;
    const temp         = status.temp;
    const hum          = status.hum;

    const isVisible = !useFilter || filterIds.includes(deviceId);
    if (!isVisible) return;
    visibleCount++;

    // Status values
    const statusClass = isChecking ? 'checking' : (isOnline ? 'online' : 'offline');
    const statusText  = isChecking ? 'Checking...' : (isOnline ? 'Online' : 'Offline');
    const statusIcon  = isChecking ? '⏳' : (isOnline ? '🟢' : '🔴');

    // Last seen
    const lastSeenStr = lastSeen
      ? new Date(lastSeen).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true })
      : '--:--';

    // Temp & humidity display
    const tempDisplay = (isOnline && temp != null) ? `${parseFloat(temp).toFixed(1)}°C` : '--.-°C';
    const humDisplay  = (isOnline && hum  != null) ? `${parseFloat(hum).toFixed(1)}%`   : '--.- %';

    // Alert classes for temp/hum
    const tempAlert = (isOnline && temp != null && temp > thresholds.temp);
    const humAlert  = (isOnline && hum  != null && hum  > thresholds.hum);
    const tempClass = tempAlert ? 'dc-value alert' : 'dc-value';
    const humClass  = humAlert  ? 'dc-value alert' : 'dc-value';

    // Card alert border
    const cardClass = (tempAlert || humAlert) ? 'device-card alert-card' : 'device-card';

    const card = document.createElement('a');
    card.href      = `index.html?id=${deviceId}`;
    card.className = cardClass;
    card.style.animationDelay = `${index * 0.05}s`;

    card.innerHTML = `
      <!-- Top row: name + ID badge -->
      <div class="dc-top">
        <div class="dc-name">${friendlyName}</div>
        <span class="dc-id">${deviceId}</span>
      </div>

      <!-- Status bar -->
      <div class="dc-status-bar ${statusClass}">
        <span class="dc-status-dot ${statusClass}"></span>
        <span class="dc-status-text">${statusText}</span>
        <span class="dc-last-seen">Last: ${lastSeenStr}</span>
      </div>

      <!-- Sensor readings -->
      <div class="dc-readings">
        <div class="dc-reading-block">
          <span class="dc-reading-icon">🌡️</span>
          <div>
            <div class="${tempClass}">${tempDisplay}</div>
            <div class="dc-reading-label">Temperature</div>
          </div>
          ${tempAlert ? '<span class="dc-alert-tag">⚠️ HIGH</span>' : ''}
        </div>
        <div class="dc-divider"></div>
        <div class="dc-reading-block">
          <span class="dc-reading-icon">💧</span>
          <div>
            <div class="${humClass}">${humDisplay}</div>
            <div class="dc-reading-label">Humidity</div>
          </div>
          ${humAlert ? '<span class="dc-alert-tag">⚠️ HIGH</span>' : ''}
        </div>
      </div>

      <!-- Footer -->
      <div class="dc-footer">
        <span class="dc-view-link">View Details →</span>
      </div>
    `;
    grid.appendChild(card);
  });

  // No results message
  const noMsg = document.getElementById('noResultsMsg');
  if (noMsg) noMsg.classList.toggle('visible', useFilter && visibleCount === 0);
}

async function checkDeviceStatus(deviceId) {
  try {
    const res = await fetch(`${SERVER_URL}/api/data?deviceId=${deviceId}&_t=${Date.now()}`);
    if (!res.ok) throw new Error('Not OK');
    const d = await res.json();
    const t = d.temperature ?? d.temp;
    const h = d.humidity    ?? d.hum;
    if (t != null && h != null) {
      deviceStatusCache[deviceId] = { online: true, lastSeen: d.timestamp || new Date().toISOString(), temp: t, hum: h };
    } else {
      deviceStatusCache[deviceId] = { online: false };
    }
  } catch {
    deviceStatusCache[deviceId] = { online: false };
  }
}

async function refreshAllDeviceStatuses() {
  const keys = Object.keys(DEVICE_NAME_MAP);
  // Check all in parallel
  await Promise.all(keys.map(id => checkDeviceStatus(id)));
  renderDeviceGrid(filterActive ? filteredDeviceIds : null);
}

// ════════════════════════════════════════════════════════════
//  THRESHOLD FILTER  (home.html)
// ════════════════════════════════════════════════════════════
async function applyThresholdFilter() {
  const from = document.getElementById('filterDateFrom')?.value;
  const to   = document.getElementById('filterDateTo')?.value;
  if (!from || !to) return showToast('Please select a date range first', 'error');

  const btn      = document.getElementById('thresholdFilterBtn');
  const clearBtn = document.getElementById('clearFilterBtn');
  const statusEl = document.getElementById('filterStatusText');

  if (btn) { btn.textContent = '🔍 Searching...'; btn.disabled = true; }

  try {
    const res = await fetch(
      `${SERVER_URL}/api/historical/threshold-breaches?from=${from}&to=${to}&tempThreshold=${thresholds.temp}&humThreshold=${thresholds.hum}&_t=${Date.now()}`
    );
    if (!res.ok) throw new Error('Server error ' + res.status);
    const data = await res.json();

    filteredDeviceIds = data.deviceIds || [];
    filterActive      = true;

    renderDeviceGrid(filteredDeviceIds);

    if (clearBtn)  clearBtn.classList.add('visible');
    if (statusEl) {
      statusEl.textContent = filteredDeviceIds.length > 0
        ? `⚠️ ${filteredDeviceIds.length} device(s) exceeded thresholds between ${from} and ${to}`
        : `✅ No threshold breaches found between ${from} and ${to}`;
      statusEl.classList.add('visible');
    }
    if (btn) btn.classList.add('active');
  } catch (e) {
    showToast('❌ Filter failed: ' + e.message, 'error');
  } finally {
    if (btn) { btn.textContent = '🔍 Apply Filter'; btn.disabled = false; }
  }
}

function clearThresholdFilter() {
  filterActive      = false;
  filteredDeviceIds = [];
  renderDeviceGrid(null);

  const btn      = document.getElementById('thresholdFilterBtn');
  const clearBtn = document.getElementById('clearFilterBtn');
  const statusEl = document.getElementById('filterStatusText');

  if (btn)      { btn.classList.remove('active'); }
  if (clearBtn)  clearBtn.classList.remove('visible');
  if (statusEl)  statusEl.classList.remove('visible');
}

// ════════════════════════════════════════════════════════════
//  HOME PAGE — EXPORT ALL DEVICES EXCEL
//  One sheet per device, friendly name as sheet name
// ════════════════════════════════════════════════════════════
async function exportAllDevicesExcel(deviceIds, from, to) {
  if (!from || !to) return showToast('Please select a date range', 'error');
  if (!deviceIds || !deviceIds.length) return showToast('No devices to export', 'error');
  const wb         = XLSX.utils.book_new();
  const isSameDay  = from === to;
  const tempThresh = thresholds.temp;
  const humThresh  = thresholds.hum;

  // ── Shared style helpers ────────────────────────────────────
  function headerStyle(bgHex) {
    return {
      font:      { bold: true, color: { rgb: 'FFFFFFFF' }, sz: 11 },
      fill:      { patternType: 'solid', fgColor: { rgb: bgHex } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: { top:{style:'medium',color:{rgb:'FFD1D5DB'}}, bottom:{style:'medium',color:{rgb:'FFD1D5DB'}}, left:{style:'medium',color:{rgb:'FFD1D5DB'}}, right:{style:'medium',color:{rgb:'FFD1D5DB'}} }
    };
  }
  function labelStyle() {
    return {
      font:      { bold: true, color: { rgb: 'FF1F2937' }, sz: 10 },
      fill:      { patternType: 'solid', fgColor: { rgb: 'FFF3F4F6' } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: { top:{style:'thin',color:{rgb:'FFE5E7EB'}}, bottom:{style:'thin',color:{rgb:'FFE5E7EB'}}, left:{style:'thin',color:{rgb:'FFE5E7EB'}}, right:{style:'thin',color:{rgb:'FFE5E7EB'}} }
    };
  }
  function areaStyle() {
    return {
      font:      { bold: true, color: { rgb: 'FF1E3A5F' }, sz: 10 },
      fill:      { patternType: 'solid', fgColor: { rgb: 'FFE0F2FE' } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: { top:{style:'thin',color:{rgb:'FFE5E7EB'}}, bottom:{style:'thin',color:{rgb:'FFE5E7EB'}}, left:{style:'thin',color:{rgb:'FFE5E7EB'}}, right:{style:'thin',color:{rgb:'FFE5E7EB'}} }
    };
  }
  function dataStyle(val, thresh) {
    const alert = val > thresh;
    const warn  = !alert && val > thresh * 0.9;
    let fgColor, fontColor;
    if (alert)     { fgColor = 'FFFFF1F2'; fontColor = 'FFBE123C'; }
    else if (warn) { fgColor = 'FFFEFCE8'; fontColor = 'FFB45309'; }
    else           { fgColor = 'FFF0FDF4'; fontColor = 'FF15803D'; }
    return {
      font:      { bold: alert, color: { rgb: fontColor }, sz: 10 },
      fill:      { patternType: 'solid', fgColor: { rgb: fgColor } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: { top:{style:'thin',color:{rgb:'FFE5E7EB'}}, bottom:{style:'thin',color:{rgb:'FFE5E7EB'}}, left:{style:'thin',color:{rgb:'FFE5E7EB'}}, right:{style:'thin',color:{rgb:'FFE5E7EB'}} }
    };
  }
  function noDataStyle() {
    return {
      font:      { italic: true, color: { rgb: 'FF94A3B8' }, sz: 10 },
      fill:      { patternType: 'solid', fgColor: { rgb: 'FFF8FAFC' } },
      alignment: { horizontal: 'center', vertical: 'center' }
    };
  }
  function makeCell(v, s) { return { v, s, t: typeof v === 'number' ? 'n' : 's' }; }

  // ── Header row ──────────────────────────────────────────────
  const HEADER = [
    makeCell('Factory Area',     headerStyle('FF0F4C81')),
    makeCell('Hour / Date',      headerStyle('FF1E3A5F')),
    makeCell('Min Temp (°C)',    headerStyle('FF059669')),
    makeCell('Avg Temp (°C)',    headerStyle('FF2563EB')),
    makeCell('Max Temp (°C)',    headerStyle('FFDC2626')),
    makeCell('Min Humidity (%)', headerStyle('FF059669')),
    makeCell('Avg Humidity (%)', headerStyle('FF0891B2')),
    makeCell('Max Humidity (%)', headerStyle('FFDC2626')),
  ];

  let sheetsAdded = 0;

  for (const deviceId of deviceIds) {
    const friendlyName = getFriendlyName(deviceId);

    // Fetch data for this device
    let raw = [];
    try {
      const res = await fetch(
        `${SERVER_URL}/api/history?deviceId=${deviceId}&from=${from}&to=${to}&_t=${Date.now()}`
      );
      if (res.ok) {
        const records = await res.json();
        raw = records.map(r => ({
          timestamp: r.timestamp,
          temp: r.temperature !== undefined ? r.temperature : r.temp,
          hum:  r.humidity    !== undefined ? r.humidity    : r.hum
        })).filter(r => r.temp != null && r.hum != null);
      }
    } catch (e) {
      console.warn(`[ExportAll] Failed to fetch ${deviceId}:`, e.message);
    }

    const dataRows = [];

    if (raw.length === 0) {
      // No data — add a single "no data" row
      dataRows.push([
        makeCell(friendlyName,               areaStyle()),
        makeCell('No data for selected range', noDataStyle()),
        makeCell('--', noDataStyle()),
        makeCell('--', noDataStyle()),
        makeCell('--', noDataStyle()),
        makeCell('--', noDataStyle()),
        makeCell('--', noDataStyle()),
        makeCell('--', noDataStyle()),
      ]);
    } else {
      // ── Always use 1-hour buckets regardless of date range ──
      const map = {};
      raw.forEach(r => {
        const d   = new Date(r.timestamp);
        const ist = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
        // Key = date + hour (IST)
        const dateKey = ist.getUTCFullYear() + '-' +
          String(ist.getUTCMonth()+1).padStart(2,'0') + '-' +
          String(ist.getUTCDate()).padStart(2,'0');
        const key = dateKey + ' ' + pad(ist.getUTCHours()) + ':00';
        if (!map[key]) map[key] = { temps: [], hums: [] };
        map[key].temps.push(r.temp);
        map[key].hums.push(r.hum);
      });
      Object.keys(map).sort().forEach(key => {
        const b       = map[key];
        const avg     = arr => +(arr.reduce((a,v)=>a+v,0)/arr.length).toFixed(1);
        const minTemp = +Math.min(...b.temps).toFixed(1);
        const avgTemp = avg(b.temps);
        const maxTemp = +Math.max(...b.temps).toFixed(1);
        const minHum  = +Math.min(...b.hums).toFixed(1);
        const avgHum  = avg(b.hums);
        const maxHum  = +Math.max(...b.hums).toFixed(1);
        dataRows.push([
          makeCell(friendlyName, areaStyle()),
          makeCell(key,          labelStyle()),
          makeCell(minTemp,      dataStyle(minTemp, tempThresh)),
          makeCell(avgTemp,      dataStyle(avgTemp, tempThresh)),
          makeCell(maxTemp,      dataStyle(maxTemp, tempThresh)),
          makeCell(minHum,       dataStyle(minHum,  humThresh)),
          makeCell(avgHum,       dataStyle(avgHum,  humThresh)),
          makeCell(maxHum,       dataStyle(maxHum,  humThresh)),
        ]);
      });
    }

    // Build worksheet
    const allRows = [HEADER, ...dataRows];
    const ws      = XLSX.utils.aoa_to_sheet(allRows);
    ws['!cols']   = [{ wch:22 }, { wch:16 }, { wch:16 }, { wch:16 }, { wch:16 }, { wch:18 }, { wch:18 }, { wch:18 }];
    ws['!rows']   = [{ hpt:36 }, ...dataRows.map(() => ({ hpt:22 }))];

    // Sheet name = friendly name (max 31 chars, Excel limit)
    const sheetName = friendlyName.substring(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    sheetsAdded++;
  }

  // Download
  const filename = isSameDay
    ? `FactoryMonitor_AllDevices_${from}.xlsx`
    : `FactoryMonitor_AllDevices_${from}_to_${to}.xlsx`;

  const url = URL.createObjectURL(new Blob(
    [XLSX.write(wb, { bookType: 'xlsx', type: 'array' })],
    { type: 'application/octet-stream' }
  ));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);

  showToast(`✅ Excel exported! ${sheetsAdded} sheet(s) included.`, 'success');
}

// ════════════════════════════════════════════════════════════
//  MIDNIGHT RESET
// ════════════════════════════════════════════════════════════
function scheduleMidnightReset() {
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0, 0, 5);
  setTimeout(() => { renderTodayCharts(); updateStats(); scheduleMidnightReset(); }, next - now);
}

// ════════════════════════════════════════════════════════════
//  BOOTSTRAP — DETAIL PAGE  (index.html)
// ════════════════════════════════════════════════════════════
async function initDetailPage() {
  if (!document.getElementById('dashboardView')) return;

  // Always fetch latest names from MongoDB so renames reflect immediately
  await loadDeviceNameMap();

  const deviceId     = getCurrentDeviceId();
  const friendlyName = getFriendlyName(deviceId);

  // Update title, browser tab, and chart titles
  const titleEl = document.getElementById('pageDeviceTitle');
  if (titleEl) titleEl.textContent = `Data Visualization: ${friendlyName}`;
  document.title = `${friendlyName} — RH-Meter`;

  const tempChartTitle = document.getElementById('tempChartTitle');
  const humChartTitle  = document.getElementById('humChartTitle');
  if (tempChartTitle) tempChartTitle.textContent = `📈 Temperature — ${friendlyName}`;
  if (humChartTitle)  humChartTitle.textContent  = `💧 Humidity — ${friendlyName}`;

  scheduleMidnightReset();
  initCharts();

  document.getElementById('tempDateFrom')?.addEventListener('change', renderTempDetail);
  document.getElementById('tempDateTo')?.addEventListener('change',   renderTempDetail);
  document.getElementById('humDateFrom')?.addEventListener('change',  renderHumDetail);
  document.getElementById('humDateTo')?.addEventListener('change',    renderHumDetail);

  loadSettings().then(() => {
    fetchCurrent();
    fetchAllData();
  });

  setExportToday();

  setInterval(fetchCurrent, 10000);
  setInterval(fetchAllData, 60000);
}

// ════════════════════════════════════════════════════════════
//  BOOTSTRAP — HOME PAGE  (home.html)
// ════════════════════════════════════════════════════════════
function initHomePage() {
  if (!document.getElementById('deviceGrid')) return;

  // Set today's date in filter bar
  const today = dateStr(new Date());
  const fromEl = document.getElementById('filterDateFrom');
  const toEl   = document.getElementById('filterDateTo');
  if (fromEl) fromEl.value = today;
  if (toEl)   toEl.value   = today;

  // Set export date range defaults
  const expFrom = document.getElementById('exportAllDateFrom');
  const expTo   = document.getElementById('exportAllDateTo');
  if (expFrom) expFrom.value = today;
  if (expTo)   expTo.value   = today;

  // Load device names from MongoDB first, then load settings and render
  loadDeviceNameMap().then(() => {
    return loadSettings();
  }).then(() => {
    renderDeviceGrid(null);
    refreshAllDeviceStatuses();
    setInterval(refreshAllDeviceStatuses, 30000);
  });

  // Settings drawer — close on overlay click
  document.getElementById('settingsOverlay')?.addEventListener('click', closeSettingsDrawer);
}

// ════════════════════════════════════════════════════════════
//  DOM READY — auto-detect which page we're on
// ════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('deviceGrid')) {
    initHomePage();
  } else if (document.getElementById('dashboardView')) {
    initDetailPage(); // async function, no need to await at top level
  }
});