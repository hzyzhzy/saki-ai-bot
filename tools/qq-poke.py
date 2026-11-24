# -*- coding: utf-8 -*-
"""戳一戳（右键头像 → 菜单「戳一戳」）。

## 为什么需要单独一个脚本
客户端方案（Anode seat 里的 QQ 界面）没有 OneBot 的 `send_poke`：
QQ 里对应的是「右键某人头像 → 戳一戳」。`qq-py.py` 只做「切群 + 发文本」，
管不到这个动作，所以单开一个。

## 实测结构（2026-11-15，QQ NT 9.9.33）
右键消息区的头像后，菜单是**主窗口树里**的一个 `q-context-menu`（不是独立顶层窗口）：
```
q-context-menu q-context-menu__mixed-type group-member-menu   name=菜单
  q-context-menu-item q-context-menu-item--normal   name=屏蔽此人发言
  q-context-menu-item q-context-menu-item--normal   name=举报
  q-context-menu-item q-context-menu-item--normal   name=添加好友
  q-context-menu-item q-context-menu-item--normal   name=查看资料
  q-context-menu-item q-context-menu-item--normal   name=戳一戳      ← 这个
  q-context-menu-item q-context-menu-item--normal   name=TA
  q-context-menu-item q-context-menu-item--normal   name=发送消息
```
⚠️ 第 1 版只看「新出现的顶层窗口」⇒ 一个都抓不到（菜单在渲染层里）✗

## 用法
    python qq-poke.py --hwnd 132512 --probe             # 只打开菜单、把项名列出来，不点
    python qq-poke.py --hwnd 132512 --to 桐间旭丘        # 真戳（定位他最近那条消息的头像）

⚠️ 不点菜单里的任何东西 = 安全；`--to` 会真的戳到人，只在验证时用一次。
"""

import json
import sys
import time

import uiautomation as auto


def arg(name, default=""):
    a = sys.argv
    for i, x in enumerate(a):
        if x == "--" + name and i + 1 < len(a):
            return a[i + 1]
    return default


def cls_of(c):
    try:
        return c.ClassName or ""
    except Exception:
        return ""


def name_of(c):
    try:
        return c.Name or ""
    except Exception:
        return ""


def walk(c, md=30):
    acc = []
    stack = [(c, 0)]
    while stack:
        x, d = stack.pop()
        if d > md:
            continue
        acc.append((d, x))
        try:
            kids = x.GetChildren()
        except Exception:
            kids = []
        for k in kids:
            stack.append((k, d + 1))
    return acc


def top_windows():
    out = []
    try:
        for c in auto.GetRootControl().GetChildren():
            out.append(c)
    except Exception:
        pass
    return out


def dismiss():
    """Esc 关掉菜单（按两下更稳，一下有时只关一层）"""
    for _ in range(2):
        try:
            auto.SendKeys("{Esc}", waitTime=0.15)
        except Exception:
            pass


def find_menu(w, key="戳一戳"):
    """在主窗口（和顶层窗口）里找右键菜单；返回菜单根 + 目标项。"""
    boxes = []
    for d, c in walk(w, 30):
        if "q-context-menu" in cls_of(c) and "q-context-menu-item" not in cls_of(c) and "overlay" not in cls_of(c):
            boxes.append(c)
    target = None
    for d, c in walk(w, 30):
        k = cls_of(c)
        if "q-context-menu-item" in k and name_of(c) == key:
            target = c
            break
    return boxes, target


def container_nick(box):
    """某个 message-container 里的昵称。

    ⚠️ 2026-11-15 实测：昵称在 **`avatar-span` 的 Name** 里（和 `qq-read.py` 取 `who`
    同一个来源）。第 1 版取「第一个 TextControl」，结果一个都匹配不上
    （`message-container` 里第一个 TextControl 常是时间/等级徽章）✗
    """
    for d, c in walk(box, 12):
        if "avatar-span" in cls_of(c):
            nm = name_of(c)
            if nm and len(nm) <= 26:
                return nm
    for d, c in walk(box, 12):
        if (c.ControlTypeName or "") == "TextControl":
            nm = name_of(c)
            if nm and len(nm) <= 26:
                return nm
    return ""


def boxes(nodes):
    return [
        (d, c)
        for d, c in nodes
        if "message-container" in cls_of(c) and "message-container__avatar" not in cls_of(c)
    ]


