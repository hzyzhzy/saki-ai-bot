"""用**真实鼠标点击**发送按钮（最后一条路）。

## 为什么需要
  实测：文字能打进去（说明 SendKeys 通）、发送按钮 `enabled=True`，但
    · `InvokePattern.Invoke` —— 不报错，消息不发（假 Invoke，跟会话项一个毛病）
    · `{Enter}` / `{Ctrl}{Enter}` —— 输入框内容原样不动，也不发
  ⇒ 只剩真实鼠标点击。

## 代价
  会把鼠标移到按钮上并点一下（`mouse_event`），点完不还原鼠标位置的话用户能感觉到。
  这里点完**把鼠标移回原位置**。

用法：
  python tools/qq-click-send.py --hwnd 1902218
"""

import ctypes
import sys
import time

import uiautomation as auto

auto.SetGlobalSearchTimeout(4.0)

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


def arg(name, default=None):
    a = sys.argv
    if "--" + name in a:
        i = a.index("--" + name)
        if i + 1 < len(a):
            return a[i + 1]
    return default


def find_send_button(win):
    def walk(c, d=0, md=28, acc=None):
        if acc is None:
            acc = []
        if d > md:
            return acc
        try:
            ch = c.GetChildren()
        except Exception:
            return acc
        for x in ch:
            acc.append((d, x))
            walk(x, d + 1, md, acc)
        return acc

    for d, c in walk(win, 0, 28):
        try:
            nm = (c.Name or "").strip()
            cl = c.ClassName or ""
            if (c.ControlTypeName or "") == "ButtonControl" and (nm == "发送" or "send-msg" in cl):
                return c
        except Exception:
            continue
    return None


def main():
    hwnd = int(arg("hwnd", "0") or 0)
    if not hwnd:
        print("要 --hwnd")
        return 1
    win = auto.ControlFromHandle(hwnd)
    if win is None:
        print("拿不到窗口")
        return 1

    btn = find_send_button(win)
    if btn is None:
        print("❌ 找不到发送按钮")
        return 2
    try:
        enabled = btn.IsEnabled
    except Exception:
        enabled = None
    r = btn.BoundingRectangle
    cx = (r.left + r.right) // 2
    cy = (r.top + r.bottom) // 2
    print("发送按钮 rect=(%d,%d,%d,%d) 中心=(%d,%d) enabled=%s" % (r.left, r.top, r.right, r.bottom, cx, cy, enabled))
    if enabled is False:
        print("❌ 按钮是 disabled（输入框空？）")
        return 3

    # 记住鼠标原位，点完还原
    pt = ctypes.wintypes.POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
    ox, oy = pt.x, pt.y
    print("原鼠标位置=(%d,%d)" % (ox, oy))

    # 先把窗口拉前台（鼠标点击需要点在可见的窗口上）
    try:
        win.SetActive(waitTime=0.02)
    except Exception:
        pass
    time.sleep(0.3)

    ctypes.windll.user32.SetCursorPos(cx, cy)
    time.sleep(0.12)
    ctypes.windll.user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.06)
    ctypes.windll.user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    print("✅ 已点击")
    time.sleep(0.8)

    # 还原鼠标
    ctypes.windll.user32.SetCursorPos(ox, oy)

    # 验证
    try:
        def walk(c, d=0, md=26, acc=None):
            if acc is None:
                acc = []
            if d > md:
                return acc
            try:
                ch = c.GetChildren()
            except Exception:
                return acc
            for x in ch:
                acc.append((d, x))
                walk(x, d + 1, md, acc)
            return acc

        for d, c in walk(win, 0, 26):
            if "ExEditor" in (c.ClassName or ""):
                tp = c.GetPattern(auto.PatternId.TextPattern)
                t = (tp.DocumentRange.GetText(-1) or "").strip() if tp else ""
                print("点击后输入框: %r" % t[:40])
                print("结果:", "✅ 已清空（发出去了）" if t == "" else "⚠️ 还有内容（可能没发）")
                return 0 if t == "" else 4
    except Exception as e:
        print("验证失败:", e)
    return 0


if __name__ == "__main__":
    import ctypes.wintypes  # noqa: E402

    sys.exit(main())
