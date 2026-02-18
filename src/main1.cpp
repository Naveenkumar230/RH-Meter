// ── Core / RTOS ─────────────────────────────────────────────
#include <Arduino.h>
#include <Wire.h>

// [WDT] Hardware watchdog
#include <esp_task_wdt.h>

// ── Connectivity ─────────────────────────────────────────────
#include <WiFi.h>
#include <WiFiManager.h>        // captive-portal provisioning
#include <ArduinoOTA.h>         // [OTA] wireless firmware update
#include <PubSubClient.h>       // MQTT → ThingsBoard

// ── Persistence ──────────────────────────────────────────────
#include <Preferences.h>        // [NVS] non-volatile credential store

// ── Sensor ───────────────────────────────────────────────────
#include <WEMOS_SHT3X.h>        // SHT30 driver

// ── Display ──────────────────────────────────────────────────
#include <LiquidCrystal_I2C.h>

// ── Web / Time ───────────────────────────────────────────────
#include <WebServer.h>
#include <time.h>

// ============================================================
//  CONFIGURATION  (edit these before flashing)
// ============================================================
namespace Config {
    // -- [NVS] Default credentials stored to NVS on first boot --
    constexpr const char* WIFI_SSID       = "YOUR_WIFI_SSID";
    constexpr const char* WIFI_PASS       = "YOUR_WIFI_PASSWORD";

    // ThingsBoard
    constexpr const char* TB_HOST         = "thingsboard.cloud";  
    constexpr int         TB_PORT         = 1883;
    constexpr const char* TB_TOKEN        = "VFIUsDTve9r5cBm8ZpPH"; 

    // OTA
    constexpr const char* OTA_HOSTNAME    = "FactoryMonitor";
    constexpr const char* OTA_PASSWORD    = "ota_admin_2024";   // change in production

    // NTP
    constexpr const char* NTP_SERVER      = "pool.ntp.org";
    constexpr long        GMT_OFFSET_SEC  = 19800;              // India UTC+5:30
    constexpr int         DST_OFFSET_SEC  = 0;

    // [CAL] Calibration offsets (applied every reading)
    constexpr float TEMP_OFFSET           = -0.8f;             // °C
    constexpr float HUM_OFFSET            = +7.1f;             // %RH

    // Thresholds
    constexpr float TEMP_NORMAL           = 27.0f;
    constexpr float TEMP_WARNING          = 35.0f;
    constexpr float HUM_DRY_LIMIT         = 40.0f;
    constexpr float HUM_WET_LIMIT         = 70.0f;

    // [WDT] Hardware watchdog timeout
    constexpr uint32_t WDT_TIMEOUT_SEC    = 30;

    // Timing intervals (ms) — [NOB] all millis()-based, no delay()
    constexpr uint32_t SENSOR_INTERVAL_MS = 2000;
    constexpr uint32_t CLOUD_INTERVAL_MS  = 10000;
    constexpr uint32_t LCD_INTERVAL_MS    = 2000;
    constexpr uint32_t WIFI_CHECK_MS      = 5000;
    constexpr uint32_t MQTT_CHECK_MS      = 5000;
    constexpr uint32_t LCD_PAGE_MS        = 6000;   // rotate pages every 6 s

    // Hardware pins
    constexpr int I2C_SDA = 21;
    constexpr int I2C_SCL = 22;

    // I2C addresses
    constexpr uint8_t LCD_ADDR  = 0x27;
    constexpr uint8_t SHT_ADDR  = 0x44;

    // History buffer (48 h @ 1 sample/30 s ≈ 5760; using 2880 to save RAM)
    constexpr int MAX_READINGS = 2880;
}

// ============================================================
//  CUSTOM LCD CHARACTER BITMAPS
// ============================================================
byte gDegree[8]    = {0b00110,0b01001,0b01001,0b00110,0b00000,0b00000,0b00000,0b00000};
byte gUpArrow[8]   = {0b00100,0b01110,0b11111,0b00100,0b00100,0b00100,0b00100,0b00000};
byte gDownArrow[8] = {0b00100,0b00100,0b00100,0b00100,0b11111,0b01110,0b00100,0b00000};
byte gDroplet[8]   = {0b00100,0b00100,0b01010,0b01010,0b10001,0b10001,0b10001,0b01110};
byte gThermo[8]    = {0b00100,0b01010,0b01010,0b01010,0b01110,0b11111,0b11111,0b01110};
byte gCheck[8]     = {0b00000,0b00001,0b00011,0b10110,0b11100,0b01000,0b00000,0b00000};
byte gWarn[8]      = {0b00100,0b00100,0b00100,0b00100,0b00100,0b00000,0b00100,0b00000};
byte gWifi[8]      = {0b00000,0b01110,0b10001,0b00100,0b01010,0b00000,0b00100,0b00000};

