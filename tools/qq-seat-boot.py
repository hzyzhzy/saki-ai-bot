# -*- coding: utf-8 -*-
"""在**座位里**把 QQ 准备到"可读可发"的状态，然后输出它的 hwnd。

做四件事，每件都幂等（已经在跑就跳过）：
  ① 找已经登录的 QQ 窗口 —— 按**昵称**认人（多号共存时必须区分，不能只看"宽>400"）
  ② 没有就启动 QQ
  ③ 出现「选择账号登录」弹窗 → 点目标账号头像 → 点「登录」
  ④ 等登录完成（窗口里能读到自己的昵称），输出 hwnd + 昵称

## 为什么要按昵称认窗口（2026-11-21 实测）
座位里可能同时登录好几个号（Anon 的窗口 1230x720、Saki 的 953x584），
而 `Chrome_WidgetWin_1` + `Name='QQ'` 两个都满足 ⇒ 只按"第一个匹配"会**读到别人的号** ✗
能区分的只有窗口左上角那个 `user-profile-card__nickname` 的文字 ✓

## 输出（最后一行，给 PowerShell 抓）
    SEAT_OK {"hwnd": 3998294, "nick": "Saki"}
    SEAT_NEED_LOGIN {"reason": "..."}      ← 需要人工扫码/处理
    SEAT_FAIL {"reason": "..."}
"""

import json
import sys
import time

import uiautomation as auto

TARGET_NICK = "Saki"          # 要准备的那个号的昵称
QQ_EXE = r"C:\Program Files\Tencent\QQNT\QQ.exe"


def out(tag, **kw):
    print("%s %s" % (tag, json.dumps(kw, ensure_ascii=False)), flush=True)


def walk(c, d, md, acc):
    if d > md:
        return
    try:
        for x in c.GetChildren():
            acc.append((d, x))
            walk(x, d + 1, md, acc)
    except Exception:
        pass


def qq_windows():
    """所有像"QQ 主界面/登录窗"的顶层窗口。"""
    out_ = []
    try:
        for w in auto.GetRootControl().GetChildren():
            try:
                if "Chrome_WidgetWin" not in (w.ClassName or ""):
                    continue
                r = w.BoundingRectangle
                ww, hh = r.right - r.left, r.bottom - r.top
                if ww < 300 or hh < 200:
                    continue
                out_.append((w, ww, hh))
            except Exception:
                continue
    except Exception:
        pass
    return out_


def nick_of(win, tries=1):
    """窗口左上角那个"当前登录账号"的昵称（登录弹窗返回空）。

    ⚠️⚠️ 2026-11-21 实测更正：`user-profile-card__nickname` 的 **Name 是空的**
    （昵称在它的子 TextControl 里，但深度/时机不稳，实测两个窗口都读成空串）✗
    **可靠的是头像那个元素的 Name**：
        `avatar user-avatar user-avatar--clip` → Name = "Saki的头像" / "Anon的头像" ✓
    ⇒ 「XXX的头像」去掉后缀就是昵称；读不到再退回 profile-nickname 的子节点。

    ⚠️⚠️ `tries`（2026-11-21 加）：**刚启动/刚登录那几秒 UIA 树还没就绪**，
    一次读会返回空 ⇒ 上层误判成"没登录"（实测：`现有窗口：Saki@0x60674` 明明读到了，
    但第 ① 步读空 ⇒ 输出 SEAT_NEED_LOGIN）✗ ⇒ 给几次重试 ✓
    """
    for _try in range(max(1, tries)):
        acc = []
        walk(win, 0, 26, acc)
        # ① 头像名（最可靠）
        for d, c in acc:
            try:
                if "user-avatar--clip" not in (c.ClassName or ""):
                    continue
                nm = (c.Name or "").strip()
                if not nm:
                    continue
                if nm.endswith("的头像"):
                    return nm[: -len("的头像")]
                return nm
            except Exception:
                continue
        # ② 退路：profile-nickname 的子 TextControl
        for d, c in acc:
            try:
                if "user-profile-card__nickname" not in (c.ClassName or ""):
                    continue
                for t in c.GetChildren():
                    nm = (t.Name or "").strip()
                    if nm:
                        return nm
            except Exception:
                continue
        if _try < tries - 1:
            time.sleep(0.6)
    return ""


def has_login_dialog(win):
    """这个窗口是不是「选择账号登录」弹窗（有「登录」按钮）。"""
    acc = []
    walk(win, 0, 28, acc)
    has_login_btn = False
    has_title = False
    for d, c in acc:
        try:
            nm = (c.Name or "").strip()
            if (c.ControlTypeName or "") == "ButtonControl" and nm == "登录":
                has_login_btn = True
            if "选择账号登录" in nm:
                has_title = True
        except Exception:
            pass
    return has_login_btn and has_title


