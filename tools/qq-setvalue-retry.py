"""重试 LegacyIAccessible.SetValue 写进 ProseMirror 输入框。

上次失败是 ELEMENTNOTAVAILABLE（元素瞬失，QQ 重绘导致），这类错误重试通常能过。
如果 Legacy.SetValue 能成 → 打字完全不需要键盘、不需要前台。
"""

import sys
import time

import uiautomation as auto

auto.SetGlobalSearchTimeout(6.0)
HWND = int(sys.argv[1]) if len(sys.argv) > 1 else 526754
TEXT = sys.argv[2] if len(sys.argv) > 2 else "值写入测试"

win = auto.ControlFromHandle(HWND)


def walk(c, d=0, md=22, acc=None):
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


def editor():
    for d, c in walk(win, 0, 22):
        try:
            if "ExEditor-qq-msg-editor" in (c.ClassName or ""):
                return c
        except Exception:
            continue
    return None


def read_text(ed):
    try:
        tp = ed.GetPattern(auto.PatternId.TextPattern)
        if tp:
            return tp.DocumentRange.GetText(-1) or ""
    except Exception:
        pass
    return None


def transient(e):
    s = str(e)
    return "-2147220992" in s or "80040200" in s or "not available" in s.lower() or "notavailable" in s.lower()


ed = editor()
if ed is None:
    print("❌ 没找到输入框（先切群）")
    sys.exit(1)

print("输入框 cls =", ed.ClassName[:70])
print("写入前文本 =", repr(read_text(ed)))

ok = False
for i in range(8):
    try:
        ed2 = editor()  # 每次重新拿（元素会重建）
        if ed2 is None:
            print(f"  第{i+1}次: 拿不到输入框")
            time.sleep(0.4)
            continue
        legacy = ed2.GetPattern(auto.PatternId.LegacyIAccessiblePattern)
        if not legacy:
            print("  不支持 LegacyIAccessiblePattern")
            break
        legacy.SetValue(TEXT)
        ok = True
        print(f"  ✅ 第{i+1}次 SetValue 成功")
        break
    except Exception as e:
        if transient(e) and i < 7:
            print(f"  第{i+1}次 瞬失，重试…")
            time.sleep(0.35 * (i + 1))
            continue
        print(f"  ❌ 第{i+1}次 失败: {e}")
        break

time.sleep(0.8)
ed3 = editor()
print("写入后文本 =", repr(read_text(ed3)) if ed3 else "(拿不到)")
print("结果:", "✅ 能直接写值（不需要键盘！）" if ok else "❌ 不能直接写值，只能走键盘")
