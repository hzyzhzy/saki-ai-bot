# 开机自动启动（放到「启动」文件夹里用）
#
# 和「一键启动+看门狗.bat」的区别：这个专门为**开机场景**做了三件事：
#   1. 先等一会 —— 开机瞬间 OneDrive 可能还没同步完，脚本文件可能不完整
#   2. 等网络就绪 —— NapCat 登录需要网络，太早起会失败
#   3. 自动重试 —— 一次没起来会再试，最多试 3 轮
#
# 用法：把「开机启动.bat」的快捷方式放进 shell:startup
#       （或者直接把本文件的快捷方式放进去，但推荐用 .bat）

$ErrorActionPreference = 'Continue'
$BotDir = $PSScriptRoot
$LogFile = Join-Path $BotDir 'logs\autostart.log'

function Say($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}
}

Say '================ 开机启动开始 ================'

# ── 1. 等 OneDrive 同步完 ──
# 机器人文件在 OneDrive 里，开机瞬间可能是占位符/旧版本。
# 判断方法：看一个关键文件能不能读出来。
$ready = $false
for ($i = 1; $i -le 24; $i++) {
  try {
    $c = Get-Content (Join-Path $BotDir 'src\bot.js') -Raw -ErrorAction Stop
    if ($c -and $c.Length -gt 10000) { $ready = $true; break }
  } catch {}
  if ($i % 4 -eq 0) { Say "等待 OneDrive 同步…（第 $i 次）" }
  Start-Sleep -Seconds 5
}
if (-not $ready) {
  Say '⚠️ 等了两分钟，src\bot.js 还是读不出来（或内容不完整）。继续尝试启动。'
} else {
  Say '✅ 文件就绪'
}

# ── 2. 等网络就绪 ──
# NapCat 快速登录需要连服务器，没网会失败。
$online = $false
for ($i = 1; $i -le 24; $i++) {
  if (Test-Connection -ComputerName 'qq.com' -Count 1 -Quiet -ErrorAction SilentlyContinue) {
    $online = $true
    break
  }
  if ($i % 6 -eq 0) { Say "等待网络…（第 $i 次）" }
  Start-Sleep -Seconds 5
}
if ($online) { Say '✅ 网络就绪' } else { Say '⚠️ 等了两分钟还是没网，继续尝试启动' }

# 再多等一会，让系统起稳（QQ 之类的东西别抢）
Start-Sleep -Seconds 10

# ── 3. 启动 + 重试 ──
$ok = $false
for ($round = 1; $round -le 3; $round++) {
  Say ">>> 第 $round 轮启动"

  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $BotDir 'start-all.ps1') -NoOpenUi 2>&1 |
      ForEach-Object { Say "  $_" }
  } catch {
    Say "  start-all.ps1 出错: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds 5

  # 检查是不是真的起来了
  $nap = [bool](Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)
  $bot = [bool](Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'src[\\/]index\.js' })

  if ($nap -and $bot) {
    Say "✅ 第 $round 轮启动成功（NapCat 在、机器人在）"
    $ok = $true
    break
  }
  Say "  NapCat=$nap 机器人=$bot，没齐，等 20 秒重试"
  Start-Sleep -Seconds 20
}

if (-not $ok) {
  Say '❌ 三轮都没起来。请手动双击「一键启动+看门狗.bat」看具体报错。'
}

# ── 4. 交给看门狗（这一步会一直占着窗口，所以开机启动用的是隐藏方式）──
Say '启动看门狗…'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $BotDir 'watchdog.ps1')
