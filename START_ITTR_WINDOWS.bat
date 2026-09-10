@echo off
setlocal
cd /d "%~dp0"
title ITTR ShopFlow v20.1

echo.
echo ============================================
echo   ITTR ShopFlow v20.1
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed.
  echo Install Node.js LTS, then run this file again.
  echo https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First run: installing required packages...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  echo Creating .env configuration file...
  copy /Y ".env.example" ".env" >nul
)

findstr /C:"OPENAI_API_KEY=your_server_side_key" ".env" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo NOTE: AI is not configured yet.
  echo The main shop platform will still open and work.
  echo For AI features, edit .env and replace:
  echo OPENAI_API_KEY=your_server_side_key
  echo with your server-side OpenAI API key.
  echo.
)

echo Starting ITTR server...
start "ITTR ShopFlow Server" cmd /k "cd /d ""%~dp0"" && npm start"

echo Waiting for server...
timeout /t 3 /nobreak >nul

echo Opening ITTR in your browser...
start "" "http://localhost:3000"

echo.
echo ITTR has been launched.
echo Keep the "ITTR ShopFlow Server" window open while using the site.
echo.
pause
