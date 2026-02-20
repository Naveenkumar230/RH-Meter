// ============================================================
//  Factory Monitor Pro — main.js
//  Depends on: Chart.js 4.4.0, SheetJS (xlsx.full.min.js)
// ============================================================

let allData    = [];
let chartTempToday  = null;
let chartHumToday   = null;
let chartTempDetail = null;
let chartHumDetail  = null;
let failCount  = 0;
let lastTemp   = null;
let lastHum    = null;

// ── Utility ──────────────────────────────────────────────────
function pad(n)      { return n < 10 ? '0' + n : '' + n; }
function dateStr(d)  { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function timeLabel(ts) {
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function filterDate(ds) {
  return allData.filter(r => dateStr(new Date(r.timestamp)) === ds);
}

function filterRange(from, to) {
  return allData.filter(r => {
    const d = dateStr(new Date(r.timestamp));
    return d >= from && d <= to;
  });
}

/** Average readings into 1-hour buckets */
function bucketHourly(arr) {
  const map = {};
  arr.forEach(r => {
    const d = new Date(r.timestamp);
    const key = dateStr(d) + ' ' + pad(d.getHours()) + ':00';
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

/** Average readings into 30-minute buckets for graph display */
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

/** Aggregate data by calendar day */
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

/** Min / Max / Avg for a field across an array of records */
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
  if (isOnline) {
    badge.classList.remove('offline');
    text.textContent = 'Online';
  } else {
    badge.classList.add('offline');
    text.textContent = 'Offline';
  }
}

// // ── Fetch: current reading ────────────────────────────────────
// function fetchCurrent() {
//   fetch('/api/current')
//     .then(r => r.json())
//     .then(d => {
//       failCount = 0;
//       updateStatusBadge(true);

//       // Temperature
//       const temp = d.temp;
//       document.getElementById('tempValue').textContent = temp.toFixed(1);

//       if (lastTemp !== null) {
//         if (temp > lastTemp + 0.2) {
//           document.getElementById('tempTrend').textContent     = '↑';
//           document.getElementById('tempTrendText').textContent = 'Rising';
//         } else if (temp < lastTemp - 0.2) {
//           document.getElementById('tempTrend').textContent     = '↓';
//           document.getElementById('tempTrendText').textContent = 'Falling';
//         } else {
//           document.getElementById('tempTrend').textContent     = '→';
//           document.getElementById('tempTrendText').textContent = 'Stable';
//         }
//       }
//       lastTemp = temp;

//       const tempStatus = document.getElementById('tempStatus');
//       tempStatus.className   = 'status-badge-inline status-' + d.tempLevel;
//       tempStatus.textContent = d.tempLevel.charAt(0).toUpperCase() + d.tempLevel.slice(1);

//       // Humidity
//       const hum = d.hum;
//       document.getElementById('humValue').textContent = hum.toFixed(1);

//       if (lastHum !== null) {
//         if (hum > lastHum + 0.5) {
//           document.getElementById('humTrend').textContent     = '↑';
//           document.getElementById('humTrendText').textContent = 'Rising';
//         } else if (hum < lastHum - 0.5) {
//           document.getElementById('humTrend').textContent     = '↓';
//           document.getElementById('humTrendText').textContent = 'Falling';
//         } else {
//           document.getElementById('humTrend').textContent     = '→';
//           document.getElementById('humTrendText').textContent = 'Stable';
//         }
//       }
//       lastHum = hum;

//       const humStatus = document.getElementById('humStatus');
//       humStatus.className   = 'status-badge-inline status-' + d.humLevel;
//       humStatus.textContent = d.humLevel.charAt(0).toUpperCase() + d.humLevel.slice(1);
//     })
//     .catch(() => {
//       failCount++;
//       if (failCount >= 3) updateStatusBadge(false);
//     });
// }

// // ── Fetch: historical data ────────────────────────────────────
// function fetchAllData() {
//   fetch('/api/all-data')
//     .then(r => r.json())
//     .then(data => {
//       allData = data;
//       document.getElementById('dataCount').textContent = data.length;
//       renderTodayCharts();
//       updateStats();
//     })
//     .catch(() => {});
// }

// ── THINGSBOARD CLOUD CONNECTION ──────────────────────────────
// ── THINGSBOARD CLOUD CONNECTION ──────────────────────────────
const TB_HOST = "https://thingsboard.cloud";
const DEVICE_ID = "b2829b00-0c8a-11f1-b5a7-93241ed57bdc"; 
const TB_USER = "naveenkumarak2002@gmail.com"; 
const TB_PASS = "Naveen235623@@@"; 
let jwtToken = null;

async function loginTB() {
    try {
        console.log("Attempting to login with:", TB_USER); // Debugging line
        let res = await fetch(`${TB_HOST}/api/auth/login`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json' 
            },
            body: JSON.stringify({ 
                username: TB_USER.trim(), // .trim() removes any accidental spaces
                password: TB_PASS.trim() 
            })
        });

        if (res.status === 401) {
            console.error("❌ Login Rejected: Check if your email/password in app.js has a typo.");
            return;
        }

        let data = await res.json();
        jwtToken = data.token;
        console.log("✅ Login Successful! Token received.");
    } catch (e) { 
        console.error("❌ Network Error during login:", e); 
    }
}

// Helper to calculate status levels
function getTempLevel(t) { return t <= 27.0 ? 'normal' : (t <= 35.0 ? 'warning' : 'critical'); }
function getHumLevel(h) { return h < 40.0 ? 'critical' : (h <= 70.0 ? 'normal' : 'warning'); }

// ── Fetch: current reading from Cloud ─────────────────────────
async function fetchCurrent() {
    if (!jwtToken) await loginTB();
    if (!jwtToken) return;

    fetch(`${TB_HOST}/api/plugins/telemetry/DEVICE/${DEVICE_ID}/values/timeseries?keys=temperature,humidity`, {
        headers: { 'X-Authorization': `Bearer ${jwtToken}` }
    })
    .then(r => r.json())
    .then(tbData => {
        failCount = 0;
        updateStatusBadge(true);

        if(!tbData.temperature || !tbData.humidity) return;

        // Reconstruct your original 'd' object format
        let t = parseFloat(tbData.temperature[0].value);
        let h = parseFloat(tbData.humidity[0].value);
        let d = { temp: t, hum: h, tempLevel: getTempLevel(t), humLevel: getHumLevel(h) };

        // --- Temperature Updates ---
        document.getElementById('tempValue').textContent = d.temp.toFixed(1);
        if (lastTemp !== null) {
            if (d.temp > lastTemp + 0.2) {
                document.getElementById('tempTrend').textContent = '↑';
                document.getElementById('tempTrendText').textContent = 'Rising';
            } else if (d.temp < lastTemp - 0.2) {
                document.getElementById('tempTrend').textContent = '↓';
                document.getElementById('tempTrendText').textContent = 'Falling';
            } else {
                document.getElementById('tempTrend').textContent = '→';
                document.getElementById('tempTrendText').textContent = 'Stable';
            }
        }
        lastTemp = d.temp;
        const tempStatus = document.getElementById('tempStatus');
        tempStatus.className = 'status-badge-inline status-' + d.tempLevel;
        tempStatus.textContent = d.tempLevel.charAt(0).toUpperCase() + d.tempLevel.slice(1);

        // --- Humidity Updates ---
        document.getElementById('humValue').textContent = d.hum.toFixed(1);
        if (lastHum !== null) {
            if (d.hum > lastHum + 0.5) {
                document.getElementById('humTrend').textContent = '↑';
                document.getElementById('humTrendText').textContent = 'Rising';
            } else if (d.hum < lastHum - 0.5) {
                document.getElementById('humTrend').textContent = '↓';
                document.getElementById('humTrendText').textContent = 'Falling';
            } else {
                document.getElementById('humTrend').textContent = '→';
                document.getElementById('humTrendText').textContent = 'Stable';
            }
        }
        lastHum = d.hum;
        const humStatus = document.getElementById('humStatus');
        humStatus.className = 'status-badge-inline status-' + d.humLevel;
        humStatus.textContent = d.humLevel.charAt(0).toUpperCase() + d.humLevel.slice(1);
    })
    .catch(() => {
        failCount++;
        if (failCount >= 3) {
            updateStatusBadge(false);
            jwtToken = null; // force re-login
        }
    });
}

function fetchAllData() {
  if (!jwtToken) return;

  // Fetch last 30 days so date-range filter always has data
  const endTs   = Date.now();
  const startTs = endTs - (30 * 24 * 60 * 60 * 1000);

  fetch(`${TB_HOST}/api/plugins/telemetry/DEVICE/${DEVICE_ID}/values/timeseries?keys=temperature,humidity&startTs=${startTs}&endTs=${endTs}&limit=50000`, {
    headers: { 'X-Authorization': `Bearer ${jwtToken}` }
  })
  .then(r => r.json())
  .then(tbData => {
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
  })
  .catch(() => {});
}

// ── Dashboard stats ───────────────────────────────────────────
function updateStats() {
  const todayData = filterDate(dateStr(new Date()));
  const tempStats = stats(todayData, 'temp');
  const humStats  = stats(todayData, 'hum');

  document.getElementById('statMinTemp').textContent = tempStats.min;
  document.getElementById('statMaxTemp').textContent = tempStats.max;
  document.getElementById('statAvgTemp').textContent = tempStats.avg;

  document.getElementById('statMinHum').textContent = humStats.min;
  document.getElementById('statMaxHum').textContent = humStats.max;
  document.getElementById('statAvgHum').textContent = humStats.avg;
}

// ── Shared Chart Options ──────────────────────────────────────
const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 400 },
  plugins: { legend: { display: false } },
  scales: {
    x: {
      grid:  { color: '#e2e8f0' },
      ticks: { color: '#64748b', maxRotation: 0 }
    },
    y: {
      grid:  { color: '#e2e8f0' },
      ticks: { color: '#64748b' },
      beginAtZero: false
    }
  }
};

