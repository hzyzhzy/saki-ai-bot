#!/usr/bin/env node
/**
 * B站**主动评论**（2026-10-22 加）
 *
 * ## 用户要求
 *   「继续做**主动评论**和回复评论功能」
 *   「也可以加个**手动发一条**，但是要**显示出来发送的视频链接**」
 *   「和分享视频一样，可以差不多直接复用那边的所有设置」（⇒ 关键词/条数/时间段那套）
 *
 * ## 干什么
 *   给一个视频（BV 号或链接）→ 打开看标题/简介/评论 → 让她**用自己的口气写一条评论** → 发出去
 *   → **把视频链接打出来**（用户要的）
 *
 * ## 用法
 *   node tools/bili-proactive-comment.mjs --bvid BV1xx411c7mD --dry    # 只生成，不发
 *   node tools/bili-proactive-comment.mjs --bvid BV1xx411c7mD          # 真发
 *   node tools/bili-proactive-comment.mjs --url https://www.bilibili.com/video/BV...
 *
 * ## ⚠️ 探路结论（2026-10-22 实测，别重复踩）
 *   · 视频页评论区在 **Web Component**（`#commentapp`）里，普通 `querySelector` 穿不进去
 *   · 发评论的输入框 = shadow DOM 里的 `.brt-editor`（host 是 `BILI-COMMENT-RICH-TEXTAREA`）
 *   · **发布按钮文字是「发布」**（右下角蓝色那个）
 *   · 评论区是**懒加载**：必须滚到底、滚几次、再等几秒才出内容
 */
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// ⚠️ 弹幕是 deflate 压缩的 XML，要解（见 danmakuOf）
import { inflateSync, gunzipSync, brotliDecompressSync } from 'node:zlib';
import yaml from 'js-yaml';
import * as shortMemory from '../src/short-memory.js';
import * as presence from '../src/bili-presence.js';
// ⚠️ 2026-10-22 踩过：下面那个 `llmCfg` 是**配置对象**，不是模块 —— 别把两个搞混
import * as llm from '../src/llm.js';
// ⚠️ 2026-10-22：统一在这里决定用哪个浏览器
//    （系统 Chrome 优先 + 独立 profile；没有 Chrome 才用内置 Chromium）
import { browserOpts , biliProfileDir } from './lib/browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (n) => argv.includes('--' + n);
const say = (s) => console.log(`[主动评论] ${s}`);

/* ── 用接口把"视频里到底有什么"抓出来（2026-10-21 加） ─────────────
 * ## 用户问：「其他项目的 bot 会读取要评论的视频的什么信息？也是只读取标题吗？
 *            能不能真正读取视频内容塞进上下文，评论效果更好」
 *
 * ## 实测结论（2026-10-21，别重复探）
 *   | 想读的东西 | 能不能 | 说明 |
 *   | --- | --- | --- |
 *   | **字幕（CC）** | ❌ 基本没有 | 实测 3 个视频 `subtitle.subtitles` 全是空、`allow_submit=false`；
 *   |                |        | 游客接口也不给 ⇒ 拿它当主料会经常"什么也没有" ✗ |
 *   | **playurl 下视频抽帧** | ⚠️ 麻烦 | 要 wbi 签名 + 登录 cookie，而且下几十 MB 只为了几帧 ✗ |
 *   | **弹幕** | ✅ 能，而且最好用 | `x/v1/dm/list.so?oid=<cid>` 返回 deflate 压的 XML，解出来就是
 *   |        |                  | 观众在画面里看到的**具体东西**（"红石粉没充能""这椅子坐着烫"）✓ |
 *   | **热评** | ✅ 能 | `x/v2/reply?type=1&oid=<aid>&sort=2` ⇒ 观众关心什么 ✓ |
 *   | **分P标题** | ✅ 能 | 多 P 视频的分集标题信息量很大 ✓ |
 *
 * ⇒ 所以"读内容"走 **弹幕抽样 + 热评 + 分P + 完整简介**：全免费、几百毫秒、比标题强一个数量级。
 *   （真要看画面得抽帧 + 视觉模型，那要额外花钱，等用户点头再加。）
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/203.0.113.10 Safari/537.36';
const HH = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
const jget = async (u) => {
  try {
    const r = await fetch(u, { headers: HH, signal: AbortSignal.timeout(15000) });
    return await r.json();
  } catch { return null; }
};

/** 把 B站表情标记转成人能读的（2026-10-22 用户：「b站有些表情 saki 好像不能直接读出来」）
 *  `[doge_金箍]` → `（doge 金箍 表情）` —— 不然模型只看到一串方括号里的字，不知道那是表情 ✗ */
