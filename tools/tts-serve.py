#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
常驻 TTS 服务 —— **一个进程服务所有 QQ 号**（2026-10-22 重构）

## 为什么要改
实测 **单套 IndexTTS 就吃 7.6 GB 显存**（`nvidia-smi` 看到 python 进程 7647 MB），
而 8 GB 卡**装不下一套以上** ⇒ 两个号各起一套 ⇒ 推理峰值爆显存 ⇒ 慢到 240 秒超时 ✗
（用户现场：「我早打开了啊」「感觉比刚才更慢了」「合成超时 ⇒ 改发文字」）

`IndexTTS2.infer(spk_audio_prompt=…)` 的**音色是每次请求传的** ⇒
完全可以**一个进程按请求切音色**，两个号轮流用同一份模型 ✓

## 两种模式
### ① HTTP 模式（**现在主用**）
```
python tts-serve.py --http 9876
POST http://127.0.0.1:9876/tts
  {"text":"啊？","out":"C:/x.wav","voice":"C:/.../anon_ref_raw.wav",
   "vec":"none","emo_alpha":0.5}
→ {"ok":true,"file":"C:/x.wav","dur":1.8,"ms":16000}
GET  http://127.0.0.1:9876/ping   → {"ok":true,"ready":true,"load":71.2}
```
⚠️ 推理**串行**（一把锁），绝不会两个请求同时抢显存 ✓

### ② stdin 模式（保底，兼容老代码）
```
{"text":"…","out":"…","vec":[…]}
→ {"ok":true,"file":"…","dur":1.8}
```

