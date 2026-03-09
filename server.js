const express  = require('express');
const mongoose = require('mongoose');
const cron     = require('node-cron');
const axios    = require('axios');
const cors     = require('cors');
const https    = require('https');

// ── Constants ─────────────────────────────────────────────────
const DASHBOARD_URL = 'https://rh-meter-bridge.onrender.com';
const LOCATION_NAME = 'CT-PAT Area';
const SENDER_EMAIL  = 'naveenkumarak2002@gmail.com';
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const app = express();

// ── CORS ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ── MongoDB ───────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI || "mongodb+srv://factory_admin:factory_admin1234@cluster0.zk0gm.mongodb.net/FactoryData?retryWrites=true&w=majority")
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

// ── Schemas ───────────────────────────────────────────────────
const SensorData = mongoose.model('SensorData', new mongoose.Schema({
  deviceId:    { type: String, default: 'Meter_01' },
  temperature: Number,
  humidity:    Number,
  tempLevel:   String,
  humLevel:    String,
  timestamp:   { type: Date, default: Date.now }
}));

const Settings = mongoose.model('Settings', new mongoose.Schema({
  key:           { type: String, default: 'global', unique: true },
  tempThreshold: { type: Number, default: 35 },
  humThreshold:  { type: Number, default: 70 },
  recipients:    { type: String, default: '' },
}, { timestamps: true }));

const AlertCooldown = mongoose.model('AlertCooldown', new mongoose.Schema({
  key:        { type: String, unique: true },
  lastSentAt: { type: Date, default: null },
}));

const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// ── Seed defaults ─────────────────────────────────────────────
mongoose.connection.once('open', async () => {
  try {
    const existing = await Settings.findOne({ key: 'global' });
    if (!existing) {
      await Settings.create({ key: 'global', tempThreshold: 35, humThreshold: 70, recipients: '' });
      console.log('✅ Default settings seeded');
    }
  } catch (err) { console.error('❌ Seed error:', err.message); }
});

// ── Cooldown helpers ──────────────────────────────────────────
async function canSendAlert(key) {
  try {
    const r = await AlertCooldown.findOne({ key });
    if (!r || !r.lastSentAt) return true;
    return (Date.now() - new Date(r.lastSentAt).getTime()) > COOLDOWN_MS;
  } catch { return true; }
}

async function markAlertSent(key) {
  await AlertCooldown.findOneAndUpdate(
    { key }, { $set: { lastSentAt: new Date() } }, { upsert: true, new: true }
  );
}

// ── Brevo email sender (HTTPS API — works on Render free) ─────
async function sendEmail(subject, htmlBody, recipients) {
  const payload = JSON.stringify({
    sender:      { name: 'Factory Monitor Pro', email: SENDER_EMAIL },
    to:          recipients.map(email => ({ email })),
    subject:     subject,
    htmlContent: htmlBody
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers: {
        'accept':         'application/json',
        'api-key':        BREVO_API_KEY,
        'content-type':   'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          console.error('❌ Brevo error:', data);
          resolve({ ok: false, error: data });
        } else {
          console.log(`✅ Email sent via Brevo`);
          resolve({ ok: true });
        }
      });
    });
    req.on('error', (err) => {
      console.error('❌ Brevo request error:', err.message);
      resolve({ ok: false, error: err.message });
    });
    req.write(payload);
    req.end();
  });
}

