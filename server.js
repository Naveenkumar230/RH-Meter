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
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));


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

const COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 hours

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
  Meter_01:'Samudra', Meter_02:'R&D',     Meter_03:'Samudra',
  Meter_04:'Samudra', Meter_05:'Samudra', Meter_06:'Samudra',
  Meter_07:'Samudra', Meter_08:'Samudra', Meter_09:'Samudra',
  Meter_10:'BNG',     Meter_11:'BNG',     Meter_12:'BNG',
  Meter_13:'BNG'
};

// ── Email Template — Navy Blue Template 1 Final ──────────────
function buildAlertEmail({ deviceId, friendlyName, location, alertType, actualValue, threshold, unit, otherTemp, otherHum, tempThreshold, humThreshold, time, date, combined }) {
  const dashUrl = `https://rh-meter-bridge.onrender.com/detail.html?id=${deviceId}`;

  const tempIsAlert = otherTemp != null && tempThreshold != null && otherTemp > tempThreshold;
  const humIsAlert  = otherHum  != null && humThreshold  != null && otherHum  > humThreshold;
  const tempExcess  = tempIsAlert ? `+${(otherTemp-tempThreshold).toFixed(1)}&deg;C over limit` : `${(tempThreshold-(otherTemp||0)).toFixed(1)}&deg;C below limit`;
  const humExcess   = humIsAlert  ? `+${(otherHum-humThreshold).toFixed(1)}% over limit`        : `${(humThreshold-(otherHum||0)).toFixed(1)}% below limit`;
  const alertLabel  = combined ? 'Multiple Parameters Exceeded'
    : alertType === 'temperature' ? 'Temperature Threshold Exceeded'
    : 'Humidity Threshold Exceeded';

  function readingBlock(type, value, lim, isAlert) {
    const u    = type === 'temperature' ? '&deg;C' : '%';
    const icon = type === 'temperature' ? '&#127777; Temperature' : '&#128167; Humidity';
    const ex   = type === 'temperature' ? tempExcess : humExcess;
    const bg   = isAlert ? '#fef2f2' : '#f0fdf4';
    const bdr  = isAlert ? '#fca5a5' : '#bbf7d0';
    const bdrW = isAlert ? '2px' : '1px';
    const hdr  = isAlert ? '#ef4444' : '#16a34a';
    const col  = isAlert ? '#ef4444' : '#16a34a';
    const sts  = isAlert ? '&#128680; ALERT' : '&#10003; NORMAL';
    const exl  = isAlert ? 'Exceeded By' : 'Safe Margin';
    const v    = value != null ? value.toFixed(1) : '--';
    return `
<td width="48%" valign="top" style="padding:4px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="border:${bdrW} solid ${bdr};border-radius:12px;overflow:hidden;">
    <tr><td style="background:${hdr};padding:11px 12px;text-align:center;
      font-size:11px;font-weight:700;color:#fff;text-transform:uppercase;
      letter-spacing:1px;">${icon} &middot; ${sts}</td></tr>
    <tr><td style="background:${bg};padding:18px 12px 6px;text-align:center;">
      <div style="font-size:48px;font-weight:900;color:${col};line-height:1;
        font-family:Arial,sans-serif;">${v}<span style="font-size:18px;">${u}</span></div>
    </td></tr>
    <tr><td style="background:${bg};padding:0 12px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="background:rgba(255,255,255,0.85);border-radius:8px;">
        <tr><td style="padding:7px 10px;font-size:12px;color:#64748b;">Threshold</td>
            <td style="padding:7px 10px;font-size:12px;font-weight:700;
              color:#1e293b;text-align:right;">${lim}${u}</td></tr>
        <tr style="border-top:1px solid rgba(0,0,0,0.06);">
            <td style="padding:7px 10px;font-size:12px;
              color:${col};font-weight:700;">${exl}</td>
            <td style="padding:7px 10px;font-size:12px;font-weight:800;
              color:${col};text-align:right;">${ex}</td></tr>
      </table>
    </td></tr>
  </table>
</td>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>RH-Meter Alert</title>
<style>
  body,table,td,p,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;margin:0;padding:0;}
  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
  @media only screen and (max-width:600px){
    .eb{padding:10px !important;}
    .hpad{padding:20px 16px 0 !important;}
    .dtbox{display:block !important;width:100% !important;
      border-right:none !important;
      border-bottom:1px solid rgba(255,255,255,0.15) !important;
      padding:16px !important;}
    .cpad{padding:14px 16px 0 !important;}
    .devrow td{display:block !important;width:100% !important;
      border-right:none !important;}
    .rc{display:block !important;width:100% !important;
      padding:0 0 10px 0 !important;}
    .rsp{display:none !important;}
    .btn{padding:13px 16px !important;font-size:14px !important;}
    .fp{padding:14px 16px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#e8edf5;
  font-family:'Segoe UI',Helvetica,Arial,sans-serif;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  class="eb" style="background:#e8edf5;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  style="max-width:580px;background:#ffffff;border-radius:18px;
    overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.12);">

  <!-- HEADER -->
  <tr><td style="background:linear-gradient(135deg,#1e3a5f,#1d4ed8);
    padding:24px 28px 0;" class="hpad">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="margin-bottom:22px;">
    <tr>
      <td valign="top">
        <div style="font-size:10px;color:rgba(255,255,255,0.5);
          text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px;">
          Relative Humidity Monitoring System</div>
        <div style="font-size:18px;font-weight:800;color:#ffffff;">
          RH-Meter Alert System</div>
      </td>
      <td align="right" valign="top">
        <div style="background:#ef4444;color:#fff;padding:8px 16px;
          border-radius:20px;font-size:11px;font-weight:800;white-space:nowrap;">
          &#9888;&#65039; THRESHOLD EXCEEDED</div>
      </td>
    </tr>
    </table>

  //   <!-- DATE | TIME | UNIT — 3 big prominent boxes -->
  //   <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  //     style="border-radius:12px 12px 0 0;overflow:hidden;background:#0f2744;">
  //   <tr>
  //     <td width="33%" class="dtbox"
  //       style="padding:18px 14px;text-align:center;
  //         border-right:1px solid rgba(255,255,255,0.1);">
  //       <div style="font-size:22px;margin-bottom:8px;">&#128197;</div>
  //       <div style="font-size:10px;color:rgba(255,255,255,0.45);
  //         text-transform:uppercase;letter-spacing:1.2px;margin-bottom:8px;">Date</div>
  //       <div style="font-size:14px;font-weight:800;color:#ffffff;
  //         line-height:1.4;">${date}</div>
  //     </td>
  //     <td width="34%" class="dtbox"
  //       style="padding:18px 14px;text-align:center;
  //         border-right:1px solid rgba(255,255,255,0.1);">
  //       <div style="font-size:22px;margin-bottom:8px;">&#128336;</div>
  //       <div style="font-size:10px;color:rgba(255,255,255,0.45);
  //         text-transform:uppercase;letter-spacing:1.2px;margin-bottom:8px;">Time IST</div>
  //       <div style="font-size:18px;font-weight:900;color:#ffffff;">${time}</div>
  //     </td>
  //     <td width="33%" class="dtbox"
  //       style="padding:18px 14px;text-align:center;">
  //       <div style="font-size:22px;margin-bottom:8px;">&#128205;</div>
  //       <div style="font-size:10px;color:rgba(255,255,255,0.45);
  //         text-transform:uppercase;letter-spacing:1.2px;margin-bottom:8px;">Unit</div>
  //       <div style="font-size:14px;font-weight:800;color:#60a5fa;">${location}</div>
  //     </td>
  //   </tr>
  //   </table>
  // </td></tr>

  <!-- ALERT HEADLINE -->
  <tr><td style="background:#ffffff;padding:18px 28px 0;" class="cpad">
    <div style="background:#fef2f2;border-left:5px solid #ef4444;
      border-radius:0 8px 8px 0;padding:13px 16px;">
      <div style="font-size:10px;color:#ef4444;font-weight:700;
        text-transform:uppercase;letter-spacing:1.2px;margin-bottom:5px;">
        &#9888;&#65039; Threshold Exceeded</div>
      <div style="font-size:16px;font-weight:800;color:#1e293b;">
        ${alertLabel} at <span style="color:#1d4ed8;">${friendlyName}</span>
      </div>
    </div>
  </td></tr>

  <!-- DEVICE INFO -->
  <tr><td style="background:#ffffff;padding:14px 28px 0;" class="cpad">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;
        border-collapse:separate;border-spacing:0;">
      <tr style="background:#eff6ff;">
        <td colspan="4" style="padding:8px 14px;font-size:10px;font-weight:700;
          text-transform:uppercase;letter-spacing:1.2px;color:#1d4ed8;">
          Device Information</td>
      </tr>
      <tr class="devrow" style="border-top:1px solid #e2e8f0;">
        <td style="padding:10px 14px;font-size:12px;color:#64748b;
          font-weight:600;background:#f8fafc;width:22%;">Device ID</td>
        <td style="padding:10px 14px;font-size:13px;font-weight:700;
          font-family:monospace;color:#1e293b;width:28%;
          border-right:1px solid #e2e8f0;">${deviceId}</td>
        <td style="padding:10px 14px;font-size:12px;color:#64748b;
          font-weight:600;background:#f8fafc;width:22%;">Location</td>
        <td style="padding:10px 14px;font-size:13px;font-weight:700;
          color:#1e293b;">${friendlyName}</td>
      </tr>
      <tr class="devrow" style="border-top:1px solid #e2e8f0;">
        <td style="padding:10px 14px;font-size:12px;color:#64748b;
          font-weight:600;background:#f8fafc;">Unit</td>
        <td style="padding:10px 14px;border-right:1px solid #e2e8f0;">
          <span style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;
            padding:3px 10px;border-radius:6px;font-size:12px;font-weight:700;">
            ${location}</span>
        </td>
        <td style="padding:10px 14px;font-size:12px;color:#64748b;
          font-weight:600;background:#f8fafc;">Alert Time</td>
        <td style="padding:10px 14px;font-size:12px;font-weight:700;
          color:#1e293b;">${time} IST</td>
      </tr>
    </table>
  </td></tr>

  <!-- SENSOR READINGS -->
  <tr><td style="background:#ffffff;padding:14px 28px 0;" class="cpad">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;
      letter-spacing:1.2px;color:#1d4ed8;margin-bottom:12px;">
      Sensor Readings</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      ${readingBlock('temperature', otherTemp, tempThreshold, tempIsAlert)}
      <td width="4%" class="rsp"></td>
      ${readingBlock('humidity', otherHum, humThreshold, humIsAlert)}
    </tr>
    </table>
  </td></tr>

  <!-- DASHBOARD BUTTON -->
  <tr><td style="background:#ffffff;padding:20px 28px 8px;text-align:center;"
    class="cpad">
    <a href="${dashUrl}" class="btn"
      style="display:block;background:linear-gradient(135deg,#1e3a5f,#1d4ed8);
        color:#ffffff;padding:14px 40px;border-radius:10px;font-size:15px;
        font-weight:700;text-decoration:none;letter-spacing:0.3px;">
      View Live Dashboard &#8594;
    </a>
    <p style="font-size:11px;color:#94a3b8;margin:10px 0 0 0;">
      Next alert for this device after 3 hour cooldown</p>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;
    padding:16px 28px;border-radius:0 0 18px 18px;" class="fp">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td valign="middle">
        <span style="font-size:14px;font-weight:800;color:#1e3a5f;">
          Aquarelle India Pvt. Ltd.</span>
      </td>
      <td align="right" valign="middle"
        style="font-size:11px;color:#94a3b8;">
        Automated Monitoring System</td>
    </tr>
    </table>
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
  try {
    await axios.get('https://rh-meter-bridge.onrender.com/api/ping');
    console.log('⚡ Self-ping OK');
  } catch (e) {
    console.error('Self-ping failed:', e.message);
  }
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
    const hum          = latest?.humidity    ?? 65.0;
    const recipients   = recipientStr.split(',').map(e => e.trim()).filter(Boolean);
    const location     = LOCATION_MAP_SERVER[deviceId] || 'Unknown';
    const now          = new Date();
    const time         = now.toLocaleTimeString('en-IN', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hour12:true });
    const date         = now.toLocaleDateString('en-IN', { timeZone:'Asia/Kolkata', day:'numeric', month:'long', year:'numeric' });

    let friendlyName = deviceId;
    try {
      const namesDoc = await DeviceNames.findOne({ key: 'global' });
      if (namesDoc?.names?.[deviceId]) friendlyName = namesDoc.names[deviceId];
    } catch(e) {}

    const html = buildAlertEmail({
      deviceId, friendlyName, location,
      alertType:     hum > settings.humThreshold ? 'humidity' : 'temperature',
      combined:      false,
      actualValue:   hum > settings.humThreshold ? hum : temp,
      threshold:     hum > settings.humThreshold ? settings.humThreshold : settings.tempThreshold,
      unit:          hum > settings.humThreshold ? '%' : '°C',
      otherTemp:     temp,
      otherHum:      hum,
      tempThreshold: settings.tempThreshold,
      humThreshold:  settings.humThreshold,
      time, date
    });

    const subject = `⚠️ Test Alert — ${friendlyName} | ${deviceId} | ${location}`;
    const result  = await sendEmail(subject, html, recipients);
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
    res.json({ ok: true, usedData: { temp, hum, deviceId, friendlyName, location } });
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