"""查前台窗口是什么（进程名 + 标题 + hwnd）。

用途：自测/操作前先看一眼前台，避免把"环境问题"误判成"代码 bug"。
（第 13 轮的教训：排查了 12 轮才发现是 UAC 弹窗占着前台。）

输出一行 JSON：
  {"ok":true,"hwnd":123,"title":"QQ","proc":"QQ","cls":"Chrome_WidgetWin_1","isQQ":true,"isUAC":false}
"""

import ctypes
import json
import os
import sys

u = ctypes.windll.user32
u.GetForegroundWindow.restype = ctypes.c_void_p


def proc_name(pid):
    """不引入 psutil，直接用 Win32 API + 一次 tasklist（慢但稳）
    ⚠️ 更快的办法是 QueryFullProcessImageNameW，用它。"""
    try:
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return ''
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = ctypes.c_uint(1024)
            ok = ctypes.windll.kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
            if ok:
                return os.path.basename(buf.value)
        finally:
            ctypes.windll.kernel32.CloseHandle(h)
    except Exception:
        pass
    return ''


def main():
    h = int(u.GetForegroundWindow() or 0)
    title = ''
    cls = ''
    pid = 0
    if h:
        b = ctypes.create_unicode_buffer(512)
        u.GetWindowTextW(h, b, 512)
        title = b.value or ''
        c = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(h, c, 256)
        cls = c.value or ''
        p = ctypes.c_uint()
        u.GetWindowThreadProcessId(h, ctypes.byref(p))
        pid = p.value

    proc = proc_name(pid) if pid else ''
    qq_hwnd = 0
    a = sys.argv
    if '--qq-hwnd' in a:
        i = a.index('--qq-hwnd')
        if i + 1 < len(a):
            try:
                qq_hwnd = int(a[i + 1])
            except ValueError:
                pass

    out = {
        'ok': True,
        'hwnd': h,
        'title': title,
        'cls': cls,
        'pid': pid,
        'proc': proc,
        'isQQ': bool(qq_hwnd) and h == qq_hwnd,
        'isUAC': ('用户帐户控制' in title) or ('用户账户控制' in title) or ('User Account Control' in title) or (proc.lower() == 'consent.exe'),
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
