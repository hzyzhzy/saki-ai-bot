# -*- coding: utf-8 -*-
"""把一条**文件消息**下载到本地，返回路径。

## 怎么做的（2026-11-17 实测通了）
· 右键文件气泡 → 菜单里有「保存」（直接存到默认下载目录，不起对话框）
· 默认下载目录**不是** `%USERPROFILE%\\Downloads` —— 这台机器的用户目录整体重定向到 E 盘，
  注册表里是 `E:\\Downloads`（见 `User Shell Folders` 的 `{374DE290-…}`）
  ⇒ 必须**动态查注册表**，不能写死
· 存完按「文件名 + 最近修改」找回来

## 为什么不用「另存为」
那条会弹原生保存对话框（QuitBot 的 `media.py` 就是走它），多一层对话框就多一堆不稳定因素。
「保存」一步到位，实测 `latest.log`（63 KB）直接出现在 `E:\\Downloads` ✓

    python qq-save-file.py --hwnd 132512 --name latest.log
    → {"ok": true, "path": "E:\\Downloads\\latest.log", "size": 64711}
"""

import ctypes
import glob
import json
import os
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


def download_dir():
    """真实下载目录 —— 优先注册表（这台机器重定向到 E:\\Downloads）"""
    try:
        import winreg

        k = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
        )
        v, _ = winreg.QueryValueEx(k, "{374DE290-123F-4565-9164-39C4925E467B}")
        winreg.CloseKey(k)
        v = os.path.expandvars(str(v))
        if v and os.path.isdir(v):
            return v
    except Exception:
        pass
    for cand in (
        os.path.join(os.path.expanduser("~"), "Downloads"),
        os.path.join(os.path.expanduser("~"), "下载"),
        r"E:\Downloads",
    ):
        if os.path.isdir(cand):
            return cand
    return os.path.expanduser("~")


def scroll_up_once(w, times=3):
    """把消息区往上滚几格（看更早的消息）。⚠️ `auto.WheelUp()` **不接受 times 参数**。"""
    panel = None
    for d, c in walk(w, 30):
        if "message-panel" in cls_of(c):
            panel = c
            break
    if panel is None:
        return False
    try:
        r = panel.BoundingRectangle
        cx = (r.left + r.right) // 2
        cy = (r.top + r.bottom) // 2
        u = ctypes.windll.user32
        u.SetCursorPos(int(cx), int(cy))
        time.sleep(0.08)
        for _ in range(times):
            auto.WheelUp()
        time.sleep(0.35)
        return True
    except Exception:
        return False


def file_cards(w):
    """所有**在视口内**的文件消息卡片（容器 className 含 `message-container` + `file-message`）"""
    out = []
    panel_bottom = 10**9
    for d, c in walk(w, 30):
        if "message-panel" in cls_of(c):
            try:
                panel_bottom = c.BoundingRectangle.bottom
            except Exception:
                pass
            break
    for d, c in walk(w, 34):
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
        if not fname:
            continue
        # ⚠️⚠️ **只收视口内的卡片** —— 滚动之后树里仍然留着视口外的容器，
        #    而它们的 rect 是负坐标/窗口外 ⇒ 右键会点到窗口外边，菜单根本不弹 ✗
        #    （实测：滚 2 屏找到了卡片，但 `menu_seen: []`，就是栽在这里）
        try:
            r = c.BoundingRectangle
            if r.bottom <= 0 or r.top >= panel_bottom or r.right <= 0:
                continue
        except Exception:
            continue
        out.append((fname, c))
    return out


