/**
 * 群聊里的**语音发言**（2026-10-22 要求；同日改成「共享 TTS daemon」）
 *
 * ## 用户原话
 *   「现在可以把 bot 在群里的部分发言改成语音了，可以挑选语气词或情绪比较重的小部分消息
 *     转为语音发送。然后要加兜底，**没生成出要照常按文字消息发送出去**」
 *
 * ## 谁决定哪句转语音
 *   ⚠️⚠️ **她自己决定，代码不许猜**（AGENTS 铁律：工具只能由她调，代码不许用关键词替她判断）。
 *   ⇒ 两条路：思考链调 `[工具:语音]`（整条）或正文标 `[语音]…[/语音]`（一小截）
 *
 * ## ⚠️⚠️⚠️ 2026-10-22 重构：**一个 TTS daemon 服务所有号**
 *
 * 老做法是**每个号各 spawn 一套** `tts-serve.py`（stdio 长连接）。实测炸了：
 *   · `nvidia-smi` 看到**单个 python 进程就吃 7647 MB**，8 GB 卡**装不下一套以上**；
 *   · 两个号同时预热 ⇒ 显存 93% ⇒ 推理峰值爆掉 ⇒ **合成卡满 240 秒超时** ⇒ 退回文字 ✗
 *     （用户现场：「我早打开了啊」「感觉比刚才更慢了」）
 *
 * `IndexTTS2.infer(spk_audio_prompt=…)` 的音色是**每次请求传的** ⇒ 完全可以一个进程按请求切音色 ✓
 * ⇒ 现在：**共享一个 HTTP daemon**（`tts-serve.py --http 9876`），所有号都 POST 它。
 *
 * 顺带解决两件事：
 *   ① **换音色不用重起进程**了（以前 `refChanged()` 要杀掉重载，换一次等 90 秒）
 *   ② daemon 用 `detached` 起 ⇒ **活过机器人重启**（重启机器人不再连带重载模型）
 *
 * ## 兜底（用户明确要求）
 *   合成失败 / 超时 / daemon 起不来 ⇒ **那段照常当文字发出去**，绝不能让消息凭空消失 ✗
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// ⚠️ 2026-10-21：`config` 要用来读 `voice.ref`（**按号私有** ⇒ 每个 QQ 号能有自己的音色）
import { ROOT, config } from './config.js';
import { log } from './log.js';

/** IndexTTS 的安装目录（模块和 venv 都在这儿） */
const IDX_ROOT = String(process.env.INDEX_TTS_ROOT || '').trim() || 'C:\\IndexTTS';
/** 合成产物放这儿（临时文件，定时清理会带走） */
const OUT_DIR = join(ROOT, 'logs', 'bili', 'group-voice');

/** ⚠️ **共享 daemon 的端口**（所有号都连这个；改端口只改这一处） */
const HTTP_PORT = Number(process.env.QQBOT_TTS_PORT || 9876);
/** daemon 空闲多少秒退出 —— ⚠️ 给大了会一直占 7.6 GB（视频管线要抢），给小了频繁冷启动 */
const IDLE_SEC = Number(process.env.QQBOT_TTS_IDLE || 1800);

/**
 * 单句合成超时。
 *
 * ⚠️⚠️ 2026-11-07 改（用户：「**一条语音都没发出来啊**」）——
 *    原来写死 **60 秒**，注释说「第一句 24 秒、之后 16 秒 ⇒ 2.5 倍余量」，
 *    那是**daemon 已经热透之后**的数字。实测冷启动第一次是这样的：
 *      · 模型加载 23~69 秒（`TTS daemon 就绪（69s，模型 23.6s）`）
 *      · **然后第一次合还要做 torch 首次编译** —— 17:26:10 那次就在这儿卡满 60 秒
 *        ⇒ 「合成失败：合成超时（60s）⇒ 改发文字」✗
 *    ⇒ 第一次必然失败、退回文字；等 daemon 真热了，她已经按「一小时一两次」不再标语音了
 *      ⇒ **一条语音都发不出来**。
 *    现在：**默认 150 秒**（够冷启动 + 首次编译），可用 `QQBOT_TTS_TIMEOUT` 覆盖。
 *    ⚠️ 别调小 —— 小了就是"每次都发文字、永远没有语音"。
 */
