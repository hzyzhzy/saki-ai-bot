# -*- coding: utf-8 -*-
"""最小常驻服务：验证 `anode exec` 起的进程能不能一直活着 + 能不能被外部看到。

## 为什么要先验这个
用户要求「改常驻进程」——想摆脱「每次 `anode exec` 都要 2~3 秒」的开销。
QuitBot 能做到 `interval=1.0` 秒，是因为它的采集器**常驻在座位里**；
我们是每次起一个短命脚本，光是进程启动 + UIA 初始化就吃掉了 2~3 秒。

要改常驻，第一个必须确认的前提是：
**`anode exec` 起的进程，在 exec 返回之后还能继续跑吗？**
如果不行为（比如 exec 结束会连带杀掉子进程），整个方案就得换。

## 这个脚本做什么
写一个时间戳文件，然后**每秒追加一行**，跑 25 秒。
外面在 exec 返回之后去看那个文件有没有继续长 —— 长就是在跑。
"""

import os
import sys
import time

OUT = os.path.join(os.environ.get("TEMP", r"C:\Temp"), "qq-daemon-probe.log")


def main():
    sec = 25
    for i in range(50):
        if "--sec" in sys.argv:
            sec = int(sys.argv[sys.argv.index("--sec") + 1])
            break
    t0 = time.time()
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("start pid=%d %s\n" % (os.getpid(), time.strftime("%H:%M:%S")))
        f.flush()
    n = 0
    while time.time() - t0 < sec:
        time.sleep(1)
        n += 1
        try:
            with open(OUT, "a", encoding="utf-8") as f:
                f.write("tick %d pid=%d %s\n" % (n, os.getpid(), time.strftime("%H:%M:%S")))
        except Exception:
            pass
    print("DAEMON_DONE ticks=%d file=%s" % (n, OUT))


if __name__ == "__main__":
    main()
