# start-sl.ps1 —— 纯 SnowLuma 启动（**不含 anode**，2026-11-21 起）
#
# ## 为什么有这个文件
# 原来的 `start-saki.ps1` 是 **anode 客户端模式**的全流程：
#     anode 席位 → 座位里的 QQ → daemon（读屏）→ 适配器（假 OneBot）→ bot
# 用户 2026-11-21 决定：**把爱音也接回 SL，anode 只作技术储备、不再自启**
#     （「把爱音也先接进sl，关掉anode模式，anode模式作为技术储备吧，关闭anode自启」）
# ⇒ 这个脚本只做 SL 那半边：**起协议端（如果没起）+ 起 bot 号**，别的一律不碰 ✓
#
# ## 顺序（照 AGENTS 的「重启的正确顺序」）
#   ① 数 SL 实例（必须 ≤1）
#   ② 没起就起（WMI，零窗口）
#   ③ 等端口 3001/3002/3003 中有活在听
#   ④ 起 bot（`node tools/start-bot.mjs --all`，零窗口）
#   ⑤ 等日志出现「已登录 QQ」
#
# ⚠️ 一个黑窗都不许弹（用户 2026-10-22 / 2026-11-18 两次强调）
# ⚠️ 全程按 PID 操作，**绝不按 CommandLine 匹配**（会杀到 DSH 自己的 runner）

$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $base

$logDir = Join-Path $base 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'start-sl.log'

function Log([string]$m) {
    $line = "$(Get-Date -Format 'HH:mm:ss') $m"
    Write-Host $line
    Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
}
function Fail([string]$m) {
    Log "❌ $m"
    exit 1
}

Log '=== 纯 SL 启动开始 ==='

# ---------------------------------------------------------------- ① 数实例
$slExe = 'C:\SnowLuma\node.exe'
if (-not (Test-Path $slExe)) { Fail "找不到 $slExe" }

$inst = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.ExecutablePath -like 'C:\SnowLuma*' })

if ($inst.Count -gt 1) {
    # ⚠️ 2026-11-21 踩过：会有"空转实例"（端口被占它自己换一个、不连任何 bot）
    #    ⇒ 判据是**谁占着 3001**，不是"有几个进程"
    $owner3001 = (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue).OwningProcess
    Log "① 发现 $($inst.Count) 个 SL 实例（pid $($inst.ProcessId -join ','))；3001 的 owner = $owner3001"
    foreach ($p in $inst) {
        if ($p.ProcessId -ne $owner3001) {
            Log "   停掉空转的 $($p.ProcessId)"
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 3
    $inst = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.ExecutablePath -like 'C:\SnowLuma*' })
}

if ($inst.Count -eq 1) {
    Log "① SL 已在跑（pid $($inst[0].ProcessId)）✓ 不重复起"
} else {
    Log '① SL 没在跑，启动中（WMI，零窗口）…'
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine      = '"C:\SnowLuma\node.exe" index.mjs'
        CurrentDirectory = 'C:\SnowLuma'
    }
    if ($r.ReturnValue -ne 0) { Fail "WMI 起协议端失败，ReturnValue=$($r.ReturnValue)" }
    Log "   已起，pid=$($r.ProcessId)，等 25 秒…"
    Start-Sleep -Seconds 25
}

# ---------------------------------------------------------------- ② 等端口
$wantPorts = @(3001, 3002, 3003)
$ready = $false
foreach ($i in 1..20) {
    $live = @($wantPorts | Where-Object {
            (Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue) -ne $null
        })
    if ($live.Count -gt 0) {
        Log "② 端口在听: $($live -join ', ') ✓"
        $ready = $true
        break
    }
    Start-Sleep -Seconds 2
}
if (-not $ready) {
    Log '② ⚠️ 3001/3002/3003 都没在听 —— 可能是账号还没 hook 上（QQ 没登 / 白名单挡住了）'
    Log '   ⇒ 先看 C:\SnowLuma\logs\snowluma-<日期>.log，再决定要不要动'
}

# ---------------------------------------------------------------- ③ 起 bot
Log '③ 起 bot（node tools\start-bot.mjs --all，零窗口）…'
$out = & node "$base\tools\start-bot.mjs" --all 2>&1 | Out-String
foreach ($line in ($out -split "`r?`n")) {
    if ($line.Trim()) { Log "   $line" }
}
Start-Sleep -Seconds 22

# ---------------------------------------------------------------- ④ 验收
$locks = @(
    @{ n = 'Saki'; p = Join-Path $base 'state\bot.lock' },
    @{ n = 'Anon'; p = Join-Path $base 'state\accounts\10000013\bot.lock' },
    @{ n = '第三号'; p = Join-Path $base 'state\accounts\10000014\bot.lock' }
)
foreach ($l in $locks) {
    if (-not (Test-Path $l.p)) { Log "④ $($l.n)：没有锁文件"; continue }
    try {
        $j = Get-Content $l.p -Raw | ConvertFrom-Json
        $alive = $true
        try { Get-Process -Id $j.pid -ErrorAction Stop | Out-Null } catch { $alive = $false }
        Log "④ $($l.n)：pid=$($j.pid) $(if ($alive) { '活着 ✓' } else { '❌ 已死' })"
    } catch {
        Log "④ $($l.n)：锁文件读不出来"
    }
}

$today = Get-Date -Format 'yyyy-MM-dd'
foreach ($f in @("bot-$today.log", "bot-$today-10000013.log")) {
    $fp = Join-Path $logDir $f
    if (-not (Test-Path $fp)) { continue }
    $hit = Get-Content $fp -Tail 40 -Encoding utf8 | Select-String -Pattern '已连接到协议端|已登录 QQ'
    foreach ($h in $hit) { Log "④ $f → $($h.Line.Trim())" }
}

Log '=== 纯 SL 启动结束（anode 未启动，符合当前策略）==='