// ── Chart Initialisation ──────────────────────────────────────
function initCharts() {
  chartTempToday = new Chart(document.getElementById('chartTempToday').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2
      }]
    },
    options: chartOptions
  });

  chartHumToday = new Chart(document.getElementById('chartHumToday').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6, 182, 212, 0.1)',
        fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2
      }]
    },
    options: chartOptions
  });
}

// ── Today's Dashboard Charts ──────────────────────────────────
function renderTodayCharts() {
  const data30 = bucket30min(filterDate(dateStr(new Date())));

  chartTempToday.data.labels           = data30.map(b => b.label);
  chartTempToday.data.datasets[0].data = data30.map(b => b.temp);
  chartTempToday.update();

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

// ── Temperature Detail Page ───────────────────────────────────
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

  const tempStats = stats(subset, 'temp');
  // Average first, then Min, then Max
  document.getElementById('tempDetailAvg').textContent = tempStats.avg;
  document.getElementById('tempDetailMin').textContent = tempStats.min;
  document.getElementById('tempDetailMax').textContent = tempStats.max;

  if (chartTempDetail) chartTempDetail.destroy();

  const oldTable = document.getElementById('tempDayTable');
  if (oldTable) oldTable.remove();

  if (isSameDay) {
    document.getElementById('tempChartTitle').textContent = '📈 Temperature - Single Day (30 min avg)';
    const bucketed = bucket30min(subset);
    chartTempDetail = new Chart(document.getElementById('chartTempDetail').getContext('2d'), {
      type: 'line',
      data: {
        labels: bucketed.map(b => b.label),
        datasets: [{
          label: 'Temperature (°C)',
          data: bucketed.map(b => b.temp),
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          fill: true, tension: 0.4, pointRadius: 3, borderWidth: 2
        }]
      },
      options: { ...chartOptions, plugins: { legend: { display: true, labels: { color: '#475569' } } } }
    });
  } else {
    document.getElementById('tempChartTitle').textContent = '📊 Temperature - Daily Summary';
    const days = groupByDay(subset);

    const tableHTML = `
      <div id="tempDayTable" style="overflow-x:auto; margin-top:20px; display:flex; justify-content:center;">
        <table style="width:80%; border-collapse:collapse; font-family:'Inter',sans-serif; font-size:0.875rem; text-align:center;">
          <thead>
            <tr style="background:#f1f5f9;">
              <th style="padding:10px 16px; border:1px solid #e2e8f0; color:#475569;">Date</th>
              <th style="padding:10px 16px; border:1px solid #e2e8f0; color:#3b82f6;">Avg (°C)</th>
              <th style="padding:10px 16px; border:1px solid #e2e8f0; color:#10b981;">Min (°C)</th>
              <th style="padding:10px 16px; border:1px solid #e2e8f0; color:#ef4444;">Max (°C)</th>
            </tr>
          </thead>
          <tbody>
            ${days.map(d => `
              <tr>
                <td style="padding:10px 16px; border:1px solid #e2e8f0; font-weight:600;">${d.date}</td>
                <td style="padding:10px 16px; border:1px solid #e2e8f0; color:#3b82f6; font-weight:700;">${d.tempAvg}</td>
                <td style="padding:10px 16px; border:1px solid #e2e8f0; color:#10b981; font-weight:700;">${d.tempMin}</td>
                <td style="padding:10px 16px; border:1px solid #e2e8f0; color:#ef4444; font-weight:700;">${d.tempMax}</td>
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
      options: { ...chartOptions, plugins: { legend: { display: true, labels: { color: '#475569' } } } }
    });
  }
}
function renderHumDetail() {
  const from      = document.getElementById('humDateFrom').value;
  const to        = document.getElementById('humDateTo').value;
  const subset    = filterRange(from, to);
  const isSameDay = from === to;

  const humStats = stats(subset, 'hum');
  // Average first, then Min, then Max
  document.getElementById('humDetailAvg').textContent = humStats.avg;
  document.getElementById('humDetailMin').textContent = humStats.min;
  document.getElementById('humDetailMax').textContent = humStats.max;

  if (chartHumDetail) chartHumDetail.destroy();

  const oldTable = document.getElementById('humDayTable');
  if (oldTable) oldTable.remove();

  if (isSameDay) {
    document.getElementById('humChartTitle').textContent = '💧 Humidity - Single Day (30 min avg)';
    const bucketed = bucket30min(subset);
    chartHumDetail = new Chart(document.getElementById('chartHumDetail').getContext('2d'), {
      type: 'line',
      data: {
        labels: bucketed.map(b => b.label),
        datasets: [{
          label: 'Humidity (%)',
          data: bucketed.map(b => b.hum),
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6, 182, 212, 0.1)',
          fill: true, tension: 0.4, pointRadius: 3, borderWidth: 2
        }]
      },
      options: { ...chartOptions, plugins: { legend: { display: true, labels: { color: '#475569' } } } }
    });
  } else {
    document.getElementById('humChartTitle').textContent = '📊 Humidity - Daily Summary';
    const days = groupByDay(subset);

    const tableHTML = `
      <div id="humDayTable" style="overflow-x:auto; margin-top:20px; display:flex; justify-content:center;">
        <table style="width:80%; border-collapse:collapse; font-family:'Inter',sans-serif; font-size:0.875rem; text-align:center;">
          <thead>
            <tr style="background:#f1f5f9;">
              <th style="padding:10px 16px; border:1px solid #e2e8f0; color:#475569;">Date</th>
              <th style="padding:10px 16px; border:1px solid #e2e8f0; color:#06b6d4;">Avg (%)</th>
              <th style="padding:10px 16px; border:1px solid #e2e8f0; color:#10b981;">Min (%)</th>
              <th style="padding:10px 16px; border:1px solid #e2e8f0; color:#ef4444;">Max (%)</th>
            </tr>
          </thead>
          <tbody>
            ${days.map(d => `
              <tr>
                <td style="padding:10px 16px; border:1px solid #e2e8f0; font-weight:600;">${d.date}</td>
                <td style="padding:10px 16px; border:1px solid #e2e8f0; color:#06b6d4; font-weight:700;">${d.humAvg}</td>
                <td style="padding:10px 16px; border:1px solid #e2e8f0; color:#10b981; font-weight:700;">${d.humMin}</td>
                <td style="padding:10px 16px; border:1px solid #e2e8f0; color:#ef4444; font-weight:700;">${d.humMax}</td>
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
      options: { ...chartOptions, plugins: { legend: { display: true, labels: { color: '#475569' } } } }
    });
  }
}

