# -*- coding: utf-8 -*-
"""把 QQ 主窗口"唤醒"一下，逼它渲染新消息。

## 为什么需要（2026-11-16 实测踩的坑）
把爱音的消息发到 Saki 在的群里，SnowLuma 返回 `retcode 0`，
但 Saki 的 QQ 界面**二十分钟都没显示那条消息** ——
直到某个动作（切群/滚轮）之后才出现：
    `示例服务器 2026 | Anon：@Saki 自测一下，收到请回`
⇒ QQ 在窗口**不活跃**时会**暂停渲染新消息**，UIA 读的控件树里也就没有它 ✗
   （QuitBot 也遇到同一件事，它的文档里写着 `refresh_detached`：
     "允许主动刷新独立窗口，**可能激活窗口**"。）

## 唤醒手段（从轻到重）
1. `SetActive` —— 把窗口拉到前台（会抢 seat 的焦点，但不碰用户桌面）
2. 消息区**轻微滚一下再滚回来** —— 逼它重绘
3. 点一下标题栏

    python qq-wake.py --hwnd 132512
"""

import json
import sys
import time

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


def walk(c, md=30):
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

    steps = []
    # ① 拉到前台
    try:
        w.SetActive(waitTime=0.2)
        steps.append("SetActive")
    except Exception as e:
        steps.append("SetActive失败:" + str(e)[:30])
    time.sleep(0.35)

    # ② 消息区滚一下再滚回来（逼重绘；滚轮落在消息区中心，不点任何东西）
    try:
        panel = None
        for d, c in walk(w, 30):
            if "message-panel" in cls_of(c):
                panel = c
                break
        if panel is not None:
            r = panel.BoundingRectangle
            cx, cy = (r.left + r.right) // 2, (r.top + r.bottom) // 2
            # ⚠️ `auto.WheelDown()` 不接受 x/y 参数（实测 `WheelDown() got an unexpected
            #    keyword argument 'x'`）—— 要先把指针挪到消息区，再滚。
            import ctypes

            u = ctypes.windll.user32
            u.SetCursorPos(int(cx), int(cy))
            time.sleep(0.12)
            auto.WheelDown(times=1)
            time.sleep(0.25)
            auto.WheelUp(times=1)
            steps.append("滚动重绘")
        else:
            steps.append("没找到 message-panel")
    except Exception as e:
        steps.append("滚动失败:" + str(e)[:30])

    time.sleep(0.3)
    print(json.dumps({"ok": True, "steps": steps}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
