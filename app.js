// ============================================================
//  Factory Monitor Pro — app.js
//  Depends on: Chart.js 4.4.0, SheetJS (xlsx.full.min.js)
// ============================================================
const SERVER_URL = 'https://rh-meter-bridge.onrender.com';
let allData         = [];
let chartTempToday  = null;
let chartHumToday   = null;
let chartTempDetail = null;
let chartHumDetail  = null;
let failCount       = 0;
let lastTemp        = null;
let lastHum         = null;

let thresholds = { temp: 35, hum: 70, recipients: '', senderEmail: '', appPassSet: false };

// ── Utility ──────────────────────────────────────────────────
function pad(n)     { return n < 10 ? '0' + n : '' + n; }
function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

function filterDate(ds) {
  return allData.filter(r => dateStr(new Date(r.timestamp)) === ds);
}
function filterRange(from, to) {
  return allData.filter(r => {
    const d = dateStr(new Date(r.timestamp));
    return d >= from && d <= to;
  });
}

function bucket30min(arr) {
  const map = {};
  arr.forEach(r => {
    const d = new Date(r.timestamp);
    const m = d.getMinutes() < 30 ? '00' : '30';
    const key = dateStr(d) + ' ' + pad(d.getHours()) + ':' + m;
    if (!map[key]) map[key] = { temps: [], hums: [], key };
    map[key].temps.push(r.temp);
    map[key].hums.push(r.hum);
  });
  return Object.keys(map).sort().map(k => {
    const b = map[k];
    return {
      label: b.key.split(' ')[1],
      temp:  +(b.temps.reduce((a, v) => a + v, 0) / b.temps.length).toFixed(1),
      hum:   +(b.hums.reduce((a, v)  => a + v, 0) / b.hums.length).toFixed(1)
    };
  });
}

function bucket5min(arr) {
  const map = {};
  arr.forEach(r => {
    const d = new Date(r.timestamp);
    const m = Math.floor(d.getMinutes() / 5) * 5;
    const key = dateStr(d) + ' ' + pad(d.getHours()) + ':' + pad(m);
    if (!map[key]) map[key] = { temps: [], hums: [], key };
    map[key].temps.push(r.temp);
    map[key].hums.push(r.hum);
  });
  return Object.keys(map).sort().map(k => {
    const b = map[k];
    return {
      label: b.key.split(' ')[1],
      temp:  +(b.temps.reduce((a, v) => a + v, 0) / b.temps.length).toFixed(1),
      hum:   +(b.hums.reduce((a, v)  => a + v, 0) / b.hums.length).toFixed(1)
    };
  });
}

function groupByDay(arr) {
  const map = {};
  arr.forEach(r => {
    const ds = dateStr(new Date(r.timestamp));
    if (!map[ds]) map[ds] = { temps: [], hums: [] };
    map[ds].temps.push(r.temp);
    map[ds].hums.push(r.hum);
  });
  return Object.keys(map).sort().map(ds => {
    const g = map[ds];
    return {
      date:    ds,
      tempAvg: +(g.temps.reduce((a, v) => a + v, 0) / g.temps.length).toFixed(1),
      tempMin: +Math.min(...g.temps).toFixed(1),
      tempMax: +Math.max(...g.temps).toFixed(1),
      humAvg:  +(g.hums.reduce((a, v)  => a + v, 0) / g.hums.length).toFixed(1),
      humMin:  +Math.min(...g.hums).toFixed(1),
      humMax:  +Math.max(...g.hums).toFixed(1)
    };
  });
}

function stats(arr, key) {
  if (!arr.length) return { min: '--', max: '--', avg: '--' };
  const v = arr.map(r => r[key]);
  return {
    min: Math.min(...v).toFixed(1),
    max: Math.max(...v).toFixed(1),
    avg: (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)
  };
}

// ── Status Badge ─────────────────────────────────────────────
function updateStatusBadge(isOnline) {
  const badge = document.getElementById('statusBadge');
  const text  = document.getElementById('statusText');
  if (!badge || !text) return;
  if (isOnline) {
    badge.classList.remove('offline');
    text.textContent = 'Online';
  } else {
    badge.classList.add('offline');
    text.textContent = 'Offline';
  }
}

