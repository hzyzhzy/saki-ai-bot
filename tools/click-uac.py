"""点掉当前屏幕上的 UAC 对话框（「是」）。

只做这一件事：找 #32770 + 标题含「用户帐户控制」的窗口 → UIA 找「是」→ Invoke。
UAC 已经在等的时候跑它，别等太久（UAC 有超时）。
"""

import ctypes
import sys
import time

import uiautomation as auto

auto.SetGlobalSearchTimeout(2.5)


def find_uac():
    u = ctypes.windll.user32
    CB = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    out = []

    def cb(h, l):
        if not u.IsWindowVisible(h):
            return True
        cls = ctypes.create_unicode_buffer(64)
        u.GetClassNameW(h, cls, 64)
        if cls.value != '#32770':
            return True
        t = ctypes.create_unicode_buffer(256)
        u.GetWindowTextW(h, t, 256)
        title = t.value or ''
        if any(k in title for k in ('用户帐户控制', '用户账户控制', 'User Account Control')):
            out.append((int(h), title))
        return True

    u.EnumWindows(CB(cb), 0)
    return out


def walk(c, d=0, md=10, acc=None):
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


def click(h, title):
    try:
        w = auto.ControlFromHandle(h)
    except Exception as e:
        return False, 'control:' + str(e)[:40]
    if w is None:
        return False, 'null'
    btns = []
    for d, c in walk(w, 0, 10):
        try:
            if (c.ControlTypeName or '') != 'ButtonControl':
                continue
            nm = (c.Name or '').strip()
            if nm:
                btns.append((nm, c))
        except Exception:
            continue
    names = [n for n, _ in btns]
    # UAC 的按钮名是 "是(Y)" / "Yes" / "&Yes" 这种
    for target in ('是', 'Yes'):
        for nm, c in btns:
            if nm.startswith(target) or target in nm:
                try:
                    p = c.GetPattern(auto.PatternId.InvokePattern)
                    if p is None:
                        return False, 'no_invoke:' + nm
                    p.Invoke(waitTime=0.05)
                    return True, 'invoked:' + nm
                except Exception as e:
                    return False, 'invoke_err:' + str(e)[:40]
    return False, 'buttons=' + ','.join(names[:8])


def main():
    tries = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    for i in range(tries):
        wins = find_uac()
        if wins:
            print(f'第{i+1}次: 找到 {len(wins)} 个 UAC 窗口')
            for h, title in wins:
                ok, detail = click(h, title)
                print(f'  hwnd={h} title={title!r} -> {ok} {detail}')
                if ok:
                    print('✅ 已点「是」')
                    return 0
        time.sleep(1)
    print('❌ 没找到 UAC 窗口（' + str(tries) + ' 秒内）')
    return 1


if __name__ == '__main__':
    sys.exit(main())
