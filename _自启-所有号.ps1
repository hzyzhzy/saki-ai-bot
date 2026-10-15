# 开机自启：把这台机器上**所有** QQ 号都拉起来（以后新增的号自动包含）。
#
# 为什么是一网打尽：原来是"一个号一条注册表"，每加一个号都要再配一次、很容易忘
# （用户 2026-10-14：「如果是分开的话，那就把所有的号包括新增的一起」）。
#
# ⚠️⚠️ 判据统一成一条：**"它的管理界面端口在不在听"**。
#    · 主号**没有**自己的 port（它的界面端口在共用 config.yml 的 `webui.port`），
#      别的号各自在 `accounts/<QQ>.yml` 里写了 port ⇒ 各取各的。
#    · 为什么不用 `mainAccount`：**实测 config.yml 里它是空的** —— 靠它认主号会认错，
#      于是主号会被当成"其余的号"**再起一次** ✗（演练时抓到的）。
#    · 为什么不去按命令行找进程：这个项目在这上面踩过大坑（会误伤、甚至杀掉自己）。
#
# 分工：
#   ① 主号还在跑 → **不碰**（连老的 `autostart.ps1` 都不叫，它就是专门起主号的）；
#      没在跑 → 走老那套（等 OneDrive 同步完 → 等网络 → 重试 3 轮 → 转看门狗），一个字没改。
#   ② 其余的号：没在跑的逐个拉起（隐藏窗口）。
#
# ⚠️ 日志：`logs\__开机自启.log`（自启是隐藏跑的，不加日志就没法查）。
$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null
$log = Join-Path $root 'logs\__开机自启.log'
function Say($m) {
  Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
}
function Listening($port) {
  if ($port -le 0) { return $false }
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}
Say '===== 开机自启开始 ====='
Set-Location $root

# 共用的界面端口（= 主号那个）
$sharedPort = 0
$mP = [regex]::Match((Get-Content (Join-Path $root 'config.yml') -Raw), '(?m)^webui:[\s\S]{0,200}?^\s+port:\s*(\d+)')
if ($mP.Success) { $sharedPort = [int]$mP.Groups[1].Value }
Say "共用界面端口 = $sharedPort"

# ① 主号
if (Listening $sharedPort) {
  Say "主号已经在跑（界面 $sharedPort 在听）→ 跳过，不动它"
} else {
  try {
    Say '主号没在跑 → 走 autostart.ps1 老那套…'
    & (Join-Path $root 'autostart.ps1')
    Say '主号那套跑完了'
  } catch {
    Say ('主号那套出错：' + $_.Exception.Message)
  }
}

# ② 其余的号
foreach ($f in (Get-ChildItem (Join-Path $root 'accounts') -Filter '*.yml')) {
  $qq = $f.BaseName
  $m = [regex]::Match((Get-Content $f.FullName -Raw), '(?m)^\s+port:\s*(\d+)')
  $port = $sharedPort
  if ($m.Success) { $port = [int]$m.Groups[1].Value }
  if (Listening $port) { Say "号 $qq 已经在跑（界面 $port 在听）→ 跳过"; continue }
  Say "拉起号 $qq（界面 $port）…"
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '_run-bot.bat', $qq -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 6
}
Say '===== 开机自启结束 ====='