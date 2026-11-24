# 修 RDP 监听器：`SSLCertificateSHA1Hash` 是空的 ⇒ TermService 建不起监听器（0x80070005）
#
# ## 背景（实测）
#   四个服务（RDPDR / UmRdpService / SessionEnv / TermService）全部 Running，
#   `MachineKeys` 和私钥对 NETWORK SERVICE 都给了读权限，
#   但 `HKLM\...\WinStations\RDP-Tcp\SSLCertificateSHA1Hash` **是空值**，
#   而 `Remote Desktop\Certificates\<thumbprint>` 键下**没有 PrivateKey 子键**。
#   ⇒ TermService 找不到可用的证书，建监听器时直接 access denied。
#
# ## 这个脚本做什么
#   ① 导出 RDP-Tcp 注册表备份到 C:\Temp\rdp-tcp-backup.reg（出问题能还原）
#   ② 生成一张自签名 SSL 证书（Cert:\LocalMachine\My）
#   ③ 把它绑定到 SSLCertificateSHA1Hash
#   ④ 重启 TermService，看 3389 起没起
#
# ## 回滚
#   reg import C:\Temp\rdp-tcp-backup.reg
#   （然后重启 TermService；那张自签名证书可以留在证书库里，无害）

$ErrorActionPreference = 'Continue'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "管理员: $isAdmin"
if (-not $isAdmin) { Write-Host "❌ 需要管理员"; exit 1 }

$key = 'HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'

Write-Host "`n=== ① 备份 RDP-Tcp 注册表 ==="
reg export $key 'C:\Temp\rdp-tcp-backup.reg' /y 2>&1 | Select-Object -First 2 | ForEach-Object { "  $_" }
if (Test-Path 'C:\Temp\rdp-tcp-backup.reg') { Write-Host ("  ✓ 备份 " + (Get-Item 'C:\Temp\rdp-tcp-backup.reg').Length + " 字节") }

Write-Host "`n=== ② 生成自签名证书 ==="
$cert = $null
try {
  # 先找有没有现成能用的
  $existing = Get-ChildItem 'Cert:\LocalMachine\My' -ErrorAction SilentlyContinue |
    Where-Object { $_.EnhancedKeyUsageList.ObjectId -contains '203.0.113.10.203.0.113.10.1' } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
  if ($existing) {
    Write-Host ("  复用已有 SSL 证书: " + $existing.Thumbprint)
    $cert = $existing
  } else {
    $cert = New-SelfSignedCertificate -DnsName @('localhost', $env:COMPUTERNAME) `
      -CertStoreLocation 'Cert:\LocalMachine\My' `
      -KeyExportPolicy Exportable `
      -KeyUsage KeyEncipherment, DigitalSignature `
      -Type SSLServerAuthentication `
      -KeyLength 2048 `
      -NotAfter (Get-Date).AddYears(5) `
      -ErrorAction Stop
    Write-Host ("  ✓ 已生成: " + $cert.Thumbprint)
  }
} catch {
  Write-Host ("  ✗ 生成失败: " + $_.Exception.Message)
  Write-Host "DONE-FAIL"
  exit 2
}

Write-Host "`n=== ③ 给 NETWORK SERVICE 私钥读权限 ==="
try {
  $rsaFile = Join-Path $env:ProgramData "Microsoft\Crypto\RSA\MachineKeys"
  # 证书私钥落在 MachineKeys 里，找到最新的那个
  $f = Get-ChildItem $rsaFile -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-3) } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($f) {
    icacls $f.FullName /grant 'NETWORK SERVICE:(R)' 2>&1 | Select-Object -First 1 | ForEach-Object { "  $_" }
    Write-Host ("  给了 " + $f.Name + " 读权限")
  } else {
    Write-Host "  没找到新私钥文件（可能已在别处），跳过"
  }
} catch {
  Write-Host ("  权限设置失败（继续）: " + $_.Exception.Message)
}

Write-Host "`n=== ④ 绑定到 SSLCertificateSHA1Hash ==="
try {
  $tp = $cert.Thumbprint
  $bytes = [byte[]]::new($tp.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    $bytes[$i] = [Convert]::ToByte($tp.Substring($i * 2, 2), 16)
  }
  Set-ItemProperty -Path ('HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp') `
    -Name 'SSLCertificateSHA1Hash' -Value $bytes -Type Binary -ErrorAction Stop
  $now = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp').SSLCertificateSHA1Hash
  Write-Host ("  ✓ 已写入，长度 " + $now.Length + " 字节")
} catch {
  Write-Host ("  ✗ 写入失败: " + $_.Exception.Message)
  Write-Host "DONE-FAIL"
  exit 3
}

Write-Host "`n=== ⑤ 重启 TermService ==="
try {
  Restart-Service TermService -Force -ErrorAction Stop
  Write-Host "  ✓ 重启成功"
} catch {
  Write-Host ("  重启失败（尝试 stop+start）: " + $_.Exception.Message)
  try { Stop-Service TermService -Force -ErrorAction Stop; Start-Sleep 4; Start-Service TermService -ErrorAction Stop; Write-Host "  ✓ stop+start 成功" } catch { Write-Host ("  ✗ " + $_.Exception.Message) }
}

Start-Sleep -Seconds 10
Write-Host "`n=== ⑥ 验证 ==="
$l = Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue
if ($l) {
  Write-Host ("  ✓ 3389 在听 pid=" + $l.OwningProcess) -ForegroundColor Green
  Write-Host "DONE-OK"
} else {
  Write-Host "  ✗ 3389 还是没起" -ForegroundColor Red
  try {
    Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' -MaxEvents 2 -ErrorAction Stop |
      ForEach-Object { Write-Host ("    " + $_.TimeCreated + "  " + $_.Message.Substring(0, [Math]::Min(70, $_.Message.Length))) }
  } catch {}
  Write-Host "DONE-FAIL"
}
