// ============================================================
//  Factory Monitor Pro — app.js
//  Data source: HiveMQ Cloud → server.js → /api/data
//  (ThingsBoard removed)
// ============================================================
const SERVER_URL = 'https://rh-meter-bridge.onrender.com';

// const SERVER_URL = 'http://localhost:3001';

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
function dateStr(d) { return d.toISOString().slice(0, 10); }  // ← Fix 2: UTC-based

function filterDate(ds)       { return allData.filter(r => dateStr(new Date(r.timestamp)) === ds); }
function filterRange(from,to) { return allData.filter(r => { const d = dateStr(new Date(r.timestamp)); return d >= from && d <= to; }); }

function toIST(d) {
  // Add 5 hours 30 minutes to UTC to get IST
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
//  STATUS BADGE
// ════════════════════════════════════════════════════════════
function updateStatusBadge(isOnline) {
  const badge = document.getElementById('statusBadge');
  const text  = document.getElementById('statusText');
  if (!badge || !text) return;
  badge.classList.toggle('offline', !isOnline);
  text.textContent = isOnline ? 'Online' : 'Offline';
}

// ════════════════════════════════════════════════════════════
//  FETCH CURRENT READING  ← now from /api/data (not ThingsBoard)
// ════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════
//  FETCH CURRENT READING (Optimized for HiveMQ)
// ════════════════════════════════════════════════════════════
async function fetchCurrent() {
  try {
    const deviceId = document.getElementById('meterSelect')?.value || 'Meter_02';
    // Added _t parameter to prevent browser caching
    const res = await fetch(`${SERVER_URL}/api/data?deviceId=${deviceId}&_t=${Date.now()}`);

    if (!res.ok) throw new Error('Server returned ' + res.status);

    const d = await res.json();
    
    // IMPORTANT: Check for 'temperature' OR 'temp' depending on your JSON structure
    const t = d.temperature !== undefined ? parseFloat(d.temperature) : (d.temp !== undefined ? parseFloat(d.temp) : null);
    const h = d.humidity !== undefined ? parseFloat(d.humidity) : (d.hum !== undefined ? parseFloat(d.hum) : null);

    if (t === null || h === null) {
      console.warn('[fetchCurrent] No valid data in response for:', deviceId);
      updateStatusBadge(false);
      return;
    }

    failCount = 0;
    updateStatusBadge(true);

    // Update UI
    document.getElementById('tempValue').textContent = t.toFixed(1);
    document.getElementById('humValue').textContent = h.toFixed(1);

    // Trend Logic
    if (lastTemp !== null) {
      const diff = t - lastTemp;
      document.getElementById('tempTrend').textContent = diff > 0.1 ? '↑' : diff < -0.1 ? '↓' : '→';
    }
    lastTemp = t;
    lastHum = h;

  } catch (err) {
    failCount++;
    if (failCount >= 3) updateStatusBadge(false);
    console.warn('[fetchCurrent] Error:', err.message);
  }
}


async function fetchRangeData(from, to) {
  try {
    const deviceId = document.getElementById('meterSelect')?.value || 'Meter_02';
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
//  FETCH HISTORY (HiveMQ Optimized)
// ════════════════════════════════════════════════════════════
async function fetchAllData() {
  try {
    const deviceId = document.getElementById('meterSelect')?.value || 'Meter_02';
    
    // Use today's UTC date by default
    const today = new Date().toISOString().slice(0, 10);
    const from  = today;
    const to    = today;

    const res = await fetch(
      `${SERVER_URL}/api/history?deviceId=${deviceId}&from=${from}&to=${to}&_t=${Date.now()}`
    );
    if (!res.ok) throw new Error('History fetch failed: ' + res.status);
    const records = await res.json();

    allData = records.map(r => ({
      timestamp: r.timestamp,
      temp: r.temperature !== undefined ? r.temperature : r.temp,
      hum:  r.humidity    !== undefined ? r.humidity    : r.hum
    })).filter(r => r.temp != null && r.hum != null);

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

  [chartTempToday, chartHumToday, chartTempDetail, chartHumDetail].forEach(c => { if (c) c.update('none'); });
}

async function saveThresholdSettings() {
  const entered = prompt('🔒 Enter admin password to save settings:');
  if (entered === null) return;
  if (entered !== 'Rhmeter12345') { showToast('❌ Incorrect password', 'error'); return; }

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
//  STATS
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
//  CHART BASE OPTIONS
// ════════════════════════════════════════════════════════════
const chartOptions = {
  responsive: true, maintainAspectRatio: false,
  animation: { duration: 400 },
  plugins: { legend: { display: false } },
  scales: {
    x: { grid: { color: '#e2e8f0' }, ticks: { color: '#64748b', maxRotation: 0 } },
    y: { grid: { color: '#e2e8f0' }, ticks: { color: '#64748b' }, beginAtZero: false }
  }
};

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
  if (!tempCanvas || !humCanvas) { console.warn('Chart canvases not found'); return; }

  chartTempToday = new Chart(tempCanvas.getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }] },
    plugins: [tempThresholdPlugin],
    options: chartOptions
  });

  chartHumToday = new Chart(humCanvas.getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,0.1)', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }] },
    plugins: [humThresholdPlugin],
    options: chartOptions
  });
}