const emojiText = (s) =>
  String(s ?? '').replace(/\[([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_]{1,13})\]/g, (_m, n) =>
    `（${String(n).replace(/_/g, ' ')} 表情）`);

/** 弹幕：解 deflate 压缩的 XML → 按时间均匀抽 N 条（去掉太短/纯符号/重复） */
async function danmakuOf(cid, n = 40) {
  try {
    const r = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, { headers: HH, signal: AbortSignal.timeout(15000) });
    const buf = Buffer.from(await r.arrayBuffer());
    let xml = '';
    for (const fn of [inflateSync, gunzipSync, brotliDecompressSync]) {
      try { xml = fn(buf).toString('utf8'); break; } catch { /* 试下一个 */ }
    }
    if (!xml) xml = buf.toString('utf8');
    const all = [...xml.matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)]
      .map((m) => ({ t: Number((m[1] || '').split(',')[0]) || 0, text: String(m[2] || '').trim() }))
      .filter((x) => x.text.length >= 4 && /[\u4e00-\u9fa5a-zA-Z]/.test(x.text))
      // 去掉"哈哈哈""前方高能"这种没信息量的
      .filter((x) => !/^(哈+|前[方面]高能|awsl|好耶|爷青回|泪目|打卡|第一|沙发|空降成功|来了来了)+$/i.test(x.text));
    // 按时间排序，均匀抽（保证覆盖整条视频，而不是只抽到开头的"第一/来了"）
    all.sort((a, b) => a.t - b.t);
    const seen = new Set();
    const out = [];
    const step = Math.max(1, Math.floor(all.length / n));
    for (let i = 0; i < all.length && out.length < n; i += step) {
      const x = all[i];
      const k = x.text.slice(0, 8);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  } catch { return []; }
}

/** 热评 */
async function hotRepliesOf(aid, n = 8) {
  const r = await jget(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${n}`);
  return (r?.data?.replies || []).map((x) => String(x?.content?.message || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, n);
}

/** 把"内容"抓齐（拿不到的部分留空，绝不让它挂掉整条流程） */
async function fetchExtra(bvid) {
  const out = { aid: 0, cid: 0, title: '', up: '', desc: '', duration: 0, parts: [], danmaku: [], hot: [], tags: [] };
  const v = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  const d = v?.data;
  if (!d) return out;
  out.aid = Number(d.aid) || 0;
  out.cid = Number(d.cid) || 0;
  out.title = String(d.title || '');
  out.up = String(d?.owner?.name || '');
  out.desc = String(d.desc || '');
  out.duration = Number(d.duration) || 0;
  out.parts = (d.pages || []).map((p) => String(p.part || '')).filter(Boolean);
  if (out.cid) out.danmaku = await danmakuOf(out.cid);
  if (out.aid) out.hot = await hotRepliesOf(out.aid);
  // 标签（能看出 UP 自己怎么定位这条视频）
  const tg = await jget(`https://api.bilibili.com/x/tag/archive/tags?bvid=${bvid}`);
  out.tags = (tg?.data || []).map((x) => String(x?.tag_name || '')).filter(Boolean).slice(0, 12);
  return out;
}

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// ⚠️ 2026-10-21：**按 QQ 号分 profile**（主号走老路径 state/bili-profile，别的号 state/bili-profile-<QQ>）
const PROFILE = biliProfileDir();
const DRY = flag('dry');

let bvid = String(arg('bvid', '')).trim();
const urlIn = String(arg('url', '')).trim();
// ⚠️ 2026-10-22：**BV / av 都认**（B站搜索结果里给的是 `av` 号，只认 BV 会全被过滤 ✗）
if (!bvid && urlIn) {
  bvid = (urlIn.match(/video\/((?:BV[0-9A-Za-z]{10}|av\d+))/i) || [])[1] || '';
}
if (!bvid) { say('❌ 要 --bvid BVxxx 或 --url <视频链接>'); process.exit(2); }
const VIDEO_URL = `https://www.bilibili.com/video/${bvid}`;

/* ⚠️⚠️⚠️ 2026-10-22 真事故（用户截图：「**这个视频 saki 发了三条评论**」）：
 *   那三条**全是我测试时发的** —— 我直接跑这个脚本，**绕过了 `bili-proactive.js` 的去重**
 *   （`visited` 只在 `runOnce` 入口挡），而且其中两次脚本报"没提交"其实**已经发出去了** ✗
 *
 *   ⇒ 规矩（用户原话）：「**一个视频一定只能发一条，除非有人回复 saki**」
 *     · 脚本**自己**查 `state/bili-proactive.json` 的 `visited` —— 发过就直接退出 ✓
 *     · 发完**不管报 ok 还是 uncertain 都记进 visited**（宁可少发，绝不重复发）✓
 *     · 真要重发（比如上次真被拦了）⇒ 显式加 `--force` ✓
 *     · ⚠️ "有人回复 saki 再回" 那条走的是**评论回复**（`bili-comments.js`），不是这条路 ✓
 */
const FORCE = flag('force');
const PSTAT = join(ROOT, 'state', 'bili-proactive.json');
function readPState() {
  try { return JSON.parse(readFileSync(PSTAT, 'utf8')) || {}; } catch { return {}; }
}
function markVisited(reason) {
  try {
    const o = readPState();
    o.visited = [...new Set([...(o.visited || []), bvid])];
    o.sent = [{ at: Date.now(), bvid, url: VIDEO_URL, ok: reason === 'ok', uncertain: reason === 'uncertain' }, ...(o.sent || [])].slice(0, 80);
    writeFileSync(PSTAT, JSON.stringify(o, null, 2), 'utf8');
  } catch (e) {
    say('⚠️ 记 visited 失败：' + e.message);
  }
}
if (!DRY && !FORCE) {
  const visited = readPState().visited || [];
  if (visited.includes(bvid)) {
    say(`⏭ 这个视频已经评论过了（${bvid}）—— 一个视频只发一条，除非有人回复她`);
    say('（真要重发就加 --force）');
    console.log(JSON.stringify({ ok: false, already: true, bvid, err: '这个视频已经评论过了' }));
    process.exit(0);
  }
}

const cfg = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) || {};
const llmCfg = cfg.llm || {};
if (!llmCfg.apiKey || !llmCfg.baseURL) { say('❌ config.yml 里没有 llm'); process.exit(2); }

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const SHOT_DIR = join(ROOT, 'logs', `bili-proactive-${stamp}`);
mkdirSync(SHOT_DIR, { recursive: true });

