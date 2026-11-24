"""在 seat 里找 QQ 的主窗口 hwnd（自动探测，不要写死）。

## 为什么需要
  seat 里的 QQ 每次重启，hwnd 都会变（实测从 1902218 → 132512 → …）。
  写死一个值的话，重启一次就得改代码。

## 判据
  · class = `Chrome_WidgetWin_1`
  · 所属进程 = QQ.exe
  · 可见
  · **优先选有 UIA 子节点多的那个**（主窗口 vs 弹窗）
    ⚠️ 这一步用 uiautomation 数节点，最准；数是 0 的说明是空壳/隐藏窗。

输出一行 JSON：`{"ok":true,"hwnd":132512,"pid":34712,"candidates":[...]}`
"""

import ctypes
import json
import sys

u = ctypes.windll.user32
CB = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)


def proc_name(pid):
    try:
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return ''
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = ctypes.c_uint(1024)
            if ctypes.windll.kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                import os
                return os.path.basename(buf.value)
        finally:
            ctypes.windll.kernel32.CloseHandle(h)
    except Exception:
        pass
    return ''


def list_windows():
    out = []

    def cb(h, l):
        try:
            if not u.IsWindowVisible(h):
                return True
            cls = ctypes.create_unicode_buffer(128)
            u.GetClassNameW(h, cls, 128)
            if cls.value != 'Chrome_WidgetWin_1':
                return True
            p = ctypes.c_uint()
            u.GetWindowThreadProcessId(h, ctypes.byref(p))
            if proc_name(p.value).lower() != 'qq.exe':
                return True
            t = ctypes.create_unicode_buffer(256)
            u.GetWindowTextW(h, t, 256)
            r = ctypes.wintypes.RECT()
            u.GetWindowRect(h, ctypes.byref(r))
            out.append({
                'hwnd': int(h),
                'pid': p.value,
                'title': (t.value or '')[:40],
                'w': r.right - r.left,
                'h': r.bottom - r.top,
            })
        except Exception:
            pass
        return True

    u.EnumWindows(CB(cb), 0)
    return out


def count_nodes(hwnd):
    """用 uiautomation 数节点（判断是不是真界面）"""
    try:
        import uiautomation as auto

        auto.SetGlobalSearchTimeout(3.0)
        w = auto.ControlFromHandle(int(hwnd))
        if w is None:
            return 0

        def walk(c, d=0, md=18, acc=None):
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

        n = walk(w, 0, 18)
        has_items = any('recent-contact-item' in (getattr(c, 'ClassName', '') or '') for _, c in n)
        return len(n) if has_items else -len(n)  # 有会话项的记正数，更优先
    except Exception:
        return 0


def main():
    wins = list_windows()
    if not wins:
        print(json.dumps({'ok': False, 'error': 'seat 里没找到可见的 QQ 窗口'}, ensure_ascii=False))
        return 1

    # 按"节点数（有会话项优先）"排序
    scored = []
    for w in wins:
        s = count_nodes(w['hwnd'])
        w['nodes'] = abs(s)
        w['hasItems'] = s > 0
        scored.append((abs(s) + (1000 if s > 0 else 0), w))
    scored.sort(key=lambda x: -x[0])

    best = scored[0][1]
    print(json.dumps({
        'ok': True,
        'hwnd': best['hwnd'],
        'pid': best['pid'],
        'title': best['title'],
        'nodes': best['nodes'],
        'hasItems': best['hasItems'],
        'candidates': [c[1] for c in scored[:5]],
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    import ctypes.wintypes

    sys.exit(main())
