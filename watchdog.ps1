# NapCat 看门狗：NapCat 挂了就自动拉起来，不需要人工介入。
#
# 背景：NapCat 崩过一次（NapCatWinBootMain 进程消失、3001 端口没了），
# 机器人在那之后默默重连了 9 分钟，群里完全没反应，用户只能干等。
# 这个脚本盯着 3001，一旦掉了就重启协议端 + 机器人。
#
# 用法：
#   双击 看门狗.bat          （有窗口，能看日志）
#   或 powershell -File watchdog.ps1
#
# 停止：关掉这个窗口（Ctrl+C）

$ErrorActionPreference = 'Continue'
$BotDir = $PSScriptRoot
# ⚠️ NapCat 目录**不要写死绝对路径**：默认 = 本项目**上一级**下的 napcat\NapCat.Shell，
#    也可以用环境变量 NAPCAT_DIR 覆盖。
$NapCatDir = if ($env:NAPCAT_DIR) { $env:NAPCAT_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'napcat\NapCat.Shell' }
$LogFile = Join-Path $BotDir 'logs\watchdog.log'
$CheckSeconds = 20

# 机器人号 —— 从 config.yml 读（「快登名单里还有没有它」和提醒文案都要用）。
# ⚠️ 以前 `Start-NapCat` 里是**硬编码 '10000002'** 的，换号就会悄悄登错号。
$BotQQ = ''
try {
  # ⚠️⚠️ 2026-09-17 修：正则原来只认双引号（`"?`），而 config.yml 里写的是
  #    `botQQ: '10000002'`（**单引号**）→ 匹配不到 → $BotQQ 为空。
  #    （start-all.ps1 里早就用 `['""]?` 兼容了两种引号，这份漏了。）
  $m = Select-String -Path (Join-Path $BotDir 'config.yml') -Pattern '^\s*botQQ\s*:\s*[''""]?(\d+)' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($m) { $BotQQ = $m.Matches[0].Groups[1].Value }
} catch {}

function Say($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Write-Host $line
  try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}
}

function Test-NapCat { [bool](Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) }

# ── 网络通不通 ────────────────────────────────────────
# ⚠️ 为什么需要：这台机器走的是 USB 无线网卡（WLAN 2），
#    日志里反复出现「没有可用的网络适配器发送消息」，然后 20 秒后被踢下线。
#    网络一断，重启 NapCat 毫无意义（登不上，还白烧一次扫码会话）。
#    所以任何「重启动作」之前都先问一句：网通吗？
function Test-Network {
  # 腾讯的服务器是 QQ 能不能登的关键，优先测它
  foreach ($h in @('qq.com', 'www.baidu.com')) {
    try {
      if (Test-Connection -ComputerName $h -Count 1 -Quiet -ErrorAction SilentlyContinue) { return $true }
    } catch {}
  }
  # ping 不通也可能只是禁 ICMP，再用 TCP 试一次
  try {
    $r = Test-NetConnection -ComputerName 'qq.com' -Port 443 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
    if ($r -and $r.TcpTestSucceeded) { return $true }
  } catch {}
  return $false
}

function Test-Bot {
  $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'src[\\/]index\.js' }
  return [bool]$p
}

function Get-BotToken {
  try {
    $m = Select-String -Path (Join-Path $BotDir 'config.yml') -Pattern 'accessToken:\s*"?([^"\r\n]+)"?' | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value.Trim() }
  } catch {}
  return ''
}

