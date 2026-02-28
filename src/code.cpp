#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// Set the LCD address to 0x27 (standard for these I2C backpacks)
LiquidCrystal_I2C lcd(0x3F, 20, 4);
void setup() {
    // 1. DISABLE BROWNOUT: Stops the board from resetting immediately
    WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0); 

    Serial.begin(115200);
    delay(2000); // Give the LCD time to power up

    // 2. SLOW I2C: 50kHz is the most stable speed for 20x4 displays
    Wire.begin(4, 22, 50000); 

    // 3. LCD WAKE-UP
    lcd.init();          
    delay(500);          
    lcd.backlight();     
    lcd.clear();         
    
    // 4. PRINT TEST
    lcd.setCursor(0, 0);
    lcd.print("HI NAVEEN");
    lcd.setCursor(0, 1);
    lcd.print("I2C TEST OK");
    
    Serial.println("Test message 'HI' sent to LCD");
}

void loop() {
    // Do nothing
}