// ── ThingsBoard Connection ────────────────────────────────────
const TB_HOST   = "https://thingsboard.cloud";
const DEVICE_ID = "b2829b00-0c8a-11f1-b5a7-93241ed57bdc";
const TB_USER   = "naveenkumarak2002@gmail.com";
const TB_PASS   = "Naveen235623@@@";
let jwtToken    = null;

async function loginTB() {
  try {
    const res = await fetch(`${TB_HOST}/api/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify({ username: TB_USER.trim(), password: TB_PASS.trim() })
    });
    if (res.status === 401) { console.error("❌ TB Login rejected"); return; }
    const data = await res.json();
    jwtToken   = data.token;
    console.log("✅ TB Login OK");
  } catch (e) {
    console.error("❌ TB Login network error:", e);
  }
}

function getTempLevel(t) { return t <= 27.0 ? 'normal' : (t <= 35.0 ? 'warning' : 'critical'); }
function getHumLevel(h)  { return h < 40.0 ? 'critical' : (h <= 70.0 ? 'normal' : 'warning'); }

// ── Fetch current reading from ThingsBoard ────────────────────
async function fetchCurrent() {
  if (!jwtToken) await loginTB();
  if (!jwtToken) return;

  try {
    const res = await fetch(
      `${TB_HOST}/api/plugins/telemetry/DEVICE/${DEVICE_ID}/values/timeseries?keys=temperature,humidity`,
      { headers: { 'X-Authorization': `Bearer ${jwtToken}` } }
    );
    const tbData = await res.json();

    failCount = 0;
    updateStatusBadge(true);

    if (!tbData.temperature || !tbData.humidity) return;

    const t = parseFloat(tbData.temperature[0].value);
    const h = parseFloat(tbData.humidity[0].value);

    // ── Temperature UI ──
    document.getElementById('tempValue').textContent = t.toFixed(1);
    if (lastTemp !== null) {
      const diff = t - lastTemp;
      document.getElementById('tempTrend').textContent     = diff > 0.2 ? '↑' : diff < -0.2 ? '↓' : '→';
      document.getElementById('tempTrendText').textContent = diff > 0.2 ? 'Rising' : diff < -0.2 ? 'Falling' : 'Stable';
    }
    lastTemp = t;
    const tempStatus = document.getElementById('tempStatus');
    tempStatus.className   = 'status-badge-inline status-' + getTempLevel(t);
    tempStatus.textContent = getTempLevel(t).charAt(0).toUpperCase() + getTempLevel(t).slice(1);

    // ── Humidity UI ──
    document.getElementById('humValue').textContent = h.toFixed(1);
    if (lastHum !== null) {
      const diff = h - lastHum;
      document.getElementById('humTrend').textContent     = diff > 0.5 ? '↑' : diff < -0.5 ? '↓' : '→';
      document.getElementById('humTrendText').textContent = diff > 0.5 ? 'Rising' : diff < -0.5 ? 'Falling' : 'Stable';
    }
    lastHum = h;
    const humStatus = document.getElementById('humStatus');
    humStatus.className   = 'status-badge-inline status-' + getHumLevel(h);
    humStatus.textContent = getHumLevel(h).charAt(0).toUpperCase() + getHumLevel(h).slice(1);

    // ── FIX: Send to backend for alert checking (server handles email — no double send) ──
    saveToBackend(t, h);

  } catch (err) {
    failCount++;
    if (failCount >= 3) { updateStatusBadge(false); jwtToken = null; }
  }
}

// ── Save to backend — server checks threshold & sends email ──
// ✅ FIX: This replaces the old checkThresholdsAndAlert() which double-saved data.
//    Now we just post once per reading. The server does ALL alert logic.
let _lastSaveTs = 0;
async function saveToBackend(temp, hum) {
  // Throttle: only save once every 10 seconds to avoid flooding MongoDB
  const now = Date.now();
  if (now - _lastSaveTs < 10000) return;
  _lastSaveTs = now;

  try {
    await fetch(`${SERVER_URL}/save-data`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        deviceId:    document.getElementById('meterSelect')?.value || 'Meter_01',
        temperature: temp,
        humidity:    hum,
        tempLevel:   getTempLevel(temp),
        humLevel:    getHumLevel(hum)
      })
    });
  } catch (e) {
    console.warn('Backend save failed:', e.message);
  }
}

// ── Fetch historical data from ThingsBoard ───────────────────
async function fetchAllData() {
  if (!jwtToken) await loginTB();
  if (!jwtToken) return;

  const endTs   = Date.now();
  const startTs = endTs - (30 * 24 * 60 * 60 * 1000);

  try {
    const res = await fetch(
      `${TB_HOST}/api/plugins/telemetry/DEVICE/${DEVICE_ID}/values/timeseries?keys=temperature,humidity&startTs=${startTs}&endTs=${endTs}&limit=50000`,
      { headers: { 'X-Authorization': `Bearer ${jwtToken}` } }
    );
    const tbData = await res.json();

    const historyMap = {};
    if (tbData.temperature) {
      tbData.temperature.forEach(item => {
        historyMap[item.ts] = { timestamp: new Date(item.ts).toISOString(), temp: parseFloat(item.value), hum: null };
      });
    }
    if (tbData.humidity) {
      tbData.humidity.forEach(item => {
        if (!historyMap[item.ts]) historyMap[item.ts] = { timestamp: new Date(item.ts).toISOString(), temp: null, hum: parseFloat(item.value) };
        else historyMap[item.ts].hum = parseFloat(item.value);
      });
    }

    allData = Object.values(historyMap).filter(r => r.temp !== null && r.hum !== null);
    allData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    document.getElementById('dataCount').textContent = allData.length;
    renderTodayCharts();
    updateStats();
  } catch (e) {
    console.warn('fetchAllData failed:', e.message);
  }
}

// ── Settings: Load from server ────────────────────────────────
async function loadSettings() {
  try {
    const res = await fetch(`${SERVER_URL}/api/settings`);
    if (!res.ok) throw new Error('Not OK');
    const data = await res.json();
    thresholds.temp       = data.tempThreshold ?? 35;
    thresholds.hum        = data.humThreshold  ?? 70;
    thresholds.recipients = data.recipients    ?? '';
    thresholds.senderEmail= data.senderEmail   ?? '';
    thresholds.appPassSet = data.appPassSet     ?? false;
    syncThresholdUI();
  } catch (e) {
    console.warn('Settings load failed, using defaults:', e.message);
    syncThresholdUI();
  }
}

// ── FIX: Single, complete syncThresholdUI — was defined twice before ──
function syncThresholdUI() {
  // Input values
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('thresholdTempInput', thresholds.temp);
  set('thresholdHumInput',  thresholds.hum);

  // Threshold badges in header
  const tb = document.getElementById('tempThresholdBadge');
  const hb = document.getElementById('humThresholdBadge');
  if (tb) tb.textContent = thresholds.temp + ' °C';
  if (hb) hb.textContent = thresholds.hum  + ' %';

  // Rebuild recipient chips from saved recipients
  initRecipientChips();

  // Force chart threshold lines to redraw
  if (chartTempToday)  chartTempToday.update();
  if (chartHumToday)   chartHumToday.update();
  if (chartTempDetail) chartTempDetail.update();
  if (chartHumDetail)  chartHumDetail.update();
}

// ── Settings: Save to server ──────────────────────────────────
async function saveThresholdSettings() {
  // Password gate
  const entered = prompt('🔒 Enter admin password to save settings:');
  if (entered === null) return;
  if (entered !== 'Rhmeter12345') {
    showToast('❌ Incorrect password', 'error');
    return;
  }

  const tempEl = document.getElementById('thresholdTempInput');
  const humEl  = document.getElementById('thresholdHumInput');
  if (!tempEl || !humEl) return showToast('Input fields not found', 'error');

  const tv = parseFloat(tempEl.value);
  const hv = parseFloat(humEl.value);
  if (isNaN(tv)) return showToast('Enter a valid temperature threshold', 'error');
  if (isNaN(hv)) return showToast('Enter a valid humidity threshold', 'error');

  // ✅ FIX: Read recipients from chip elements
  const chips = document.querySelectorAll('.recipient-chip');
  const recipientList = Array.from(chips).map(c => c.dataset.email).filter(Boolean).join(',');
  if (!recipientList) return showToast('Add at least one recipient email', 'error');

  const payload = {
    tempThreshold: tv,
    humThreshold:  hv,
    recipients:    recipientList
  };

  try {
    const res = await fetch(`${SERVER_URL}/api/settings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Server returned ' + res.status);

    // Update local thresholds object
    thresholds.temp       = tv;
    thresholds.hum        = hv;
    thresholds.recipients = recipientList;

    // ✅ FIX: syncThresholdUI updates badges + forces chart lines to redraw
    syncThresholdUI();

    // Re-render charts so threshold lines appear immediately
    renderTodayCharts();
    if (chartTempDetail) renderTempDetail();
    if (chartHumDetail)  renderHumDetail();

    showToast('✅ Settings saved!', 'success');

  } catch (e) {
    console.error('Save failed:', e.message);
    showToast('❌ Failed to save: ' + e.message, 'error');
  }
}

// ── Test Email ────────────────────────────────────────────────
// ✅ FIX: Reads chips correctly, saves to DB first, then sends test
async function sendTestEmail() {
  const chips = document.querySelectorAll('.recipient-chip');
  const recipientList = Array.from(chips).map(c => c.dataset.email).filter(Boolean).join(',');

  if (!recipientList) {
    return showToast('Add at least one recipient email first, then click Save Settings before testing', 'error');
  }

  // Disable buttons
  document.querySelectorAll('.btn-test-email').forEach(b => {
    b.disabled    = true;
    b.textContent = '📨 Sending...';
  });

  try {
    // Step 1: Make sure latest recipients are saved to DB
    const saveRes = await fetch(`${SERVER_URL}/api/settings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ recipients: recipientList })
    });
    if (!saveRes.ok) throw new Error('Could not save recipients to server');

    // Step 2: Send test email — pass recipients in body as well for immediate use
    const res = await fetch(`${SERVER_URL}/api/test-email`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ recipients: recipientList })
    });

    const json = await res.json().catch(() => ({}));

    if (res.ok && json.ok) {
      showToast('✅ Test email sent! Check your inbox.', 'success');
    } else {
      const errMsg = json.error || `Server error ${res.status}`;
      console.error('Test email failed:', errMsg);
      showToast('❌ Email failed: ' + errMsg, 'error');
    }

  } catch (e) {
    console.error('sendTestEmail error:', e);
    showToast('❌ Could not reach server: ' + e.message, 'error');
  } finally {
    document.querySelectorAll('.btn-test-email').forEach(b => {
      b.disabled    = false;
      b.textContent = '📨 Send Test Email';
    });
  }
}

// ── Chip UI ───────────────────────────────────────────────────
function initRecipientChips() {
  const container = document.getElementById('recipientChipsContainer');
  if (!container) return;
  container.innerHTML = '';
  if (thresholds.recipients) {
    thresholds.recipients.split(',').map(e => e.trim()).filter(Boolean).forEach(email => addChipToDOM(email));
  }
}

function addChipToDOM(email) {
  const container = document.getElementById('recipientChipsContainer');
  if (!container) return;
  const chip = document.createElement('div');
  chip.className     = 'recipient-chip';
  chip.dataset.email = email;
  chip.innerHTML     = `
    <span class="chip-email">✉️ ${email}</span>
    <button class="chip-remove" onclick="removeChip(this)" title="Remove">✕ Delete</button>
  `;
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

function removeChip(btn) {
  btn.closest('.recipient-chip').remove();
}

function handleRecipientKeydown(e) {
  if (e.key === 'Enter') { e.preventDefault(); addChip(); }
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  const old = document.getElementById('toastNotif');
  if (old) old.remove();
  const t = document.createElement('div');
  t.id = 'toastNotif';
  t.style.cssText = `
    position:fixed; bottom:28px; right:28px; z-index:9999;
    padding:14px 22px; border-radius:10px; font-size:0.875rem; font-weight:600;
    box-shadow:0 8px 32px rgba(0,0,0,0.15);
    background:${type === 'success' ? '#f0fdf4' : '#fff5f5'};
    color:${type === 'success' ? '#16a34a' : '#dc2626'};
    border:1px solid ${type === 'success' ? '#bbf7d0' : '#fca5a5'};
    transition: opacity 0.4s ease;
  `;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 3500);
}

// ── Dashboard stats ───────────────────────────────────────────
function updateStats() {
  const todayData = filterDate(dateStr(new Date()));
  const tempStats = stats(todayData, 'temp');
  const humStats  = stats(todayData, 'hum');
  document.getElementById('statMinTemp').textContent = tempStats.min;
  document.getElementById('statMaxTemp').textContent = tempStats.max;
  document.getElementById('statAvgTemp').textContent = tempStats.avg;
  document.getElementById('statMinHum').textContent  = humStats.min;
  document.getElementById('statMaxHum').textContent  = humStats.max;
  document.getElementById('statAvgHum').textContent  = humStats.avg;
}

// ── Threshold line plugin ─────────────────────────────────────
// ✅ FIX: Plugin reads from thresholds object at draw time — always current value
function makeThresholdPlugin(getVal, color) {
  return {
    id: 'thresholdLine_' + color,
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
      ctx.fillStyle    = color;
      ctx.font         = 'bold 11px Inter, sans-serif';
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`Threshold: ${value}°`, chartArea.right - 4, y - 3);
      ctx.restore();
    }
  };
}

const tempThresholdPlugin = makeThresholdPlugin(() => thresholds.temp, '#ef4444');
const humThresholdPlugin  = makeThresholdPlugin(() => thresholds.hum,  '#f59e0b');

// ── Chart base options ────────────────────────────────────────
const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 400 },
  plugins: { legend: { display: false } },
  scales: {
    x: { grid: { color: '#e2e8f0' }, ticks: { color: '#64748b', maxRotation: 0 } },
    y: { grid: { color: '#e2e8f0' }, ticks: { color: '#64748b' }, beginAtZero: false }
  }
};

// ── Init charts ───────────────────────────────────────────────
function initCharts() {
  chartTempToday = new Chart(document.getElementById('chartTempToday').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [], borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.1)',
        fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2
      }]
    },
    plugins: [tempThresholdPlugin],
    options: chartOptions
  });

  chartHumToday = new Chart(document.getElementById('chartHumToday').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [], borderColor: '#06b6d4',
        backgroundColor: 'rgba(6,182,212,0.1)',
        fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2
      }]
    },
    plugins: [humThresholdPlugin],
    options: chartOptions
  });
}

// ── Render today's dashboard charts ──────────────────────────
function renderTodayCharts() {
  if (!chartTempToday || !chartHumToday) return;
  const data30 = bucket30min(filterDate(dateStr(new Date())));

  chartTempToday.data.labels           = data30.map(b => b.label);
  chartTempToday.data.datasets[0].data = data30.map(b => b.temp);
  chartTempToday.update();   // ✅ threshold line redraws here

  chartHumToday.data.labels            = data30.map(b => b.label);
  chartHumToday.data.datasets[0].data  = data30.map(b => b.hum);
  chartHumToday.update();
}

// ── Navigation ────────────────────────────────────────────────
function showDetailPage(type) {
  document.getElementById('dashboardView').style.display = 'none';
  if (type === 'temperature') {
    document.getElementById('temperatureDetail').classList.add('active');
    const today = dateStr(new Date());
    document.getElementById('tempDateFrom').value = today;
    document.getElementById('tempDateTo').value   = today;
    renderTempDetail();
  } else if (type === 'humidity') {
    document.getElementById('humidityDetail').classList.add('active');
    const today = dateStr(new Date());
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

// ── Temperature Detail ────────────────────────────────────────
function setTodayTemp() {
  const today = dateStr(new Date());
  document.getElementById('tempDateFrom').value = today;
  document.getElementById('tempDateTo').value   = today;
  renderTempDetail();
}

function renderTempDetail() {
  const from      = document.getElementById('tempDateFrom').value;
  const to        = document.getElementById('tempDateTo').value;
  const subset    = filterRange(from, to);
  const isSameDay = from === to;

  const s = stats(subset, 'temp');
  document.getElementById('tempDetailMin').textContent = s.min;
  document.getElementById('tempDetailMax').textContent = s.max;
  document.getElementById('tempDetailAvg').textContent = s.avg;

  if (chartTempDetail) chartTempDetail.destroy();
  const oldTable = document.getElementById('tempDayTable');
  if (oldTable) oldTable.remove();

  if (isSameDay) {
    document.getElementById('tempChartTitle').textContent = '📈 Temperature - Single Day';
    const bucketed = bucket5min(subset);
    chartTempDetail = new Chart(document.getElementById('chartTempDetail').getContext('2d'), {
      type: 'line',
      data: {
        labels: bucketed.map(b => b.label),
        datasets: [{ label: 'Temperature (°C)', data: bucketed.map(b => b.temp),
          borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)',
          fill: true, tension: 0.4, pointRadius: 2, borderWidth: 2 }]
      },
      plugins: [tempThresholdPlugin],
      options: { ...chartOptions, plugins: { legend: { display: true, labels: { color: '#475569' } } } }
    });
  } else {
    document.getElementById('tempChartTitle').textContent = '📊 Temperature - Daily Summary';
    const days = groupByDay(subset);
    const tableHTML = `
      <div id="tempDayTable" style="overflow-x:auto;margin-top:20px;">
        <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
          <thead><tr style="background:#f1f5f9;">
            <th style="padding:10px 16px;text-align:left;border:1px solid #e2e8f0;color:#475569;">Date</th>
            <th style="padding:10px 16px;text-align:center;border:1px solid #e2e8f0;color:#3b82f6;">Avg (°C)</th>
            <th style="padding:10px 16px;text-align:center;border:1px solid #e2e8f0;color:#10b981;">Min (°C)</th>
            <th style="padding:10px 16px;text-align:center;border:1px solid #e2e8f0;color:#ef4444;">Max (°C)</th>
          </tr></thead>
          <tbody>${days.map(d => `
            <tr>
              <td style="padding:10px 16px;border:1px solid #e2e8f0;font-weight:600;">${d.date}</td>
              <td style="padding:10px 16px;border:1px solid #e2e8f0;text-align:center;color:#3b82f6;font-weight:700;">${d.tempAvg}</td>
              <td style="padding:10px 16px;border:1px solid #e2e8f0;text-align:center;color:#10b981;font-weight:700;">${d.tempMin}</td>
              <td style="padding:10px 16px;border:1px solid #e2e8f0;text-align:center;color:#ef4444;font-weight:700;">${d.tempMax}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    document.querySelector('#temperatureDetail .chart-section').insertAdjacentHTML('beforeend', tableHTML);
    chartTempDetail = new Chart(document.getElementById('chartTempDetail').getContext('2d'), {
      type: 'bar',
      data: {
        labels: days.map(d => d.date),
        datasets: [
          { label: 'Average', data: days.map(d => d.tempAvg), backgroundColor: 'rgba(59,130,246,0.6)',  borderColor: '#3b82f6', borderWidth: 2, borderRadius: 6 },
          { label: 'Min',     data: days.map(d => d.tempMin), backgroundColor: 'rgba(16,185,129,0.4)',  borderColor: '#10b981', borderWidth: 1, borderRadius: 6 },
          { label: 'Max',     data: days.map(d => d.tempMax), backgroundColor: 'rgba(239,68,68,0.4)',   borderColor: '#ef4444', borderWidth: 1, borderRadius: 6 }
        ]
      },
      plugins: [tempThresholdPlugin],
      options: { ...chartOptions, plugins: { legend: { display: true, labels: { color: '#475569' } } } }
    });
  }
}

// ── Humidity Detail ───────────────────────────────────────────
function setTodayHum() {
  const today = dateStr(new Date());
  document.getElementById('humDateFrom').value = today;
  document.getElementById('humDateTo').value   = today;
  renderHumDetail();
}

function renderHumDetail() {
  const from      = document.getElementById('humDateFrom').value;
  const to        = document.getElementById('humDateTo').value;
  const subset    = filterRange(from, to);
  const isSameDay = from === to;

  const s = stats(subset, 'hum');
  document.getElementById('humDetailMin').textContent = s.min;
  document.getElementById('humDetailMax').textContent = s.max;
  document.getElementById('humDetailAvg').textContent = s.avg;

  if (chartHumDetail) chartHumDetail.destroy();
  const oldTable = document.getElementById('humDayTable');
  if (oldTable) oldTable.remove();

  if (isSameDay) {
    document.getElementById('humChartTitle').textContent = '💧 Humidity - Single Day';
    const bucketed = bucket5min(subset);
    chartHumDetail = new Chart(document.getElementById('chartHumDetail').getContext('2d'), {
      type: 'line',
      data: {
        labels: bucketed.map(b => b.label),
        datasets: [{ label: 'Humidity (%)', data: bucketed.map(b => b.hum),
          borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,0.1)',
          fill: true, tension: 0.4, pointRadius: 2, borderWidth: 2 }]
      },
      plugins: [humThresholdPlugin],
      options: { ...chartOptions, plugins: { legend: { display: true, labels: { color: '#475569' } } } }
    });
  } else {
    document.getElementById('humChartTitle').textContent = '📊 Humidity - Daily Summary';
    const days = groupByDay(subset);
    const tableHTML = `
      <div id="humDayTable" style="overflow-x:auto;margin-top:20px;">
        <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
          <thead><tr style="background:#f1f5f9;">
            <th style="padding:10px 16px;text-align:left;border:1px solid #e2e8f0;color:#475569;">Date</th>
            <th style="padding:10px 16px;text-align:center;border:1px solid #e2e8f0;color:#06b6d4;">Avg (%)</th>
            <th style="padding:10px 16px;text-align:center;border:1px solid #e2e8f0;color:#10b981;">Min (%)</th>
            <th style="padding:10px 16px;text-align:center;border:1px solid #e2e8f0;color:#ef4444;">Max (%)</th>
          </tr></thead>
          <tbody>${days.map(d => `
            <tr>
              <td style="padding:10px 16px;border:1px solid #e2e8f0;font-weight:600;">${d.date}</td>
              <td style="padding:10px 16px;border:1px solid #e2e8f0;text-align:center;color:#06b6d4;font-weight:700;">${d.humAvg}</td>
              <td style="padding:10px 16px;border:1px solid #e2e8f0;text-align:center;color:#10b981;font-weight:700;">${d.humMin}</td>
              <td style="padding:10px 16px;border:1px solid #e2e8f0;text-align:center;color:#ef4444;font-weight:700;">${d.humMax}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    document.querySelector('#humidityDetail .chart-section').insertAdjacentHTML('beforeend', tableHTML);
    chartHumDetail = new Chart(document.getElementById('chartHumDetail').getContext('2d'), {
      type: 'bar',
      data: {
        labels: days.map(d => d.date),
        datasets: [
          { label: 'Average', data: days.map(d => d.humAvg), backgroundColor: 'rgba(6,182,212,0.6)',   borderColor: '#06b6d4', borderWidth: 2, borderRadius: 6 },
          { label: 'Min',     data: days.map(d => d.humMin), backgroundColor: 'rgba(16,185,129,0.4)',  borderColor: '#10b981', borderWidth: 1, borderRadius: 6 },
          { label: 'Max',     data: days.map(d => d.humMax), backgroundColor: 'rgba(239,68,68,0.4)',   borderColor: '#ef4444', borderWidth: 1, borderRadius: 6 }
        ]
      },
      plugins: [humThresholdPlugin],
      options: { ...chartOptions, plugins: { legend: { display: true, labels: { color: '#475569' } } } }
    });
  }
}

// ── Date-picker listeners ─────────────────────────────────────
document.getElementById('tempDateFrom').addEventListener('change', renderTempDetail);
document.getElementById('tempDateTo').addEventListener('change',   renderTempDetail);
document.getElementById('humDateFrom').addEventListener('change',  renderHumDetail);
document.getElementById('humDateTo').addEventListener('change',    renderHumDetail);

// ── Export ────────────────────────────────────────────────────
function setExportToday() {
  const today = dateStr(new Date());
  document.getElementById('exportDateFrom').value = today;
  document.getElementById('exportDateTo').value   = today;
}

function exportExcelFiltered() {
  const from = document.getElementById('exportDateFrom').value;
  const to   = document.getElementById('exportDateTo').value;
  if (!from || !to) return alert('Please select a From and To date.');
  const filtered = filterRange(from, to);
  if (!filtered.length) return alert(`No data found between ${from} and ${to}.`);
  const rows = [['Timestamp', 'Temperature (°C)', 'Humidity (%)']];
  filtered.forEach(r => rows.push([r.timestamp, r.temp, r.hum]));
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 24 }, { wch: 22 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'SensorData');
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob  = new Blob([wbout], { type: 'application/octet-stream' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href = url; a.download = `FactoryMonitor_${from}_to_${to}.xlsx`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function exportCSVFiltered() {
  const from = document.getElementById('exportDateFrom').value;
  const to   = document.getElementById('exportDateTo').value;
  if (!from || !to) return alert('Please select a From and To date.');
  const filtered = filterRange(from, to);
  if (!filtered.length) return alert(`No data found between ${from} and ${to}.`);
  let csv = "Timestamp,Temperature (°C),Humidity (%)\n";
  filtered.forEach(r => { csv += `${r.timestamp},${r.temp},${r.hum}\n`; });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `FactoryMonitor_${from}_to_${to}.csv`; a.click();
}

function exportCSV() {
  if (!allData.length) return alert('No data yet.');
  let csv = "Timestamp,Temperature (°C),Humidity (%)\n";
  allData.forEach(r => { csv += r.timestamp + ',' + r.temp + ',' + r.hum + '\n'; });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'sensor_log_' + dateStr(new Date()) + '.csv'; a.click();
}

function exportExcel() {
  if (!allData.length) return alert('No data yet.');
  const rows = [['Timestamp', 'Temperature (°C)', 'Humidity (%)']];
  allData.forEach(r => rows.push([r.timestamp, r.temp, r.hum]));
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 24 }, { wch: 22 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'SensorData');
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob  = new Blob([wbout], { type: 'application/octet-stream' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href = url; a.download = 'FactoryMonitor_' + dateStr(new Date()) + '.xlsx';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── Meter Switch ──────────────────────────────────────────────
function switchMeter() {
  fetchAllData();
  fetchCurrent();
}

// ── Midnight reset ────────────────────────────────────────────
function scheduleMidnightReset() {
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  setTimeout(() => {
    renderTodayCharts();
    updateStats();
    scheduleMidnightReset();
  }, next - now);
}

// ── Threshold panel toggle ────────────────────────────────────
function toggleThresholdPanel(id) {
  const body = document.getElementById(id);
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  const btn = body.previousElementSibling?.querySelector('.threshold-toggle');
  if (btn) btn.textContent = open ? '▼ Configure' : '▲ Close';
}

// ── Bootstrap ─────────────────────────────────────────────────
scheduleMidnightReset();
initCharts();

loadSettings().then(() => {
  fetchCurrent();
  fetchAllData();
});

setExportToday();
setInterval(fetchCurrent,  2000);
setInterval(fetchAllData, 10000);