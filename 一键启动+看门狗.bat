@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 客服小祥（QQ + 机器人 + 看门狗）—— 别关这个窗口
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-with-watchdog.ps1"
echo.
echo 看门狗已停止。按任意键关闭。
pause >nul
