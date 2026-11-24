# -*- coding: utf-8 -*-
"""诊断：右键**文件消息卡片**，看菜单里有没有「另存为」。

## 为什么需要
`bot.js` 的 `fetchLogFile()` 有三条路拿文件字节：①段里的 url ②`get_group_file_url` ③`get_file`
—— 客户端方案三条全断（UIA 拿不到 url，也没有那两个接口）⇒ `analyzeLogFile()` 直接返回空，
群友发的 `latest.log` / `错误报告.zip` **她一个字都读不到** ✗

QuitBot 的做法（`_engine/ui/workflows/media.py` 的 `download_message_file`）：
**右键文件气泡 → 菜单「另存为」→ 原生保存对话框 → 写路径 → 确认**。

这个脚本只做第一步诊断：右键 → 把菜单项打出来，**什么都不点**。

    python qq-probe-file-menu.py --hwnd 132512
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


def name_of(c):
    try:
        return (c.Name or "").strip()
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

    nodes = walk(w, 34)

    # 找文件消息容器：**判据在容器 className 上**（`message-container … file-message`）
    # ⚠️ 别再按 `file-name` 的 Name 取文件名 —— 那个 GroupControl 的 Name 是**空的**，
    #    文件名在它的**子节点**里（实测 `export_co` + `nfig.txt` 两段、树里顺序还是反的）。
    target = None
    fname = ""
    for d, c in nodes:
        k = cls_of(c)
        if "message-container" not in k or "file-message" not in k:
            continue
        if "message-container__avatar" in k:
            continue
        parts = []
        for dd, x in walk(c, 16):
            if "file-name" not in cls_of(x):
                continue
            for ddd, y in walk(x, 8):
                t = name_of(y)
                if not t:
                    continue
                try:
                    r = y.BoundingRectangle
                    parts.append((r.left, len(parts), t))
                except Exception:
                    parts.append((10**9, len(parts), t))
            break
        parts.sort()
        fname = "".join(t for _, _, t in parts)
        if fname:
            target = c
            break

    if target is None:
        # 退化：直接找 file-name 的祖先
        for d, c in nodes:
            if "file-name" in cls_of(c):
                nm = name_of(c)
                if nm:
                    fname = nm
                    p = c
                    for _ in range(4):
                        try:
                            p = p.GetParentControl()
                        except Exception:
                            break
                        if p is not None and "message-container" in cls_of(p):
                            target = p
                            break
                if target is not None:
                    break

    if target is None:
        print(json.dumps({"ok": False, "error": "这一屏没有文件消息（先切到有文件的会话）"}, ensure_ascii=False))
        return 1

    try:
        w.SetActive(waitTime=0.2)
        time.sleep(0.3)
    except Exception:
        pass

    try:
        target.RightClick(waitTime=0.5)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "右键失败:" + str(e)[:60], "file": fname}, ensure_ascii=False))
        return 1
    time.sleep(0.9)

    items = []
    for d, x in walk(w, 30):
        if "q-context-menu-item" in cls_of(x):
            n2 = name_of(x)
            if n2 and n2 not in items:
                items.append(n2)

    for _ in range(2):
        try:
            auto.SendKeys("{Esc}", waitTime=0.15)
        except Exception:
            pass

    print(
        json.dumps(
            {
                "ok": True,
                "file": fname,
                "menu_items": items,
                "has_saveas": ("另存为" in items) or ("保存为" in items) or ("下载" in items),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