// ════════════════════════════════════════════════════════════
//  RENDER TODAY CHARTS
// ════════════════════════════════════════════════════════════
function renderTodayCharts() {
  if (!chartTempToday || !chartHumToday) return;
  const data = bucket30min(filterDate(dateStr(new Date())));

  chartTempToday.data.labels           = data.map(b => b.label);
  chartTempToday.data.datasets[0].data = data.map(b => b.temp);
  chartTempToday.update();

  chartHumToday.data.labels            = data.map(b => b.label);
  chartHumToday.data.datasets[0].data  = data.map(b => b.hum);
  chartHumToday.update();
}

// ════════════════════════════════════════════════════════════
//  NAVIGATION
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
  const from   = document.getElementById('tempDateFrom').value;
  const to     = document.getElementById('tempDateTo').value;
  const subset = await fetchRangeData(from, to);         // ← fetch from server
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
      options: { ...chartOptions, plugins: { legend: { display: true, labels: { color:'#475569' } } } }
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
        { label:'Average', data: days.map(d=>d.tempAvg), backgroundColor:'rgba(59,130,246,0.6)',  borderColor:'#3b82f6', borderWidth:2, borderRadius:6 },
        { label:'Min',     data: days.map(d=>d.tempMin), backgroundColor:'rgba(16,185,129,0.4)',  borderColor:'#10b981', borderWidth:1, borderRadius:6 },
        { label:'Max',     data: days.map(d=>d.tempMax), backgroundColor:'rgba(239,68,68,0.4)',   borderColor:'#ef4444', borderWidth:1, borderRadius:6 }
      ]},
      plugins: [tempThresholdPlugin],
      options: { ...chartOptions, plugins: { legend: { display: true, labels: { color:'#475569' } } } }
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
  const from   = document.getElementById('humDateFrom').value;
  const to     = document.getElementById('humDateTo').value;
  const subset = await fetchRangeData(from, to);         // ← fetch from server
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
      options: { ...chartOptions, plugins: { legend: { display: true, labels: { color:'#475569' } } } }
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
        { label:'Average', data: days.map(d=>d.humAvg), backgroundColor:'rgba(6,182,212,0.6)',   borderColor:'#06b6d4', borderWidth:2, borderRadius:6 },
        { label:'Min',     data: days.map(d=>d.humMin), backgroundColor:'rgba(16,185,129,0.4)',  borderColor:'#10b981', borderWidth:1, borderRadius:6 },
        { label:'Max',     data: days.map(d=>d.humMax), backgroundColor:'rgba(239,68,68,0.4)',   borderColor:'#ef4444', borderWidth:1, borderRadius:6 }
      ]},
      plugins: [humThresholdPlugin],
      options: { ...chartOptions, plugins: { legend: { display: true, labels: { color:'#475569' } } } }
    });
  }
}