# ── QQ 是否真的在线 ────────────────────────────────────
# ⚠️ 这是 2026-09-11 踩的坑：账号被踢下线后，
#    NapCat 进程还在、3001 还在监听、机器人也照常连着，
#    但 QQ 已离线 → 消息根本到不了 → 机器人静默。
#    端口和进程都查不出来，**只有这个接口能发现**。
#
# 用 PowerShell 原生的 ClientWebSocket（不依赖 node 的 ws 模块 —— 临时脚本放在
# %TEMP% 里 require('ws') 会失败，踩过）。
#
# 返回：'online' / 'offline' / 'unknown'
function Test-QQOnline {
  # ⚠️⚠️⚠️ 2026-09-15 大修：**「已登录,无法重复登录」不是在线，是"卡死"**。
  #
  #    ## 用户报的现象（NapCat 控制台截图）
  #
  #      23:34:14 [error] [KickedOffLine] [下线通知] 你的账号当前登录已失效，请重新登录。
  #      23:34:15 [info]  账号状态变更为离线
  #      23:34:52 [info]  正在快速登录 10000002
  #      23:34:52 [error] 当前账号(10000002)已登录,无法重复登录
  #
  #    用户问的：为什么说「已登录」却**实际没登录**？
  #
  #    ## 根因（翻 napcat.mjs 得到的）
  #
  #      ```js
  #      c.onUserLoggedIn = (u) => {
  #        const l = `当前账号(${u})已登录,无法重复登录`;
  #        e.logError(l), ve.setQQLoginError(l);   // ← 只记错误，**不动登录状态**
  #      }
  #      c.onQRCodeLoginSucceed = async (u) => {
  #        o.isLogined = !0, ve.setQQLoginStatus(!0)  // ← 只有"扫码成功"才置为已登录
  #      }
  #      ```
  #
  #    那句话**是 QQ 核心说的**（它本地还攥着那个已经被服务器作废的会话），
  #    NapCat 把它当**错误**记下来 —— 而且**没有**把状态置成已登录。
  #    更坑的是：`quickLoginWithUin()` 的 promise **只在扫码成功时才 resolve**，
  #    所以这次快登**永远不返回** → 15 秒后 HTTP 超时。
  #
  #    **结果**：NapCat 停在 `QQLoginStatus = false`，也就是**真的没登录**。
  #    而老代码把 loginError 里的「已登录」当成**在线** →
  #    离线计数被清零 → 看门狗**再也没动过**，静默了 45 分钟（这才是真 bug）。
  #
  #    ## 正确的判据（四个状态）
  #
  #      · `isLogin: true`            → **online**（QQLoginStatus && selfInfo.online）
  #      · loginError 含「已登录」     → **stale** 卡死态：登录态被作废，
  #                                      NapCat 自己永远出不来，**只有重启它**
  #      · loginError 含「失效/重新登录/未登录/请扫码」 → **offline**（在等扫码）
  #      · 其他 / 查不到               → **unknown**（绝不当作离线，避免误动作）
  #
  #    ## 另外带回一个关键信息：`hasCred`
  #
  #      机器人号还在不在 NapCat 的「快速登录名单」里。
  #      **不在 = 本地凭据被腾讯清掉了 → 快登永远不可能成功、重启也没用**，
  #      这种情况别白烧风控信号，直接叫人扫码。
  #      （2026-09-15 实测：被踢之后名单里就只剩服主主号了）
  #
  # 返回 [pscustomobject]@{ state = 'online|offline|stale|unknown'; hasCred = $bool }
  #
  # ── 下面是 2026-09-13 那次修的（保留，仍然成立）──
  #
  #    ⚠️⚠️ 原实现**信了 NapCat 的坏字段，主动给风控送信号**。
  #
  #    原实现：连 3001 发 `get_status`，看返回里的 `"online"`。
  #    实测这个版本（NapCat v4.18.19）的 `get_status` 返回是坏的：
  #      {"status":"ok","retcode":0,"data":{"online":false,"good":true,"stat":{}}}
  #    —— **永远 online:false**，哪怕 QQ 明明在线、机器人在正常收发消息。
  #
  #    后果（用户发现的）：看门狗**每 65 秒**判一次"QQ 离线了"→
  #    调一次快速登录 → NapCat 每次回「已登录,无法重复登录」→
  #    **每 65 秒一个"异常登录"信号**。用户问「会触发风控吗」——**会，是我们自己造成的**。
  #
  #    所以改用 **HTTP 管理接口** CheckLoginStatus（机器人管理界面用的那个，
  #    不抢 3001 连接、字段可靠）。
  #
  # ⚠️⚠️ 2026-09-15：判据挪到 `tools/napcat-state.mjs` 了。
  #
  #    原来这里是用 here-string 内嵌一段 JS 写到 %TEMP% 再跑 —— 改一行要重写整段，
  #    而且**没法写测试**（在 ps1 里它就是一个字符串）。而"卡死 45 分钟"那个 bug
  #    恰恰就出在这段判据上。现在 tool 有 `test/watchdog-state.js` 真的喂假 NapCat 验。
  #
  #    ⚠️ 注意别把它的输出读错：格式是**一行** `<state>:<cred|nocred>`，
  #       state ∈ online|offline|stale|unknown（含义见 tools/napcat-state.mjs 顶部）。
  $outFile = Join-Path $env:TEMP '_wd_qqcheck.out'
  try {
    if (Test-Path $outFile) { Remove-Item $outFile -Force -ErrorAction SilentlyContinue }
    $tool = Join-Path $BotDir 'tools\napcat-state.mjs'
    if (-not (Test-Path $tool)) {
      if ($env:WD_DEBUG) { Write-Host "  [WD-DEBUG] 找不到 $tool" }
      return [pscustomobject]@{ state = 'unknown'; hasCred = $false }
    }
    # ⚠️ 路径带空格（「OneDrive - yijia」）→ 必须交给 cmd 并显式加引号，
    #    否则 node 收到的是 `<本机用户目录>\OneDrive` → ENOENT → 静默 unknown（踩过）。
    $cmdLine = 'node "{0}" > "{1}" 2>nul' -f $tool, $outFile
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/c ' + $cmdLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $BotDir
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.WaitForExit(30000) | Out-Null
    $r = ''
    if (Test-Path $outFile) { $r = [string](Get-Content $outFile -Raw -ErrorAction SilentlyContinue) }
    $r = $r.Trim().ToLower()
    if ($env:WD_DEBUG) { Write-Host "  [WD-DEBUG] 命令行=[$cmdLine]" ; Write-Host "  [WD-DEBUG] node 输出=[$r]" }
    # 形如 `offline:cred` / `stale:nocred`
    if ($r -match '(online|offline|stale|unknown)\s*:\s*(cred|nocred)') {
      return [pscustomobject]@{ state = $Matches[1]; hasCred = ($Matches[2] -eq 'cred') }
    }
    # ⚠️ 兜底：绝不把"没读到"当成离线（会乱重启）。unknown = 什么都不做。
    return [pscustomobject]@{ state = 'unknown'; hasCred = $false }
  } catch {
    return [pscustomobject]@{ state = 'unknown'; hasCred = $false }
  }
}

