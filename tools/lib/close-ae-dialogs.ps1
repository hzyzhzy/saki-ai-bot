# 关掉 AE 的模态对话框（并尽量"点对按钮"）
#
# 为什么要单独一个文件：这段 C# 内联在 JS 模板字符串里要过
#   JS 模板 → PowerShell 字符串 → C# 源码 三层转义，改一次错一次 ✗
#
# 2026-10-22 加的场景（用户截图）：
#   AE 上次崩溃后启动会弹「崩溃修复选项」对话框，按钮是
#   「以安全模式启动 / 重置首选项 / 管理增效工具 / 继续」——
#   以前这里对 #32770 一律发 WM_CLOSE，等于**取消**，AE 起不来 ⇒ 一直"starting" ✗
#   ⇒ 现在先找按钮文字（继续/确定/OK/正常启动…）发 BM_CLICK，点不到才 WM_CLOSE。
#
# 输出：动了几个对话框（整数，一行）

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class AEBox {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  delegate bool EnumProc(IntPtr h, IntPtr l);

  // 想点的按钮（按优先级）
  static readonly string[] WANT = new string[] {
    "继续", "Continue", "正常启动", "确定", "OK", "好", "是", "Yes", "关闭", "Close"
  };

  public static int Handle(uint pid) {
    int acted = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      if (cls.ToString() != "#32770") return true;   // 只要标准对话框

      IntPtr btn = IntPtr.Zero;
      EnumChildWindows(h, (ch, l2) => {
        var t = new StringBuilder(512); GetWindowText(ch, t, 512);
        string s = t.ToString().Trim();
        if (s.Length == 0) return true;
        foreach (string w in WANT) {
          if (s == w) { btn = ch; return false; }
        }
        return true;
      }, IntPtr.Zero);

      if (btn != IntPtr.Zero) {
        PostMessage(btn, 0x00F5, IntPtr.Zero, IntPtr.Zero);  // BM_CLICK
        acted++;
      } else {
        PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);     // WM_CLOSE
        acted++;
      }
      return true;
    }, IntPtr.Zero);
    return acted;
  }
}
'@

$procs = Get-Process -Name AfterFX -ErrorAction SilentlyContinue
if (-not $procs) { 0; exit 0 }
$n = 0
foreach ($pr in $procs) { $n += [AEBox]::Handle([uint32]$pr.Id) }
$n
exit 0
