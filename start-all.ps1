# 一键启动：先确保 QQ 协议端（NapCat）在跑，再启动客服小祥。
#
# 用法（一般通过「一键启动（QQ+机器人）.bat」调用）：
#   powershell -File start-all.ps1            # 启动完问一句要不要开管理界面
#   powershell -File start-all.ps1 -OpenUi    # 直接打开
#   powershell -File start-all.ps1 -NoOpenUi  # 不打开（脚本化调用用这个）
#   powershell -File start-all.ps1 -BotQQ 10000002   # 指定要快速登录的 QQ 号

param(
  [switch]$OpenUi,
  [switch]$NoOpenUi,
  [string]$BotQQ = ''
)

$ErrorActionPreference = 'Continue'

# ⚠️ NapCat 目录**不要写死绝对路径**：默认 = 本项目**上一级**下的 napcat\NapCat.Shell，
#    也可以用环境变量 NAPCAT_DIR 覆盖。
$NapCatDir = if ($env:NAPCAT_DIR) { $env:NAPCAT_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'napcat\NapCat.Shell' }
$BotDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogFile   = Join-Path $BotDir 'logs\bot.log'
$UiUrl     = 'http://127.0.0.1:3099'

# 要快速登录的 QQ 号。留空则从 config.yml 里读 botQQ，读不到就问/扫码。
if (-not $BotQQ) {
  $cfgPath = Join-Path $BotDir 'config.yml'
  if (Test-Path $cfgPath) {
    # ⚠️ 2026-09-15 修：原来只认**双引号**（`"?(\d+)"?`），而 config.yml 里写的是
    #    `botQQ: '10000002'`（**单引号**）→ 读不到 → 报「没配 botQQ，只能用二维码登录」
    #    → 而且 `$launchArgs` 是空数组，`Start-Process -ArgumentList @()` 直接报
    #    「argument is null, empty」→ **NapCat 根本没启动**，脚本卡在等 3001。
    $m = Select-String -Path $cfgPath -Pattern "^\s*botQQ\s*:\s*['""]?(\d+)" -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($m) { $BotQQ = $m.Matches[0].Groups[1].Value }
  }
}

