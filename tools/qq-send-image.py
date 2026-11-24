#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""qq-send-image.py —— 在客户端里**发一张图片**（表情包 / 照片 / 截图都走这条）。

## 为什么单独一个脚本
`qq-py.py` 只发文本。发图在 QQ 里是「点输入框上方的**图片**按钮 → 系统文件对话框 →
选文件 → 确定 →（可选）打字 → 点发送」。

## 实测按钮位置（2026-11-21，QQ NT 9.9.33，窗口 1920x1080）
    '表情'   rect=[322, 875, 354, 908]   ← 表情面板（要点很多下，不用它）
    '截图'   rect=[358, 875, 382, 908]
    '文件'   rect=[398, 875, 422, 908]
    '图片'   rect=[438, 875, 470, 908]   ← **用这个**
    '发送'   rect=[1638, 1031, 1666, 1061]

⚠️ **表情也走这条**：表情库里就是本地 png/gif，点「图片」发出去同样是图
   （客户端拿不到 `sub_type:1` 那个 NapCat 特有字段 —— QQ 自己会按大小渲染，
   小图在手机上通常显示成表情样式）。

## 用法
    python qq-send-image.py --hwnd 394768 --file "D:\\path\\a.png"
    python qq-send-image.py --hwnd 394768 --file "..." --text "配一句话"   # 先发图再打字？不，一条消息只能一种
    python qq-send-image.py --hwnd 394768 --file "..." --dry               # 只验路径和按钮，不动手

⚠️ 一条消息里**图 + 字**：QQ 支持，但这里只做"只发图"（简单可靠）。
   要带话就再发一条文字（调用方自己决定顺序）。

