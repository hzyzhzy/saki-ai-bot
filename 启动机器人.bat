@echo off
chcp 65001 >nul
title QQ AI 机器人
cd /d "%~dp0"

if not exist "node_modules" (
    echo 首次运行，正在安装依赖...
    call npm install --no-fund --no-audit
    if errorlevel 1 (
        echo.
        echo 依赖安装失败。请确认已安装 Node.js 且网络正常。
        pause
        exit /b 1
    )
)

echo ============================================
echo   QQ AI 机器人启动中...
echo   停止请按 Ctrl+C
echo ============================================
echo.

node src/index.js

echo.
echo 机器人已退出。
pause