def main():
    hwnd = arg("hwnd")
    want = arg("name", "")
    ddir = download_dir()
    try:
        w = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:80]}, ensure_ascii=False))
        return 1
    if w is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    cards = file_cards(w)
    # ⚠️ 文件消息常常已经滚出视口 ⇒ 最多往上滚 12 屏去找（每屏滚 3 格）
    scrolled = 0
    while not cards and scrolled < 12:
        if not scroll_up_once(w, 3):
            break
        scrolled += 1
        cards = file_cards(w)

    if not cards:
        print(
            json.dumps(
                {"ok": False, "error": "滚了 %d 屏也没有文件消息" % scrolled, "dir": ddir},
                ensure_ascii=False,
            )
        )
        return 1
    print(json.dumps({"scrolled_screens": scrolled}, ensure_ascii=False))

    target = None
    for fname, c in cards:
        if not want or want in fname or fname in want:
            target = (fname, c)
            break
    if target is None:
        target = cards[-1]
    fname, box = target

    # 已经有这个文件且够新 ⇒ 直接用（别重复下载）
    cand = os.path.join(ddir, fname)
    if os.path.isfile(cand) and time.time() - os.path.getmtime(cand) < 3600:
        print(json.dumps({"ok": True, "path": cand, "size": os.path.getsize(cand), "reused": True}, ensure_ascii=False))
        return 0

    t0 = time.time()
    try:
        w.SetActive(waitTime=0.2)
        time.sleep(0.3)
    except Exception:
        pass

    try:
        box.RightClick(waitTime=0.5)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "右键失败:" + str(e)[:60], "file": fname}, ensure_ascii=False))
        return 1

    # ⚠️ 菜单不是每次都立刻出来（实测同类调用偶发拿到空列表）⇒ 最多等 4 秒，
    #    每次重试都**重新右键**（菜单可能已经自己收起来了）。
    item = None
    menu_seen = []
    for attempt in range(4):
        time.sleep(0.9)
        menu_seen = []
        for d, x in walk(w, 30):
            if "q-context-menu-item" in cls_of(x):
                nm2 = name_of(x)
                if nm2:
                    menu_seen.append(nm2)
                    if nm2 == "保存":
                        item = x
                        break
        if item is not None:
            break
        # 没出来 ⇒ 收掉可能的残菜单，再右键一次
        for _ in range(2):
            try:
                auto.SendKeys("{Esc}", waitTime=0.1)
            except Exception:
                pass
        try:
            box.RightClick(waitTime=0.5)
        except Exception:
            pass

    if item is None:
        for _ in range(2):
            try:
                auto.SendKeys("{Esc}", waitTime=0.1)
            except Exception:
                pass
        print(
            json.dumps(
                {"ok": False, "error": "菜单里没有「保存」", "file": fname, "menu_seen": menu_seen[:12]},
                ensure_ascii=False,
            )
        )
        return 1

    try:
        item.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.2)
    except Exception:
        try:
            item.Click(waitTime=0.2)
        except Exception as e:
            print(json.dumps({"ok": False, "error": "点不到保存:" + str(e)[:50]}, ensure_ascii=False))
            return 1

    # 等文件落盘（最多 30 秒）：同名、且修改时间晚于点击时刻
    base = os.path.splitext(fname)[0]
    deadline = time.time() + 30
    while time.time() < deadline:
        time.sleep(0.6)
        # ① 原名
        p = os.path.join(ddir, fname)
        if os.path.isfile(p) and os.path.getmtime(p) >= t0 - 1:
            print(json.dumps({"ok": True, "path": p, "size": os.path.getsize(p), "dir": ddir}, ensure_ascii=False))
            return 0
        # ② QQ 遇到重名会存成 `xxx(1).log`
        for hit in glob.glob(os.path.join(ddir, base + "*" + os.path.splitext(fname)[1])):
            try:
                if os.path.getmtime(hit) >= t0 - 1:
                    print(
                        json.dumps(
                            {"ok": True, "path": hit, "size": os.path.getsize(hit), "dir": ddir, "renamed": True},
                            ensure_ascii=False,
                        )
                    )
                    return 0
            except Exception:
                pass

    print(json.dumps({"ok": False, "error": "30 秒内没等到文件落盘", "file": fname, "dir": ddir}, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    sys.exit(main())