/* ── ① 打开视频页，抓内容 ───────────────────────── */
/* ⚠️⚠️ 2026-10-22 加**重试**（真事故：完整跑一遍时脚本直接崩了，`exit code 21`）——
 *    Chrome 的 `exit code 21` = **这个 user-data-dir 还被另一个 Chrome 占着** ✗
 *    现场：主号那个「评论回复」的**常驻浏览器**正开着同一个 profile，
 *    `runOnce()` 虽然先调了 `release()`，但 Chrome **退出要几秒**才放开互斥体 ⇒
 *    脚本立刻去起就撞上了 ⇒ 整个活白跑（还留一堆 Chrome 日志刷屏）✗
 *    ⇒ 起不来就**等几秒重试**，最多 4 次（总共约 12 秒），别一次失败就崩 ✓ */
let ctx = null;
for (let attempt = 1; attempt <= 4; attempt++) {
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, {
      ...browserOpts(),
      headless: true,
      viewport: { width: 1500, height: 1000 },
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled'],
    });
    break;
  } catch (e) {
    const msg = String(e?.message || '');
    // ⚠️ 只有"profile 被占"才值得重试；别的原因（找不到 Chrome 之类）重试也没用
    const busy = /exitCode=21|SingletonLock|already in use|user data directory is already in use|Target page, context or browser has been closed/i.test(msg);
    say(`⚠️ Chrome 起不来（第 ${attempt}/4 次${busy ? '，profile 还被占着' : ''}）：${msg.split('\n')[0].slice(0, 120)}`);
    if (attempt === 4) { say('❌ 四次都没起来 ⇒ 放弃这一轮'); process.exit(4); }
    await new Promise((r) => setTimeout(r, busy ? 4000 : 1500));
  }
}
if (!ctx) { say('❌ 浏览器没起来'); process.exit(4); }
const page = await ctx.newPage();
say(`打开 ${VIDEO_URL}`);
await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 5000));
// 评论区懒加载：滚几次再等
for (let i = 0; i < 4; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 1800));
}
await new Promise((r) => setTimeout(r, 3000));

const info = await page.evaluate(() => {
  const txt = (sel) => (document.querySelector(sel)?.innerText || '').replace(/\s+/g, ' ').trim();
  return {
    title: txt('h1.video-title, h1[title]'),
    up: txt('.up-name, .up-info--name'),
    desc: txt('.desc-info-text, .basic-desc-info').slice(0, 400),
    // 页面尾部文字里就带着已加载的评论（够模型感受氛围了）
    tail: (document.body.innerText || '').replace(/\s+/g, ' ').slice(-1500),
  };
});
say(`标题：${info.title}`);
say(`UP：${info.up}`);

/* ── ①.5 把"视频里到底有什么"抓出来（弹幕 / 热评 / 分P / 完整简介） ──
 * ⚠️ 这一步**在开浏览器之前就该做**，但放在这儿也行（接口不占 profile）。
 *    拿不到就空着 —— 绝不能因为它挂掉整条流程 ✓ */
