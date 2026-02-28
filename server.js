const express    = require('express');
const mongoose   = require('mongoose');
const bodyParser = require('body-parser');
const cron       = require('node-cron');
const axios      = require('axios');
const nodemailer = require('nodemailer');
const cors       = require('cors');

const app = express();

// ── CORS ────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('.'));

// ── MongoDB ─────────────────────────────────────────────────
mongoose.connect("mongodb+srv://factory_admin:factory_admin1234@cluster0.zk0gm.mongodb.net/FactoryData?retryWrites=true&w=majority")
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

// ── Schemas ─────────────────────────────────────────────────
const SensorData = mongoose.model('SensorData', new mongoose.Schema({
  deviceId:    { type: String, default: 'Meter_01' },
  temperature: Number,
  humidity:    Number,
  tempLevel:   String,
  humLevel:    String,
  timestamp:   { type: Date, default: Date.now }
}));

const SettingsSchema = new mongoose.Schema({
  key:           { type: String, default: 'global', unique: true },
  tempThreshold: { type: Number, default: 35 },
  humThreshold:  { type: Number, default: 70 },
  recipients:    { type: String, default: '' },
  senderEmail:   { type: String, default: 'threedprinterdataaquarelle@gmail.com' },
  senderAppPass: { type: String, default: 'akqk cuwt tdmp myre' },
}, { timestamps: true });

const Settings = mongoose.model('Settings', SettingsSchema);

// ── Seed default settings ───────────────────────────────────
async function seedSettings() {
  try {
    const existing = await Settings.findOne({ key: 'global' });
    if (!existing) {
      await Settings.create({
        key:           'global',
        tempThreshold: 35,
        humThreshold:  70,
        recipients:    '',
        senderEmail:   'threedprinterdataaquarelle@gmail.com',
        senderAppPass: 'akqk cuwt tdmp myre',
      });
      console.log('✅ Default settings seeded');
    } else {
      if (!existing.senderEmail || !existing.senderAppPass) {
        await Settings.findOneAndUpdate(
          { key: 'global' },
          { $set: {
            senderEmail:   'threedprinterdataaquarelle@gmail.com',
            senderAppPass: 'akqk cuwt tdmp myre',
          }}
        );
        console.log('✅ Sender credentials updated');
      }
    }
  } catch (err) {
    console.error('❌ Seed error:', err.message);
  }
}

mongoose.connection.once('open', () => { seedSettings(); });

// ── Cooldown tracker ────────────────────────────────────────
const lastAlertSent = {};
const COOLDOWN_MS   = 60 * 60 * 1000; // 1 hour

