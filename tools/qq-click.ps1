# 真实的鼠标点击（mouse_event），不走 UIA —— 用来点 QQ 的消息输入框。
# ⚠️ 为什么必须自己发：worker 的 click 会在坐标处找控件、然后走 a11y 路径，
#    返回 via:"a11y", events:0 —— **一个真实鼠标事件都没发**，输入框拿不到焦点，
#    后面 Ctrl+V 就粘贴到别处去了（实测消息一直发不出去的根因）。
param(
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class QQM{
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] public static extern IntPtr GetCursorPos(out POINT p);
 [StructLayout(LayoutKind.Sequential)] public struct POINT{public int X,Y;}

 public static string Click(int x,int y){
   SetCursorPos(x,y);
   System.Threading.Thread.Sleep(90);
   POINT before; GetCursorPos(out before);
   mouse_event(0x0002,0,0,0,IntPtr.Zero);   // LEFT_DOWN
   System.Threading.Thread.Sleep(45);
   mouse_event(0x0004,0,0,0,IntPtr.Zero);   // LEFT_UP
   System.Threading.Thread.Sleep(90);
   POINT after; GetCursorPos(out after);
   var p = new POINT(); p.X = x; p.Y = y;
   IntPtr w = WindowFromPoint(p);
   return "cursor=" + after.X + "," + after.Y + " cursorBefore=" + before.X + "," + before.Y
        + " topWindow=" + w.ToInt64() + " fg=" + GetForegroundWindow().ToInt64();
 }
}
'@

Write-Output ([QQM]::Click($X, $Y))
