# 客服小祥 · 全流程启动（幂等，可以反复跑）
#
# 顺序：anode 席位 → 座位里的 QQ（启动/登录/认窗口） → daemon → 适配器 → bot 号
# 每一步都先检查"是不是已经在跑"，在跑就跳过 ⇒ 随时重跑都安全。
#
# 2026-11-21 新建：原来那套（autostart.ps1 / start-all.ps1）是**老架构**
#   （SnowLuma + 桌面 QQ），现在是 anode 座位 + 客户端适配器，那条路已经不通了。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File start-saki.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File start-saki.ps1 -NoBot
param(
    [switch]$NoBot
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logPath = Join-Path $logDir 'start-saki.log'
$PY = 'C:\Temp\dbenv\Scripts\python.exe'

function Log([string]$msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Write-Host $line
    try { Add-Content -LiteralPath $logPath -Value $line -Encoding utf8 } catch {}
}
function Fail([string]$msg) { Log "❌ $msg"; exit 1 }

Set-Location $root
Log "===== 全流程启动 开始 ====="

# ---------------------------------------------------------------- 找 anode
$anode = $null
foreach ($p in @("$env:LOCALAPPDATA\Programs\Anode\anode.exe")) {
    if (Test-Path $p) { $anode = $p; break }
}
if (-not $anode) {
    $c = Get-Command anode -ErrorAction SilentlyContinue
    if ($c) { $anode = $c.Source }
}
if (-not $anode) { Fail "找不到 anode.exe" }
Log "anode = $anode"

# ---------------------------------------------------------------- ① 席位
$st = & $anode status 2>&1 | Out-String
if ($st -match 'state\s+ready') {
    Log "① anode 席位已在跑 ✓"
} else {
    Log "① anode 没在跑，启动中…"
    & $anode start --hidden 2>&1 | ForEach-Object { Log "   $_" }
    Start-Sleep -Seconds 8
    $st = & $anode status 2>&1 | Out-String
    if ($st -notmatch 'state\s+ready') { Fail "anode 启动后状态不是 ready" }
    Log "① anode 已就绪 ✓"
}
$seatSession = -1
if ($st -match 'seat session\s+(\d+)') { $seatSession = [int]$Matches[1] }
Log "   座位 session = $seatSession"

# ---------------------------------------------------------------- ② 租约
$leaseOut = & $anode --agent dsh lease acquire --ttl 600 2>&1 | Out-String
$token = ''
if ($leaseOut -match '"leaseToken"\s*:\s*"([^"]+)"') { $token = $Matches[1] }
if (-not $token) { Fail "拿不到 leaseToken`n$leaseOut" }
Log "② 租约 OK（$($token.Substring(0,10))…）"

# ---------------------------------------------------------------- ③ 座位里的 QQ
Log "③ 准备座位里的 QQ…"
$jobFile = Join-Path $env:TEMP 'saki-seatboot.job'
if (Test-Path $jobFile) { Remove-Item $jobFile -Force }
& $anode --agent dsh --lease $token exec --cwd $root --timeout 200000 -- `
    $PY 'tools\qq-seat-boot.py' 'Saki' 2>&1 | Out-File -FilePath $jobFile -Encoding utf8
$jobTxt = Get-Content $jobFile -Raw -ErrorAction SilentlyContinue
$jobId = ''
if ($jobTxt -match '(j_[0-9a-f]{32})') { $jobId = $Matches[1] }
if (-not $jobId) { Fail "拿不到座位脚本 jobId：$jobTxt" }
Log "   jobId = $jobId"

$seatOut = ''
for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Seconds 2
    $chunk = (& $anode --agent dsh job $jobId --wait 2500 2>&1 | Out-String)
    $seatOut += $chunk
    # ⚠️ 三种情况都要退出循环：脚本给出结论、job 已结束（崩溃也算）、或明显报错。
    #    原来只认 SEAT_OK/NEED_LOGIN/FAIL ⇒ Python 一崩就白等满 160 秒 ✗
    if ($seatOut -match 'SEAT_OK|SEAT_NEED_LOGIN|SEAT_FAIL') { break }
    if ($chunk -match '\bcompleted\b' -or $chunk -match 'Traceback') { break }
}

$hwnd = 0
if ($seatOut -match 'SEAT_OK') {
    if ($seatOut -match '"hwnd"\s*:\s*(\d+)') { $hwnd = [int]$Matches[1] }
    if ($seatOut -match '"nick"\s*:\s*"([^"]*)"') { $nick = $Matches[1] } else { $nick = '?' }
    Log "③ QQ 就绪：hwnd=$hwnd 昵称=$nick ✓"
} elseif ($seatOut -match 'SEAT_NEED_LOGIN') {
    Log "❌ 需要人工登录座位里的 QQ"
    ($seatOut -split "`n" | Where-Object { $_ -match 'SEAT_NEED_LOGIN' }) | ForEach-Object { Log "   $_" }
    Log "   → 打开 anode 查看器看一眼座位；处理好后重跑本脚本"
    exit 2
} else {
    ($seatOut -split "`n" | Select-Object -Last 15) | ForEach-Object { if ($_.Trim()) { Log "   $_" } }
    Fail "座位 QQ 准备失败（没看到 SEAT_OK）"
}

