# -*- coding: utf-8 -*-
"""`anode run` 的包装器：把一切错误都落到文件里，再去看。

## 为什么需要
`qq-daemon.py` 用 `anode exec`（前台）跑得起来：`daemon v2 启动` → `基线：8 条`。
但 `anode run`（fire-and-forget）起不来 —— `anode jobs` 里根本没这个 job，
而且 `run` 不返回 stdout，看不到它到底怎么死的。

所以包一层：
· 先把 stderr/stdout 重定向到 `logs/qq-daemon-launch.log`
· `os.chdir` 到 tools 目录（daemon 用 `__file__` 找 `qq-read.py`，工作目录不对就 import 失败）
· 整个 main 包 try/except，把 traceback 全写进文件
"""

import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LAUNCH_LOG = os.path.join(ROOT, "logs", "qq-daemon-launch.log")


def log(msg):
    try:
        with open(LAUNCH_LOG, "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass


def main():
    log("launcher 启动 pid=%d argv=%s" % (os.getpid(), sys.argv[1:]))
    try:
        os.chdir(HERE)
        log("chdir → " + os.getcwd())
    except Exception as e:
        log("chdir 失败：" + str(e))

    # 把 daemon 拉起来（同进程，出错就在这层捕获）
    try:
        log("即将 exec qq-daemon.py")
        daemon = os.path.join(HERE, "qq-daemon.py")
        log("存在性: %s" % os.path.isfile(daemon))
        g = {"__name__": "__main__", "__file__": daemon}
        code = open(daemon, encoding="utf-8").read()
        log("读源码 %d 字节，开始执行" % len(code))
        exec(compile(code, daemon, "exec"), g)
        log("daemon 返回了（正常应该永不返回）")
    except SystemExit as e:
        log("daemon SystemExit: %s" % (e.code,))
    except Exception:
        log("daemon 抛异常：\n" + traceback.format_exc())


if __name__ == "__main__":
    main()