// ── Humidity Detail Page ──────────────────────────────────────
function setTodayHum() {
  const today = dateStr(new Date());
  document.getElementById('humDateFrom').value = today;
  document.getElementById('humDateTo').value   = today;
  renderHumDetail();
}

// ── Date-picker listeners ─────────────────────────────────────

document.getElementById('tempDateFrom').addEventListener('change', renderTempDetail);
document.getElementById('tempDateTo').addEventListener('change',   renderTempDetail);
document.getElementById('humDateFrom').addEventListener('change',  renderHumDetail);
document.getElementById('humDateTo').addEventListener('change',    renderHumDetail);

// ── Export ────────────────────────────────────────────────────
function exportCSV() {
  if (!allData.length) return alert('No data yet.');
  let csv = "Timestamp,Temperature (°C),Humidity (%)\n";
  allData.forEach(r => { csv += r.timestamp + ',' + r.temp + ',' + r.hum + '\n'; });
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'sensor_log_' + dateStr(new Date()) + '.csv';
  a.click();
}
function exportExcel() {
  if (!allData.length) return alert('No data yet.');
  try {
    const hourly = bucketHourly(allData);
    const rows = [['Hour', 'Avg Temperature (°C)', 'Avg Humidity (%)']];
    hourly.forEach(h => rows.push([h.label, h.temp, h.hum]));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 12 }, { wch: 24 }, { wch: 22 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'SensorData');
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'FactoryMonitor_' + dateStr(new Date()) + '.xlsx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch(e) {
    alert('Excel export failed: ' + e.message);
    console.error(e);
  }
}