function Test-Port {
  param([int]$Port)
  [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Get-BotProcs {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'src[\\/]index\.js' }
}

function Write-Step { param([string]$Text) Write-Host $Text }

Write-Host '============================================'
Write-Host '  一键启动：先 QQ 协议端，再客服小祥'
Write-Host '============================================'
Write-Host ''

# ── 1. NapCat ──────────────────────────────────────
Write-Step '[1/3] 检查 NapCat...'

if (Test-Port 3001) {
  Write-Step '      NapCat 已在运行，跳过。'
} elseif (Test-Port 6099) {
  # ⚠️⚠️ 2026-09-17 加（用户要求补上，跟 `watchdog.ps1` 第 361 行那条对齐）：
  #
  #    **6099 通、3001 不通 = NapCat 进程活得好好的，只是停在二维码等扫码。**
  #    这时候**绝对不能杀 QQ 重启** —— 那会把"它正在等的这次登录"也一起毁掉，
  #    白白多烧一次登录。而这个号已经被 QQ 风控标记过（今天被踢了 7 次），
  #    每一次多余的重启都是在给风控送信号。
  #
  #    之前没有这一层，后果实测过两次：NapCat 明明在等扫码，
  #    这个脚本却把它连 QQ 一起杀掉重来。
  #
  #    现在只提示、不动它，脚本继续往下走 —— 机器人照样启动，
  #    连不上会自动重连（3 秒一轮），用户扫完码就通了。
  Write-Step '      NapCat 进程在跑，但 3001 没监听 —— 它在等扫码。'
  Write-Host '       [注意] 不重启它：重启会把这次登录也毁掉，白白多烧一次。' -ForegroundColor Yellow
  Write-Host '              点开任务栏那个 NapCat 窗口扫码；扫完机器人会自己连上。' -ForegroundColor Yellow
} else {
  Write-Step '      NapCat 没在跑。'

  # QQ 必须完全退出，NapCat 才能注入。这里只提示+代劳关掉，并说清后果。
  $qq = @(Get-Process -Name QQ -ErrorAction SilentlyContinue)
  $boot = @(Get-Process -Name NapCatWinBootMain -ErrorAction SilentlyContinue)
  if ($qq.Count -or $boot.Count) {
    Write-Step "      检测到残留进程（QQ $($qq.Count) 个），正在关闭以重新注入..."
    $qq | Stop-Process -Force -ErrorAction SilentlyContinue
    $boot | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
  }

  $launcher = Join-Path $NapCatDir 'launcher-win10-user.bat'
  if (-not (Test-Path $launcher)) {
    Write-Host "[错误] 找不到 $launcher" -ForegroundColor Red
    exit 1
  }

  # 用 -q <QQ号> 快速登录：不需要扫码，也不需要密码。
  # NapCat 会用它自己缓存的登录态直接登上（实测可行）。
  $launchArgs = @()
  if ($BotQQ) {
    $launchArgs = @($BotQQ)
    Write-Step "      快速登录 QQ $BotQQ（不用扫码）"
  } else {
    Write-Step '      没配 botQQ，只能用二维码登录'
  }

  Write-Step '      启动 NapCat...'
  # NapCat 的窗口留成**最小化**：平时不占地方，万一要扫码点开任务栏就能看到。
  # 不用 Hidden —— 那样登录态失效时二维码没人看得见，会卡死在等扫码。
  #
  # ⚠️ 2026-09-15 修：**空数组不能传给 -ArgumentList** ——
  #    `Start-Process ... -ArgumentList @()` 会报
  #    「Cannot validate argument on parameter 'ArgumentList'. The argument is null, empty…」
  #    然后抛异常 → NapCat 压根没起来，脚本白等 90 秒（用户实测卡在这一步）。
  if ($launchArgs.Count -gt 0) {
    Start-Process -FilePath $launcher -ArgumentList $launchArgs -WorkingDirectory $NapCatDir -WindowStyle Minimized
  } else {
    Start-Process -FilePath $launcher -WorkingDirectory $NapCatDir -WindowStyle Minimized
  }

  Write-Step '      等待 3001 端口就绪（最多 90 秒）'
  $waited = 0
  while ($waited -lt 90) {
    Start-Sleep -Milliseconds 1500
    $waited += 1.5
    if (Test-Port 3001) { break }
    Write-Host '.' -NoNewline
  }
  Write-Host ''

  if (-not (Test-Port 3001)) {
    Write-Host '[警告] 等了 90 秒 NapCat 仍未监听 3001。' -ForegroundColor Yellow
    Write-Host '       看一下 NapCat 的窗口 —— 很可能停在扫码登录。'
    Write-Host '       扫码登录完成后重新运行本脚本即可。'
    exit 1
  }
  Write-Step '      NapCat 就绪。'
}

# ── 2. 机器人 ──────────────────────────────────────
Write-Host ''
Write-Step '[2/3] 启动客服小祥...'

$old = @(Get-BotProcs)
if ($old.Count) {
  Write-Step "      发现旧进程 $($old.Count) 个，按 PID 停掉（不会误伤别的 node）："
  foreach ($p in $old) {
    Write-Step "        - PID $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

$logDir = Join-Path $BotDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
if (Test-Path $LogFile) { Remove-Item $LogFile -Force -ErrorAction SilentlyContinue }

# 用 _run-bot.bat 在**后台**跑机器人（窗口完全隐藏，不占桌面也不占任务栏）。
#
# ⚠️ 踩过的三个坑：
#   1. 不能用 Start-Process -RedirectStandardOutput —— 父进程会等子进程的输出句柄关闭，
#      而 node 一直活着，脚本就永远不返回。所以重定向交给 _run-bot.bat。
#   2. 不要在 PowerShell 里拼 `cmd /c start ... cmd /c "node ... > log"` ——
#      多层引号转义必然出错，日志会是空的。
#   3. 不要用 `start /min` —— 那会留一个最小化的 cmd 窗口在任务栏上，看着很烦。
#      用 WindowStyle Hidden 才能真正藏起来。
$runner = Join-Path $BotDir '_run-bot.bat'
Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/c', "`"$runner`"" `
  -WorkingDirectory $BotDir `
  -WindowStyle Hidden

Write-Step '      等待机器人连上 NapCat...'
$waited = 0
$ok = $false
while ($waited -lt 45) {
  Start-Sleep -Milliseconds 1500
  $waited += 1.5
  if ((Test-Path $LogFile) -and (Select-String -Path $LogFile -Pattern '已连接到 NapCat' -Quiet -ErrorAction SilentlyContinue)) {
    $ok = $true
    break
  }
  Write-Host '.' -NoNewline
}
Write-Host ''

if (-not $ok) {
  Write-Host '[警告] 机器人 45 秒内没连上。日志尾部：' -ForegroundColor Yellow
  Write-Host '--------------------------------------------'
  if (Test-Path $LogFile) { Get-Content $LogFile -Tail 15 }
  Write-Host '--------------------------------------------'
  exit 1
}

Write-Step '      机器人已连接。'

# ── 3. 汇总 ────────────────────────────────────────
Write-Host ''
Write-Host '============================================'
Write-Host '  都起来了，可以测了'
Write-Host '============================================'
Write-Host "  管理界面   : $UiUrl"
Write-Host "  机器人日志 : $LogFile"
Write-Host '  NapCat 窗口: 标题为 NapCat 的那个窗口，别关'
Write-Host ''
Write-Host '  停止机器人 : 双击 停止机器人.bat'
Write-Host ''

if ($NoOpenUi) { exit 0 }
if ($OpenUi) { Start-Process $UiUrl; exit 0 }

$ans = Read-Host '现在打开管理界面吗？(Y/n)'
if ($ans -notmatch '^[Nn]') { Start-Process $UiUrl }
exit 0
