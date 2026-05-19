@echo off
setlocal

cd /d "%~dp0"

REM --- Basic checks ---
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not in PATH.
  echo Install Node.js, then re-run this file.
  pause
  exit /b 1
)

REM --- Check for dependencies ---
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
    echo.
)

echo ================================================
echo            GAME NIGHT LAUNCHER
echo ================================================
echo.

REM --- Start server in separate window (keep open for logs) ---
echo Starting Game Launcher server...
start "Game Night Launcher" cmd /k "node server.js"

REM Give the server a moment to boot
timeout /t 2 /nobreak >nul

REM Open host screen in default browser
start "" "http://localhost:3000/"

exit /b 0
