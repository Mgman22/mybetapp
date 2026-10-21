@echo off
setlocal
cd /d "%~dp0"
title STT Betting - Local Server
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not in PATH.
  echo Install Node.js 20 LTS or newer, then run this file again.
  pause
  exit /b 1
)
if not exist package.json (
  echo package.json was not found. Please extract the complete project ZIP first.
  pause
  exit /b 1
)
if not exist node_modules\express (
  echo Installing required packages for the first run...
  call npm install
  if errorlevel 1 (
    echo Package installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
echo Starting STT Betting local server...
call npm start
if errorlevel 1 (
  echo.
  echo Server stopped with an error. Read the message above.
  pause
)
endlocal
