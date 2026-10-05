@echo off
setlocal
rem =====================================================
rem  relay-gate startup script (Windows / srvany service)
rem  Requires: Node.js >= 22.5 (built-in node:sqlite)
rem
rem  Service-mode notes:
rem  - Do not use pause: it hangs forever with no interactive terminal.
rem  - Redirect stdout/stderr into logs\, otherwise srvany loses them.
rem  - node runs in the foreground: exit ends the service, the service
rem    manager decides whether to restart it.
rem
rem  Comments here are ASCII on purpose. cmd.exe decodes .bat files with the
rem  OEM codepage (GBK on zh-CN Windows), so UTF-8 Chinese comments render as
rem  mojibake in the console.
rem =====================================================
cd /d "%~dp0"

rem Listen port must match src/index.js default (19900); override via .env PORT.
set "PORT=19900"
if defined PORT_ENV_OVERRIDE set "PORT=%PORT_ENV_OVERRIDE%"

if not exist logs mkdir logs

rem Rotate logs at startup once they exceed ~8MB (keep one previous generation).
rem Without this the redirect target grows without bound across restarts.
set "MAXBYTES=8388608"
for %%F in (logs\relay.out.log logs\relay.err.log) do (
  if exist "%%F" (
    for %%A in ("%%F") do if %%~zA GTR %MAXBYTES% move /y "%%F" "%%F.1" >nul
  )
)

rem Install deps on first run (remove or comment out if installed)
if not exist node_modules\express (
  echo [relay-gate] installing dependencies...
  call npm install
)

rem Kill orphaned relay-gate node from a previous service instance. srvany's
rem stop only kills the cmd wrapper; the node child survives and keeps holding
rem port %PORT%, so a fresh start would fail to bind or worse, two schedulers
rem would run side by side. Pure cmd (netstat+tasklist): the former powershell
rem helper took ~26s just for Get-NetTCPConnection, delaying every restart.
rem Only kill when the port owner really is node.exe: tasklist CSV echoes
rem "name","PID",... and for-variables keep the quotes, so compare with %%~
rem (quote-stripped) on both sides.
echo [relay-gate] killing orphaned node holding port %PORT% if any...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr /C:"LISTENING"') do (
  for /f "usebackq tokens=1,2 delims=," %%A in (`tasklist /FI "PID eq %%P" /FO CSV /NH`) do (
    if /I "%%~A"=="node.exe" if "%%~B"=="%%~P" (
      echo [relay-gate] killing orphaned node pid %%~B >> logs\relay.out.log
      taskkill /F /PID %%~B >nul 2>&1
    )
  )
)

echo [relay-gate] starting %DATE% %TIME% >> logs\relay.out.log
node src\index.js >> logs\relay.out.log 2>> logs\relay.err.log
echo [relay-gate] node exited with errorlevel %ERRORLEVEL% at %DATE% %TIME% >> logs\relay.err.log