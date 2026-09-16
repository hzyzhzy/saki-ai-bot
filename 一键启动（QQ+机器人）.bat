@echo off
chcp 65001 >nul
title 一键启动 · QQ机器人 + 客服小祥
cd /d "%~dp0"

rem 真正的逻辑在 start-all.ps1（batch 的引号转义太容易出问题）
rem 参数透传： /y 直接开管理界面，/n 不打开
set "EXTRA="
if /i "%~1"=="/y" set "EXTRA=-OpenUi"
if /i "%~1"=="/n" set "EXTRA=-NoOpenUi"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1" %EXTRA%

if errorlevel 1 (
    echo.
    echo 启动未完成。
    pause
)
