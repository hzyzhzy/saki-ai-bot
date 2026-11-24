# 最小动作：重启 TermService，让它重新读一遍 RDP-Tcp 配置并重建监听器。
# 就这一件事，不改注册表、不动证书、不碰其他服务。
# 结果写到 C:\Temp\rdp-restart.txt，方便外面查。

$ErrorActionPreference = 'Continue'
$log = 'C:\Temp\rdp-restart.txt'
$lines = @()

function W($t) { $script:lines += $t; Write-Host $t }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
W "管理员: $isAdmin"

W "`n=== 重启 TermService ==="
try {
  Restart-Service TermService -Force -ErrorAction Stop
  W "  ✓ 重启成功"
} catch {
  W ("  ✗ " + $_.Exception.Message)
  W "  试 stop + start"
  try {
    Stop-Service TermService -Force -ErrorAction Stop
    Start-Sleep -Seconds 4
    Start-Service TermService -ErrorAction Stop
    W "  ✓ stop+start 成功"
  } catch {
    W ("  ✗ 也失败: " + $_.Exception.Message)
  }
}

Start-Sleep -Seconds 10

W "`n=== 服务状态 ==="
foreach ($n in @('RDPDR', 'UmRdpService', 'SessionEnv', 'TermService')) {
  $s = Get-Service $n -ErrorAction SilentlyContinue
  if ($s) { W ("  " + $n.PadRight(14) + $s.Status) }
}

W "`n=== 3389 ==="
$l = Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue
if ($l) {
  W ("  ✓ 3389 在听 pid=" + $l.OwningProcess)
} else {
  W "  ✗ 还是没起"
  W "  最近 3 条 event 17："
  try {
    Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' -MaxEvents 3 -ErrorAction Stop |
      ForEach-Object { W ("    " + $_.TimeCreated + "  " + $_.Message.Substring(0, [Math]::Min(60, $_.Message.Length))) }
  } catch {}
}

$lines | Out-File -FilePath $log -Encoding utf8
W "`nDONE"