输出最后一行是 JSON：`{"ok": true/false, ...}`
"""

import ctypes
import json
import os
import sys
import time

import uiautomation as auto


def arg(name, default=''):
    a = sys.argv
    for i, x in enumerate(a):
        if x == '--' + name and i + 1 < len(a):
            return a[i + 1]
    return default


def has(name):
    return ('--' + name) in sys.argv


def cls_of(c):
    try:
        return c.ClassName or ''
    except Exception:
        return ''


def name_of(c):
    try:
        return (c.Name or '').strip()
    except Exception:
        return ''


def rect_of(c):
    try:
        r = c.BoundingRectangle
        return [r.left, r.top, r.right, r.bottom]
    except Exception:
        return None


def walk(c, md):
    out = []
    stack = [(0, c)]
    while stack:
        d, x = stack.pop()
        if d > md:
            continue
        out.append((d, x))
        try:
            for ch in x.GetChildren():
                stack.append((d + 1, ch))
        except Exception:
            pass
    return out


def find_button(win, want):
    """按名字找按钮（'图片' / '发送'）。"""
    for d, c in walk(win, 26):
        try:
            if (c.ControlTypeName or '') == 'ButtonControl' and name_of(c) == want:
                return c
        except Exception:
            pass
    return None


def click_at(x, y):
    u = ctypes.windll.user32
    u.SetCursorPos(int(x), int(y))
    time.sleep(0.1)
    u.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.03)
    u.mouse_event(0x0004, 0, 0, 0, 0)


def click_control(c):
    """优先 Invoke（不动鼠标），不行再真点。"""
    try:
        c.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.05)
        return 'Invoke'
    except Exception:
        r = rect_of(c)
        if r:
            click_at((r[0] + r[2]) // 2, (r[1] + r[3]) // 2)
            return 'Click'
    return '?'


def find_dialog(win=None):
    """找"选择文件"对话框。

    ⚠️⚠️ 2026-11-21 实测修正（第一版完全找不到它）——
    这个 `#32770` 对话框**不是顶层窗口**：它挂在 **QQ 窗口的直接子节点**上（depth=1）✗
    所以 `auto.GetRootControl().GetChildren()` 里**看不到它**（那里只有 QQ / WorkerW / Progman 三个）。
    实测结构：
        d=1 Window  name='请选择'  cls='#32770'  rect=[628,269,1588,809]
        d=4 Edit    name='文件名(N):'  cls='Edit'   rect=[831,732,1343,748]   ← 输路径这里
        d=4 Button  name='打开'        rect=[1347,729,1362,752]              ← 确认
    ⇒ 先给 `win` 就在它内部找（快、准）；没给才退回顶层窗口（兼容别处调用）✓
    """
    # ① 在给定窗口内部找 #32770
    #    ⚠️⚠️ 2026-11-21 实测修正 2：对话框**关掉之后 UIA 树里还留着那个节点** ✗
    #      （脚本因此误判"没关掉"、白白 return 5 —— 而其实图片已经进输入框了）
    #      ⇒ 必须同时确认它**还看得见**：`IsOffscreen` 为假 + 矩形还在屏幕内 ✓
    def alive(c):
        try:
            if c.IsOffscreen:
                return False
            r = c.BoundingRectangle
            if r.right - r.left < 100 or r.bottom - r.top < 80:
                return False
            return True
        except Exception:
            return False

    if win is not None:
        for d, c in walk(win, 6):
            try:
                if (c.ControlTypeName or '') == 'WindowControl' and cls_of(c) == '#32770' and alive(c):
                    return c, cls_of(c), name_of(c)
            except Exception:
                pass
    # ② 退路：顶层窗口
    for w in auto.GetRootControl().GetChildren():
        try:
            cn = w.ClassName or ''
            nm = (w.Name or '').strip()
            if cn == '#32770' or '请选择' in nm or '打开' in nm:
                r = w.BoundingRectangle
                if (r.right - r.left) > 200:
                    return w, cn, nm
        except Exception:
            pass
    return None, '', ''


def dialog_edit_and_ok(dlg):
    """在对话框里找「文件名」输入框和**确认按钮**。

    ⚠️⚠️ 2026-11-21 实测修正（第一版点错了按钮）——
    对话框底部那个真正提交的按钮叫 **「确认」**（旁边是「取消」），
    而 `Button name='打开'` 是**文件列表工具栏**上那个（点它只是进入选中项）✗
    实测截图：右下角就是「确认」「取消」两个字。
    """
    edit = None
    confirms = []
    for d, c in walk(dlg, 12):
        try:
            ct = c.ControlTypeName or ''
            nm = name_of(c)
            if ct == 'EditControl' and ('文件名' in nm or not edit):
                edit = c
            if ct == 'ButtonControl' and nm in ('确认', '确定', '打开'):
                r = rect_of(c)
                if r:
                    # 「确认」优先；「打开」只当退路（那多半是工具栏按钮）
                    pri = 0 if nm in ('确认', '确定') else 1
                    confirms.append((pri, -(r[2] - r[0]), c, nm))
        except Exception:
            pass
    confirms.sort(key=lambda x: (x[0], x[1]))
    return edit, (confirms[0][2] if confirms else None), (confirms[0][3] if confirms else '')


def set_edit_text(edit, text):
    """往 Edit 里写路径 —— **优先 ValuePattern.SetValue**（比 SendKeys 稳得多）。

    ⚠️ 实测：`SetFocus()` + `SendKeys(fp)` 打不进去（截图里文件名框还是空的）✗
      ⇒ 用 UIA 的 ValuePattern 直接赋值 ✓ 一步到位、不受焦点/输入法影响
    ⚠️ 有的 Edit 不支持 ValuePattern ⇒ 退回真键盘：点一下它、Ctrl+A、再 SendKeys
    """
    try:
        vp = edit.GetPattern(auto.PatternId.ValuePattern)
        vp.SetValue(text)
        return 'ValuePattern'
    except Exception:
        pass
    try:
        r = rect_of(edit)
        if r:
            u = ctypes.windll.user32
            u.SetCursorPos((r[0] + r[2]) // 2, (r[1] + r[3]) // 2)
            time.sleep(0.1)
            u.mouse_event(0x0002, 0, 0, 0, 0)
            time.sleep(0.03)
            u.mouse_event(0x0004, 0, 0, 0, 0)
            time.sleep(0.2)
        edit.SetFocus()
        time.sleep(0.2)
        u = ctypes.windll.user32
        u.keybd_event(0x11, 0, 0, 0)
        u.keybd_event(0x41, 0, 0, 0)
        u.keybd_event(0x41, 0, 2, 0)
        u.keybd_event(0x11, 0, 2, 0)
        time.sleep(0.1)
        u.keybd_event(0x2E, 0, 0, 0)
        u.keybd_event(0x2E, 0, 2, 0)
        time.sleep(0.15)
        auto.SendKeys(text, waitTime=0.01)
        return 'SendKeys'
    except Exception as e:
        return 'failed:' + str(e)[:60]


def main():
    fp = arg('file')
    hwnd = arg('hwnd')
    group = arg('group')
    if not fp:
        print(json.dumps({'ok': False, 'error': '要 --file'}, ensure_ascii=False))
        return 1
    if not os.path.isfile(fp):
        print(json.dumps({'ok': False, 'error': '文件不存在: ' + fp}, ensure_ascii=False))
        return 1
    if not hwnd:
        print(json.dumps({'ok': False, 'error': '要 --hwnd'}, ensure_ascii=False))
        return 1

    win = auto.ControlFromHandle(int(hwnd))
    if win is None:
        print(json.dumps({'ok': False, 'error': '窗口不可用'}, ensure_ascii=False))
        return 1

    # ⚠️⚠️⚠️ 2026-11-21 **必须切群**（用户：「肯定是爱音那边啊，sl 怎么可能有这种低级错误」）——
    #    这个脚本原来**只往当前打开的会话发图**，不切群 ✗
    #    而 daemon 一直在后台按需切群 ⇒ "我以为在目标群、其实在别的群" ⇒ **图发到别处** ✗✗
    #    （文字那条 `qq-py.py send` 有 `--group` + header 校验所以不会错，只有图这条漏了）
    #    ⇒ 现在：给了 `--group` 就先切 + **校验 header**，对不上直接**不发** ✓
    if group:
        try:
            import importlib.util as _ilu

            _qp = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'qq-py.py')
            _spec = _ilu.spec_from_file_location('qq_py_mod', _qp)
            _qm = _ilu.module_from_spec(_spec)
            _spec.loader.exec_module(_qm)

            nodes = _qm.tree(win)
            had = any(group in str(_qm.name_of_item(c) or '') for d, c in nodes if _qm.CLS_ITEM in _qm.cls_of(c))
            if had:
                ok, _ = _qm.do_switch(win, group, nodes)
                print('切群到「%s」: %s' % (group, '✓' if ok else '❌'))
                if not ok:
                    print(json.dumps({'ok': False, 'error': '切群失败，不敢发（怕发到别的群）'}, ensure_ascii=False))
                    return 9
            else:
                print('（会话列表里没看到「%s」—— 当前可能已在，继续校验 header）' % group)

            # **发之前再验一次 header** —— 这是最后一道闸 ✓
            time.sleep(0.6)
            hdr = ''
            for d, c in _qm.tree(win):
                if 'chat-header' in _qm.cls_of(c):
                    hdr = str(_qm.name_of(c) or '')
                    break
            print('当前 header: %r' % hdr)
            if group not in hdr:
                print(json.dumps({'ok': False,
                                  'error': 'header 对不上（%r 不含 %r）⇒ 不发' % (hdr, group)},
                                 ensure_ascii=False))
                return 9
        except Exception as e:
            print(json.dumps({'ok': False, 'error': '切群/校验出错: ' + str(e)[:80]}, ensure_ascii=False))
            return 9
    else:
        print('⚠️ 没给 --group ⇒ 发往**当前打开的会话**（可能不是你想的那个群）')

    btn_img = find_button(win, '图片')
    if btn_img is None:
        print(json.dumps({'ok': False, 'error': '找不到「图片」按钮'}, ensure_ascii=False))
        return 2

    btn_send = find_button(win, '发送')
    print('「图片」按钮 rect=%s' % (rect_of(btn_img),))
    print('「发送」按钮 %s' % ('rect=' + str(rect_of(btn_send)) if btn_send else '❌ 没找到'))

    if has('dry'):
        print(json.dumps({'ok': True, 'dry': True, 'file': fp}, ensure_ascii=False))
        return 0

    # ① 点「图片」→ 等文件对话框
    t0 = time.time()
    how = click_control(btn_img)
    print('点了「图片」（%s）' % how)

    dlg = None
    for _ in range(30):  # 最多 6 秒
        time.sleep(0.2)
        dlg, cn, nm = find_dialog(win)      # ⚠️ 传 win：对话框在 QQ 窗口内部
        if dlg is not None:
            print('文件对话框出现：cls=%r name=%r（%.1fs）' % (cn, nm, time.time() - t0))
            break
    if dlg is None:
        print(json.dumps({'ok': False, 'error': '点了图片但没弹出文件对话框'}, ensure_ascii=False))
        return 3

    # ② 在对话框里找「文件名」输入框 + 确认按钮
    edit, ok_btn, ok_name = dialog_edit_and_ok(dlg)
    print('文件名输入框: %s | 确认按钮: %s（%r）' % (
        '找到了' if edit is not None else '❌',
        '找到了' if ok_btn is not None else '❌', ok_name))

    if edit is None:
        try:
            auto.SendKeys('{Esc}')
        except Exception:
            pass
        print(json.dumps({'ok': False, 'error': '对话框里找不到文件名输入框'}, ensure_ascii=False))
        return 4

    # 用 ValuePattern 写路径（SendKeys 实测打不进去）
    how3 = set_edit_text(edit, fp)
    print('写路径方式: %s' % how3)
    time.sleep(0.5)
    # 读回来验一下（ValuePattern 支持的话能读）
    try:
        got = edit.GetPattern(auto.PatternId.ValuePattern).Value
        print('读回: %r' % (got or '')[:60])
    except Exception:
        print('（这个 Edit 不支持读回）')

    if str(how3).startswith('failed'):
        try:
            auto.SendKeys('{Esc}')
        except Exception:
            pass
        print(json.dumps({'ok': False, 'error': '路径写不进去: ' + str(how3)}, ensure_ascii=False))
        return 4

    # ③ 点「确认」
    if ok_btn is not None:
        h2 = click_control(ok_btn)
        print('点了「%s」（%s）' % (ok_name or '确认', h2))
    else:
        u = ctypes.windll.user32
        u.keybd_event(0x0D, 0, 0, 0)
        u.keybd_event(0x0D, 0, 2, 0)
        print('没有确认按钮 ⇒ 用回车')
    time.sleep(1.8)

    dlg2, _, _ = find_dialog(win)
    if dlg2 is not None:
        edit2, ok2, nm2 = dialog_edit_and_ok(dlg2)
        if ok2 is not None:
            click_control(ok2)
            time.sleep(1.4)
        dlg2, _, _ = find_dialog(win)
        if dlg2 is not None:
            try:
                auto.SendKeys('{Esc}')
            except Exception:
                pass
            print(json.dumps({'ok': False, 'error': '文件对话框没关掉（路径可能不被接受）'}, ensure_ascii=False))
            return 5

    print('图片应已进输入框')

    # ⚠️⚠️ 2026-11-21 加**真实验证**（用户：「图片工具没真实验证」）——
    #    之前 `{"ok": true}` 只代表"点到了发送按钮"，**图没进输入框也会报成功** ✗
    #    ⇒ 点发送**之前**先确认输入框真的不是空的了：
    #      · 有图时 `qq-msg-editor` 的 className **不再带 `is-empty`**
    #      · （实测：空框 cls 里有 `is-empty`，塞进图之后就没有了）
    ed = None
    for d, c in walk(win, 24):
        if 'qq-msg-editor' in cls_of(c) and 'ProseMirror' in cls_of(c):
            ed = c
            break
    if ed is None:
        for d, c in walk(win, 24):
            if 'qq-msg-editor' in cls_of(c):
                ed = c
                break
    empty = True
    if ed is not None:
        k = cls_of(ed)
        empty = 'is-empty' in k
        print('输入框状态: cls=%r ⇒ %s' % (k[:60], '**还是空的**' if empty else '有内容 ✓'))
    if empty:
        try:
            auto.SendKeys('{Esc}')
        except Exception:
            pass
        print(json.dumps({'ok': False, 'error': '图没进输入框（输入框还是空的）⇒ 不发空消息'},
                         ensure_ascii=False))
        return 7

    # ④ 点发送
    btn_send = find_button(win, '发送')
    if btn_send is None:
        print(json.dumps({'ok': False, 'error': '找不到「发送」按钮'}, ensure_ascii=False))
        return 6
    how2 = click_control(btn_send)
    time.sleep(1.2)
    print('点了「发送」（%s）' % how2)

    # ⑤ 发送后：输入框应该重新变空（= 真发出去了）
    sent_ok = False
    for _ in range(10):
        time.sleep(0.3)
        ed2 = None
        for d, c in walk(win, 24):
            if 'qq-msg-editor' in cls_of(c) and 'ProseMirror' in cls_of(c):
                ed2 = c
                break
        if ed2 is not None and 'is-empty' in cls_of(ed2):
            sent_ok = True
            break
    print('发送后输入框: %s' % ('已清空 ✓（真发出去了）' if sent_ok else '还有内容 ⚠️（可能没发出去）'))

    print(json.dumps({'ok': sent_ok, 'file': fp, 'how': how, 'send': how2,
                      'verified': sent_ok,
                      'ms': int((time.time() - t0) * 1000)}, ensure_ascii=False))
    return 0 if sent_ok else 8


if __name__ == '__main__':
    sys.exit(main())