// ── Email Templates ─────────────────────────────────────────
function tempEmailHTML(device, currentTemp, threshold) {
  const exceededBy = (currentTemp - threshold).toFixed(1);
  const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.12);">
    <div style="background:linear-gradient(135deg,#ef4444,#f97316);padding:32px 28px 24px;text-align:center;">
      <div style="font-size:2.5rem;">🌡️</div>
      <h1 style="color:white;margin:8px 0 4px;font-size:1.4rem;font-weight:700;">Temperature Alert</h1>
      <p style="color:rgba(255,255,255,0.85);margin:0;font-size:0.875rem;">Factory Monitor Pro — ${device}</p>
    </div>
    <div style="background:#ffffff;padding:28px 28px 0;">
      <div style="background:#fff5f5;border:1px solid #fecaca;border-radius:12px;padding:24px;text-align:center;">
        <p style="color:#9ca3af;font-size:0.75rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:0 0 6px;">Current Temperature</p>
        <p style="color:#ef4444;font-size:3.2rem;font-weight:800;margin:0;line-height:1;">${currentTemp.toFixed(1)}°C</p>
        <div style="display:inline-block;background:#ef4444;color:white;border-radius:20px;padding:4px 14px;font-size:0.78rem;font-weight:700;margin-top:10px;">
          ▲ ${exceededBy}°C above threshold
        </div>
      </div>
    </div>
    <div style="background:#ffffff;padding:20px 28px;">
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:12px 4px;color:#64748b;font-weight:600;">⚠️ Threshold Set</td>
          <td style="padding:12px 4px;color:#1e293b;font-weight:700;text-align:right;">${threshold} °C</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:12px 4px;color:#64748b;font-weight:600;">🏭 Device</td>
          <td style="padding:12px 4px;color:#1e293b;font-weight:700;text-align:right;">${device}</td>
        </tr>
        <tr>
          <td style="padding:12px 4px;color:#64748b;font-weight:600;">🕐 Time</td>
          <td style="padding:12px 4px;color:#1e293b;font-weight:700;text-align:right;">${time}</td>
        </tr>
      </table>
    </div>
    <div style="background:#fef2f2;border-top:1px solid #fecaca;padding:16px 28px;text-align:center;">
      <p style="color:#ef4444;font-size:0.78rem;font-weight:600;margin:0;">⏰ Next alert after 1 hour if condition persists</p>
      <p style="color:#9ca3af;font-size:0.72rem;margin:6px 0 0;">Factory Monitor Pro · Aquarelle Clothing Ltd</p>
    </div>
  </div>`;
}

function humEmailHTML(device, currentHum, threshold) {
  const exceededBy = (currentHum - threshold).toFixed(1);
  const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.12);">
    <div style="background:linear-gradient(135deg,#06b6d4,#3b82f6);padding:32px 28px 24px;text-align:center;">
      <div style="font-size:2.5rem;">💧</div>
      <h1 style="color:white;margin:8px 0 4px;font-size:1.4rem;font-weight:700;">Humidity Alert</h1>
      <p style="color:rgba(255,255,255,0.85);margin:0;font-size:0.875rem;">Factory Monitor Pro — ${device}</p>
    </div>
    <div style="background:#ffffff;padding:28px 28px 0;">
      <div style="background:#f0fdff;border:1px solid #a5f3fc;border-radius:12px;padding:24px;text-align:center;">
        <p style="color:#9ca3af;font-size:0.75rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:0 0 6px;">Current Humidity</p>
        <p style="color:#0891b2;font-size:3.2rem;font-weight:800;margin:0;line-height:1;">${currentHum.toFixed(1)}%</p>
        <div style="display:inline-block;background:#0891b2;color:white;border-radius:20px;padding:4px 14px;font-size:0.78rem;font-weight:700;margin-top:10px;">
          ▲ ${exceededBy}% above threshold
        </div>
      </div>
    </div>
    <div style="background:#ffffff;padding:20px 28px;">
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:12px 4px;color:#64748b;font-weight:600;">⚠️ Threshold Set</td>
          <td style="padding:12px 4px;color:#1e293b;font-weight:700;text-align:right;">${threshold} %</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:12px 4px;color:#64748b;font-weight:600;">🏭 Device</td>
          <td style="padding:12px 4px;color:#1e293b;font-weight:700;text-align:right;">${device}</td>
        </tr>
        <tr>
          <td style="padding:12px 4px;color:#64748b;font-weight:600;">🕐 Time</td>
          <td style="padding:12px 4px;color:#1e293b;font-weight:700;text-align:right;">${time}</td>
        </tr>
      </table>
    </div>
    <div style="background:#ecfeff;border-top:1px solid #a5f3fc;padding:16px 28px;text-align:center;">
      <p style="color:#0891b2;font-size:0.78rem;font-weight:600;margin:0;">⏰ Next alert after 1 hour if condition persists</p>
      <p style="color:#9ca3af;font-size:0.72rem;margin:6px 0 0;">Factory Monitor Pro · Aquarelle Clothing Ltd</p>
    </div>
  </div>`;
}

