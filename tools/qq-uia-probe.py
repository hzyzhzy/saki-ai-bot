"""用 uiautomation（QuitBot 那条通道）读 QQ 窗口，看能不能拿到完整 a11y 树。

⚠️ 为什么单独试这个：我们一直用 PowerShell + .NET System.Windows.Automation，
   只能读到 22 个节点；而 QuitBot 用的是 comtypes + UIAutomationClient，
   并且 InitializeUIAutomationInCurrentThread。两条通道对 Chromium 的表现可能不同。
"""

import sys
import time

import uiautomation as auto

HWND = int(sys.argv[1]) if len(sys.argv) > 1 else 0

# QuitBot 的做法：在专用线程里初始化 UIA
auto.SetGlobalSearchTimeout(5.0)

print("UIA 初始化完成")


def walk(control, depth=0, max_depth=6, acc=None):
    """按 QuitBot 的 WalkControl 思路递归读"""
    if acc is None:
        acc = []
    if depth > max_depth:
        return acc
    for child in control.GetChildren():
        try:
            cls = child.ClassName or ""
            name = (child.Name or "").replace("\n", " ")
            ct = child.ControlTypeName or ""
            acc.append((depth, ct, cls, name[:40]))
        except Exception:
            continue
        walk(child, depth + 1, max_depth, acc)
    return acc


if HWND:
    win = auto.ControlFromHandle(HWND)
else:
    # 找 QQ 主窗口
    win = None
    for w in auto.GetRootControl().GetChildren():
        try:
            if w.ClassName == "Chrome_WidgetWin_1" and w.Name == "QQ":
                win = w
                break
        except Exception:
            continue

if win is None:
    print("没找到窗口")
    sys.exit(1)

print(f"窗口: class={win.ClassName} name={win.Name!r}")
nodes = walk(win, 0, 6)
print(f"前 6 层节点数: {len(nodes)}")

# 找关键 className
key = [n for n in nodes if any(k in n[2] for k in ("recent-contact-item", "chat-header", "ExEditor", "item__info"))]
print(f"命中关键 className: {len(key)}")
for n in key[:8]:
    print(f"  d{n[0]} [{n[1]}] cls={n[2][:60]} name={n[3]}")

print("\n--- 前 25 个节点 ---")
for n in nodes[:25]:
    print(f"  d{n[0]} [{n[1]}] {n[2][:45]:45} {n[3]}")

# 深一点再扫一次（QuitBot 用 maxDepth=35）
print("\n--- 深扫 depth=20 找会话项 ---")
deep = walk(win, 0, 20)
hits = [n for n in deep if "recent-contact-item" in n[2]]
print(f"总节点 {len(deep)}，recent-contact-item {len(hits)} 个")
for n in hits[:5]:
    print(f"  d{n[0]} cls={n[2][:50]}")
