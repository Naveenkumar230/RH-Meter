// ── Core / RTOS ─────────────────────────────────────────────
#include <Arduino.h>
#include <Wire.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include <esp_task_wdt.h>

// ── Connectivity ─────────────────────────────────────────────
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <ArduinoOTA.h>
#include <PubSubClient.h>

// ── Persistence ──────────────────────────────────────────────
#include <Preferences.h>

// ── Sensor ───────────────────────────────────────────────────
#include <Adafruit_SHT31.h>

// ── Display ──────────────────────────────────────────────────
#include <LiquidCrystal_I2C.h>

// ── Web / Time ───────────────────────────────────────────────
#include <WebServer.h>
#include <time.h>

// ============================================================
//  ISRG Root X1 Certificate — required for HiveMQ TLS
// ============================================================
static const char ISRG_ROOT_X1[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoBggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)EOF";

// ============================================================
//  CONFIGURATION
// ============================================================
namespace Config {
    constexpr const char* WIFI_SSID       = "AIPL-IOT";
    constexpr const char* WIFI_PASS       = "@ipl2027";

    // constexpr const char* DEVICE_ID    = "Meter_01";  // new code
    // constexpr const char* DEVICE_ID    = "Meter_02";  // old code
    // constexpr const char* DEVICE_ID    = "Meter_03";  // new code 
    //    constexpr const char* DEVICE_ID    = "Meter_04";  // new code
    constexpr const char* DEVICE_ID    = "Meter_05"; //new code
    // constexpr const char* DEVICE_ID    = "Meter_06"; //new code 
    // constexpr const char* DEVICE_ID    = "Meter_07"; //new code
    // constexpr const char* DEVICE_ID    = "Meter_08"; // old code
    // constexpr const char* DEVICE_ID    = "Meter_09"; // completed
    // constexpr const char* DEVICE_ID    = "Meter_10"; //completed
    // constexpr const char* DEVICE_ID    = "Meter_11";   //completed
    // constexpr const char* DEVICE_ID    = "Meter_12"; // completed
    // constexpr const char* DEVICE_ID    = "Meter_13"; // completed
    // constexpr const char* DEVICE_ID    = "Meter_14";  

    // ── HiveMQ Broker ────────────────────────────────────────
    constexpr const char* MQTT_HOST    = "d034db44805b4258a6c72c3efe0f9019.s1.eu.hivemq.cloud";
    constexpr int         MQTT_PORT    = 8883;
    constexpr const char* MQTT_USER    = "RH-METER";
    constexpr const char* MQTT_PASS    = "RH-METEr1234";

    // constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_01/telemetry";  
    // constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_02/telemetry";
    // constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_03/telemetry";
    // constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_04/telemetry";
    constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_05/telemetry";
    // constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_06/telemetry";
    // constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_07/telemetry";
    // constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_08/telemetry";
    // constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_09/telemetry";
    // constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_10/telemetry";  //Recalibration done
    // constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_11/telemetry";    //Reclaribation done
    // constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_12/telemetry";  // Reclaribation done
    //    constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_13/telemetry";     //ReCalibration Done 
    // constexpr const char* MQTT_TOPIC = "AIPL/RH_Meter/Meter_14/telemetry";

    // OTA
    constexpr const char* OTA_HOSTNAME    = "FactoryMonitor";
    constexpr const char* OTA_PASSWORD    = "ota_admin_2024";

    // NTP
    constexpr const char* NTP_SERVER      = "pool.ntp.org";
    constexpr long         GMT_OFFSET_SEC  = 19800; // IST
    constexpr int          DST_OFFSET_SEC  = 0;

    // Calibration
    constexpr float TEMP_OFFSET           = 0.4f;
    constexpr float HUM_OFFSET            = 2.0f;

    // Thresholds
    constexpr float TEMP_NORMAL           = 27.0f;
    constexpr float TEMP_WARNING          = 35.0f;
    constexpr float HUM_DRY_LIMIT         = 40.0f;
    constexpr float HUM_WET_LIMIT         = 70.0f;

    constexpr uint32_t WDT_TIMEOUT_SEC    = 300;

    // Timing intervals (ms)
    constexpr uint32_t SENSOR_INTERVAL_MS = 2000;
    constexpr uint32_t CLOUD_INTERVAL_MS  = 10000;
    constexpr uint32_t LCD_INTERVAL_MS    = 2000;
    constexpr uint32_t WIFI_CHECK_MS      = 5000;
    constexpr uint32_t MQTT_CHECK_MS      = 5000;
    constexpr uint32_t LCD_PAGE_MS        = 6000;

