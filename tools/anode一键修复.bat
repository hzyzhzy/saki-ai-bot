@echo off
chcp 65001 >nul
title Anode 一键修复 + 验证
echo ============================================================
echo  Anode 一键修复 + 验证
echo  用法：右键这个文件 →「以管理员身份运行」
echo ============================================================
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo [错误] 不是管理员权限。
  echo        请右键 -^> 「以管理员身份运行」。
  pause
  exit /b 1
)

echo [1/5] 启动 RDP 相关服务...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "foreach($n in 'RDPDR','UmRdpService','SessionEnv','TermService'){ $s=Get-Service $n -ErrorAction SilentlyContinue; if($s -and $s.Status -ne 'Running'){ try{ Start-Service $n -ErrorAction Stop; Write-Host \"  OK $n\" }catch{ Write-Host \"  FAIL $n : $($_.Exception.Message)\" } } else { Write-Host \"  OK $n (already running)\" } }"
echo.

echo [2/5] 备份 RDP-Tcp 注册表...
reg export "HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp" "C:\Temp\rdp-tcp-backup.reg" /y >nul 2>&1
if exist "C:\Temp\rdp-tcp-backup.reg" (echo   OK 备份到 C:\Temp\rdp-tcp-backup.reg) else (echo   WARN 备份失败，继续)
echo.

echo [3/5] 生成/绑定 RDP 证书...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-rdp-cert-bind.ps1"
echo.

echo [4/5] 检查 3389...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$l=Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue; if($l){ Write-Host ('  OK 3389 在听 pid=' + $l.OwningProcess) -ForegroundColor Green } else { Write-Host '  FAIL 3389 没起' -ForegroundColor Red }"
echo.

echo [5/5] Anode 体检...
set ANODE=%LOCALAPPDATA%\Programs\Anode\anode.exe
if exist "%ANODE%" (
  "%ANODE%" doctor
) else (
  echo   Anode 没找到，跳过
)
echo.

echo ============================================================
echo  如果 3389 起了：回普通终端跑  anode start --hidden
echo  如果还是不行：把上面输出发给我，或者先重启机器再跑一次这个
echo ============================================================
pause
