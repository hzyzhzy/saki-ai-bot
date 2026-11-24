# 修 RDP 监听器起不来的根因：TermService 以 NETWORK SERVICE 身份跑，
# 但读不到 C:\ProgramData\Microsoft\Crypto\RSA\MachineKeys 里 RDP 证书的私钥
# ⇒ event 17 报 0x80070005（拒绝访问）⇒ 3389 不监听。
# 这个脚本做两件事（都要管理员）：
#   ① 给 NETWORK SERVICE 加 MachineKeys 的**只读**权限（最小改动）
#   ② 重启 TermService，让它重建监听器
# 用法：右键「以管理员身份运行」，或者由提权调起。

$ErrorActionPreference = 'Continue'
Write-Host "=== 当前是否管理员 ==="
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "  $isAdmin"
if (-not $isAdmin) {
  Write-Host "❌ 需要管理员权限" -ForegroundColor Red
  exit 1
}

$mk = 'C:\ProgramData\Microsoft\Crypto\RSA\MachineKeys'

Write-Host "`n=== ① 给 NETWORK SERVICE 加只读权限 ==="
$out = icacls $mk /grant 'NETWORK SERVICE:(RX)' 2>&1
$out | Select-Object -First 3 | ForEach-Object { "  $_" }

Write-Host "`n=== ② 重启 TermService ==="
try {
  Restart-Service TermService -Force -ErrorAction Stop
  Write-Host "  ✓ 重启成功"
} catch {
  Write-Host ("  ✗ " + $_.Exception.Message)
  Write-Host "  改用 stop + start"
  try {
    Stop-Service TermService -Force -ErrorAction Stop
    Start-Sleep -Seconds 3
    Start-Service TermService -ErrorAction Stop
    Write-Host "  ✓ stop+start 成功"
  } catch {
    Write-Host ("  ✗ 也失败: " + $_.Exception.Message)
  }
}

Start-Sleep -Seconds 8

Write-Host "`n=== ③ 验证 3389 ==="
$l = Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue
if ($l) {
  Write-Host ("  ✓ 3389 在听 pid=" + $l.OwningProcess) -ForegroundColor Green
} else {
  Write-Host "  ✗ 3389 还没起" -ForegroundColor Red
  Write-Host "  最近事件："
  try {
    Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' -MaxEvents 3 -ErrorAction Stop |
      Select-Object TimeCreated, Id, @{n='msg';e={$_.Message.Substring(0,[Math]::Min(100,$_.Message.Length))}} |
      Format-List
  } catch {}
}

Write-Host "`n完成。如果 3389 起来了，回到普通终端跑 anode doctor"
Write-Host "DONE"
