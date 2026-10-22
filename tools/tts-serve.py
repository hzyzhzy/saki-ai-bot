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
    httpd.serve_forever()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="", help="默认参考音色（每请求可用 voice 覆盖）")
    ap.add_argument("--http", type=int, default=0, help="HTTP 端口（0=用 stdin 模式）")
    ap.add_argument("--model-dir", default=r"C:\IndexTTS\checkpoints")
    ap.add_argument("--idle", type=int, default=1800, help="空闲多少秒后退出（默认 1800）")
    ap.add_argument("--cpu", action="store_true")
    args = ap.parse_args()

    if not args.http and not args.voice:
        print("要么给 --http，要么给 --voice（stdin 模式必须有默认音色）", file=sys.stderr)
        sys.exit(2)

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