// Character slots
enum LcdChar : uint8_t { CHR_DEG=0, CHR_UP, CHR_DN, CHR_DROP, CHR_THERM, CHR_CHECK, CHR_WARN, CHR_WIFI };

// ============================================================
//  GLOBAL OBJECTS
// ============================================================
SHT3X           sht30(Config::SHT_ADDR);
LiquidCrystal_I2C lcd(Config::LCD_ADDR, 20, 4);
WebServer       webServer(80);
Preferences     prefs;
WiFiClient      wifiClient;
PubSubClient    mqttClient(wifiClient);

// ============================================================
//  STATE
// ============================================================
struct SensorReading {
    time_t  ts;
    float   temp;
    float   hum;
};

SensorReading   history[Config::MAX_READINGS];
int             histIdx       = 0;
int             histTotal     = 0;

float  currentTemp   = NAN;
float  currentHum    = NAN;
float  lastTemp      = NAN;
float  lastHum       = NAN;

bool   wifiOnline    = false;
bool   mqttOnline    = false;
bool   otaActive     = false;

// Timers [NOB]
uint32_t tLastSensor  = 0;
uint32_t tLastCloud   = 0;
uint32_t tLastLCD     = 0;
uint32_t tLastWiFiChk = 0;
uint32_t tLastMqttChk = 0;
uint32_t tLCDPage     = 0;

uint8_t  lcdPage      = 0;   // 0 = Temperature, 1 = Humidity

// ============================================================
//  NVS HELPERS  [NVS]
// ============================================================
/**
 * Writes default credentials to NVS on very first boot.
 * Subsequent boots read from NVS so credentials survive power loss.
 */
void nvsInit() {
    prefs.begin("factory", false);
    if (!prefs.isKey("tb_token")) {
        // First-time provisioning: burn defaults into NVS
        prefs.putString("tb_token", Config::TB_TOKEN);
        prefs.putString("ota_pass",  Config::OTA_PASSWORD);
        Serial.println("[NVS] First boot — defaults written to NVS");
    }
    prefs.end();
}

String nvsGet(const char* key, const char* fallback) {
    prefs.begin("factory", true);
    String val = prefs.getString(key, fallback);
    prefs.end();
    return val;
}

// ============================================================
//  UTILITY
// ============================================================
String alertLevel(float v, float norm, float warn) {
    if (v <= norm) return "normal";
    if (v <= warn) return "warning";
    return "critical";
}

String humLevel(float h) {
    if (h < Config::HUM_DRY_LIMIT) return "critical";
    if (h <= Config::HUM_WET_LIMIT) return "normal";
    return "warning";
}

String isoTime(time_t t) {
    struct tm ti; localtime_r(&t, &ti);
    char buf[20]; strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &ti);
    return String(buf);
}

/** [CAL] Apply calibration, clamp humidity 0–100, reject out-of-range */
bool applyCalibration(float rawT, float rawH, float& outT, float& outH) {
    if (isnan(rawT) || rawT < -40.0f || rawT > 125.0f) return false;
    if (isnan(rawH) || rawH <   0.0f || rawH > 100.0f) return false;
    outT = rawT + Config::TEMP_OFFSET;
    outH = constrain(rawH + Config::HUM_OFFSET, 0.0f, 100.0f);
    return true;
}

void pushHistory(float t, float h) {
    time_t now; time(&now);
    history[histIdx] = { now, t, h };
    histIdx = (histIdx + 1) % Config::MAX_READINGS;
    if (histTotal < Config::MAX_READINGS) histTotal++;
}

// ============================================================
//  LCD HELPERS
// ============================================================
void lcdCreateChars() {
    lcd.createChar(CHR_DEG,   gDegree);
    lcd.createChar(CHR_UP,    gUpArrow);
    lcd.createChar(CHR_DN,    gDownArrow);
    lcd.createChar(CHR_DROP,  gDroplet);
    lcd.createChar(CHR_THERM, gThermo);
    lcd.createChar(CHR_CHECK, gCheck);
    lcd.createChar(CHR_WARN,  gWarn);
    lcd.createChar(CHR_WIFI,  gWifi);
}