const SYNTH_TIMEOUT_MS = Math.max(30, Number(process.env.QQBOT_TTS_TIMEOUT || 150)) * 1000;

/** 默认参考音色（和视频配音同一个，听起来才是同一个人） */
const DEFAULT_VOICE_REF = join(ROOT, 'logs', 'bili', 'voice-ref', 'saki_ref_sakiko2.wav');
/** 音色目录（界面上的下拉就是列这里） */
export const VOICE_DIR = join(ROOT, 'logs', 'bili', 'voice-ref');

/**
 * **现在该用哪个音色** —— 2026-10-21：「**各个QQ账号可以选择用哪个语音**」
 *
 * ⚠️ 从 `config.voice.ref` 读（**按号私有** ⇒ 每个 QQ 号能有自己的音色）
 * ⚠️ 配置里写的是**文件名**（`saki_ref.wav` 这种），不是全路径 —— 界面上就是列文件名 ✓
 * ⚠️ 配的音色不存在 / 没配 ⇒ 用默认，并且**别静默**（打一行 warn，不然用户以为设了没生效）✗
 */
export function voiceRef() {
  const name = String(config?.voice?.ref || '').trim();
  if (!name) return DEFAULT_VOICE_REF;
  const p = join(VOICE_DIR, name);
  if (existsSync(p)) return p;
  log.warn(`[群语音] 配置里的音色不存在：${name} ⇒ 改用默认`);
  return DEFAULT_VOICE_REF;
}

/** 界面上那个下拉要列的东西（只列 wav/mp3） */
export function listVoices() {
  try {
    return readdirSync(VOICE_DIR)
      .filter((n) => /\.(wav|mp3|m4a)$/i.test(n))
      .sort()
      .map((n) => ({ name: n, def: n === 'saki_ref_sakiko2.wav' }));
  } catch {
    return [];
  }
}

/** 语音功能开没开（总闸 + 戳一戳那个开关 + 韵律参数） */
export function voiceSettings() {
  const c = config?.voice || {};
  return {
    // ⚠️ 2026-10-21：**默认关**（用户：「谷雨那边一定不能开语音功能」）——
    //    这一段按号私有，没配过的号会读到默认值 ⇒ 默认开 = 那些号自动开语音 ✗
    enable: c.enable === true,
    pokeVoice: c.pokeVoice === true,
    ref: String(c.ref || ''),
    current: voiceRef().split(/[\\/]/).pop(),   // 实际在用的那个（配错时能看出回落到默认了）
    /* ⚠️ 2026-10-22 加：**韵律参数**（用户：「太抑扬顿挫了，和小学生读课文一样」）
     *   实测「不传情感向量 + 情感强度 0.5」最自然 ⇒ 做成按号可配 ✓ */
    noVec: c.noVec === true,                                    // true = 不传 emo_vector
    emoAlpha: Number.isFinite(c.emoAlpha) ? c.emoAlpha : null,   // 情感强度（0~2）
    durationFactor: Number.isFinite(c.durationFactor) ? c.durationFactor : null, // ⚠️ 越大越慢
  };
}

/**
 * 从她的回复里抽出语音段。
 *
 * `[语音]啊？真的假的[/语音]` ⇒ 那段**不按文字发**，改成语音发
 * 兜底：合成失败时调用方要把它当文字补发（见 `bot.js` 的 `_sendVoiceClip`）
 *
 * @returns {{text:string, clips:string[]}} text = 去掉语音标记后的正文
 */
export function pickVoice(raw) {
  const src = String(raw ?? '');
  const clips = [];
  // ⚠️ 只认**成对**的 [语音]…[/语音]；落单的（她写了一半）原样留着当文字，
  //    免得把半句话吃掉 —— 这也是兜底的一部分 ✓
  const text = src.replace(/\[语音\]([\s\S]*?)\[\/语音\]/g, (_m, body) => {
    const t = String(body ?? '').trim();
    if (t) clips.push(t);
    return '';
  });
  return { text: text.trim(), clips };
}