function testEmailHTML(recipients, time) {
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.12);">
    <div style="background:linear-gradient(135deg,#10b981,#3b82f6);padding:32px 28px 24px;text-align:center;">
      <div style="font-size:2.5rem;">✅</div>
      <h1 style="color:white;margin:8px 0 4px;font-size:1.4rem;font-weight:700;">Email Config Working!</h1>
      <p style="color:rgba(255,255,255,0.85);margin:0;font-size:0.875rem;">Factory Monitor Pro — Test Email</p>
    </div>
    <div style="background:#ffffff;padding:28px;">
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:24px;text-align:center;">
        <p style="color:#16a34a;font-size:1rem;font-weight:700;margin:0 0 8px;">Your alert system is ready!</p>
        <p style="color:#64748b;font-size:0.875rem;margin:0;">You will receive Temperature and Humidity alerts whenever thresholds are exceeded.</p>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;margin-top:16px;">
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:12px 4px;color:#64748b;font-weight:600;">📧 Sent To</td>
          <td style="padding:12px 4px;color:#1e293b;font-weight:700;text-align:right;">${recipients}</td>
        </tr>
        <tr>
          <td style="padding:12px 4px;color:#64748b;font-weight:600;">🕐 Sent At</td>
          <td style="padding:12px 4px;color:#1e293b;font-weight:700;text-align:right;">${time}</td>
        </tr>
      </table>
    </div>
    <div style="background:#f0fdf4;border-top:1px solid #bbf7d0;padding:16px 28px;text-align:center;">
      <p style="color:#16a34a;font-size:0.78rem;font-weight:600;margin:0;">Factory Monitor Pro · Aquarelle Clothing Ltd</p>
    </div>
  </div>`;
}

// ── Send Email core ─────────────────────────────────────────
async function sendAlertEmail(subject, htmlBody) {
  try {
    const settings = await Settings.findOne({ key: 'global' });

    const senderEmail  = (settings && settings.senderEmail)   || 'threedprinterdataaquarelle@gmail.com';
    const senderPass   = (settings && settings.senderAppPass) || 'akqk cuwt tdmp myre';
    const recipientStr = (settings && settings.recipients)    || '';

    const recipients = recipientStr.split(',').map(e => e.trim()).filter(Boolean);
    if (!recipients.length) {
      console.warn('⚠️  No recipients configured');
      return { ok: false, error: 'No recipients configured' };
    }

    console.log(`📧 Sending "${subject}" to: ${recipients.join(', ')}`);

    const transporter = nodemailer.createTransport({
      host:   'smtp.gmail.com',
      port:   587,
      secure: false,
      auth:   { user: senderEmail, pass: senderPass },
      tls:    { rejectUnauthorized: false },
      connectionTimeout: 15000,
      greetingTimeout:   15000,
      socketTimeout:     15000,
    });

    await transporter.verify();
    console.log('✅ SMTP verified');

    await transporter.sendMail({
      from:    `"Factory Monitor Pro" <${senderEmail}>`,
      to:      recipients.join(', '),
      subject,
      html:    htmlBody,
    });

    console.log(`✅ Email sent → ${recipients.join(', ')}`);
    return { ok: true };

  } catch (err) {
    console.error('❌ Email failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Alert checker — fires on every /save-data ───────────────
async function checkAndAlert(record) {
  try {
    const settings = await Settings.findOne({ key: 'global' });
    if (!settings) return;

    const now    = Date.now();
    const device = record.deviceId || 'Meter_01';

    // Temperature
    if (record.temperature != null) {
      const key      = `${device}_temp`;
      const lastSent = lastAlertSent[key] || 0;
      if (record.temperature > settings.tempThreshold && (now - lastSent) > COOLDOWN_MS) {
        lastAlertSent[key] = now;
        console.log(`🌡️ ALERT: ${record.temperature}°C > ${settings.tempThreshold}°C threshold`);
        await sendAlertEmail(
          `🌡️ Temperature Alert — ${device} (${record.temperature.toFixed(1)}°C)`,
          tempEmailHTML(device, record.temperature, settings.tempThreshold)
        );
      }
    }

    // Humidity
    if (record.humidity != null) {
      const key      = `${device}_hum`;
      const lastSent = lastAlertSent[key] || 0;
      if (record.humidity > settings.humThreshold && (now - lastSent) > COOLDOWN_MS) {
        lastAlertSent[key] = now;
        console.log(`💧 ALERT: ${record.humidity}% > ${settings.humThreshold}% threshold`);
        await sendAlertEmail(
          `💧 Humidity Alert — ${device} (${record.humidity.toFixed(1)}%)`,
          humEmailHTML(device, record.humidity, settings.humThreshold)
        );
      }
    }

  } catch (err) {
    console.error('❌ Alert check error:', err.message);
  }
}

// ── Keep-Alive Ping ─────────────────────────────────────────
cron.schedule('*/10 * * * *', async () => {
  try {
    await axios.get('https://rh-meter-bridge.onrender.com/');
    console.log('⚡ Self-ping OK');
  } catch (e) {
    console.error('Self-ping failed:', e.message);
  }
});

// ── Routes ──────────────────────────────────────────────────

app.get('/', (req, res) => res.send('Bridge is running ✅'));

app.post('/save-data', async (req, res) => {
  try {
    const data = { ...req.body, deviceId: req.body.deviceId || 'Meter_01' };
    await new SensorData(data).save();
    console.log("💾 Saved:", data);
    checkAndAlert(data);
    res.status(200).send("Saved");
  } catch (err) {
    console.error("❌ Save Error:", err);
    res.status(500).send("Error");
  }
});

app.get('/api/data', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'Meter_01';
    const records  = await SensorData.find({ deviceId }).sort({ timestamp: -1 }).limit(1);
    res.json(records[0] || {});
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    let s = await Settings.findOne({ key: 'global' });
    if (!s) s = await Settings.create({ key: 'global' });
    res.json({
      tempThreshold: s.tempThreshold,
      humThreshold:  s.humThreshold,
      recipients:    s.recipients,
      senderEmail:   s.senderEmail,
      appPassSet:    !!s.senderAppPass,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const allowed = ['tempThreshold', 'humThreshold', 'recipients', 'senderEmail', 'senderAppPass'];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    if (update.senderAppPass === '') delete update.senderAppPass;
    await Settings.findOneAndUpdate(
      { key: 'global' },
      { $set: update },
      { upsert: true, new: true }
    );
    console.log('✅ Settings updated:', update);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/test-email', async (req, res) => {
  try {
    const settings = await Settings.findOne({ key: 'global' });
    
    // Use recipients from request body first, fallback to DB
    const recipients = req.body.recipients || (settings && settings.recipients) || '';
    
    if (!recipients || recipients.trim() === '') {
      return res.status(400).json({ ok: false, error: 'No recipients configured' });
    }

    const senderEmail = (settings && settings.senderEmail) || 'threedprinterdataaquarelle@gmail.com';
    const senderPass  = (settings && settings.senderAppPass) || 'akqk cuwt tdmp myre';

    const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    console.log('📧 Test email → recipients:', recipients);
    console.log('📧 Sender:', senderEmail);
    console.log('📧 Pass length:', senderPass?.length);

    const transporter = nodemailer.createTransport({
      host:   'smtp.gmail.com',
      port:   587,
      secure: false,
      auth:   { user: senderEmail, pass: senderPass },
      tls:    { rejectUnauthorized: false },
      connectionTimeout: 15000,
      greetingTimeout:   15000,
      socketTimeout:     15000,
    });

    await transporter.verify();
    console.log('✅ SMTP verified for test email');

    await transporter.sendMail({
      from:    `"Factory Monitor Pro" <${senderEmail}>`,
      to:      recipients,
      subject: '✅ Factory Monitor Pro — Test Email',
      html:    testEmailHTML(recipients, time)
    });

    console.log('✅ Test email sent to:', recipients);
    res.json({ ok: true });

  } catch (err) {
    console.error('❌ Test email error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/debug-settings', async (req, res) => {
  const s = await Settings.findOne({ key: 'global' });
  res.json({
    senderEmail: s?.senderEmail,
    passLength:  s?.senderAppPass?.length,
    passStored:  s?.senderAppPass,
    recipients:  s?.recipients
  });
});

// ── Debug route ─────────────────────────────────────────────
app.get('/api/debug-email', async (req, res) => {
  try {
    const settings = await Settings.findOne({ key: 'global' });
    console.log('DEBUG — senderEmail:', settings.senderEmail);
    console.log('DEBUG — appPass length:', settings.senderAppPass?.length);
    console.log('DEBUG — recipients:', settings.recipients);
    console.log('DEBUG — tempThreshold:', settings.tempThreshold);
    console.log('DEBUG — humThreshold:', settings.humThreshold);

    const transporter = nodemailer.createTransport({
      host:   'smtp.gmail.com',
      port:   587,
      secure: false,
      auth:   { user: settings.senderEmail, pass: settings.senderAppPass },
      tls:    { rejectUnauthorized: false },
      connectionTimeout: 15000,
      greetingTimeout:   15000,
      socketTimeout:     15000,
    });

    await transporter.verify();
    const info = await transporter.sendMail({
      from:    `"Factory Monitor" <${settings.senderEmail}>`,
      to:      settings.recipients,
      subject: '✅ Debug Test Email',
      html:    '<p>Debug test from Factory Monitor Pro</p>'
    });

    console.log('✅ Debug email sent:', info.messageId);
    res.json({ ok: true, messageId: info.messageId, accepted: info.accepted });

  } catch(err) {
    console.error('❌ DEBUG ERROR:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge running on port ${PORT}`));