/**
 * Status bar — always on row 0.
 * Shows  [WiFi icon] [Online|Offl] [OTA flag] [page indicator]
 */
void lcdStatusBar(uint8_t page) {
    lcd.setCursor(0, 0);
    if (wifiOnline) { lcd.write(CHR_WIFI); lcd.print(" Online "); }
    else            { lcd.print("X Offline"); }
    lcd.print(mqttOnline ? " MQTT" : "     ");
    if (otaActive)  lcd.print(" OTA");
    else { lcd.print("    "); lcd.setCursor(18, 0); lcd.print(page + 1); lcd.print("/2"); }
}

/** Row helper: pad / truncate to exactly `width` chars */
void lcdRow(uint8_t row, const String& text, uint8_t width = 20) {
    lcd.setCursor(0, row);
    String s = text;
    while ((int)s.length() < width) s += ' ';
    lcd.print(s.substring(0, width));
}

void lcdPageTemperature() {
    lcdStatusBar(0);

    // Row 1: value
    lcd.setCursor(0, 1);
    lcd.write(CHR_THERM);
    lcd.print(" Temp: ");
    if (!isnan(currentTemp)) {
        char buf[8]; dtostrf(currentTemp, 5, 1, buf);
        lcd.print(buf); lcd.write(CHR_DEG); lcd.print("C  ");
    } else { lcd.print(" ---.-" ); lcd.write(CHR_DEG); lcd.print("C"); }

    // Row 2: trend
    lcd.setCursor(0, 2);
    lcd.print("Trend: ");
    if (!isnan(lastTemp)) {
        float delta = currentTemp - lastTemp;
        if      (delta >  0.2f) { lcd.print("Rising  "); lcd.write(CHR_UP);  }
        else if (delta < -0.2f) { lcd.print("Falling "); lcd.write(CHR_DN);  }
        else                    { lcd.print("Stable  ="); }
    } else { lcd.print("---------"); }

    // Row 3: status
    lcd.setCursor(0, 3);
    lcd.print("Status: ");
    if (!isnan(currentTemp)) {
        String lvl = alertLevel(currentTemp, Config::TEMP_NORMAL, Config::TEMP_WARNING);
        if      (lvl == "normal")   { lcd.print("NORMAL   "); lcd.write(CHR_CHECK); }
        else if (lvl == "warning")  { lcd.print("WARNING  "); lcd.write(CHR_WARN);  }
        else                        { lcd.print("CRITICAL!");                        }
    } else { lcd.print("NO SENSOR   "); }
}

void lcdPageHumidity() {
    lcdStatusBar(1);

    lcd.setCursor(0, 1);
    lcd.write(CHR_DROP);
    lcd.print(" Hum:  ");
    if (!isnan(currentHum)) {
        char buf[7]; dtostrf(currentHum, 5, 1, buf);
        lcd.print(buf); lcd.print(" %RH ");
    } else { lcd.print("  --.- %RH"); }

    lcd.setCursor(0, 2);
    lcd.print("Trend: ");
    if (!isnan(lastHum)) {
        float delta = currentHum - lastHum;
        if      (delta >  0.5f) { lcd.print("Rising  "); lcd.write(CHR_UP);  }
        else if (delta < -0.5f) { lcd.print("Falling "); lcd.write(CHR_DN);  }
        else                    { lcd.print("Stable  ="); }
    } else { lcd.print("---------"); }

    lcd.setCursor(0, 3);
    lcd.print("Status: ");
    if (!isnan(currentHum)) {
        String lvl = humLevel(currentHum);
        if      (lvl == "normal")   { lcd.print("NORMAL   "); lcd.write(CHR_CHECK); }
        else if (lvl == "warning")  { lcd.print("WET-WARN "); lcd.write(CHR_WARN);  }
        else                        { lcd.print("DRY-CRIT!");                        }
    } else { lcd.print("NO SENSOR   "); }
}

void lcdSplash() {
    lcd.clear();
    lcdRow(1, "  FACTORY MONITOR PRO ");
    lcdRow(2, "     v3.0  (AIPL-01)  ");
    lcdRow(3, "  Initializing....    ");
}

