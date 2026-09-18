<#
  安全重启机器人 —— **先算间隔，不够就直接拒绝**。

  ## 为什么要有它（2026-09-18 用户提的）

  用户原话：「我发现你有几次都是重启之后才发现不能重启的，能改进一下吗」。

  那天我（AI）至少三次重启间隔不足：**46 秒 / 3 分 44 秒 / 1 分 53 秒** ——
  每次都是**手工算时间**（在命令里写 `Get-Date '上次时间'`），漏了或算错，
  而且**重启之后才发现**。人肉把关不可靠，所以把这道闸写成脚本：
  **不够就 exit 1，根本不动手**。

  ## 为什么必须是 5 分钟

  一次"重启机器人" = **一次新的 QQ 登录**。这个号已经被 QQ 安全中心标成
  "风险设备"（收到过「设备存在外挂或其他软件影响 QQ 正常使用」的处罚通知），
  短时间内的会话更迭是风控**最敏感**的特征。

  ## 用法

    powershell -File tools\restart-bot.ps1 -CheckOnly   # 只算间隔、不动手（先跑这个）
    powershell -File tools\restart-bot.ps1              # 够了就重启；不够就拒绝
    powershell -File tools\restart-bot.ps1 -Force       # 明知有风险也要重启（别乱用）

  ## 上次登录时间从哪来

  `logs/bot.log` 每次启动都会被 `_run-bot.bat` 清空，所以里面的
  「已登录 QQ」**最后一条**就是**当前这一实例**的登录时刻 = 上次重启时刻。
  这条判据不需要额外落盘，也不怕机器人自己掉线重连（那种情况取最后一条仍然对）。
#>
param(
  [int]$MinGapSec = 300,
  [switch]$CheckOnly,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # 本脚本在 tools\ 下，根目录是上一层
Set-Location $root
$logPath = Join-Path $root 'logs\bot.log'

function Get-LastLoginAt {
  if (-not (Test-Path $logPath)) { return $null }
  $hit = Get-Content $logPath -ErrorAction SilentlyContinue |
    Select-String '已登录 QQ' | Select-Object -Last 1
  if (-not $hit) { return $null }
  # 行形如：[14:09:46] INF 已登录 QQ: 10000002
  $m = [regex]::Match($hit.Line, '^\[(\d{2}):(\d{2}):(\d{2})\]')
  if (-not $m.Success) { return $null }
  $t = Get-Date
  return (Get-Date -Year $t.Year -Month $t.Month -Day $t.Day `
      -Hour ([int]$m.Groups[1].Value) -Minute ([int]$m.Groups[2].Value) `
      -Second ([int]$m.Groups[3].Value))
}

$last = Get-LastLoginAt
$now = Get-Date
if ($last) {
  $gap = [int]($now - $last).TotalSeconds
  if ($gap -lt 0) { $gap = 0 }   # 跨天 / 时钟漂移，当作"刚刚"
  Write-Host ("上次登录（= 上次重启）：{0}" -f $last.ToString('HH:mm:ss'))
  Write-Host ("距现在：{0} 分 {1} 秒（门槛 {2} 分）" -f [int]($gap / 60), ($gap % 60), [int]($MinGapSec / 60))
} else {
  Write-Host '日志里找不到「已登录 QQ」——机器人可能还没起来过。' -ForegroundColor Yellow
  $gap = [int]::MaxValue
}

if ($gap -lt $MinGapSec -and -not $Force) {
  $need = $MinGapSec - $gap
  Write-Host ("拒绝重启：还要等 {0} 分 {1} 秒。" -f [int]($need / 60), ($need % 60)) -ForegroundColor Red
  Write-Host '（重启 = 一次 QQ 登录，这个号是风险设备。要么等，要么 -Force）' -ForegroundColor Red
  exit 1
}

if ($CheckOnly) {
  Write-Host '现在可以重启（-CheckOnly：只报结论，不动手）。' -ForegroundColor Green
  exit 0
}

# ── 到这里才真的重启 ───────────────────────────────────────
# ⚠️ 模式**拼接**着写：别让完整字面量出现在命令行里 ——
#    否则会匹配到 DSH 自己的 runner（那个 node 进程的命令行带着我这条命令的全文）。
$pat = 'src[\\/]' + 'index' + '\.js'
$pids = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $pat -and $_.ProcessId -ne $PID -and $_.CommandLine -notmatch 'runner\.js' } | Select-Object -ExpandProperty ProcessId)
if ($pids.Count -eq 0) {
  Write-Host '没找到机器人在跑 —— 等看门狗自己补（10~15 秒）。' -ForegroundColor Yellow
} else {
  Write-Host ("杀掉实例：{0}" -f ($pids -join ', '))
  Stop-Process -Id $pids -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 15   # 先给看门狗机会（它通常 5~20 秒内会补一个）
$list = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $pat -and $_.ProcessId -ne $PID -and $_.CommandLine -notmatch 'runner\.js' })
if ($list.Count -eq 0) {
  Write-Host '看门狗还没补上来，再等 15 秒…'
  Start-Sleep -Seconds 15
  $list = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match $pat -and $_.ProcessId -ne $PID -and $_.CommandLine -notmatch 'runner\.js' })
}
$color = if ($list.Count -eq 1) { 'Green' } else { 'Red' }
Write-Host ("实例数：{0}（必须是 1）" -f $list.Count) -ForegroundColor $color
$list | Select-Object ProcessId, CreationDate | Format-Table -AutoSize
Get-Content $logPath -ErrorAction SilentlyContinue |
  Select-String '已连接|已登录|SyntaxError' | Select-Object -Last 3
