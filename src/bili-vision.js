/**
 * **看视频画面** —— 抽帧 + 读画面里的文字（2026-10-22 加）
 *
 * ## 用户原话
 *   「**bot看视频的时候可以逐帧看视频画面的文字来分析视频吗**」→「**接**」
 *
 * ## 为什么值得做
 *   主动评论原来只读 **标题 / 简介 / 弹幕 / 热评 / 分P** —— 全是"别人说的话"，
 *   唯独**画面里有什么**完全不知道。而很多视频（尤其聊天记录、教程、游戏）的
 *   关键信息就在**画面上的字**里（字幕、界面文字、标题卡）。
 *   ⇒ 读出来塞进上下文，评论才能说到"画面里那行字"，而不是只顺着标题夸 ✗
 *
 * ## 实测链路（2026-10-22，全跑通）
 *   ① Playwright 打开视频页 → `window.__playinfo__` 里就有 dash 地址
 *      ⚠️ **不用自己算 wbi 签名**（页面已经算好了）—— 原来这里被判定成"麻烦"就是以为要算 ✗
 *   ② 挑 **AVC（codecid=7）** 那条轨
 *      ⚠️⚠️ 这台机器的 ffmpeg 是 **v3.0.1（2016 年）**，解不了 **HEVC(12) / AV1(13)**
 *      ⇒ 不挑 AVC 会报 `No decoder for stream #0:0` ✗（实测踩过）
 *   ③ Node `fetch` 下载（带 **Referer + Cookie**）—— 实测 73 秒视频 480p 只 **1.1 MB / 1.6 秒**
 *      ⚠️ 别用 ffmpeg 直接读那个 URL：**403 Forbidden**（老 ffmpeg 的 `-headers` 带不动 Cookie）✗
 *   ④ ffmpeg 抽 N 帧 → 每帧约 30 KB
 *   ⑤ 视觉模型读文字（中转站 22 个模型支持视觉，但**额度随时会用完** ⇒ 按顺序试）
 *
 * ## 代价（实测）
 *   · 抽帧 + 下载 ≈ **6 秒**
 *   · 读字 **16.8 秒/帧**（推理模型，`max_tokens` 给少于 3000 会返回空 ✗）
 *   · 3 帧 ≈ **50 秒** + 一点 token 钱
 *   ⇒ 所以调用方**必须给硬超时**，读不出来就当没有，绝不拖慢发评论 ✓
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, config } from './config.js';
import { log } from './log.js';

const FF = String(process.env.BILI_FFMPEG || '').trim()
  || 'C:\\Users\\<主人>\\AppData\\Roaming\\bilibili\\ffmpeg\\ffmpeg.exe';

/** 抽出来的帧放这儿（临时，用完就删） */
const TMP_DIR = () => join(ROOT, 'logs', 'bili', 'frames');

/** 下载上限 —— 超过就别读了（长视频光下就几十 MB，不值） */
const MAX_DOWNLOAD = 40 * 1024 * 1024;

/**
 * 读画面文字用的模型（**按顺序试**）。
 *
 * ⚠️ 中转站的模型**额度随时会用完**（实测 `Credits exhausted`），所以不能只写一个。
 * ⚠️ 都得是 **supports_vision** 的（`/models` 里带这个字段）。
 * ⚠️ 顺序：先挑响应快、视觉稳的；`deepseek-v4.1-flash` 垫底（它主职是文本）
 */
const VISION_MODELS = ['gpt-5.6-terra', 'kimi-k2.8-preview', 'glm-5.3', 'deepseek-v4.1-flash'];

/** 读画面文字用的提示词 —— 只要字，不要发挥 */
const PROMPT = `把这张画面里出现的**所有文字**原样读出来（字幕、标题、角标、水印、界面里的字都算）。
规则：
- 只读**真的看得见**的字，看不清就写「看不清」，别猜、别补全。
- 一句一行，别加解释、别翻译、别总结。
- 一个字都没有就只回：无文字`;

/** 挑一个"能读画面"的提供商（要有 key + baseURL） */
function visionEndpoint() {
  const l = config.llm || {};
  // 优先用**中转站**那家（22 个模型支持视觉）；没有就用扁平那套
  const list = Array.isArray(l.providers) ? l.providers.filter((p) => p && p.baseURL && p.apiKey) : [];
  const relay = list.find((p) => /example|relay|proxy/i.test(String(p.baseURL)))
    || list[0]
    || null;
  if (relay) return { baseURL: String(relay.baseURL).replace(/\/+$/, ''), apiKey: String(relay.apiKey) };
  if (l.baseURL && l.apiKey) return { baseURL: String(l.baseURL).replace(/\/+$/, ''), apiKey: String(l.apiKey) };
  return null;
}

