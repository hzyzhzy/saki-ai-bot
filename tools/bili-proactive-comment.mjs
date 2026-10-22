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
if (!bvid && urlIn) bvid = (urlIn.match(/video\/(BV[0-9A-Za-z]+)/) || [])[1] || '';
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
const ctx = await chromium.launchPersistentContext(PROFILE, {
  ...browserOpts(),
  headless: true,
  viewport: { width: 1500, height: 1000 },
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
});
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
  const editor = page.locator('.brt-editor').first();
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  await editor.scrollIntoViewIfNeeded().catch(() => {});
  await editor.click({ timeout: 15000 });
  await new Promise((r) => setTimeout(r, 600));

  const probe = comment.slice(0, 6).replace(/\s+/g, '');
  const typedOk = async () => {
    const t = await editor.innerText().catch(() => '');
    return String(t).replace(/\s+/g, '').includes(probe);
  };

  // ① 键盘输入（最像真人）
  await page.keyboard.type(comment, { delay: 25 });
  await new Promise((r) => setTimeout(r, 900));
  // ② fill（对 contenteditable 直接设内容，会触发 input 事件）
  if (!(await typedOk())) {
    say('键盘输入没进去 ⇒ 换 fill()');
    await editor.fill(comment).catch(() => {});
    await new Promise((r) => setTimeout(r, 900));
  }
  // ③ insertText（剪贴板式插入）
  if (!(await typedOk())) {
    say('fill 也没进去 ⇒ 换 insertText');
    await editor.click({ timeout: 8000 }).catch(() => {});
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
      ok: false, uncertain: true, video: VIDEO_URL, title: info.title, comment,
      err: '点了发布但没提交（接口也查不到，可能被风控拦了）',
    }));
  }
} catch (e) {
  await page.screenshot({ path: join(SHOT_DIR, 'fail.png') }).catch(() => {});
  say(`❌ 发送失败：${e.message}（截图在 ${SHOT_DIR}）`);
  console.log(JSON.stringify({ ok: false, video: VIDEO_URL, err: e.message.slice(0, 200) }));
}
try { await ctx.close(); } catch { /* ignore */ }
process.exit(0);
