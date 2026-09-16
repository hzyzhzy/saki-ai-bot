@echo off
chcp 65001 >nul
title 停止客服小祥
cd /d "%~dp0"

echo 正在停止机器人...
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'src[\\\\/]index\.js' } | ForEach-Object { Write-Host ('  停止 PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo.
echo 已停止。（NapCat / QQ 不会被关闭，机器人下次启动会重新连上）
timeout /t 3 /nobreak >nul
