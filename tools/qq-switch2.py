"""用 LegacyIAccessiblePattern.DoDefaultAction 切群（QuitBot 的兜底路径）。

QuitBot 的 invoke()：
    pattern = control.GetPattern(InvokePattern)
    ...
    legacy = control.GetPattern(LegacyIAccessiblePattern)
    if legacy and legacy.DefaultAction:
        legacy.DoDefaultAction()
        return "LegacyIAccessible.DoDefaultAction"
⇒ QQ 的会话项 InvokePattern 会"成功但不生效"，真正管用的是 Legacy 的 DoDefaultAction。
"""

import sys
import time

import uiautomation as auto

auto.SetGlobalSearchTimeout(6.0)
HWND = int(sys.argv[1]) if len(sys.argv) > 1 else 526754
GROUP = sys.argv[2] if len(sys.argv) > 2 else "示例服务器 2026"

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


def find_info(control, depth=0):
    if depth > 4:
        return None
    try:
        children = control.GetChildren()
    except Exception:
        return None
    for ch in children:
        try:
            cls = ch.ClassName or ""
        except Exception:
            continue
        if "item__info" in cls or "list-item__info" in cls:
            return ch
        got = find_info(ch, depth + 1)
        if got is not None:
            return got
    return None


def name_of(c):
    info = find_info(c)
    if info is None:
        return ""
    texts = []
    try:
        for t in info.GetChildren():
            if (t.ControlTypeName or "") == "TextControl" and (t.Name or "").strip():
                texts.append(t.Name.strip())
    except Exception:
        pass
    return "".join(texts)


nodes = walk(win, 0, 22)
items = []
for d, c in nodes:
    try:
        if "recent-contact-item" in (c.ClassName or ""):
            items.append((name_of(c), c))
    except Exception:
        pass

print(f"会话项 {len(items)} 个")
target = None
for nm, c in items:
    if GROUP in nm:
        target = (nm, c)
        break
if not target:
    print("❌ 没找到 " + GROUP)
    sys.exit(1)

nm, c = target
print(f"目标: {nm}")

# ① 先看它有哪些 Pattern
print("\n=== 该会话项支持的 Pattern ===")
for pname in dir(auto.PatternId):
    if not pname.endswith("Pattern"):
        continue
    try:
        pid = getattr(auto.PatternId, pname)
        pat = c.GetPattern(pid)
        if pat:
            print(f"  ✅ {pname}")
    except Exception:
        pass

# ② LegacyIAccessible.DoDefaultAction
print("\n=== 试 LegacyIAccessible.DoDefaultAction ===")
ok = False
try:
    legacy = c.GetPattern(auto.PatternId.LegacyIAccessiblePattern)
    if legacy:
        try:
            print(f"  DefaultAction = {legacy.DefaultAction!r}")
        except Exception:
            pass
        legacy.DoDefaultAction()
        print("  ✅ DoDefaultAction 调用成功")
        ok = True
    else:
        print("  ❌ 不支持 LegacyIAccessiblePattern")
except Exception as e:
    print(f"  ❌ 失败: {e}")

if not ok:
    # ③ 再兜底：SelectionItemPattern.Select
    print("\n=== 试 SelectionItemPattern.Select ===")
    try:
        sel = c.GetPattern(auto.PatternId.SelectionItemPattern)
        if sel:
            sel.Select()
            print("  ✅ Select 成功")
            ok = True
        else:
            print("  ❌ 不支持 SelectionItemPattern")
    except Exception as e:
        print(f"  ❌ 失败: {e}")

time.sleep(2.5)

# ④ 验证：右侧聊天区有没有出现（找 chat-header 或 ExEditor）
nodes2 = walk(win, 0, 24)
hdr = None
ed = None
for d, cc in nodes2:
    try:
        cls = cc.ClassName or ""
    except Exception:
        continue
    if "chat-header" in cls:
        hdr = (cc.Name or "").strip()
    if "ExEditor" in cls:
        ed = cls
print(f"\n验证：chat-header={hdr!r}  ExEditor={bool(ed)}  总节点={len(nodes2)}")
print("结果:", "✅ 切群成功" if (hdr or ed) else "❌ 还是没切过去")
