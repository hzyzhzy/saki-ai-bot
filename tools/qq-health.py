"""
QQ 健康检查 + 自动重启 + 自动打开会话。

## 为什么要这个
  今天反复出现"QQ 卡住"，每次都要人手动重启。判据应该是可测的，不该靠感觉。

## 健康判据（任一不满足就算不健康）
  1. 进程在（有主实例）
  2. 窗口能拿到（ControlFromHandle 不失败）
  3. UIA 树节点数 >= 150          ← 太少说明 a11y 没建或界面崩了
  4. 会话项（recent-contact-item）>= 3  ← 会话列表读不出来
  5. 输入框（ExEditor-qq-msg-editor）存在 ← 没有说明没打开会话（可自动修，不一定要重启）

## 用法
  python tools/qq-health.py --hwnd H              # 只体检，输出 JSON
  python tools/qq-health.py --hwnd H --open-group "群名"   # 没会话就打开这个群
"""

import json
import sys
import time

import uiautomation as auto

auto.SetGlobalSearchTimeout(5.0)

CLS_ITEM = "recent-contact-item"
CLS_EDITOR = "ExEditor-qq-msg-editor"
CLS_HEADER = "chat-header__contact-name"
CLS_INFO = ("item__info", "list-item__info")

MIN_NODES = 150
MIN_ITEMS = 3


def arg(name, default=None):
    a = sys.argv
    if "--" + name in a:
        i = a.index("--" + name)
        if i + 1 < len(a):
            return a[i + 1]
    return default


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


def cls_of(c):
    try:
        return c.ClassName or ""
    except Exception:
        return ""


def find_info(c, depth=0):
    if depth > 4:
        return None
    try:
        ch = c.GetChildren()
    except Exception:
        return None
    for x in ch:
        if any(k in cls_of(x) for k in CLS_INFO):
            return x
        g = find_info(x, depth + 1)
        if g is not None:
            return g
    return None


def name_of(c):
    i = find_info(c)
    if i is None:
        return ""
    t = []
    try:
        for x in i.GetChildren():
            if (x.ControlTypeName or "") == "TextControl" and (x.Name or "").strip():
                t.append(x.Name.strip())
    except Exception:
        pass
    return "".join(t)


def health(hwnd):
    r = {
        "ok": False,
        "hwnd": hwnd,
        "nodes": 0,
        "items": 0,
        "editor": False,
        "header": "",
        "problems": [],
    }
    if not hwnd:
        r["problems"].append("no_hwnd")
        return r
    try:
        w = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        r["problems"].append("window_unavailable:" + str(e)[:40])
        return r
    if w is None:
        r["problems"].append("window_null")
        return r
    try:
        nodes = walk(w, 0, 22)
    except Exception as e:
        r["problems"].append("walk_failed:" + str(e)[:40])
        return r
    r["nodes"] = len(nodes)
    r["items"] = len([c for d, c in nodes if CLS_ITEM in cls_of(c)])
    r["editor"] = bool([c for d, c in nodes if CLS_EDITOR in cls_of(c)])
    hdrs = [(c.Name or "").strip() for d, c in nodes if CLS_HEADER in cls_of(c)]
    r["header"] = hdrs[-1] if hdrs else ""

    if r["nodes"] < MIN_NODES:
        r["problems"].append("too_few_nodes(%d<%d)" % (r["nodes"], MIN_NODES))
    if r["items"] < MIN_ITEMS:
        r["problems"].append("too_few_sessions(%d<%d)" % (r["items"], MIN_ITEMS))
    if not r["editor"]:
        r["problems"].append("no_open_session")
    r["ok"] = len([p for p in r["problems"] if p != "no_open_session"]) == 0
    return r


def open_group(hwnd, group):
    """SetActive + Invoke 打开指定群，并核对标题"""
    w = auto.ControlFromHandle(int(hwnd))
    try:
        w.SetActive(waitTime=0.05)
    except Exception:
        pass
    time.sleep(0.4)
    nodes = walk(w, 0, 22)
    items = [(name_of(c), c) for d, c in nodes if CLS_ITEM in cls_of(c)]
    exact = [x for x in items if x[0] == group]
    cand = exact if exact else [x for x in items if group in x[0]]
    if not cand:
        return False, "not_found"
    nm, c = cand[0]
    try:
        pat = c.GetPattern(auto.PatternId.InvokePattern)
        pat.Invoke(waitTime=0.05)
    except Exception as e:
        return False, "invoke_failed:" + str(e)[:40]
    time.sleep(2.2)
    nodes2 = walk(w, 0, 24)
    hdrs = [(x.Name or "").strip() for d, x in nodes2 if CLS_HEADER in cls_of(x)]
    actual = hdrs[-1] if hdrs else ""
    ed = bool([x for d, x in nodes2 if CLS_EDITOR in cls_of(x)])
    ok = (group in actual) and ed
    return ok, "header=%r editor=%s" % (actual, ed)


def main():
    hwnd = arg("hwnd")
    h = health(hwnd)
    g = arg("open-group")
    if g:
        # 只在"没打开会话"时尝试打开（其它问题不该靠点一下修）
        if not h["editor"]:
            ok, detail = open_group(hwnd, g)
            h["openAttempt"] = {"ok": ok, "detail": detail}
            h = health(hwnd)  # 重新体检
    print(json.dumps(h, ensure_ascii=False))
    return 0 if h["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