// ── Core alert email sender ───────────────────────────────────
async function sendAlertEmail(subject, htmlBody) {
  try {
    const settings     = await Settings.findOne({ key: 'global' });
    const recipientStr = (settings && settings.recipients) || '';
    const recipients   = recipientStr.split(',').map(e => e.trim()).filter(Boolean);

    if (!recipients.length) {
      console.warn('⚠️  No recipients configured');
      return { ok: false, error: 'No recipients configured' };
    }

    console.log(`📧 Sending "${subject}" → ${recipients.join(', ')}`);
    return await sendEmail(subject, htmlBody, recipients);

  } catch (err) {
    console.error('❌ Email exception:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Email Templates ───────────────────────────────────────────
function tempEmailHTML(device, currentTemp, threshold, currentHum) {
  const exceededBy = (currentTemp - threshold).toFixed(1);
  const time       = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const humOk      = currentHum != null;

  const header = `
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:2px;
                  text-transform:uppercase;color:rgba(255,255,255,0.6);">THRESHOLD BREACH</p>
        <h1 style="margin:0 0 6px;font-size:22px;font-weight:800;color:#ffffff;line-height:1.2;">
          Temperature Alert
        </h1>
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.75);">
          Device <strong style="color:#fff;">${device}</strong>
          &nbsp;·&nbsp; Recorded at ${time}
        </p>
      </td>
      <td align="right" style="vertical-align:top;">
        <div style="background:rgba(255,255,255,0.15);border-radius:6px;
                    padding:10px 16px;text-align:center;min-width:80px;">
          <p style="margin:0;font-size:28px;font-weight:900;color:#ffffff;line-height:1;">
            ${currentTemp.toFixed(1)}<span style="font-size:16px;">°C</span>
          </p>
          <p style="margin:4px 0 0;font-size:10px;font-weight:700;letter-spacing:1px;
                    text-transform:uppercase;color:rgba(255,255,255,0.7);">Current</p>
        </div>
      </td>
    </tr></table>`;

  const body = `
    <!-- Alert banner -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="background:#fff5f5;border-left:4px solid #ef4444;border-radius:0 6px 6px 0;
                   padding:14px 18px;">
          <p style="margin:0;font-size:13px;color:#7f1d1d;font-weight:600;">
            &#9650;&nbsp; Temperature exceeded the configured threshold of
            <strong>${threshold}°C</strong> by <strong>+${exceededBy}°C</strong>.
            Immediate attention may be required.
          </p>
        </td>
      </tr>
    </table>

    <!-- Metric cards -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        ${metricCard({
          icon: '&#127777;', label: 'Temperature', value: currentTemp.toFixed(1), unit: '°C',
          badgeText: `+${exceededBy}°C ABOVE LIMIT`, badgeColor: '#ef4444',
          borderColor: '#fca5a5', bgColor: '#fff5f5',
          noteText: `Limit: ${threshold}°C`, noteColor: '#ef4444'
        })}
        ${metricCard({
          icon: '&#128167;', label: 'Humidity', value: humOk ? currentHum.toFixed(1) : '--', unit: humOk ? '%' : '',
          badgeText: 'WITHIN RANGE', badgeColor: '#10b981',
          borderColor: '#6ee7b7', bgColor: '#f0fdf4',
          noteText: 'Status: Normal', noteColor: '#059669'
        })}
      </tr>
    </table>

    <!-- Details table -->
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border-top:1px solid #f1f5f9;">
      ${detailRow('Location', LOCATION_NAME)}
      ${detailRow('Device ID', device)}
      ${detailRow('Alert Triggered', time)}
      ${detailRow('Next Alert Window', 'After 1-hour cooldown', true)}
    </table>`;

  return emailWrapper({
    accentColor: '#b91c1c',
    headerContent: header,
    bodyContent: body,
    footerNote: `Factory Monitor Pro &nbsp;·&nbsp; Aquarelle Clothing Ltd &nbsp;·&nbsp; ${LOCATION_NAME}`
  });
}

function detailRow(label, value, last = false) {
  return `
  <tr style="${last ? '' : 'border-bottom:1px solid #f1f5f9;'}">
    <td style="padding:12px 0;font-size:13px;color:#64748b;font-weight:500;">${label}</td>
    <td style="padding:12px 0;font-size:13px;color:#0f172a;font-weight:700;text-align:right;">${value}</td>
  </tr>`;
}

// ════════════════════════════════════════════════════════════
//  2.  HUMIDITY ALERT
// ════════════════════════════════════════════════════════════
function humEmailHTML(device, currentHum, threshold, currentTemp) {
  const exceededBy = (currentHum - threshold).toFixed(1);
  const time       = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const tempOk     = currentTemp != null;

  const header = `
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:2px;
                  text-transform:uppercase;color:rgba(255,255,255,0.6);">THRESHOLD BREACH</p>
        <h1 style="margin:0 0 6px;font-size:22px;font-weight:800;color:#ffffff;line-height:1.2;">
          Humidity Alert
        </h1>
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.75);">
          Device <strong style="color:#fff;">${device}</strong>
          &nbsp;·&nbsp; Recorded at ${time}
        </p>
      </td>
      <td align="right" style="vertical-align:top;">
        <div style="background:rgba(255,255,255,0.15);border-radius:6px;
                    padding:10px 16px;text-align:center;min-width:80px;">
          <p style="margin:0;font-size:28px;font-weight:900;color:#ffffff;line-height:1;">
            ${currentHum.toFixed(1)}<span style="font-size:16px;">%</span>
          </p>
          <p style="margin:4px 0 0;font-size:10px;font-weight:700;letter-spacing:1px;
                    text-transform:uppercase;color:rgba(255,255,255,0.7);">Current</p>
        </div>
      </td>
    </tr></table>`;

  const body = `
    <!-- Alert banner -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="background:#ecfeff;border-left:4px solid #0891b2;border-radius:0 6px 6px 0;
                   padding:14px 18px;">
          <p style="margin:0;font-size:13px;color:#164e63;font-weight:600;">
            &#9650;&nbsp; Humidity exceeded the configured threshold of
            <strong>${threshold}%</strong> by <strong>+${exceededBy}%</strong>.
            Ventilation or corrective action may be required.
          </p>
        </td>
      </tr>
    </table>

    <!-- Metric cards -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        ${metricCard({
          icon: '&#127777;', label: 'Temperature', value: tempOk ? currentTemp.toFixed(1) : '--', unit: tempOk ? '°C' : '',
          badgeText: 'WITHIN RANGE', badgeColor: '#10b981',
          borderColor: '#6ee7b7', bgColor: '#f0fdf4',
          noteText: 'Status: Normal', noteColor: '#059669'
        })}
        ${metricCard({
          icon: '&#128167;', label: 'Humidity', value: currentHum.toFixed(1), unit: '%',
          badgeText: `+${exceededBy}% ABOVE LIMIT`, badgeColor: '#0891b2',
          borderColor: '#67e8f9', bgColor: '#ecfeff',
          noteText: `Limit: ${threshold}%`, noteColor: '#0891b2'
        })}
      </tr>
    </table>

    <!-- Details table -->
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border-top:1px solid #f1f5f9;">
      ${detailRow('Location', LOCATION_NAME)}
      ${detailRow('Device ID', device)}
      ${detailRow('Alert Triggered', time)}
      ${detailRow('Next Alert Window', 'After 1-hour cooldown', true)}
    </table>`;

  return emailWrapper({
    accentColor: '#0e7490',
    headerContent: header,
    bodyContent: body,
    footerNote: `Factory Monitor Pro &nbsp;·&nbsp; Aquarelle Clothing Ltd &nbsp;·&nbsp; ${LOCATION_NAME}`
  });
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

function emailWrapper({ accentColor, headerContent, bodyContent, footerNote }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Factory Monitor Pro</title></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:40px 0;">
  <tr><td align="center">
    <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;">

      <!-- ── Top brand bar ── -->
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

      <!-- ── Accent header ── -->
      <tr>
        <td style="background:${accentColor};padding:36px 32px 28px;">
          ${headerContent}
        </td>
      </tr>

      <!-- ── White body ── -->
      <tr>
        <td style="background:#ffffff;padding:32px 32px 28px;">
          ${bodyContent}
        </td>
      </tr>

      <!-- ── CTA row ── -->
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

      <!-- ── Footer ── -->
      <tr>
        <td style="background:#f8fafc;border-top:1px solid #e2e8f0;border-radius:0 0 10px 10px;
                   padding:16px 32px;" align="center">
          <p style="margin:0;color:#94a3b8;font-size:11px;line-height:1.6;">
            ${footerNote}<br>
            This is an automated alert. Do not reply to this email.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

// ════════════════════════════════════════════════════════════
//  3.  TEST EMAIL (config verification)
// ════════════════════════════════════════════════════════════
function testEmailHTML(recipients, time) {
  const header = `
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:2px;
                  text-transform:uppercase;color:rgba(255,255,255,0.6);">SYSTEM VERIFICATION</p>
        <h1 style="margin:0 0 6px;font-size:22px;font-weight:800;color:#ffffff;line-height:1.2;">
          Email Configuration Confirmed
        </h1>
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.75);">
          Alert delivery is operational &nbsp;·&nbsp; ${time}
        </p>
      </td>
      <td align="right" style="vertical-align:top;">
        <div style="background:rgba(255,255,255,0.15);border-radius:6px;
                    padding:12px 16px;text-align:center;">
          <p style="margin:0;font-size:26px;font-weight:900;color:#ffffff;line-height:1;">&#10003;</p>
          <p style="margin:4px 0 0;font-size:10px;font-weight:700;letter-spacing:1px;
                    text-transform:uppercase;color:rgba(255,255,255,0.7);">Verified</p>
        </div>
      </td>
    </tr></table>`;

  const body = `
    <!-- Info block -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="background:#f0fdf4;border-left:4px solid #10b981;border-radius:0 6px 6px 0;
                   padding:14px 18px;">
          <p style="margin:0;font-size:13px;color:#14532d;font-weight:600;">
            &#10003;&nbsp; The alert notification system is configured correctly.
            You will receive automated alerts whenever sensor readings exceed the defined thresholds.
          </p>
        </td>
      </tr>
    </table>

    <!-- Details table -->
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border-top:1px solid #f1f5f9;">
      ${detailRow('Monitoring Location', LOCATION_NAME)}
      ${detailRow('Recipients', recipients)}
      ${detailRow('Verification Time', time)}
      ${detailRow('Alert Cooldown Period', '1 hour between repeat alerts', true)}
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
      <tr>
        <td style="background:#f8fafc;border-radius:6px;border:1px solid #e2e8f0;padding:16px 18px;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:1px;
                    text-transform:uppercase;color:#64748b;">What to expect</p>
          <p style="margin:0;font-size:12px;color:#475569;line-height:1.7;">
            &#8227; &nbsp;Temperature alerts fire when readings exceed your configured threshold.<br>
            &#8227; &nbsp;Humidity alerts fire when readings exceed your configured threshold.<br>
            &#8227; &nbsp;Each alert type has an independent 1-hour cooldown per device.
          </p>
        </td>
      </tr>
    </table>`;

  return emailWrapper({
    accentColor: '#065f46',
    headerContent: header,
    bodyContent: body,
    footerNote: `Factory Monitor Pro &nbsp;·&nbsp; Aquarelle Clothing Ltd &nbsp;·&nbsp; ${LOCATION_NAME}`
  });
}

// ════════════════════════════════════════════════════════════
//  4.  TEST ALERT EMAIL (live sensor preview)
// ════════════════════════════════════════════════════════════
function testAlertEmailHTML(device, temp, hum, tempThreshold, humThreshold, time) {
  const tempExceeded = temp > tempThreshold;
  const humExceeded  = hum  > humThreshold;

  const statusLabel = (tempExceeded && humExceeded) ? 'Dual Threshold Breach'
    : tempExceeded ? 'Temperature Threshold Breach'
    : humExceeded  ? 'Humidity Threshold Breach'
    : 'All Readings Within Range';

  const accentColor = (tempExceeded || humExceeded) ? '#7f1d1d' : '#065f46';
  const bannerColor = (tempExceeded || humExceeded) ? { bg:'#fff5f5', border:'#ef4444', text:'#7f1d1d' }
                                                    : { bg:'#f0fdf4', border:'#10b981', text:'#14532d' };
  const bannerMsg   = (tempExceeded || humExceeded)
    ? `One or more sensor readings have exceeded configured thresholds. Review the values below and take corrective action if required.`
    : `All sensor readings are within normal operating ranges. No action is required.`;

  const tempCard = tempExceeded ? {
    icon:'&#127777;', label:'Temperature', value: temp.toFixed(1), unit:'°C',
    badgeText:`+${(temp - tempThreshold).toFixed(1)}°C ABOVE LIMIT`, badgeColor:'#ef4444',
    borderColor:'#fca5a5', bgColor:'#fff5f5',
    noteText:`Limit: ${tempThreshold}°C`, noteColor:'#ef4444'
  } : {
    icon:'&#127777;', label:'Temperature', value: temp.toFixed(1), unit:'°C',
    badgeText:'WITHIN RANGE', badgeColor:'#10b981',
    borderColor:'#6ee7b7', bgColor:'#f0fdf4',
    noteText:'Status: Normal', noteColor:'#059669'
  };

  const humCard = humExceeded ? {
    icon:'&#128167;', label:'Humidity', value: hum.toFixed(1), unit:'%',
    badgeText:`+${(hum - humThreshold).toFixed(1)}% ABOVE LIMIT`, badgeColor:'#0891b2',
    borderColor:'#67e8f9', bgColor:'#ecfeff',
    noteText:`Limit: ${humThreshold}%`, noteColor:'#0891b2'
  } : {
    icon:'&#128167;', label:'Humidity', value: hum.toFixed(1), unit:'%',
    badgeText:'WITHIN RANGE', badgeColor:'#10b981',
    borderColor:'#6ee7b7', bgColor:'#f0fdf4',
    noteText:'Status: Normal', noteColor:'#059669'
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
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border-top:1px solid #f1f5f9;">
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
    return emailWrapper({
    accentColor,
    headerContent: header,
    bodyContent: body,
    footerNote: `Factory Monitor Pro &nbsp;·&nbsp; Aquarelle Clothing Ltd &nbsp;·&nbsp; ${LOCATION_NAME}`
  });
}

app.post('/api/send-raw-email', async (req, res) => {
  try {
    const { to, subject, html } = req.body;
    if (!to || !subject || !html)
      return res.status(400).json({ ok: false, error: 'Missing to / subject / html' });

    const recipients = to.split(',').map(e => e.trim()).filter(Boolean);
    const result     = await sendEmail(subject, html, recipients);
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ── Alert checker ─────────────────────────────────────────────
async function checkAndAlert(record) {
  try {
    const settings = await Settings.findOne({ key: 'global' });
    if (!settings) { console.warn('⚠️ No settings in DB'); return; }

    const device = record.deviceId || 'Meter_01';
    const temp   = record.temperature;
    const hum    = record.humidity;

    if (temp != null) {
      console.log(`🔍 Temp: ${temp}°C  vs  threshold: ${settings.tempThreshold}°C`);
      if (temp > settings.tempThreshold) {
        const key = `${device}_temp`;
        if (await canSendAlert(key)) {
          await markAlertSent(key);
          console.log(`🌡️  ALERT — temp exceeded for ${device}`);
          await sendAlertEmail(
            `🌡️ Temperature Alert — ${device} (${temp.toFixed(1)}°C)`,
            tempEmailHTML(device, temp, settings.tempThreshold, hum)
          );
        } else { console.log(`⏳ Temp cooldown active`); }
      } else { console.log(`✅ Temp OK`); }
    }

    if (hum != null) {
      console.log(`🔍 Hum: ${hum}%  vs  threshold: ${settings.humThreshold}%`);
      if (hum > settings.humThreshold) {
        const key = `${device}_hum`;
        if (await canSendAlert(key)) {
          await markAlertSent(key);
          console.log(`💧  ALERT — hum exceeded for ${device}`);
          await sendAlertEmail(
            `💧 Humidity Alert — ${device} (${hum.toFixed(1)}%)`,
            humEmailHTML(device, hum, settings.humThreshold, temp)
          );
        } else { console.log(`⏳ Hum cooldown active`); }
      } else { console.log(`✅ Hum OK`); }
    }

  } catch (err) { console.error('❌ Alert check error:', err.message); }
}

// ── Keep-alive ping (prevents Render free tier sleep) ─────────
cron.schedule('*/10 * * * *', async () => {
  try { await axios.get('https://rh-meter-bridge.onrender.com/'); console.log('⚡ Self-ping OK'); }
  catch (e) { console.error('Self-ping failed:', e.message); }
});

// ════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.send('🚀 Factory Monitor Bridge is running ✅'));

// ── Save sensor data + trigger alert check ────────────────────
app.post('/save-data', async (req, res) => {
  try {
    const data = { ...req.body, deviceId: req.body.deviceId || 'Meter_01' };
    await new SensorData(data).save();
    console.log('💾 Saved:', data);
    await checkAndAlert(data);
    res.status(200).send('Saved');
  } catch (err) { console.error('❌ Save Error:', err); res.status(500).send('Error'); }
});

// ── Latest sensor reading ─────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'Meter_01';  // ← this line added
    const records = await SensorData.find({ deviceId }).sort({ timestamp: -1 }).limit(1);
    res.json(records[0] || {});
  } catch (err) { 
    console.error('❌ Data fetch error:', err); 
    res.status(500).send('Error'); 
  }
})

// ── Get settings ──────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    let s = await Settings.findOne({ key: 'global' });
    if (!s) s = await Settings.create({ key: 'global' });
    res.json({ tempThreshold: s.tempThreshold, humThreshold: s.humThreshold, recipients: s.recipients });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Save settings ─────────────────────────────────────────────
app.post('/api/settings', async (req, res) => {
  try {
    const allowed = ['tempThreshold', 'humThreshold', 'recipients'];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    if (update.tempThreshold !== undefined) update.tempThreshold = parseFloat(update.tempThreshold);
    if (update.humThreshold  !== undefined) update.humThreshold  = parseFloat(update.humThreshold);

    const result = await Settings.findOneAndUpdate(
      { key: 'global' }, { $set: update }, { upsert: true, new: true }
    );
    console.log('✅ Settings updated:', update);
    res.json({ ok: true, settings: { tempThreshold: result.tempThreshold, humThreshold: result.humThreshold, recipients: result.recipients } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Send test email ───────────────────────────────────────────
app.post('/api/test-email', async (req, res) => {
  try {
    const settings   = await Settings.findOne({ key: 'global' });
    let recipientStr = (req.body.recipients || (settings && settings.recipients) || '').trim();

    if (!recipientStr) {
      return res.status(400).json({ ok: false, error: 'No recipients. Add at least one email and save settings first.' });
    }

    const recipients = recipientStr.split(',').map(e => e.trim()).filter(Boolean);
    const time       = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    console.log('📧 Test email → recipients:', recipients);

    const result = await sendEmail('✅ Factory Monitor Pro — Test Email', testEmailHTML(recipientStr, time), recipients);

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    res.json({ ok: true });

  } catch (err) {
    console.error('❌ Test email exception:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Test alert email ──────────────────────────────────────────
app.post('/api/test-alert-email', async (req, res) => {
  try {
    const settings = await Settings.findOne({ key: 'global' });
    if (!settings) return res.status(500).json({ ok: false, error: 'No settings in DB' });

    const recipientStr = (req.body.recipients || settings.recipients || '').trim();
    if (!recipientStr) return res.status(400).json({ ok: false, error: 'No recipients configured' });

    const deviceId = req.body.deviceId || 'Meter_01';
    const latest   = await SensorData.findOne({ deviceId }).sort({ timestamp: -1 });

    const temp = latest?.temperature ?? 36.5;
    const hum  = latest?.humidity    ?? 72.0;
    const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    const recipients = recipientStr.split(',').map(e => e.trim()).filter(Boolean);

    console.log(`📧 Test alert email → ${recipients.join(', ')}`);

    const result = await sendEmail(
      `🔔 Test Alert — ${LOCATION_NAME} | ${deviceId} | T:${temp.toFixed(1)}°C  H:${hum.toFixed(1)}%`,
      testAlertEmailHTML(deviceId, temp, hum, settings.tempThreshold, settings.humThreshold, time),
      recipients
    );

    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });

    res.json({ ok: true, usedData: { temp, hum, deviceId } });

  } catch (err) {
    console.error('❌ Test alert email error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Reset cooldowns ───────────────────────────────────────────
app.post('/api/reset-cooldown', async (req, res) => {
  try {
    await AlertCooldown.deleteMany({});
    console.log('✅ Cooldowns reset');
    res.json({ ok: true, message: 'All cooldowns cleared. Next threshold breach will fire immediately.' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Debug ─────────────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  const s         = await Settings.findOne({ key: 'global' });
  const cooldowns = await AlertCooldown.find({});
  res.json({
    recipients:    s?.recipients,
    tempThreshold: s?.tempThreshold,
    humThreshold:  s?.humThreshold,
    brevoKeySet:   !!(process.env.BREVO_API_KEY || BREVO_API_KEY),
    cooldowns:     cooldowns,
  });
});

app.get('/api/history', async (req, res) => {
  try {
    const records = await SensorData.find({}).sort({ timestamp: 1 }).limit(1000);
    res.json(records.map(r => ({
      timestamp: r.timestamp,
      temp: r.temperature,
      hum: r.humidity
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/send-raw-email', async (req, res) => {
  try {
    const { to, subject, html } = req.body;
    if (!to || !subject || !html)
      return res.status(400).json({ ok: false, error: 'Missing to / subject / html' });
    const recipients = to.split(',').map(e => e.trim()).filter(Boolean);
    const result = await sendEmail(subject, html, recipients);
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge running on port ${PORT}`)); 