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
$UiUrl     = 'http://203.0.113.10'

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

# ⚠️⚠️ 2026-09-20 加：**协议端换成 LLBot 了**（见 AGENTS「协议端已换成 LLBot」）。
#    LLBot 的 OneBot **也用 3001** —— 所以这个脚本**绝不能再"3001 没在跑就去启 NapCat"**：
#    那会把 NapCat 拉起来占住 3001，LLBot 反而抢不到，而且 NapCat 那边还要扫码 ✗
#    ⚠️ 这条链是会**开机自动跑**的（`autostart.ps1` 第 62 行调本脚本）→
#      不修的话**每次开机会把 NapCat 拉起来**，机器人开机后就是死的。
#    做法：读 `config.yml` 的 `provider.name`；是 `llonebot` 就改去拉 LLBot。
function Get-ProviderName {
  $f = Join-Path $BotDir 'config.yml'
  $lines = @(Get-Content $f -ErrorAction SilentlyContinue)
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^provider:\s*$') {
      for ($j = $i + 1; $j -lt [Math]::Min($i + 6, $lines.Count); $j++) {
        if ($lines[$j] -match '^\s+name\s*:\s*[''""]?([A-Za-z]+)') { return $Matches[1].ToLower() }
      }
      return ''
    }
  }
  return ''
}
$ProviderName = Get-ProviderName

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
} elseif ($ProviderName -ne 'napcat') {
  # ⚠️⚠️ 2026-09-20 改：**不是 NapCat 的协议端，一律不碰 NapCat**
  #    （都抢 3001，而且用户根本没在用它）。
  #    原来这里写的是 `-eq 'llonebot'` —— 换成 **SnowLuma** 之后不匹配，
  #    就会掉到最后的 `else`（**去拉 NapCat**）✗ 真实隐患。
  if ($ProviderName -eq 'llonebot') {
    # LLBot：独立应用（不注入 QQ），双击即用；它自己会开 3001 上的 OneBot。
    Write-Step '      协议端是 LLBot —— 跳过 NapCat（两个协议端都抢 3001，不能同时跑）'
    $llbotExe = 'C:\LLBot\llbot.exe'
    if (Test-Path $llbotExe) {
      Write-Step '      拉起 LLBot…（它起来后如果没自动登录，要去它的窗口点「启动」）'
      Start-Process -FilePath $llbotExe -ErrorAction SilentlyContinue | Out-Null
      # 它开核心 + 登录要十几秒，等一会儿再往下（最多 40 秒）
      for ($i = 0; $i -lt 20; $i++) {
        if (Test-Port 3001) { break }
        Start-Sleep -Seconds 2
      }
      if (Test-Port 3001) {
        Write-Step '      ✅ LLBot 的 OneBot（3001）已就绪'
      } else {
        Write-Host '       [注意] 3001 还没起来 —— 去 LLBot 窗口点「启动」；' -ForegroundColor Yellow
        Write-Host '              它登录好之后机器人会自己连上（3 秒一轮重连）。' -ForegroundColor Yellow
      }
    } else {
      Write-Host "      [警告] 找不到 $llbotExe —— 请手动启动 LLBot" -ForegroundColor Yellow
    }
  } else {
    # ⚠️⚠️ 2026-09-20 改：**不只是提示了 —— 真的去把它起起来**。
    #
    #    为什么：开机自启链是 `SakiBot`（注册表）→ `_autostart-hidden.vbs`
    #    → `autostart.ps1` → **这里**。而界面切换协议端**只改 `config.yml`**，
    #    所以只要这里**按 provider 分派**，"开机起谁"就会**自动跟着界面切换走** ——
    #    用户问「能不能在 webui 上切换时自动把启动项也切换」，这就是答案：
    #    **自启项永远只有 `SakiBot` 一个**，它每次启动都读 config 决定起哪个协议端，
    #    所以不存在"要不要切换启动项"的问题。
    #    （反过来：协议端**自己注册的开机自启**必须清掉 —— LLBot 的
    #      `LuckyLilliaDesktop` 就是这么干的，留着就会和当前协议端抢 3001。）
    Write-Step "      协议端是 $ProviderName —— 跳过 NapCat（都抢 3001，不能同时跑）"
    if ($ProviderName -eq 'snowluma') {
      $snowDir = 'C:\SnowLuma'
      $snowVbs = Join-Path $snowDir '_start-hidden.vbs'
      # ⚠️⚠️ 2026-09-21 加（**开机实测踩到的第一个坑**）：SnowLuma 是**注入式**，
      #    而且它只注入"**已经发现的** QQ 进程"（它日志原话：`hook auto-load enabled:
      #    every discovered QQ process will be injected`）—— **它自己不会拉 QQ**。
      #    ⇒ 开机时 QQ 客户端没起来 ⇒ 它注不进去 ⇒ **OneBot（3001）根本不会起**
      #      ⇒ 机器人一直 ECONNREFUSED（01:24 那次重启就是这样：5099 在听、3001 空着、
      #        机器人起来了但连不上，`autostart.ps1` 报"等待机器人连上 NapCat..."）。
      #    ⇒ **必须先确保 QQ 客户端在跑**（用机器人号登着那个）。
      $qqExe = 'C:\Program Files\Tencent\QQNT\QQ.exe'
      if (-not @(Get-Process -Name QQ -ErrorAction SilentlyContinue).Count) {
        if (Test-Path $qqExe) {
          Write-Step '      拉起 QQ 客户端…（SnowLuma 注不进去就不会有 OneBot）'
          Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'start', '', $qqExe -ErrorAction SilentlyContinue | Out-Null
        } else {
          Write-Host "      [警告] 找不到 QQ 客户端：$qqExe" -ForegroundColor Yellow
        }
      } else {
        Write-Step '      QQ 客户端已在跑'
      }
      # ⚠️⚠️ 2026-09-21 加（**开机实测踩到的第二个坑**）：**幂等**。
      #    01:24 那次起了**两个** SnowLuma —— 第二个发现 5099 被占，**退到了 5100**
      #    （它日志：`port 5099 is in use, using 5100 instead`）。两个实例以后会抢 3001。
      if (@(Get-NetTCPConnection -LocalPort 5099 -State Listen -ErrorAction SilentlyContinue).Count -gt 0) {
        Write-Step '      SnowLuma 已经在跑（5099 在听）—— 跳过启动'
      } elseif (Test-Path $snowVbs) {
        Write-Step '      拉起 SnowLuma…'
        Start-Process -FilePath 'wscript.exe' -ArgumentList '//nologo', $snowVbs -ErrorAction SilentlyContinue | Out-Null
      } else {
        Write-Host "      [警告] 找不到 $snowVbs —— 请手动启动 SnowLuma" -ForegroundColor Yellow
      }
      # 等 3001：要等 QQ 登录 + 注入 + 它自己起 OneBot，给足时间（最多 90 秒）
      for ($i = 0; $i -lt 45; $i++) {
        if (Test-Port 3001) { break }
        Start-Sleep -Seconds 2
      }
      if (Test-Port 3001) {
        Write-Step '      ✅ SnowLuma 的 OneBot（3001）已就绪'
      } else {
        Write-Host '       [注意] 3001 还没起来 —— 去它自己的界面（5099）看接入状态；' -ForegroundColor Yellow
        Write-Host '              ⚠️ 最可能是 QQ 客户端没登录（要扫码）—— 登好机器人号它会自动注入。' -ForegroundColor Yellow
      }
    } else {
      Write-Step "      $ProviderName 没有配启动方式 —— 去它自己的界面启动"
      if (Test-Port 3001) {
        Write-Step '      ✅ 3001 已就绪'
      } else {
        Write-Host '       [注意] 3001 还没起来；起好之后机器人会自己连上。' -ForegroundColor Yellow
      }
    }
  }
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

Write-Step '      等待机器人连上协议端...'
$waited = 0
$ok = $false
while ($waited -lt 45) {
  Start-Sleep -Milliseconds 1500
  $waited += 1.5
  # ⚠️⚠️ 2026-09-21 修：原来只认 `已连接到 NapCat`，协议端换成 SnowLuma 后日志是
  #    `已连接到协议端（snowluma），等待消息…` ⇒ 匹配不上 → 这里也会白等 45 秒后报警告。
  #    改成认通用那句，旧的 NapCat 写法留着兼容。
  if ((Test-Path $LogFile) -and (Select-String -Path $LogFile -Pattern '已连接到协议端|已连接到 NapCat' -Quiet -ErrorAction SilentlyContinue)) {
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
