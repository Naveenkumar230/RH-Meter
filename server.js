const express  = require('express');
const mongoose = require('mongoose');
const cron     = require('node-cron');
const axios    = require('axios');
const cors     = require('cors');
const https    = require('https');
const mqtt     = require('mqtt');          // ← NEW: HiveMQ subscriber

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
// Change this line in your Schemas section
const SensorData = mongoose.model('SensorData', new mongoose.Schema({
  deviceId:    { type: String, default: 'Meter_02' },
  temperature: Number,
  humidity:    Number,
  tempLevel:   String,
  humLevel:    String,
  timestamp:   { type: Date, default: Date.now }
}), 'sensordatas'); // <--- ADD THIS 'sensordatas' string here

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

// ════════════════════════════════════════════════════════════
//  HIVEMQ MQTT SUBSCRIBER
// ════════════════════════════════════════════════════════════

// 1. Check if MQTT_URL exists in Render Env. 
// 2. If it does, we use it directly. 
// 3. If it doesn't, we build it from the host/port.
const HIVEMQ_URL = process.env.MQTT_URL || `mqtts://d034db44805b4258a6c72c3efe0f9019.s1.eu.hivemq.cloud:8883`;
const HIVEMQ_USER = process.env.MQTT_USER || 'RH-METER';
const HIVEMQ_PASS = process.env.MQTT_PASS || 'RH-METEr1234';
const HIVEMQ_TOPIC = 'AIPL/RH_Meter/+/telemetry';

function startHiveMQSubscriber() {
  console.log(`[HiveMQ] Attempting connection to: ${HIVEMQ_URL}`);

  const mqttClient = mqtt.connect(HIVEMQ_URL, {
    username:           HIVEMQ_USER,
    password:           HIVEMQ_PASS,
    clientId:           'server-bridge-' + Math.random().toString(16).slice(2, 8),
    rejectUnauthorized: true,     // Enforce TLS for HiveMQ Cloud
    reconnectPeriod:    5000,     // Auto-reconnect every 5s
    connectTimeout:     30000,
  });

  mqttClient.on('connect', () => {
    console.log('✅ [HiveMQ] Connected to broker successfully!');
    mqttClient.subscribe(HIVEMQ_TOPIC, { qos: 1 }, (err) => {
      if (err) console.error('❌ [HiveMQ] Subscribe failed:', err.message);
      else     console.log(`✅ [HiveMQ] Subscribed to all meters via: ${HIVEMQ_TOPIC}`);
    });
  });

mqttClient.on('message', async (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      
      const deviceId = topic.split('/')[2] || payload.id || 'Meter_02';

      const temp = parseFloat(payload.temp);
      const hum  = parseFloat(payload.hum);

      if (isNaN(temp) || isNaN(hum)) {
        console.warn(`⚠️ [HiveMQ] Invalid payload from ${deviceId}:`, payload);
        return;
      }

      const record = { 
        deviceId: deviceId, 
        temperature: temp,
        humidity: hum,
        tempLevel: temp <= 27 ? 'normal' : temp <= 35 ? 'warning' : 'critical',
        humLevel: hum < 40 ? 'critical' : hum <= 70 ? 'normal' : 'critical'  // ← Fix 3
      };

      await new SensorData(record).save();
      console.log(`💾 [HiveMQ] Saved ${deviceId}: T=${temp}°C, H=${hum}%`);
      await checkAndAlert(record);  // ← Fix 1

    } catch (err) {
      console.error('❌ [HiveMQ] Message Processing Error:', err.message);
    }
  });

  mqttClient.on('reconnect', () => console.log('🔄 [HiveMQ] Reconnecting...'));
  
  mqttClient.on('error', (err) => {
    if (err.message.includes('Connection refused: Not authorized')) {
      console.error('❌ [HiveMQ] AUTH ERROR: Check your HiveMQ Username/Password!');
    } else {
      console.error('❌ [HiveMQ] MQTT Error:', err.message);
    }
  });

  mqttClient.on('offline', () => console.warn('⚠️ [HiveMQ] Client offline'));
}

