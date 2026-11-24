# -*- coding: utf-8 -*-
"""常驻读取服务 v4：**只读视口内的会话 + 摘要驱动**。

## 历史（都是实测踩出来的）
· 短命 `qq-read.py`（每次 anode exec）读一次 2000~3000ms；**常驻只要 375ms**（快 5~8 倍）
· 切群在常驻里 ≈ 2.5~3.3 秒（真切的代价是等 QQ 自己加载那个群），"已在里面"约 350ms
· `qp.tree(win)` 会遍历到**滚出视口的项** —— 实测切了 37 个会话，不是前 8 个
  ⇒ 必须按 `BoundingRectangle` 过滤（窗口 rect 由调用方传入）
· **不能无脑轮转**（用户：「一直在往下轮转啊」）：一圈 25 秒、没消息的群也白切
  ⇒ 改成**摘要驱动**：只切摘要变了的
· **`m.self` 必须过滤**（她自己的话被推回去会变成复读机 —— 今天就是这里爆的）

## 用法
    anode run C:\Temp\dbenv\Scripts\python.exe tools\qq-daemon.py --hwnd 198002 --port 6701
"""

import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

import uiautomation as auto

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LOG_PATH = os.path.join(ROOT, "logs", "qq-daemon.log")

SEEN = set()
SEEN_CAP = 6000
SESSION_SIG = {}
# ⚠️ 2026-11-18 提速：daemon 认为界面**当前停在哪个群**。
#    用来跳过"已经在那个群还要再切一次"（do_switch 即使已在也要 350~450ms）。
#    ⚠️ 只在**切群成功 + header 校验通过**之后才写它；校验不过立刻清空 ✓
CURRENT_GROUP = ""
SESSION_KIND = {}
BASELINE_GROUPS = set()
# ⚠️⚠️ 2026-11-18 加：**基线要落盘**。
#    原来只在内存 ⇒ daemon 每次重启（含自愈重启 QQ）所有群都当"第一次见"
#    ⇒ 每个群的前若干条消息被「只记不推」吞掉 ✗
#    实测：重启 daemon 后发的那条测试消息就这么丢了（日志 `基线：「…」20 条（只记不推）`）。
#    落盘之后重启也知道"这个群建过基线" ⇒ 新消息照常推 ✓
BASELINE_FILE = os.path.join(ROOT, "state", "qq-baseline.json")


def load_baseline():
    try:
        with open(BASELINE_FILE, encoding="utf-8") as _f:
            _v = json.load(_f)
        return set(str(x) for x in _v) if isinstance(_v, list) else set()
    except Exception:
        return set()


def save_baseline():
    try:
        with open(BASELINE_FILE, "w", encoding="utf-8") as _f:
            json.dump(sorted(BASELINE_GROUPS), _f, ensure_ascii=False)
    except Exception:
        pass
LAST_SWITCH = {}
POKE_SEEN = {}  # 戳去重：key(群|发起人|动作|目标|后缀) → 上次推的时间戳
# ⚠️⚠️ 2026-11-19 改（用户：「戳一戳的描述还不够完善」+ 实测反复戳没反应）——
#    原来这是个 **set**（永久去重）⇒ 同一个人**反复戳同一个动作**，
#    第二次起永远被吞掉（实测：23:34 那次 Anon 又捏了一下，daemon 日志干干净净）✗
#    但也不能全推：daemon 每轮读的是屏幕上**所有**灰字，旧戳一直在那儿 ⇒ 会反复推 ✗
#    ⇒ 改成**按 key 记时间戳 + 冷却窗口**：窗口内去重（防同一行被读很多遍），
#      超过窗口就允许再推（"他又戳了一次"是合法事件）✓
POKE_COOLDOWN_SEC = 45.0
SWITCH_COOLDOWN_SEC = 5.0
# 空转多少轮之后点一下卡片强制刷新（约 25 秒，每轮约 0.6s）
IDLE_REFRESH_ROUNDS = 40
_idle_rounds = 0
# 适配器发消息时创建它 ⇒ daemon 暂停切群，把界面让给发送方（省掉每轮 2.5~3.3 秒的切群）
HOLD_PATH = os.path.join(ROOT, "state", "daemon-hold")
# 握手（2026-11-17 21:20）：适配器要发消息时写 "切到 X 群"，daemon 切好回写确认
SWITCH_REQ = os.path.join(ROOT, "state", "daemon-switch-to")
SWITCH_ACK = os.path.join(ROOT, "state", "daemon-switched")
HOLD_STALE_SEC = 15.0
# 落盘：daemon 读到的**所有**消息（不只是推的）—— bot 补看直接查这个文件
SEEN_LOG = os.path.join(ROOT, "state", "qq-seen.jsonl")
SEEN_LOG_MAX = 300  # 超过就删最老的，只留最新 300 条
# ⚠️⚠️ 2026-11-21 加（「历史要定时清」）——
#    只按条数裁的问题：不活跃的群能在这 300 条里躺几个月，而被挤掉的都是
#    活跃群的近况；图片文件更是只增不减 ✗
#    ⇒ 再加一条**按时间**的：超过这么多小时的记录直接删，连带删它的图片 ✓
#    24 小时 = 补看只关心"今天聊了什么"，再老的对她也用不上
SEEN_KEEP_HOURS = 24.0
# 图片也落盘（用户：「图片也要能保存下来」）—— 裁帧存这里
IMG_DIR = os.path.join(ROOT, "state", "qq-img")  # 已经建过基线的群（每个群只建一次，防重启后把历史当新消息推）  # 会话名 → group/private（来自 parse_item，下一版用它替代名字猜）


def arg(name, default=""):
    a = sys.argv
    for i, x in enumerate(a):
        if x == "--" + name and i + 1 < len(a):
            return a[i + 1]
    return default


