@echo off
rem =====================================================
rem  relay-gate startup script (Windows / srvany service)
rem  Requires: Node.js >= 22.5 (built-in node:sqlite)
rem
rem  服务模式下注意：
rem  - 不使用 pause：无交互终端时会永久挂死
rem  - stdout/stderr 重定向到 logs/，否则 srvany 下日志丢失
rem  - node 前台运行：退出即让服务结束，由服务管理器决定是否拉起
rem =====================================================
cd /d "%~dp0"

if not exist logs mkdir logs

rem Install deps on first run (remove or comment out if installed)
if not exist node_modules\express (
  echo [relay-gate] installing dependencies...
  call npm install
)

echo [relay-gate] starting %DATE% %TIME% >> logs\relay.out.log
node src\index.js >> logs\relay.out.log 2>> logs\relay.err.log
echo [relay-gate] node exited with errorlevel %ERRORLEVEL% at %DATE% %TIME% >> logs\relay.err.log
