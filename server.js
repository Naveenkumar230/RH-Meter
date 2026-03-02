const express  = require('express');
const mongoose = require('mongoose');
const cron     = require('node-cron');
const axios    = require('axios');
const cors     = require('cors');
const { Resend } = require('resend');

const app = express();

// ── CORS ─────────────────────────────────────────────────────
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

// ── MongoDB ──────────────────────────────────────────────────
mongoose.connect("mongodb+srv://factory_admin:factory_admin1234@cluster0.zk0gm.mongodb.net/FactoryData?retryWrites=true&w=majority")
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

// ── Schemas ──────────────────────────────────────────────────
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

// ── Seed defaults ────────────────────────────────────────────
mongoose.connection.once('open', async () => {
  try {
    const existing = await Settings.findOne({ key: 'global' });
    if (!existing) {
      await Settings.create({ key: 'global', tempThreshold: 35, humThreshold: 70, recipients: '' });
      console.log('✅ Default settings seeded');
    }
  } catch (err) { console.error('❌ Seed error:', err.message); }
});

// ── Cooldown helpers ─────────────────────────────────────────
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

// ── Email Templates ──────────────────────────────────────────
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
    <div style="background:#fff;padding:28px 28px 0;">
      <div style="background:#fff5f5;border:1px solid #fecaca;border-radius:12px;padding:24px;text-align:center;">
        <p style="color:#9ca3af;font-size:0.75rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:0 0 6px;">Current Temperature</p>
        <p style="color:#ef4444;font-size:3.2rem;font-weight:800;margin:0;line-height:1;">${currentTemp.toFixed(1)}°C</p>
        <div style="display:inline-block;background:#ef4444;color:white;border-radius:20px;padding:4px 14px;font-size:0.78rem;font-weight:700;margin-top:10px;">
          ▲ ${exceededBy}°C above threshold
        </div>
      </div>
    </div>
    <div style="background:#fff;padding:20px 28px;">
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:12px 4px;color:#64748b;font-weight:600;">⚠️ Threshold</td>
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
    <div style="background:#fff;padding:28px 28px 0;">
      <div style="background:#f0fdff;border:1px solid #a5f3fc;border-radius:12px;padding:24px;text-align:center;">
        <p style="color:#9ca3af;font-size:0.75rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:0 0 6px;">Current Humidity</p>
        <p style="color:#0891b2;font-size:3.2rem;font-weight:800;margin:0;line-height:1;">${currentHum.toFixed(1)}%</p>
        <div style="display:inline-block;background:#0891b2;color:white;border-radius:20px;padding:4px 14px;font-size:0.78rem;font-weight:700;margin-top:10px;">
          ▲ ${exceededBy}% above threshold
        </div>
      </div>
    </div>
    <div style="background:#fff;padding:20px 28px;">
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:12px 4px;color:#64748b;font-weight:600;">⚠️ Threshold</td>
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
    <div style="background:#fff;padding:28px;">
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:24px;text-align:center;">
        <p style="color:#16a34a;font-size:1rem;font-weight:700;margin:0 0 8px;">Your alert system is ready! 🎉</p>
        <p style="color:#64748b;font-size:0.875rem;margin:0;">Temperature & Humidity alerts will fire when thresholds are exceeded.</p>
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