/** 读一帧（返回文字，失败返回空串） */
async function readFrame(file, model, ep, timeoutMs) {
  const b64 = readFileSync(file).toString('base64');
  const r = await fetch(`${ep.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
    body: JSON.stringify({
      model,
      /* ⚠️⚠️ 推理模型的思考**计入 completion_tokens** —— 给 600 会"想完了正文被截空"（实测）✗
       *    给足 4000 才稳定出正文 ✓ */
      max_tokens: 4000,
      temperature: 0.1,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0, 120)}`);
  let out = '';
  try { out = String(JSON.parse(txt)?.choices?.[0]?.message?.content || ''); } catch { /* ignore */ }
  return out.trim();
}

/**
 * **抽 N 帧，读出画面里的文字**。
 *
 * @param {object} p
 * @param {import('playwright-core').Page} p.page **已经开着的**视频页（复用，省一次打开）
 * @param {number} [p.count=3] 抽几帧
 * @param {number} [p.budgetMs=75000] 整个"读字"环节的硬上限（超了就当没有）
 * @returns {Promise<{ok:boolean, texts:string[], model:string, ms:number, err?:string}>}
 */
export async function frameText({ page, count = 3, budgetMs = 75000 } = {}) {
  const t0 = Date.now();
  const fail = (err) => ({ ok: false, texts: [], model: '', ms: Date.now() - t0, err });

  if (!page) return fail('没有传页面');
  const ep = visionEndpoint();
  if (!ep) return fail('没配视觉模型');
  if (!statSync(FF).isFile()) return fail(`找不到 ffmpeg：${FF}`);

  /* ── ① 从页面里拿播放地址（不用 wbi 签名）── */
  let info;
  try {
    info = await page.evaluate(() => {
      const pi = window.__playinfo__, st = window.__INITIAL_STATE__;
      return {
        title: String(st?.videoData?.title || ''),
        duration: Number(st?.videoData?.duration) || 0,
        vids: (pi?.data?.dash?.video || []).map((v) => ({
          qn: Number(v.id) || 0, codecid: Number(v.codecid) || 0, url: String(v.baseUrl || ''),
        })),
      };
    });
  } catch (e) {
    return fail(`读 playinfo 失败：${e.message}`);
  }
  const avc = (info.vids || []).filter((v) => v.codecid === 7 && v.url);
  const pick = avc.find((v) => v.qn === 32) || avc[0];
  if (!pick) return fail('这条视频没有 AVC 轨（只有 HEVC/AV1，这个 ffmpeg 解不了）');
  if (!info.duration) return fail('拿不到时长');

  /* ── ② 下载（带 Referer + Cookie）── */
  let cookieStr = '';
  try {
    const cookies = await page.context().cookies('https://www.bilibili.com');
    cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch { /* 没 cookie 也能试 */ }
  let buf;
  try {
    const r = await fetch(pick.url, {
      headers: {
        Referer: 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/203.0.113.10 Safari/537.36',
        ...(cookieStr ? { Cookie: cookieStr } : {}),
      },
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) return fail(`下载视频 HTTP ${r.status}`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_DOWNLOAD) return fail(`视频太大（${(len / 1048576).toFixed(0)}MB），跳过读画面`);
    buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD) return fail('视频太大，跳过读画面');
  } catch (e) {
    return fail(`下载失败：${e.message}`);
  }

  /* ── ③ 抽帧 ── */
  const dir = TMP_DIR();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(dir, { recursive: true });
  const mp4 = join(dir, 'v.mp4');
  try { writeFileSync(mp4, buf); } catch (e) { return fail(`存视频失败：${e.message}`); }

  // 均匀取时间点（避开片头片尾的黑屏/logo）
  const pts = Array.from({ length: count }, (_, i) => info.duration * (0.12 + (0.76 * i) / Math.max(1, count - 1)));
  const frames = [];
  for (let i = 0; i < pts.length; i++) {
    const f = join(dir, `f${i}.jpg`);
    try {
      execFileSync(FF, ['-ss', String(pts[i].toFixed(1)), '-i', mp4, '-frames:v', '1',
        '-vf', 'scale=960:-1', '-q:v', '4', '-y', f], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
      if (statSync(f).size > 2000) frames.push(f);
    } catch { /* 这一帧抽不到就跳过 */ }
  }
  if (!frames.length) return fail('一帧都没抽出来');

  /* ── ④ 读字（按模型顺序试，整段有硬上限）── */
  const left = () => budgetMs - (Date.now() - t0);
  for (const model of VISION_MODELS) {
    if (left() < 8000) break;
    const texts = [];
    let okCount = 0;
    let lastErr = '';
    for (const f of frames) {
      if (left() < 6000) break;
      try {
        const t = await readFrame(f, model, ep, Math.min(60000, left()));
        if (t && t !== '无文字') { texts.push(t); okCount += 1; }
        else if (t === '无文字') okCount += 1;
      } catch (e) {
        lastErr = e.message;
        break;   // 这个模型不行（多半是额度/限流）⇒ 换下一个
      }
    }
    if (okCount > 0) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: true, texts, model, ms: Date.now() - t0, title: info.title, duration: info.duration };
    }
    log.info(`[看画面] ${model} 读不出来（${lastErr.slice(0, 80)}）⇒ 换下一个模型`);
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  return fail('所有视觉模型都读不出来（多半是额度用完了）');
}