const extra = await fetchExtra(bvid);
say(`内容：弹幕 ${extra.danmaku.length} 条 ｜ 热评 ${extra.hot.length} 条 ｜ 分P ${extra.parts.length} 个 ｜ 简介 ${extra.desc.length} 字`);
if (extra.danmaku.length) say(`弹幕抽样：${extra.danmaku.slice(0, 8).map((x) => x.text).join(' / ')}`);

/* ── ①.6 **看画面**（2026-10-22 加，用户：「bot看视频的时候可以逐帧看视频画面的文字吗」→「接」）
 *
 * ⚠️ 为什么值得：上面拿的全是"别人说的话"（标题/弹幕/热评），**画面里有什么完全不知道** ✗
 *    而很多视频的关键信息就在**画面上的字**里（字幕、界面文字、标题卡）。
 * ⚠️⚠️ **绝不能因为它拖慢/搞挂整条流程**：
 *    · 整段有硬上限（`budgetMs`），超了就当没有；
 *    · 任何失败都只是 `texts: []`，后面提示词里那一段就不出现；
 *    · 读字慢（16 秒/帧）+ 模型额度随时会用完 ⇒ 这是**加分项，不是必需项** ✓
 * ⚠️ 复用**已经开着的** `page` 拿播放地址（省一次打开，页面里 `__playinfo__` 现成的）✓
 */
let frames = { ok: false, texts: [] };
try {
  const { frameText } = await import('../src/bili-vision.js');
  frames = await frameText({ page, count: 3, budgetMs: 75000 });
  say(frames.ok
    ? `画面文字：${frames.texts.length} 帧读到字（${frames.model}，${(frames.ms / 1000).toFixed(0)}s）`
    : `画面文字：没读到（${frames.err}）—— 跳过，不影响发评论`);
  if (frames.ok && frames.texts.length) {
    say(`画面抽样：${frames.texts[0].replace(/\s+/g, ' ').slice(0, 80)}`);
  }
} catch (e) {
  say(`画面文字：出错（${e.message}）—— 跳过`);
}

/* ⚠️⚠️ 第三道保险（2026-10-21 用户：「**评论视频一定不要重复评论**」）
 *   前两道在 `src/bili-proactive.js`（永久 bvid 名单 + 发之前挡一道），
 *   这一道是**看页面**：评论区里要是已经有她自己的昵称，就直接不发了 ✓
 *   ⚠️ 为什么还要这一道：state 文件可能被删/换台机器跑，只有页面是"真相"。
 *   ⚠️ 局限：评论区是懒加载的，她的评论要是在很下面没滚到，这儿看不出来 ——
 *      所以它只是**兜底**，主力还是那两份名单。
 */
const mineOnPage = await page.evaluate(() => {
  const txt = document.body.innerText || '';
  return /蓝色大Saki|蓝色大saki/.test(txt);
});
if (mineOnPage) {
  say('⚠️ 这个视频下面**已经有我的评论了** ⇒ 不重复评论');
  try { await ctx.close(); } catch { /* ignore */ }
  console.log(JSON.stringify({ ok: false, already: true, video: VIDEO_URL, title: extra.title || info.title, err: '页面上已经有她的评论了' }));
  process.exit(0);
}

/* ── ② 让模型写一条评论 ─────────────────────────── */
/* ⚠️ 2026-10-22 改：从写死的 `SAKI_VOICE` 换成 `voiceBlock()` —— 它读**当前人设包**的
 *    `prompt/bili-comment.md`（用户：「b站那边评论要用到的人设在新建时也要完善好，
 *    和 QQ 这边一样」）⇒ 换人设 / 新建人设之后，主动评论的腔调跟着变 ✓ */
