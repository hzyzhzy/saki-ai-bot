# 关掉 AE 的模态对话框（并尽量"点对按钮"）
#
# 为什么要单独一个文件：这段 C# 内联在 JS 模板字符串里要过
#   JS 模板 → PowerShell 字符串 → C# 源码 三层转义，改一次错一次 ✗
#
# 2026-10-22 加的场景（用户截图）：
#   AE 上次崩溃后启动会弹「崩溃修复选项」对话框，按钮是
#   「以安全模式启动 / 重置首选项 / 管理增效工具 / 继续」——
#   以前这里对 #32770 一律发 WM_CLOSE，等于**取消**，AE 起不来 ⇒ 一直"starting" ✗
#
# ⚠️⚠️ 2026-11-08 根治（用户：「经常会有这个弹窗，之前解决了很多遍都不行，必须根治一次」）：
#   那个框是 **Windows TaskDialog**（标题「崩溃修复选项」），按钮是**自绘的**，
#   不是 Button 控件 ⇒ EnumChildWindows 找不到、BM_CLICK 点不到 ✗
#   点不到就退回 WM_CLOSE = 取消 ⇒ AE 永远起不来，一直 starting ✗✗
#   ⇒ 四层兜底，一层比一层硬：
#     ① 标准 Button（有些框是真按钮）→ BM_CLICK
#     ② TaskDialog 专用消息 TDM_CLICK_BUTTON + IDCONTINUE(11)，不行再试 IDOK(1)
#     ③ 提到前台发一次**回车**（TaskDialog 的默认按钮就是「继续」，回车必应）
#     ④ 最后才 WM_CLOSE
#
# 输出：动了几个对话框（整数，一行）

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

public class AEBox {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  delegate bool EnumProc(IntPtr h, IntPtr l);

  static readonly string[] WANT = new string[] {
    // ⚠️⚠️ 2026-11-08：「是否在关闭前保存对 saki_intro.aep 所做的更改？」——
    //   **必须点「不保存」**：点「保存」会再弹一个保存对话框（又卡一层），
    //   点「取消」等于中止关闭 ⇒ AE 不退，脚本收不了尾 ✗
    "不保存", "Don't Save", "不儲存", "否", "No",
    "继续", "Continue", "正常启动", "確定", "确定", "OK", "好", "是", "Yes", "关闭", "Close"
  };

  const uint TDM_CLICK_BUTTON = 0x0400 + 102;
  const int IDOK = 1;
  const int IDNO = 7;        // 「不保存」
  const int IDCONTINUE = 11; // 「继续」（崩溃修复框）

  public static int Handle(uint pid) {
    int acted = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      if (cls.ToString() != "#32770") return true;

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
        PostMessage(btn, 0x00F5, IntPtr.Zero, IntPtr.Zero);
        acted++;
        return true;
      }

      // ② TaskDialog 自绘按钮 ⇒ 走专用消息（不保存 → 继续 → OK，都试一遍）
      int[] ids = new int[] { IDNO, IDCONTINUE, IDOK };
      foreach (int id in ids) {
        SendMessage(h, TDM_CLICK_BUTTON, (IntPtr)id, IntPtr.Zero);
        Thread.Sleep(280);
        if (!IsWindowVisible(h)) { acted++; return true; }
      }

      IntPtr prev = GetForegroundWindow();
      SetForegroundWindow(h);
      Thread.Sleep(120);
      keybd_event(0x0D, 0, 0, UIntPtr.Zero);
      Thread.Sleep(40);
      keybd_event(0x0D, 0, 2, UIntPtr.Zero);
      Thread.Sleep(250);
      if (prev != IntPtr.Zero) SetForegroundWindow(prev);
      if (!IsWindowVisible(h)) { acted++; return true; }

      PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
      acted++;
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
