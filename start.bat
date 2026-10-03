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

echo [relay-gate] starting %DATE% %TIME% >> logs\relay.out.log
node src\index.js >> logs\relay.out.log 2>> logs\relay.err.log
echo [relay-gate] node exited with errorlevel %ERRORLEVEL% at %DATE% %TIME% >> logs\relay.err.log