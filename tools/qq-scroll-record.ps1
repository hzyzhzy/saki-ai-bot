# QQ 聊天记录**边滚边录**（真的在滑动，不是静态截图）
#
# 为什么不能只截帧：用户 2026-10-20 要求「群里的聊天不是截图，是要真的在滑动的聊天记录」。
#
# 做法：PrintWindow 后台截帧 + **mouse_event 滚轮**推动聊天区；
# ⚠️ 滚轮只对**前台窗口**生效（实测：不前台化的话画面完全不变 ✗）
#    ⇒ 录制期间会把 QQ 抢到前台，**别在这个窗口上干别的**，录完会自动还回去。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\qq-scroll-record.ps1 `
#     -Title "QQ" -Seconds 45 -Fps 20 -ScrollPerSec 1.5 -Direction up
#
# 参数：
#   -Direction  up = 往历史翻（滚轮向上）；down = 往最新翻
#   -ScrollPerSec 每秒滚几格（1~2 比较自然，太快会晕）

param(
  [string]$Title = 'QQ',
  [int]$Seconds = 45,
  [int]$Fps = 20,
  [double]$ScrollPerSec = 1.5,
  [string]$Direction = 'up',
  [string]$Crop = 'chat',
  [string]$OutDir = '',
  [long]$Handle = 0
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class QSR {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, IntPtr e);
  public struct RECT { public int L, T, R, B; }
}
"@

$ErrorActionPreference = 'Stop'

# ── 找窗口 ────────────────────────────────────────
$qqPids = @((Get-Process -Name QQ -ErrorAction SilentlyContinue).Id)
if ($qqPids.Count -eq 0) { Write-Host "❌ QQ 没在跑"; exit 1 }
$cands = New-Object System.Collections.ArrayList
if ($Handle -gt 0) {
  [void]$cands.Add([pscustomobject]@{ H = [IntPtr]$Handle; 标题 = '(指定句柄)' })
} else {
  $cb = [QSR+EnumWindowsProc]{
    param($h, $p)
    $pid2 = 0; [void][QSR]::GetWindowThreadProcessId($h, [ref]$pid2)
    if ($script:qqPids -contains [int]$pid2 -and [QSR]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 512; [void][QSR]::GetWindowText($h, $sb, 512)
      $r = New-Object QSR+RECT; [void][QSR]::GetWindowRect($h, [ref]$r)
      if (($r.R-$r.L) -gt 200 -and ($r.B-$r.T) -gt 200) {
        [void]$script:cands.Add([pscustomobject]@{ H = $h; 标题 = $sb.ToString(); 宽 = ($r.R-$r.L); 高 = ($r.B-$r.T) })
      }
    }
    return $true
  }
  [void][QSR]::EnumWindows($cb, [IntPtr]::Zero)
}
$hit = $cands | Where-Object { $_.标题 -like "*$Title*" } | Select-Object -First 1
if (-not $hit) {
  Write-Host "❌ 没找到标题含 '$Title' 的窗口。现有："
  $cands | ForEach-Object { Write-Host "   '$($_.标题)'" }
  exit 1
}
$h = $hit.H
$r = New-Object QSR+RECT; [void][QSR]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $hh = $r.B - $r.T
Write-Host "目标：标题='$($hit.标题)' 句柄=$h 尺寸=${w}x${hh}"

# ── 裁剪（主窗口跳过左栏，独立聊天窗口整窗）────────
$x0 = 0; $y0 = 0; $cw = $w; $ch = $hh
if ($Crop -eq 'chat') {
  $isMain = ($hit.标题 -eq 'QQ' -or [string]::IsNullOrWhiteSpace($hit.标题))
  if ($isMain) { $x0 = [int]($w * 0.455); $y0 = [int]($hh * 0.055) }
  $cw = $w - $x0; $ch = $hh - $y0
  Write-Host "裁剪 → ${cw}x${ch}（起点 $x0,$y0）"
}

if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot "..\logs\bili\qqrec\$(Get-Date -Format 'yyyyMMdd-HHmmss')-scroll" }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host "帧输出：$OutDir"

# ── 抢前台 + 把鼠标放到聊天区中央 ─────────────────
[void][QSR]::ShowWindow($h, 9)          # SW_RESTORE
Start-Sleep -Milliseconds 200
[void][QSR]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 400
$mx = [int](($r.L + $r.R) / 2 + 120)    # 偏右一点，避开左侧会话列表
$my = [int]($r.B * 0.55)
[void][QSR]::SetCursorPos($mx, $my)
Start-Sleep -Milliseconds 200
Write-Host "⚠️ 录制中：QQ 已被拉到前台，请勿操作（鼠标已移到聊天区 $mx,$my）"

# ── 边截边滚 ─────────────────────────────────────
$interval = [int](1000 / $Fps)
$total = $Seconds * $Fps
$scrollEvery = [int]($Fps / $ScrollPerSec)
if ($scrollEvery -lt 1) { $scrollEvery = 1 }
$delta = if ($Direction -eq 'up') { 120 } else { -120 }   # 向上滚 = 看更早的消息
$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 85

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$n = 0
for ($i = 0; $i -lt $total; $i++) {
  $target = $i * $interval
  while ($sw.ElapsedMilliseconds -lt $target) { Start-Sleep -Milliseconds 1 }

  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][QSR]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc); $g.Dispose()

  if ($Crop -eq 'chat') {
    $rect = New-Object System.Drawing.Rectangle $x0, $y0, $cw, $ch
    $cropped = $bmp.Clone($rect, $bmp.PixelFormat)
    $bmp.Dispose()
    $cropped.Save((Join-Path $OutDir ("f{0:d5}.jpg" -f $i)), $jpegCodec, $encParams)
    $cropped.Dispose()
  } else {
    $bmp.Save((Join-Path $OutDir ("f{0:d5}.jpg" -f $i)), $jpegCodec, $encParams)
    $bmp.Dispose()
  }
  $n++

  # 到点滚一格（每格 120 = 标准滚轮一档）
  if ($i % $scrollEvery -eq 0 -and $i -gt 0) {
    [void][QSR]::SetCursorPos($mx, $my)   # 保险：焦点被抢走时鼠标位置会变
    [void][QSR]::mouse_event(0x0800, 0, 0, $delta, [IntPtr]::Zero)
  }
}
$sw.Stop()
$sz = (Get-ChildItem $OutDir -Filter *.jpg | Measure-Object Length -Sum).Sum
Write-Host "✅ 录完：$n 帧 / $([math]::Round($sw.Elapsed.TotalSeconds,1)) 秒 / $([math]::Round($sz/1MB,1)) MB"
Write-Host "   滚动：每秒 $ScrollPerSec 格，方向 $Direction"
Write-Host "FRAMES=$OutDir"
Write-Host "FPS=$Fps"
