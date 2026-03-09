// ══════════════════════════════════════════════════════════════════════
//  send-test-email.js  —  Sends the FULL professional alert email
//  via your Render server (no API key needed locally).
//  Run: node send-test-email.js
// ══════════════════════════════════════════════════════════════════════

const https = require('https');

const SERVER    = 'rh-meter-bridge.onrender.com';
const RECIPIENT = 'naveenkumarak@aquarelleindia.com';
const DEVICE_ID = 'Meter_01';

// ── Shared constants (must match server.js) ───────────────────────────
const DASHBOARD_URL  = 'https://rh-meter-bridge.onrender.com';
const LOCATION_NAME  = 'CT-PAT Area';
const SENDER_EMAIL   = 'naveenkumarak2002@gmail.com';

// ══════════════════════════════════════════════════════════════════════
//  FULL PROFESSIONAL EMAIL TEMPLATE  (same as email-templates.js)
// ══════════════════════════════════════════════════════════════════════

function detailRow(label, value, last = false) {
  return `
  <tr style="${last ? '' : 'border-bottom:1px solid #f1f5f9;'}">
    <td style="padding:12px 0;font-size:13px;color:#64748b;font-weight:500;">${label}</td>
    <td style="padding:12px 0;font-size:13px;color:#0f172a;font-weight:700;text-align:right;">${value}</td>
  </tr>`;
}

function metricCard({ icon, label, value, unit, badgeText, badgeColor, borderColor, bgColor, noteText, noteColor }) {
  return `
  <td width="50%" style="padding:0 8px 0 0;vertical-align:top;">
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:${bgColor};border:1.5px solid ${borderColor};border-radius:8px;">
      <tr><td style="padding:22px 18px;" align="center">
        <p style="margin:0 0 4px;font-size:22px;">${icon}</p>
        <p style="margin:0 0 10px;font-size:10px;font-weight:700;letter-spacing:1.5px;
                  text-transform:uppercase;color:#94a3b8;">${label}</p>
        <p style="margin:0;font-size:30px;font-weight:800;color:${noteColor};line-height:1;">
          ${value}<span style="font-size:16px;font-weight:600;">${unit}</span>
        </p>
        <div style="display:inline-block;margin-top:10px;background:${badgeColor};
                    color:#ffffff;border-radius:4px;padding:3px 10px;
                    font-size:10px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;">
          ${badgeText}
        </div>
        <p style="margin:8px 0 0;font-size:11px;font-weight:600;color:${noteColor};">${noteText}</p>
      </td></tr>
    </table>
  </td>`;
}

