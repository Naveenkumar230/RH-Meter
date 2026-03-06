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

  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:540px;margin:0 auto;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.14);">
    <div style="background:linear-gradient(135deg,#ef4444,#f97316);padding:32px 28px 24px;text-align:center;">
      <div style="font-size:2.8rem;margin-bottom:6px;">🌡️</div>
      <h1 style="color:white;margin:0 0 4px;font-size:1.4rem;font-weight:700;">Temperature Alert</h1>
      <p style="color:rgba(255,255,255,0.85);margin:0;font-size:0.85rem;">Factory Monitor Pro — ${device}</p>
      <div style="display:inline-block;background:rgba(255,255,255,0.2);color:white;border-radius:20px;padding:4px 14px;font-size:0.75rem;font-weight:700;margin-top:8px;">📍 ${LOCATION_NAME}</div>
    </div>
    <div style="background:#f8fafc;padding:24px 24px 8px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="50%" style="padding:0 8px 16px 0;">
          <div style="background:#fff5f5;border:2px solid #ef4444;border-radius:14px;padding:20px 16px;text-align:center;">
            <div style="font-size:1.4rem;margin-bottom:4px;">🌡️</div>
            <p style="color:#9ca3af;font-size:0.7rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:0 0 6px;">Temperature</p>
            <p style="color:#ef4444;font-size:2.4rem;font-weight:800;margin:0;line-height:1;">${currentTemp.toFixed(1)}°C</p>
            <div style="display:inline-block;background:#ef4444;color:white;border-radius:20px;padding:3px 12px;font-size:0.72rem;font-weight:700;margin-top:8px;">▲ +${exceededBy}°C over limit</div>
            <p style="color:#ef4444;font-size:0.72rem;font-weight:600;margin:6px 0 0;">Threshold: ${threshold}°C</p>
          </div>
        </td>
        <td width="50%" style="padding:0 0 16px 8px;">
          <div style="background:#f0fdf4;border:2px solid #22c55e;border-radius:14px;padding:20px 16px;text-align:center;">
            <div style="font-size:1.4rem;margin-bottom:4px;">💧</div>
            <p style="color:#9ca3af;font-size:0.7rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:0 0 6px;">Humidity</p>
            <p style="color:#16a34a;font-size:2.4rem;font-weight:800;margin:0;line-height:1;">${humOk ? currentHum.toFixed(1)+'%' : '--'}</p>
            <div style="display:inline-block;background:#22c55e;color:white;border-radius:20px;padding:3px 12px;font-size:0.72rem;font-weight:700;margin-top:8px;">✓ Within Normal Range</div>
            <p style="color:#16a34a;font-size:0.72rem;font-weight:600;margin:6px 0 0;">Status: Normal</p>
          </div>
        </td>
      </tr></table>
    </div>
    <div style="background:#ffffff;padding:4px 28px 20px;">
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">📍 Location</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">${LOCATION_NAME}</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">🏭 Device</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">${device}</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">🕐 Alert Time</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">${time}</td>
        </tr>
        <tr>
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">⏰ Next Alert</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">After 1 hour cooldown</td>
        </tr>
      </table>
    </div>
    <div style="background:#ffffff;padding:0 28px 28px;text-align:center;">
      <a href="${DASHBOARD_URL}" target="_blank" style="display:inline-block;background:linear-gradient(135deg,#ef4444,#f97316);color:white;text-decoration:none;padding:13px 32px;border-radius:10px;font-size:0.9rem;font-weight:700;box-shadow:0 4px 14px rgba(239,68,68,0.4);">📊 Open Live Dashboard →</a>
      <p style="color:#94a3b8;font-size:0.75rem;margin:10px 0 0;">${DASHBOARD_URL}</p>
    </div>
    <div style="background:#fef2f2;border-top:1px solid #fecaca;padding:14px 28px;text-align:center;">
      <p style="color:#ef4444;font-size:0.75rem;font-weight:600;margin:0;">Factory Monitor Pro · Aquarelle Clothing Ltd · ${LOCATION_NAME}</p>
    </div>
  </div>`;
}

function humEmailHTML(device, currentHum, threshold, currentTemp) {
  const exceededBy = (currentHum - threshold).toFixed(1);
  const time       = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const tempOk     = currentTemp != null;

  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:540px;margin:0 auto;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.14);">
    <div style="background:linear-gradient(135deg,#06b6d4,#3b82f6);padding:32px 28px 24px;text-align:center;">
      <div style="font-size:2.8rem;margin-bottom:6px;">💧</div>
      <h1 style="color:white;margin:0 0 4px;font-size:1.4rem;font-weight:700;">Humidity Alert</h1>
      <p style="color:rgba(255,255,255,0.85);margin:0;font-size:0.85rem;">Factory Monitor Pro — ${device}</p>
      <div style="display:inline-block;background:rgba(255,255,255,0.2);color:white;border-radius:20px;padding:4px 14px;font-size:0.75rem;font-weight:700;margin-top:8px;">📍 ${LOCATION_NAME}</div>
    </div>
    <div style="background:#f8fafc;padding:24px 24px 8px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="50%" style="padding:0 8px 16px 0;">
          <div style="background:#f0fdf4;border:2px solid #22c55e;border-radius:14px;padding:20px 16px;text-align:center;">
            <div style="font-size:1.4rem;margin-bottom:4px;">🌡️</div>
            <p style="color:#9ca3af;font-size:0.7rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:0 0 6px;">Temperature</p>
            <p style="color:#16a34a;font-size:2.4rem;font-weight:800;margin:0;line-height:1;">${tempOk ? currentTemp.toFixed(1)+'°C' : '--'}</p>
            <div style="display:inline-block;background:#22c55e;color:white;border-radius:20px;padding:3px 12px;font-size:0.72rem;font-weight:700;margin-top:8px;">✓ Within Normal Range</div>
            <p style="color:#16a34a;font-size:0.72rem;font-weight:600;margin:6px 0 0;">Status: Normal</p>
          </div>
        </td>
        <td width="50%" style="padding:0 0 16px 8px;">
          <div style="background:#f0fdff;border:2px solid #06b6d4;border-radius:14px;padding:20px 16px;text-align:center;">
            <div style="font-size:1.4rem;margin-bottom:4px;">💧</div>
            <p style="color:#9ca3af;font-size:0.7rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:0 0 6px;">Humidity</p>
            <p style="color:#0891b2;font-size:2.4rem;font-weight:800;margin:0;line-height:1;">${currentHum.toFixed(1)}%</p>
            <div style="display:inline-block;background:#0891b2;color:white;border-radius:20px;padding:3px 12px;font-size:0.72rem;font-weight:700;margin-top:8px;">▲ +${exceededBy}% over limit</div>
            <p style="color:#0891b2;font-size:0.72rem;font-weight:600;margin:6px 0 0;">Threshold: ${threshold}%</p>
          </div>
        </td>
      </tr></table>
    </div>
    <div style="background:#ffffff;padding:4px 28px 20px;">
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">📍 Location</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">${LOCATION_NAME}</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">🏭 Device</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">${device}</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">🕐 Alert Time</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">${time}</td>
        </tr>
        <tr>
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">⏰ Next Alert</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">After 1 hour cooldown</td>
        </tr>
      </table>
    </div>
    <div style="background:#ffffff;padding:0 28px 28px;text-align:center;">
      <a href="${DASHBOARD_URL}" target="_blank" style="display:inline-block;background:linear-gradient(135deg,#06b6d4,#3b82f6);color:white;text-decoration:none;padding:13px 32px;border-radius:10px;font-size:0.9rem;font-weight:700;box-shadow:0 4px 14px rgba(6,182,212,0.4);">📊 Open Live Dashboard →</a>
      <p style="color:#94a3b8;font-size:0.75rem;margin:10px 0 0;">${DASHBOARD_URL}</p>
    </div>
    <div style="background:#ecfeff;border-top:1px solid #a5f3fc;padding:14px 28px;text-align:center;">
      <p style="color:#0891b2;font-size:0.75rem;font-weight:600;margin:0;">Factory Monitor Pro · Aquarelle Clothing Ltd · ${LOCATION_NAME}</p>
    </div>
  </div>`;
}

