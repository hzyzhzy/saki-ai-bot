# -*- coding: utf-8 -*-
"""测 `qq-sessions.parse_item` 单次耗时 —— 判断 daemon 卡住是不是它太贵。

## 背景（2026-11-17 18:11）
daemon 只打了「daemon v4 启动」一行，**45 秒都没到「摘要基线」** ⇒ 卡在 `visible_sessions`。
而 `qq-sessions.py` 单独跑只要 3 秒、`kind`/`summary` 全对。
差别在于：daemon 对**每个会话项**各调一次 `parse_item`（它内部 `find_info` 递归 +
`walk(c,0,8)`），而 `qq-sessions.py` 是**一次遍历整棵树**再解析。

## 这个脚本量什么
· 一次 `qp.tree(win)`（整棵树）要多久
· `parse_item` 单次要多久（连测 5 个会话项）
· 两者加起来 vs `qq-sessions.py` 的 3 秒
"""

import importlib.util
import json
import os
import sys
import time

import uiautomation as auto

HERE = os.path.dirname(os.path.abspath(__file__))


def arg(name, default=""):
    a = sys.argv
    for i, x in enumerate(a):
        if x == "--" + name and i + 1 < len(a):
            return a[i + 1]
    return default


def load_mod(fname, modname):
    path = os.path.join(HERE, fname)
    spec = importlib.util.spec_from_file_location(modname, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    hwnd = int(arg("hwnd", "0") or 0)
    if not hwnd:
        print(json.dumps({"ok": False, "error": "要 --hwnd"}, ensure_ascii=False))
        return 1

    qp = load_mod("qq-py.py", "qq_py_mod")
    qs = load_mod("qq-sessions.py", "qq_sessions_mod")

    win = auto.ControlFromHandle(hwnd)
    if win is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    # ① 整棵树
    t0 = time.time()
    nodes = qp.tree(win)
    tree_ms = round((time.time() - t0) * 1000)

    # ② 找会话项
    items = []
    for d, c in nodes:
        if qp.CLS_ITEM not in qp.cls_of(c):
            continue
        items.append(c)

    # ③ 对前 5 个各调一次 parse_item，逐个计时
    per = []
    names = []
    for c in items[:5]:
        t1 = time.time()
        try:
            it = qs.parse_item(c)
        except Exception as e:
            per.append({"error": str(e)[:60]})
            continue
        ms = round((time.time() - t1) * 1000)
        per.append(ms)
        names.append((it or {}).get("name"))

    print(
        json.dumps(
            {
                "ok": True,
                "tree_ms": tree_ms,
                "nodes": len(nodes),
                "items": len(items),
                "parse_item_ms": per,
                "parse_item_total_ms": sum(x for x in per if isinstance(x, int)),
                "names": names,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