# ---------------------------------------------------------------- ④ daemon
$pyCount = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.SessionId -eq $seatSession }).Count
if ($pyCount -gt 0) {
    Log "④ daemon 已在跑（座位里 $pyCount 个 python）✓"
} else {
    Log "④ 起 daemon…"
    $r = & $anode --agent dsh --lease $token run $PY `
        (Join-Path $root 'tools\qq-daemon-launch.py') '--hwnd' "$hwnd" '--port' '6701' 2>&1 |
        Out-String
    Log "   $($r.Trim())"
    Start-Sleep -Seconds 14
    $dTail = Get-Content (Join-Path $logDir 'qq-daemon.log') -Tail 8 -ErrorAction SilentlyContinue
    if ($dTail -match 'daemon v4 启动') { Log "④ daemon 起来了 ✓" }
    else {
        ($dTail | ForEach-Object { Log "   $_" })
        Fail "daemon 没起来（看 logs/qq-daemon.log 和 qq-daemon-launch.log）"
    }
}

# ---------------------------------------------------------------- ⑤ 适配器
$adp = Get-NetTCPConnection -LocalPort 6700 -State Listen -ErrorAction SilentlyContinue
if ($adp) {
    Log "⑤ 适配器已在跑（pid=$($adp[0].OwningProcess)）✓"
} else {
    Log "⑤ 起适配器…"
    $vbs = Join-Path $root 'tools\启动适配器（隐藏）.vbs'
    if (-not (Test-Path $vbs)) { $vbs = Join-Path $root 'tools\_start-adapter.vbs' }
    if (-not (Test-Path $vbs)) { Fail "找不到适配器启动脚本" }
    Start-Process -FilePath 'wscript.exe' -ArgumentList $vbs -WorkingDirectory $root
    Start-Sleep -Seconds 12
    $adp = Get-NetTCPConnection -LocalPort 6700 -State Listen -ErrorAction SilentlyContinue
    if ($adp) { Log "⑤ 适配器起来了（pid=$($adp[0].OwningProcess)）✓" }
    else { Fail "适配器没起来（看 logs/qq-onebot.log）" }
}

# ---------------------------------------------------------------- ⑥ bot
if ($NoBot) {
    Log "⑥ 跳过 bot（-NoBot）"
} else {
    $mainAlive = $false
    $lock = Join-Path $root 'state\bot.lock'
    if (Test-Path $lock) {
        try {
            $j = Get-Content $lock -Raw | ConvertFrom-Json
            if ($j.pid) { Get-Process -Id $j.pid -ErrorAction Stop | Out-Null; $mainAlive = $true }
        } catch {}
    }
    if ($mainAlive) {
        Log "⑥ bot 主号已在跑 ✓（不重复启动）"
    } else {
        Log "⑥ 起 bot 号…"
        & node 'tools\start-bot.mjs' '--all' 2>&1 | ForEach-Object { Log "   $_" }
        Start-Sleep -Seconds 25
    }
}

# ---------------------------------------------------------------- ⑦ 看门狗
#    ⚠️ 2026-11-21 加（用户：「卡死了要自动重启」）——
#    daemon 卡死时**它自己检测不到**（主循环停在那了），只能靠外面盯。
#    看门狗看 `state\daemon-heartbeat` 的新鲜度，超过 120 秒没更新就杀掉重起。
$wdVbs = Join-Path $root 'tools\看门狗（隐藏）.vbs'
$wdLock = Join-Path $root 'state\watchdog.lock'
$wdAlive = $false
if (Test-Path $wdLock) {
    try {
        $wdPid = [int]((Get-Content $wdLock -Raw).Trim())
        if ($wdPid -gt 0) { Get-Process -Id $wdPid -ErrorAction Stop | Out-Null; $wdAlive = $true }
    } catch {}
}
if ($wdAlive) {
    Log "⑦ 看门狗已在跑（pid=$wdPid）✓"
} elseif (Test-Path $wdVbs) {
    Log "⑦ 起看门狗（隐藏）…"
    Start-Process -FilePath 'wscript.exe' -ArgumentList $wdVbs -WorkingDirectory $root
    Start-Sleep -Seconds 4
    if (Test-Path $wdLock) {
        $wdPid2 = [int]((Get-Content $wdLock -Raw).Trim())
        Log "⑦ 看门狗起来了（pid=$wdPid2）✓"
    } else {
        Log "⑦ 看门狗可能没起来（没看到 lock），看 logs\watchdog.log"
    }
} else {
    Log "⑦ 没找到 看门狗（隐藏）.vbs，跳过"
}

# ---------------------------------------------------------------- 自检
Log "===== 自检 ====="
$adp2 = Get-NetTCPConnection -LocalPort 6700 -State Listen -ErrorAction SilentlyContinue
Log ("  适配器 6700 : " + $(if ($adp2) { "✓ pid=" + $adp2[0].OwningProcess } else { "❌" }))
$d2 = Get-Content (Join-Path $logDir 'qq-daemon.log') -Tail 5 -ErrorAction SilentlyContinue
Log ("  daemon      : " + $(if ($d2 -match '心跳|摘要基线|落盘|切到') { "✓" } else { "？看日志" }))
$today = Get-Date -Format 'yyyy-MM-dd'
$b2 = Join-Path $logDir ("bot-{0}.log" -f $today)
Log ("  bot 日志    : " + $(if ((Test-Path $b2) -and (Get-Item $b2).LastWriteTime -gt (Get-Date).AddMinutes(-5)) { "✓ 最近还在写" } else { "？" }))
Log "===== 全流程启动 结束 ====="
exit 0
