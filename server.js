const express    = require('express');
const mongoose   = require('mongoose');
const bodyParser = require('body-parser');
const cron       = require('node-cron');
const axios      = require('axios');

const app = express();
app.use(bodyParser.json());

// ── MongoDB Connection ──────────────────────────────────────
mongoose.connect("mongodb+srv://factory_admin:factory_admin1234@cluster0.zk0gm.mongodb.net/FactoryData?retryWrites=true&w=majority")
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

// ── Schema ──────────────────────────────────────────────────
const SensorData = mongoose.model('SensorData', new mongoose.Schema({
  temperature: Number,
  humidity:    Number,
  tempLevel:   String,
  humLevel:    String,
  timestamp:   { type: Date, default: Date.now }
}));

// ── Keep-Alive Ping (Render free tier) ─────────────────────
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

// ── Save data from ThingsBoard Rule Engine ──────────────────
app.post('/save-data', async (req, res) => {
  try {
    await new SensorData(req.body).save();
    console.log("💾 Saved:", req.body);
    res.status(200).send("Saved");
  } catch (err) {
    console.error("❌ Save Error:", err);
    res.status(500).send("Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge running on port ${PORT}`));