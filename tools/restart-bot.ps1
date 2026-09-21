<#
  安全重启机器人 —— **先算间隔，不够就直接拒绝**。

  ## 为什么要有它（2026-09-18 用户提的）

  用户原话：「我发现你有几次都是重启之后才发现不能重启的，能改进一下吗」。

  那天我（AI）至少三次重启间隔不足：**46 秒 / 3 分 44 秒 / 1 分 53 秒** ——
  每次都是**手工算时间**（在命令里写 `Get-Date '上次时间'`），漏了或算错，
  而且**重启之后才发现**。人肉把关不可靠，所以把这道闸写成脚本：
  **不够就 exit 1，根本不动手**。

  ## 时间间隔门槛（⚠️ 2026-09-20 改：300 秒 → 30 秒）

  原来要求隔 **5 分钟**，理由是「一次重启机器人 = 一次新的 QQ 登录」。
  **换成 LLBot / SnowLuma 之后这条不成立了**：协议端是**独立进程**，
  重启机器人 = 机器人**重新连一次它的 OneBot（3001）** —— QQ 那边的登录会话
  **完全没动**（2026-09-20 实测：一晚重启了十几次，协议端日志里一次 login 都没有）。

  ⚠️ 现在保留的 30 秒只为防「手抖连点」和「新实例还没站稳又被杀」，**不再是风控考虑**。
  NapCat 时代（注入式）的历史理由留在这里备查：
  > 一次"重启机器人" = **一次新的 QQ 登录**。这个号已经被 QQ 安全中心标成
  > "风险设备"（收到过「设备存在外挂或其他软件影响 QQ 正常使用」的处罚通知），
  > 短时间内的会话更迭是风控**最敏感**的特征。

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
  [int]$MinGapSec = 30,   # ⚠️ 见文件头：LLBot/SnowLuma 时代重启机器人不是 QQ 登录，30 秒只为防连点
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
  $last = Get-Date -Year $t.Year -Month $t.Month -Day $t.Day `
      -Hour ([int]$m.Groups[1].Value) -Minute ([int]$m.Groups[2].Value) `
      -Second ([int]$m.Groups[3].Value)
  # ⚠️⚠️ 2026-09-19 修（用户抓到的：凌晨一点时它还说「距现在 0 分 0 秒」）：
  #    日志行里**只有 HH:MM:SS、没有日期**，所以上面那句永远按"今天"拼。
  #    **跨过午夜**之后，昨天 23:57 被拼成"今天 23:57" —— 那是个**未来**时刻，
  #    `$now - $last` 变成负数，而下面那句 `if ($gap -lt 0) { $gap = 0 }` 把它当"刚刚" →
  #    于是每次刚过午夜都会**一直显示 0 分 0 秒、一直拒绝重启**（我因为这个栽了两次，
  #    还据此算错了时间）。正确做法：**拼出来的时间比现在晚 → 那行是昨天的 → 减一天**。
  if ($last -gt (Get-Date)) { $last = $last.AddDays(-1) }
  $last
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
# ⚠️⚠️ 2026-09-20 加：**看门狗没在跑时，自己把它拉起来**。
#    为什么要加：管理界面上的「重启机器人」按钮就是调这个脚本 ——
#    而看门狗经常没在跑（2026-09-20 白天它就不在）⇒ 少了这段，
#    点一次按钮的结果是**机器人被停掉、然后没人补**，比不点还糟 ✗
if ($list.Count -eq 0) {
  Write-Host '看门狗没在跑（没人补）—— 自己用 WMI 拉起一个…' -ForegroundColor Yellow
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = 'cmd.exe /c _run-bot.bat'; CurrentDirectory = $root
  }
  Write-Host ("  已用 WMI 启动（返回 {0}）" -f $r.ReturnValue)
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    $list = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -match $pat -and $_.ProcessId -ne $PID -and $_.CommandLine -notmatch 'runner\.js' })
    if ($list.Count -ge 1) { break }
  }
}
$color = if ($list.Count -eq 1) { 'Green' } else { 'Red' }
Write-Host ("实例数：{0}（必须是 1）" -f $list.Count) -ForegroundColor $color
$list | Select-Object ProcessId, CreationDate | Format-Table -AutoSize
Get-Content $logPath -ErrorAction SilentlyContinue |
  Select-String '已连接|已登录|SyntaxError' | Select-Object -Last 3
