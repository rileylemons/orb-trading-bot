@echo off
cd /d "C:\Users\riley\Desktop\Trading"
node bot.js >> "C:\Users\riley\Desktop\Trading\logs\%date:~-4%-%date:~4,2%-%date:~7,2%.txt" 2>&1
