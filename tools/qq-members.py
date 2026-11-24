"""读当前群的成员列表 + 群资料（不切群、不碰前台）。

## 为什么要它
  OneBot 的 `get_group_member_list` / `get_group_info` 是 bot 常用的（点名、禁言、查人）。
  这两样都在右侧「群成员列表」面板里，**读它不需要切群、不需要前台** ✓

## 靠什么认
  实测右侧有个 `[Pane] 群成员列表`（className 含 `group-member-list`），
  里面每行是一个成员项，含昵称 / 群名片 / 角色（群主/管理员）。
"""

import json
import sys

import uiautomation as auto

auto.SetGlobalSearchTimeout(5.0)


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


def nm_of(c):
    try:
        return (c.Name or "").strip()
    except Exception:
        return ""


def walk(c, d=0, md=30, acc=None):
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


def main():
    hwnd = int(arg("hwnd", "0") or 0)
    if not hwnd:
        print(json.dumps({"ok": False, "error": "要 --hwnd"}))
        return 1
    try:
        win = auto.ControlFromHandle(hwnd)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "窗口不可用:" + str(e)[:60]}))
        return 1
    if win is None:
        print(json.dumps({"ok": False, "error": "window_null"}))
        return 1

    nodes = walk(win, 0, 30)

    # ① 群名 + 人数（chat-header 里通常带 "(59)"）
    group = ""
    count = 0
    for d, c in nodes:
        if "chat-header__contact-name" in cls_of(c):
            group = nm_of(c)
            break

    # ② 成员列表面板
    pane = None
    for d, c in nodes:
        k = cls_of(c)
        if "group-member-list" in k or ("Pane" in (c.ControlTypeName or "") and "群成员" in nm_of(c)):
            pane = c
            break

    if pane is None:
        print(json.dumps({"ok": False, "error": "找不到群成员列表面板（可能没打开群聊）", "group": group}, ensure_ascii=False))
        return 1

    members = []
    # ⚠️ 成员项的结构（实测 QQ NT 9.9.33）：
    #     group-user            → TextControl 'Ch1hayaAnonQWQ'   ← **昵称在这里**
    #     group-member-label    → TextControl '群主' / '管理员'   ← 角色标签，不能当昵称
    #   之前把角色标签当昵称，是因为在整棵子树里取"最长的文本"。
    for d, c in walk(pane, 0, 14):
        k = cls_of(c)
        # 认 group-user 这一层（它自己带昵称文本）
        if "group-user" not in k:
            continue
        nickname = ""
        card = ""
        role = "member"
        raw = []
        for dd, cc in walk(c, 0, 6):
            if (cc.ControlTypeName or "") != "TextControl":
                continue
            t = nm_of(cc)
            if not t:
                continue
            raw.append(t)
            # 昵称：group-user 自己的直接文本（第一个非角色标签）
            if not nickname and t not in ("群主", "管理员", "群成员"):
                nickname = t
        # 角色：看紧跟其后的 group-member-label
        # （UIA 没有父指针，用"同一行、x 在昵称右侧"就近判断；拿不到就默认 member）
        try:
            br = c.BoundingRectangle
        except Exception:
            br = None
        if br is not None:
            for dd, cc in walk(pane, 0, 14):
                kk = cls_of(cc)
                if "group-member-label" not in kk:
                    continue
                try:
                    lr = cc.BoundingRectangle
                except Exception:
                    continue
                # 同一行（纵向重叠）且在昵称右侧
                if abs(lr.top - br.top) <= 20 and lr.left >= br.left:
                    label = ""
                    for ddd, t2 in walk(cc, 0, 4):
                        if (t2.ControlTypeName or "") == "TextControl":
                            label = nm_of(t2) or label
                    if "群主" in label:
                        role = "owner"
                    elif "管理员" in label:
                        role = "admin"
                    break
        if nickname:
            members.append({"nickname": nickname, "card": card, "role": role, "raw": raw[:4]})

    # 人数：从群名括号里抠
    import re

    m = re.search(r"\((\d+)\)", group)
    if m:
        count = int(m.group(1))

    out = {
        "ok": True,
        "group": group,
        "count": count,
        "members": len(members),
        "list": members[:60],
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
