// ============================================================
//  Dehumidifier Power Monitor — main1.cpp
//  ESP32 + ZMPT101B AC Voltage Sensor + Relay + Button
//  MQTT → HiveMQ Cloud
//  Topic: AIPL/Power_Monitor/<DEVICE_ID>/telemetry
// ============================================================

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <WiFiClientSecure.h>

// ════════════════════════════════════════════════════════════
//  DEVICE CONFIGURATION — Change DEVICE_ID per unit
//  Valid IDs: Dehum_01 … Dehum_10
// ════════════════════════════════════════════════════════════
constexpr const char* DEVICE_ID    = "Dehum_01";   // ← CHANGE THIS PER DEVICE

// ════════════════════════════════════════════════════════════
//  MQTT CREDENTIALS
// ════════════════════════════════════════════════════════════
constexpr const char* MQTT_HOST    = "d034db44805b4258a6c72c3efe0f9019.s1.eu.hivemq.cloud";
constexpr int         MQTT_PORT    = 8883;
constexpr const char* MQTT_USER    = "RH-METER";
constexpr const char* MQTT_PASS    = "RH-METEr1234";

// ════════════════════════════════════════════════════════════
//  PIN DEFINITIONS
// ════════════════════════════════════════════════════════════
constexpr int PIN_ZMPT        = 34;   // ZMPT101B analog out → ADC1_CH6
constexpr int PIN_RELAY       = 26;   // Relay control (HIGH = ON)
constexpr int PIN_BUTTON      = 27;   // Physical toggle button (INPUT_PULLUP)
constexpr int PIN_LED_GREEN   = 25;   // Green LED  = relay ON / voltage present
constexpr int PIN_LED_RED     = 33;   // Red LED    = relay OFF / no voltage

// ════════════════════════════════════════════════════════════
//  ZMPT101B CALIBRATION (230V India)
//  Run calibration sketch once and set VRMS_CALIBRATION so
//  reading matches a known reference meter.
//  Default offset: ADC midpoint ~1862 for 3.3V / 12-bit ADC
// ════════════════════════════════════════════════════════════
constexpr float VRMS_CALIBRATION = 0.5f;   // ← tune until LCD shows ~230V
constexpr int   ADC_SAMPLES      = 500;    // samples per RMS calculation
constexpr float VOLTAGE_THRESHOLD = 50.0f; // Vrms above this = "ONLINE"

// ════════════════════════════════════════════════════════════
//  TIMING
// ════════════════════════════════════════════════════════════
constexpr unsigned long PUBLISH_INTERVAL_MS  = 10000UL;  // 10 s live publish
constexpr unsigned long DEBOUNCE_MS          = 200UL;
constexpr unsigned long LCD_REFRESH_MS       = 1000UL;

// ════════════════════════════════════════════════════════════
//  MQTT TOPIC  (matches server.js AIPL/RH_Meter/+/telemetry pattern)
//  Power monitor uses its own root: AIPL/Power_Monitor/+/telemetry
// ════════════════════════════════════════════════════════════
char mqttTopic[80];   // built in setup()

// ════════════════════════════════════════════════════════════
//  GLOBALS
// ════════════════════════════════════════════════════════════
WiFiClientSecure  wifiClientSecure;
PubSubClient      mqttClient(wifiClientSecure);
LiquidCrystal_I2C lcd(0x27, 16, 2);

bool  relayState     = false;   // true = relay energised
bool  lastButtonRead = HIGH;
unsigned long lastDebounce   = 0;
unsigned long lastPublish    = 0;
unsigned long lastLcdRefresh = 0;

// ════════════════════════════════════════════════════════════
//  ZMPT101B — RMS voltage measurement
// ════════════════════════════════════════════════════════════
float measureVrms() {
  long   sumSq  = 0;
  int    offset = 0;

  // First pass: estimate DC offset (mid-rail)
  long   dcSum  = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) {
    dcSum += analogRead(PIN_ZMPT);
    delayMicroseconds(100);
  }
  offset = dcSum / ADC_SAMPLES;

  // Second pass: compute RMS around offset
  for (int i = 0; i < ADC_SAMPLES; i++) {
    int raw   = analogRead(PIN_ZMPT) - offset;
    sumSq    += (long)raw * raw;
    delayMicroseconds(100);
  }

  float rms = sqrt((float)sumSq / ADC_SAMPLES);
  return rms * VRMS_CALIBRATION;
}

// ════════════════════════════════════════════════════════════
//  RELAY CONTROL
// ════════════════════════════════════════════════════════════
void setRelay(bool on) {
  relayState = on;
  digitalWrite(PIN_RELAY,     on ? HIGH : LOW);
  digitalWrite(PIN_LED_GREEN, on ? HIGH : LOW);
  digitalWrite(PIN_LED_RED,   on ? LOW  : HIGH);
  Serial.printf("[Relay] %s\n", on ? "ON" : "OFF");
}

// ════════════════════════════════════════════════════════════
//  MQTT — PUBLISH TELEMETRY
//  Payload (JSON):
//  {
//    "id"      : "Dehum_01",
//    "vrms"    : 228.4,
//    "online"  : true,        ← true if voltage present AND relay ON
//    "relay"   : true,        ← relay state (could be ON but no voltage if dehumidifier off)
//    "ts"      : 1717000000   ← Unix epoch (seconds)
//  }
// ════════════════════════════════════════════════════════════
void publishTelemetry(float vrms) {
  bool  voltagePresent = (vrms >= VOLTAGE_THRESHOLD);
  bool  online         = voltagePresent && relayState;

  char payload[180];
  snprintf(payload, sizeof(payload),
    "{\"id\":\"%s\",\"vrms\":%.1f,\"online\":%s,\"relay\":%s}",
    DEVICE_ID,
    vrms,
    online   ? "true" : "false",
    relayState ? "true" : "false"
  );

  if (mqttClient.publish(mqttTopic, payload, true)) {
    Serial.printf("[MQTT] Published → %s\n", payload);
  } else {
    Serial.println("[MQTT] Publish FAILED");
  }
}

