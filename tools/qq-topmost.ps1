# 窗口状态：top（摆进屏内+置顶，**不改尺寸**）/ normal / hide / show / reset（恢复成 1230x1050）
# ⚠️ 实测三条：
#   ① 不置顶 ⇒ 鼠标按"光标下顶窗"分发，点到的是盖在上面的 DSH
#   ② 不摆位 ⇒ 窗口在屏幕外时读树能读、鼠标点不了（坐标越界）
#   ③ **绝不能改尺寸** ⇒ 曾用 MoveWindow(...,820,700) 把窗口强行缩小，
#      结果 QQ 布局重排、消息块一个都认不出来（rawNodes 198 但 blocks=0）✗
param(
  [Parameter(Mandatory=$true)][long]$Hwnd,
  [ValidateSet('top','normal','hide','show','reset')][string]$Mode = 'top'
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class QQZ4{
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int cx,int cy,uint f);
 [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] public static extern int GetWindowRect(IntPtr h,out RECT r);
 [StructLayout(LayoutKind.Sequential)] public struct POINT{public int X,Y;}
 [StructLayout(LayoutKind.Sequential)] public struct RECT{public int L,T,R,B;}
}
'@

$h = [IntPtr]$Hwnd
$SWP_NOSIZE     = 0x0001
$SWP_NOMOVE     = 0x0002
$SWP_NOACTIVATE = 0x0010

$r = New-Object QQZ4+RECT
[void][QQZ4]::GetWindowRect($h, [ref]$r)
$ww = $r.R - $r.L
$hh = $r.B - $r.T

switch ($Mode) {
  'show' {
    if ([QQZ4]::IsIconic($h)) { [void][QQZ4]::ShowWindow($h, 9) }
    [void][QQZ4]::ShowWindow($h, 8)
  }
  'top' {
    if ([QQZ4]::IsIconic($h)) { [void][QQZ4]::ShowWindow($h, 9) }
    if (-not [QQZ4]::IsWindowVisible($h)) { [void][QQZ4]::ShowWindow($h, 8) }
    # 只摆位置（SWP_NOSIZE）—— 尺寸一律不动
    if ($r.L -lt 0 -or $r.T -lt 0 -or ($r.L + $ww) -gt 2500 -or ($r.T + $hh) -gt 1560) {
      [void][QQZ4]::SetWindowPos($h, [IntPtr]::Zero, 80, 60, 0, 0, $SWP_NOSIZE -bor $SWP_NOACTIVATE)
    }
    [void][QQZ4]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE)
  }
  'normal' {
    [void][QQZ4]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE)
  }
  'reset' {
    # 只有这个模式才改尺寸：把窗口恢复成 1230x1050 并摆到左上
    if ([QQZ4]::IsIconic($h)) { [void][QQZ4]::ShowWindow($h, 9) }
    [void][QQZ4]::MoveWindow($h, 80, 60, 1230, 1050, $true)
    [void][QQZ4]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE)
  }
  'hide' {
    [void][QQZ4]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE)
    [void][QQZ4]::ShowWindow($h, 0)
  }
}
Start-Sleep -Milliseconds 220

[void][QQZ4]::GetWindowRect($h, [ref]$r)
$p = New-Object QQZ4+POINT
$p.X = [int](($r.L + $r.R) / 2)
$p.Y = [int](($r.T + $r.B) / 2)
$top = [QQZ4]::WindowFromPoint($p)
$vis = [QQZ4]::IsWindowVisible($h)

Write-Output ("mode=" + $Mode + " visible=" + $vis + " rect=" + $r.L + "," + $r.T + "," + ($r.R-$r.L) + "," + ($r.B-$r.T) + " centerTop=" + $top.ToInt64() + " target=" + $Hwnd)
