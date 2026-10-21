# QQ 群窗口录屏（后台截帧，不打扰用户操作）
#
# 为什么这么做：NTQQ 是 Electron，ffmpeg 的 gdigrab 按坐标录会被遮挡；
# 而 PrintWindow + PW_RENDERFULLCONTENT(2) 能**直接向窗口要画面** ——
# 窗口被别的东西盖住也照录，实测 1005x902 每帧只要 31ms（≈32 fps）✓
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\qq-window-record.ps1 -Seconds 60 -Fps 20
#   powershell -ExecutionPolicy Bypass -File tools\qq-window-record.ps1 -Crop chat -Seconds 60
#
# 参数：
#   -Seconds   录多久（默认 30）
#   -Fps       目标帧率（默认 20）
#   -Crop      full = 整窗口；chat = 只截右侧聊天区（去掉左侧会话列表，少露无关信息）
#   -OutDir    帧输出目录（默认 logs\bili\qqrec\<时间戳>）
#   -Handle    指定窗口句柄（不给就自动找"可见、且是 QQ 进程、宽高>200"的最大那个）

param(
  [int]$Seconds = 30,
  [int]$Fps = 20,
  [string]$Crop = 'full',
  [string]$OutDir = '',
  [long]$Handle = 0,
  [string]$Title = ''    # 按标题挑窗口（支持部分匹配）。⚠️ 有多个 QQ 窗口时必须给，否则会随机挑
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class QQRec {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int L, T, R, B; }
}
"@

$ErrorActionPreference = 'Stop'

# ── ① 找窗口 ─────────────────────────────────────
$qqPids = @((Get-Process -Name QQ -ErrorAction SilentlyContinue).Id)
if ($qqPids.Count -eq 0) { Write-Host "❌ QQ 没在跑"; exit 1 }

$cands = New-Object System.Collections.ArrayList
if ($Handle -gt 0) {
  [void]$cands.Add([pscustomobject]@{ H = [IntPtr]$Handle })
} else {
  $cb = [QQRec+EnumWindowsProc]{
    param($h, $p)
    $pid2 = 0
    [void][QQRec]::GetWindowThreadProcessId($h, [ref]$pid2)
    if ($script:qqPids -contains [int]$pid2 -and [QQRec]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][QQRec]::GetWindowText($h, $sb, 512)
      $r = New-Object QQRec+RECT
      [void][QQRec]::GetWindowRect($h, [ref]$r)
      $w = $r.R - $r.L; $hh = $r.B - $r.T
      if ($w -gt 200 -and $hh -gt 200) {
        [void]$script:cands.Add([pscustomobject]@{ H = $h; 标题 = $sb.ToString(); 宽 = $w; 高 = $hh })
      }
    }
    return $true
  }
  [void][QQRec]::EnumWindows($cb, [IntPtr]::Zero)
}
if ($cands.Count -eq 0) {
  Write-Host "❌ 没找到可见的 QQ 窗口（把群窗口打开、别最小化再试）"
  exit 1
}
$win = $cands | Sort-Object { $_.宽 * $_.高 } -Descending | Select-Object -First 1
if ($Title) {
  $hit = $cands | Where-Object { $_.标题 -like "*$Title*" } | Select-Object -First 1
  if (-not $hit) {
    Write-Host "❌ 没有标题含 '$Title' 的窗口。现有："
    $cands | ForEach-Object { Write-Host "   '$($_.标题)' $($_.宽)x$($_.高)" }
    exit 1
  }
  $win = $hit
}
$h = $win.H
if (-not $win.宽) {
  $r = New-Object QQRec+RECT; [void][QQRec]::GetWindowRect($h, [ref]$r)
  $win | Add-Member -NotePropertyName 宽 -NotePropertyValue ($r.R - $r.L) -Force
  $win | Add-Member -NotePropertyName 高 -NotePropertyValue ($r.B - $r.T) -Force
}
$w = [int]$win.宽; $hh = [int]$win.高
Write-Host "目标窗口：句柄=$h 标题='$($win.标题)' 尺寸=${w}x${hh}"

# 裁剪策略要区分**主窗口**和**独立聊天窗口**（2026-10-20 踩过）：
#   · 主窗口标题是 'QQ'，左边有会话列表 ⇒ 要跳过左栏（约 45.5%）
#   · 独立聊天窗口标题是**群名**，整个窗口就是聊天 ⇒ 从 0 开始，否则会把内容裁掉 ✗
$x0 = 0; $y0 = 0; $cw = $w; $ch = $hh
if ($Crop -eq 'chat') {
  $isMain = ($win.标题 -eq 'QQ' -or [string]::IsNullOrWhiteSpace($win.标题))
  if ($isMain) {
    # ⚠️ 0.487 会把群名左边裁掉一个字（"示例群" → "丸手机被抓"）⇒ 留到 0.455 ✓
    $x0 = [int]($w * 0.455); $y0 = [int]($hh * 0.055)
  }
  $cw = $w - $x0; $ch = $hh - $y0
  if ($isMain) { Write-Host "裁剪：主窗口（跳过左栏）→ ${cw}x${ch}（起点 $x0,$y0）" }
  else { Write-Host "裁剪：独立聊天窗口（整窗）→ ${cw}x${ch}（起点 $x0,$y0）" }
}

if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot "..\logs\bili\qqrec\$(Get-Date -Format 'yyyyMMdd-HHmmss')" }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host "帧输出：$OutDir"

# ── ② 循环截帧 ───────────────────────────────────
$interval = [int](1000 / $Fps)
$total = $Seconds * $Fps
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
  [void][QQRec]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()

  if ($Crop -eq 'chat') {
    $rect = New-Object System.Drawing.Rectangle $x0, $y0, $cw, $ch
    # ⚠️ 变量名别叫 $crop —— 和 -Crop 参数同名（PS 不区分大小写），
    #    赋值会被 [string] 类型约束强制转成字符串，后面 .Save() 直接报 MethodNotFound ✗
    $cropped = $bmp.Clone($rect, $bmp.PixelFormat)
    $bmp.Dispose()
    $cropped.Save((Join-Path $OutDir ("f{0:d5}.jpg" -f $i)), $jpegCodec, $encParams)
    $cropped.Dispose()
  } else {
    $bmp.Save((Join-Path $OutDir ("f{0:d5}.jpg" -f $i)), $jpegCodec, $encParams)
    $bmp.Dispose()
  }
  $n++
}
$sw.Stop()
$realFps = [math]::Round($n * 1000.0 / $sw.ElapsedMilliseconds, 1)
$sz = (Get-ChildItem $OutDir -Filter *.jpg | Measure-Object Length -Sum).Sum
Write-Host "✅ 录完：$n 帧 / $([math]::Round($sw.Elapsed.TotalSeconds,1)) 秒 / 实际 $realFps fps / $([math]::Round($sz/1MB,1)) MB"
Write-Host "FRAMES=$OutDir"
Write-Host "FPS=$Fps"
