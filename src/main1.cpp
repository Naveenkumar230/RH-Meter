// ============================================================
//  Dehumidifier Power Monitor — main.cpp
//  ESP32 + ZMPT101B AC Voltage Sensor
//  MQTT → HiveMQ Cloud (TLS)
//  Topic: AIPL/Power_Monitor/<DEVICE_ID>/telemetry
//
//  Wiring:
//    ZMPT101B VCC  → ESP32 3.3V  (NOT 5V)
//    ZMPT101B GND  → ESP32 GND
//    ZMPT101B OUT  → ESP32 GPIO34 (ADC1 — safe with WiFi)
//
//  Flow:
//    1. Boot → WiFiManager AP mode (SSID: Dehum-Setup-<ID>)
//    2. User connects to AP, enters home WiFi credentials
//    3. ESP32 connects to WiFi + HiveMQ MQTT
//    4. Reads ZMPT101B every 10s, publishes vrms + online/offline
//    5. online = true  if vrms > VOLTAGE_THRESHOLD (100V)
//       online = false if vrms ≤ VOLTAGE_THRESHOLD
//
//  Payload: {"id":"Dehum_01","vrms":228.5,"online":true}
//
//  NOTE: LCD display removed — telemetry is sent via MQTT
//        and printed to Serial only.
// ============================================================

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <PubSubClient.h>
#include <WiFiClientSecure.h>

// ════════════════════════════════════════════════════════════
//  DEVICE CONFIGURATION — Change DEVICE_ID per unit
//  e.g. "Dehum_01", "Dehum_02" ... "Dehum_10"
// ════════════════════════════════════════════════════════════
constexpr const char* DEVICE_ID = "Dehum_08";   // ← CHANGE THIS PER DEVICE

// ════════════════════════════════════════════════════════════
//  MQTT CREDENTIALS
// ════════════════════════════════════════════════════════════
constexpr const char* MQTT_HOST = "d034db44805b4258a6c72c3efe0f9019.s1.eu.hivemq.cloud";
constexpr int         MQTT_PORT = 8883;
constexpr const char* MQTT_USER = "RH-METER";
constexpr const char* MQTT_PASS = "RH-METEr1234";

// ════════════════════════════════════════════════════════════
//  PIN — ZMPT101B OUT → GPIO34 (ADC1, input-only, WiFi safe)
//  DO NOT use GPIO 0,2,4,12–15,25–27 (ADC2 — blocked by WiFi)
// ════════════════════════════════════════════════════════════
constexpr int PIN_VOLTAGE = 34;

// ════════════════════════════════════════════════════════════
//  VOLTAGE SENSING CONFIGURATION
//  India mains: 230V AC, 50Hz
// ════════════════════════════════════════════════════════════
constexpr float     AC_FREQ_HZ        = 50.0f;
constexpr int       SAMPLES_PER_CYCLE = 100;          // ADC samples per RMS window
constexpr int       NUM_CYCLES        = 5;            // average over 5 full cycles
constexpr float     ADC_VREF          = 3.3f;         // ESP32 ADC reference voltage
constexpr int       ADC_RESOLUTION    = 4095;         // 12-bit ADC
constexpr float     CALIBRATION       = 520.0f;       // ← TUNE THIS with a multimeter
                                                      //   Formula: actual_V / raw_rms_reading
                                                      //   Default 520 is a safe starting point

// Online threshold: if vrms > this → dehumidifier has power → ONLINE
constexpr float VOLTAGE_THRESHOLD = 100.0f;           // Volts RMS

// ════════════════════════════════════════════════════════════
//  TIMING
// ════════════════════════════════════════════════════════════
constexpr unsigned long PUBLISH_INTERVAL_MS = 10000UL;   // publish every 10s

// ════════════════════════════════════════════════════════════
//  GLOBALS
// ════════════════════════════════════════════════════════════
WiFiClientSecure  wifiClientSecure;
PubSubClient      mqttClient(wifiClientSecure);

char mqttTopic[80];

float         vrms         = 0.0f;
bool          isOnline     = false;
unsigned long lastPublish  = 0;

// ════════════════════════════════════════════════════════════
//  VOLTAGE MEASUREMENT — True RMS via oversampling
//
//  The ZMPT101B outputs a sine wave centered around VCC/2.
//  On 3.3V ESP32, the midpoint is ~1.65V (ADC ~2048).
//  We subtract the DC offset, square, average, then sqrt.
//  Multiply by CALIBRATION to get real-world Vrms.
// ════════════════════════════════════════════════════════════
float measureVrms() {
  const int totalSamples = SAMPLES_PER_CYCLE * NUM_CYCLES;
  // Sample period in microseconds: 1 cycle = 1/50Hz = 20ms → each sample every 20ms/100 = 200µs
  const unsigned long samplePeriodUs = (unsigned long)(1000000.0f / (AC_FREQ_HZ * SAMPLES_PER_CYCLE));

  // --- Step 1: Find DC offset (midpoint) ---
  // Take a quick burst to measure the ADC zero point
  long dcSum = 0;
  for (int i = 0; i < 50; i++) {
    dcSum += analogRead(PIN_VOLTAGE);
    delayMicroseconds(samplePeriodUs / 2);
  }
  float dcOffset = (float)dcSum / 50.0f;

  // --- Step 2: Collect samples and compute sum of squares ---
  double sumSquares = 0.0;
  unsigned long tStart = micros();

  for (int i = 0; i < totalSamples; i++) {
    // Wait for the right sample moment
    while (micros() - tStart < (unsigned long)(i * samplePeriodUs)) { /* spin */ }

    int raw = analogRead(PIN_VOLTAGE);
    float centered = (float)raw - dcOffset;               // remove DC offset
    float voltage  = centered * (ADC_VREF / ADC_RESOLUTION); // convert to volts
    sumSquares += (double)(voltage * voltage);
  }

  // --- Step 3: RMS + calibration ---
  float rmsRaw = sqrt((float)(sumSquares / totalSamples));
  float result = rmsRaw * CALIBRATION;

  // Clamp noise floor — anything under 5V is treated as 0
  if (result < 5.0f) result = 0.0f;

  return result;
}