const { voiceBlock } = await import('../src/bili-publish.js');
const mem = shortMemory.block({ maxChars: 500 });
const sys = [
  '你在 B 站**看了一个别人的视频**，想留一条评论。',
  '',
  voiceBlock(),
  '',
  presence.block(),
  '',
  mem ? mem + '\n' : '',
  '要求：',
  '1. ⚠️ **像真的看过一样**：提**一个具体的点**（画面里的东西、他在做什么、这一步为什么这么做），' +
  '最好能对上**弹幕里大家在说的那个东西** —— 别空夸、别只说"好看""不错" ✗',
  '2. **一句话就够**，最多两句（10~40 字），口语，别写小作文',
  '3. 🚫 别求关注、别打广告、别放 QQ 群号 / 服务器 IP（你是来看视频的，不是来拉人的）',
  '4. 🚫 别用「up主」「大佬」这种套话堆砌；也别说自己是 AI',
  '5. 🚫 **别照抄弹幕里的话**（那是别人说的）—— 可以顺着说、可以接梗，但要换你自己的说法',
  '6. 可以带一点你自己的看法（喜欢 / 觉得麻烦 / 想起自己那边的事），但**别喧宾夺主**',
  '7. 只输出评论正文，不要引号、不要前缀',
  /* ⚠️ 2026-10-22 用户：「**每句都打了句号，语气词很少，倒是太多了**」
   *   评论回复那边已经加过这套，主动评论这里同样适用（而且这是**对外**发的，更像人更重要）✓ */
  '8. 🚫 **别打句号**（写完就完了）；✅ **挂个语气词**（啊/嘛/呗/诶/哦/呀/啦/呢/吧）—— 没语气词就是机器在播报 ✗',
  '9. ⚠️ **「倒」最多一个**（三四条里一次就够），连着用就成复读 ✗',
  '10. 🚫 别用「因此 / 此外 / 然而 / 而且」这类书面语连接词；别对称排比（「不是…而是…」）✗',
  '11. ✅ **句子长短不一**，别每条都卡在同一个长度；真人评论是想到哪说到哪 ✓',
  /* ⚠️ 2026-10-22 加：**画面上的字**怎么用（用户要求"逐帧看画面文字"就是为了这个）
   *    ⚠️ 只给方向：可以提一处，但别原样念 —— 念字幕是最典型的"AI 在读屏" ✗ */
  '12. ✅ 如果下面给了【画面上的字】，**可以提其中一处**（比只看标题强得多，说明你真看了）——' +
    '但要**换成你的话**，🚫 别把字幕原样念一遍、也别逐帧复述 ✗',
  /* ⚠️ 2026-10-22 加（实测生成过「第三帧那个"下"卡在那儿…」）——
   *    "第几帧 / 截图 / 抽帧 / 画面文字" 全是**我们内部的说法**，观众根本不知道，
   *    从她嘴里说出来就像机器在报日志 ✗ ⇒ 换成"刚才那个""中间那段"这种人的说法 ✓ */
  '13. 🚫 别说「第几帧」「截图」「抽帧」「画面文字」这种**技术词** —— ' +
    '你就说「刚才那个」「中间那段」「最后那一下」，像人一样 ✓',
].filter(Boolean).join('\n');
const user = [
  `视频：《${extra.title || info.title}》`,
  `UP：${extra.up || info.up}`,
  extra.duration ? `时长：${extra.duration} 秒` : '',
  extra.parts.length > 1 ? `分P：${extra.parts.slice(0, 10).join(' / ')}` : '',
  extra.tags.length ? `标签：${extra.tags.join('、')}` : '',
  (extra.desc || info.desc) ? `简介：${(extra.desc || info.desc).slice(0, 600)}` : '',
  '',
  // ⚠️ 弹幕是"画面里到底有什么"的最好来源（用户问的"真正读取视频内容"就靠它）
  extra.danmaku.length
    ? '【弹幕抽样】观众在画面里看到的东西（**这些才是视频的实际内容**，可以顺着聊）：\n' +
      extra.danmaku.map((x) => `· ${emojiText(x.text)}`).join('\n')
    : '（这个视频没有弹幕可参考）',
  '',
  /* ⚠️ 2026-10-22 加：**画面里读到的字**（抽帧 + 视觉模型）。
   *    和弹幕的区别：弹幕是观众**说**的，这是画面上**真有**的字（字幕/界面/标题卡）✓
   *    ⚠️ 读不到就整段不出现（`frames.ok` 为假）—— 别让模型以为"画面没字" */
  frames.ok && frames.texts.length
    ? '【画面上的字】我抽了几帧、把画面里的文字读出来了（**这是视频里真实出现的内容**）：\n' +
      frames.texts.map((t, i) => `· 第 ${i + 1} 帧：${emojiText(t).replace(/\n/g, ' ／ ').slice(0, 200)}`).join('\n') +
      '\n（⚠️ 只读字、没看画面，别把没读到的部分当真）'
    : '',
  '',
  extra.hot.length
    ? '【热门评论】观众关心什么（别跟这些说一样的）：\n' + extra.hot.map((x) => `· ${emojiText(x).slice(0, 80)}`).join('\n')
    : '',
  '',
  '下面是从页面上看到的评论（感受一下这里的气氛）：',
  info.tail,
].filter(Boolean).join('\n');