def panel_rect(nodes):
    """消息面板的可见区域（用来判断"这条消息的头像现在真的在屏幕上"）。

    ⚠️⚠️ 2026-11-15 踩的坑：消息的 `rect.top` **不是屏幕坐标**，而是**滚动内容坐标**
    （往上滚过之后会是负数，或者是个只对渲染层有意义的值）。
    第 2 版按它取"最下面那条"，结果拿到 `avatar_at=[513,123]` —— 那是 QQ 的
    **搜索框/标题栏**，右键点上去当然没有「戳一戳」菜单 ✗
    （截图核对：QQ 窗口内容区从 y≈130 才开始，123 在标题栏上。）
    ⇒ 先拿到 `message-panel` 的实际矩形，只挑**真正落在它里面**的头像。
    """
    for d, c in nodes:
        if "message-panel" in cls_of(c):
            try:
                r = c.BoundingRectangle
                return (r.left, r.top, r.right, r.bottom)
            except Exception:
                return None
    return None


def in_panel(avatar, pr, margin=2):
    if pr is None:
        return True  # 找不到面板就别过滤了，退回老行为
    try:
        r = avatar.BoundingRectangle
    except Exception:
        return False
    cx, cy = (r.left + r.right) // 2, (r.top + r.bottom) // 2
    return (pr[0] + margin) <= cx <= (pr[2] - margin) and (pr[1] + margin) <= cy <= (pr[3] - margin)


def member_list_rect(nodes):
    """右侧「群成员列表」的矩形（没展开就是 None）。"""
    for d, c in nodes:
        if "group-member-list__wrapper" in cls_of(c):
            try:
                r = c.BoundingRectangle
                return (r.left, r.top, r.right, r.bottom)
            except Exception:
                return None
    return None


