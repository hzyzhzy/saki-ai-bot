# 按依赖顺序把 RDP 相关服务全部拉起来。
#
# ## 为什么需要
#   Anode 的 seat 靠"环回远程桌面"，前提是 TermService 真的在 3389 上监听。
#   实测这台机器：fDenyTSConnections 已经是 0、Child sessions 已开，
#   但 3389 还是不起 —— 因为两个依赖服务从来没启动过：
#     RDPDR          （Remote Desktop Device Redirector）← UmRdpService 依赖它
#     UmRdpService   （UserMode Port Redirector）      ← 监听器靠它
#     SessionEnv     （Remote Desktop Configuration）
#   ExitCode=1077 是 ERROR_SERVICE_NEVER_STARTED（正常，表示"没跑过"），不是故障。
#
# ## 怎么跑
#   右键「以管理员身份运行」，或者让提权进程调它。每一步都会打印真实错误码。

$ErrorActionPreference = 'Continue'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "管理员: $isAdmin"
if (-not $isAdmin) { Write-Host "❌ 需要管理员权限，请右键以管理员身份运行"; exit 1 }

# 顺序很重要：先底层，再上层
$order = @('RDPDR', 'UmRdpService', 'SessionEnv', 'TermService')

Write-Host "`n=== 按顺序启动 ==="
foreach ($name in $order) {
  $svc = Get-Service $name -ErrorAction SilentlyContinue
  if (-not $svc) { Write-Host "  $name : 不存在"; continue }
  if ($svc.Status -eq 'Running') {
    Write-Host "  $name : 已在运行"
    continue
  }
  # 依赖服务先确保起来
  foreach ($dep in $svc.ServicesDependedOn) {
    if ($dep.Status -ne 'Running') {
      try { Start-Service $dep.Name -ErrorAction Stop; Write-Host "    (依赖 $($dep.Name) 已启动)" } catch { Write-Host "    (依赖 $($dep.Name) 起不来: $($_.Exception.Message))" }
    }
  }
  try {
    Set-Service $name -StartupType Manual -ErrorAction SilentlyContinue
    Start-Service $name -ErrorAction Stop
    Start-Sleep -Milliseconds 800
    $now = (Get-Service $name).Status
    Write-Host "  ✓ $name -> $now" -ForegroundColor Green
  } catch {
    $msg = $_.Exception.Message
    Write-Host "  ✗ $name : $msg" -ForegroundColor Red
    $c = Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction SilentlyContinue
    if ($c) { Write-Host "      State=$($c.State) ExitCode=$($c.ExitCode)" }
  }
}

Start-Sleep -Seconds 6

Write-Host "`n=== 最终状态 ==="
foreach ($name in $order) {
  $svc = Get-Service $name -ErrorAction SilentlyContinue
  if ($svc) { Write-Host ("  " + $name.PadRight(14) + $svc.Status) }
}

Write-Host "`n=== 3389 监听 ==="
$l = Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue
if ($l) {
  Write-Host ("  ✓ 3389 在听 pid=" + $l.OwningProcess) -ForegroundColor Green
  Write-Host "`n现在可以跑：anode doctor / anode start --hidden"
} else {
  Write-Host "  ✗ 3389 还没起" -ForegroundColor Red
  Write-Host "`n最近 event 17："
  try {
    Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' -MaxEvents 3 -ErrorAction Stop |
      ForEach-Object { "    " + $_.TimeCreated + "  " + $_.Message.Substring(0, [Math]::Min(70, $_.Message.Length)) }
  } catch {}
  Write-Host "`n如果还是 0x80070005，下一步是检查 RDP 证书："
  Write-Host "  Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\SystemCertificates\Remote Desktop\Certificates'"
}

Write-Host "`nDONE"