def read_has_chat(win):
    """这个窗口能不能读到聊天区（header + 输入框）。"""
    acc = []
    walk(win, 0, 26, acc)
    hdr = any("chat-header" in (c.ClassName or "") for d, c in acc)
    ed = any("ExEditor-qq-msg-editor" in (c.ClassName or "") for d, c in acc)
    return hdr, ed


def click_button(win, name):
    acc = []
    walk(win, 0, 28, acc)
    for d, c in acc:
        try:
            if (c.ControlTypeName or "") != "ButtonControl":
                continue
            if (c.Name or "").strip() != name:
                continue
            try:
                c.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.05)
            except Exception:
                c.Click(simulateMove=False)
            return True
        except Exception:
            continue
    return False


def main():
    nick_want = sys.argv[1] if len(sys.argv) > 1 else TARGET_NICK
    print("目标账号: %r" % nick_want, flush=True)

    # ---------- ① 已有登录好的目标账号？ ----------
    for w, ww, hh in qq_windows():
        nk = nick_of(w, 3)
        if nk:
            print("  发现已登录窗口 hwnd=0x%X %dx%d 昵称=%r" % (w.NativeWindowHandle or 0, ww, hh, nk), flush=True)
        if nk == nick_want:
            hdr, ed = read_has_chat(w)
            print("  ✓ 就是它（header=%s editor=%s）" % (hdr, ed), flush=True)
            out("SEAT_OK", hwnd=int(w.NativeWindowHandle or 0), nick=nk)
            return 0

    # ---------- ② 有没有登录弹窗 ----------
    dlg = None
    for w, ww, hh in qq_windows():
        if has_login_dialog(w):
            dlg = w
            print("  发现登录弹窗 hwnd=0x%X %dx%d" % (w.NativeWindowHandle or 0, ww, hh), flush=True)
            break

    # ---------- ③ 没有 QQ 的话先启动它 ----------
    if not qq_windows():
        print("  QQ 没在跑，启动它…", flush=True)
        try:
            import subprocess
            subprocess.Popen([QQ_EXE], creationflags=0x00000008 | 0x00000200, close_fds=True)
        except Exception as e:
            out("SEAT_FAIL", reason="启动 QQ 失败: %s" % str(e)[:80])
            return 1
        # 等窗口出现（最多 60 秒）
        for i in range(60):
            time.sleep(1)
            ws = qq_windows()
            if ws:
                print("  QQ 窗口出现（等了 %d 秒）" % (i + 1), flush=True)
                break
        else:
            out("SEAT_FAIL", reason="60 秒没等到 QQ 窗口")
            return 1
        # 重新找登录弹窗
        for w, ww, hh in qq_windows():
            if has_login_dialog(w):
                dlg = w
                break

    # ---------- ④ 点登录 ----------
    if dlg is not None:
        print("  点「%s」头像…" % nick_want, flush=True)
        if not click_button(dlg, nick_want):
            print("  ⚠️ 弹窗里没找到「%s」头像按钮（可能列表里没有这个号）" % nick_want, flush=True)
        time.sleep(1.5)
        print("  点「登录」…", flush=True)
        if not click_button(dlg, "登录"):
            out("SEAT_FAIL", reason="登录弹窗里找不到「登录」按钮")
            return 1
        # 等登录完成（最多 90 秒）
        for i in range(90):
            time.sleep(1)
            for w, ww, hh in qq_windows():
                nk = nick_of(w)
                if nk == nick_want:
                    hdr, ed = read_has_chat(w)
                    print("  ✓ 登录完成（等了 %d 秒）hwnd=0x%X header=%s editor=%s"
                          % (i + 1, w.NativeWindowHandle or 0, hdr, ed), flush=True)
                    out("SEAT_OK", hwnd=int(w.NativeWindowHandle or 0), nick=nk)
                    return 0
        out("SEAT_NEED_LOGIN", reason="点了登录但 90 秒内没检测到 %r 登录成功（可能要扫码/验证）" % nick_want)
        return 2

    # ---------- ⑤ 没有弹窗也没有目标号 ----------
    names = []
    for w, ww, hh in qq_windows():
        nk = nick_of(w) or "（读不到昵称）"
        names.append("%s@0x%X" % (nk, w.NativeWindowHandle or 0))
    out("SEAT_NEED_LOGIN", reason="没有 %r 的登录态，也没找到登录弹窗；现有窗口：%s"
        % (nick_want, ", ".join(names) or "无"))
    return 2


if __name__ == "__main__":
    sys.exit(main())