function exportFilteredExcel(type) {
  const isTemp = type === 'temperature';
  const from = document.getElementById(isTemp ? 'tempDateFrom' : 'humDateFrom').value;
  const to   = document.getElementById(isTemp ? 'tempDateTo'   : 'humDateTo').value;

  if (!from || !to) return alert('Please select a date range first.');
  const subset = filterRange(from, to);
  if (!subset.length) return alert('No data in selected range.');

  try {
    const isSameDay = from === to;

    let rows, filename;
    if (isSameDay) {
      // Hourly summary for single day
      const hourly = bucketHourly(subset);
      if (isTemp) {
        rows = [['Hour', 'Avg Temperature (°C)', 'Min Temperature (°C)', 'Max Temperature (°C)']];
        hourly.forEach(h => {
          const raw = subset.filter(r => {
            const d = new Date(r.timestamp);
            return pad(d.getHours()) + ':00' === h.label;
          });
          const temps = raw.map(r => r.temp);
          rows.push([h.label, h.temp, +Math.min(...temps).toFixed(1), +Math.max(...temps).toFixed(1)]);
        });
      } else {
        rows = [['Hour', 'Avg Humidity (%)', 'Min Humidity (%)', 'Max Humidity (%)']];
        hourly.forEach(h => {
          const raw = subset.filter(r => {
            const d = new Date(r.timestamp);
            return pad(d.getHours()) + ':00' === h.label;
          });
          const hums = raw.map(r => r.hum);
          rows.push([h.label, h.hum, +Math.min(...hums).toFixed(1), +Math.max(...hums).toFixed(1)]);
        });
      }
      filename = `${isTemp ? 'Temperature' : 'Humidity'}_Hourly_${from}.xlsx`;
    } else {
      // Daily summary for multi-day
      const days = groupByDay(subset);
      if (isTemp) {
        rows = [['Date', 'Avg Temperature (°C)', 'Min Temperature (°C)', 'Max Temperature (°C)']];
        days.forEach(d => rows.push([d.date, d.tempAvg, d.tempMin, d.tempMax]));
      } else {
        rows = [['Date', 'Avg Humidity (%)', 'Min Humidity (%)', 'Max Humidity (%)']];
        days.forEach(d => rows.push([d.date, d.humAvg, d.humMin, d.humMax]));
      }
      filename = `${isTemp ? 'Temperature' : 'Humidity'}_Daily_${from}_to_${to}.xlsx`;
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 16 }, { wch: 26 }, { wch: 26 }, { wch: 26 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, isTemp ? 'Temperature' : 'Humidity');
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch(e) {
    alert('Excel export failed: ' + e.message);
    console.error(e);
  }
}
// ── Daily midnight reset ──────────────────────────────────────
function scheduleMidnightReset() {
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5); // 12:00:05 AM next day
  const msUntilMidnight = next - now;

  setTimeout(() => {
    console.log('🔄 Midnight reset: clearing today cache and refreshing data...');
    allData = allData.filter(r => {
      // Keep all data but today's dashboard will naturally show new day's data
      return true;
    });
    renderTodayCharts();
    updateStats();
    scheduleMidnightReset(); // reschedule for next midnight
  }, msUntilMidnight);
}

scheduleMidnightReset();

// fetch('/api/info')
//   .then(r => r.json())
//   .then(d => document.getElementById('ipAddr').textContent = d.ip)
//   .catch(() => {});

document.addEventListener('DOMContentLoaded', async () => {
  initCharts();
  await loginTB();
  fetchCurrent();
  fetchAllData();

  setInterval(fetchCurrent,  2000);
  setInterval(fetchAllData, 10000);
});

// setInterval(fetchCurrent,  2000);
// setInterval(fetchAllData, 10000);