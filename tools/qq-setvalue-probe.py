"""测 QQ 的消息输入框到底能不能"直接写值"（不需要键盘、不需要前台、不需要切桌面）。

如果 ValuePattern 或 LegacyIAccessiblePattern.SetValue 能写进去 —— 那打字这一步
就彻底不用碰用户的桌面了。
QuitBot 只对搜索框用过 SetValue（那是标准 Edit 控件），消息框是 contenteditable
（UIA 里是 GroupControl），大概率不支持 —— 但值得实测一次。
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


nodes = walk(win, 0, 22)
ed = None
for d, c in nodes:
    try:
        if "ExEditor-qq-msg-editor" in (c.ClassName or ""):
            ed = (d, c)
            break
    except Exception:
        pass

if ed is None:
    print("❌ 没找到输入框（先切到一个会话）")
    sys.exit(1)

d, editor = ed
print(f"输入框 depth={d} cls={editor.ClassName} name={(editor.Name or '')[:30]!r}")

# 1) 有哪些 Pattern
print("\n=== 支持的 Pattern ===")
for name in dir(auto.PatternId):
    if not name.endswith("Pattern"):
        continue
    try:
        pid = getattr(auto.PatternId, name)
        pat = editor.GetPattern(pid)
        if pat:
            print(f"  ✅ {name}")
    except Exception:
        pass

# 2) 试 ValuePattern.SetValue
print("\n=== 试 ValuePattern.SetValue ===")
try:
    pat = editor.GetPattern(auto.PatternId.ValuePattern)
    if pat:
        old = ""
        try:
            old = pat.Value
            print(f"  当前值: {old!r}")
        except Exception:
            pass
        pat.SetValue(TEXT, waitTime=0.8)
        time.sleep(0.5)
        try:
            print(f"  写入后值: {pat.Value!r}")
        except Exception:
            pass
        print("  ✅ SetValue 调用成功")
    else:
        print("  ❌ 不支持 ValuePattern")
except Exception as e:
    print(f"  ❌ ValuePattern 失败: {e}")

# 3) 试 LegacyIAccessible
print("\n=== 试 LegacyIAccessiblePattern.SetValue ===")
try:
    pat2 = editor.GetPattern(auto.PatternId.LegacyIAccessiblePattern)
    if pat2:
        pat2.SetValue(TEXT)
        time.sleep(0.4)
        print("  ✅ Legacy SetValue 调用成功")
    else:
        print("  ❌ 不支持 LegacyIAccessiblePattern")
except Exception as e:
    print(f"  ❌ Legacy 失败: {e}")

# 4) 看输入框里现在有什么（读文本）
print("\n=== 输入框当前内容（TextPattern）===")
try:
    tp = editor.GetPattern(auto.PatternId.TextPattern)
    if tp:
        print("  文本:", repr((tp.DocumentRange.GetText(-1) or "")[:80]))
    else:
        print("  不支持 TextPattern")
except Exception as e:
    print(f"  TextPattern 失败: {e}")