# ── 醒目提醒 ──────────────────────────────────────────
# 弹一个置顶的消息框 + 系统提示音，用户不在电脑前也能注意到
function Alert($title, $msg) {
  Say "🔔 提醒：$title —— $msg"
  try { [System.Media.SystemSounds]::Exclamation.Play() } catch {}
  try { [System.Media.SystemSounds]::Hand.Play() } catch {}
  try {
    $sh = New-Object -ComObject WScript.Shell
    # 4+48 = 信息图标 + 置顶；60 秒后自动关
    $null = $sh.Popup($msg, 60, $title, 4 + 48)
  } catch {
    Say '（弹窗失败，看日志就行）'
  }
}

function Test-NapCatAlive {
  # ⚠️ 2026-09-13 加：判断 NapCat **进程还活着吗**（不是"QQ 登录着吗"）。
  #
  #    为什么要单独一个判据：
  #      `Start-NapCat` 会**杀掉 QQ 再重新登录** —— 这是最贵的操作：
  #        · 每次都是一个风控信号（"频繁重登"是风控最敏感的特征）
  #        · 还会**作废用户刚要扫的二维码**
  #      而很多情况下 NapCat 进程**活得好好的**，只是 QQ 掉线了 ——
  #      那种时候重启它不但没用，还纯粹在送风控信号。
  #
  #    判据：WebUI（6099）在监听，或者 OneBot 端口（3001）在监听。
  #    WebUI 是 NapCat 自己起的，跟 QQ 登没登录无关 ——
  #    所以「6099 通、3001 不通」= **在等扫码**，这时候绝不能重启。
  $webui = [bool](Get-NetTCPConnection -LocalPort 6099 -State Listen -ErrorAction SilentlyContinue)
  $onebot = [bool](Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)
  return ($webui -or $onebot)
}

