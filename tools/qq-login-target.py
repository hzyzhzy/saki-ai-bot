# 处理「下线通知」弹窗 → 点 Saki → 点登录
import sys
import time

import uiautomation as auto

TARGET = sys.argv[1] if len(sys.argv) > 1 else 'Saki'


def walk(c, d, md, acc):
    if d > md:
        return
    try:
        for x in c.GetChildren():
            acc.append((d, x))
            walk(x, d + 1, md, acc)
    except Exception:
        pass


def all_wins():
    out = []
    for w in auto.GetRootControl().GetChildren():
        try:
            if "Chrome_WidgetWin" not in (w.ClassName or ""):
                continue
            r = w.BoundingRectangle
            ww, hh = r.right - r.left, r.bottom - r.top
            if ww < 200 or hh < 150:
                continue
            out.append((w, ww, hh))
        except Exception:
            pass
    return out


# ── ① 先点掉「下线通知」里的「确定」
dismissed = 0
for w, ww, hh in all_wins():
    acc = []
    walk(w, 0, 30, acc)
    has_notice = any('下线通知' in (c.Name or '') for d, c in acc)
    if not has_notice:
        continue
    print("发现「下线通知」窗口 hwnd=0x%X" % (w.NativeWindowHandle or 0))
    for d, c in acc:
        try:
            if (c.ControlTypeName or "") != "ButtonControl":
                continue
            if (c.Name or "").strip() != "确定":
                continue
            print("  点「确定」")
            try:
                c.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.05)
            except Exception:
                c.Click(simulateMove=True)
            dismissed += 1
            break
        except Exception:
            pass
    if dismissed:
        time.sleep(2)
        break

if dismissed:
    print("✅ 关掉了下线通知")
else:
    print("（没有下线通知，继续）")

# ── ② 找登录弹窗（有「选择账号登录」和「登录」按钮）
dlg = None
for w, ww, hh in all_wins():
    acc = []
    walk(w, 0, 30, acc)
    has_title = any('选择账号登录' in (c.Name or '') for d, c in acc)
    has_btn = any((c.ControlTypeName or '') == 'ButtonControl' and (c.Name or '').strip() == '登录'
                  for d, c in acc)
    if has_title and has_btn:
        dlg = w
        print("登录弹窗 hwnd=0x%X %dx%d" % (w.NativeWindowHandle or 0, ww, hh))
        break

if dlg is None:
    print("❌ 还是没找到登录弹窗")
    for w, ww, hh in all_wins():
        acc = []
        walk(w, 0, 30, acc)
        names = sorted({(c.Name or '').strip() for d, c in acc
                        if (c.ControlTypeName or '') == 'ButtonControl' and (c.Name or '').strip()})
        print("  窗口 0x%X %dx%d 按钮: %s" % (w.NativeWindowHandle or 0, ww, hh, names[:14]))
    sys.exit(3)

# ── ③ 点目标头像
acc = []
walk(dlg, 0, 30, acc)
hit = None
for d, c in acc:
    try:
        if (c.ControlTypeName or "") == "ButtonControl" and (c.Name or "").strip() == TARGET:
            hit = c
            break
    except Exception:
        pass
if hit is None:
    print("❌ 弹窗里没有「%s」账号" % TARGET)
    sys.exit(4)
print("点「%s」头像…" % TARGET)
try:
    hit.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.05)
except Exception:
    hit.Click(simulateMove=True)
time.sleep(2)

# ── ④ 点登录
acc2 = []
walk(dlg, 0, 30, acc2)
btn = None
for d, c in acc2:
    try:
        if (c.ControlTypeName or "") == "ButtonControl" and (c.Name or "").strip() == "登录":
            btn = c
            break
    except Exception:
        pass
if btn is None:
    print("❌ 找不到登录按钮")
    sys.exit(5)
print("点「登录」…")
try:
    btn.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.05)
except Exception:
    btn.Click(simulateMove=True)

# ── ⑤ 验证
print("等登录（最多 120 秒）…")


def nick_of(win):
    a = []
    walk(win, 0, 26, a)
    for d, c in a:
        try:
            if "user-avatar--clip" in (c.ClassName or ""):
                nm = (c.Name or "").strip()
                if nm.endswith("的头像"):
                    return nm[: -len("的头像")]
                if nm:
                    return nm
        except Exception:
            pass
    return ""


for i in range(60):
    time.sleep(2)
    found = []
    for w, ww, hh in all_wins():
        nk = nick_of(w)
        if nk:
            found.append("%s@0x%X(%dx%d)" % (nk, w.NativeWindowHandle or 0, ww, hh))
    if found and i % 3 == 0:
        print("  等 %ds: %s" % ((i + 1) * 2, found))
    if any(s.startswith(TARGET + "@") for s in found):
        print("✅ 登录成功：%s" % [s for s in found if s.startswith(TARGET + "@")])
        sys.exit(0)
print("❌ 没等到 %r 登录，现有: %s" % (TARGET, found))
sys.exit(6)
