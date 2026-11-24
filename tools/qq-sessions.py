"""列出 QQ 的所有会话（群 + 私聊），并区分类型。

## 为什么需要
  `get_friend_list` / `send_private_msg` 都要知道"哪些会话是私聊"。
  而 UIA **不暴露 QQ 号**，所以只能靠**会话名 + 结构特征**来区分。

## 怎么区分群 / 私聊（实测 QQ NT 9.9.33）
  会话项 `recent-contact-item` 的子树里：
    · **群**：`item__avatar` 里通常是群头像，`item__info` 的第一个 Text 是群名，
      而且**群名后面常带成员数**（如 `(4)`），`secondary-info`/`summary-main` 里有「某人：」
    · **私聊**：`item__info` 的第一个 Text 是人名/备注，没有成员数括号
  ⚠️ 这套判据不是 100% 准（群名也可能带括号），所以额外给一个 `hint`：
    · `hasMemberCount`：紧跟名字的 Text 形如 `(12)`
    · `hasColonSummary`：摘要里有「XXX：」这种「谁说了什么」
    → **两个都有 ⇒ 群**；**都没有 ⇒ 私聊**；只有一个 ⇒ 看 `prefer`
  输出里带 `kind` + `confidence`，调用方可以自己再筛。

用法：
  python tools/qq-sessions.py --hwnd H [--json]
"""

import json
import re
import sys
import time

import uiautomation as auto

auto.SetGlobalSearchTimeout(4.0)

CLS_ITEM = "recent-contact-item"
CLS_INFO = ("item__info", "list-item__info")
MEMBER_COUNT_RE = re.compile(r"^\((\d+)\)$")
COLON_RE = re.compile(r"^[^：:]{1,20}[：:]")
# ⚠️ 2026-11-16 加：会话项里的**时间**（`11:11` / `昨天` / `10/30`）——
#    必须先剔掉再取摘要，不然「11:11」会被 COLON_RE 当成「谁：说了什么」✗
TIME_RE = re.compile(r"^(\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日天]|\d{1,2}/\d{1,2}|\d{1,2}月\d{1,2}日)$")
# 会话项里的**等级徽章**（「LV」「青铜」这类）不可能是摘要，剔掉
BADGE_RE = re.compile(r"^(LV|青铜|白银|黄金|铂金|钻石|星耀|王者|大师|传说)$")


def arg(name, default=None):
    a = sys.argv
    if "--" + name in a:
        i = a.index("--" + name)
        if i + 1 < len(a):
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


def find_info(c, depth=0):
    if depth > 4:
        return None
    try:
        children = c.GetChildren()
    except Exception:
        return None
    for x in children:
        if any(k in cls_of(x) for k in CLS_INFO):
            return x
        g = find_info(x, depth + 1)
        if g is not None:
            return g
    return None


def parse_item(c):
    """从一个 recent-contact-item 里抠出 名字 / 未读 / 摘要 / 类型线索

    ⚠️⚠️ 2026-11-18 提速（优化全链路耗时）——
    原来对**同一个会话项遍历 4~5 遍**：`find_info()` 递归 + `info.GetChildren()`
    两次（一次收集 texts、一次找 name）+ 全子树 `walk(c,0,8)` 两次
    （一次拼摘要、一次找未读徽章）⇒ 实测 **20ms/项**，15 个会话就是 301ms，
    而这段**每轮都跑**（轮询 0.2 秒一轮）⇒ 白占掉半个轮询周期 ✗
    ⇒ 合并成：`info` 子级读 1 遍、全子树走 1 遍。行为与原来完全一致：
      · name 仍取 `info` 下第一个有文字的 TextControl
      · 摘要仍排除时间戳 / LV 徽章 / 未读数字 / 群人数括号
      · 未读仍取 q-badge 里的数字最大值
    """
    info = find_info(c)
    if info is None:
        return None
    texts = []
    name = ""
    try:
        for t in info.GetChildren():
            if (t.ControlTypeName or "") != "TextControl":
                continue
            nm = name_of(t)
            if not nm:
                continue
            texts.append(nm)
            if not name:
                name = nm  # ⚠️ 第一个 = 名字（和原来"取第一个再 break"一致）
    except Exception:
        pass
    if not texts or not name:
        return None

    member_count = None
    parts = []
    seen = set()
    unread = 0
    dot = False
    # ⚠️ 一次遍历：摘要零件 + 未读徽章（原来分两趟走同一棵子树）
    for d, t in walk(c, 0, 8):
        k = cls_of(t)
        if "q-badge" in k:
            # 徽章先处理掉：里面的数字是"未读数"，绝不能混进摘要
            if "q-badge-dot" in k:
                dot = True
            bn = name_of(t)
            if bn and bn.replace("+", "").isdigit():
                unread = max(unread, int(bn.replace("+", "")))
            continue
        if (t.ControlTypeName or "") != "TextControl":
            continue
        nm = name_of(t)
        if not nm or nm in seen:
            continue
        seen.add(nm)
        if nm == name:
            continue
        m = MEMBER_COUNT_RE.match(nm)
        if m and member_count is None:
            member_count = int(m.group(1))
            continue
        if TIME_RE.match(nm):
            continue
        if BADGE_RE.match(nm):  # 「LV」「13」「青铜」这类徽章
            continue
        if nm.replace("+", "").isdigit():  # 未读数字
            continue
        parts.append(nm)
    # ⚠️ 累加而不是只取第一条：一条摘要常被拆成好几个 TextControl
    #    （实测只取第一条会得到 `[` —— `[图片]` 被切断了）
    summary = "".join(parts)

    # 判类型
    kind = "unknown"
    conf = "low"
    if member_count is not None:
        kind = "group"
        conf = "high" if summary else "medium"
    elif summary:
        kind = "group"
        conf = "medium"
    else:
        kind = "private"
        conf = "medium"

    return {
        "name": name,
        "memberCount": member_count,
        "summary": summary,
        "unread": unread,
        "dot": dot,
        "kind": kind,
        "confidence": conf,
        "rawTexts": texts[:6],
    }