// ============================================================
//  OTA SETUP  [OTA]
// ============================================================
void setupOTA() {
    String otaPass = nvsGet("ota_pass", Config::OTA_PASSWORD);

    ArduinoOTA.setHostname(Config::OTA_HOSTNAME);
    ArduinoOTA.setPassword(otaPass.c_str());

    ArduinoOTA.onStart([]() {
        otaActive = true;
        lcd.clear();
        lcdRow(1, "  ** OTA UPDATE **  ");
        lcdRow(2, "  Do NOT power off! ");
        Serial.println("[OTA] Update started");
    });

    ArduinoOTA.onEnd([]() {
        otaActive = false;
        lcdRow(3, "  Done! Rebooting.. ");
        Serial.println("[OTA] Complete — rebooting");
        // WDT will not fire here; ESP restarts automatically after onEnd
    });

    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
        // [WDT] feed during long OTA transfer to prevent spurious reset
        esp_task_wdt_reset();
        uint8_t pct = progress * 100 / total;
        char buf[21];
        snprintf(buf, sizeof(buf), "  Progress: %3d %%    ", pct);
        lcdRow(3, buf);
    });

    ArduinoOTA.onError([](ota_error_t err) {
        otaActive = false;
        Serial.printf("[OTA] Error #%u\n", err);
        lcdRow(3, "  OTA ERROR!        ");
    });

    ArduinoOTA.begin();
    Serial.println("[OTA] Ready — hostname: " + String(Config::OTA_HOSTNAME));
}

// ============================================================
//  WIFI — SELF-HEALING  [HEAL]
// ============================================================
/**
 * Called every WIFI_CHECK_MS.
 * If disconnected, attempts reconnect WITHOUT blocking the loop.
 * WiFiManager handles first-time provisioning via captive portal.
 */
void wifiTask() {
    if (WiFi.status() == WL_CONNECTED) {
        if (!wifiOnline) {
            wifiOnline = true;
            Serial.println("[WiFi] Connected — IP: " + WiFi.localIP().toString());
        }
        return;
    }

    // Lost connection
    if (wifiOnline) {
        wifiOnline  = false;
        mqttOnline  = false;
        Serial.println("[WiFi] Connection lost — will retry");
    }

    // Non-blocking reconnect attempt (begin() is async on ESP32)
    Serial.println("[WiFi] Attempting reconnect...");
    WiFi.reconnect();
    // Connection result will be checked on the next wifiTask() call
}

// ============================================================
//  MQTT / THINGSBOARD — SELF-HEALING  [HEAL]
// ============================================================
/**
 * Publishes a JSON telemetry payload to ThingsBoard.
 * Uses MQTT QoS 0 (fire-and-forget) for minimal blocking.
 */
void mqttPublish() {
    if (!mqttClient.connected() || isnan(currentTemp) || isnan(currentHum)) return;

    char payload[128];
    snprintf(payload, sizeof(payload),
        "{\"temperature\":%.1f,\"humidity\":%.1f,\"tempLevel\":\"%s\",\"humLevel\":\"%s\"}",
        currentTemp, currentHum,
        alertLevel(currentTemp, Config::TEMP_NORMAL, Config::TEMP_WARNING).c_str(),
        humLevel(currentHum).c_str());

    bool ok = mqttClient.publish("v1/devices/me/telemetry", payload);
    if (ok) Serial.printf("[MQTT] Sent → %s\n", payload);
    else    Serial.println("[MQTT] Publish failed");
}

/**
 * Called every MQTT_CHECK_MS.
 * Reconnects silently if broker is unreachable without stalling the loop.
 */
void mqttTask() {
    if (!wifiOnline) return;

    if (mqttClient.connected()) {
        mqttOnline = true;
        mqttClient.loop();   // keep-alive
        return;
    }

    mqttOnline = false;
    String token = nvsGet("tb_token", Config::TB_TOKEN);  // [NVS] read token at runtime

    Serial.print("[MQTT] Connecting to ThingsBoard... ");
    // connect() has a ~3 s TCP timeout — acceptable since it's infrequent
    if (mqttClient.connect("ESP32-FactMon", token.c_str(), nullptr)) {
        mqttOnline = true;
        Serial.println("OK");
    } else {
        Serial.printf("Failed (rc=%d) — will retry in %d s\n",
                       mqttClient.state(), Config::MQTT_CHECK_MS / 1000);
    }
}

