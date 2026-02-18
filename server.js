const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// ── MONGODB CONNECTION ──────────────────────────────────────
const mongoURI = "mongodb+srv://factory_admin:factory_admin1234@cluster0.zk0gm.mongodb.net/FactoryData?retryWrites=true&w=majority";

mongoose.connect(mongoURI)
    .then(() => console.log("✅ Permanent MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

// ── DATA SCHEMA (Matches your ESP32 payload) ────────────────
const SensorData = mongoose.model('SensorData', {
    temperature: Number,
    humidity: Number,
    tempLevel: String,
    humLevel: String,
    timestamp: { type: Date, default: Date.now }
});

// ── ENDPOINT FOR THINGSBOARD ────────────────────────────────
app.post('/save-data', async (req, res) => {
    try {
        const data = new SensorData(req.body);
        await data.save();
        console.log("💾 Archived to MongoDB:", req.body);
        res.status(200).send("Saved");
    } catch (err) {
        console.error("❌ Save Error:", err);
        res.status(500).send("Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge live on port ${PORT}`));