function emailWrapper({ accentColor, headerContent, bodyContent }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Factory Monitor Pro</title></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:40px 0;">
  <tr><td align="center">
    <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;">

      <!-- Brand bar -->
      <tr>
        <td style="background:#0f172a;padding:14px 32px;border-radius:10px 10px 0 0;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="color:#ffffff;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">
              FACTORY MONITOR PRO
            </td>
            <td align="right" style="color:#64748b;font-size:11px;font-weight:500;letter-spacing:0.5px;">
              Aquarelle Clothing Ltd &nbsp;·&nbsp; ${LOCATION_NAME}
            </td>
          </tr></table>
        </td>
      </tr>

      <!-- Accent header -->
      <tr>
        <td style="background:${accentColor};padding:36px 32px 28px;">
          ${headerContent}
        </td>
      </tr>

      <!-- White body -->
      <tr>
        <td style="background:#ffffff;padding:32px 32px 28px;">
          ${bodyContent}
        </td>
      </tr>

      <!-- CTA -->
      <tr>
        <td style="background:#ffffff;padding:0 32px 32px;" align="center">
          <a href="${DASHBOARD_URL}" target="_blank"
            style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;
                   padding:14px 36px;border-radius:6px;font-size:13px;font-weight:700;
                   letter-spacing:0.8px;text-transform:uppercase;">
            Open Live Dashboard &rarr;
          </a>
          <p style="margin:10px 0 0;color:#94a3b8;font-size:11px;">${DASHBOARD_URL}</p>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#f8fafc;border-top:1px solid #e2e8f0;border-radius:0 0 10px 10px;
                   padding:16px 32px;" align="center">
          <p style="margin:0;color:#94a3b8;font-size:11px;line-height:1.6;">
            Factory Monitor Pro &nbsp;·&nbsp; Aquarelle Clothing Ltd &nbsp;·&nbsp; ${LOCATION_NAME}<br>
            This is an automated alert. Do not reply to this email.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

function buildTestAlertEmailHTML(device, temp, hum, tempThreshold, humThreshold, time) {
  const tempExceeded = temp > tempThreshold;
  const humExceeded  = hum  > humThreshold;

  const statusLabel = (tempExceeded && humExceeded) ? 'Dual Threshold Breach'
    : tempExceeded ? 'Temperature Threshold Breach'
    : humExceeded  ? 'Humidity Threshold Breach'
    : 'All Readings Within Range';

  const accentColor = (tempExceeded || humExceeded) ? '#7f1d1d' : '#065f46';
  const bannerColor = (tempExceeded || humExceeded)
    ? { bg: '#fff5f5', border: '#ef4444', text: '#7f1d1d' }
    : { bg: '#f0fdf4', border: '#10b981', text: '#14532d' };
  const bannerMsg = (tempExceeded || humExceeded)
    ? 'One or more sensor readings have exceeded configured thresholds. Review the values below and take corrective action if required.'
    : 'All sensor readings are within normal operating ranges. No action is required.';

  const tempCard = tempExceeded ? {
    icon: '&#127777;', label: 'Temperature', value: temp.toFixed(1), unit: '°C',
    badgeText: `+${(temp - tempThreshold).toFixed(1)}°C ABOVE LIMIT`, badgeColor: '#ef4444',
    borderColor: '#fca5a5', bgColor: '#fff5f5',
    noteText: `Limit: ${tempThreshold}°C`, noteColor: '#ef4444'
  } : {
    icon: '&#127777;', label: 'Temperature', value: temp.toFixed(1), unit: '°C',
    badgeText: 'WITHIN RANGE', badgeColor: '#10b981',
    borderColor: '#6ee7b7', bgColor: '#f0fdf4',
    noteText: 'Status: Normal', noteColor: '#059669'
  };

  const humCard = humExceeded ? {
    icon: '&#128167;', label: 'Humidity', value: hum.toFixed(1), unit: '%',
    badgeText: `+${(hum - humThreshold).toFixed(1)}% ABOVE LIMIT`, badgeColor: '#0891b2',
    borderColor: '#67e8f9', bgColor: '#ecfeff',
    noteText: `Limit: ${humThreshold}%`, noteColor: '#0891b2'
  } : {
    icon: '&#128167;', label: 'Humidity', value: hum.toFixed(1), unit: '%',
    badgeText: 'WITHIN RANGE', badgeColor: '#10b981',
    borderColor: '#6ee7b7', bgColor: '#f0fdf4',
    noteText: 'Status: Normal', noteColor: '#059669'
  };

  const header = `
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:2px;
                  text-transform:uppercase;color:rgba(255,255,255,0.6);">TEST ALERT PREVIEW</p>
        <h1 style="margin:0 0 6px;font-size:22px;font-weight:800;color:#ffffff;line-height:1.2;">
          ${statusLabel}
        </h1>
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.75);">
          Device <strong style="color:#fff;">${device}</strong>
          &nbsp;·&nbsp; ${time}
        </p>
      </td>
    </tr></table>`;

  const body = `
    <!-- Banner -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="background:${bannerColor.bg};border-left:4px solid ${bannerColor.border};
                   border-radius:0 6px 6px 0;padding:14px 18px;">
          <p style="margin:0;font-size:13px;color:${bannerColor.text};font-weight:600;">
            ${bannerMsg}
          </p>
        </td>
      </tr>
    </table>

    <!-- Metric cards -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        ${metricCard(tempCard)}
        ${metricCard(humCard)}
      </tr>
    </table>

    <!-- Details table -->
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f1f5f9;">
      ${detailRow('Location', LOCATION_NAME)}
      ${detailRow('Device ID', device)}
      ${detailRow('Temp Threshold', `${tempThreshold}°C`)}
      ${detailRow('Humidity Threshold', `${humThreshold}%`)}
      ${detailRow('Snapshot Time', time)}
      ${detailRow('Alert Cooldown', '1 hour between repeat alerts', true)}
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
      <tr>
        <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;">
          <p style="margin:0;font-size:11px;color:#94a3b8;font-style:italic;">
            This is a test preview using live sensor data. Real alerts fire automatically
            when thresholds are exceeded and the cooldown period has elapsed.
          </p>
        </td>
      </tr>
    </table>`;

  return emailWrapper({ accentColor, headerContent: header, bodyContent: body });
}

// ══════════════════════════════════════════════════════════════════════
//  STEP 1 — Fetch settings + latest sensor data from your server
// ══════════════════════════════════════════════════════════════════════
function httpsGet(path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: SERVER, path, headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad JSON: ' + data)); } });
    }).on('error', reject);
  });
}

function httpsPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: SERVER, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad JSON: ' + data)); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════════
(async () => {
  try {
    // 1. Fetch thresholds from server
    console.log('⚙️  Fetching settings from server...');
    const settings = await httpsGet('/api/settings');
    const tempThreshold = settings.tempThreshold ?? 35;
    const humThreshold  = settings.humThreshold  ?? 70;
    console.log(`   Temp threshold: ${tempThreshold}°C  |  Hum threshold: ${humThreshold}%`);

    // 2. Fetch latest sensor reading from server history
    console.log('📡 Fetching latest sensor data from server...');
    const history = await httpsGet('/api/history');
    const latest  = history.length ? history[history.length - 1] : null;
    const temp    = latest?.temp ?? 36.5;
    const hum     = latest?.hum  ?? 72.0;
    console.log(`   Latest reading — Temp: ${temp}°C  |  Hum: ${hum}%`);

    // 3. Build the full professional HTML locally
    const time    = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const html    = buildTestAlertEmailHTML(DEVICE_ID, temp, hum, tempThreshold, humThreshold, time);
    const subject = `🔔 Test Alert — ${LOCATION_NAME} | ${DEVICE_ID} | T:${temp.toFixed(1)}°C  H:${hum.toFixed(1)}%`;

    // 4. POST to server's /api/send-raw-email — server uses its own Brevo key
    console.log(`📤 Sending full template email to ${RECIPIENT}...`);
    const result = await httpsPost('/api/send-raw-email', {
      to:      RECIPIENT,
      subject: subject,
      html:    html
    });

    if (result.ok) {
      console.log('✅ Email sent successfully!');
      console.log(`   Delivered to: ${RECIPIENT}`);
    } else {
      console.error('❌ Server rejected:', result.error);
    }

  } catch (err) {
    console.error('❌ Error:', err.message);
  }
})();