@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 客服小祥 看门狗（关掉这个窗口就停止）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0watchdog.ps1"
pause