function testEmailHTML(recipients, time) {
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:540px;margin:0 auto;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.14);">
    <div style="background:linear-gradient(135deg,#10b981,#3b82f6);padding:32px 28px 24px;text-align:center;">
      <div style="font-size:2.8rem;margin-bottom:6px;">✅</div>
      <h1 style="color:white;margin:0 0 4px;font-size:1.4rem;font-weight:700;">Email Config Working!</h1>
      <p style="color:rgba(255,255,255,0.85);margin:0;font-size:0.85rem;">Factory Monitor Pro — Test Email</p>
    </div>
    <div style="background:#ffffff;padding:28px;">
      <div style="background:#f0fdf4;border:2px solid #bbf7d0;border-radius:14px;padding:22px;text-align:center;margin-bottom:20px;">
        <p style="color:#16a34a;font-size:1.05rem;font-weight:700;margin:0 0 6px;">🎉 Alert system is ready!</p>
        <p style="color:#64748b;font-size:0.875rem;margin:0;">You will receive Temperature and Humidity alerts whenever thresholds are exceeded.</p>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">📍 Location</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">${LOCATION_NAME}</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">📧 Sent To</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">${recipients}</td>
        </tr>
        <tr>
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">🕐 Sent At</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">${time}</td>
        </tr>
      </table>
    </div>
    <div style="background:#ffffff;padding:0 28px 28px;text-align:center;">
      <a href="${DASHBOARD_URL}" target="_blank" style="display:inline-block;background:linear-gradient(135deg,#10b981,#3b82f6);color:white;text-decoration:none;padding:13px 32px;border-radius:10px;font-size:0.9rem;font-weight:700;box-shadow:0 4px 14px rgba(16,185,129,0.35);">📊 Open Live Dashboard →</a>
      <p style="color:#94a3b8;font-size:0.75rem;margin:10px 0 0;">${DASHBOARD_URL}</p>
    </div>
    <div style="background:#f0fdf4;border-top:1px solid #bbf7d0;padding:14px 28px;text-align:center;">
      <p style="color:#16a34a;font-size:0.75rem;font-weight:600;margin:0;">Factory Monitor Pro · Aquarelle Clothing Ltd · ${LOCATION_NAME}</p>
    </div>
  </div>`;
}

function testAlertEmailHTML(device, temp, hum, tempThreshold, humThreshold, time) {
  const tempExceeded = temp > tempThreshold;
  const humExceeded  = hum  > humThreshold;

  const headerGradient = (tempExceeded && humExceeded) ? 'linear-gradient(135deg,#ef4444,#f97316)'
    : tempExceeded ? 'linear-gradient(135deg,#ef4444,#f97316)'
    : humExceeded  ? 'linear-gradient(135deg,#06b6d4,#3b82f6)'
    : 'linear-gradient(135deg,#10b981,#3b82f6)';

  const headerIcon  = (tempExceeded && humExceeded) ? '⚠️' : tempExceeded ? '🌡️' : humExceeded ? '💧' : '✅';
  const headerTitle = (tempExceeded && humExceeded) ? 'Temp & Humidity Alert'
    : tempExceeded ? 'Temperature Alert'
    : humExceeded  ? 'Humidity Alert'
    : 'All Values Normal — Test Email';

  const tempCard = tempExceeded ? {
    bg: '#fff5f5', border: '#ef4444', valueColor: '#ef4444', badgeBg: '#ef4444',
    badge: `▲ +${(temp - tempThreshold).toFixed(1)}°C over limit`,
    note: `Threshold: ${tempThreshold}°C`, noteColor: '#ef4444'
  } : {
    bg: '#f0fdf4', border: '#22c55e', valueColor: '#16a34a', badgeBg: '#22c55e',
    badge: '✓ Within Normal Range', note: 'Status: Normal', noteColor: '#16a34a'
  };

  const humCard = humExceeded ? {
    bg: '#f0fdff', border: '#06b6d4', valueColor: '#0891b2', badgeBg: '#0891b2',
    badge: `▲ +${(hum - humThreshold).toFixed(1)}% over limit`,
    note: `Threshold: ${humThreshold}%`, noteColor: '#0891b2'
  } : {
    bg: '#f0fdf4', border: '#22c55e', valueColor: '#16a34a', badgeBg: '#22c55e',
    badge: '✓ Within Normal Range', note: 'Status: Normal', noteColor: '#16a34a'
  };

  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:540px;margin:0 auto;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.14);">
    <div style="background:${headerGradient};padding:32px 28px 24px;text-align:center;">
      <div style="font-size:2.8rem;margin-bottom:6px;">${headerIcon}</div>
      <h1 style="color:white;margin:0 0 4px;font-size:1.4rem;font-weight:700;">${headerTitle}</h1>
      <p style="color:rgba(255,255,255,0.85);margin:0;font-size:0.85rem;">Factory Monitor Pro — ${device}</p>
      <div style="display:inline-block;background:rgba(255,255,255,0.2);color:white;border-radius:20px;padding:4px 14px;font-size:0.75rem;font-weight:700;margin-top:8px;">📍 ${LOCATION_NAME}</div>
    </div>
    <div style="background:#f8fafc;padding:24px 20px 8px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="50%" style="padding:0 8px 16px 0;">
          <div style="background:${tempCard.bg};border:2px solid ${tempCard.border};border-radius:14px;padding:20px 14px;text-align:center;">
            <div style="font-size:1.6rem;margin-bottom:4px;">🌡️</div>
            <p style="color:#9ca3af;font-size:0.68rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:0 0 6px;">Temperature</p>
            <p style="color:${tempCard.valueColor};font-size:2.2rem;font-weight:800;margin:0;line-height:1;">${temp.toFixed(1)}°C</p>
            <div style="display:inline-block;background:${tempCard.badgeBg};color:white;border-radius:20px;padding:3px 10px;font-size:0.70rem;font-weight:700;margin-top:8px;">${tempCard.badge}</div>
            <p style="color:${tempCard.noteColor};font-size:0.70rem;font-weight:600;margin:6px 0 0;">${tempCard.note}</p>
          </div>
        </td>
        <td width="50%" style="padding:0 0 16px 8px;">
          <div style="background:${humCard.bg};border:2px solid ${humCard.border};border-radius:14px;padding:20px 14px;text-align:center;">
            <div style="font-size:1.6rem;margin-bottom:4px;">💧</div>
            <p style="color:#9ca3af;font-size:0.68rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:0 0 6px;">Humidity</p>
            <p style="color:${humCard.valueColor};font-size:2.2rem;font-weight:800;margin:0;line-height:1;">${hum.toFixed(1)}%</p>
            <div style="display:inline-block;background:${humCard.badgeBg};color:white;border-radius:20px;padding:3px 10px;font-size:0.70rem;font-weight:700;margin-top:8px;">${humCard.badge}</div>
            <p style="color:${humCard.noteColor};font-size:0.70rem;font-weight:600;margin:6px 0 0;">${humCard.note}</p>
          </div>
        </td>
      </tr></table>
    </div>
    <div style="background:#ffffff;padding:4px 28px 20px;">
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">📍 Location</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">${LOCATION_NAME}</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">🏭 Device</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">${device}</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">🕐 Alert Time</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">${time}</td>
        </tr>
        <tr>
          <td style="padding:11px 4px;color:#64748b;font-weight:600;">⏰ Next Alert</td>
          <td style="padding:11px 4px;color:#1e293b;font-weight:700;text-align:right;">After 1 hour cooldown</td>
        </tr>
      </table>
    </div>
    <div style="background:#ffffff;padding:0 28px 28px;text-align:center;">
      <a href="${DASHBOARD_URL}" target="_blank" style="display:inline-block;background:${headerGradient};color:white;text-decoration:none;padding:13px 32px;border-radius:10px;font-size:0.9rem;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,0.15);">📊 Open Live Dashboard →</a>
      <p style="color:#94a3b8;font-size:0.72rem;margin:10px 0 0;">${DASHBOARD_URL}</p>
    </div>
    <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:14px 28px;text-align:center;">
      <p style="color:#64748b;font-size:0.75rem;font-weight:600;margin:0;">Factory Monitor Pro · Aquarelle Clothing Ltd · ${LOCATION_NAME}</p>
    </div>
  </div>`;
}

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
    const deviceId = req.query.deviceId || 'Meter_01';
    const records  = await SensorData.find({ deviceId }).sort({ timestamp: -1 }).limit(1);
    res.json(records[0] || {});
  } catch (err) { res.status(500).send('Error'); }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge running on port ${PORT}`)); 