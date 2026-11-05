@echo off
REM Heimdall one-click setup + launcher.
REM NOTE: keep this file pure ASCII (Windows cmd encoding pitfall).

setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"

where node >nul 2>nul
if errorlevel 1 (
  echo [Heimdall] Node.js was not found.
  echo Install Node.js 22.13 or newer, reopen the terminal, then double-click this file again.
  pause
  exit /b 1
)

echo [Heimdall] preparing dependencies, browser, console, MCP and engine...
node "%ROOT%bin\heimdall.mjs" setup --no-connect
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [Heimdall] setup failed. Read the messages above.
  pause
  exit /b %RC%
)

node "%ROOT%core\scripts\check-console-routes.mjs" --base http://127.0.0.1:8900
if errorlevel 1 (
  echo [Heimdall] WARNING: setup is ready, but some console buttons call missing engine routes.
)

echo [Heimdall] ready: http://127.0.0.1:8900
exit /b 0
