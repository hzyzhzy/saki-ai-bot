# 录 QQ 聊天窗口（9:16）—— 找窗口 → 调成 9:16 → 置前 → ffmpeg 录 → 还原窗口
# ⚠️ 参数全部走环境变量（这个项目路径有空格+中文，绝不拼命令行）
param(
  [int]$QqPid = 8000,
  [string]$Out = "",
  [int]$Seconds = 3,
  # ⚠️ 2026-10-20 用户要求：「**只能录几个 1 号群的聊天记录**」
  #    ⇒ 必须**按群名指定**要录哪个群，不许逮着一个窗口就录（私聊 / 别的群都不该进视频）
  [string]$GroupName = "",
  [switch]$ListWindows
)
$ErrorActionPreference = 'Stop'

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class Rec {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static List<IntPtr> ByPid(uint want) {
    var o = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == want && IsWindowVisible(h) && GetWindowTextLength(h) > 0) o.Add(h);
      return true;
    }, IntPtr.Zero);
    return o;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(300); GetWindowText(h, sb, 300); return sb.ToString(); }
  public static string Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return r.L + " " + r.T + " " + (r.R-r.L) + " " + (r.B-r.T); }
  // 最小化→还原→(Alt 欺骗)→置前：Windows 不让后台进程抢前台，这几步是关键
  public static bool Force(IntPtr h) {
    ShowWindow(h, 6); System.Threading.Thread.Sleep(120);
    ShowWindow(h, 9); System.Threading.Thread.Sleep(200);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    System.Threading.Thread.Sleep(350);
    return ok || GetForegroundWindow() == h;
  }
  public static void Place(IntPtr h, int x, int y, int w, int hh) {
    // SWP_NOZORDER=0x4 SWP_SHOWWINDOW=0x40
    SetWindowPos(h, IntPtr.Zero, x, y, w, hh, 0x44);
  }
}
'@
Add-Type -TypeDefinition $sig

$wins = [Rec]::ByPid($QqPid)
if ($wins.Count -eq 0) { "❌ 没找到 PID=$QqPid 的可见窗口（QQ 没开 / 窗口被最小化了）"; exit 1 }

# ⚠️ 先把**所有**候选窗口列出来 —— 用户要求「只能录几个 1 号群的聊天记录」，
#    所以**不给 -GroupName 就只列不录**，防止把私聊或别的群录进视频 ✗
$cands = @()
foreach ($w in $wins) { $cands += [PSCustomObject]@{ H = $w; Title = [Rec]::Title($w); Rect = [Rec]::Rect($w) } }

if ($ListWindows -or -not $GroupName) {
  "QQ 的可见窗口（$($cands.Count) 个）："
  foreach ($c in $cands) { "  「$($c.Title)」  @$($c.Rect)" }
  if (-not $GroupName) {
    "`n⚠️ 没给 -GroupName ⇒ 只列出来，**不录**（免得把私聊/别的群录进视频）"
    "   用法: -GroupName `"群名`""
    exit 0
  }
}

$target = $cands | Where-Object { $_.Title -like "*$GroupName*" } | Select-Object -First 1
if (-not $target) {
  "❌ 没有标题含「$GroupName」的窗口。上面是现有的（把那个群在 QQ 里点开再跑）"
  exit 1
}

$h = $target.H
$title = $target.Title
$orig = [Rec]::Rect($h)
"窗口: $title"
"原矩形: $orig"

# ── 调成 9:16（608x1080，屏幕满高）并挪到左上 ──
[Rec]::Place($h, 0, 0, 608, 1080)
Start-Sleep -Milliseconds 600
"调成 9:16 后: " + [Rec]::Rect($h)

# ── 置前 ──
$ok = [Rec]::Force($h)
"置前: $ok"
Start-Sleep -Milliseconds 700

$r = ([Rec]::Rect($h)) -split ' '
"实际录制区域: x=$($r[0]) y=$($r[1]) w=$($r[2]) h=$($r[3])"

$ff = '<本机用户目录>\AppData\Roaming\bilibili\ffmpeg\ffmpeg.exe'
if (-not $Out) { $Out = Join-Path (Get-Location) 'logs\bili\__rec916.mp4' }
New-Item -ItemType Directory -Force -Path (Split-Path $Out -Parent) | Out-Null

# ⚠️ ffmpeg 往 stderr 写的东西会被 `$ErrorActionPreference='Stop'` 当成异常抛出来
#    （报错全文都是 "ffmpeg version 3.0.1 ..." 这种正常日志）⇒ 这一段临时放开
$old = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & $ff -y -f gdigrab -framerate 30 -offset_x $r[0] -offset_y $r[1] -video_size "$($r[2])x$($r[3])" `
       -i desktop -t $Seconds -c:v libx264 -preset ultrafast -pix_fmt yuv420p $Out 2>&1 | Select-Object -Last 1
} finally {
  # ── 还原窗口大小/位置（**无论如何都要还原**，别把用户的窗口留在左上角）──
  $o = $orig -split ' '
  [Rec]::Place($h, [int]$o[0], [int]$o[1], [int]$o[2], [int]$o[3])
  "已还原窗口: " + [Rec]::Rect($h)
  $ErrorActionPreference = $old
}

if (Test-Path $Out) { "✅ 录到: $Out  ($([math]::Round((Get-Item $Out).Length/1KB,0)) KB)" } else { "❌ 录制失败"; exit 1 }
