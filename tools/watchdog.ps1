# 客服小祥 · 看门狗（常驻，卡死自动重启）
#
# 为什么需要它：daemon 卡死的时候**它自己检测不到**（主循环已经停在那了），
# 只能靠外面盯着。实测 2026-11-21 卡了 40 分钟，所有群消息既不落盘也不推，
# 而进程还活着（CPU 只用了 34 秒）—— 光看"进程在不在"根本发现不了 ✗
#
# 判据：daemon 主循环每轮会摸 `state\daemon-heartbeat`。
#   这个文件超过 -StaleSec 秒没更新 + 座位里还有 python 进程 ⇒ 判定卡死。
#
# 动作：杀掉座位里的 daemon，然后跑一次 start-saki.ps1（它会重新拿租约、起 daemon）。
#
# 用法（由 start-saki.ps1 自动拉起；也可以手动）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\watchdog.ps1
param(
    [int]$StaleSec = 120,      # 心跳超过这么久没更新 = 卡死
    [int]$IntervalSec = 30,    # 每轮检查间隔
    [int]$MaxRestarts = 20     # 一小时内最多重启几次（防死循环）
)

$ErrorActionPreference = 'Continue'
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $toolsDir
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logPath = Join-Path $logDir 'watchdog.log'
$beat = Join-Path $root 'state\daemon-heartbeat'
$startPs1 = Join-Path $root 'start-saki.ps1'

function Log([string]$msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $msg
    try { Add-Content -LiteralPath $logPath -Value $line -Encoding utf8 } catch {}
}

Log "===== 看门狗启动（stale=${StaleSec}s interval=${IntervalSec}s）====="

# ⚠️ 写自己的 pid 到 state\watchdog.lock —— 「看门狗（隐藏）.vbs」靠它判"是不是已经有一个在跑"，
#    避免多开之后互相踩（各自判定卡死、各自去重启，把好好的 daemon 反复杀掉）✗
$lockPath = Join-Path $root 'state\watchdog.lock'
try { Set-Content -LiteralPath $lockPath -Value $PID -Encoding ascii } catch {}

$restarts = @()   # 每次重启的时间戳，用来限流

while ($true) {
    try {
        # ── 座位 session 号（每次现查，座位可能被重建）
        $anode = $null
        foreach ($p in @("$env:LOCALAPPDATA\Programs\Anode\anode.exe")) {
            if (Test-Path $p) { $anode = $p; break }
        }
        if (-not $anode) {
            $c = Get-Command anode -ErrorAction SilentlyContinue
            if ($c) { $anode = $c.Source }
        }
        if (-not $anode) { Log "找不到 anode.exe，跳过本轮"; Start-Sleep $IntervalSec; continue }

        $st = & $anode status 2>&1 | Out-String
        if ($st -notmatch 'state\s+ready') {
            Log "anode 席位不在（state 非 ready）⇒ 直接跑 start-saki 拉起"
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startPs1 *>> $logPath
            Start-Sleep $IntervalSec
            continue
        }
        $seatSession = -1
        if ($st -match 'seat session\s+(\d+)') { $seatSession = [int]$Matches[1] }

        # ── 座位里有没有 daemon 进程
        $pyProcs = @()
        if ($seatSession -ge 0) {
            $pyProcs = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
                Where-Object { $_.SessionId -eq $seatSession })
        }

        if ($pyProcs.Count -eq 0) {
            Log "座位里没有 daemon ⇒ 跑 start-saki 拉起"
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startPs1 *>> $logPath
            Start-Sleep $IntervalSec
            continue
        }

        # ── 心跳新鲜度
        if (-not (Test-Path $beat)) {
            # 刚起还没摸过，或者这个版本还没心跳（老版本）—— 给它一个观察期
            Start-Sleep $IntervalSec
            continue
        }
        $age = ((Get-Date) - (Get-Item $beat).LastWriteTime).TotalSeconds
        if ($age -le $StaleSec) {
            Start-Sleep $IntervalSec
            continue
        }

        # ── 判定卡死
        $now = Get-Date
        $restarts = @($restarts | Where-Object { ($now - $_).TotalMinutes -lt 60 })
        if ($restarts.Count -ge $MaxRestarts) {
            Log ("⚠️ 心跳已 $([int]$age)s 没更新，但这一小时已经重启 $($restarts.Count) 次 ⇒ 停手，等人工")
            Start-Sleep ($IntervalSec * 4)
            continue
        }

        Log ("💀 判定卡死：心跳 $([int]$age)s 没更新（阈值 ${StaleSec}s），座位里 $($pyProcs.Count) 个 python")
        foreach ($p in $pyProcs) {
            Log "   杀 pid=$($p.ProcessId)"
            try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
        }
        $restarts += $now
        Start-Sleep -Seconds 4

        Log "→ 调 start-saki.ps1 重起"
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startPs1 *>> $logPath
        Log "→ 重启流程结束"
    } catch {
        Log "看门狗本轮出错：$($_.Exception.Message)"
    }
    Start-Sleep $IntervalSec
}