def log(msg):
    line = "%s %s" % (time.strftime("%H:%M:%S"), msg)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_mod(fname, modname):
    path = os.path.join(HERE, fname)
    spec = importlib.util.spec_from_file_location(modname, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def post(port, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        "http://127.0.0.1:%d/push" % port,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.status


def visible_sessions(qp, win, qs):
    """**视口内**的会话项 → [(name, summary)]。

    ⚠️ `qp.tree(win)` 会把滚出视口的项也带出来（实测 37 个 vs 可见 10 来个）
    ⇒ 必须用 BoundingRectangle 过滤。窗口 rect `[52,28,1282,712]` 是实测值。
    """
    try:
        wr = win.BoundingRectangle
        win_top, win_bottom = wr.top, wr.bottom
    except Exception:
        win_top, win_bottom = 0, 10**6

    # ⚠️⚠️ 2026-11-18 提速（优化全链路耗时）——
    #    `qp.tree(win)` 默认深度 22 ⇒ 840 节点、**375ms/轮**，而每轮都要读一次，
    #    把轮询周期从设计值 0.6 秒拖到 1.5 秒（心跳实测 156 秒 / 100 轮）✗
    #    实测对照（同一时刻连读，逐条比对结果完全一致）：
    #      md=22 → 375ms、15 个会话
    #      md=18 → **135ms**、15 个会话
    #      md=16 →  57ms、15 个会话（也一致，但离会话项只有 1~2 层，留点余量）
    #    会话项在第 13 层、内容 16~17 层 ⇒ 深度 18 够用且安全 ✓
    nodes = qp.tree(win, 18)
    out = []
    _n = 0
    for d, c in nodes:
        if qp.CLS_ITEM not in qp.cls_of(c):
            continue
        _n += 1
        try:
            r = c.BoundingRectangle
        except Exception:
            continue
        # 只认**整项都在窗口内**的（压在边界上的也不要）
        if r.top < win_top or r.bottom > win_bottom:
            continue
        # ⚠️ 摘要 / 名字 / 类型全部交给 qq-sessions.py 的 parse_item ——
        #    它已经过滤掉时间戳（TIME_RE）、等级徽章（BADGE_RE）、未读数字、成员数括号。
        #    v4 自己拼整行文本 ⇒ 这些都会抖 ⇒ 同一个群每轮都判"摘要变了" ⇒ 反复切 ✗
        try:
            it = qs.parse_item(c)
        except Exception as e:
            it = None
        if not it:
            continue
        nm = str(it.get("name") or "").strip()
        if not nm:
            continue
        out.append((nm, str(it.get("summary") or ""), str(it.get("kind") or "")))
    # 去重保序
    seen = set()
    uniq = []
    for nm, sm, kd in out:
        if nm in seen:
            continue
        seen.add(nm)
        uniq.append((nm, sm, kd))
    return uniq


def save_image(group, who, text, rect):
    """把图片消息按屏幕矩形裁一帧存下来，返回相对路径（失败返回空串）。

    ⚠️ 不用子进程 `qq-grab-image.py`（每条 2~3 秒），常驻进程里直接 PIL 裁，毫秒级。
    ⚠️ `rect[1] < 0` = 已经滚出视口，截不到（和适配器那边判断一致）。
    """
    try:
        import hashlib

        from PIL import ImageGrab

        if not rect or len(rect) != 4:
            return ""
        l, t, r, b = [int(x) for x in rect]
        if t < 0 or r <= l or b <= t:
            return ""
        try:
            os.makedirs(IMG_DIR, exist_ok=True)
        except Exception:
            pass
        h = hashlib.md5(("%s|%s|%s|%s" % (group, who, text, l)).encode("utf-8")).hexdigest()[:16]
        path = os.path.join(IMG_DIR, h + ".png")
        if os.path.isfile(path):
            return "qq-img/" + h + ".png"
        img = ImageGrab.grab(bbox=(l, t, r, b), all_screens=True)
        img.save(path, "PNG")
        log("图片已存：qq-img/%s.png（%dx%d）" % (h, r - l, b - t))
        return "qq-img/" + h + ".png"
    except Exception as e:
        log("存图失败：" + str(e)[:70])
        return ""


def append_seen(group, got):
    """返回 {key: img相对路径}（给推送 batch 用，省得适配器再裁一次）。"""
    """把这一轮读到的消息**全部**追加进 `state/qq-seen.jsonl`（按 群|谁|正文 去重）。

    ⚠️ 不做"只记新的"—— 用户要的是"历史一直在落盘"，这样 bot 补看不用再读界面。
    ⚠️ 超过 SEEN_LOG_MAX 就保留最新 N 条重写（原子替换，避免写一半崩掉）。
    """
    if not got:
        return {}
    img_map = {}
    try:
        # 已有内容
        lines = []
        keys = set()
        if os.path.isfile(SEEN_LOG):
            with open(SEEN_LOG, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    k = (obj.get("g"), obj.get("w"), obj.get("t"))
                    if k in keys:
                        continue
                    keys.add(k)
                    lines.append(line)
        # 追加本轮的
        added = 0
        for key, m in got:
            who = str(m.get("who") or "").strip()
            text = str(m.get("text") or "").strip()
            kind0 = str(m.get("kind") or "")
            # ⚠️⚠️⚠️ 2026-11-21 修（「截屏放进聊天历史」）——
            #    `qq-read.py` 里写着「**纯图片 / 纯文件没有正文，text 是空的**」，
            #    而这里原来是 `if not who or not text: continue`
            #    ⇒ **纯图片消息 text 空 ⇒ 整条被跳过** ⇒ 既没落盘、更没存图 ✗
            #    实测：seen.jsonl 300 条里带 img 的 **0 条**，`state/qq-img/` 里**一个文件都没有** ✗
            #    ⇒ 图片消息**必须有占位文本**才能进历史（也是她读历史时能看见"这儿有张图"）
            if not text and kind0 == "image":
                text = "[图片]"
            if not who or not text:
                continue
            k = (group, who, text)
            if k in keys:
                continue
            keys.add(k)
            # 图片：按屏幕矩形裁一帧存下来，路径记进 jsonl（用户：「图片也要能保存下来」）
            img_rel = ""
            if str(m.get("kind") or "") == "image":
                img_rel = save_image(group, who, text, m.get("rect"))
                if img_rel:
                    img_map[key] = img_rel
            lines.append(
                json.dumps(
                    {
                        "g": group,
                        "w": who,
                        "t": text,
                        "at": bool(m.get("at") or m.get("atMe")),
                        "self": bool(m.get("self")),
                        "q": m.get("quote") or "",
                        "img": img_rel,
                        "ts": int(time.time()),
                    },
                    ensure_ascii=False,
                )
            )
            added += 1
        if not added:
            return img_map
        # ⚠️⚠️ 2026-11-21 加**按时间清理**（「历史要定时清」）——
        #    原来只按条数裁（`SEEN_LOG_MAX = 300`）⇒ 一个不活跃的群能在里面躺几个月，
        #    而被挤掉的都是活跃群的近况 ✗ 而且图片文件**只增不减**（越攒越多）✗
        #    ⇒ 两条一起做：
        #      ① 超过 `SEEN_KEEP_HOURS` 小时的行**删掉**；
        #      ② 被删掉那些行带的图片文件**一起删**（`state/qq-img/` 不留孤儿）。
        #    ⚠️ 只清理**已经写进去的旧行**；本轮新增的一律保留（刚发生的不能丢）✓
        dropped = 0
        dropped_imgs = []
        try:
            cutoff = time.time() - SEEN_KEEP_HOURS * 3600
            kept = []
            for line in lines:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                ts = float(o.get("ts") or 0)
                if ts and ts < cutoff:
                    dropped += 1
                    im = str(o.get("img") or "")
                    if im:
                        dropped_imgs.append(im)
                    continue
                kept.append(line)
            lines = kept
        except Exception as e:
            log("按时间清理出错（不影响本轮写入）：" + str(e)[:70])
        # 超限裁剪（条数兜底）
        if len(lines) > SEEN_LOG_MAX:
            lines = lines[-SEEN_LOG_MAX:]
        tmp = SEEN_LOG + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        os.replace(tmp, SEEN_LOG)
        # 删掉不再被任何一行引用的图片文件
        try:
            if dropped_imgs:
                still = set()
                for line in lines:
                    try:
                        im = str((json.loads(line) or {}).get("img") or "")
                    except Exception:
                        continue
                    if im:
                        still.add(im)
                gone = 0
                for im in dropped_imgs:
                    if im in still:
                        continue
                    fp = os.path.join(ROOT, "state", im.replace("/", os.sep))
                    try:
                        if os.path.isfile(fp):
                            os.remove(fp)
                            gone += 1
                    except Exception:
                        pass
                if gone:
                    log("图片清理：删了 %d 个旧图" % gone)
        except Exception as e:
            log("清理图片出错：" + str(e)[:60])
        log(
            "落盘 %d 条（共 %d 行，上限 %d；按时间清了 %d 条 / 保留 %.1f 小时）"
            % (added, len(lines), SEEN_LOG_MAX, dropped, SEEN_KEEP_HOURS)
        )
    except Exception as e:
        log("落盘失败：" + str(e)[:80])
    return img_map


def poke_refresh_card(win):
    """用**真鼠标**点一下当前会话卡片，逼 QQ 刷新会话列表。

    用户实测（2026-11-17 20:50）：QQ 界面会"卡住不更新"，手动点一下卡片就刷新了。
    ⚠️ 必须真鼠标事件（`mouse_event`）—— UIA 的 Invoke 不触发 QQ 那套刷新逻辑。
    """
    try:
        import ctypes

        u = ctypes.windll.user32
        try:
            wr = win.BoundingRectangle
        except Exception:
            return False
        # 会话列表在窗口左侧；点第一张卡片的位置（左侧 x≈200、顶部往下 120）
        x = int(wr.left + 200)
        y = int(wr.top + 120)
        u.SetCursorPos(x, y)
        time.sleep(0.05)
        u.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
        time.sleep(0.03)
        u.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
        log("（空转 %d 轮，真鼠标点卡片强制刷新 @%d,%d）" % (_idle_rounds, x, y))
        time.sleep(0.5)
        return True
    except Exception as e:
        log("点卡片失败：" + str(e)[:70])
        return False


def someone_is_sending():
    """适配器正在发消息吗？是 ⇒ 本轮什么都别做，把界面让给它。

    ⚠️ 超时保护：适配器崩了没删文件的话，超过 HOLD_STALE_SEC 就自己清掉，
    否则 daemon 会永久停摆。
    """
    try:
        if not os.path.isfile(HOLD_PATH):
            return False
        age = time.time() - os.path.getmtime(HOLD_PATH)
        if age > HOLD_STALE_SEC:
            try:
                os.remove(HOLD_PATH)
            except Exception:
                pass
            log("hold 文件超过 %.0f 秒，已清理（发送方可能崩了）" % age)
            return False
        return True
    except Exception:
        return False


# ---- QQ 自愈（2026-11-17 加）------------------------------------------------
# 真事故：QQ 的渲染进程死掉以后，**画面冻在最后一帧、点击/滚轮/resize 全无反应，
# 而 UIA 树只剩左半边** —— 会话列表 26 项都在，`chat-header` 和
# `ExEditor-qq-msg-editor` 全缺席，树到 22 层就断（396 节点 vs 正常 1071）。
# 症状是「群里新消息读不到」+「发送报找不到输入框」，但截图看着一切正常 ✗
# 实测重启 QQ 就能恢复（自动登录，不用扫码；起来后等约 6 秒树才建完整）。
# ⇒ 所以：① hwnd 不再写死（每次重启都会变），② 瞎了就自己重启。
QQ_EXE = r"C:\Program Files\Tencent\QQNT\QQ.exe"
# ⚠️⚠️ 2026-11-19 加（用户：「A，要不然图片看不清」）——
#    座位分辨率会**自己掉回 1280x720**，实测原因是 anode 的机制：
#      `anode display 1920x1080` 的返回值原话：
#      「It lasts until your lease ends … which restore 1280x720 at 100%」
#      「startup 1280x720 at 100%; **releasing the lease that changed it restores it**」
#    ⇒ 租约一到期分辨率就回落。而图片是**裁屏存的**（`save_image`），
#      1280 宽下消息气泡被压缩、裁出来糊 ⇒ 用户看不清 ✗
#    ⚠️ 试过直接用 Windows API（ChangeDisplaySettingsW）改：**返回 0 说成功，但
#      GetSystemMetrics 一点没变** —— RDP 会话里本地改分辨率会被忽略 ✗
#    ⇒ 只能走 anode CLI。好在**座位里能直接调**（实测拿到同一个 leaseToken ✓），
#      所以 daemon 自己定期续租 + 必要时重设就够了 ✓
ANODE_EXE = r"<本机用户目录>\AppData\Local\Programs\Anode\anode.exe"
WANT_W, WANT_H = 1920, 1080


def keep_display(log_fn):
    """续租 + 把分辨率保持成 1920x1080（anode 的 display 绑租约，到点会回落）。

    ⚠️⚠️ 2026-11-21 修（**daemon 卡死 40 分钟的真凶**）——
    原来这里**无条件**先跑 `anode lease acquire`（timeout=30），尺寸不对再跑
    `anode display`（timeout=45）。而它每 200 轮就被调一次 ⇒ 只要有一个 anode
    子进程挂住（座位里调主机 CLI，租约过期/后端忙时实测会挂住），
    **整个 daemon 主循环就永久停住** ✗✗
    实测现场：01:34:23 之后日志一个字都不再写，进程活着、40 分钟只用了 34 秒 CPU
    ⇒ 所有群消息既不落盘也不推 ⇒ bot 当然"读不到聊天历史"。
    ⇒ 现在：**先用 ctypes 查尺寸**（纯本地、不可能阻塞）；尺寸本来就对时
      **一次子进程都不起**、直接返回 ✓；只有真的不对才调 anode，超时压到 20/25 秒，
      而且任何异常都只记一行、绝不向上抛 ✓
    """
    try:
        import ctypes

        _w = ctypes.windll.user32.GetSystemMetrics(0)
        _h = ctypes.windll.user32.GetSystemMetrics(1)
    except Exception:
        return
    if _w == WANT_W and _h == WANT_H:
        return  # ✓ 本来就好，零子进程

    log_fn("保持分辨率：当前 %dx%d → 改成 %dx%d" % (_w, _h, WANT_W, WANT_H))
    tok = ""
    try:
        r = subprocess.run([ANODE_EXE, "--agent", "dsh", "lease", "acquire", "--ttl", "600"],
                           capture_output=True, text=True, timeout=20)
        try:
            tok = (json.loads(r.stdout or "{}") or {}).get("leaseToken") or ""
        except Exception:
            tok = ""
    except Exception as e:
        log_fn("保持分辨率：拿租约失败/超时（%s）⇒ 跳过" % str(e)[:60])
        return
    if not tok:
        log_fn("保持分辨率：拿不到 leaseToken ⇒ 跳过")
        return
    try:
        subprocess.run([ANODE_EXE, "--agent", "dsh", "--lease", tok, "display",
                        "%dx%d" % (WANT_W, WANT_H)],
                       capture_output=True, text=True, timeout=25)
        log_fn("保持分辨率：已请求改成 %dx%d" % (WANT_W, WANT_H))
    except Exception as e:
        log_fn("保持分辨率：改分辨率失败/超时（%s）⇒ 下次再试" % str(e)[:60])
RESTART_COOLDOWN_SEC = 600.0
BLIND_WINDOW = 10               # 看最近多少次检查
BLIND_TRIGGER = 6               # 其中多少次"读不到"就重启（不清零的滑动窗口，用户 2026-11-18 定的 A 方案）
BLIND_FLAG = os.path.join(ROOT, "state", "qq-blind.flag")  # 报警标记：有它 = 判过"瞎"、正在重启
# ⚠️⚠️ 2026-11-21 加（用户：「卡死了要自动重启」）——
#    daemon 自己卡死时**它自己检测不到**（主循环已经停了），必须靠外部看门狗。
#    这个文件就是给看门狗看的：主循环**每轮开头**摸一下它，
#    看门狗发现它超过 N 秒没更新 ⇒ daemon 卡死 ⇒ 杀掉重起 ✓
#    用 os.utime 只改时间戳（不写内容），开销几十微秒 ✓
HEARTBEAT_PATH = os.path.join(ROOT, "state", "daemon-heartbeat")


def touch_heartbeat():
    try:
        with open(HEARTBEAT_PATH, "a"):
            pass
        os.utime(HEARTBEAT_PATH, None)
    except Exception:
        pass
_last_restart = 0.0


def find_qq_window():
    """找 QQ 主窗口。**不认 hwnd** —— 它每次重启都会变。"""
    try:
        for w in auto.GetRootControl().GetChildren():
            try:
                if "Chrome_WidgetWin" not in (w.ClassName or ""):
                    continue
                if not (w.Name or "").startswith("QQ"):
                    continue
                r = w.BoundingRectangle
                if (r.right - r.left) > 400:
                    return w
            except Exception:
                continue
    except Exception:
        pass
    return None


def qq_tree_blind(win, qp, tries=1):
    """树是不是"瞎了"：会话列表大概还在，但聊天区（header + 输入框）整个不见了。

    ⚠️ 判据取"两样都没有"才叫瞎 —— 只缺一样可能只是没打开会话，别乱重启。
    ⚠️ `tries` 默认 **1**（2026-11-18 改）：原来默认 3 连读（3 × 0.9 秒 = 2.7 秒），
       而它每 20 轮就跑一次 ⇒ 平均每轮多 135ms，把轮询周期从 0.6 秒拖到 1.5 秒，
       **直接拖慢整条链路**（实测 T0→摘要变化 5.2 秒）。
       现在靠滑动窗口（6/10）容忍偶发误判，单次读就够 ✓
    """
    for i in range(tries):
        try:
            # ⚠️ 2026-11-18：深度 24 → 18（实测 489ms → 123ms）。
            #    只关心 header/editor 在不在，实测它们分别在第 13 / 17 层 ⇒ 18 够 ✓
            nodes = qp.tree(win, 18)
            if nodes:
                has_ed = qp.find_one(nodes, qp.CLS_EDITOR) is not None
                has_hdr = qp.find_one(nodes, qp.CLS_HEADER) is not None
                if has_ed or has_hdr:
                    return False
        except Exception:
            pass
        if i < tries - 1:
            time.sleep(0.7)
    return True


def restart_qq(log_fn):
    """重启 QQ，返回新的窗口对象；失败返回 None。"""
    global _last_restart
    now = time.time()
    if now - _last_restart < RESTART_COOLDOWN_SEC:
        log_fn("自愈：%.0f 秒前刚重启过，这次不重启（防死循环）" % (now - _last_restart))
        return None
    _last_restart = now

    old = find_qq_window()
    pid = 0
    if old is not None:
        try:
            pid = int(old.ProcessId or 0)
        except Exception:
            pid = 0
    if pid:
        log_fn("自愈：杀掉 QQ pid=%d（只杀这一个进程树，不碰别的号）" % pid)
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, timeout=30)
        except Exception as e:
            log_fn("自愈：taskkill 出错 " + str(e)[:70])
    else:
        log_fn("自愈：找不到 QQ 窗口，直接尝试启动")
    time.sleep(4)

    log_fn("自愈：重新启动 QQ")
    try:
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP：别跟着 daemon 的输出句柄走
        subprocess.Popen([QQ_EXE], creationflags=0x00000008 | 0x00000200, close_fds=True)
    except Exception as e:
        log_fn("自愈：启动失败 " + str(e)[:80])
        return None

    for i in range(40):
        time.sleep(1.0)
        w = find_qq_window()
        if w is not None:
            log_fn("自愈：QQ 窗口回来了（等了 %d 秒）hwnd=%d" % (i + 1, w.NativeWindowHandle or 0))
            # ⚠️ 起来后 UIA 树要几秒才建完整（实测 6 秒后才从 13 节点变成 1071 节点）
            time.sleep(6)
            return w
    log_fn("自愈：40 秒没等到 QQ 窗口，放弃")
    return None


def handle_switch_req(win, qp, log_fn):
    """适配器的握手：替它切到目标群，成功就写 ack 并删请求。返回切到哪个群（没做就返回空串）。

    ⚠️⚠️ 2026-11-19 抽成函数（用户：「发送速度还是很慢」）——
    **必须能在那 15 秒的 hold 期间也响应**。
    原来握手段在 hold 检查**之后**，而发送时 hold 一直存在（适配器写的）
    ⇒ daemon 每轮直接 `continue` ⇒ **握手永远没机会执行** ✗
    ⇒ 适配器等满窗口（我先设 8 秒、后改 3 秒）→ 超时 → "走老路自己切"（再 3 秒）
    ⇒ 实测一条消息 `📤 发送 → ✅ 已发出` 要 **11~17 秒**，而 qq-py.py 内部只占 2.4 秒 ✗✗
    现在 hold 分支和正常分支都会先调它 ✓
    """
    try:
        if not os.path.isfile(SWITCH_REQ):
            return ""
        with open(SWITCH_REQ, encoding="utf-8") as _f:
            _want = _f.read().strip()
        if not _want:
            return ""
        _t0 = time.time()
        _ok, _ = qp.do_switch(win, _want, quiet=True)
        _ms = round((time.time() - _t0) * 1000)
        if not _ok:
            log_fn("握手：切不到「%s」%dms" % (_want, _ms))
            return ""
        with open(SWITCH_ACK, "w", encoding="utf-8") as _f:
            _f.write(_want)
        log_fn("握手：替发送方切到「%s」%dms" % (_want, _ms))
        # ⚠️ 切完自己删请求：daemon 0.2 秒一轮比适配器轮询还快，
        #    不删的话同一批会连切好几次（实测 5 次 ≈ 2.6 秒）
        try:
            os.remove(SWITCH_REQ)
        except Exception:
            pass
        return _want
    except Exception as _e:
        log_fn("握手出错：" + str(_e)[:70])
        return ""


def main():
    global SEEN, _idle_rounds, CURRENT_GROUP
    hwnd = int(arg("hwnd", "0") or 0)
    port = int(arg("port", "6701") or 6701)
    me = arg("me", "Saki")

    qp = load_mod("qq-py.py", "qq_py_mod")
    qs = load_mod("qq-sessions.py", "qq_sessions_mod")
    reader = load_mod("qq-read.py", "qq_read_mod")
    reader.ME_NAME = me

    # hwnd 不再写死（QQ 每次重启都会变）：传了就试，不可用/没传就自己找
    win = None
    if hwnd:
        try:
            win = auto.ControlFromHandle(hwnd)
        except Exception as e:
            log("hwnd=%d 不可用：%s" % (hwnd, str(e)[:70]))
            win = None
    if win is None:
        win = find_qq_window()
        if win is not None:
            log("自动找到 QQ 窗口 hwnd=%d" % (win.NativeWindowHandle or 0))
    if win is None:
        log("找不到 QQ 窗口（QQ 可能没开）")
        print(json.dumps({"ok": False, "error": "no_window"}, ensure_ascii=False))
        return 1
    hwnd = int(win.NativeWindowHandle or 0)

    log("daemon v4 启动 pid=%d hwnd=%d port=%d（视口内 + 摘要驱动 + 自愈）" % (os.getpid(), hwnd, port))

    # ⚠️ 2026-11-18：把上次跑记下的"已建基线的群"读回来（不然重启后每个群又吞一批消息）
    try:
        _b = load_baseline()
        if _b:
            BASELINE_GROUPS.update(_b)
            log("已恢复 %d 个群的基线" % len(_b))
    except Exception as _e:
        log("恢复基线失败 " + str(_e)[:60])

    # ⚠️⚠️ 2026-11-18 加：**启动时如果界面上没打开会话（右侧空白），先 Invoke 打开一个**。
    #    QQ 重启 / 刚登录之后就是这样：登录成功、会话列表也在，但右侧是空白
    #    ⇒ 每一轮都读不到聊天区 ⇒ 什么都推不出来（还会被自愈判成"瞎了"）。
    #    ⚠️ 只在"确实没有 header 也没有输入框"时才动，正常启动一个字都不碰 ✓
    try:
        _probe = qp.tree(win, 18)
        if qp.find_one(_probe, qp.CLS_HEADER) is None and qp.find_one(_probe, qp.CLS_EDITOR) is None:
            _sess0 = visible_sessions(qp, win, qs)
            if _sess0:
                qp.do_switch(win, _sess0[0][0], quiet=True)
                CURRENT_GROUP = _sess0[0][0]
                log("启动：界面上没打开会话，已用 Invoke 打开「%s」" % _sess0[0][0])
            else:
                log("启动：界面上没打开会话，而且读不到会话列表")
    except Exception as _e:
        log("启动：检查/打开会话失败 " + str(_e)[:70])

    rounds = 0
    pushed = 0
    switched = 0
    fail = 0
    blind_hist = []   # 最近几次自愈检查的结果（True = 读不到聊天区）
    while True:
        t_round = time.time()
        # ⚠️ 每轮开头摸一次心跳文件（看门狗靠它判断我是不是卡死了）
        touch_heartbeat()
        try:
            # ⚠️⚠️ 2026-11-19 **hold 检查提到最前面**（用户报：「一条拆成 3 条的消息
            #    发很久，而且中途一直在切窗口，锁根本没生效一样」）。
            #    原来它在"自愈检查 + 握手"**之后** ⇒ 发送期间 daemon 还在读树、
            #    还会响应握手去切群 ⇒ 跟发送抢界面 ✗
            #    （另一半原因在适配器那边：hold 每条消息写完就删，条与条之间的空档
            #      正好够 daemon 插进来 —— 那边已改成"整批延迟 6 秒释放"✓）
            #    ⚠️ 这里 continue 时 `rounds` 不涨是故意的：那 15 秒（HOLD_STALE_SEC）
            #      过后 hold 会被自动清掉，一切照旧 ✓
            if someone_is_sending():
                # ⚠️⚠️ 2026-11-19：**hold 期间也要响应握手** ——
                #    那是发送方自己的请求（它要的就是先把界面切好再发）。
                #    不响应的话它会等超时、然后"走老路自己切"（再 3 秒）
                #    ⇒ 实测一条消息 11~17 秒，而真正的发送只占 2.4 秒 ✗
                _w = handle_switch_req(win, qp, log)
                if _w:
                    CURRENT_GROUP = _w
                time.sleep(0.15)
                continue

            # ---- 保持分辨率 1920x1080（每 200 轮 ≈ 2 分钟续一次租，租约 600 秒够）----
            #    ⚠️ 尺寸本来就对时这步只续租、什么都不改（几乎零成本）✓
            #    ⚠️ 真需要改的那一次会让 QQ 重排 ⇒ 当轮可能报"读不到聊天区"，下一轮自己恢复
            if rounds % 200 == 0:
                keep_display(log)

            # ---- 自愈：每 20 轮查一次"聊天区还在不在"（QQ 渲染死了树会只剩左半边）----
            # ⚠️⚠️ 2026-11-18 改判据（用户定的 A 方案：**滑动窗口累计，不是连续**）：
            #    实测 QQ 这个毛病是**间歇性**的 —— 瞎两下、好一下、再瞎两下，
            #    日志原文：`1/10 → 2/10 → 正常了，清零 → 1/10 → 2/10 …` 永远攒不满 ✗
            #    而每次盲区约 16~30 秒，正好漏掉@她的消息（用户就是这么丢过一条 @）。
            #    ⇒ 改成"**最近 10 次检查里有 6 次读不到**就重启"，间歇性也判得出来 ✓
            if rounds % 20 == 0:
                _blind = qq_tree_blind(win, qp)
                # ⚠️⚠️ 2026-11-19 加（用户报：「anode 那边又没反应了」）——
                #    **读不到先别急着判"瞎"，先重新找一次窗口句柄**。
                #    实测真因：座位重建 / RDP 重连 / 改分辨率之后，QQ 的**顶层窗口句柄会变**
                #    （8455716 → 5703222），而 daemon 只在启动时找一次窗口
                #    ⇒ 拿着失效句柄去读一个不存在的窗口 ⇒ 永远"读不到" ✗
                #    ⇒ 自愈每 10 分钟重启一次 QQ，但**重启根本不解决问题**（问题不在 QQ），
                #      日志原文：`自愈：最近 10 次检查里有 10 次读不到…` 之后
                #      `565 秒前刚重启过，这次不重启（防死循环）` 无限重复 ✗✗
                #    ⇒ 先比一下"当前真实窗口"的句柄，不一样就换过去再判 ✓
                if _blind:
                    _neww = find_qq_window()
                    _newh = 0
                    try:
                        _newh = int(_neww.NativeWindowHandle or 0) if _neww is not None else 0
                    except Exception:
                        _newh = 0
                    if _newh and _newh != hwnd:
                        log("自愈检查：窗口句柄变了（%d → %d）⇒ 换过去，不算瞎" % (hwnd, _newh))
                        win = _neww
                        hwnd = _newh
                        CURRENT_GROUP = ""
                        SESSION_SIG.clear()
                        _blind = qq_tree_blind(win, qp)
                        if not _blind:
                            log("自愈检查：换过句柄后能读到了 ✓")
                blind_hist.append(_blind)
                if len(blind_hist) > BLIND_WINDOW:
                    blind_hist.pop(0)
                _bad = sum(1 for x in blind_hist if x)
                if _blind:
                    log("自愈检查：读不到聊天区（窗口内 %d/%d 次失败，需 %d 次）"
                        % (_bad, len(blind_hist), BLIND_TRIGGER))
                elif _bad:
                    log("自愈检查：这轮正常（窗口内仍 %d/%d 次失败）" % (_bad, len(blind_hist)))
                if len(blind_hist) >= BLIND_WINDOW and _bad >= BLIND_TRIGGER:
                    log("自愈：最近 %d 次检查里有 %d 次读不到聊天区 ⇒ 判定 QQ 瞎了，重启它"
                        % (len(blind_hist), _bad))
                    blind_hist.clear()
                    try:
                        with open(BLIND_FLAG, "w", encoding="utf-8") as _f:
                            _f.write(time.strftime("%Y-%m-%d %H:%M:%S"))
                    except Exception:
                        pass
                    newwin = restart_qq(log)
                    if newwin is not None:
                        win = newwin
                        hwnd = int(win.NativeWindowHandle or 0)
                        SESSION_SIG.clear()
                        # ⚠️ 重启 QQ 后界面全重建 ⇒ "当前在哪个群"的记忆作废，必须清
                        CURRENT_GROUP = ""
                        # ⚠️ 2026-11-18：**不再清 BASELINE_GROUPS**。
                        #    那会让每个群重新"先记不推"，重启后头几条消息又被吞 ✗
                        #    群还是那些群，基线当然还有效 ✓
                        LAST_SWITCH.clear()
                        log("自愈：已切到新窗口 hwnd=%d，等下一轮重新建摘要基线" % hwnd)
                        # ⚠️⚠️ 2026-11-18 加（用户：「加」）——
                        #    QQ 重启后**会自动登录，但不打开任何会话** ⇒ 右侧一片空白
                        #    ⇒ 下一轮照样读不到聊天区 ⇒ 10 分钟后又重启 ⇒ **死循环**。
                        #    ⇒ 重启成功后用 **Invoke 打开第一个可见会话**。
                        #    ⚠️ 用 Invoke（纯控件调用），**不用鼠标** —— 用户明确说过：
                        #      「已经在那个会话之后再点击一次那个会话，也会导致右边变空白」✗
                        try:
                            _sess = visible_sessions(qp, win, qs)
                            if _sess:
                                qp.do_switch(win, _sess[0][0], quiet=True)
                                log("自愈：重启后已用 Invoke 打开「%s」，聊天区有内容了" % _sess[0][0])
                            else:
                                log("自愈：重启后读不到会话列表（先空跑一轮再看）")
                        except Exception as _e:
                            log("自愈：重启后打开会话失败 " + str(_e)[:70])
            # ⚠️ 2026-11-17 21:20 握手：适配器要发消息，先替它切到目标群。
            #    ⚠️ 2026-11-19：逻辑抽到 `handle_switch_req()` 了 —— hold 期间也要能响应 ✓
            _w2 = handle_switch_req(win, qp, log)
            if _w2:
                CURRENT_GROUP = _w2

            # ⚠️ 2026-11-19：hold 检查已经提到循环最前面（见上面），这里不用再判一次 ✓
            sess = visible_sessions(qp, win, qs)

            # ⚠️ 2026-11-19：hold 检查已经提到循环最前面（见上面），这里不用再判一次 ✓
            sess = visible_sessions(qp, win, qs)
            if not sess:
                time.sleep(1.0)
                continue

            first_round = not SESSION_SIG
            changed = []
            for nm, summary, kd in sess:
                prev = SESSION_SIG.get(nm)
                SESSION_SIG[nm] = summary
                if first_round:
                    continue
                if prev is not None and prev != summary:
                    hot = bool(re.search(r"\[有人@我\]|@Saki|Saki酱", summary))
                    # ⚠️ 日志：直接看清每轮谁被判成变了、为什么（别再靠猜）
                    log("摘要变化「%s」：%r → %r hot=%s" % (nm, (prev or "")[:26], (summary or "")[:26], hot))
                    # 冷却：同一群 5 秒内不再切（hot 的例外 —— @她必须立刻）
                    age = time.time() - LAST_SWITCH.get(nm, 0)
                    if not hot and age < SWITCH_COOLDOWN_SEC:
                        log("  …「%s」冷却中（%.1fs 前刚切过，跳过）" % (nm, age))
                        continue
                    changed.append((0 if hot else 1, nm))
                    _idle_rounds = 0
                # 记下 kind（下一版改私聊判据要用）
                if kd:
                    SESSION_KIND[nm] = kd
            if first_round:
                log("摘要基线：%d 个可见会话（不切、不推）" % len(SESSION_SIG))
                rounds += 1
                time.sleep(0.6)
                continue

            if not changed:
                _idle_rounds += 1
                # ⚠️⚠️ 2026-11-18 **停用**「空转太久就真鼠标点一下卡片」。
                #    用户实测（原话）：「**当已经在那个会话之后再点击一次那个会话，
                #    也会导致右边变空白**」——
                #    而这里点的是 (左列+200, 顶部+120)，正好是第一张会话卡片；
                #    界面本来就停在那张卡上时，再点一下 ⇒ 右侧被点空 ⇒
                #    `message-panel` 变成 `empty-panel` ⇒ 读不到 header/输入框 ⇒
                #    「间歇性瞎」就是这么来的（日志里 1/2 次失败 → 正常 → 再失败，
                #    周期约 25 秒，正好是 IDLE_REFRESH_ROUNDS=40 轮）。
                #    ⇒ 不再点卡片。需要聊天气泡时用 Invoke 开会话（见自愈那段）。
                if _idle_rounds >= IDLE_REFRESH_ROUNDS:
                    _idle_rounds = 0
                rounds += 1
                if rounds % 100 == 0:
                    log("心跳 rounds=%d 切群=%d 推送=%d 失败=%d 可见=%d（无变化，不切）"
                        % (rounds, switched, pushed, fail, len(sess)))
                cost = time.time() - t_round
                # ⚠️ 2026-11-18：轮询间隔 0.6 → 0.2（读树已从 375ms 降到 135ms，负担得起）。
                #    这是**消息到达延迟的主项**：间隔多长，平均就多等一半。
                #    下限 0.08 秒防"读树比 sleep 还快"时空转烧 CPU ✓
                time.sleep(max(0.08, 0.2 - cost))
                continue

            changed.sort()
            log("本轮候选（%d）：%s" % (len(changed), ", ".join(n + ("(hot)" if k == 0 else "") for k, n in changed[:6])))
            target = changed[0][1]
            target_is_hot = changed[0][0] == 0
            t0 = time.time()
            try:
                # ⚠️⚠️ 2026-11-19 **回退「已在目标群就跳过切群」**——
                #    那项优化能省 350~450ms，但实测**副作用大于收益**：
                #    `CURRENT_GROUP` 记的和界面实际**会不一致**（典型场景：适配器等不到
                #    握手 ack、走"老路自己切群"，把界面切走了，daemon 这边毫不知情）
                #    ⇒ 日志原文：`已在「示例服务器 2026」，跳过切群` 紧接着
                #      `⚠️ 切群没生效（要到「示例服务器 2026」，实际「[示例服务器外群] 示例群」）
                #       ⇒ 跳过本轮` —— **整轮白跑、还可能漏消息** ✗
                #    掉 400ms 换这个风险不值得 ⇒ 老实每次切（do_switch 已有"已在该群就快速返回"）。
                ok, _nodes = qp.do_switch(win, target, quiet=True)
                ms = round((time.time() - t0) * 1000)
                if not ok:
                    log("切不到「%s」%dms（跳过）" % (target, ms))
                    time.sleep(0.3)
                    continue
                # ⚠️⚠️ 2026-11-17 20:40：**`do_switch` 说 ok 不等于真的切过去了**。
                #    实测：判对了 示例服务器 2026、do_switch 返回成功，但界面还在「湖工」，
                #    于是把湖工的 4 条推出去、用户那条 @Saki 反倒没推 ✗
                #    ⇒ 必须自己复查 `chat-header`。
                _hdr = ""
                for _d, _c in reader.walk(win, 0, 34):
                    if "chat-header" in reader.cls_of(_c):
                        _hdr = reader.name_of(_c)
                        if _hdr:
                            break
                if _hdr and target not in _hdr and _hdr not in target:
                    log("⚠️ 切群没生效（要到「%s」，实际「%s」）⇒ 跳过本轮，不推错群内容" % (target, _hdr))
                    CURRENT_GROUP = ""   # ⚠️ 校验不过 ⇒ 清掉"当前群"记忆，下一轮老实切
                    time.sleep(0.4)
                    continue
                switched += 1
                LAST_SWITCH[target] = time.time()
                CURRENT_GROUP = target   # ⚠️ 校验通过才记（这样跳过切群是安全的）
                log("切到「%s」%dms（摘要变了）" % (target, ms))
                # ⚠️⚠️ 2026-11-17 19:17（用户：「切过去之后什么反应都没有就切到其他群了」）：
                #    QQ 切群是异步的 —— `chat-header` 先换、消息列表要几百毫秒才填上。
                #    切完**立刻读**会拿到 0 个 message-container ⇒ got 空 ⇒ 什么都不推 ✗
                #    ⇒ 轮询等消息容器出现（最多 2.5 秒）
                # ⚠️⚠️ 2026-11-18 改判据（用户报：「最近两条又没回」）——
                #    原来只要**存在 1 个** message-container 就 break ⇒ 但切群那一瞬间
                #    **上一个群的气泡还在**，条件立刻满足 ⇒ 读到的是**旧内容** ⇒
                #    全被 `SEEN` 去重 ⇒ `got` 空 ⇒ 一条都不落盘、不推 ✗
                #    实测（02:50:28 的 `@Saki服务器有人吗` / 02:51:24 的 `@Saki在吗`）：
                #    daemon 从摘要里看到了（hot=True）、也切了群，但 `state/qq-seen.jsonl`
                #    里**根本没有这两条** ⇒ 她当然不会回 ✗
                #    ⇒ 改成等「消息容器**数量稳定**」（连续两次相同才算渲染完）。
                waited = 0.0
                _last_n = -1
                while waited < 3.0:
                    _n = 0
                    for _d, _c in reader.walk(win, 0, 34):
                        _k = reader.cls_of(_c)
                        if "message-container" in _k and "message-container__avatar" not in _k:
                            _n += 1
                    if _n >= 1 and _n == _last_n:
                        break
                    _last_n = _n
                    time.sleep(0.3)
                    waited += 0.3
                if waited:
                    log("  （等消息渲染 %.2fs）" % waited)
            except Exception as e:
                log("切群异常（%s）：%s" % (target, str(e)[:70]))
                time.sleep(0.5)
                continue

            # 读这个会话
            nodes = reader.walk(win, 0, 34)
            group = ""
            for d, c in nodes:
                if "chat-header" in reader.cls_of(c):
                    group = reader.name_of(c)
                    if group:
                        break
            # ⚠️⚠️ 2026-11-17：**不要再用 `chat-header` 名字里有没有 `(人数)` 判群** ——
            #    Name 属性常常只有群名、不带括号（括号是界面另外渲染的）⇒
            #    所有群都会被判成私聊 ⇒ 一条都推不出去（实测 `跳过 9 条（…不是群）`）✗
            #    改用 `parse_item` 给的 kind：有成员数/有「XXX：」摘要 ⇒ group，都没有 ⇒ private
            is_group = SESSION_KIND.get(target, "") != "private"
            if SESSION_KIND.get(target) in ("group", "unknown"):
                is_group = True
            # 灰字提示（戳一戳就在这儿）
            j_tips = []
            for d, c in nodes:
                if "gray-tip-message" in reader.cls_of(c):
                    try:
                        t = reader.parse_gray_tip(c)
                    except Exception:
                        t = None
                    if t:
                        j_tips.append(t)
            got = []
            for d, c in nodes:
                k = reader.cls_of(c)
                if "message-container" not in k or "message-container__avatar" in k:
                    continue
                try:
                    m = reader.parse_message(c)
                except Exception:
                    continue
                if not m:
                    continue
                who = str(m.get("who") or "").strip()
                text = str(m.get("text") or "").strip()
                if not who or not text:
                    continue
                got.append(("%s|%s|%s" % (group, who, text), m))

            # ⚠️ 2026-11-17 19:58（用户：「戳一戳没回」）：
            #    戳一戳不在 message-container 里，是**灰字提示**（`gray-tip-message`）。
            #    `qq-read.py` 的 `parse_gray_tip()` 早就解析好了（含 `toMe`），
            #    但 daemon 从来没读过它 ⇒ 整条链路断的。
            # ⚠️⚠️ 2026-11-17 20:40（用户：「那段时间根本没有戳啊」）：
            #    `j_tips` 是**屏幕上所有灰字**，包括很早以前的旧戳（灰字一直留在消息流里）。
            #    `POKE_SEEN` 只在内存 ⇒ daemon 一重启就清空 ⇒ 又把旧戳全推一遍 ✗
            #    ⇒ **只取最后一条**（最新那条灰字才是刚发生的），并且给 20 秒的新鲜度门槛。
            pokes = []
            _cand = [t for t in j_tips if t.get("toMe") and not t.get("fromMe")]
            if _cand:
                t = _cand[-1]  # 按屏幕顺序最后一条 = 最新
                k_poke = "%s|%s|%s|%s" % (group, t.get("who"), t.get("action"), t.get("suffix"))
                # ⚠️⚠️⚠️ 2026-11-21 修（**这是「爱音一直不回消息」的直接原因**）——
                #    `POKE_SEEN` 之前从 `set` 改成了 `dict`（要按 key 记时间戳，
                #    解决"同一个人反复戳同一动作，第二次起永远被吞"），
                #    但**这里还在调 `.add()`** ⇒ 每轮读消息都抛
                #    `'dict' object has no attribute 'add'` ⇒ **整轮读消息中断** ✗✗
                #    实测：07:24:54 报错之后，心跳里 `推送=21` 再也不涨 ⇒ 她一条都收不到 ✗
                #    ⇒ 改成按 key 存时间戳 + 冷却窗口：
                #      窗口内去重（防空转重复推同一行灰字），超过就允许再推（"他又戳了一下"是合法事件）✓
                _now = time.time()
                if _now - float(POKE_SEEN.get(k_poke) or 0) > POKE_COOLDOWN_SEC:
                    POKE_SEEN[k_poke] = _now
                    # ⚠️⚠️ 2026-11-19 补齐字段（用户：「戳一戳的描述还不够完善，
                    #    要传给 bot 完整的戳一戳动作，比如捏了一下 Saki 的脸」）——
                    #    原来只传 `who` + `action`（"<主人>" + "捏了捏"）⇒
                    #    bot 只知道"捏了捏"，**不知道捏的是谁、捏了什么部位** ✗
                    #    `parse_gray_tip` 其实早就拆好了 target / suffix / text，这里没转发 ✗
                    #    ⇒ 全传；并且把界面上的「你」换成「Saki」——
                    #      「<主人> 捏了捏 你 的 脸」对模型来说是含糊的，
                    #      「<主人> 捏了捏 Saki 的 脸」它才知道被捏的是自己 ✓
                    _who = str(t.get("who") or "")
                    _act = str(t.get("action") or "")
                    _tgt = str(t.get("target") or "")
                    _suf = str(t.get("suffix") or "")
                    _me = re.sub(r"^(你|Saki|saki)$", "Saki", _tgt.strip()) if _tgt else ""
                    _full = (_who + _act + (_me or _tgt) + _suf).strip() or str(t.get("text") or "")
                    pokes.append(
                        {
                            "group": group,
                            "who": _who,
                            "action": _act,
                            "target": _me or _tgt,
                            "suffix": _suf,
                            # 完整一句话（"<主人>捏了捏Saki的脸"）—— bot 侧优先用它
                            "text": _full,
                        }
                    )
            if pokes:
                try:
                    post(port, {"group": group, "messages": [], "pokes": pokes})
                    log("推了 %d 个戳 → %s（%s）" % (len(pokes), "HTTP 200", group))
                except Exception as e:
                    log("推戳失败：" + str(e)[:70])

            # 落盘：这一轮读到的**所有**消息都记下来（bot 补看直接查文件，不用再读界面）
            # 返回值是 {key: 图片相对路径} —— 推送时带上，适配器直接用，不重复裁
            img_map = append_seen(group, got)

            # ⚠️⚠️ 2026-11-17：**每个群各自建一次基线** ——
            #    这里原来没有这道判断（v5 补丁把它吞了）⇒ 每切到一个新群，
            #    那个群的**全部历史**都被当新消息推给 bot ⇒ 她逐条判断逐条回
            #    ⇒ 用户看到「怎么又一直在发啊」✗✗
            #    而且 `SEEN` 只在内存 ⇒ 重启后必然重推一遍，所以基线必须按群记。
            # ⚠️⚠️ 2026-11-17 19:26（自测定位：「第一次切到那个群时新消息被当历史吞了」）：
            #    **HOT 的群不走基线** —— 她就是被 @ 了才切过来的，那些消息必须推。
            #    只有普通群才"先记不推"（防重启后把历史全推一遍）。
            if target_is_hot and group not in BASELINE_GROUPS:
                # ⚠️⚠️ HOT 首次切到某群：**只推最新那 2 条**，其余当历史记掉。
                #    19:26 的现场：跳过基线后把 19 条全推了 ⇒ 她把「@Saki」「@Saki 在吗」
                #    这些早就回过的老消息和新的合并成一组回 ⇒ 用户「又还在推很久之前的消息」✗
                #    @她的一定是最新那条，老的不该再推。
                if len(got) > 2:
                    for key, _m in got[:-2]:
                        SEEN.add(key)
                    log("HOT 首次：「%s」记掉前 %d 条历史，只推最后 2 条" % (group, len(got) - 2))
                BASELINE_GROUPS.add(group)
                save_baseline()
                batch = []
            if group not in BASELINE_GROUPS:
                for key, _m in got:
                    SEEN.add(key)
                BASELINE_GROUPS.add(group)
                save_baseline()
                log("基线：「%s」%d 条（只记不推）" % (group, len(got)))
                batch = []
            else:
                batch = []
            for key, m in got:
                if key in SEEN:
                    continue
                SEEN.add(key)
                if m.get("self"):
                    continue
                batch.append(
                    {
                        "group": group,
                        "who": str(m.get("who") or ""),
                        "text": str(m.get("text") or ""),
                        "atMe": bool(m.get("at") or m.get("atMe")),
                        "kind": str(m.get("kind") or "text"),
                        "y": m.get("y"),
                        "rect": m.get("rect"),
                        "img": img_map.get(key, ""),
                    }
                )
            if batch and is_group:
                try:
                    st = post(port, {"group": group, "messages": batch})
                    pushed += len(batch)
                    log("推了 %d 条 → HTTP %s（%s）" % (len(batch), st, group))
                except Exception as e:
                    fail += 1
                    log("推送失败（%d）：%s" % (fail, str(e)[:80]))
            elif batch:
                log("跳过 %d 条（「%s」不是群）" % (len(batch), group))
            if len(SEEN) > SEEN_CAP:
                SEEN = set(list(SEEN)[-3000:])
        except Exception as e:
            log("读出错：" + str(e)[:100])
        rounds += 1
        if rounds % 100 == 0:
            log("心跳 rounds=%d 切群=%d 推送=%d 失败=%d 摘要=%d"
                % (rounds, switched, pushed, fail, len(SESSION_SIG)))
        cost = time.time() - t_round
        # ⚠️ 2026-11-18：和上面那条一起改（0.6 → 0.2）。这里是**切群/推送那一轮**的尾巴，
        #    同样直接影响下一条消息的检测延迟 ✓
        time.sleep(max(0.08, 0.2 - cost))


if __name__ == "__main__":
    sys.exit(main())