/* ── 共享 daemon 的发现 / 拉起 ─────────────────────────── */

function pythonExe() {
  const p = String(process.env.QQBOT_TTS_PY || '').trim();
  return p || join(IDX_ROOT, '.venv', 'Scripts', 'python.exe');
}

let daemonReady = false;
let starting = null;
/** 上次因为"游戏让位中"打过日志的时间（限流用，免得每句语音都刷一行） */
let lastPauseLogAt = 0;

/** 游戏让位的标记文件（`tools/tts-serve.py` 写的，单位=秒级时间戳） */
const PAUSE_FILE = join(ROOT, 'state', 'tts-paused.json');
/** daemon 自己的 stdout/stderr 落这里（原来 `stdio: 'ignore'` ⇒ 它为什么退出**一点都看不到**） */
const DAEMON_LOG = join(ROOT, 'logs', 'tts-daemon.log');

/**
 * 游戏让位还剩多少秒（0 = 没在让位）。
 *
 * ⚠️⚠️ 2026-10-26 加（用户：「**tts 一直在启动啊，我去任务管理器关了又能自己打开，
 *     启动了游戏也不能自己关掉，而且我还看不到一条语音发出去**」）
 *
 *   真因两条，都是**机器人这边没读这个文件**造成的：
 *     · `tts-serve.py` 一启动就 `detect_game()`，有游戏就 `set_pause()` + `sys.exit(0)` ✓
 *     · 可 `group-voice.js` **从来不看 pause 文件** ⇒ 它以为 daemon 在加载，傻等 5 分钟
 *       「没就绪 ⇒ 放弃」，下一条语音再来一遍 ⇒ **每 5 分钟白 spawn 一次** ✗✗
 *       （日志实证：18:23 起→18:28 放弃、18:37 起→18:43 放弃、19:44 起→…）
 *   ⇒ 现在启动前先读它：还在让位就**一个进程都不起**，只打一行日志 ✓
 */
function pauseLeftSec() {
  try {
    const j = JSON.parse(readFileSync(PAUSE_FILE, 'utf8'));
    const untilMs = Number(j?.until || 0) * 1000; // python 写的是秒级浮点
    return Math.max(0, (untilMs - Date.now()) / 1000);
  } catch {
    return 0;
  }
}