## 用法
```
# 由 src/group-voice.js 自动拉起（detached，活过机器人重启）
python tools/tts-serve.py --http 9876 --idle 1800
```
`--idle`：空闲多少秒自己退出（默认 1800 = 半小时）。
⚠️ 给太小 ⇒ 频繁冷启动（每次 90 秒）；给太大 ⇒ 一直占着 7.6 GB，视频管线要抢。
"""
import argparse
import json
import os
import socket
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ⚠️⚠️ 必须在 import torch **之前**设（和 saki-tts.py 同一个坑）：
#    8 GB 显存跑 IndexTTS 会把显存吃满 ⇒ WDDM 分页到内存 ⇒ 慢 96 倍
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
os.environ.setdefault("OMP_NUM_THREADS", "8")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# 默认情绪：**平静偏冷 + 一点点厌恶**（给祥子调的；爱音那边传 vec:"none" 覆盖）
DEFAULT_VEC = [0.05, 0.0, 0.0, 0.0, 0.12, 0.0, 0.0, 0.83]


def acquire_singleton(tag):
    """
    **跨进程单例锁** —— 抢不到就说明已经有一个 daemon 在跑，直接退出。

    ## ⚠️⚠️⚠️ 为什么非要有这个（2026-10-22 真事故）

    三个 QQ 号是**三个独立 node 进程**，`group-voice.js` 里那个 `starting` 去重
    **只在单进程内有效** ⇒ 开机时三个号同时 ping 不到 daemon ⇒ **各自 spawn 一套**
    ⇒ 实测两台 python 同时把 IndexTTS 加载进 8 GB 卡：

      `nvidia-smi` 7490 / 8188 MiB、GPU 利用率 **100%**、功耗只有 28 W
      （不是真在算，是在等 WDDM 换页）⇒ 整机卡、推理慢到 323 秒才就绪 ✗

    更阴的是 **Windows 上 `ThreadingHTTPServer` 默认 `allow_reuse_address = 1`
    ⇒ 第二个进程 bind 同一端口**不会报错**，而是把前一个的监听抢掉** ——
    两个进程都活着、都占着模型显存，只有一个能接请求（另一个只剩 CloseWait）✗

    ⇒ 唯一可靠的判据是**文件锁**：拿不到锁 = 已有实例 ⇒ `exit(0)`，
      **在 `import torch` / 加载模型之前**就退出（连内存都不占）✓
      进程被杀/崩溃时 OS 自动释放锁，残留的锁文件无害 ✓
    """
    path = os.path.join(tempfile.gettempdir(), f"tts-serve-{tag}.lock")
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        os.write(fd, b" ")
        os.lseek(fd, 0, os.SEEK_SET)
        import msvcrt
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    except OSError:
        os.close(fd)
        return None
    except ImportError:      # 非 Windows（留一手，别在这儿炸）
        try:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return None
    try:
        os.write(fd, str(os.getpid()).encode())
    except Exception:  # noqa: BLE001
        pass
    return fd


def wav_duration(path):
    try:
        with wave.open(path, "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 0.0


# ── 游戏让位（2026-10-24 加）──────────────────────────────────────────────
# 用户：「tts服务可以加一个检测到游戏启动自动退出吗，现在玩游戏很卡」
#
# 为什么必须让位：IndexTTS 常驻要占 **2.6 GB 显存**（实测）。8 GB 的卡上再开游戏，
#   两边会互相挤 ⇒ WDDM 把显存分页到系统内存 ⇒ 游戏卡成幻灯片，TTS 也慢 96 倍 ✗
#
# ## 三条实现上的讲究（都是踩过的坑）
#
# ① **认进程的可执行文件路径，不认进程名**
#    Steam 游戏都装在 `...\steamapps\common\...` 下面，这个信号很准；
#    只看 `steam.exe` 会把「开着 Steam 商店没打游戏」也判成在玩 ✗
#
# ② **让位之后要留冷却**（这一条最关键）
#    机器人那边有 warmup（启动后 45 秒预热一次），TTS 退出后它还会再来拉 ⇒
#    没有冷却就是「起 → 检测到游戏 → 退 → 再起」的死循环，每次白加载 91 秒 ✗
#    ⇒ 退出时写 `state/tts-paused.json`，暂停期内**任何启动请求直接退、连模型都不加载** ✓
#
# ③ **只在空闲时检测**
#    它自己合成语音时 GPU 也会忙，那时候检测会误判成"有游戏" ✗
#    ⇒ 只在「距上次请求超过 60 秒」时才看进程 ✓
GAME_HINTS = (
    "steamapps", "\\steam\\common", "epic games", "battle.net",
    "riot games", "\\games\\", "ubisoft", "ea games", "wegame", "\\游戏\\",
)
# 这些是**启动器 / 常驻美化软件**，开着不等于在玩游戏
# ⚠️ 2026-10-24 实测（这台机器）：`steamapps\common` 下面**不只有游戏**，
#    还装着 MyDockFinder（桌面 dock）和 Wallpaper Engine（动态壁纸）——
#    它们**一直开着**，只按路径判就会「永远认为在玩游戏」⇒ 必须先排除 ✓
GAME_SKIP = {
    # 启动器
    "steam.exe", "steamwebhelper.exe", "epicgameslauncher.exe",
    "battle.net.exe", "riotclientservices.exe", "upc.exe", "wegame.exe",
    # 常驻美化 / 壁纸 / 桌面工具（装了但不是在玩）
    "wallpaper32.exe", "wallpaper64.exe", "ui32.exe", "ui64.exe",
    "mydock.exe", "dock_64.exe", "dockmod.exe", "dockmod64.exe",
    "temperature.exe", "screenround.exe",
}


def _in_game_dir(exe):
    low = (exe or "").lower()
    return bool(low) and any(h in low for h in GAME_HINTS)


def _foreground_fullscreen_pid():
    """
    前台窗口**盖住整个屏幕**时返回它的 pid，否则 None。

    ⚠️ 为什么用"全屏"当主判据（2026-10-24）：
       `steamapps\\common` 里大量是常驻软件（壁纸、桌面 dock）——
       只按路径判会**永远判成在玩游戏** ✗
       而游戏跑起来通常是全屏的，美化软件/壁纸**不会占前台全屏** ⇒ 这个信号干净得多 ✓
       代价：**窗口化玩的游戏判不出来** —— 那种一般不吃满显存，可以接受。
    """
    try:
        import ctypes
        from ctypes import wintypes

        u = ctypes.windll.user32
        hwnd = u.GetForegroundWindow()
        if not hwnd:
            return None
        rect = wintypes.RECT()
        if not u.GetWindowRect(hwnd, ctypes.byref(rect)):
            return None
        sw = u.GetSystemMetrics(0)  # SM_CXSCREEN
        sh = u.GetSystemMetrics(1)  # SM_CYSCREEN
        w = rect.right - rect.left
        h = rect.bottom - rect.top
        # 容差 8px：边框/DWM 会让全屏窗口差几个像素
        if w < sw - 8 or h < sh - 8:
            return None
        pid = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return int(pid.value) or None
    except Exception:
        return None


def _gpu_processes():
    """
    问 NVIDIA 驱动：**现在哪些进程在用 GPU**。返回 [(pid, exe 路径)]。

    ⚠️ 为什么拿它当主信号（2026-10-24，用户提示）
       用户：「每次开游戏都会弹出 英伟达的游戏覆盖提示，可以这样判断吗」
       · 那个**提示本身**不能用 —— 它只弹几秒，而 `NVIDIA Overlay.exe` 是**常驻**的，
         拿它当"正在玩游戏"的状态判据会把一直开着 ✓ 判成一直在玩 ✗
       · 但这句话点破了一件事：**NVIDIA 驱动自己知道哪个进程是游戏**。
         而 `nvidia-smi --query-compute-apps` 能把「驱动眼里所有在用 GPU 的进程」
         （含**完整 exe 路径**）列出来 ⇒ 拿它当信号源，等于借用 NVIDIA 的判断，
         比自己按进程名猜准得多 ✓
       · 相比「前台全屏」判据的好处：**窗口化游戏也能测到**；
         游戏最小化时也照样算（它还占着显存，正是要跟它抢的那个东西）✓
    """
    try:
        import subprocess

        r = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,process_name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if r.returncode != 0:
            return []
        out = []
        for line in (r.stdout or "").splitlines():
            if "," not in line:
                continue
            left, right = line.split(",", 1)
            pid = left.strip()
            path = right.strip()
            if pid.isdigit():
                out.append((int(pid), path))
        return out
    except Exception:
        return []


JAVA_NAMES = {"javaw.exe", "java.exe"}
# java 进程吃掉超过这么多内存，就认为是在玩 MC
# ⚠️ 阈值取 2 GB：普通 Java 工具（小脚本 / 简单后端）远远到不了；
#    MC 整合包起步就 4~8 GB（用户这台实测 **11 GB**）⇒ 这个信号非常干净 ✓
JAVA_BIG_GB = 2.0


def _big_java():
    """
    有没有**吃大内存的 java 进程** —— 这是 Minecraft 最可靠的指纹。

    ⚠️ 为什么单独立这一条（2026-10-24 实测踩到）：
       用户的 MC 是 **PCL2 启动的 Java 版**，那个 `javaw.exe` 的
       `ExecutablePath` / `CommandLine` **读出来都是空的**（权限不足）⇒
       按路径判据完全失效，MC 开着的时候 TTS 照样常驻抢显存 ✗
       但**内存占用读得到**（9.8 GB）⇒ 改用内存当判据 ✓

    ⚠️ 为什么用 `tasklist` 而不是 psutil（性能实测）
       `psutil.process_iter(...)` **第一次**调用要 **7.36 秒**
       （它要把所有进程都摸一遍，含权限探测），之后才降到 0.04 秒。
       而 TTS 每次都是**新进程**，所以对"启动时判一下"这个场景永远吃那 7 秒 ✗
       ⇒ 换成 Windows 自带的 `tasklist`（按镜像名过滤，只扫 java）
         **0.3 秒左右**返回，而且直接带内存占用 ✓
       万一 tasklist 不可用（非 Windows / 被策略禁掉）→ 退回 psutil 兜底 ✓
    """
    try:
        import subprocess

        for img in ("javaw.exe", "java.exe"):
            try:
                r = subprocess.run(
                    ["tasklist", "/FI", "IMAGENAME eq " + img, "/FO", "CSV", "/NH"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except Exception:
                continue
            if r.returncode != 0:
                continue
            for line in (r.stdout or "").splitlines():
                line = line.strip()
                if not line.startswith('"'):
                    continue
                parts = [c.strip().strip('"') for c in line.split('","')]
                if len(parts) < 5:
                    continue
                raw = parts[-1].replace(",", "").replace("K", "").replace("k", "").strip()
                if not raw.isdigit():
                    continue
                gb = int(raw) / 1024 / 1024
                if gb >= JAVA_BIG_GB:
                    return (img, f"{gb:.1f} GB 内存")
    except Exception:
        pass

    # 兜底：tasklist 用不了时退回 psutil
    try:
        import psutil
    except Exception:
        return None
    for p in psutil.process_iter(["name"]):
        try:
            n = (p.info.get("name") or "").strip()
            if n.lower() not in JAVA_NAMES:
                continue
            gb = p.memory_info().rss / (1024 ** 3)
            if gb >= JAVA_BIG_GB:
                return (n, f"{gb:.1f} GB 内存")
        except Exception:
            continue
    return None


def detect_game():
    """
    有没有游戏在跑？返回 `(进程名, 路径)`，没有就 None。

    ## 判据两级：先用最准的，再兜一刀

    ① **NVIDIA 驱动眼里的 GPU 进程**里挑游戏目录的 —— 最准（窗口化游戏也算）✓
    ② 兜底再问一次「前台是不是全屏」—— 驱动偶尔列不全时补上 ✓

    ⚠️ 两条都必须排除 `GAME_SKIP`：`steamapps\common` 下面装的不只有游戏，
       这台机器上还装着 **MyDockFinder**（桌面 dock）和 **Wallpaper Engine**（动态壁纸），
       它们**一直开着、一直占 GPU**，不排除就会「永远认为在玩游戏」✗（2026-10-24 实测踩到）
    """
    me = os.getpid()

    # ① Minecraft：吃大内存的 java（最快，几百毫秒；它的路径读不到，只能靠内存）
    bj = _big_java()
    if bj:
        return bj

    # ② 驱动视角（最准，但要起一次 nvidia-smi，1~2 秒）
    for pid, path in _gpu_processes():
        if pid == me or not path:
            continue
        if "insufficient" in path.lower():
            continue
        name = os.path.basename(path)
        if name.lower() in GAME_SKIP:
            continue
        if _in_game_dir(path):
            return (name, path)

    # ③ 兜底：前台全屏 + 游戏目录
    pid = _foreground_fullscreen_pid()
    if pid and pid != me:
        try:
            import psutil

            p = psutil.Process(pid)
            name = (p.name() or "").strip()
            exe = (p.exe() or "").strip()
        except Exception:
            return None
        if exe and name.lower() not in GAME_SKIP and _in_game_dir(exe):
            return (name, exe)
    return None


# ── ComfyUI 让位（2026-11-07 加，用户：「**加让位机制**」）────────────────
# ⚠️ 为什么需要：TTS 一个进程就吃 **7.4GB 内存 + 显存**，而 ComfyUI 加载 SDXL 又要
#    「5~6GB 显存 + 4GB 内存」，两个一起跑必然有一个被拆到硬盘页面文件上 ——
#    实测出图从 **44 秒变成 564 秒**，而且 TTS 这边也跟着超时 ✗
# ⇒ ComfyUI 一开就让位（它的 HTTP 端口在听就是"在用"），关掉之后下次自动回来 ✓
COMFY_PORT = int(os.environ.get("QQBOT_COMFY_PORT") or 8188)


def detect_comfy():
    """ComfyUI 在跑吗（它的 HTTP 端口在听就算）。

    判据用「端口」而不是进程名：用户出图时会自己把它启动起来，端口一开一关
    就是最干净的使用信号；进程名/路径各人装法不同，反而不稳 ✓
    ⚠️ `QQBOT_COMFY_PORT=0` = 关掉这套探测（ComfyUI 常开一整天、不想让它顶掉语音时用）✓
    """
    if COMFY_PORT <= 0:
        return False
    s = None
    try:
        s = socket.create_connection(("127.0.0.1", COMFY_PORT), timeout=0.6)
        return True
    except Exception:
        return False
    finally:
        try:
            if s is not None:
                s.close()
        except Exception:
            pass



def _pause_file():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "state", "tts-paused.json"))


def read_pause():
    """现在是不是"游戏期间"？返回还要暂停多少秒（0 = 不暂停）"""
    try:
        with open(_pause_file(), "r", encoding="utf-8") as f:
            j = json.load(f)
        return max(0, int(j.get("until", 0)) - time.time())
    except Exception:
        return 0


def read_pause_reason():
    """让位的原因（写日志用；读不到就返回空串）"""
    try:
        with open(_pause_file(), "r", encoding="utf-8") as f:
            return str(json.load(f).get("reason") or "")
    except Exception:
        return ""


def set_pause(seconds, reason="检测到游戏在跑"):
    """记一笔"让位到什么时候"，避免 warmup 反复把它拉起来"""
    try:
        p = _pause_file()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(
                {"until": time.time() + seconds, "at": time.time(), "reason": reason},
                f,
            )
        os.replace(tmp, p)
    except Exception:
        pass


def reply(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def do_infer(tts, req, default_voice, lock):
    """一次合成。**加锁**：推理必须串行，两个请求同时跑必爆显存 ✗"""
    text = str(req.get("text") or "").strip()
    out = str(req.get("out") or "").strip()
    if not text or not out:
        return {"ok": False, "err": "缺 text / out"}
    voice = str(req.get("voice") or "").strip() or default_voice
    if not voice or not os.path.isfile(voice):
        return {"ok": False, "err": f"音色文件不存在：{voice}"}
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    # ⚠️ 2026-10-22 用户：「太抑扬顿挫了，和小学生读课文一样」
    #   根因：每句都强制传 emo_vector = DEFAULT_VEC（给祥子调的）⇒ 盖掉参考音频情绪 ✗
    #   ⇒ `vec: "none"` 或 `[]` = 不传向量（情感跟参考音频走）✓
    raw_vec = req.get("vec")
    use_none = (isinstance(raw_vec, str) and raw_vec.lower() == "none") or (isinstance(raw_vec, list) and len(raw_vec) == 0)
    emo_vec = None if use_none else [float(x) for x in (raw_vec or DEFAULT_VEC)]

    kw = {}
    if req.get("emo_alpha") is not None:
        kw["emo_alpha"] = max(0.0, min(2.0, float(req["emo_alpha"])))
    # ⚠️ duration_factor 是"时长因子"：**越大越长（越慢）**，别搞反了（我踩过）
    if req.get("duration_factor") is not None:
        kw["duration_factor"] = max(0.5, min(2.0, float(req["duration_factor"])))

    with lock:
        t1 = time.time()
        try:
            tts.infer(
                spk_audio_prompt=voice,
                text=text,
                output_path=out,
                lang=req.get("lang") or "ZH",
                emo_vector=emo_vec,
                use_random=False,
                verbose=False,
                **kw,
            )
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "err": f"{type(e).__name__}: {e}"}
        if not os.path.isfile(out):
            return {"ok": False, "err": "没产出文件"}
        return {"ok": True, "file": out, "dur": round(wav_duration(out), 3),
                "ms": int((time.time() - t1) * 1000)}


def serve_stdio(tts, args, lock):
    """老模式：一行一个 JSON 请求，一行一个结果"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            reply({"ok": False, "err": f"请求不是 JSON：{e}"})
            continue
        reply(do_infer(tts, req, args.voice, lock))