// ============================================================
//  SENSOR TASK  [NOB] [CAL]
// ============================================================
void sensorTask() {
    int rc = sht30.get();

    if (rc != 0) {
        Serial.println("[SHT30] Read error — check wiring");
        // Retain last known values; LCD shows them stale rather than NaN
        return;
    }

    float calT, calH;
    if (!applyCalibration(sht30.cTemp, sht30.humidity, calT, calH)) {
        Serial.printf("[SHT30] Out-of-range raw: T=%.2f H=%.2f\n",
                       sht30.cTemp, sht30.humidity);
        return;
    }

    // [CAL] Accept reading
    lastTemp    = currentTemp;
    lastHum     = currentHum;
    currentTemp = calT;
    currentHum  = calH;

    pushHistory(currentTemp, currentHum);

    Serial.printf("[Sensor] T=%.1f°C  H=%.1f%%RH\n", currentTemp, currentHum);
}

// ============================================================
//  LCD TASK  [NOB]
// ============================================================
void lcdTask() {
    // Rotate page every LCD_PAGE_MS
    if (millis() - tLCDPage > Config::LCD_PAGE_MS) {
        lcdPage = (lcdPage + 1) % 2;
        lcd.clear();
        tLCDPage = millis();
    }

    if (lcdPage == 0) lcdPageTemperature();
    else              lcdPageHumidity();
}

