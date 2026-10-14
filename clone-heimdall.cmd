@echo off
REM Heimdall one-click launcher: engine + console + browser
REM NOTE: keep this file pure ASCII (Windows cmd encoding pitfall)

setlocal
set ROOT=%~dp0

echo [Heimdall] starting engine on :8900 ...
start "heimdall-engine" /MIN /D "%ROOT%core" cmd /c "node src\engine-server.mjs 8900"

echo [Heimdall] starting console on :5173 ...
start "heimdall-console" /MIN /D "%ROOT%console" cmd /c "pnpm exec vite --port 5173 --host 127.0.0.1"

REM wait for both HTTP services; -f rejects 4xx/5xx (including bad token)
set TRIES=0
:waitloop
set /a TRIES+=1
if defined HEIMDALL_TOKEN (
  curl -fsS -o nul -H "x-heimdall-token: %HEIMDALL_TOKEN%" http://127.0.0.1:8900/api/status >nul 2>&1
) else (
  curl -fsS -o nul http://127.0.0.1:8900/api/status >nul 2>&1
)
if errorlevel 1 goto retry
curl -fsS -o nul http://127.0.0.1:5173/ >nul 2>&1
if errorlevel 1 goto retry

start "" "http://127.0.0.1:5173"
echo [Heimdall] ready: http://127.0.0.1:5173
exit /b 0

:retry
if %TRIES% geq 15 goto failed
timeout /t 2 /nobreak >nul
goto waitloop

:failed
echo [Heimdall] startup failed: engine or console did not pass HTTP health checks. 1>&2
exit /b 1
