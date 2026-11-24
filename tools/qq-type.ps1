# 逐字发 Unicode 键盘事件，并且**自己抢前台 + 输完立刻还回去**。
#
# ## 为什么不用剪贴板 paste
#   ① paste 会覆盖用户的剪贴板（用户正在用电脑时很难受）
#   ② paste 失败时不知道粘到哪儿去了
#   ③ 逐字可以**每字校验前台**，一丢焦点立刻停，绝不把内容打到别的窗口
#
# ## 为什么必须抢前台（这是 Windows 的硬限制）
#   SendInput 的键盘事件只进**前台窗口**。UI Automation 的 SetFocus 只改 UIA 焦点，
#   不改 Win32 前台 —— 所以最后这一步躲不掉。
#   能做的只是把它压到最短：**记录原前台 → 抢 → 打 → 立刻还回去**。
#   ⇒ 读消息 / 切群 / 点按钮**都不需要这一步**，只有"把字打进去"需要。
param(
  [Parameter(Mandatory=$true)][string]$Text,
  [Parameter(Mandatory=$true)][long]$Hwnd,
  [switch]$NoRestore
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class QQT{
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }

  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);

  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_UNICODE = 0x0004;
  const uint KEYEVENTF_KEYUP = 0x0002;

  public static bool SendChar(char ch) {
    INPUT[] a = new INPUT[2];
    a[0].type = INPUT_KEYBOARD;
    a[0].ki.wScan = (ushort)ch;
    a[0].ki.dwFlags = KEYEVENTF_UNICODE;
    a[1] = a[0];
    a[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    return SendInput(2, a, Marshal.SizeOf(typeof(INPUT))) == 2;
  }

  /// Shift+Enter（QQ 里换行不发送）
  public static bool ShiftEnter() {
    INPUT[] a = new INPUT[4];
    for (int i = 0; i < 4; i++) a[i].type = INPUT_KEYBOARD;
    a[0].ki.wVk = 0x10; a[0].ki.dwFlags = 0;
    a[1].ki.wVk = 0x0D; a[1].ki.dwFlags = 0;
    a[2].ki.wVk = 0x0D; a[2].ki.dwFlags = KEYEVENTF_KEYUP;
    a[3].ki.wVk = 0x10; a[3].ki.dwFlags = KEYEVENTF_KEYUP;
    return SendInput(4, a, Marshal.SizeOf(typeof(INPUT))) == 4;
  }

  /// 抢前台：AttachThreadInput 绕过 SetForegroundWindow 的限制
  public static IntPtr Grab(IntPtr target) {
    if (IsIconic(target)) ShowWindow(target, 9);
    IntPtr fg = GetForegroundWindow();
    if (fg == target) return fg;
    uint tf = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint tm = GetCurrentThreadId();
    AttachThreadInput(tm, tf, true);
    BringWindowToTop(target);
    SetForegroundWindow(target);
    AttachThreadInput(tm, tf, false);
    return fg;
  }
}
'@

$target = [IntPtr]$Hwnd
$original = [QQT]::Grab($target)
Start-Sleep -Milliseconds 180
if ([QQT]::GetForegroundWindow() -ne $target) {
  Write-Output "CANNOT_FOREGROUND original=$($original.ToInt64())"
  exit 5
}

$lines = $Text -split "`n"
$sent = 0
try {
  for ($li = 0; $li -lt $lines.Length; $li++) {
    if ($li -gt 0) {
      if (-not [QQT]::ShiftEnter()) { Write-Output "FAIL shift-enter@$li"; exit 2 }
      Start-Sleep -Milliseconds 25
    }
    foreach ($ch in $lines[$li].ToCharArray()) {
      if ([QQT]::GetForegroundWindow() -ne $target) {
        Write-Output "LOST_FOCUS at char $sent"
        exit 3
      }
      if (-not [QQT]::SendChar($ch)) { Write-Output "FAIL char@$sent"; exit 4 }
      $sent++
      Start-Sleep -Milliseconds 10
    }
  }
} finally {
  # 输完立刻把前台还给原来的窗口（用户不会察觉，只看到任务栏闪一下）
  if (-not $NoRestore -and $original -ne [IntPtr]::Zero -and $original -ne $target) {
    [void][QQT]::SetForegroundWindow($original)
  }
}

Write-Output ("typed=" + $sent + " lines=" + $lines.Length + " restored=" + (-not $NoRestore))
