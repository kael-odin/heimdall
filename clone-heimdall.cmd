@echo off
REM Heimdall one-click launcher: engine + console + browser
REM NOTE: keep this file pure ASCII (Windows cmd encoding pitfall)

setlocal
set ROOT=%~dp0

echo [Heimdall] starting engine on :8900 ...
start "heimdall-engine" /MIN cmd /c "cd /d %ROOT%core && node src\engine-server.mjs 8900"

echo [Heimdall] starting console on :5173 ...
start "heimdall-console" /MIN cmd /c "cd /d %ROOT%console && pnpm exec vite --port 5173 --host 127.0.0.1"

REM wait for both services then open browser
set TRIES=0
:waitloop
timeout /t 2 /nobreak >nul
set /a TRIES+=1
curl -s -o nul http://127.0.0.1:8900/api/status
if errorlevel 1 (
  if %TRIES% lss 15 goto waitloop
)
curl -s -o nul http://127.0.0.1:5173/
if errorlevel 1 (
  if %TRIES% lss 15 goto waitloop
)

start "" "http://127.0.0.1:5173"
echo [Heimdall] ready: console http://127.0.0.1:5173  archives http://127.0.0.1:8900/static/thordata.com/index.html
pause