    // ── Hardware Pins — DUAL I2C BUS ─────────────────────────
    constexpr int     I2C_SDA             = 18;   // SHT30 SDA → Wire  (Bus0)
    constexpr int     I2C_SCL             = 22;   // SHT30 SCL → Wire  (Bus0)
    constexpr int     LCD_SDA             = 21;   // LCD SDA   → Wire1 (Bus1)
    constexpr int     LCD_SCL             = 23;   // LCD SCL   → Wire1 (Bus1)


    // This before some of the divice goes with the
    // constexpr int     I2C_SDA             = 18;  
    // constexpr int     I2C_SCL             = 19;


    constexpr uint8_t LCD_ADDR            = 0x27;
    constexpr uint8_t SHT_ADDR            = 0x44;
    constexpr int     MAX_READINGS        = 2880;
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

enum LcdChar : uint8_t { CHR_DEG=0, CHR_UP, CHR_DN, CHR_DROP, CHR_THERM, CHR_CHECK, CHR_WARN, CHR_WIFI };

// ============================================================
//  GLOBAL OBJECTS
// ============================================================
Adafruit_SHT31    sht30;
LiquidCrystal_I2C lcd(Config::LCD_ADDR, 16, 2);
WebServer         webServer(80);
Preferences       prefs;

WiFiClientSecure  secureClient;
PubSubClient      mqttClient(secureClient);

// ============================================================
//  STATE
// ============================================================
struct SensorReading { time_t ts; float temp; float hum; };

SensorReading history[Config::MAX_READINGS];
int  histIdx    = 0;
int  histTotal  = 0;

float currentTemp = NAN;
float currentHum  = NAN;
float lastTemp    = NAN;
float lastHum     = NAN;

bool  wifiOnline  = false;
bool  mqttOnline  = false;
bool  otaActive   = false;
bool  sensorReady = false;

uint32_t tLastSensor  = 0;
uint32_t tLastCloud   = 0;
uint32_t tLastLCD     = 0;
uint32_t tLastWiFiChk = 0;
uint32_t tLastMqttChk = 0;
uint32_t tLCDPage     = 0;
uint8_t  lcdPage      = 0;

// ============================================================
//  NVS HELPERS
// ============================================================
void nvsInit() {
    prefs.begin("factory", false);
    if (!prefs.isKey("mqtt_pass")) {
        prefs.putString("mqtt_pass", Config::MQTT_PASS);
        prefs.putString("ota_pass",  Config::OTA_PASSWORD);
        Serial.println("[NVS] First boot — defaults written");
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

void lcdRow(uint8_t row, const String& text, uint8_t width = 16) {
    lcd.setCursor(0, row);
    String s = text;
    while ((int)s.length() < width) s += ' ';
    lcd.print(s.substring(0, width));
}

void lcdPageTemperature() {
    lcdRow(0, " TEMPERATURE");
    lcd.setCursor(2, 1);
    lcd.write(CHR_THERM);
    lcd.print(" ");
    if (!isnan(currentTemp)) {
        char buf[7];
        dtostrf(currentTemp, 5, 1, buf);
        lcd.print(buf);
        lcd.write(CHR_DEG);
        lcd.print("C");
    } else {
        lcd.print("--.-");
        lcd.write(CHR_DEG);
        lcd.print("C");
    }
}

void lcdPageHumidity() {
    lcdRow(0, "  HUMIDITY");
    lcd.setCursor(2, 1);
    lcd.write(CHR_DROP);
    lcd.print(" ");
    if (!isnan(currentHum)) {
        char buf[7];
        dtostrf(currentHum, 5, 1, buf);
        lcd.print(buf);
        lcd.print("% RH");
    } else {
        lcd.print("--.- %");
    }
}

void lcdSplash() {
    lcd.clear();
    lcdRow(0, "Factory Monitor");
    lcdRow(1, "Initializing...");
}

// ============================================================
//  OTA SETUP
// ============================================================
void setupOTA() {
    ArduinoOTA.setHostname(Config::OTA_HOSTNAME);
    ArduinoOTA.setPassword(nvsGet("ota_pass", Config::OTA_PASSWORD).c_str());

    ArduinoOTA.onStart([]() {
        otaActive = true;
        lcd.clear();
        lcdRow(0, "** OTA UPDATE **");
        lcdRow(1, "Do NOT power off");
        Serial.println("[OTA] Update started");
    });
    ArduinoOTA.onEnd([]() {
        otaActive = false;
        lcdRow(1, "Done! Rebooting.");
        Serial.println("[OTA] Complete");
    });
    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
        esp_task_wdt_reset();
        char buf[17];
        snprintf(buf, sizeof(buf), "Progress: %3d%%  ", progress * 100 / total);
        lcdRow(1, buf);
    });
    ArduinoOTA.onError([](ota_error_t err) {
        otaActive = false;
        Serial.printf("[OTA] Error #%u\n", err);
        lcdRow(1, "OTA ERROR!      ");
    });
    ArduinoOTA.begin();
    Serial.println("[OTA] Ready");
}

// ============================================================
//  WIFI — SELF-HEALING
// ============================================================
void wifiTask() {
    if (WiFi.status() == WL_CONNECTED) {
        if (!wifiOnline) {
            wifiOnline = true;
            Serial.println("[WiFi] Connected — IP: " + WiFi.localIP().toString());
        }
        return;
    }
    if (wifiOnline) {
        wifiOnline = false;
        mqttOnline = false;
        Serial.println("[WiFi] Connection lost — retrying");
    }
    WiFi.reconnect();
}

// ============================================================
//  MQTT / HIVEMQ — SELF-HEALING
// ============================================================
void mqttPublish() {
    if (!mqttClient.connected() || isnan(currentTemp) || isnan(currentHum)) return;

    char payload[128];
    snprintf(payload, sizeof(payload),
        "{\"temp\":%.1f,\"hum\":%.1f,\"id\":\"%s\"}",
        currentTemp, currentHum, Config::DEVICE_ID);

    String dynamicTopic = "AIPL/RH_Meter/" + String(Config::DEVICE_ID) + "/telemetry";

    bool ok = mqttClient.publish(dynamicTopic.c_str(), payload);
    if (ok) {
        Serial.printf("[HiveMQ] Sent → %s : %s\n", dynamicTopic.c_str(), payload);
    } else {
        Serial.println("[HiveMQ] Publish failed");
    }
}

void mqttTask() {
    if (!wifiOnline) return;

    if (mqttClient.connected()) {
        mqttOnline = true;
        mqttClient.loop();
        return;
    }

    mqttOnline = false;
    secureClient.setInsecure();

    String clientId = "ESP32-" + String(Config::DEVICE_ID) + "-" + String(random(0xffff), HEX);

    Serial.print("[HiveMQ] Connecting... ");
    if (mqttClient.connect(clientId.c_str(), Config::MQTT_USER, Config::MQTT_PASS)) {
        mqttOnline = true;
        Serial.println("Connected ✅");
    } else {
        Serial.printf("Failed (rc=%d) — retry in %ds\n",
                      mqttClient.state(), Config::MQTT_CHECK_MS / 1000);
    }
}

// ============================================================
//  SENSOR TASK
// ============================================================
void sensorTask() {
    float rawT = sht30.readTemperature();
    float rawH = sht30.readHumidity();

    if (isnan(rawT) || isnan(rawH)) {
        // ── Do NOT reset Wire here — LCD is on separate Wire1 bus
        // ── Just keep last known good data
        Serial.println("[SHT30] Read error — keeping last good value");
        return;
    }

    float calT, calH;
    if (applyCalibration(rawT, rawH, calT, calH)) {
        lastTemp    = currentTemp;
        lastHum     = currentHum;
        currentTemp = calT;
        currentHum  = calH;
        pushHistory(currentTemp, currentHum);
        Serial.printf("[Sensor] T=%.1f°C  H=%.1f%%RH\n", currentTemp, currentHum);
    }
}

// ============================================================
//  LCD TASK
// ============================================================
void lcdTask() {
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
      <p class="val ${d.tempLevel}">${d.temp} °C</p></div>
    <div class="card"><p>Humidity</p>
      <p class="val ${d.humLevel}">${d.hum} %RH</p></div>`;
}
refresh(); setInterval(refresh,5000);
</script></body></html>)html";

void httpRoot()    { webServer.send_P(200, "text/html", HTML_ROOT); }

void httpCurrent() {
    String j = "{";
    j += "\"temp\":"        + (isnan(currentTemp) ? String("null") : String(currentTemp,1)) + ",";
    j += "\"hum\":"         + (isnan(currentHum)  ? String("null") : String(currentHum,1))  + ",";
    j += "\"tempLevel\":\"" + (isnan(currentTemp)  ? "unknown" : alertLevel(currentTemp, Config::TEMP_NORMAL, Config::TEMP_WARNING)) + "\",";
    j += "\"humLevel\":\""  + (isnan(currentHum)   ? "unknown" : humLevel(currentHum)) + "\",";
    j += "\"wifi\":"        + String(wifiOnline ? "true" : "false") + ",";
    j += "\"mqtt\":"        + String(mqttOnline ? "true" : "false");
    j += "}";
    webServer.sendHeader("Access-Control-Allow-Origin", "*");
    webServer.send(200, "application/json", j);
}

void httpHistory() {
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
        client.printf("{\"ts\":\"%s\",\"t\":%.1f,\"h\":%.1f}", isoTime(r.ts).c_str(), r.temp, r.hum);
        esp_task_wdt_reset();
    }
    client.print("]");
}

// ============================================================
//  SETUP
// ============================================================
void setup() {
    WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
    Serial.begin(115200);
    delay(2000);
    Serial.println("\n=== Factory Monitor Pro v3.0 — HiveMQ Edition ===");

    // ── 1. SHT30 on Wire (GPIO 18/22) ────────────────────────
    Wire.begin(Config::I2C_SDA, Config::I2C_SCL, 100000);
    if (!sht30.begin(Config::SHT_ADDR)) {
        Serial.println("[ERROR] SHT30 not found!");
        sensorReady = false;
    } else {
        Serial.println("[SHT30] Sensor initialized");
        sensorReady = true;
    }

    // ── 2. LCD on Wire1 (GPIO 21/23) — separate bus ──────────
    Wire1.begin(Config::LCD_SDA, Config::LCD_SCL, 100000);
    lcd.init();
    delay(500);
    lcd.backlight();
    lcd.clear();
    lcdCreateChars();
    lcdSplash();
    Serial.println("[LCD] Ready");

    nvsInit();

    // ── 3. WiFi ───────────────────────────────────────────────
    WiFiManager wm;
    wm.setConnectTimeout(30);
    wm.setConfigPortalTimeout(60);

    wm.setAPCallback([](WiFiManager* m){
        Serial.println("[WiFi] Config portal: FactoryMonitor_Setup");
        lcd.clear();
        lcdRow(0, "Connect to WiFi:");
        lcdRow(1, "FactoryMonitor_AP");
    });

    if (!wm.autoConnect("FactoryMonitor_Setup", "password123")) {
        Serial.println("[WiFi] Timeout — offline mode");
        wifiOnline = false;
    } else {
        wifiOnline = true;
        configTime(Config::GMT_OFFSET_SEC, Config::DST_OFFSET_SEC, Config::NTP_SERVER);
        setupOTA();
    }

    // ── 4. Web Server ─────────────────────────────────────────
    webServer.on("/",             httpRoot);
    webServer.on("/api/current",  httpCurrent);
    webServer.on("/api/all-data", httpHistory);
    webServer.begin();

    // ── 5. MQTT ───────────────────────────────────────────────
    mqttClient.setServer(Config::MQTT_HOST, Config::MQTT_PORT);
    mqttClient.setKeepAlive(60);
    mqttClient.setBufferSize(512);

    // ── 6. Watchdog (last step) ───────────────────────────────
    esp_task_wdt_init(Config::WDT_TIMEOUT_SEC, true);
    esp_task_wdt_add(nullptr);
    Serial.printf("[WDT] Enabled — timeout %ds\n", Config::WDT_TIMEOUT_SEC);

    tLastSensor = tLastCloud = tLastLCD = tLastWiFiChk = tLastMqttChk = tLCDPage = millis();

    Serial.println("[System] Ready\n");
}

// ============================================================
//  LOOP — non-blocking millis() scheduler
// ============================================================
void loop() {
    uint32_t now = millis();
    esp_task_wdt_reset();

    if (wifiOnline) ArduinoOTA.handle();
    webServer.handleClient();
    if (otaActive) return;

    if (now - tLastWiFiChk >= Config::WIFI_CHECK_MS) {
        tLastWiFiChk = now;
        wifiTask();
    }
    if (now - tLastMqttChk >= Config::MQTT_CHECK_MS) {
        tLastMqttChk = now;
        mqttTask();
    }
    if (sensorReady && now - tLastSensor >= Config::SENSOR_INTERVAL_MS) {
        tLastSensor = now;
        sensorTask();
    }
    if (now - tLastCloud >= Config::CLOUD_INTERVAL_MS) {
        tLastCloud = now;
        mqttPublish();
    }
    if (now - tLastLCD >= Config::LCD_INTERVAL_MS) {
        tLastLCD = now;
        lcdTask();
    }
    yield();
}