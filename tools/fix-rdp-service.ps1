# 修 RDP 监听器：真正缺的是两个依赖服务（不是证书权限）
#   UmRdpService（UserMode Port Redirector）—— RDP 监听器靠它，它 Stopped ⇒ 3389 不监听
#   SessionEnv（Remote Desktop Configuration）
# 这个脚本只做：启动这两个服务（设成 Manual，和系统默认一致），然后看 3389。
# 不删注册表、不改证书、不动其他服务。

$ErrorActionPreference = 'Continue'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "管理员: $isAdmin"
if (-not $isAdmin) { Write-Host "❌ 需要管理员"; exit 1 }

Write-Host "`n=== 启动依赖服务 ==="
foreach ($s in @('SessionEnv', 'UmRdpService')) {
  $svc = Get-Service $s -ErrorAction SilentlyContinue
  if (-not $svc) { Write-Host "  $s 不存在"; continue }
  if ($svc.Status -eq 'Running') { Write-Host "  $s 已在运行"; continue }
  try {
    Set-Service $s -StartupType Manual -ErrorAction SilentlyContinue
    Start-Service $s -ErrorAction Stop
    Write-Host "  ✓ $s 启动成功"
  } catch {
    Write-Host ("  ✗ $s : " + $_.Exception.Message)
  }
}

Write-Host "`n=== 重启 TermService ==="
try {
  Restart-Service TermService -Force -ErrorAction Stop
  Write-Host "  ✓ 重启成功"
} catch {
  Write-Host ("  ✗ " + $_.Exception.Message)
}

Start-Sleep -Seconds 10

Write-Host "`n=== 服务状态 ==="
foreach ($s in @('TermService', 'SessionEnv', 'UmRdpService')) {
  $svc = Get-Service $s -ErrorAction SilentlyContinue
  if ($svc) { Write-Host ("  " + $s.PadRight(14) + $svc.Status) }
}

Write-Host "`n=== 3389 监听 ==="
$l = Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue
if ($l) {
  Write-Host ("  ✓ 在听 pid=" + $l.OwningProcess, 'Green')
} else {
  Write-Host "  ✗ 还没起" -ForegroundColor Red
  Write-Host "  最近 event 17："
  try {
    Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' -MaxEvents 2 -ErrorAction Stop |
      ForEach-Object { "    " + $_.TimeCreated + " " + $_.Message.Substring(0, [Math]::Min(70, $_.Message.Length)) }
  } catch {}
}

Write-Host "`nDONE"
