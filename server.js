const express  = require('express');
const mongoose = require('mongoose');
const cron     = require('node-cron');
const axios    = require('axios');
const cors     = require('cors');
const https    = require('https');
const mqtt     = require('mqtt');

// ── Constants ─────────────────────────────────────────────────
const DASHBOARD_URL = 'https://rh-meter-bridge.onrender.com';
const LOCATION_NAME = 'CT-PAT Area';
const SENDER_EMAIL  = 'naveenkumarak2002@gmail.com';
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const app = express();

// ── In-memory stores ──────────────────────────────────────────
const lastSaveTime   = {};  // { Meter_01: timestamp, Meter_02: timestamp, ... }
const latestReadings = {};  // { Meter_01: { temp, hum, ... }, ... }

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

// ── Default page → home.html ──────────────────────────────────
app.get('/', (req, res) => res.sendFile(__dirname + '/home.html'));

app.use(express.static('.'));

// ── MongoDB ───────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI || "mongodb+srv://factory_admin:factory_admin1234@cluster0.zk0gm.mongodb.net/FactoryData?retryWrites=true&w=majority")
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

// ── Schemas ───────────────────────────────────────────────────
const SensorData = mongoose.model('SensorData', new mongoose.Schema({
  deviceId:    { type: String, default: 'Meter_02' },
  temperature: Number,
  humidity:    Number,
  tempLevel:   String,
  humLevel:    String,
  timestamp:   { type: Date, default: Date.now }
}), 'sensordatas');

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

// ── Device Names Schema ───────────────────────────────────────
// Stores user-friendly names for each device — globally shared
const DeviceNames = mongoose.model('DeviceNames', new mongoose.Schema({
  key:   { type: String, default: 'global', unique: true },
  names: { type: Object, default: {} }  // { "Meter_01": "CT-PAT Area", ... }
}, { timestamps: true }));

const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// ── Default device names ──────────────────────────────────────
const DEFAULT_NAMES = {
  "Meter_01": "Production Floor - A",
  "Meter_02": "CT-PAT Area",
  "Meter_03": "Quality Control Lab",
  "Meter_04": "Warehouse - North",
  "Meter_05": "Warehouse - South",
  "Meter_06": "Packaging Unit - 1",
  "Meter_07": "Packaging Unit - 2",
  "Meter_08": "Cold Storage - A",
  "Meter_09": "Cold Storage - B",
  "Meter_10": "Server Room",
  "Meter_11": "Assembly Line - 1",
  "Meter_12": "Assembly Line - 2",
  "Meter_13": "Dispatch Area"
};

// ── Seed defaults ─────────────────────────────────────────────
mongoose.connection.once('open', async () => {
  try {
    const existing = await Settings.findOne({ key: 'global' });
    if (!existing) {
      await Settings.create({ key: 'global', tempThreshold: 35, humThreshold: 70, recipients: '' });
      console.log('✅ Default settings seeded');
    }
    // Seed device names if not present
    const existingNames = await DeviceNames.findOne({ key: 'global' });
    if (!existingNames) {
      await DeviceNames.create({ key: 'global', names: DEFAULT_NAMES });
      console.log('✅ Default device names seeded');
    }
  } catch (err) { console.error('❌ Seed error:', err.message); }
});

// ════════════════════════════════════════════════════════════
//  HIVEMQ MQTT SUBSCRIBER
// ════════════════════════════════════════════════════════════
const HIVEMQ_URL   = process.env.MQTT_URL  || `mqtts://d034db44805b4258a6c72c3efe0f9019.s1.eu.hivemq.cloud:8883`;
const HIVEMQ_USER  = process.env.MQTT_USER || 'RH-METER';
const HIVEMQ_PASS  = process.env.MQTT_PASS || 'RH-METEr1234';
const HIVEMQ_TOPIC = 'AIPL/RH_Meter/+/telemetry';

