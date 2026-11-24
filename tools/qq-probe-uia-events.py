# -*- coding: utf-8 -*-
"""验证：**UIA 事件订阅**在 Anode 的座位里到底能不能用。

## 为什么要验
用户问「为什么不是只要消息界面有变化就立刻扫一遍」—— 对，UIA 本来有事件订阅
（`AddStructureChangedEventHandler`），界面一变就回调，根本不用轮询。
但我们现在的架构是「每次跑一个短命 `qq-read.py`，跑完就退出」，
**进程一退订阅就没了** ⇒ 只能用定时轮询（我把它叫"轮"，还加了节流当补丁）。

要改成事件驱动，前提是：**UIA 事件在这个会话里真的能收到**。
有些环境（尤其远程/服务会话）UIA 事件会被静默丢弃 ⇒ 必须先实测，别在错的假设上改架构。

    python qq-probe-uia-events.py --hwnd 198002 --sec 20
    → {"ok": true, "events": 37, "kinds": {...}, "samples": [...]}
"""

import json
import sys
import time

import uiautomation as auto

SEC = 20
HITS = []
KINDS = {}


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


def on_event(sender, event_id=None, *rest):
    """结构变化回调 —— 只记"收到了"，别在里面做重活（UIA 回调里耗时会被丢事件）。"""
    try:
        k = str(event_id)
        KINDS[k] = KINDS.get(k, 0) + 1
        if len(HITS) < 12:
            HITS.append(
                {
                    "event": k,
                    "cls": cls_of(sender)[:48],
                    "name": name_of(sender)[:40],
                    "t": round(time.time(), 2),
                }
            )
    except Exception:
        pass


def main():
    hwnd = arg("hwnd")
    sec = int(arg("sec", str(SEC)) or SEC)
    if not hwnd:
        print(json.dumps({"ok": False, "error": "要 --hwnd"}, ensure_ascii=False))
        return 1

    try:
        win = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        print(json.dumps({"ok": False, "error": "窗口不可用:" + str(e)[:70]}, ensure_ascii=False))
        return 1
    if win is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    registered = 0
    errs = []

    # ① 结构变化事件（新消息、新会话项都会触发）
    try:
        win.AddStructureChangedEventHandler(auto.TreeScope.Subtree, on_event)
        registered += 1
    except Exception as e:
        errs.append("StructureChanged: " + str(e)[:70])

    # ② 属性变化事件（摘要文字变动会触发）
    try:
        win.AddPropertyChangedEventHandler(auto.TreeScope.Subtree, on_event)
        registered += 1
    except Exception as e:
        errs.append("PropertyChanged: " + str(e)[:70])

    if registered == 0:
        print(json.dumps({"ok": False, "error": "一个都订阅不上", "errs": errs}, ensure_ascii=False))
        return 1

    # 订阅之后**主动做点事**触发界面变化：切一次群（切回来）
    # ⚠️ 这里不调外部脚本（那要另起进程），只把自己的窗口拉前台 + 滚一下消息区
    try:
        win.SetActive(waitTime=0.05)
        time.sleep(0.2)
        import ctypes

        u = ctypes.windll.user32
        panel = None
        stack = [(win, 0)]
        while stack:
            c, d = stack.pop()
            if d > 30:
                continue
            if "message-panel" in cls_of(c):
                panel = c
                break
            try:
                for k in c.GetChildren():
                    stack.append((k, d + 1))
            except Exception:
                pass
        if panel is not None:
            r = panel.BoundingRectangle
            u.SetCursorPos(int((r.left + r.right) // 2), int((r.top + r.bottom) // 2))
            time.sleep(0.1)
            auto.WheelUp()
            time.sleep(0.2)
            auto.WheelDown()
    except Exception:
        pass

    # 等事件
    time.sleep(sec)

    # 取消订阅（进程退出也会自动清，这里显式做一次）
    try:
        win.RemoveStructureChangedEventHandler(auto.TreeScope.Subtree, on_event)
    except Exception:
        pass
    try:
        win.RemovePropertyChangedEventHandler(auto.TreeScope.Subtree, on_event)
    except Exception:
        pass

    total = sum(KINDS.values())
    print(
        json.dumps(
            {
                "ok": True,
                "registered": registered,
                "seconds": sec,
                "events": total,
                "kinds": KINDS,
                "samples": HITS,
                "errs": errs,
                "verdict": "✅ UIA 事件可用，可以改成事件驱动" if total > 0 else "❌ 一个事件都没收到，只能继续轮询",
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