def find_in_member_list(nodes, want):
    """在**群成员列表**里找目标，返回应该右键的点 (x, y)。

    ⚠️⚠️ 为什么优先用成员列表（2026-11-15 实测）：
     消息区的头像 `BoundingRectangle` 对**文件消息**会给过期/错位的坐标 ——
     实测谷雨那条 `45轮.txt` 的 avatar 报 `[497,107,529,139]`（中心 `[513,123]`），
     而那个位置实际是 QQ 的**搜索框** ⇒ 右键点空 ⇒ 菜单里没有「戳一戳」✗
     成员列表**一直可见、位置稳定**，比滚动区可靠得多。

    布局是 `[头像][名字]` ⇒ 名字元素往左 20px 就是头像中心。
    """
    ml = member_list_rect(nodes)
    if ml is None:
        return None
    hits = []
    for d, c in nodes:
        if name_of(c) != want:
            continue
        try:
            r = c.BoundingRectangle
        except Exception:
            continue
        cx, cy = (r.left + r.right) // 2, (r.top + r.bottom) // 2
        if not (ml[0] <= cx <= ml[2] and ml[1] <= cy <= ml[3]):
            continue
        hits.append((r.top, r))
    if not hits:
        return None
    hits.sort(key=lambda x: x[0])
    r = hits[0][1]
    return (r.left - 20, (r.top + r.bottom) // 2)


def find_target_avatar(nodes, want):
    """按昵称找**当前屏幕上真的看得见**的那条消息的头像。

    ⚠️⚠️ 2026-11-15 实测踩的坑：同一个人有**很多条**消息，第 1 版取的是
    **第一条**（遍历顺序不是屏幕顺序）⇒ 那条早就滚出视口了，右键落在消息区外面
    ⇒ 菜单里当然没有「戳一戳」✗（第一次碰巧成功、之后连戳三次全失败）

    ⇒ 现在：① 只留落在 `message-panel` 里的；② 其中取**最下面**那条。
    """
    pr = panel_rect(nodes)
    cands = []
    for d, box in boxes(nodes):
        nick = container_nick(box)
        if not nick:
            continue
        if nick != want and want not in nick and nick not in want:
            continue
        avatar = None
        for dd, k in walk(box, 8):
            kc = cls_of(k)
            if "message-container__avatar" in kc or "avatar-native" in kc:
                avatar = k
                break
        if avatar is None:
            continue
        if not in_panel(avatar, pr):
            continue
        try:
            top = avatar.BoundingRectangle.top
        except Exception:
            top = -10**9
        cands.append((top, box, avatar))
    if not cands:
        return None, None
    cands.sort(key=lambda x: x[0])
    top, box, avatar = cands[-1]
    return box, avatar


def first_avatar(nodes):
    for d, c in nodes:
        k = cls_of(c)
        if "message-container__avatar" in k or "avatar-native" in k:
            return c
    return None


def session_name(nodes):
    for d, c in nodes:
        if "chat-header" in cls_of(c):
            nm = name_of(c)
            if nm:
                return nm
    return ""


def poke_item_click(item):
    """点「戳一戳」。先试 Invoke（不动鼠标），失败再用真实点击。"""
    tries = []
    try:
        item.GetInvokePattern().Invoke(waitTime=0.4)
        tries.append("invoke")
    except Exception as e:
        tries.append("invoke_fail:" + str(e)[:40])
    # ⚠️ Invoke 返回不代表点中（DOM 菜单实测有时是空转）⇒ 菜单还在就补一次真实点击
    time.sleep(0.6)
    try:
        w = auto.ControlFromHandle(item.GetTopLevelControl().NativeWindowHandle)
    except Exception:
        w = None
    still = False
    try:
        if w is not None:
            _, t2 = find_menu(w)
            still = t2 is not None
    except Exception:
        still = False
    if still:
        try:
            item.Click(waitTime=0.4)
            tries.append("click")
        except Exception as e:
            tries.append("click_fail:" + str(e)[:40])
    return tries


def main():
    hwnd = arg("hwnd")
    probe = "--probe" in sys.argv
    want = arg("to", "")
    if not hwnd:
        print(json.dumps({"ok": False, "error": "要 --hwnd"}, ensure_ascii=False))
        return 1

    try:
        w = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        print(json.dumps({"ok": False, "error": "窗口不可用:" + str(e)[:60]}, ensure_ascii=False))
        return 1
    if w is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    nodes = walk(w, 34)
    session = session_name(nodes)

    # ── 定位：**先群成员列表，再退回消息区头像** ──
    # 成员列表一直可见、坐标稳定；消息区头像对文件消息会报错位坐标（见 find_in_member_list 的注释）
    pos = find_in_member_list(nodes, want) if want else None
    how = "member-list"

    if pos is not None:
        cx, cy = pos
        try:
            auto.RightClick(cx, cy, waitTime=0.6)
        except Exception as e:
            print(json.dumps({"ok": False, "error": "右键失败(member-list):" + str(e)[:80]}, ensure_ascii=False))
            return 1
    else:
        how = "message-avatar"
        if want:
            box, avatar = find_target_avatar(nodes, want)
            if avatar is None:
                print(
                    json.dumps(
                        {
                            "ok": False,
                            "error": f"群成员列表和消息区都找不到「{want}」（成员列表没展开？他最近没在这屏发过言？）",
                            "session": session,
                        },
                        ensure_ascii=False,
                    )
                )
                return 1
        else:
            avatar = first_avatar(nodes)
            if avatar is None:
                print(json.dumps({"ok": False, "error": "消息区里没找到头像", "session": session}, ensure_ascii=False))
                return 1
        r = avatar.BoundingRectangle
        cx, cy = (r.left + r.right) // 2, (r.top + r.bottom) // 2
        try:
            avatar.RightClick(waitTime=0.6)
        except Exception as e:
            print(json.dumps({"ok": False, "error": "右键失败:" + str(e)[:80]}, ensure_ascii=False))
            return 1

    time.sleep(0.9)

    boxes_, item = find_menu(w, "戳一戳")

    if probe or item is None:
        names = []
        for b in boxes_:
            for d, c in walk(b, 8):
                nm = name_of(c)
                if nm and "q-context-menu-item" in cls_of(c):
                    names.append(nm)
        dismiss()
        print(
            json.dumps(
                {
                    "ok": item is not None,
                    "mode": "probe",
                    "session": session,
                    "avatar_at": [cx, cy],
                    "menu_items": names,
                    "error": "" if item is not None else "菜单里没有「戳一戳」",
                },
                ensure_ascii=False,
            )
        )
        return 0 if item is not None else 1

    tries = poke_item_click(item)
    time.sleep(0.8)
    dismiss()
    time.sleep(0.3)

    # 验证：界面里出现「戳了戳」这类提示，或者菜单已消失
    nodes2 = walk(w, 34)
    hint = ""
    for d, c in nodes2:
        nm = name_of(c)
        if nm and "戳了戳" in nm:
            hint = nm[:80]
            break

    print(
        json.dumps(
            {
                "ok": True,
                "mode": "send",
                "session": session,
                "to": want or "(第一个头像)",
                "how": how,
                "avatar_at": [cx, cy],
                "tries": tries,
                "hint": hint,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
