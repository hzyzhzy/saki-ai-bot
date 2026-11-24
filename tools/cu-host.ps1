<#
  ⚠️ 2026-11-14：**一次性的"电脑操作"执行器** —— 由 explorer 起（用户桌面会话、前台），干完就退。

  ## 为什么要它
    QQ 是 Electron，`SendInput` 的键鼠只作用于**前台窗口**；而 Windows 规定
    **只有前台进程才能 SetForegroundWindow**。我从 DSH 的子进程里发起 ⇒ 天生不是前台 ⇒
    抢不到 ⇒ 键鼠全打到 DSH 窗口上（实测 worker 自己报 `foreground: 2034042`）。
    ⇒ 需要一个**由 explorer 启动**的进程（它是用户会话里的前台进程），由它来抢前台 + 发键鼠。

  ## 生命周期（用户要求：需要时自动启动，发完自动关闭）
    · 不带 `-Watch` ⇒ **跑完这一次就退出**（默认，推荐）
    · 带 `-Watch` ⇒ 常驻轮询任务文件（调试用，正常不用）

  ## 任务 / 结果（都用文件交换，别走 stdout —— explorer 起的进程拿不到输出）
    任务：C:\Temp\cu-host\task.json
      {
        "hwnd": 21238224,
        "show": true,            // 先显示窗口（默认 true）
        "hideAfter": true,       // 干完藏回去（默认 true）
        "ops": [
          { "type": "click", "x": 325, "y": 491 },
          { "type": "clickref" },                        // 预留
          { "type": "paste", "text": "要发的话" },        // 中文走剪贴板最稳
          { "type": "key", "keys": "ctrl+v" },
          { "type": "key", "keys": "enter" },
          { "type": "sleep", "ms": 500 }
        ]
      }
    结果：C:\Temp\cu-host\result.json
      { "ok": true, "steps": [...], "at": 时间戳 }

  ## 用法
    explorer.exe "执行电脑操作.bat"
