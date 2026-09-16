@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 客服小祥（开机自启 · 勿关）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1"