say('让模型写评论…');
let comment = '';
try {
  const ans = await llm.phrase({ system: sys, user, maxTokens: 400, timeoutMs: 40000, thinking: { type: 'disabled' } });
  /* ⚠️ 2026-10-22 用户：「**每句都打了句号，语气词很少**」—— 评论回复那边已经修了，
   *   主动评论这条**同一个毛病**，这里加一样的兜底（去句号 + 去破折号）✓ */
  comment = String(ans ?? '')
    .replace(/^["'「『]|["'」』]$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)
    .replace(/——+/g, '，')
    .replace(/—/g, '，')
    .replace(/，{2,}/g, '，')
    .replace(/。+$/, '')
    .trim();
} catch (e) {
  say('❌ 生成失败：' + e.message);
  try { await ctx.close(); } catch { /* ignore */ }
  process.exit(3);
}
if (!comment) { say('❌ 模型给了空评论'); try { await ctx.close(); } catch { /* ignore */ } process.exit(3); }
say(`写好了：${comment}`);

if (DRY) {
  say(`（dry，没有发）视频链接：${VIDEO_URL}`);
  try { await ctx.close(); } catch { /* ignore */ }
  console.log(JSON.stringify({ ok: true, dry: true, video: VIDEO_URL, comment }));
  process.exit(0);
}

/* ── ③ 发出去 ───────────────────────────────────── */
try {
  /* ⚠️⚠️ 2026-10-22 真踩到（截图看出来的）：输入框里**一直是占位符**
   *   「万水千山总是情，评论两句行不行」⇒ `keyboard.type()` **一个字都没打进去** ✗
   *   于是「发布」按钮压根没出现 ⇒ `findPublishBtn()` 找到的是**页面别处的**按钮 ⇒ 点了没反应 ✗
   *
   *   ⇒ 现在：**输完必须验证**（读 innerText 看有没有那段字），
   *     不行就换 `fill()`（对 contenteditable 更可靠），再不行 `insertText`，
   *     三种都不行就**直接报错**（绝不假装发了）✓
   */
  /* ⚠️⚠️ 2026-10-22 修（真 bug：`locator resolved to hidden <div class="brt-editor">`）——
   *    页面上有**好几个** `.brt-editor`（页头一个隐藏的、评论区里一个真的），
   *    `.first()` 挑中的是**隐藏的那个** ⇒ 等 15 秒超时 ⇒ 整个活白跑 ✗
   *    ⇒ 遍历找**可见的**那个；一个都没有就先点一下「发一条友善的评论」把评论区展开 ✓ */
  const pickEditor = async () => {
    const eds = page.locator('.brt-editor');
    const n = await eds.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const e = eds.nth(i);
      if (await e.isVisible().catch(() => false)) return e;
    }
    return null;
  };
  let editor = await pickEditor();
  if (!editor) {
    // 评论区没展开 ⇒ 点一下占位区（文字各家版本不太一样，用模糊匹配）
    say('没找到可见的输入框 ⇒ 试着点开评论区');
    for (const sel of ['.reply-box .brt-editor', '.comment-send .brt-editor', 'div[contenteditable="true"]']) {
      const e = page.locator(sel).first();
      if (await e.isVisible().catch(() => false)) { editor = e; break; }
    }
  }
  if (!editor) {
    await page.screenshot({ path: join(SHOT_DIR, 'noeditor.png') }).catch(() => {});
    throw new Error('页面上找不到可见的评论输入框（截图 noeditor.png）');
  }
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  await editor.scrollIntoViewIfNeeded().catch(() => {});
  await editor.click({ timeout: 15000 });
  await new Promise((r) => setTimeout(r, 600));

  const probe = comment.slice(0, 6).replace(/\s+/g, '');
  /* ⚠️⚠️ 2026-10-22 修（真 bug，截图看出来的）：输入框里**同一条评论出现了两遍** ✗
   *    真因：① `keyboard.type` 明明输进去了，但 `typedOk()` 判失败
   *          （`.brt-editor` 的 innerText 有时候读不到 / 有细微差异）
   *          ⇒ 兜底的 `fill()` 又执行一遍 ⇒ **变成两条** ⇒ 发出去就是重复评论 ✗
   *    ⇒ 两处一起改：
   *      ① `typedOk()` 除了"包含"，还要**只出现一次**（出现两次 = 兜底重复填了）；
   *      ② 每次兜底**之前先清空**（全选 + 删除），别在原文后面追加 ✓
   */
  const readBox = async () => String(await editor.innerText().catch(() => '')).replace(/\s+/g, '');
  const typedOk = async () => {
    const t = await readBox();
    if (!t.includes(probe)) return false;
    return t.split(probe).length - 1 === 1;   // ⚠️ 出现两遍就算失败
  };
  const clearBox = async () => {
    await editor.click({ timeout: 8000 }).catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
  };

  // ① 键盘输入（最像真人）
  await page.keyboard.type(comment, { delay: 25 });
  await new Promise((r) => setTimeout(r, 900));
  // ② fill（对 contenteditable 直接设内容，会触发 input 事件）
  if (!(await typedOk())) {
    say('键盘输入没进去（或重复了）⇒ 清空后用 fill()');
    await clearBox();
    await editor.fill(comment).catch(() => {});
    await new Promise((r) => setTimeout(r, 900));
  }
  // ③ insertText（剪贴板式插入）
  if (!(await typedOk())) {
    say('fill 也没进去 ⇒ 清空后用 insertText');
    await clearBox();
    await page.keyboard.insertText(comment).catch(() => {});
    await new Promise((r) => setTimeout(r, 900));
  }
  if (!(await typedOk())) {
    await page.screenshot({ path: join(SHOT_DIR, 'noinput.png') }).catch(() => {});
    throw new Error('内容输不进输入框（键盘/fill/insertText 三种都试了，截图 noinput.png）');
  }
  say('✅ 内容已进输入框');

  // 发布按钮：文字是「发布」
  /* ⚠️⚠️ 2026-10-21 真踩到（第一次真发就挂）：`page.locator('button:has-text("发布")').last()`
   *   ⇒ `locator.click: Timeout 15000ms exceeded`，而截图里**评论已经填好了、右下角「发布」按钮就在那儿** ✗
   *   真因：`button:has-text("发布")` 在整页能匹配到**好几个**（隐藏的/别处的），
   *        `.last()` 挑中的那个不可见 ⇒ Playwright 等它可点击，等到超时 ✗
   *   ⇒ 修法：**自己挑"可见 + 文字正好是发布"的那个**，并且三级兜底：
   *     ① 正常 click ② force click ③ 拿 boundingBox 用鼠标点坐标
   */
  async function findPublishBtn() {
    const cands = page.locator('button:has-text("发布"), [class*="submit"]:has-text("发布")');
    const n = await cands.count();
    for (let i = 0; i < n; i++) {
      const b = cands.nth(i);
      try {
        if (!(await b.isVisible())) continue;
        const t = (await b.innerText()).replace(/\s+/g, '').trim();
        if (t === '发布' || t === '发表评论' || t === '发送') return b;
      } catch { /* 这个不行，看下一个 */ }
    }
    return null;
  }
  const sendBtn = await findPublishBtn();
  if (!sendBtn) {
    await page.screenshot({ path: join(SHOT_DIR, 'nobtn.png') }).catch(() => {});
    throw new Error('找不到可见的「发布」按钮（已截图 nobtn.png）');
  }
  /* ⚠️ 2026-10-22 加诊断：把**点的是哪个按钮**打出来
   *   上一轮截图里输入框已经被清空了、而且下方根本没按钮 ⇒ 怀疑点到了页面别处的东西 ✗
   *   ⇒ 记下文字 / class / 坐标，下次一眼能看出点错了 ✓ */
  try {
    const info = await sendBtn.evaluate((el) => ({
      text: String(el.innerText || '').replace(/\s+/g, ''),
      cls: String(el.className || '').slice(0, 60),
      box: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
    }));
    say(`要点这个按钮：${JSON.stringify(info)}`);
  } catch { /* 拿不到就算了 */ }

  try {
    await sendBtn.click({ timeout: 8000 });
  } catch {
    say('正常点击没成功，改用 force 点一次');
    try {
      await sendBtn.click({ timeout: 8000, force: true });
    } catch {
      say('force 也不行，改用坐标点');
      const box = await sendBtn.boundingBox();
      if (!box) throw new Error('按钮拿不到坐标');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
  }
  // ⚠️ 点完**立刻**截一张（上一版等 4 秒，结果内容已经被清空了，看不出当时什么样）
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: join(SHOT_DIR, 'after-click.png') }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2800));
  await page.screenshot({ path: join(SHOT_DIR, 'sent.png') }).catch(() => {});
  /* ⚠️ 点完按钮**不等于发成功** —— 再核一遍
   * ⚠️⚠️ 2026-10-22 实测：**页面文本验证会误报失败** ——
   *   00:40 那条其实**发出去了**（接口查得到、页面上 2 分钟后才显示），
   *   但脚本当时只看"页面上有没有这段字" ⇒ 判成"没核实到" ✗
   *   ⇒ 现在**三重核实**（任何一重通过就算成功）：
   *     ① 输入框被清空（最直接的信号）
   *     ② 页面上出现了这段字（可能滞后）
   *     ③ **调接口查最新评论**（最准，等最多 20 秒）
   */
  const leftInBox = async () => page.locator('.brt-editor').first().innerText()
    .then((t) => String(t || '').replace(/\s+/g, '').includes(String(comment).replace(/\s+/g, '').slice(0, 10)))
    .catch(() => false);

  /* ⚠️⚠️ 2026-10-22 加：**明确识别"被风控"**（参考别人项目的做法）
   *
   *   今天实测撞到的原文：**「受到神秘力量干扰，请稍后再试！」**（截图抓到的）
   *   社区文档的说法（[v_voucher 验证](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/misc/sign/v_voucher.md)）：
   *     「当同一接口在**短时间内被同一用户/IP/UA 多次请求**或异常时，会触发风控」
   *   ⇒ 这是**账号/IP 级的临时限制**，**继续撞只会延长**（别人的项目 BiliPai 是
   *      「命中风控后**短期跳过**，避免无效重试」）✗
   *
   *   ⇒ 这里把页面上的固定文案**认出来**，回执里带 `blocked: true`，
   *     上层（`bili-proactive.js`）据此**全局暂停**，别让 20 分钟一次的定时任务一直撞 ✓
   *   ⚠️ 只认**页面给的固定字面**（不是猜人话），符合 AGENTS 的"认协议"例外 ✓ */
  const riskHit = await page.evaluate(() => {
    const t = document.body.innerText || '';
    const pats = [
      '受到神秘力量干扰',
      '请稍后再试',
      '操作过于频繁',
      '操作太频繁',
      '评论功能已被限制',
      '发送失败，请重试',
    ];
    const hit = pats.find((p) => t.includes(p));
    return hit || '';
  }).catch(() => '');
  if (riskHit) say(`⚠️ 页面上出现风控提示：「${riskHit}」`);

  let appeared = false;
  for (let i = 0; i < 2 && !appeared; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000));
    appeared = await page.evaluate((txt) => {
      const body = document.body.innerText || '';
      return body.includes(String(txt).slice(0, 10));
    }, comment).catch(() => false);
  }

  // ③ 接口核实（页面文本会滞后，这个最准）
  let viaApi = false;
  if (!appeared) {
    say('页面没看到 ⇒ 调接口核实（最多等 20 秒）');
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/203.0.113.10 Safari/537.36';
    for (let i = 0; i < 5 && !viaApi; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const v = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
          headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(12000),
        })).json();
        const aid = v?.data?.aid;
        if (!aid) continue;
        const rr = await (await fetch(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&pn=1&ps=20&sort=2`, {
          headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(12000),
        })).json();
        const reps = rr?.data?.replies || [];
        viaApi = reps.some((x) => String(x?.content?.message || '').replace(/\s+/g, '').includes(String(comment).replace(/\s+/g, '').slice(0, 12)));
      } catch { /* 网络抖动，再试 */ }
    }
    say(viaApi ? '✅ 接口查到了这条评论' : '接口也没查到');
  }

  const boxLeft = await leftInBox();
  if (appeared || viaApi || !boxLeft) {
    say(appeared ? '✅ 页面上已经能看到这条评论了' : viaApi ? '✅ 接口核实：评论已发出' : '✅ 输入框被清空了 ⇒ 已提交');
    shortMemory.add('bili-comment', `去别人的视频下发了一条评论（${String(info.title).slice(0, 24)}）：${comment.slice(0, 60)}`,
      { key: `proactive:${bvid}` });
    markVisited('ok');
    console.log(JSON.stringify({ ok: true, video: VIDEO_URL, title: info.title, comment, verified: appeared ? 'page' : viaApi ? 'api' : 'box' }));
  } else {
    /* ⚠️⚠️ 2026-10-22 真事故教训：这次报"没提交"，但**用户截图里它其实发出去了**（
     *   00:40 那条报成功、00:43 那条报失败，两条都在页面上）✗
     *   ⇒ `uncertain` 也**必须记 visited** —— 宁可少发一条，绝不重复发 ✓ */
    say('❌ 输入框里还留着这段话、接口也查不到 ⇒ 真的没提交');
    markVisited('uncertain');
    console.log(JSON.stringify({
      ok: false,
      uncertain: true,
      // ⚠️ 2026-10-22：**把"是不是风控"明确报上去** —— 上层据此全局暂停，别一直撞 ✓
      blocked: !!riskHit,
      blockedReason: riskHit || '',
      video: VIDEO_URL,
      title: info.title,
      comment,
      err: riskHit
        ? `被 B站风控拦了（页面提示「${riskHit}」）—— 这不是代码问题，是账号/IP 级临时限制`
        : '点了发布但没提交（接口也查不到，可能被风控拦了）',
    }));
  }
} catch (e) {
  await page.screenshot({ path: join(SHOT_DIR, 'fail.png') }).catch(() => {});
  say(`❌ 发送失败：${e.message}（截图在 ${SHOT_DIR}）`);
  console.log(JSON.stringify({ ok: false, video: VIDEO_URL, err: e.message.slice(0, 200) }));
}
try { await ctx.close(); } catch { /* ignore */ }
process.exit(0);