function startHiveMQSubscriber() {
  console.log(`[HiveMQ] Attempting connection to: ${HIVEMQ_URL}`);

  const mqttClient = mqtt.connect(HIVEMQ_URL, {
    username:           HIVEMQ_USER,
    password:           HIVEMQ_PASS,
    clientId:           'server-bridge-' + Math.random().toString(16).slice(2, 8),
    rejectUnauthorized: true,
    reconnectPeriod:    5000,
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
      const payload  = JSON.parse(message.toString());
      const deviceId = topic.split('/')[2] || payload.id || 'Meter_02';
      const temp     = parseFloat(payload.temp);
      const hum      = parseFloat(payload.hum);

      if (isNaN(temp) || isNaN(hum)) {
        console.warn(`⚠️ [HiveMQ] Invalid payload from ${deviceId}:`, payload);
        return;
      }

      const record = {
        deviceId,
        temperature: temp,
        humidity:    hum,
        tempLevel:   temp <= 27 ? 'normal' : temp <= 35 ? 'warning' : 'critical',
        humLevel:    hum < 40   ? 'critical' : hum <= 70 ? 'normal' : 'critical'
      };

      // ── Always update live cache (for dashboard real-time display) ──
      latestReadings[deviceId] = { ...record, timestamp: new Date() };

      // ── Always check alerts on every reading ──
      await checkAndAlert(record);

      // ── Save to MongoDB only every 30 minutes per device ──
      const now        = Date.now();
      const lastSaved  = lastSaveTime[deviceId] || 0;
      const THIRTY_MIN = 30 * 60 * 1000;

      if (now - lastSaved >= THIRTY_MIN) {
        lastSaveTime[deviceId] = now;
        await new SensorData(record).save();
        console.log(`💾 [HiveMQ] Saved ${deviceId}: T=${temp}°C, H=${hum}% (30min)`);
      } else {
        const minsLeft = Math.round((THIRTY_MIN - (now - lastSaved)) / 60000);
        console.log(`⏭️  [HiveMQ] Live only ${deviceId}: T=${temp}°C H=${hum}% (save in ${minsLeft}min)`);
      }

    } catch (err) {
      console.error('❌ [HiveMQ] Message Processing Error:', err.message);
    }
  });

  mqttClient.on('reconnect', () => console.log('🔄 [HiveMQ] Reconnecting...'));
  mqttClient.on('error',     (err) => {
    if (err.message.includes('Connection refused: Not authorized'))
      console.error('❌ [HiveMQ] AUTH ERROR: Check your HiveMQ Username/Password!');
    else
      console.error('❌ [HiveMQ] MQTT Error:', err.message);
  });
  mqttClient.on('offline', () => console.warn('⚠️ [HiveMQ] Client offline'));
}

mongoose.connection.once('open', () => { startHiveMQSubscriber(); });

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
  if (!apiKey) { console.error('❌ BREVO_API_KEY not set'); return { ok: false, error: 'BREVO_API_KEY not configured' }; }

  const payload = JSON.stringify({
    sender:      { name: 'RH-Meter Alert System', email: SENDER_EMAIL },
    to:          recipients.map(email => ({ email })),
    subject,
    htmlContent: htmlBody
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
      headers: {
        'accept': 'application/json', 'api-key': apiKey,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) { console.error('❌ Brevo error:', data); resolve({ ok: false, error: data }); }
        else { console.log('✅ Email sent via Brevo'); resolve({ ok: true }); }
      });
    });
    req.on('error', (err) => { console.error('❌ Brevo request error:', err.message); resolve({ ok: false, error: err.message }); });
    req.write(payload);
    req.end();
  });
}

async function sendAlertEmail(subject, htmlBody) {
  try {
    const settings     = await Settings.findOne({ key: 'global' });
    const recipientStr = (settings && settings.recipients) || '';
    const recipients   = recipientStr.split(',').map(e => e.trim()).filter(Boolean);
    if (!recipients.length) { console.warn('⚠️ No recipients configured'); return { ok: false, error: 'No recipients configured' }; }
    console.log(`📧 Sending "${subject}" → ${recipients.join(', ')}`);
    return await sendEmail(subject, htmlBody, recipients);
  } catch (err) { console.error('❌ Email exception:', err.message); return { ok: false, error: err.message }; }
}

// ── Location map (server-side) ────────────────────────────────
const LOCATION_MAP_SERVER = {
  Meter_01:'Samudra', Meter_02:'Samudra', Meter_03:'Samudra',
  Meter_04:'Samudra', Meter_05:'Samudra', Meter_06:'Samudra',
  Meter_07:'Samudra', Meter_08:'Samudra', Meter_09:'Samudra',
  Meter_10:'Samudra', Meter_11:'BNG',     Meter_12:'BNG',
  Meter_13:'BNG'
};

