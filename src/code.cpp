#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// 1. Set address to 0x3F for your specific adapter
LiquidCrystal_I2C lcd(0x3F, 20, 4); 

void setup() {
    Serial.begin(115200);
    
    // 2. Use Pin 4 (SDA) and Pin 22 (SCL) at a stable 50kHz speed
    Wire.begin(4, 22, 50000); 

    lcd.init();
    delay(500);
    lcd.backlight();
    lcd.clear();
    
    // 3. Print to the 20x4 grid
    lcd.setCursor(0, 0);
    lcd.print("METER_02 ONLINE");
    lcd.setCursor(0, 1);
    lcd.print("ADDR: 0x3F | P4");
}

void loop() {
    // Keep empty for now to test the display
}