def main():
    hwnd = int(arg("hwnd", "0") or 0)
    if not hwnd:
        print(json.dumps({"ok": False, "error": "要 --hwnd"}, ensure_ascii=False))
        return 1
    try:
        win = auto.ControlFromHandle(hwnd)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "窗口不可用:" + str(e)[:60]}, ensure_ascii=False))
        return 1
    if win is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    # ⚠️ 2026-11-16 加 `--wake`：**会话列表也在"窗口不活跃就不渲染"的范围内**。
    #    不唤醒的话，别的群来了新消息、摘要该变的也没变 ⇒ 适配器的"扫会话"
    #    永远发现不了 → 多会话收消息这条链就是死的 ✗
    #    （同一个坑在 `qq-read.py` 那边实测过：SetActive 一下，积压的消息立刻出现。）
    if "--wake" in sys.argv:
        try:
            win.SetActive(waitTime=0.15)
            time.sleep(0.3)
        except Exception:
            pass

    nodes = walk(win, 0, 22)
    out = []
    for d, c in nodes:
        if CLS_ITEM not in cls_of(c):
            continue
        item = parse_item(c)
        if item:
            out.append(item)

    # ⚠️⚠️ 2026-11-15：**改用群名表对照来判断群/私聊**。
    #    原来靠"成员数括号 + 摘要里的『某人：』"判，实测**不可靠** ——
    #    会话项的直接子 Text 往往只有名字（成员数和摘要在更深层，这里读不到），
    #    结果 13 个群全被判成私聊 ✗
    #    ⇒ 用 `state/group-names.json`（20 个已知群名）对照：
    #       名字在表里 ⇒ 群；不在 ⇒ 私聊。
    #       再叠一层结构线索（有成员数括号 ⇒ 一定是群）。
    known = set()
    try:
        import os
        gp = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'state', 'group-names.json')
        with open(gp, encoding='utf-8') as f:
            gj = json.load(f)
        for _gid, gv in (gj.get('groups') or {}).items():
            nm = str((gv or {}).get('name') or '').strip()
            if nm and '配置里写的' not in nm:
                known.add(nm)
    except Exception:
        pass

    for item in out:
        nm = item['name']
        if item.get('memberCount') is not None:
            item['kind'] = 'group'
            item['confidence'] = 'high'
            item['why'] = '有成员数括号'
        elif nm in known:
            item['kind'] = 'group'
            item['confidence'] = 'high'
            item['why'] = '在群名表里'
        else:
            item['kind'] = 'private'
            item['confidence'] = 'medium'
            item['why'] = '不在群名表里'

    print(json.dumps({
        "ok": True,
        "total": len(out),
        "groups": [x for x in out if x["kind"] == "group"],
        "privates": [x for x in out if x["kind"] == "private"],
        "unknown": [x for x in out if x["kind"] == "unknown"],
        "all": out,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