// ── Rich HTML email builder — Variation 4 Teal ───────────────
function buildAlertEmail({ deviceId, friendlyName, location, alertType, actualValue, threshold, unit, otherTemp, otherHum, tempThreshold, humThreshold, time, date, combined }) {
  const isTemp     = alertType === 'temperature';
  const dashUrl    = `https://rh-meter-bridge.onrender.com/index.html?id=${deviceId}`;
  const logoUrl    = `https://rh-meter-bridge.onrender.com/logo.png`;
  const unitColor  = location === 'Samudra' ? '#0891b2' : '#0f766e';
  const unitBg     = location === 'Samudra' ? 'rgba(8,145,178,0.12)' : 'rgba(15,118,110,0.12)';
  const unitBorder = location === 'Samudra' ? 'rgba(8,145,178,0.3)'  : 'rgba(15,118,110,0.3)';

  // Alert value block builder
  function alertBlock(type, value, limit, isAlert) {
    const col   = isAlert ? '#ef4444' : '#16a34a';
    const bg    = isAlert ? '#fef2f2' : '#f0fdf4';
    const bdr   = isAlert ? '#fecaca' : '#bbf7d0';
    const hdrBg = isAlert ? '#ef4444' : '#16a34a';
    const lbl   = type === 'temperature' ? '🌡️ Temperature' : '💧 Humidity';
    const u     = type === 'temperature' ? '°C' : '%';
    const status = isAlert ? 'ALERT 🚨' : 'NORMAL ✓';
    const excess  = isAlert ? `+${(value - limit).toFixed(1)}${u} over limit` : `${(limit - value).toFixed(1)}${u} below limit`;
    return `
      <div style="border:${isAlert ? '2px' : '1px'} solid ${bdr};border-radius:12px;overflow:hidden;">
        <div style="background:${hdrBg};padding:10px 16px;">
          <span style="font-size:12px;color:#fff;font-weight:800;text-transform:uppercase;letter-spacing:1px;">${lbl} · ${status}</span>
        </div>
        <div style="padding:18px;text-align:center;background:${bg};">
          <div style="font-size:${isAlert ? '50px' : '32px'};font-weight:900;color:${col};line-height:1;">${value.toFixed(1)}<span style="font-size:${isAlert ? '20px' : '14px'};">${u}</span></div>
          <div style="margin-top:10px;background:#fff;border-radius:8px;padding:8px 12px;">
            <table width="100%" style="font-size:12px;border-collapse:collapse;">
              <tr><td style="color:#64748b;text-align:left;">Threshold</td><td style="text-align:right;font-weight:700;color:#1e293b;">${limit}${u}</td></tr>
              <tr><td style="color:${col};text-align:left;padding-top:3px;font-weight:700;">${isAlert ? 'Exceeded By' : 'Safe Margin'}</td><td style="text-align:right;font-weight:800;color:${col};padding-top:3px;">${excess}</td></tr>
            </table>
          </div>
        </div>
      </div>`;
  }

  const tempIsAlert = otherTemp != null && tempThreshold != null && otherTemp > tempThreshold;
  const humIsAlert  = otherHum  != null && humThreshold  != null && otherHum  > humThreshold;

  // Build readings section
  let readingsHtml = '';
  if (combined) {
    // Both temp and hum shown side by side — alert one is BIG
    readingsHtml = `
      <table width="100%" style="border-collapse:collapse;">
        <tr>
          <td width="50%" valign="top" style="padding-right:10px;">
            ${alertBlock('temperature', otherTemp, tempThreshold, tempIsAlert)}
          </td>
          <td width="50%" valign="top" style="padding-left:10px;">
            ${alertBlock('humidity', otherHum, humThreshold, humIsAlert)}
          </td>
        </tr>
      </table>`;
  } else {
    // Single alert — alert BIG (55%), other SMALL (45%)
    const alertVal   = isTemp ? otherTemp : otherHum;
    const normalVal  = isTemp ? otherHum  : otherTemp;
    const alertLimit = isTemp ? tempThreshold : humThreshold;
    const normalLim  = isTemp ? humThreshold  : tempThreshold;
    const normalType = isTemp ? 'humidity' : 'temperature';
    readingsHtml = `
      <table width="100%" style="border-collapse:collapse;">
        <tr>
          <td width="56%" valign="top" style="padding-right:12px;">
            ${alertBlock(alertType, alertVal, alertLimit, true)}
          </td>
          <td width="44%" valign="top">
            ${alertBlock(normalType, normalVal, normalLim, false)}
          </td>
        </tr>
      </table>`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0fdfa;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdfa;padding:28px 16px;">
<tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #99f6e4;box-shadow:0 4px 24px rgba(0,0,0,0.07);">

  <!-- HEADER -->
  <tr><td style="background:linear-gradient(135deg,#0f766e,#0891b2);padding:24px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle">
        <img src="${logoUrl}" height="36" style="height:36px;vertical-align:middle;margin-right:10px;" alt="Logo">
        <span style="font-size:16px;font-weight:800;color:#ffffff;vertical-align:middle;">RH-Meter Alert System</span>
        <div style="font-size:11px;color:rgba(255,255,255,0.65);margin-top:5px;padding-left:46px;text-transform:uppercase;letter-spacing:1px;">Relative Humidity Monitoring System</div>
      </td>
      <td align="right" valign="top">
        <div style="background:#ef4444;color:#fff;padding:6px 14px;border-radius:6px;font-size:11px;font-weight:800;white-space:nowrap;">⚠️ THRESHOLD EXCEEDED</div>
      </td>
    </tr></table>
    <!-- Date Time Bar -->
    <div style="margin-top:14px;background:rgba(255,255,255,0.12);border-radius:8px;padding:10px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:12px;color:rgba(255,255,255,0.9);">📅 <b style="color:#fff;">${date}</b></td>
        <td align="center" style="font-size:12px;color:rgba(255,255,255,0.9);">🕐 <b style="color:#fff;">${time}</b></td>
        <td align="right" style="font-size:12px;color:#a5f3fc;">📍 <b>${friendlyName}</b></td>
      </tr></table>
    </div>
  </td></tr>

  <!-- DEVICE INFO -->
  <tr><td style="padding:22px 32px 0;">
    <table width="100%" style="border:1px solid #99f6e4;border-radius:10px;overflow:hidden;font-size:13px;border-collapse:collapse;">
      <tr style="background:#f0fdfa;">
        <td style="padding:8px 14px;color:#0f766e;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:1px;" colspan="4">Device Information</td>
      </tr>
      <tr style="border-top:1px solid #ccfbf1;">
        <td style="padding:10px 14px;color:#64748b;font-weight:600;width:22%;">Device ID</td>
        <td style="padding:10px 14px;font-weight:700;font-family:monospace;color:#1e293b;width:28%;">${deviceId}</td>
        <td style="padding:10px 14px;color:#64748b;font-weight:600;width:22%;">Location</td>
        <td style="padding:10px 14px;font-weight:700;color:#1e293b;width:28%;">${friendlyName}</td>
      </tr>
      <tr style="border-top:1px solid #ccfbf1;">
        <td style="padding:10px 14px;color:#64748b;font-weight:600;">Unit</td>
        <td style="padding:10px 14px;"><span style="background:${unitBg};color:${unitColor};border:1px solid ${unitBorder};padding:3px 10px;border-radius:6px;font-size:12px;font-weight:700;">${location}</span></td>
        <td style="padding:10px 14px;color:#64748b;font-weight:600;">Alert Time</td>
        <td style="padding:10px 14px;font-weight:600;color:#1e293b;font-size:12px;">${time}</td>
      </tr>
    </table>
  </td></tr>

  <!-- SENSOR READINGS -->
  <tr><td style="padding:18px 32px 0;">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#0f766e;margin-bottom:12px;">Sensor Readings</div>
    ${readingsHtml}
  </td></tr>

  <!-- CTA BUTTON -->
  <tr><td style="padding:22px 32px;text-align:center;">
    <a href="${dashUrl}" style="display:inline-block;background:linear-gradient(135deg,#0f766e,#0891b2);color:#ffffff;padding:13px 44px;border-radius:10px;font-size:14px;font-weight:700;text-decoration:none;">View Live Dashboard →</a>
    <div style="font-size:11px;color:#94a3b8;margin-top:8px;">Next alert for this device after 1 hour cooldown</div>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="padding:16px 32px;background:#f0fdfa;border-top:1px solid #99f6e4;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle">
        <img src="${logoUrl}" height="22" style="height:22px;vertical-align:middle;margin-right:8px;" alt="Logo">
        <span style="font-size:13px;color:#0f766e;font-weight:700;vertical-align:middle;">Aquarelle India Pvt. Ltd.</span>
      </td>
      <td align="right" style="font-size:11px;color:#94a3b8;">Automated Monitoring Alert</td>
    </tr></table>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Alert check ───────────────────────────────────────────────
async function checkAndAlert(record) {
  try {
    const settings = await Settings.findOne({ key: 'global' });
    if (!settings) { console.warn('⚠️ No settings in DB'); return; }

    const device   = record.deviceId || 'Meter_02';
    const temp     = record.temperature;
    const hum      = record.humidity;
    const location = LOCATION_MAP_SERVER[device] || 'Unknown';
    const now      = new Date();
    const time     = now.toLocaleTimeString('en-IN',  { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hour12:true });
    const date     = now.toLocaleDateString('en-IN',  { timeZone:'Asia/Kolkata', day:'numeric', month:'long', year:'numeric' });

    // Get friendly name from MongoDB
    let friendlyName = device;
    try {
      const namesDoc = await DeviceNames.findOne({ key: 'global' });
      if (namesDoc && namesDoc.names && namesDoc.names[device]) friendlyName = namesDoc.names[device];
    } catch (e) { /* fallback to deviceId */ }

    const tempBreached = temp != null && temp > settings.tempThreshold;
    const humBreached  = hum  != null && hum  > settings.humThreshold;
    const tempKey      = `${device}_temp`;
    const humKey       = `${device}_hum`;
    const canTemp      = tempBreached && await canSendAlert(tempKey);
    const canHum       = humBreached  && await canSendAlert(humKey);

    // ── Combined alert: both breached at same time ────────────
    if (canTemp && canHum) {
      await markAlertSent(tempKey);
      await markAlertSent(humKey);
      const html = buildAlertEmail({
        deviceId: device, friendlyName, location,
        alertType: 'temperature', combined: true,
        actualValue: temp, threshold: settings.tempThreshold, unit: '°C',
        otherTemp: temp, otherHum: hum,
        tempThreshold: settings.tempThreshold, humThreshold: settings.humThreshold,
        time, date
      });
      await sendAlertEmail(
        `⚠️ Combined Alert — ${friendlyName} | Temp ${temp.toFixed(1)}°C & Humidity ${hum.toFixed(1)}% | ${location}`,
        html
      );
      console.log(`📧 Combined alert sent for ${device}`);
      return;
    }

    // ── Single temperature alert ──────────────────────────────
    if (canTemp) {
      await markAlertSent(tempKey);
      const html = buildAlertEmail({
        deviceId: device, friendlyName, location,
        alertType: 'temperature', combined: false,
        actualValue: temp, threshold: settings.tempThreshold, unit: '°C',
        otherTemp: temp, otherHum: hum,
        tempThreshold: settings.tempThreshold, humThreshold: settings.humThreshold,
        time, date
      });
      await sendAlertEmail(
        `⚠️ Temperature Alert — ${friendlyName} | ${temp.toFixed(1)}°C | ${location}`,
        html
      );
      console.log(`📧 Temp alert sent for ${device}`);
    } else if (tempBreached) {
      console.log(`⏳ Temp cooldown active for ${device}`);
    } else if (temp != null) {
      console.log(`✅ Temp OK for ${device}: ${temp}°C`);
    }

    // ── Single humidity alert ─────────────────────────────────
    if (canHum) {
      await markAlertSent(humKey);
      const html = buildAlertEmail({
        deviceId: device, friendlyName, location,
        alertType: 'humidity', combined: false,
        actualValue: hum, threshold: settings.humThreshold, unit: '%',
        otherTemp: temp, otherHum: hum,
        tempThreshold: settings.tempThreshold, humThreshold: settings.humThreshold,
        time, date
      });
      await sendAlertEmail(
        `⚠️ Humidity Alert — ${friendlyName} | ${hum.toFixed(1)}% | ${location}`,
        html
      );
      console.log(`📧 Hum alert sent for ${device}`);
    } else if (humBreached) {
      console.log(`⏳ Hum cooldown active for ${device}`);
    } else if (hum != null) {
      console.log(`✅ Hum OK for ${device}: ${hum}%`);
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

// ── Latest sensor reading ─────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'Meter_02';

    // ── Use in-memory cache first (always latest real-time value) ──
    if (latestReadings[deviceId]) {
      const r = latestReadings[deviceId];
      return res.json({
        temperature: r.temperature,
        humidity:    r.humidity,
        tempLevel:   r.tempLevel,
        humLevel:    r.humLevel,
        timestamp:   r.timestamp,
        deviceId:    r.deviceId
      });
    }

    // ── Fallback to MongoDB if server just restarted ──
    const record = await SensorData.findOne({ deviceId }).sort({ timestamp: -1 });
    if (!record) return res.json({});
    res.json({
      temperature: record.temperature,
      humidity:    record.humidity,
      tempLevel:   record.tempLevel,
      humLevel:    record.humLevel,
      timestamp:   record.timestamp,
      deviceId:    record.deviceId
    });
  } catch (err) { console.error('❌ /api/data error:', err); res.status(500).send('Error'); }
});

// ── Save sensor data (backward compatibility) ─────────────────
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
      .find({ deviceId, timestamp: { $gte: from, $lte: to } })
      .sort({ timestamp: 1 })
      .lean()
      .read('primary');

    console.log(`📦 [History] returning ${records.length} records`);

    res.json(records.map(r => ({
      timestamp: r.timestamp,
      temp:      r.temperature,
      hum:       r.humidity
    })));
  } catch (err) { console.error('❌ /api/history error:', err); res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════
//  NEW ENDPOINT — THRESHOLD BREACHES  (PRD 3.4)
//  GET /api/historical/threshold-breaches
//  Query params: from, to, tempThreshold, humThreshold
//  Returns: { deviceIds: ["Meter_02", "Meter_05", ...] }
//
//  Logic:
//  1. Query ALL devices in the date range
//  2. For each device, check if ANY record exceeded either threshold
//  3. Return only the deviceIds that had at least one breach
// ════════════════════════════════════════════════════════════
app.get('/api/historical/threshold-breaches', async (req, res) => {
  try {
    const from          = req.query.from ? new Date(req.query.from + 'T00:00:00.000Z') : new Date();
    const to            = req.query.to   ? new Date(req.query.to   + 'T23:59:59.999Z') : new Date();
    const tempThreshold = parseFloat(req.query.tempThreshold) || 35;
    const humThreshold  = parseFloat(req.query.humThreshold)  || 70;

    console.log(`🔍 [ThresholdBreaches] from=${from.toISOString()} to=${to.toISOString()} tempT=${tempThreshold} humT=${humThreshold}`);

    // Find all records in the date range where either threshold was breached
    // Use MongoDB aggregation to get unique deviceIds efficiently
    const breachedDevices = await SensorData.aggregate([
      {
        $match: {
          timestamp: { $gte: from, $lte: to },
          $or: [
            { temperature: { $gt: tempThreshold } },
            { humidity:    { $gt: humThreshold  } }
          ]
        }
      },
      {
        $group: { _id: '$deviceId' }
      },
      {
        $sort: { _id: 1 }
      }
    ]);

    const deviceIds = breachedDevices.map(d => d._id).filter(Boolean);
    console.log(`⚠️ [ThresholdBreaches] Found ${deviceIds.length} devices with breaches:`, deviceIds);

    res.json({ deviceIds, from: from.toISOString(), to: to.toISOString(), tempThreshold, humThreshold });
  } catch (err) {
    console.error('❌ /api/historical/threshold-breaches error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Device Names ──────────────────────────────────────────────
// GET /api/device-names → returns global device name map
app.get('/api/device-names', async (req, res) => {
  try {
    let doc = await DeviceNames.findOne({ key: 'global' });
    if (!doc) doc = await DeviceNames.create({ key: 'global', names: DEFAULT_NAMES });
    res.json({ names: doc.names });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/device-names → saves updated name map to MongoDB
app.post('/api/device-names', async (req, res) => {
  try {
    const { names } = req.body;
    if (!names || typeof names !== 'object') return res.status(400).json({ error: 'names object required' });
    const result = await DeviceNames.findOneAndUpdate(
      { key: 'global' },
      { $set: { names } },
      { upsert: true, new: true }
    );
    console.log('✅ Device names updated:', names);
    res.json({ ok: true, names: result.names });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const html       = `<p>✅ Test email from Factory Monitor Pro. Server time: ${time}</p>`;
    const result     = await sendEmail('✅ Factory Monitor Pro — Test Email', html, recipients);
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
    const recipients   = recipientStr.split(',').map(e => e.trim()).filter(Boolean);
    const html         = `<p>🔔 Test alert for ${deviceId}. T=${temp}°C, H=${hum}%</p>`;
    const result       = await sendEmail(`🔔 Test Alert — ${deviceId}`, html, recipients);
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
    broker: HIVEMQ_URL, topic: HIVEMQ_TOPIC,
    recipients: s?.recipients, tempThreshold: s?.tempThreshold, humThreshold: s?.humThreshold,
    brevoKeySet: !!(process.env.BREVO_API_KEY || BREVO_API_KEY),
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