// Start subscriber after MongoDB is ready
mongoose.connection.once('open', () => {
  startHiveMQSubscriber();
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

// ── Brevo email sender ────────────────────────────────────────
async function sendEmail(subject, htmlBody, recipients) {
  const apiKey = process.env.BREVO_API_KEY || BREVO_API_KEY;

  if (!apiKey) {
    console.error('❌ BREVO_API_KEY is not set — skipping email');
    return { ok: false, error: 'BREVO_API_KEY not configured' };
  }

  const payload = JSON.stringify({
sender: { name: 'RH-Meter Alert System', email: SENDER_EMAIL },
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
        'api-key':        apiKey,
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
async function checkAndAlert(record) {
  try {
    const settings = await Settings.findOne({ key: 'global' });
    if (!settings) { console.warn('⚠️ No settings in DB'); return; }

    const device = record.deviceId || 'Meter_02';
    const temp   = record.temperature;
    const hum    = record.humidity;

    if (temp != null) {
      console.log(`🔍 Temp: ${temp}°C  vs  threshold: ${settings.tempThreshold}°C`);
      if (temp > settings.tempThreshold) {
        const key = `${device}_temp`;
        if (await canSendAlert(key)) {
          await markAlertSent(key);
          const html = await tempEmailHTML(device, temp, settings.tempThreshold, hum);
          await sendAlertEmail(`🌡️ Temperature Alert — ${device} (${temp.toFixed(1)}°C)`, html);
        } else { console.log(`⏳ Temp cooldown active`); }
      } else { console.log(`✅ Temp OK`); }
    }

    if (hum != null) {
      console.log(`🔍 Hum: ${hum}%  vs  threshold: ${settings.humThreshold}%`);
      if (hum > settings.humThreshold) {
        const key = `${device}_hum`;
        if (await canSendAlert(key)) {
          await markAlertSent(key);
          const html = await humEmailHTML(device, hum, settings.humThreshold, temp);
          await sendAlertEmail(`💧 Humidity Alert — ${device} (${hum.toFixed(1)}%)`, html);
        } else { console.log(`⏳ Hum cooldown active`); }
      } else { console.log(`✅ Hum OK`); }
    }
  } catch (err) { console.error('❌ Alert check error:', err.message); }
}

// ── Keep-alive ping ───────────────────────────────────────────
cron.schedule('*/10 * * * *', async () => {
  try { await axios.get('https://rh-meter-bridge.onrender.com/'); console.log('⚡ Self-ping OK'); }
  catch (e) { console.error('Self-ping failed:', e.message); }
});

// ════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.send('🚀 Factory Monitor Bridge (HiveMQ) is running ✅'));

// ── Latest sensor reading (used by app.js fetchCurrent) ──────
app.get('/api/data', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'Meter_02';
    const record   = await SensorData.findOne({ deviceId }).sort({ timestamp: -1 });
    if (!record) return res.json({});
    res.json({
      temperature: record.temperature,
      humidity:    record.humidity,
      tempLevel:   record.tempLevel,
      humLevel:    record.humLevel,
      timestamp:   record.timestamp,
      deviceId:    record.deviceId
    });
  } catch (err) {
    console.error('❌ /api/data error:', err);
    res.status(500).send('Error');
  }
});

// ── Save sensor data (kept for backward compatibility) ────────
app.post('/save-data', async (req, res) => {
  try {
    const data = { ...req.body, deviceId: req.body.deviceId || 'Meter_02' };
    await new SensorData(data).save();
    console.log('💾 Saved via HTTP:', data);
    await checkAndAlert(data);
    res.status(200).send('Saved');
  } catch (err) { console.error('❌ Save Error:', err); res.status(500).send('Error'); }
});

// ── History ───────────────────────────────────────────────────
app.get('/api/history', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'Meter_02';

    const from = req.query.from
      ? new Date(req.query.from + 'T00:00:00.000Z')
      : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');

    const to = req.query.to
      ? new Date(req.query.to + 'T23:59:59.999Z')
      : new Date(new Date().toISOString().slice(0, 10) + 'T23:59:59.999Z');

    console.log(`📅 [History] deviceId=${deviceId} from=${from.toISOString()} to=${to.toISOString()}`);

    const records = await SensorData
      .find({
        deviceId,
        timestamp: { $gte: from, $lte: to }
      })
      .sort({ timestamp: 1 })
      .lean()
      .read('primary');        // ← forces read from primary, bypasses cache

    console.log(`📦 [History] returning ${records.length} records`);

    res.json(records.map(r => ({
      timestamp: r.timestamp,
      temp:      r.temperature,
      hum:       r.humidity
    })));
  } catch (err) {
    console.error('❌ /api/history error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Settings ──────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    let s = await Settings.findOne({ key: 'global' });
    if (!s) s = await Settings.create({ key: 'global' });
    res.json({ tempThreshold: s.tempThreshold, humThreshold: s.humThreshold, recipients: s.recipients });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    res.json({ ok: true, settings: { tempThreshold: result.tempThreshold, humThreshold: result.humThreshold, recipients: result.recipients } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Test email ────────────────────────────────────────────────
app.post('/api/test-email', async (req, res) => {
  try {
    const settings   = await Settings.findOne({ key: 'global' });
    let recipientStr = (req.body.recipients || (settings && settings.recipients) || '').trim();
    if (!recipientStr) return res.status(400).json({ ok: false, error: 'No recipients configured' });
    const recipients = recipientStr.split(',').map(e => e.trim()).filter(Boolean);
    const time       = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const result     = await sendEmail('✅ Factory Monitor Pro — Test Email', testEmailHTML(recipientStr, time), recipients);
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Test alert email ──────────────────────────────────────────
app.post('/api/test-alert-email', async (req, res) => {
  try {
    const settings     = await Settings.findOne({ key: 'global' });
    if (!settings) return res.status(500).json({ ok: false, error: 'No settings in DB' });
    const recipientStr = (req.body.recipients || settings.recipients || '').trim();
    if (!recipientStr) return res.status(400).json({ ok: false, error: 'No recipients configured' });
    const deviceId     = req.body.deviceId || 'Meter_02';
    const latest       = await SensorData.findOne({ deviceId }).sort({ timestamp: -1 });
    const temp         = latest?.temperature ?? 36.5;
    const hum          = latest?.humidity    ?? 72.0;
    const time         = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const recipients   = recipientStr.split(',').map(e => e.trim()).filter(Boolean);
    const result       = await sendEmail(
      `🔔 Test Alert — ${LOCATION_NAME} | ${deviceId}`,
      testAlertEmailHTML(deviceId, temp, hum, settings.tempThreshold, settings.humThreshold, time),
      recipients
    );
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
    res.json({ ok: true, usedData: { temp, hum, deviceId } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Reset cooldowns ───────────────────────────────────────────
app.post('/api/reset-cooldown', async (req, res) => {
  try {
    await AlertCooldown.deleteMany({});
    res.json({ ok: true, message: 'All cooldowns cleared.' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Debug ─────────────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  const s         = await Settings.findOne({ key: 'global' });
  const cooldowns = await AlertCooldown.find({});
  res.json({
    broker: HIVEMQ_URL,
    topic:         HIVEMQ_TOPIC,
    recipients:    s?.recipients,
    tempThreshold: s?.tempThreshold,
    humThreshold:  s?.humThreshold,
    brevoKeySet:   !!(process.env.BREVO_API_KEY || BREVO_API_KEY),
    cooldowns,
  });
});

app.post('/api/send-raw-email', async (req, res) => {
  try {
    const { to, subject, html } = req.body;
    if (!to || !subject || !html) return res.status(400).json({ ok: false, error: 'Missing to / subject / html' });
    const recipients = to.split(',').map(e => e.trim()).filter(Boolean);
    const result     = await sendEmail(subject, html, recipients);
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge (HiveMQ) running on port ${PORT}`));