#>
param(
  [string]$Task  = 'C:\Temp\cu-host\task.json',
  [string]$Out   = 'C:\Temp\cu-host\result.json',
  [switch]$Watch
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CH {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@

function Log-Step($list, [string]$m) {
  $list.Add(("{0} {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $m)) | Out-Null
}

# 抢前台（AttachThreadInput 绕开"只有前台进程能设前台"的限制）
function Force-Foreground([IntPtr]$h) {
  for ($i = 0; $i -lt 4; $i++) {
    [void][CH]::ShowWindow($h, 9)
    [void][CH]::BringWindowToTop($h)
    $fg = [CH]::GetForegroundWindow()
    if ($fg -eq $h) { return $true }
    $tidFg = [CH]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    $tidMe = [CH]::GetCurrentThreadId()
    $attached = $false
    if ($tidFg -ne $tidMe) { $attached = [CH]::AttachThreadInput($tidMe, $tidFg, $true) }
    [void][CH]::SetForegroundWindow($h)
    if ($attached) { [void][CH]::AttachThreadInput($tidMe, $tidFg, $false) }
    Start-Sleep -Milliseconds 250
    if ([CH]::GetForegroundWindow() -eq $h) { return $true }
  }
  return ([CH]::GetForegroundWindow() -eq $h)
}

function Do-Click([int]$x, [int]$y) {
  [void][CH]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 60
  [CH]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
  Start-Sleep -Milliseconds 40
  [CH]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
}

# 中文用剪贴板（SendInput 只能打 ASCII）
function Do-Paste([string]$text) {
  Set-Clipboard -Value $text
  Start-Sleep -Milliseconds 120
  [CH]::keybd_event(0x11, 0, 0, [IntPtr]::Zero)       # Ctrl down
  [CH]::keybd_event(0x56, 0, 0, [IntPtr]::Zero)       # V down
  Start-Sleep -Milliseconds 40
  [CH]::keybd_event(0x56, 0, 2, [IntPtr]::Zero)       # V up
  [CH]::keybd_event(0x11, 0, 2, [IntPtr]::Zero)       # Ctrl up
}

function Do-Key([string]$chord) {
  $map = @{ 'enter' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B; 'space' = 0x20; 'f' = 0x46; 'v' = 0x56; 'a' = 0x41; 'backspace' = 0x08 }
  $parts = $chord.ToLower() -split '\+'
  $mods = @()
  $key = $parts[-1]
  foreach ($p in $parts[0..($parts.Count - 2)]) {
    if ($p -eq 'ctrl') { $mods += 0x11 }
    elseif ($p -eq 'shift') { $mods += 0x10 }
    elseif ($p -eq 'alt') { $mods += 0x12 }
  }
  $vk = if ($map.ContainsKey($key)) { $map[$key] } else { [int][char]$key.ToUpper() }
  foreach ($m in $mods) { [CH]::keybd_event([byte]$m, 0, 0, [IntPtr]::Zero) }
  [CH]::keybd_event([byte]$vk, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [CH]::keybd_event([byte]$vk, 0, 2, [IntPtr]::Zero)
  foreach ($m in $mods) { [CH]::keybd_event([byte]$m, 0, 2, [IntPtr]::Zero) }
}

function Run-Task {
  $steps = New-Object System.Collections.ArrayList
  $res = [ordered]@{ ok = $false; steps = $steps; at = (Get-Date).ToString('o') }
  try {
    if (-not (Test-Path $Task)) { throw "没有任务文件：$Task" }
    $t = Get-Content $Task -Raw -Encoding UTF8 | ConvertFrom-Json
    $h = [IntPtr]([int64]$t.hwnd)
    if ($h -eq [IntPtr]::Zero) { throw '任务里没有 hwnd' }

    if ($t.show -ne $false) { Log-Step $steps "show $($t.hwnd)" | Out-Null; [void][CH]::ShowWindow($h, 9) }
    $ok = Force-Foreground $h
    Log-Step $steps ("force-foreground=" + $(if ($ok) { 'ok' } else { 'FAILED' })) | Out-Null
    if (-not $ok) { throw '抢不到前台（可能有别的窗口是前台进程，或 QQ 拒绝）' }
    Start-Sleep -Milliseconds 250

    foreach ($op in $t.ops) {
      switch ($op.type) {
        'click' { Do-Click ([int]$op.x) ([int]$op.y); Log-Step $steps "click $($op.x),$($op.y)" | Out-Null }
        'paste' { Do-Paste ([string]$op.text); Log-Step $steps ("paste " + ([string]$op.text).Length + ' 字') | Out-Null }
        'key'   { Do-Key ([string]$op.keys); Log-Step $steps "key $($op.keys)" | Out-Null }
        'sleep' { Start-Sleep -Milliseconds ([int]$op.ms); Log-Step $steps "sleep $($op.ms)ms" | Out-Null }
        default { Log-Step $steps "skip 未知 op: $($op.type)" | Out-Null }
      }
      Start-Sleep -Milliseconds 80
    }

    if ($t.hideAfter -ne $false) {
      [void][CH]::ShowWindow($h, 0)
      Log-Step $steps 'hide（藏回托盘）' | Out-Null
    }
    $res.ok = $true
  } catch {
    $res.ok = $false
    $res.error = $_.Exception.Message
    Log-Step $steps ("ERROR " + $_.Exception.Message) | Out-Null
  }
  $res.at = (Get-Date).ToString('o')
  $dir = Split-Path $Out -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  ($res | ConvertTo-Json -Depth 6) | Set-Content -Path $Out -Encoding UTF8
  # ⚠️ 用完就把任务删掉：下次必须"有任务才起"，不会误重跑
  if (Test-Path $Task) { Remove-Item $Task -Force -ErrorAction SilentlyContinue }
}

Run-Task
if ($Watch) {
  while ($true) {
    Start-Sleep -Milliseconds 700
    if (Test-Path $Task) { Run-Task }
  }
}
# ⚠️ 默认**不 Watch** ⇒ 跑完这一次就退出（用户要求：发完自动关闭）
