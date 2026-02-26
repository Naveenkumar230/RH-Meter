const express    = require('express');
const mongoose   = require('mongoose');
const bodyParser = require('body-parser');
const cron       = require('node-cron');
const axios      = require('axios');
const nodemailer = require('nodemailer');
const cors = require('cors');


app.use(cors());
// app.use(bodyParser.json());
// app.use(express.static('.'));
const app = express();

// ── CORS — allow all origins ────────────────────────────────
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

// ── MongoDB Connection ──────────────────────────────────────
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

// ── Seed default settings on first boot ─────────────────────
async function seedSettings() {
  try {
    const existing = await Settings.findOne({ key: 'global' });
    if (!existing) {
      await Settings.create({
  key:           'global',
  tempThreshold: 35,
  humThreshold:  70,
  recipients:    '',          // user fills this from the dashboard
  senderEmail:   'threedprinterdataaquarelle@gmail.com',
  senderAppPass: 'gpfw evgv celc nawl',
});
      console.log('✅ Default settings seeded to MongoDB');
    } else {
      // If existing but no sender creds, fill them in
      if (!existing.senderEmail || !existing.senderAppPass) {
        await Settings.findOneAndUpdate(
          { key: 'global' },
          {
            $set: {
              senderEmail:   'threedprinterdataaquarelle@gmail.com',
              senderAppPass: 'gpfw evgv celc nawl',
            }
          }
        );
        console.log('✅ Sender credentials updated in MongoDB');
      }
    }
  } catch (err) {
    console.error('❌ Seed error:', err.message);
  }
}

mongoose.connection.once('open', () => {
  seedSettings();
});

// ── Cooldown tracker ────────────────────────────────────────
const lastAlertSent = {};
const COOLDOWN_MS   = 60 * 60 * 1000; // 1 hour