// ════════════════════════════════════════════════════════════
//  MQTT — SUBSCRIBE CALLBACK
//  Accepts remote relay commands:
//  Topic : AIPL/Power_Monitor/<ID>/cmd
//  Payload: "ON" or "OFF"
// ════════════════════════════════════════════════════════════
char cmdTopic[80];

void mqttCallback(char* topic, byte* payload, unsigned int len) {
  char msg[32] = {0};
  len = min(len, (unsigned int)31);
  memcpy(msg, payload, len);
  Serial.printf("[MQTT] Cmd received: %s\n", msg);

  if (strcmp(msg, "ON")  == 0) setRelay(true);
  if (strcmp(msg, "OFF") == 0) setRelay(false);
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
    mqttClient.subscribe(cmdTopic);
    Serial.printf("[MQTT] Subscribed to %s\n", cmdTopic);
  } else {
    Serial.printf(" failed, rc=%d\n", mqttClient.state());
  }
}

// ════════════════════════════════════════════════════════════
//  LCD DISPLAY
// ════════════════════════════════════════════════════════════
void updateLCD(float vrms) {
  bool voltagePresent = (vrms >= VOLTAGE_THRESHOLD);

  lcd.clear();

  // Line 0 — Device ID + voltage
  lcd.setCursor(0, 0);
  lcd.print(DEVICE_ID);
  lcd.setCursor(9, 0);
  char vbuf[7];
  snprintf(vbuf, sizeof(vbuf), "%5.1fV", vrms);
  lcd.print(vbuf);

  // Line 1 — Status
  lcd.setCursor(0, 1);
  if (!relayState) {
    lcd.print("Relay: OFF      ");
  } else if (voltagePresent) {
    lcd.print("ONLINE  RUNNING ");
  } else {
    lcd.print("Relay ON NO VOLT");
  }
}

// ════════════════════════════════════════════════════════════
//  SETUP
// ════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  Serial.printf("\n🚀 Booting %s\n", DEVICE_ID);

  // ── Build topics ─────────────────────────────────────────
  snprintf(mqttTopic, sizeof(mqttTopic),  "AIPL/Power_Monitor/%s/telemetry", DEVICE_ID);
  snprintf(cmdTopic,  sizeof(cmdTopic),   "AIPL/Power_Monitor/%s/cmd",       DEVICE_ID);

  // ── GPIO ──────────────────────────────────────────────────
  analogReadResolution(12);           // 12-bit ADC (0-4095)
  analogSetAttenuation(ADC_11db);     // full-scale ≈ 3.3V

  pinMode(PIN_RELAY,     OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_RED,   OUTPUT);
  pinMode(PIN_BUTTON,    INPUT_PULLUP);

  setRelay(false);                    // start with relay OFF

  // ── LCD ──────────────────────────────────────────────────
  Wire.begin();
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("  Dehumidifier  ");
  lcd.setCursor(0, 1);
  lcd.print("   Monitor v1   ");
  delay(1500);

  // ── WiFi (WiFiManager AP if no saved credentials) ────────
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Connecting WiFi ");
  WiFiManager wm;
  wm.setConfigPortalTimeout(120);
  char apName[32];
  snprintf(apName, sizeof(apName), "Dehum-Setup-%s", DEVICE_ID);
  if (!wm.autoConnect(apName)) {
    Serial.println("[WiFi] Connect failed — restarting");
    ESP.restart();
  }
  Serial.printf("[WiFi] Connected: %s\n", WiFi.localIP().toString().c_str());
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("WiFi OK");
  lcd.setCursor(0, 1);
  lcd.print(WiFi.localIP().toString());
  delay(1000);

  // ── MQTT (TLS, no cert verification for HiveMQ cloud) ────
  wifiClientSecure.setInsecure();   // trust all — use setCACert() for prod
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setKeepAlive(60);
  mqttClient.setSocketTimeout(10);
  mqttReconnect();
}

// ════════════════════════════════════════════════════════════
//  LOOP
// ════════════════════════════════════════════════════════════
void loop() {
  unsigned long now = millis();

  // ── MQTT keep-alive ───────────────────────────────────────
  if (!mqttClient.connected()) mqttReconnect();
  mqttClient.loop();

  // ── Physical button — debounced toggle ───────────────────
  bool buttonNow = digitalRead(PIN_BUTTON);
  if (buttonNow == LOW && lastButtonRead == HIGH) {
    // falling edge = button pressed
    if (now - lastDebounce > DEBOUNCE_MS) {
      lastDebounce = now;
      setRelay(!relayState);
      Serial.printf("[Button] Toggled relay → %s\n", relayState ? "ON" : "OFF");
    }
  }
  lastButtonRead = buttonNow;

  // ── Measure voltage ───────────────────────────────────────
  float vrms = measureVrms();

  // ── Publish on interval ───────────────────────────────────
  if (now - lastPublish >= PUBLISH_INTERVAL_MS) {
    lastPublish = now;
    if (mqttClient.connected()) publishTelemetry(vrms);
  }

  // ── LCD refresh ───────────────────────────────────────────
  if (now - lastLcdRefresh >= LCD_REFRESH_MS) {
    lastLcdRefresh = now;
    updateLCD(vrms);
  }
}