/** 问一下 daemon 在不在（2.5 秒超时，别卡住回复流） */
async function pingDaemon() {
  try {
    const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/ping`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    return j?.ok === true ? j : null;
  } catch {
    return null;
  }
}

/**
 * **确保 daemon 在跑**（已有就复用，没有就 detached 起一个）
 * @returns {Promise<boolean>} 就绪了吗
 */
function start() {
  if (starting) return starting;
  starting = (async () => {
    // ⓪ **游戏在跑（让位中）⇒ 一个进程都不起**（见 `pauseLeftSec` 上面那段）
    const left = pauseLeftSec();
    if (left > 0) {
      daemonReady = false;
      starting = null;
      // ⚠️ 日志限流：`synth()` 每次要发语音都会来调一次，每句都打一行会刷屏
      if (Date.now() - lastPauseLogAt > 10 * 60 * 1000) {
        lastPauseLogAt = Date.now();
        log.info(
          `[群语音] 游戏还在跑 → 这次**不启动** TTS（让位还有 ${Math.ceil(left / 60)} 分钟；` +
            '这段时间语音全走文字，游戏关了就别再点它）',
        );
      }
      return false;
    }

    // ① 已经有人在跑（别的号起的 / 上一轮机器人留的）⇒ 直接复用，**省一次 90 秒冷启动** ✓
    const pong = await pingDaemon();
    if (pong) {
      daemonReady = true;
      log.info(`[群语音] 复用已运行的 TTS daemon（:${HTTP_PORT}，pid ${pong.pid ?? '?'}，模型 ${pong.load ?? '?'}s）`);
      starting = null;
      return true;
    }

    // ② 起一个（⚠️ detached + unref ⇒ **活过机器人重启**，重启不再连带重载模型）
    if (!existsSync(pythonExe())) {
      log.warn(`[群语音] 找不到 python：${pythonExe()} ⇒ 语音不可用（会照常发文字）`);
      starting = null;
      return false;
    }
    // ⚠️ 2026-10-26：**起来就死**的收尸变量（见下面 spawn 那段注释）
    let earlyExit = null;
    try {
      /* ⚠️⚠️ 2026-10-26：**把 daemon 自己的报错写到文件里**
       *    原来 `stdio: 'ignore'` ⇒ 它为什么没起来（游戏让位 / 单例冲突 / import 失败）
       *    **一个字都看不到**，机器人只会说「5 分钟没就绪 ⇒ 放弃」⇒ 白查一天 ✗
       */
      let errFd = null;
      try {
        mkdirSync(join(ROOT, 'logs'), { recursive: true });
        errFd = openSync(DAEMON_LOG, 'a');
      } catch {
        /* 打不开就算了，别影响主流程 */
      }
      const child = spawn(pythonExe(), [
        join(ROOT, 'tools', 'tts-serve.py'),
        '--http', String(HTTP_PORT),
        '--idle', String(IDLE_SEC),
      ], {
        // ⚠️⚠️ `cwd` 和 `PYTHONPATH` 都必须是 IndexTTS 目录，否则 `import indextts` 直接
        //    ModuleNotFoundError（2026-10-22 实测：漏了这两个，服务 4 分钟都没就绪 ✗）
        cwd: IDX_ROOT,
        env: { ...process.env, PYTHONPATH: IDX_ROOT, HF_ENDPOINT: 'https://hf-mirror.com' },
        detached: true,          // ⚠️ 关键：脱离机器人进程，重启机器人不会带走它
        stdio: ['ignore', errFd ?? 'ignore', errFd ?? 'ignore'],
        windowsHide: true,
      });
      /* ⚠️ 2026-10-26：**盯着它有没有"起来就死"**
       *    游戏让位 / 单例冲突时 python 是 `sys.exit(0)` —— 一闪就没，
       *    可原来照样傻等 5 分钟 ✗ ⇒ 这里收尸，立刻判失败
       */
      child.on('exit', (code) => {
        if (!daemonReady && earlyExit === null) earlyExit = code === null ? -1 : code;
      });
      child.unref();
      log.info(`[群语音] 起来了 TTS daemon（:${HTTP_PORT}，pid ${child.pid}）—— 模型加载约 60~120 秒`);
    } catch (e) {
      log.warn(`[群语音] 起不来 TTS daemon：${e.message} ⇒ 语音不可用（会照常发文字）`);
      starting = null;
      return false;
    }

    // ③ 等它就绪（实测 54~130 秒，给足 5 分钟）
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) {
      await new Promise((r) => setTimeout(r, 1500));
      /* ⚠️ 2026-10-26：**它已经死了 ⇒ 别等了**（原来会白等满 5 分钟）
       *    退出码 0 + pause 文件变新 ⇒ 那 99% 是「检测到游戏在跑，让位退出」✓
       */
      if (earlyExit !== null) {
        const leftNow = pauseLeftSec();
        if (leftNow > 0) {
          log.info(
            `[群语音] TTS daemon 起来就退了 —— **游戏在跑，它主动让位**（还有 ${Math.ceil(leftNow / 60)} 分钟解禁）`,
          );
        } else {
          log.warn(
            `[群语音] TTS daemon 起来就退（code=${earlyExit}）⇒ 语音这次不可用；` +
              `详细原因看 logs/tts-daemon.log`,
          );
        }
        daemonReady = false;
        starting = null;
        return false;
      }
      const j = await pingDaemon();
      if (j) {
        daemonReady = true;
        log.info(`[群语音] TTS daemon 就绪（${((Date.now() - t0) / 1000).toFixed(0)}s，模型 ${j.load ?? '?'}s）`);
        starting = null;
        return true;
      }
    }
    log.warn('[群语音] TTS daemon 5 分钟没就绪 ⇒ 放弃这次（语音会退回文字）');
    starting = null;
    return false;
  })();
  return starting;
}

/**
 * 合成一句话 → wav 路径。
 * @returns {Promise<{ok:boolean, file?:string, dur?:number, err?:string}>}
 */
export async function synth(text) {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, err: '空文本' };
  /* ⚠️ 2026-10-26：**游戏在跑 ⇒ 直接说清楚**（原来统一报"还没热起来"，用户看不懂）
   *    ⚠️ 这里只是"解释一句"，真正的闸在 `start()` 的 ⓪（读同一个文件）✓
   */
  if (pauseLeftSec() > 0) {
    return { ok: false, err: '游戏在跑，语音暂时让位（照发文字）' };
  }
  /* ⚠️⚠️ **没热起来时这一条先发文字**（不卡回复流）
   *    模型加载 60~130 秒，群里等两分钟才来一条语音，人早走了 ✗
   *    ⇒ 立刻返回失败（调用方发文字，用户马上看到内容），同时后台把它加载起来 ✓ */
  if (!daemonReady) {
    void start();
    return { ok: false, err: 'TTS 还没热起来（这条先发文字，下次就能发语音）' };
  }
  try { mkdirSync(OUT_DIR, { recursive: true }); } catch { /* ignore */ }
  const out = join(OUT_DIR, `g${Date.now()}.wav`);

 /* ⚠️ 2026-10-22：「**太抑扬顿挫了，和小学生读课文一样**」→ 实验选定「不传情感向量 + 情感强度 0.5」
   *   ⚠️ 这些是**按号**的（爱音 0.5，主号保持老行为）✓ */
  const vs = voiceSettings();
  const body = { text: t.slice(0, 150), out, voice: voiceRef() };
  if (vs.noVec) body.vec = 'none';
  if (typeof vs.emoAlpha === 'number') body.emo_alpha = vs.emoAlpha;
  if (typeof vs.durationFactor === 'number') body.duration_factor = vs.durationFactor;

  try {
    const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
    });
    const j = await r.json();
    if (!j.ok) {
      log.info(`[群语音] 「${t.slice(0, 20)}」合成失败：${j.err} ⇒ 改发文字`);
      // daemon 挂了 ⇒ 下次重新发现
      if (!(await pingDaemon())) daemonReady = false;
    }
    return j;
  } catch (e) {
    // 超时 / 连不上 ⇒ 判失败，并让下次重新发现 daemon
    daemonReady = false;
    const err = e.name === 'TimeoutError' ? `合成超时（${SYNTH_TIMEOUT_MS / 1000}s）` : e.message;
    log.info(`[群语音] 「${t.slice(0, 20)}」合成失败：${err} ⇒ 改发文字`);
    return { ok: false, err };
  }
}

/** 把 wav 转成 base64 的 record 段（QQ 语音） */
export function recordSeg(wavPath) {
  const b64 = readFileSync(wavPath).toString('base64');
  return { type: 'record', data: { file: `base64://${b64}` } };
}

/**
 * 预热：把 daemon 拉起来 **+ 跑一次 dummy 合成**（把首次 CUDA 编译也吃掉）
 *
 * ## 为什么要跑 dummy
 *   实测冷启动分两段：**加载模型 54~130 秒** + **第一次推理还要十几秒**（s2mel 首次编译）。
 *   光"加载完"不够，第一句真语音照样慢 ⇒ 预热阶段先合成一句「嗯。」把它吃掉 ✓
 *   ⚠️ dummy 的 wav 合成完就删，不留垃圾
 */
export function warmup() {
  void (async () => {
    try {
      const ok = await start();
      if (!ok) return;
      const t0 = Date.now();
      const r = await synth('嗯。');
      if (r?.file) { try { rmSync(r.file, { force: true }); } catch { /* ignore */ } }
      if (r?.ok) log.info(`[群语音] 预热完成（模型 + 首次编译都就绪，共 ${Math.round((Date.now() - t0) / 1000)} 秒）⇒ 之后每句十几秒`);
      else log.warn(`[群语音] 预热：首次编译没跑成（${r?.err ?? '未知'}）⇒ 第一条可能慢`);
    } catch (e) {
      log.debug(`[群语音] 预热出错：${e.message}`);
    }
  })();
}
