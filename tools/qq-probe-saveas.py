# -*- coding: utf-8 -*-
"""诊断：点文件卡片的「另存为」，看弹出什么窗口、里面有哪些控件。

## 为什么先诊断
`另存为` 大概率弹一个原生保存对话框（QuitBot 的 `media.py` 就是靠它：
"Save an exact file bubble through its native Save As dialog"）。
但**对话框的控件结构必须实测**才知道：
  · 是不是标准 `#32770`？
  · 文件名输入框是 `Edit` 还是 `ComboBox`？
  · 「保存」按钮叫什么？
猜错就会变成"点了没反应"，白折腾。

这个脚本**只打开对话框、把结构打出来，然后 Esc 关掉**（不写任何文件）。

    python qq-probe-saveas.py --hwnd 132512
"""

import ctypes
import json
import sys
import time
from ctypes import wintypes

import uiautomation as auto


def arg(name, default=""):
    a = sys.argv
    for i, x in enumerate(a):
        if x == "--" + name and i + 1 < len(a):
            return a[i + 1]
    return default


def cls_of(c):
    try:
        return c.ClassName or ""
    except Exception:
        return ""


def name_of(c):
    try:
        return (c.Name or "").strip()
    except Exception:
        return ""


def walk(c, md=26):
    acc = []
    stack = [(c, 0)]
    while stack:
        x, d = stack.pop()
        if d > md:
            continue
        acc.append((d, x))
        try:
            kids = x.GetChildren()
        except Exception:
            kids = []
        for k in kids:
            stack.append((k, d + 1))
    return acc


def all_top_windows():
    """所有顶层窗口（用 Win32 枚举 —— UIA 的 Root 在 seat 里返回空）"""
    u = ctypes.windll.user32
    out = []
    proto = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lp):
        if not u.IsWindowVisible(hwnd):
            return True
        n = u.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        u.GetWindowTextW(hwnd, buf, n + 1)
        cn = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(hwnd, cn, 256)
        p = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        out.append({"hwnd": int(hwnd), "title": buf.value, "cls": cn.value, "pid": int(p.value)})
        return True

    u.EnumWindows(proto(cb), 0)
    return out


def find_file_box(w):
    for d, c in walk(w, 34):
        k = cls_of(c)
        if "message-container" in k and "file-message" in k and "message-container__avatar" not in k:
            return c
    return None


def main():
    hwnd = arg("hwnd")
    try:
        w = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:80]}, ensure_ascii=False))
        return 1
    if w is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    box = find_file_box(w)
    if box is None:
        print(json.dumps({"ok": False, "error": "这一屏没有文件消息"}, ensure_ascii=False))
        return 1

    try:
        w.SetActive(waitTime=0.2)
        time.sleep(0.3)
    except Exception:
        pass

    before = {x["hwnd"] for x in all_top_windows()}

    box.RightClick(waitTime=0.5)
    time.sleep(0.9)

    item = None
    for d, x in walk(w, 30):
        if "q-context-menu-item" in cls_of(x) and name_of(x) == "另存为":
            item = x
            break
    if item is None:
        for _ in range(2):
            try:
                auto.SendKeys("{Esc}", waitTime=0.1)
            except Exception:
                pass
        print(json.dumps({"ok": False, "error": "菜单里没有「另存为」"}, ensure_ascii=False))
        return 1

    try:
        item.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.2)
    except Exception:
        try:
            item.Click(waitTime=0.2)
        except Exception as e:
            print(json.dumps({"ok": False, "error": "点不到另存为:" + str(e)[:50]}, ensure_ascii=False))
            return 1

    # 等对话框出现
    time.sleep(1.6)
    after = [x for x in all_top_windows() if x["hwnd"] not in before]

    detail = []
    for winfo in after:
        ctrls = []
        try:
            cw = auto.ControlFromHandle(winfo["hwnd"])
            if cw is not None:
                for d, c in walk(cw, 12):
                    ctrls.append(
                        {
                            "d": d,
                            "cls": cls_of(c)[:60],
                            "name": name_of(c)[:50],
                            "type": (c.ControlTypeName or "")[:26],
                        }
                    )
        except Exception as e:
            ctrls.append({"error": str(e)[:60]})
        detail.append({"win": winfo, "controls": ctrls[:40]})

    # Esc 关掉对话框（不写文件）
    for _ in range(3):
        try:
            auto.SendKeys("{Esc}", waitTime=0.2)
        except Exception:
            pass

    print(json.dumps({"ok": True, "new_windows": detail}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