// ============================================================
//  WEB API
// ============================================================
const char HTML_ROOT[] PROGMEM = R"html(<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Factory Monitor Pro</title>
<style>
  body{font-family:sans-serif;background:#1a1a2e;color:#eee;padding:16px}
  h1{color:#e94560}
  .card{background:#16213e;border-radius:8px;padding:16px;margin:8px 0}
  .val{font-size:2rem;font-weight:bold}
  .norm{color:#2ecc71} .warn{color:#f39c12} .crit{color:#e74c3c}
  a{color:#e94560}
</style></head>
<body>
<h1>Factory Monitor Pro</h1>
<div id="d"></div>
<script>
async function refresh(){
  const r=await fetch('/api/current');
  const d=await r.json();
  document.getElementById('d').innerHTML=`
    <div class="card"><p>Temperature</p>
      <p class="val ${d.tempLevel}">${d.temp} °C</p>
      <p>Status: ${d.tempLevel.toUpperCase()}</p></div>
    <div class="card"><p>Humidity</p>
      <p class="val ${d.humLevel}">${d.hum} %RH</p>
      <p>Status: ${d.humLevel.toUpperCase()}</p></div>
    <p><a href="/api/all-data">Download JSON history</a></p>`;
}
refresh(); setInterval(refresh,5000);
</script></body></html>)html";

void httpRoot()    { webServer.send_P(200, "text/html", HTML_ROOT); }

void httpCurrent() {
    String j = "{";
    j += "\"temp\":"     + (isnan(currentTemp) ? String("null") : String(currentTemp,1)) + ",";
    j += "\"hum\":"      + (isnan(currentHum)  ? String("null") : String(currentHum,1))  + ",";
    j += "\"tempLevel\":\"" + (isnan(currentTemp) ? "unknown" : alertLevel(currentTemp, Config::TEMP_NORMAL, Config::TEMP_WARNING)) + "\",";
    j += "\"humLevel\":\"" + (isnan(currentHum)  ? "unknown" : humLevel(currentHum)) + "\",";
    j += "\"wifi\":"     + String(wifiOnline ? "true" : "false") + ",";
    j += "\"mqtt\":"     + String(mqttOnline ? "true" : "false");
    j += "}";
    webServer.sendHeader("Access-Control-Allow-Origin", "*");
    webServer.send(200, "application/json", j);
}

void httpHistory() {
    // Stream large JSON to avoid single large String allocation
    webServer.setContentLength(CONTENT_LENGTH_UNKNOWN);
    webServer.sendHeader("Access-Control-Allow-Origin", "*");
    webServer.send(200, "application/json", "");

    WiFiClient client = webServer.client();
    client.print("[");

    int start = (histIdx - histTotal + Config::MAX_READINGS) % Config::MAX_READINGS;
    bool first = true;
    for (int i = 0; i < histTotal; i++) {
        int idx = (start + i) % Config::MAX_READINGS;
        const SensorReading& r = history[idx];
        if (r.temp < -40 || r.temp > 125) continue;
        if (!first) client.print(",");
        first = false;
        client.printf("{\"ts\":\"%s\",\"t\":%.1f,\"h\":%.1f}",
            isoTime(r.ts).c_str(), r.temp, r.hum);
        // [WDT] Feed watchdog during potentially long history dump
        esp_task_wdt_reset();
    }
    client.print("]");
}

// ============================================================
//  SETUP
// ============================================================
void setup() {
    Serial.begin(115200);
    Serial.println("\n=== Factory Monitor Pro v3.0 ===");

    // [WDT] Enable hardware watchdog — 30 s timeout
    esp_task_wdt_init(Config::WDT_TIMEOUT_SEC, true);
    esp_task_wdt_add(nullptr);   // subscribe main task
    Serial.printf("[WDT] Enabled — timeout %d s\n", Config::WDT_TIMEOUT_SEC);

    // [NVS] Init persistent storage
    nvsInit();

    // I2C + LCD
    Wire.begin(Config::I2C_SDA, Config::I2C_SCL);
    lcd.init();
    lcd.backlight();
    lcdCreateChars();
    lcdSplash();
    Serial.println("[LCD] Initialised");

    // WiFiManager — blocking only during first-time captive portal
    WiFiManager wm;
    wm.setAPCallback([](WiFiManager* m){
        Serial.println("[WiFi] Config portal open: FactoryMonitor_Setup");
        lcd.clear();
        lcdRow(1, " Connect to WiFi AP:");
        lcdRow(2, "FactoryMonitor_Setup");
        lcdRow(3, "Pass: password123   ");
    });

    // [HEAL] autoConnect will return even if WiFi fails after portal timeout
    if (!wm.autoConnect("FactoryMonitor_Setup", "password123")) {
        Serial.println("[WiFi] Initial connect failed — will retry in loop");
        wifiOnline = false;
    } else {
        wifiOnline = true;
        Serial.println("[WiFi] Connected: " + WiFi.localIP().toString());

        // NTP sync (only after WiFi up)
        configTime(Config::GMT_OFFSET_SEC, Config::DST_OFFSET_SEC, Config::NTP_SERVER);
        Serial.println("[NTP] Sync started");

        // [OTA] Register OTA handlers
        setupOTA();
    }

    // MQTT broker config
    mqttClient.setServer(Config::TB_HOST, Config::TB_PORT);
    mqttClient.setKeepAlive(60);

    // Web server routes
    webServer.on("/",            httpRoot);
    webServer.on("/api/current", httpCurrent);
    webServer.on("/api/all-data",httpHistory);
    webServer.begin();
    Serial.println("[HTTP] Server listening on port 80");

    // Init timers so tasks fire immediately on first loop pass
    tLastSensor  = millis() - Config::SENSOR_INTERVAL_MS;
    tLastCloud   = millis() - Config::CLOUD_INTERVAL_MS;
    tLastLCD     = millis() - Config::LCD_INTERVAL_MS;
    tLastWiFiChk = millis() - Config::WIFI_CHECK_MS;
    tLastMqttChk = millis() - Config::MQTT_CHECK_MS;
    tLCDPage     = millis();

    Serial.println("[System] Ready — entering main loop\n");
}

// ============================================================
//  LOOP  — [NOB] Non-blocking, millis()-based scheduler
// ============================================================
void loop() {
    uint32_t now = millis();

    // ── [WDT] Feed watchdog every iteration ─────────────────
    esp_task_wdt_reset();

    // ── [OTA] Handle OTA requests ────────────────────────────
    if (wifiOnline) ArduinoOTA.handle();

    // ── HTTP server ──────────────────────────────────────────
    webServer.handleClient();

    // Skip sensor/cloud tasks during OTA to avoid I2C conflicts
    if (otaActive) return;

    // ── WiFi health check  [HEAL] ────────────────────────────
    if (now - tLastWiFiChk >= Config::WIFI_CHECK_MS) {
        tLastWiFiChk = now;
        wifiTask();
    }

    // ── MQTT health check + keep-alive  [HEAL] ───────────────
    if (now - tLastMqttChk >= Config::MQTT_CHECK_MS) {
        tLastMqttChk = now;
        mqttTask();
    }

    // ── Sensor read every 2 s  [CAL] ────────────────────────
    if (now - tLastSensor >= Config::SENSOR_INTERVAL_MS) {
        tLastSensor = now;
        sensorTask();
    }

    // ── Cloud publish every 10 s ─────────────────────────────
    if (now - tLastCloud >= Config::CLOUD_INTERVAL_MS) {
        tLastCloud = now;
        mqttPublish();
    }

    // ── LCD update every 2 s ─────────────────────────────────
    if (now - tLastLCD >= Config::LCD_INTERVAL_MS) {
        tLastLCD = now;
        lcdTask();
    }

    // Tiny yield so background tasks (TCP stack, etc.) get CPU time
    yield();
}