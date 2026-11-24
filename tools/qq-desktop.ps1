# 把 QQ 放进独立 Windows 桌面（不在用户桌面上出现）。
#
# 为什么必须走这条：InvokePattern.Invoke 会让元素获得焦点 => QQ 被激活到前台。
# 只要切群/点按钮，用户桌面就会被顶一下。唯一解法是让 QQ 跑在另一个桌面上。
#
# error 87 的教训（上一版挂在这）：
#   CreateDesktopW 的 dwDesiredAccess 必须合法：
#     x 0x01FF / 0x10000000  -> ERROR_INVALID_PARAMETER (87)
#     v 0x000F01FF (DESKTOP_ALL_ACCESS) 或 0x02000000 (MAXIMUM_ALLOWED)
#   pDevmode / lpsa / lpszDevice 传 NULL，dwFlags 传 0。
#
# 打字：SendInput 只进"当前输入桌面"，SetThreadDesktop 改不了这点。
# 所以打字仍要 SwitchDesktop 过去，但那时用户桌面上没有 QQ 窗口，打完切回来。
param(
  [ValidateSet('create','launch','enter','leave','status','probe')]
  [string]$Action = 'status',
  [string]$DesktopName = 'QQBot',
  [string]$Exe = 'C:\Program Files\Tencent\QQNT\QQ.exe',
  [string]$Args = '--force-renderer-accessibility'
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DT3{
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateDesktopW(string name, string device, IntPtr devmode, uint flags, uint access, IntPtr sa);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SwitchDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool GetUserObjectInformationW(IntPtr h, int index, StringBuilder info, int len, out int needed);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  public static string CurrentDesktopName() {
    IntPtr h = GetThreadDesktop(GetCurrentThreadId());
    var sb = new StringBuilder(260); int need;
    if (GetUserObjectInformationW(h, 2, sb, 520, out need)) return sb.ToString();
    return "(unknown)";
  }

  public static string TryCreate(string name, uint access) {
    IntPtr h = CreateDesktopW(name, null, IntPtr.Zero, 0, access, IntPtr.Zero);
    int err = Marshal.GetLastWin32Error();
    if (h != IntPtr.Zero) { CloseDesktop(h); return "ok"; }
    return "err=" + err;
  }

  public static IntPtr OpenAny(string name) {
    uint[] tries = { 0x02000000, 0x000F01FF, 0x000001FF };
    foreach (uint a in tries) {
      IntPtr h = OpenDesktopW(name, 0, false, a);
      if (h != IntPtr.Zero) return h;
    }
    return IntPtr.Zero;
  }

  public static bool Launch(string desktop, string exe, string args, out int pid, out string err) {
    pid = 0; err = "";
    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.lpDesktop = @"WinSta0\" + desktop;
    PROCESS_INFORMATION pi;
    var cmd = new StringBuilder("\"" + exe + "\" " + args);
    bool ok = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
    if (!ok) { err = "CreateProcess err=" + Marshal.GetLastWin32Error(); return false; }
    pid = pi.dwProcessId;
    return true;
  }
}
'@

switch ($Action) {
  'status' { Write-Output ("currentDesktop=" + [DT3]::CurrentDesktopName()) }

  'probe' {
    Write-Output "=== 逐个试 CreateDesktop 的 access 值 ==="
    $cases = @(
      @{ v = 0x02000000; n = 'MAXIMUM_ALLOWED' },
      @{ v = 0x000F01FF; n = 'DESKTOP_ALL_ACCESS' },
      @{ v = 0x000001FF; n = 'DESKTOP_ALL(0x01FF)' },
      @{ v = 0x10000000; n = 'GENERIC_ALL' }
    )
    foreach ($c in $cases) {
      $nm = $DesktopName + '_probe'
      $r = [DT3]::TryCreate($nm, [uint32]$c.v)
      Write-Output ("  " + $c.n.PadRight(24) + " 0x" + ('{0:X8}' -f $c.v) + " -> " + $r)
    }
  }

  'create' {
    $h = [DT3]::OpenAny($DesktopName)
    if ($h -ne [IntPtr]::Zero) {
      Write-Output "exists=true"
      [void][DT3]::CloseDesktop($h)
      break
    }
    $done = $false
    foreach ($a in @(0x02000000, 0x000F01FF, 0x000001FF)) {
      $r = [DT3]::TryCreate($DesktopName, [uint32]$a)
      if ($r -eq 'ok') { Write-Output ("created=true access=0x" + ('{0:X8}' -f $a)); $done = $true; break }
      Write-Output ("  access=0x" + ('{0:X8}' -f $a) + " -> " + $r)
    }
    if (-not $done) { Write-Output "created=false (all access values failed)" }
  }

  'launch' {
    $pid0 = 0; $err = ''
    $ok = [DT3]::Launch($DesktopName, $Exe, $Args, [ref]$pid0, [ref]$err)
    Write-Output ("launch=" + $ok + " pid=" + $pid0 + " " + $err)
  }

  'enter' {
    $h = [DT3]::OpenAny($DesktopName)
    if ($h -eq [IntPtr]::Zero) { Write-Output "openFailed"; break }
    Write-Output ("switched=" + [DT3]::SwitchDesktop($h) + " to=" + $DesktopName)
    [void][DT3]::CloseDesktop($h)
  }

  'leave' {
    $h = [DT3]::OpenAny('Default')
    if ($h -eq [IntPtr]::Zero) { Write-Output "openDefaultFailed"; break }
    Write-Output ("switched=" + [DT3]::SwitchDesktop($h) + " to=Default")
    [void][DT3]::CloseDesktop($h)
  }
}