function Start-NapCat {
  Say '启动 NapCat…'
  # NapCat 是注入进 QQ 的，所以必须先彻底关掉 QQ
  Get-Process -Name QQ, NapCatWinBootMain -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 4

  $launcher = Join-Path $NapCatDir 'launcher-win10-user.bat'
  if (-not (Test-Path $launcher)) { Say "❌ 找不到 $launcher"; return $false }

  # 用 config.yml 里的 botQQ 做快速登录
  $botQQ = $BotQQ
  try {
    # ⚠️ 同上：单引号也要认（config.yml 里是 `botQQ: '10000002'`）
    $m = Select-String -Path (Join-Path $BotDir 'config.yml') -Pattern 'botQQ:\s*[''""]?(\d+)' | Select-Object -First 1
    if ($m) { $botQQ = $m.Matches[0].Groups[1].Value }
  } catch {}

  # ⚠️⚠️ 2026-09-17 修（用户截图：看门狗每轮都抛异常，NapCat 永远起不来）：
  #   ① **空数组不能传给 `-ArgumentList`** —— `Start-Process -ArgumentList @()`
  #      会抛 `ParameterBindingValidationException`，**整条命令中断，NapCat 压根没启动**，
  #      然后就是"等 90 秒还没监听 3001"→ 下一轮再来一遍的死循环。
  #      （这个坑 2026-09-15 在 start-all.ps1 里修过，watchdog.ps1 这份**漏了**。）
  #   ② 别拿 `$args` 当变量名 —— 它是 PowerShell 的**自动变量**。
  $napArgs = @()
  if ($botQQ) { $napArgs = @('-q', $botQQ) }
  # 最小化启动：平时不占屏幕，但要扫码时能从任务栏点出来
  if ($napArgs.Count -gt 0) {
    Start-Process -FilePath $launcher -ArgumentList $napArgs -WorkingDirectory $NapCatDir -WindowStyle Minimized
  } else {
    Start-Process -FilePath $launcher -WorkingDirectory $NapCatDir -WindowStyle Minimized
  }

  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    if (Test-NapCat) { Say '✅ NapCat 就绪'; return $true }
  }
  Say '⚠️ 等了 90 秒 NapCat 仍未监听 3001 —— 可能停在扫码登录，点开任务栏的 NapCat 窗口看看'
  return $false
}

function Start-Bot {
  Say '启动机器人…'
  Remove-Item (Join-Path $BotDir 'logs\bot.log') -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '_run-bot.bat' -WorkingDirectory $BotDir -WindowStyle Hidden
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $log = Join-Path $BotDir 'logs\bot.log'
    if ((Test-Path $log) -and (Select-String -Path $log -Pattern '已连接到 NapCat' -Quiet -ErrorAction SilentlyContinue)) {
      Say '✅ 机器人已连接'
      return $true
    }
  }
  Say '⚠️ 机器人未在 30 秒内连上，看 logs\bot.log'
  return $false
}

Say '============================================'
Say ' 看门狗启动：盯着 NapCat 和机器人'
Say " 每 $CheckSeconds 秒检查一次，挂了自动拉起"
Say ' 关掉这个窗口就停止'
Say '============================================'

# 启动时先对齐一次状态
#
# ⚠️⚠️ 2026-09-15 修：这里原来**只看 3001**，缺了"在等扫码"那一层 ——
#    而主循环里早就有（**6099 通 + 3001 不通 = 在等扫码，绝不能重启**）。
#
#    后果：看门狗每次一启动就**杀掉 QQ 重来一次**，顺手把用户刚要扫的二维码作废。
#    这正是 2026-09-13 那个「一边叫人扫码、一边把码作废」的死循环 ——
#    主循环修了，**启动这一段漏了**（长期没人注意，因为看门狗很少重启）。
#
#    实测（2026-09-15 00:31）：我刚刷好一张新码，一重启看门狗就被它杀掉了。
if (-not (Test-NapCat)) {
  $webuiUp = [bool](Get-NetTCPConnection -LocalPort 6099 -State Listen -ErrorAction SilentlyContinue)
  if ($webuiUp) {
    Say '⏳ NapCat 在等扫码登录（6099 通、3001 不通）—— 启动时**不重启**，等用户扫'
  } else {
    Say 'NapCat 没在跑，先拉起来'
    Start-NapCat | Out-Null
  }
}
if (-not (Test-Bot)) {
  Say '机器人没在跑，先拉起来'
  Start-Bot | Out-Null
}

