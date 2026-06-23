// ============================================================
//  powermonitor.js  — Dehumidifier Power Monitor
//  Add to your existing server.js with:
//    require('./powermonitor')(app, mongoose, mqtt, HIVEMQ_URL, HIVEMQ_USER, HIVEMQ_PASS);
//
//  MQTT topic  : AIPL/Power_Monitor/+/telemetry
//  MQTT cmd    : AIPL/Power_Monitor/<ID>/cmd   (payload: "ON"/"OFF")
//  REST routes ://    GET  /api/power-data?deviceId=Dehum_01
//    GET  /api/power-history?deviceId=Dehum_01&from=YYYY-MM-DD&to=YYYY-MM-DD
//    POST /api/power-relay   { deviceId, state: "ON"|"OFF" }
//    GET  /api/device-names                         ← NEW: get all custom names
//    POST /api/device-name/rename                   ← NEW: rename a device (password protected)
//      body: { deviceId, newName, password }
// ============================================================

module.exports = function (app, mongoose, mqtt) {

  // ── ENV / constants ────────────────────────────────────────
  const HIVEMQ_URL   = process.env.MQTT_URL  || 'mqtts://d034db44805b4258a6c72c3efe0f9019.s1.eu.hivemq.cloud:8883';
  const HIVEMQ_USER  = process.env.MQTT_USER || 'RH-METER';
  const HIVEMQ_PASS  = process.env.MQTT_PASS || 'RH-METEr1234';
  const POWER_TOPIC  = 'AIPL/Power_Monitor/+/telemetry';
  const SAVE_INTERVAL_MS = 10 * 60 * 1000;   // save every 10 minutes

  // Password required to rename a device.
  // Set RENAME_PASSWORD in your environment variables (Render dashboard → Environment).
  // Falling back to a default is ONLY for local testing — change it in production!
  const RENAME_PASSWORD = '12345';

  // ── In-memory stores ──────────────────────────────────────
  const latestPower  = {};   // { Dehum_01: { vrms, online, relay, timestamp } }
  const lastSavePwr  = {};   // { Dehum_01: epochMs }

  // ─────────────────────────────────────────────────────────
  //  MONGOOSE SCHEMAS
  // ─────────────────────────────────────────────────────────
  const PowerData = mongoose.model('PowerData', new mongoose.Schema({
    deviceId:  { type: String, required: true },
    vrms:      { type: Number, default: 0 },
    online:    { type: Boolean, default: false },
    relay:     { type: Boolean, default: false },
    timestamp: { type: Date,   default: Date.now }
  }, { collection: 'powerdatas' }));

  // NEW: stores custom display names per device, keyed by deviceId
  const DeviceName = mongoose.model('DeviceName', new mongoose.Schema({
    deviceId:   { type: String, required: true, unique: true },
    name:       { type: String, required: true },
    updatedAt:  { type: Date,   default: Date.now }
  }, { collection: 'devicenames' }));

  // ─────────────────────────────────────────────────────────
  //  MQTT SUBSCRIBER
  // ─────────────────────────────────────────────────────────
  const mqttClient = mqtt.connect(HIVEMQ_URL, {
    username:           HIVEMQ_USER,
    password:           HIVEMQ_PASS,
    clientId:           'server-power-' + Math.random().toString(16).slice(2,8),
    rejectUnauthorized: true,
    reconnectPeriod:    5000,
    connectTimeout:     30000,
  });

  mqttClient.on('connect', () => {
    console.log('✅ [PowerMonitor] MQTT connected');
    mqttClient.subscribe(POWER_TOPIC, { qos:1 }, err => {
      if (err) console.error('❌ [PowerMonitor] Subscribe error:', err.message);
      else     console.log(`✅ [PowerMonitor] Subscribed: ${POWER_TOPIC}`);
    });
  });

  mqttClient.on('message', async (topic, message) => {
    try {
      const payload  = JSON.parse(message.toString());
      // Topic: AIPL/Power_Monitor/Dehum_01/telemetry
      const deviceId = topic.split('/')[2] || payload.id;
      const vrms     = parseFloat(payload.vrms ?? 0);
      const online   = !!payload.online;
      const relay    = !!payload.relay;
      const ts       = new Date();

      // Update in-memory latest
      latestPower[deviceId] = { deviceId, vrms, online, relay, timestamp: ts };
      console.log(`[PowerMonitor] ${deviceId} vrms=${vrms} online=${online} relay=${relay}`);

      // Throttled save to MongoDB
      const now     = Date.now();
      const lastSav = lastSavePwr[deviceId] || 0;
      if (now - lastSav >= SAVE_INTERVAL_MS) {
        lastSavePwr[deviceId] = now;
        await new PowerData({ deviceId, vrms, online, relay, timestamp: ts }).save();
        console.log(`💾 [PowerMonitor] Saved ${deviceId}`);
      }
    } catch (err) {
      console.error('❌ [PowerMonitor] Message error:', err.message);
    }
  });

  mqttClient.on('reconnect', () => console.log('🔄 [PowerMonitor] Reconnecting…'));
  mqttClient.on('error',     err => console.error('❌ [PowerMonitor] MQTT error:', err.message));


  app.get('/api/power-history-all', async (req, res) => {
  try {
    const DEHUM_IDS = ['Dehum_01','Dehum_02','Dehum_03','Dehum_04','Dehum_05',
                       'Dehum_06','Dehum_07','Dehum_08','Dehum_09','Dehum_10'];
    const from = req.query.from
      ? new Date(req.query.from + 'T00:00:00.000+05:30')
      : new Date(new Date().toISOString().slice(0,10) + 'T00:00:00.000+05:30');
    const to = req.query.to
      ? new Date(req.query.to + 'T23:59:59.999+05:30')
      : new Date(new Date().toISOString().slice(0,10) + 'T23:59:59.999+05:30');

    const records = await PowerData
      .find({ deviceId: { $in: DEHUM_IDS }, timestamp: { $gte: from, $lte: to } })
      .sort({ timestamp: 1 })
      .lean();

    const grouped = {};
    DEHUM_IDS.forEach(id => grouped[id] = []);
    records.forEach(r => grouped[r.deviceId]?.push({
      timestamp: r.timestamp, vrms: r.vrms, online: r.online, relay: r.relay
    }));

    res.json(grouped);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

  // ─────────────────────────────────────────────────────────
  //  REST — GET latest reading
  // ─────────────────────────────────────────────────────────
  app.get('/api/power-data', async (req, res) => {
    try {
      const deviceId = req.query.deviceId;
      if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

      // Return live reading if available
      if (latestPower[deviceId]) return res.json(latestPower[deviceId]);

      // Fallback: last DB record
      const rec = await PowerData.findOne({ deviceId }).sort({ timestamp: -1 }).lean();
      if (!rec) return res.json({ deviceId, vrms:0, online:false, relay:false, timestamp:null });
      res.json(rec);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────
  //  REST — GET history  (IST-aware date range)
  // ─────────────────────────────────────────────────────────
app.get('/api/power-history', async (req, res) => {
    try {
      const deviceId = req.query.deviceId;
      if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

      const from = req.query.from
        ? new Date(req.query.from + 'T00:00:00.000+05:30')
        : new Date(new Date().toISOString().slice(0,10) + 'T00:00:00.000+05:30');
      const to = req.query.to
        ? new Date(req.query.to + 'T23:59:59.999+05:30')
        : new Date(new Date().toISOString().slice(0,10) + 'T23:59:59.999+05:30');

      console.log(`[PowerMonitor] History ${deviceId} from=${from.toISOString()} to=${to.toISOString()}`);

      const records = await PowerData
        .find({ deviceId, timestamp:{ $gte:from, $lte:to } })
        .sort({ timestamp:1 })
        .lean();

      res.json(records.map(r => ({
        timestamp: r.timestamp,
        vrms:      r.vrms,
        online:    r.online,
        relay:     r.relay,
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────
  //  REST — GET history for ALL devices at once (batched)
  //  Used by the dashboard grid view to avoid 10+ separate calls
  // ─────────────────────────────────────────────────────────
  app.get('/api/power-history-all', async (req, res) => {
    try {
      const DEHUM_IDS = [
        'Dehum_01','Dehum_02','Dehum_03','Dehum_04','Dehum_05',
        'Dehum_06','Dehum_07','Dehum_08','Dehum_09','Dehum_10'
      ];

      const from = req.query.from
        ? new Date(req.query.from + 'T00:00:00.000+05:30')
        : new Date(new Date().toISOString().slice(0,10) + 'T00:00:00.000+05:30');
      const to = req.query.to
        ? new Date(req.query.to + 'T23:59:59.999+05:30')
        : new Date(new Date().toISOString().slice(0,10) + 'T23:59:59.999+05:30');

      console.log(`[PowerMonitor] History-All from=${from.toISOString()} to=${to.toISOString()}`);

      const records = await PowerData
        .find({ deviceId: { $in: DEHUM_IDS }, timestamp: { $gte: from, $lte: to } })
        .sort({ timestamp: 1 })
        .lean();

      const grouped = {};
      DEHUM_IDS.forEach(id => grouped[id] = []);
      records.forEach(r => {
        if (grouped[r.deviceId]) {
          grouped[r.deviceId].push({
            timestamp: r.timestamp,
            vrms:      r.vrms,
            online:    r.online,
            relay:     r.relay,
          });
        }
      });

      res.json(grouped);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────
  //  REST — POST relay command  (web → MQTT → ESP32)
  // ─────────────────────────────────────────────────────────
  app.post('/api/power-relay', (req, res) => {
    try {
      const { deviceId, state } = req.body;
      if (!deviceId || !['ON','OFF'].includes(state))
        return res.status(400).json({ error: 'deviceId and state (ON|OFF) required' });

      const cmdTopic = `AIPL/Power_Monitor/${deviceId}/cmd`;
      mqttClient.publish(cmdTopic, state, { qos:1 }, err => {
        if (err) {
          console.error(`❌ [PowerMonitor] Relay cmd failed: ${err.message}`);
          return res.status(500).json({ ok:false, error: err.message });
        }
        console.log(`📡 [PowerMonitor] Relay cmd sent → ${deviceId}: ${state}`);
        res.json({ ok:true, deviceId, state });
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────
  //  REST — GET all latest readings (home page summary)
  // ─────────────────────────────────────────────────────────
  app.get('/api/power-all', async (req, res) => {
    try {
      const DEHUM_IDS = [
        'Dehum_01','Dehum_02','Dehum_03','Dehum_04','Dehum_05',
        'Dehum_06','Dehum_07','Dehum_08','Dehum_09','Dehum_10'
      ];

      const result = {};
      for (const id of DEHUM_IDS) {
        if (latestPower[id]) {
          result[id] = latestPower[id];
        } else {
          const rec = await PowerData.findOne({ deviceId:id }).sort({ timestamp:-1 }).lean();
          result[id] = rec || { deviceId:id, vrms:0, online:false, relay:false, timestamp:null };
        }
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────
  //  REST — GET all custom device names
  //  Returns: { Dehum_01: "Living Room Dehumidifier", ... }
  //  Devices with no custom name are simply omitted —
  //  frontend falls back to its own default label.
  // ─────────────────────────────────────────────────────────
  app.get('/api/device-names', async (req, res) => {
    try {
      const rows = await DeviceName.find({}).lean();
      const map  = {};
      rows.forEach(r => { map[r.deviceId] = r.name; });
      res.json(map);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────
  //  REST — POST rename a device (password protected)
  //  body: { deviceId, newName, password }
  // ─────────────────────────────────────────────────────────
  app.post('/api/device-name/rename', async (req, res) => {
    try {
      const { deviceId, newName, password } = req.body;

      if (!deviceId || !newName || !newName.trim()) {
        return res.status(400).json({ ok:false, error: 'deviceId and newName are required' });
      }
      if (password !== RENAME_PASSWORD) {
        return res.status(401).json({ ok:false, error: 'Incorrect password' });
      }

      const trimmedName = newName.trim().slice(0, 60); // cap length

      await DeviceName.findOneAndUpdate(
        { deviceId },
        { deviceId, name: trimmedName, updatedAt: new Date() },
        { upsert: true }
      );

      console.log(`✏️ [PowerMonitor] Renamed ${deviceId} → "${trimmedName}"`);
      res.json({ ok:true, deviceId, name: trimmedName });
    } catch (err) {
      res.status(500).json({ ok:false, error: err.message });
    }
  });

  console.log('✅ [PowerMonitor] Module loaded — routes + MQTT subscriber ready');
};