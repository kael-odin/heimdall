@echo off
REM Heimdall one-click launcher: engine + console + browser
REM NOTE: keep this file pure ASCII (Windows cmd encoding pitfall)

setlocal
set ROOT=%~dp0
REM child processes inherit this so the route check can find console/dist
set ROOT_DIR=%ROOT%

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

REM ---- route check: every /api/ path the console knows about must exist on this engine ----
REM A path extracted from the console bundle that the engine does not serve is a 404 in the
REM browser with no useful message. Cheap to catch here; silent for 7 days otherwise.
node -e "const fs=require('fs'),path=require('path');const dir=path.join(process.env.ROOT_DIR,'console','dist','assets');let files=[];try{files=fs.readdirSync(dir).filter(f=>f.endsWith('.js'))}catch(e){process.exit(0)}const known=new Set();for(const f of files){const t=fs.readFileSync(path.join(dir,f),'utf8');for(const m of t.matchAll(/['`](\/api\/[a-z0-9\/\-:_.]*)['`]/gi)){known.add(m[1].replace(/\/\$\{[^}]*\}/g,':id'.replace(':id','{')));}}const base='http://127.0.0.1:8900';const hdr=process.env.HEIMDALL_TOKEN?{'x-heimdall-token':process.env.HEIMDALL_TOKEN}:{};(async()=>{const bad=[];for(const p of known){const url=p.replace(/\{[^}]*\}/g,'x');let r;try{r=await fetch(base+url,{method:'GET',headers:hdr})}catch(e){continue}if(r.status===404&&/unknown|not found|no route/i.test((await r.text()).slice(0,200)))bad.push(p)}if(bad.length){console.log('');console.log('[Heimdall] WARNING: console calls these engine routes, but the engine does not serve them:');for(const b of bad)console.log('  - '+b);console.log('  (UI buttons backed by them will fail with 404)')}else{console.log('[Heimdall] route check: all '+known.size+' /api paths the console uses are served.')}})().catch(()=>{})"
set RC=%ERRORLEVEL%

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