// ── Core email sender (Resend HTTPS — works on Render free) ──
async function sendAlertEmail(subject, htmlBody) {
  try {
    const settings     = await Settings.findOne({ key: 'global' });
    const recipientStr = (settings && settings.recipients) || '';
    const recipients   = recipientStr.split(',').map(e => e.trim()).filter(Boolean);

    if (!recipients.length) {
      console.warn('⚠️  No recipients configured');
      return { ok: false, error: 'No recipients configured' };
    }

    const apiKey = process.env.RESEND_API_KEY || 're_RbrVuset_9xsKwycFfn4yRpFNYvx7F8sL';
    const resend  = new Resend(apiKey);

    console.log(`📧 Sending "${subject}" → ${recipients.join(', ')}`);

    const { data, error } = await resend.emails.send({
      from:    'Factory Monitor Pro <onboarding@resend.dev>',
      to:      recipients,
      subject: subject,
      html:    htmlBody,
    });

    if (error) { console.error('❌ Resend error:', error); return { ok: false, error: error.message }; }
    console.log(`✅ Email sent → Resend ID: ${data.id}`);
    return { ok: true, id: data.id };

  } catch (err) {
    console.error('❌ Email exception:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Alert checker ────────────────────────────────────────────
async function checkAndAlert(record) {
  try {
    const settings = await Settings.findOne({ key: 'global' });
    if (!settings) { console.warn('⚠️ No settings in DB'); return; }

    const device = record.deviceId || 'Meter_01';

    // Temperature check
    if (record.temperature != null) {
      console.log(`🔍 Temp: ${record.temperature}°C  vs  threshold: ${settings.tempThreshold}°C`);
      if (record.temperature > settings.tempThreshold) {
        const key = `${device}_temp`;
        if (await canSendAlert(key)) {
          await markAlertSent(key);
          console.log(`🌡️  ALERT TRIGGERED — temp exceeded for ${device}`);
          await sendAlertEmail(
            `🌡️ Temperature Alert — ${device} (${record.temperature.toFixed(1)}°C)`,
            tempEmailHTML(device, record.temperature, settings.tempThreshold)
          );
        } else { console.log(`⏳ Temp cooldown active for ${device}`); }
      } else { console.log(`✅ Temp within limit`); }
    }

    // Humidity check
    if (record.humidity != null) {
      console.log(`🔍 Hum: ${record.humidity}%  vs  threshold: ${settings.humThreshold}%`);
      if (record.humidity > settings.humThreshold) {
        const key = `${device}_hum`;
        if (await canSendAlert(key)) {
          await markAlertSent(key);
          console.log(`💧  ALERT TRIGGERED — hum exceeded for ${device}`);
          await sendAlertEmail(
            `💧 Humidity Alert — ${device} (${record.humidity.toFixed(1)}%)`,
            humEmailHTML(device, record.humidity, settings.humThreshold)
          );
        } else { console.log(`⏳ Hum cooldown active for ${device}`); }
      } else { console.log(`✅ Hum within limit`); }
    }

  } catch (err) { console.error('❌ Alert check error:', err.message); }
}

// ── Keep-alive ping (prevents Render free tier sleep) ────────
cron.schedule('*/10 * * * *', async () => {
  try { await axios.get('https://rh-meter-bridge.onrender.com/'); console.log('⚡ Self-ping OK'); }
  catch (e) { console.error('Self-ping failed:', e.message); }
});

// ════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.send('🚀 Factory Monitor Bridge is running ✅'));

// ── Save sensor data + trigger alert check ───────────────────
app.post('/save-data', async (req, res) => {
  try {
    const data = { ...req.body, deviceId: req.body.deviceId || 'Meter_01' };
    await new SensorData(data).save();
    console.log('💾 Saved:', data);
    await checkAndAlert(data);
    res.status(200).send('Saved');
  } catch (err) { console.error('❌ Save Error:', err); res.status(500).send('Error'); }
});

// ── Latest sensor reading ────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'Meter_01';
    const records  = await SensorData.find({ deviceId }).sort({ timestamp: -1 }).limit(1);
    res.json(records[0] || {});
  } catch (err) { res.status(500).send('Error'); }
});

// ── Get settings ─────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    let s = await Settings.findOne({ key: 'global' });
    if (!s) s = await Settings.create({ key: 'global' });
    res.json({
      tempThreshold: s.tempThreshold,
      humThreshold:  s.humThreshold,
      recipients:    s.recipients,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Save settings ────────────────────────────────────────────
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

// ── Send test email ──────────────────────────────────────────
app.post('/api/test-email', async (req, res) => {
  try {
    const settings   = await Settings.findOne({ key: 'global' });
    let recipientStr = (req.body.recipients || (settings && settings.recipients) || '').trim();

    if (!recipientStr) {
      return res.status(400).json({ ok: false, error: 'No recipients. Add at least one email and save settings first.' });
    }

    const apiKey = process.env.RESEND_API_KEY || 're_RbrVuset_9xsKwycFfn4yRpFNYvx7F8sL';
    const resend  = new Resend(apiKey);

    const recipients = recipientStr.split(',').map(e => e.trim()).filter(Boolean);
    const time       = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    console.log('📧 Test email → recipients:', recipients);

    const { data, error } = await resend.emails.send({
      from:    'Factory Monitor Pro <onboarding@resend.dev>',
      to:      recipients,
      subject: '✅ Factory Monitor Pro — Test Email',
      html:    testEmailHTML(recipientStr, time),
    });

    if (error) { console.error('❌ Resend error:', error); return res.status(500).json({ ok: false, error: error.message }); }

    console.log('✅ Test email sent → ID:', data.id);
    res.json({ ok: true, id: data.id });

  } catch (err) {
    console.error('❌ Test email exception:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Reset cooldowns (for testing) ────────────────────────────
app.post('/api/reset-cooldown', async (req, res) => {
  try {
    await AlertCooldown.deleteMany({});
    console.log('✅ Cooldowns reset');
    res.json({ ok: true, message: 'All cooldowns cleared. Next threshold breach will fire immediately.' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Debug ─────────────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  const s = await Settings.findOne({ key: 'global' });
  const cooldowns = await AlertCooldown.find({});
  res.json({
    recipients:    s?.recipients,
    tempThreshold: s?.tempThreshold,
    humThreshold:  s?.humThreshold,
    resendKeySet:  !!(process.env.RESEND_API_KEY || 're_RbrVuset_9xsKwycFfn4yRpFNYvx7F8sL'),
    cooldowns:     cooldowns,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge running on port ${PORT}`));