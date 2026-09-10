@echo off
cd /d "%~dp0"
start "ITTR ShopFlow Server" cmd /k "npm start"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000"