def serve_http(tts, args, lock):
    """HTTP 模式：多号共用"""
    state = {"last": time.time(), "ready_at": time.time()}
    load_sec = getattr(args, "_load_sec", 0.0)

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):   # 别把访问日志刷到 stderr
            pass

        def _send(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path.startswith("/ping"):
                state["last"] = time.time()
                self._send({"ok": True, "ready": True, "load": load_sec,
                            "voice": args.voice or "", "pid": os.getpid()})
            else:
                self._send({"ok": False, "err": "只支持 GET /ping 和 POST /tts"}, 404)

        def do_POST(self):  # noqa: N802
            if not self.path.startswith("/tts"):
                self._send({"ok": False, "err": "只支持 POST /tts"}, 404)
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
                req = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception as e:  # noqa: BLE001
                self._send({"ok": False, "err": f"请求不是 JSON：{e}"}, 400)
                return
            state["last"] = time.time()
            self._send(do_infer(tts, req, args.voice, lock))
            state["last"] = time.time()

    # ⚠️⚠️ `allow_reuse_address` 必须关掉：socketserver 默认在 POSIX 上是 1，
    #    而 **Windows 上 SO_REUSEADDR 是"抢占式"的** ⇒ 两个进程能绑同一端口，
    #    后绑的把前一个的监听抢走（前一个还活着、还占着显存，却接不到请求）✗
    #    关掉之后走 Windows 默认的独占语义，第二个直接 bind 失败 ⇒ 一眼看得出 ✓
    ThreadingHTTPServer.allow_reuse_address = False
    httpd = ThreadingHTTPServer(("127.0.0.1", args.http), H)
    print(f"[tts-serve] HTTP 就绪 :{args.http}（模型 {load_sec}s）", file=sys.stderr, flush=True)

    def idle_watch():
        while True:
            time.sleep(30)
            if args.idle > 0 and time.time() - state["last"] > args.idle:
                print("[tts-serve] 空闲超时，退出", file=sys.stderr, flush=True)
                httpd.shutdown()
                return

    threading.Thread(target=idle_watch, daemon=True).start()

    def game_watch():
        """检测到游戏在跑就让位（见文件头「游戏让位」那一段的注释）"""
        while True:
            time.sleep(30)
            # ③ 只在空闲时看：自己正在合成时 GPU 也忙，别误判
            if time.time() - state["last"] < 60:
                continue
            hit = detect_game()
            if not hit:
                continue
            name, exe = hit
            # ② 留冷却：机器人 warmup 还会来拉，暂停期内启动直接退
            set_pause(args.yield_pause)
            print(
                f"[tts-serve] 检测到游戏在跑（{name}）⇒ 让位退出，把显存还给游戏"
                f"；接下来 {args.yield_pause // 60} 分钟内不会再启动",
                file=sys.stderr,
                flush=True,
            )
            httpd.shutdown()
            return

    if args.yield_to_game:
        threading.Thread(target=game_watch, daemon=True).start()
        log_scan = detect_game()
        if log_scan:
            print(
                f"[tts-serve] 启动时就有游戏在跑（{log_scan[0]}）—— 本次仍会加载，"
                f"60 秒后自动让位",
                file=sys.stderr,
                flush=True,
            )

    def comfy_watch():
        """ComfyUI 一起来就让位（见文件头「ComfyUI 让位」那段注释）"""
        while True:
            time.sleep(20)
            # ③ 只在空闲时看：自己正在合成时显存也忙，别把"我在干活"误判成"要出图"
            if time.time() - state["last"] < 60:
                continue
            if not detect_comfy():
                continue
            # ② 留冷却：机器人 warmup 还会来拉，暂停期内启动直接退
            set_pause(args.comfy_pause, "检测到 ComfyUI 在跑")
            print(
                f"[tts-serve] 检测到 ComfyUI 在跑（:{COMFY_PORT}）⇒ 让位退出，把显存还给出图"
                f"；接下来 {args.comfy_pause // 60} 分钟内不会再启动",
                file=sys.stderr,
                flush=True,
            )
            httpd.shutdown()
            return

    if args.yield_to_comfy:
        threading.Thread(target=comfy_watch, daemon=True).start()

    httpd.serve_forever()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="", help="默认参考音色（每请求可用 voice 覆盖）")
    ap.add_argument("--http", type=int, default=0, help="HTTP 端口（0=用 stdin 模式）")
    ap.add_argument("--model-dir", default=r"C:\IndexTTS\checkpoints")
    ap.add_argument("--idle", type=int, default=1800, help="空闲多少秒后退出（默认 1800）")
    # 游戏让位（2026-10-24 加，见文件头那段注释）
    ap.add_argument(
        "--yield-to-game", dest="yield_to_game", action="store_true", default=True,
        help="检测到游戏在跑就把显存让出来（默认开启）",
    )
    ap.add_argument(
        "--no-yield-to-game", dest="yield_to_game", action="store_false",
        help="关掉游戏让位（游戏时也想让她能说话才用）",
    )
    ap.add_argument(
        "--yield-pause", type=int, default=900,
        help="让位之后多少秒内不再启动（默认 900 = 15 分钟，防 warmup 反复拉起）",
    )
    # ComfyUI 让位（2026-11-07 加，见文件头那段注释）
    ap.add_argument(
        "--yield-to-comfy", dest="yield_to_comfy", action="store_true", default=True,
        help="ComfyUI 一开（:8188 在听）就把显存让出来（默认开启）",
    )
    ap.add_argument(
        "--no-yield-to-comfy", dest="yield_to_comfy", action="store_false",
        help="关掉 ComfyUI 让位（出图时也想让她能说话才用，实测两边会一起慢到不能用）",
    )
    ap.add_argument(
        "--comfy-pause", type=int, default=300,
        help="ComfyUI 让位后多少秒内不再启动（默认 300 = 5 分钟）",
    )
    ap.add_argument("--cpu", action="store_true")
    args = ap.parse_args()

    if not args.http and not args.voice:
        print("要么给 --http，要么给 --voice（stdin 模式必须有默认音色）", file=sys.stderr)
        sys.exit(2)

    # ⚠️⚠️ **让位期间直接退**（游戏 2026-10-24 / ComfyUI 2026-11-07）—— 放在抢锁之前，
    #    这样连单例锁都不用碰，更省事；`read_pause()` 是 watch 线程退出时写的，
    #    目的是挡住机器人的 warmup 反复把它拉起来（每次白加载 91 秒）✗
    #    ⚠️ 这条对**两种让位都生效**：只看"现在有没有让位"，不管它是谁写的 ✓
    if args.yield_to_game or args.yield_to_comfy:
        _left = read_pause()
        if _left > 0:
            _why = read_pause_reason() or "资源被占用"
            print(
                f"[tts-serve] 让位中（{_why}，还有 {_left // 60} 分 {_left % 60} 秒）"
                f"⇒ 本次不加载模型，直接退出",
                file=sys.stderr,
                flush=True,
            )
            sys.exit(0)

    if args.yield_to_game:
        # ⚠️⚠️ 暂停可能**已经过期但游戏还在玩**（玩了两个多小时就会这样）——
        #    如果不在启动前再确认一次，warmup 会把模型加载进显存 91 秒，
        #    60 秒后才被 game_watch 发现并退出 ⇒ 白白跟游戏抢了两分半的显存 ✗
        #    ⇒ 启动前**直接问一次驱动**，有游戏就当场让位（连模型都不 import）✓
        _g = detect_game()
        if _g:
            set_pause(args.yield_pause)
            print(
                f"[tts-serve] 启动前就检测到游戏在跑（{_g[0]}）⇒ 不加载模型，直接退出；"
                f"接下来 {args.yield_pause // 60} 分钟内不再启动",
                file=sys.stderr,
                flush=True,
            )
            sys.exit(0)

    # ⚠️⚠️ **ComfyUI 在跑就直接退**（2026-11-07 加）—— 同样的道理：抢锁/加载模型之前先问端口，
    #    端口在听就说明用户正在出图，这时候把 7.4GB 挤进去 ⇒ 两边一起卡死（出图 564 秒）✗
    if args.yield_to_comfy and detect_comfy():
        set_pause(args.comfy_pause, "检测到 ComfyUI 在跑")
        print(
            f"[tts-serve] ComfyUI 在跑（:{COMFY_PORT} 在听）⇒ 本次不加载模型，直接退出；"
            f"接下来 {args.comfy_pause // 60} 分钟内不再启动",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(0)

    # ⚠️⚠️ **必须在 import torch 之前抢单例锁** —— 抢不到就立刻走，一克显存都别占。
    #    三个号并发拉起时，这里挡住第二、第三个（见 acquire_singleton 的注释）
    lock_fd = None
    if args.http:
        lock_fd = acquire_singleton(args.http)
        if lock_fd is None:
            print(f"[tts-serve] :{args.http} 已经有一个 daemon 在跑 ⇒ 这个实例直接退出（不加载模型）",
                  file=sys.stderr, flush=True)
            sys.exit(0)

    try:
        import torch
        from indextts.infer_v2_5 import IndexTTS2
    except Exception as e:  # noqa: BLE001
        print(f"[tts-serve] 导入失败：{e}", file=sys.stderr)
        sys.exit(3)

    use_cuda = torch.cuda.is_available() and not args.cpu
    t0 = time.time()
    try:
        tts = IndexTTS2(
            cfg_path=os.path.join(args.model_dir, "config.yaml"),
            model_dir=args.model_dir,
            use_bf16=use_cuda,
            device=None if use_cuda else "cpu",
            use_cuda_kernel=False,
            use_qwen_emo=False,   # 省 1.1 GB，别开（开了慢 96 倍）
        )
    except Exception as e:  # noqa: BLE001
        print(f"[tts-serve] 模型加载失败：{type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(4)

    load_sec = round(time.time() - t0, 1)
    args._load_sec = load_sec
    print(f"[tts-serve] 模型就绪（{load_sec}s，{'cuda' if use_cuda else 'cpu'}）",
          file=sys.stderr, flush=True)
    lock = threading.Lock()

    if args.http:
        serve_http(tts, args, lock)
    else:
        # 就绪信号（stdin 模式靠这行知道可以发活了）
        reply({"ok": True, "ready": True, "load": load_sec})
        serve_stdio(tts, args, lock)


if __name__ == "__main__":
    main()