$napFailCount = 0
$qqOfflineCount = 0
$lastOfflineAlert = [datetime]::MinValue
# 上次因为「QQ 离线」而重启 NapCat 的时间（避免反复重启烧掉扫码会话）
$lastOfflineRestart = [datetime]::MinValue
# 上次试「快速登录」的时间（NapCat 管理接口有 loginRate 限流，别猛点）
$lastQuickLogin = [datetime]::MinValue
# ⚠️ 上次因为「机器人报发送失败（假在线）」而重启协议端的时间 —— 单独节流，
#    10 分钟内不重复（重启 = 一次登录，这台机器的号已被标风险设备）
$lastFakeOnlineRestart = [datetime]::MinValue

while ($true) {
  Start-Sleep -Seconds $CheckSeconds

  if (-not (Test-NapCat)) {
    # ⚠️⚠️ 2026-09-13 修：**「在等扫码」和「挂了」是两种状态，别混**。
    #
    #    真实踩过的坑（用户截图：满屏 55 个 cmd 窗口）：
    #      NapCat 启动后如果登录凭据失效，它会**停在二维码界面等扫码** ——
    #      此时 **6099（WebUI）在监听、但 3001（OneBot）不监听**。
    #      而看门狗只认 3001 → 判定「NapCat 挂了」→ 每 3.5 分钟重启一次 →
    #        · 每次弹一个 cmd 窗口，攒了 55 个（桌面被刷满）
    #        · 每次重启**都作废用户刚要扫的二维码** → 永远扫不上
    #        · QQ 进程也累积了 12 个（旧的没退干净）
    #      **这是个死循环：它一边叫人扫码，一边把码作废。**
    #
    #    修法：6099 在监听但不 3001 → 判定为「在等扫码」，
    #          **绝不重启**，只（节流地）提醒用户扫码，然后安静等着。
    $webuiUp = [bool](Get-NetTCPConnection -LocalPort 6099 -State Listen -ErrorAction SilentlyContinue)
    if ($webuiUp) {
      # 在等扫码 —— 什么都不做，别再重启（重启会作废二维码）
      #
      # ⚠️⚠️ 2026-09-15 加：**但机器人必须拉起来**。
      #    因为"给人扫的二维码"是在**机器人界面（3099）**里显示的
      #    （见下面 Alert 里那三步）。机器人不在 → 3099 不通 → **用户看不到码**，
      #    于是这条"等用户扫"就真的只能干等了。
      #
      #    实测踩到：看门狗重启后按旧逻辑只 Say 了一句就 continue，
      #    机器人又是停着的，3099 一直不通 —— 用户根本没法扫。
      #
      #    ⚠️ 判据用 **3099**（界面在不在），不是 `Test-Bot` ——
      #       后者只看进程存在；而且 `Start-Bot` 会等"已连接到 NapCat"（30 秒），
      #       3001 断开时必然等满 30 秒，每 20 秒轮一次会把机器人进程堆起来。
      $uiUp = [bool](Get-NetTCPConnection -LocalPort 3099 -State Listen -ErrorAction SilentlyContinue)
      if (-not $uiUp) {
        Say '   → 机器人界面（3099）不在 —— 拉起来，好让你能打开界面扫码'
        Start-Bot | Out-Null
      }
      if (($now - $lastOfflineAlert).TotalMinutes -gt 10) {
        $lastOfflineAlert = $now
        $napFailCount = 0
        Say '⏳ NapCat 在等扫码登录（6099 通、3001 不通）—— 不重启，等用户扫'
      }
      Start-Sleep -Seconds 1
      continue
    }

    $napFailCount++
    Say "❌ 检测到 NapCat 进程级挂了（6099/3001 都不通，连续 $napFailCount 次）"
    if ($napFailCount -ge 2) {
      Start-NapCat | Out-Null
      $napFailCount = 0
      # NapCat 重启后机器人也要重连
      Start-Sleep -Seconds 3
      if (-not (Test-Bot)) { Start-Bot | Out-Null }
    }
  } else {
    $napFailCount = 0

    # ── ★ 机器人报「发送一直失败」→ 重启协议端（2026-09-15 用户要求）────────
    #
    # ⚠️ 这是「假在线」那种坏法：**3001 一直在监听、探针也报 online**，
    #    但发消息时 QQ 回 `retcode=1200「网络连接异常!」`，而且群里谁也看不到。
    #    2026-09-15 实测：11:33 重启后好了 3 小时，14:2x 又坏 —— 探针**看不出来**，
    #    所以只能由**真的在发消息的机器人**来发现（它数连续失败次数，见
    #    `src/napcat-recover.js`），够了就在这里留一张条子。
    #
    # ⚠️ 重启逻辑**故意放在看门狗里**，不放机器人里：这里已经有
    #    「快登凭据在不在」「10 分钟节流」「在等扫码时绝不重启」「弹窗叫人扫码」
    #    这一整套踩出来的判断。机器人自己动手只会把那套绕过去。
    $reqFile = Join-Path $BotDir 'state\napcat-restart.request'
    if (Test-Path $reqFile) {
      $reqAt = [datetime]::MinValue
      $reqWhy = '机器人报告发送一直失败'
      try {
        $reqJson = Get-Content $reqFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
        if ($reqJson.at) { $reqAt = [datetime]'1970-01-01'.AddMilliseconds([double]$reqJson.at).ToLocalTime() }
        if ($reqJson.reason) { $reqWhy = [string]$reqJson.reason }
      } catch {}
      Say "📣 机器人报告：$reqWhy"

      $qqReq = Test-QQOnline
      $nowReq = Get-Date
      if (-not $qqReq.hasCred) {
        # ⚠️ 凭据没了 → 重启也登不上，只会白烧一次扫码会话（还会作废用户刚要扫的码）
        Say '   → 本地快登凭据已没了 → 重启不可能成功，**只能扫码**；条子丢掉，别再白烧风控信号'
        Remove-Item $reqFile -Force -ErrorAction SilentlyContinue
        Alert '客服小祥的 QQ 又坏了（需要你扫码）' @"
机器人报「发送一直失败（网络连接异常）」，而且本地快登凭据已经被腾讯清掉了 ——
**这种情况只能扫一次码**，重启协议端也没用（反而会作废你刚要扫的码）。

    ① 打开  http://127.0.0.1:3099
    ② 找「QQ 登录」那张卡片
    ③ 点「显示二维码」，用**机器人号**的手机 QQ 扫（别扫成服主主号）
"@
      } elseif (($nowReq - $lastFakeOnlineRestart).TotalMinutes -lt 10) {
        # 10 分钟内刚为这件事重启过 → 先等等（重启 = 一次登录，别把风控喂饱）
        Say "   → 10 分钟内已经重启过一次（$([int]($nowReq - $lastFakeOnlineRestart).TotalMinutes) 分钟前），再等等"
      } else {
        Say '   → 重启 NapCat 清掉坏会话（启动时会自动快登）'
        $lastFakeOnlineRestart = $nowReq
        Start-NapCat | Out-Null
        Remove-Item $reqFile -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        if (-not (Test-Bot)) { Start-Bot | Out-Null }
      }
      Start-Sleep -Seconds 1
      continue
    }

    # ── QQ 在线检查 ──
    # 端口在监听 ≠ QQ 在线。被踢下线时端口还在，但消息收不到。
    # ⚠️ 返回的是对象：state = online/offline/stale/unknown，hasCred = 快登凭据还在不在
    $qq = Test-QQOnline
    $qqDead = ($qq.state -eq 'offline') -or ($qq.state -eq 'stale')
    if ($qqDead) {
      $qqOfflineCount++
      $why = if ($qq.state -eq 'stale') { 'QQ 卡死了（登录态已作废，NapCat 报"已登录,无法重复登录"）' } else { 'QQ 离线了' }
      Say "❌ $why（连续 $qqOfflineCount 次检查）"

      # ⚠️ 连续两次确认再动手（避免刚好在网络抖动时误报）
      if ($qqOfflineCount -ge 2) {
        $now = Get-Date

        # ⚠️⚠️ 这段是「无人值守」的核心。以前的逻辑是：
        #    问 NapCat 有没有码 → 只有「unknown」才重启 → 否则**只弹窗，什么都不做**。
        #    结果实测（09-11 23:27 那次）：被踢之后离线 20 多分钟，
        #    看门狗一直在旁边看着，干等到 NapCat 自己出问题才重启 —— 完全没有自愈。
        #
        #    现在的做法：**先轻后重**，一步步真的去恢复。
        #
        #    ① 先试快速登录（轻）—— 大多数情况下 QQ 本地凭据还有效，
        #       调一下 SetQuickLogin 就能回来（实测重启后重登只要几秒）。
        #    ② 不行就重启 NapCat（重）—— 启动时 autoLoginAccount 会自动快登。
        #    ③ 都不行才弹窗叫人扫码。
        #
        #    ⚠️ 2026-09-15 加：② 之前先看 `hasCred` ——
        #       **凭据已经被腾讯清掉时，快登和重启都不可能成功**，
        #       那就别白烧风控信号，直接进 ③ 叫人扫码。

        $recovered = $false

        # ① 快速登录（不重启，最轻）
        #    ⚠️ 限制频率：NapCat 管理接口有 loginRate 限流，猛点会被拒（踩过）。
        #    ⚠️ 凭据没了就别试了 —— 必定失败，而且每次都是一个异常登录信号。
        if (-not $qq.hasCred) {
          Say '   → 本地快速登录凭据已被清掉（不在 NapCat 的快登名单里）'
          Say '      → 快登/重启都不可能成功，**不再白试**，直接叫人扫码'
        } elseif (($now - $lastQuickLogin).TotalSeconds -gt 45) {
          $lastQuickLogin = $now
          Say '   → 试快速登录（免扫码）'
          try {
            $r = & node (Join-Path $BotDir 'tools\napcat-recover.mjs') 2>$null | Select-Object -First 1
            Say "     结果: $r"
            if ($r -match '^ok') { $recovered = $true }
          } catch {
            Say "     快速登录出错: $($_.Exception.Message)"
          }
        }

        # ② 还是离线 → 分三种情况处理
        #
        #    ⚠️⚠️ **不能无脑重启 NapCat**（2026-09-13 改）：
        #      原来这里是「快登没成 → 直接 Start-NapCat」，而 Start-NapCat
        #      会**杀掉 QQ 重新登录** —— 这是最贵的操作：
        #        · 每次重启都是一个风控信号（"频繁重登"是风控最敏感的特征，
        #          用户的机器人号已经因为"设备存在外挂"被处罚过）
        #        · 还会**作废用户刚要扫的二维码**（他扫的时候码已经换了）
        #
        #    ⚠️ 但也**不能一概"进程活着就永不重启"**（2026-09-15 修）——
        #      那正是这次卡死 45 分钟的第二个原因：`stale` 卡死态里
        #      NapCat 进程活得好好的，可它的登录态已经被作废，
        #      **它自己永远出不来，只有重启才能清掉那个坏会话**。
        #
        #    所以按状态区分：
        #      · **stale（卡死）** + 凭据还在 → **重启 NapCat**（唯一出路），10 分钟节流
        #      · **offline（在等扫码）**    → 绝不重启（会作废二维码），只叫人
        #      · **NapCat 进程真死了**       → 重启（不重启永远好不了）
        if (-not $recovered) {
          $canRestart = ($now - $lastOfflineRestart).TotalMinutes -gt 10

          if ($qq.state -eq 'stale' -and $qq.hasCred) {
            if ($canRestart) {
              $lastOfflineRestart = $now
              Say '   → **卡死态**（登录态已作废、NapCat 自己出不来）→ 重启 NapCat 清掉坏会话'
              Start-NapCat | Out-Null
              Start-Sleep -Seconds 5
              if (-not (Test-Bot)) { Start-Bot | Out-Null }
              Start-Sleep -Seconds 20
              $after = Test-QQOnline
              if ($after.state -eq 'online') {
                $recovered = $true
                Say '   ✅ 重启后自动登录成功'
              } else {
                Say "   → 重启后仍然 $($after.state)（凭据可能也已失效）"
                $qq = $after
              }
            } else {
              Say '   → 卡死态，但 10 分钟内刚重启过 —— 先不动（避免连着登录送风控信号）'
            }
          } elseif (Test-NapCatAlive) {
            Say '   → NapCat 进程还活着（在等扫码），**不重启** —— 只把机器人拉起来 + 叫人'
            if (-not (Test-Bot)) { Start-Bot | Out-Null }
            $recovered = $false
          } elseif ($canRestart) {
            $lastOfflineRestart = $now
            Say '   → NapCat 进程真的不在了，重启它（启动时会自动快登）'
            Start-NapCat | Out-Null
            Start-Sleep -Seconds 5
            if (-not (Test-Bot)) { Start-Bot | Out-Null }
            # 给 NapCat 一点时间把自动登录跑完，再判定
            Start-Sleep -Seconds 20
            if ((Test-QQOnline).state -eq 'online') {
              $recovered = $true
              Say '   ✅ 重启后自动登录成功'
            }
          }
        }

        # ③ 自动恢复都失败 → 才叫人（10 分钟内不重复弹）
        if (-not $recovered -and (($now - $lastOfflineAlert).TotalMinutes -gt 10)) {
          $lastOfflineAlert = $now

          # ⚠️ 2026-09-13 改：**二维码现在在机器人自己的界面里就能出**。
          #
          #    原来这里给的是 `txz.qq.com` 的登录链接 —— 但那个链接
          #    **在电脑浏览器里会跳转到 QQ 官网下载页**（得用手机打开才行），
          #    用户按提示点进去看到的是"QQ 轻松做自己 / Windows 版下载"。
          #
          #    现在机器人界面（3099）里那个「显示二维码」按钮**修好了**
          #    （原来因为读错字段名，一直画一张过期的缓存码）。
          #    所以直接指向界面最省事。
          $qrLine = "**去机器人管理界面点一下就能扫**（比找文件方便）：`n`n" +
            "    ① 打开  http://127.0.0.1:3099`n" +
            "    ② 找「QQ 登录」那张卡片`n" +
            "    ③ 点「一键恢复登录」（先试免扫码）`n" +
            "    ④ 不行再点「显示二维码」，手机 QQ 扫"

          Alert '客服小祥掉线了（需要你扫码）' @"
机器人账号的 QQ 掉线了，而且**自动恢复没成功**。

看门狗已经试过：
 · 快速登录（免扫码）—— 没成
 · 凭据还在但没有自愈 → 已经重启过 NapCat（启动时自带快登）

**还是不行，说明本地登录凭据已经被腾讯清掉了**（2026-09-15 实测：
被踢之后 NapCat 的「快速登录名单」里就只剩服主主号了）——
**这种情况没有任何自动手段能救，只能扫一次码。**

⚠️ **注意别扫错号**：要用**机器人号（$BotQQ）**对应的手机 QQ 去扫，
别把服主主号（10000001）登进去。

$qrLine

━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ 顺便说一下「减少掉线」这件事（2026-09-13 查证后更新）：

这个机器人号收到过 QQ 安全中心的处罚通知——
「设备存在外挂或其他软件影响 QQ 正常使用」「已对风险设备进行下线处理」。

**这是使用非官方客户端（NapCat）的固有风险**，没有办法根治：
 · 之前设想的「把 QQ 降到 9.9.26-44343」**方向是错的** ——
   NapCat 官方现在要求 QQ「安装且最新」，而且那个版本已被标记失效（issue #1988）。
 · 你的 NapCat 已经是**最新版 v4.18.19**，没有更新可做。
 · 代码层已做能做的预防：**不再发戳一戳这类必然失败的"包"**
   （每次失败都是一次异常请求，等于给风控送证据）。

**所以策略上：把机器人号当"可牺牲的"** —— 它被封就重新注册一个，
不用因此焦虑。真正要保护的是你的主号（不要用它跑 NapCat）。
"@
        }
        $qqOfflineCount = 0
      }
    } else {
      if ($qqOfflineCount -gt 0) { Say '✅ QQ 恢复在线了' }
      $qqOfflineCount = 0
    }
  }

  if (-not (Test-Bot)) {
    Say '❌ 机器人进程不在了，重新拉起'
    Start-Bot | Out-Null
  }
}
