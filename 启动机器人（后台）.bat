@echo off
chcp 65001 >nul
title 客服小祥 · 启动器（后台）
cd /d "%~dp0"

echo ============================================
echo   客服小祥 启动中...
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 找不到 node，请先安装 Node.js
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo 首次运行，正在安装依赖...
    call npm install --no-fund --no-audit
)
if not exist "logs" mkdir logs

rem ── 先检查 QQ 协议端（NapCat）在不在 ──
rem 机器人只是 OneBot 客户端，没有 NapCat 就连不上 QQ。
rem 注意：用「写临时文件再读」来捕获 PowerShell 输出。
rem for /f 包 powershell 在这台机器上不可靠（实测返回 0，踩过）；
rem errorlevel 在管道 + powershell 组合下也不可靠。
set "NAPFILE=%TEMP%\_napcat_check.txt"
powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count" > "%NAPFILE%" 2>nul
set "NAP=0"
if exist "%NAPFILE%" set /p NAP=<"%NAPFILE%"
del "%NAPFILE%" >nul 2>&1

if "%NAP%"=="0" (
    echo [提醒] NapCat（QQ 协议端）没在跑，机器人连不上 QQ。
    echo        请先双击「一键启动（QQ+机器人）.bat」，它会连 NapCat 一起起。
    echo.
    set "GO="
    set /p "GO=还是要只启动机器人吗？(y/N) "
    if /i not "%GO%"=="y" exit /b 1
    echo.
) else (
    echo NapCat 已在运行，继续。
    echo.
)

echo 机器人正在后台启动，日志写入 logs\bot.log
echo 管理界面： http://127.0.0.1:3099
echo.
echo 这个窗口可以关掉，机器人会继续在后台运行。
echo 想停止机器人，双击「停止机器人.bat」。
echo.

rem 重定向交给 _run-bot.bat，避免引号转义问题
start "客服小祥" /min cmd /c "_run-bot.bat"

rem 等待并轮询日志（用 ping 代替 timeout —— timeout 在重定向环境下会报错）
set /a WAITED=0
:wait
ping -n 2 -w 1000 127.0.0.1 >nul 2>&1
set /a WAITED+=2
findstr /C:"已连接到 NapCat" "logs\bot.log" >nul 2>&1
if not errorlevel 1 goto ready
if %WAITED% GEQ 20 goto showlog
<nul set /p "=."
goto wait

:ready
echo.
echo       机器人已连接。
:showlog
echo --------------------------------------------
type logs\bot.log 2>nul
echo --------------------------------------------
echo.

set "ANS="
set /p "ANS=现在打开管理界面吗？(Y/n) "
if /i "%ANS%"=="n" exit /b 0
start "" "http://127.0.0.1:3099"
