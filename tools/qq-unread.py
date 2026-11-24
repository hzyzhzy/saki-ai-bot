"""读会话列表的**未读数**（红点/角标）。

## 为什么需要
  多群轮询要"先读哪个群" —— 有未读的优先。
  之前 `qq-poll.py` 是按列表顺序傻读前 N 个，白读一堆没新消息的会话。

## 结构（实测 QQ NT 9.9.33）
  会话项 `recent-contact-item` 子树里：
    `q-badge q-badge__red`          红色角标容器
      `q-badge-sub q-badge-num ...` 数字（Name 里是 "4"、"99+"）或
      `q-badge-sub q-badge-dot ...` 小红点（没有数字，只是"有未读"）
"""

import importlib.util
import json
import sys

import uiautomation as auto

spec = importlib.util.spec_from_file_location('qqpy', r'<项目目录>\qq-ai-bot\tools\qq-py.py')
qqpy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qqpy)


def unread_of(item):
    """返回 (unread, hasDot)：unread 是数字（'99+' 记 99），没有数字返回 0"""
    num = 0
    dot = False
    for d, c in qqpy.walk(item, 0, 8):
        k = qqpy.cls_of(c)
        if "q-badge" not in k:
            continue
        nm = qqpy.name_of(c)
        if "q-badge-dot" in k:
            dot = True
        if "q-badge-num" in k or (nm and nm.replace("+", "").isdigit()):
            t = nm.replace("+", "")
            if t.isdigit():
                num = max(num, int(t))
    return num, dot


def main():
    # ⚠️ 参数用 `--hwnd` 解析，不要用 sys.argv[2]（会越界）
    hwnd = 1902218
    a = sys.argv
    if '--hwnd' in a:
        i = a.index('--hwnd')
        if i + 1 < len(a):
            try:
                hwnd = int(a[i + 1])
            except ValueError:
                pass
    win = auto.ControlFromHandle(hwnd)
    if win is None:
        print(json.dumps({"ok": False, "error": "拿不到窗口"}))
        return 1
    nodes = qqpy.tree(win, 22)
    items = [(qqpy.name_of_item(c), c) for d, c in nodes if qqpy.CLS_ITEM in qqpy.cls_of(c)]
    items = [(n, c) for n, c in items if n]
    out = []
    for nm, c in items:
        u, dot = unread_of(c)
        if u or dot:
            out.append({"name": nm, "unread": u, "dot": dot})
    print(json.dumps({"ok": True, "total": len(items), "withUnread": out}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
