# 把某个窗口抢到前台，并回显抢到之后的真实前台句柄。
# ⚠️ 必须做成独立 .ps1 文件：`powershell -Command "...here-string..."` 这条路径
#    实测不可靠（Add-Type 的 @'...'@ 在 -Command 单行串里经常编译失败，且错误被吞）。
param([Parameter(Mandatory=$true)][long]$Hwnd)

Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class QQF{
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr p);
 [DllImport("kernel32.dll")]public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")]public static extern bool AttachThreadInput(uint a,uint b,bool f);
 [DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")]public static extern IntPtr SetFocus(IntPtr h);
 [DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);
}
'@

$h = [IntPtr]$Hwnd
if ([QQF]::IsIconic($h)) { [void][QQF]::ShowWindow($h, 9) }   # SW_RESTORE

$fg = [QQF]::GetForegroundWindow()
$tf = [QQF]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$tm = [QQF]::GetCurrentThreadId()
[void][QQF]::AttachThreadInput($tm, $tf, $true)
[void][QQF]::BringWindowToTop($h)
[void][QQF]::SetForegroundWindow($h)
[void][QQF]::SetFocus($h)
[void][QQF]::AttachThreadInput($tm, $tf, $false)
Start-Sleep -Milliseconds 150

# 只输出一行：抢到之后的前台句柄
Write-Output ([QQF]::GetForegroundWindow())