// ════════════════════════════════════════════════════════════
//  EXPORT
// ════════════════════════════════════════════════════════════
function setExportToday() {
  const today = dateStr(new Date());
  document.getElementById('exportDateFrom').value = today;
  document.getElementById('exportDateTo').value   = today;
}

function exportExcelFiltered() {
  const from = document.getElementById('exportDateFrom').value;
  const to   = document.getElementById('exportDateTo').value;
  if (!from || !to) return alert('Please select a date range.');
  const filtered = filterRange(from, to);
  if (!filtered.length) return alert(`No data between ${from} and ${to}.`);
  const rows = [['Timestamp','Temperature (°C)','Humidity (%)']];
  filtered.forEach(r => rows.push([r.timestamp, r.temp, r.hum]));
  const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = [{wch:24},{wch:22},{wch:20}];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'SensorData');
  const url = URL.createObjectURL(new Blob([XLSX.write(wb,{bookType:'xlsx',type:'array'})], {type:'application/octet-stream'}));
  const a = Object.assign(document.createElement('a'), {href:url, download:`FactoryMonitor_${from}_to_${to}.xlsx`});
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

function exportCSVFiltered() {
  const from = document.getElementById('exportDateFrom').value;
  const to   = document.getElementById('exportDateTo').value;
  if (!from || !to) return alert('Please select a date range.');
  const filtered = filterRange(from, to);
  if (!filtered.length) return alert(`No data between ${from} and ${to}.`);
  let csv = "Timestamp,Temperature (°C),Humidity (%)\n";
  filtered.forEach(r => { csv += `${r.timestamp},${r.temp},${r.hum}\n`; });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv],{type:'text/csv'})), download:`FactoryMonitor_${from}_to_${to}.csv` });
  a.click();
}

function exportCSV() {
  if (!allData.length) return alert('No data yet.');
  let csv = "Timestamp,Temperature (°C),Humidity (%)\n";
  allData.forEach(r => { csv += `${r.timestamp},${r.temp},${r.hum}\n`; });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv],{type:'text/csv'})), download:'sensor_log_'+dateStr(new Date())+'.csv' });
  a.click();
}

function exportExcel() {
  if (!allData.length) return alert('No data yet.');
  const rows = [['Timestamp','Temperature (°C)','Humidity (%)']];
  allData.forEach(r => rows.push([r.timestamp, r.temp, r.hum]));
  const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = [{wch:24},{wch:22},{wch:20}];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'SensorData');
  const url = URL.createObjectURL(new Blob([XLSX.write(wb,{bookType:'xlsx',type:'array'})],{type:'application/octet-stream'}));
  const a = Object.assign(document.createElement('a'), {href:url, download:'FactoryMonitor_'+dateStr(new Date())+'.xlsx'});
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ════════════════════════════════════════════════════════════
//  MISC
// ════════════════════════════════════════════════════════════
function switchMeter() { fetchAllData(); fetchCurrent(); }

function toggleThresholdPanel(id) {
  const body = document.getElementById(id);
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  const btn = body.previousElementSibling?.querySelector('.threshold-toggle');
  if (btn) btn.textContent = open ? '▼ Configure' : '▲ Close';
}

function scheduleMidnightReset() {
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0, 0, 5);
  setTimeout(() => { renderTodayCharts(); updateStats(); scheduleMidnightReset(); }, next - now);
}

// ════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
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

setInterval(fetchCurrent,  10000);   // every 10 seconds — keep as is
setInterval(fetchAllData,  60000);   // every 1 minute — fetch fresh history
});