// ════════════════════════════════════════════════════════════
//  MQTT — PUBLISH TELEMETRY
//  Payload matches what powermonitor.js expects:
//  { "id": "Dehum_01", "vrms": 228.5, "online": true }
// ════════════════════════════════════════════════════════════
void publishTelemetry() {
  char payload[120];
  snprintf(payload, sizeof(payload),
    "{\"id\":\"%s\",\"vrms\":%.1f,\"online\":%s}",
    DEVICE_ID,
    vrms,
    isOnline ? "true" : "false"
  );

  if (mqttClient.publish(mqttTopic, payload, true)) {
    Serial.printf("[MQTT] ✅ Published → %s\n", payload);
  } else {
    Serial.println("[MQTT] ❌ Publish FAILED");
  }
}

// ════════════════════════════════════════════════════════════
//  MQTT — RECONNECT
// ════════════════════════════════════════════════════════════
void mqttReconnect() {
  if (mqttClient.connected()) return;
  Serial.print("[MQTT] Connecting...");

  char clientId[40];
  snprintf(clientId, sizeof(clientId), "ESP32-%s-%04X",
           DEVICE_ID, (uint16_t)(ESP.getEfuseMac() & 0xFFFF));

  if (mqttClient.connect(clientId, MQTT_USER, MQTT_PASS)) {
    Serial.println(" connected ✅");
  } else {
    Serial.printf(" failed, rc=%d (will retry)\n", mqttClient.state());
  }
}

// ════════════════════════════════════════════════════════════
//  SETUP
// ════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  Serial.printf("\n🚀 Booting %s\n", DEVICE_ID);

  // ── ADC configuration for GPIO34 ──────────────────────────
  analogReadResolution(12);                   // 12-bit: 0–4095
  analogSetAttenuation(ADC_11db);             // full 0–3.3V range
  pinMode(PIN_VOLTAGE, INPUT);

  // ── Build MQTT topic ──────────────────────────────────────
  snprintf(mqttTopic, sizeof(mqttTopic),
           "AIPL/Power_Monitor/%s/telemetry", DEVICE_ID);

  // ── WiFiManager — AP mode on first boot ───────────────────
  // After flashing: ESP32 creates AP "Dehum-Setup-Dehum_01"
  // User connects to that AP, opens 192.168.4.1
  // Enters home WiFi SSID + password → saved to flash
  Serial.println("[WiFi] Starting WiFiManager AP portal...");

  char apName[32];
  snprintf(apName, sizeof(apName), "Dehum-%s", DEVICE_ID);
  Serial.printf("[WiFi] Connect to AP: %s\n", apName);

  WiFiManager wm;
  wm.setConfigPortalTimeout(180);   // AP portal stays open 3 minutes

  // Custom AP portal title
  wm.setTitle("Dehumidifier Power Monitor");

  if (!wm.autoConnect(apName)) {
    Serial.println("[WiFi] Connect failed — restarting in 5s");
    delay(5000);
    ESP.restart();
  }

  Serial.printf("[WiFi] ✅ Connected: %s\n", WiFi.localIP().toString().c_str());

  // ── MQTT over TLS ─────────────────────────────────────────
  wifiClientSecure.setInsecure();           // skip cert validation
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setKeepAlive(60);
  mqttClient.setSocketTimeout(10);
  mqttReconnect();

  Serial.println("[Setup] Ready — reading sensor...");
}

// ════════════════════════════════════════════════════════════
//  LOOP
// ════════════════════════════════════════════════════════════
void loop() {
  unsigned long now = millis();

  // ── MQTT keep-alive ───────────────────────────────────────
  if (!mqttClient.connected()) mqttReconnect();
  mqttClient.loop();

  // ── Read voltage sensor + publish every 10s ───────────────
  if (now - lastPublish >= PUBLISH_INTERVAL_MS) {
    lastPublish = now;

    // Measure RMS voltage
    vrms     = measureVrms();
    isOnline = (vrms > VOLTAGE_THRESHOLD);

    Serial.printf("[Sensor] Vrms=%.1fV → %s\n",
                  vrms, isOnline ? "ONLINE" : "OFFLINE");

    // Publish to MQTT if connected
    if (mqttClient.connected()) {
      publishTelemetry();
    } else {
      Serial.println("[MQTT] Not connected — skipping publish");
    }
  }
}

// ════════════════════════════════════════════════════════════
//  CALIBRATION GUIDE
//  ─────────────────
//  1. Connect ZMPT101B to your AC mains (dehumidifier socket)
//  2. Open Serial Monitor at 115200 baud
//  3. Read the "Vrms" printed every 10 seconds
//  4. Measure the same socket with a multimeter
//  5. New CALIBRATION = (multimeter_reading / serial_vrms) * current_CALIBRATION
//  6. Update CALIBRATION constant above and reflash
//
//  Example:
//    Multimeter reads: 232V
//    Serial prints:    0.447 (raw rms before calibration)
//    CALIBRATION = 232 / 0.447 = 519 ← that confirms ~520 is correct
//
//  Wiring Reminder:
//    ZMPT101B VCC → ESP32 3.3V  ⚠️ NOT 5V (protects ADC)
//    ZMPT101B GND → ESP32 GND
//    ZMPT101B OUT → GPIO34
//    AC input     → ZMPT101B AC terminals (mains socket)
// ════════════════════════════════════════════════════════════