async function sendAlertEmail(subject, htmlBody) {
  try {
    const settings = await Settings.findOne({ key: 'global' });

    const senderEmail = (settings && settings.senderEmail)   || 'threedprinterdataaquarelle@gmail.com';
    const senderPass  = (settings && settings.senderAppPass) || 'gpfw evgv celc nawl';
    const recipientStr= (settings && settings.recipients)    || '';

    const recipients = recipientStr.split(',').map(e => e.trim()).filter(Boolean);
    if (!recipients.length) {
      console.warn('⚠️  No recipients — add emails in dashboard');
      return { ok: false, error: 'No recipients configured' };
    }

    console.log(`📧 Attempting to send to: ${recipients.join(', ')}`);

 const transporter = nodemailer.createTransport({
  host:   'smtp.gmail.com',
  port:   587,
  secure: false,
  auth: {
    user: senderEmail,
    pass: senderPass,
  },
  tls: {
    rejectUnauthorized: false
  },
  connectionTimeout: 15000,
  greetingTimeout:   15000,
  socketTimeout:     15000,
});

    // Verify connection before sending
    await transporter.verify();
    console.log('✅ SMTP connection verified');

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

// ── Alert Checker ───────────────────────────────────────────
async function checkAndAlert(record) {
  try {
    const settings = await Settings.findOne({ key: 'global' });
    if (!settings) return;

    const now    = Date.now();
    const device = record.deviceId || 'Meter_01';

    // Temperature check
    if (record.temperature !== undefined && record.temperature !== null) {
      const tempKey  = `${device}_temp`;
      const lastSent = lastAlertSent[tempKey] || 0;

      if (record.temperature > settings.tempThreshold && (now - lastSent) > COOLDOWN_MS) {
        lastAlertSent[tempKey] = now;
        await sendAlertEmail(
          `🌡️ TEMPERATURE ALERT — ${device}`,
          `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;border:1px solid #fca5a5;border-radius:12px;background:#fff5f5;">
            <h2 style="color:#dc2626;margin-bottom:8px;">⚠️ Temperature Threshold Exceeded</h2>
            <p style="color:#7f1d1d;margin-bottom:20px;">An alert has been triggered on your Factory Monitor system.</p>
            <table style="width:100%;border-collapse:collapse;font-size:0.95rem;">
              <tr style="background:#fee2e2;">
                <td style="padding:10px 16px;font-weight:600;color:#991b1b;">Device</td>
                <td style="padding:10px 16px;color:#374151;">${device}</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;font-weight:600;color:#991b1b;">Current Temp</td>
                <td style="padding:10px 16px;color:#dc2626;font-weight:700;">${record.temperature.toFixed(1)} °C</td>
              </tr>
              <tr style="background:#fee2e2;">
                <td style="padding:10px 16px;font-weight:600;color:#991b1b;">Threshold</td>
                <td style="padding:10px 16px;color:#374151;">${settings.tempThreshold} °C</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;font-weight:600;color:#991b1b;">Exceeded By</td>
                <td style="padding:10px 16px;color:#dc2626;font-weight:700;">+${(record.temperature - settings.tempThreshold).toFixed(1)} °C</td>
              </tr>
              <tr style="background:#fee2e2;">
                <td style="padding:10px 16px;font-weight:600;color:#991b1b;">Time</td>
                <td style="padding:10px 16px;color:#374151;">${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}</td>
              </tr>
            </table>
            <p style="margin-top:20px;font-size:0.8rem;color:#9ca3af;">Next alert after 1 hour if condition persists.</p>
          </div>`
        );
      }
    }

    // Humidity check
    if (record.humidity !== undefined && record.humidity !== null) {
      const humKey   = `${device}_hum`;
      const lastSent = lastAlertSent[humKey] || 0;

      if (record.humidity > settings.humThreshold && (now - lastSent) > COOLDOWN_MS) {
        lastAlertSent[humKey] = now;
        await sendAlertEmail(
          `💧 HUMIDITY ALERT — ${device}`,
          `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;border:1px solid #67e8f9;border-radius:12px;background:#f0fdff;">
            <h2 style="color:#0891b2;margin-bottom:8px;">⚠️ Humidity Threshold Exceeded</h2>
            <p style="color:#164e63;margin-bottom:20px;">An alert has been triggered on your Factory Monitor system.</p>
            <table style="width:100%;border-collapse:collapse;font-size:0.95rem;">
              <tr style="background:#cffafe;">
                <td style="padding:10px 16px;font-weight:600;color:#155e75;">Device</td>
                <td style="padding:10px 16px;color:#374151;">${device}</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;font-weight:600;color:#155e75;">Current Humidity</td>
                <td style="padding:10px 16px;color:#0891b2;font-weight:700;">${record.humidity.toFixed(1)} %</td>
              </tr>
              <tr style="background:#cffafe;">
                <td style="padding:10px 16px;font-weight:600;color:#155e75;">Threshold</td>
                <td style="padding:10px 16px;color:#374151;">${settings.humThreshold} %</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;font-weight:600;color:#155e75;">Exceeded By</td>
                <td style="padding:10px 16px;color:#0891b2;font-weight:700;">+${(record.humidity - settings.humThreshold).toFixed(1)} %</td>
              </tr>
              <tr style="background:#cffafe;">
                <td style="padding:10px 16px;font-weight:600;color:#155e75;">Time</td>
                <td style="padding:10px 16px;color:#374151;">${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}</td>
              </tr>
            </table>
            <p style="margin-top:20px;font-size:0.8rem;color:#9ca3af;">Next alert after 1 hour if condition persists.</p>
          </div>`
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

// ── Health Check ────────────────────────────────────────────
app.get('/', (req, res) => res.send('Bridge is running ✅'));

// ── Save data ───────────────────────────────────────────────
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

// ── Get latest data ─────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'Meter_01';
    const records  = await SensorData.find({ deviceId }).sort({ timestamp: -1 }).limit(1);
    res.json(records[0] || {});
  } catch (err) {
    res.status(500).send("Error");
  }
});

// ── GET /api/settings ───────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    let settings = await Settings.findOne({ key: 'global' });
    if (!settings) settings = await Settings.create({ key: 'global' });
    res.json({
      tempThreshold: settings.tempThreshold,
      humThreshold:  settings.humThreshold,
      recipients:    settings.recipients,
      senderEmail:   settings.senderEmail,
      appPassSet:    !!settings.senderAppPass,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/settings ──────────────────────────────────────
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
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/test-email ────────────────────────────────────
app.post('/api/test-email', async (req, res) => {
  try {
    const result = await sendAlertEmail(
      '✅ Factory Monitor — Test Email',
      `<div style="font-family:sans-serif;padding:24px;border:1px solid #bbf7d0;border-radius:12px;background:#f0fdf4;">
        <h2 style="color:#16a34a;">✅ Email Configuration Working!</h2>
        <p style="color:#374151;margin-top:12px;">Your Factory Monitor Pro email alerts are configured correctly.</p>
        <p style="color:#6b7280;font-size:0.85rem;margin-top:16px;">Sent at: ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}</p>
      </div>`
    );

    if (result.ok) {
      res.json({ ok: true });
    } else {
      res.status(500).json({ ok: false, error: result.error });
    }
  } catch (err) {
    console.error('❌ Test email route error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


app.get('/api/debug-email', async (req, res) => {
  try {
    const settings = await Settings.findOne({ key: 'global' });
    console.log('DEBUG — senderEmail:', settings.senderEmail);
    console.log('DEBUG — appPass length:', settings.senderAppPass?.length);
    console.log('DEBUG — recipients:', settings.recipients);

    const transporter = nodemailer.createTransport({
      host:   'smtp.gmail.com',
      port:   587,
      secure: false,
      auth: {
        user: settings.senderEmail,
        pass: settings.senderAppPass,
      },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 15000,
      greetingTimeout:   15000,
      socketTimeout:     15000,
    });

    await transporter.verify();
    console.log('✅ SMTP verify passed');

    const info = await transporter.sendMail({
      from:    `"Factory Monitor" <${settings.senderEmail}>`,
      to:      settings.recipients,
      subject: '✅ Debug Test Email',
      html:    '<p>This is a debug test from Factory Monitor Pro</p>'
    });

    console.log('✅ Message sent:', info.messageId);
    res.json({ ok: true, messageId: info.messageId, accepted: info.accepted });

  } catch(err) {
    console.error('❌ DEBUG ERROR:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge running on port ${PORT}`));