#!/usr/bin/env node
/**
 * B站**常驻浏览器**服务（2026-10-22 加）
 *
 * ## 为什么要有它
 *   用户：「**可以不每次回复评论都起一遍吗，直接每次启动机器人时都启动一个最大化节省资源的
 *   浏览器实例，一直运行**」
 *   ⇒ 原来每次检查评论都要：spawn 一个 node → Playwright 起 Chrome（**20~30 秒**）→ 抓 → 退出。
 *     一天查几十次就是反复冷启动，又慢又费 ✗
 *   ⇒ 这个进程**只起一次 Chrome，然后一直挂着**，之后每次检查只要 `goto` 一下（2~3 秒）✓
 *
 * ## 协议（一行一个 JSON，stdout 只许是结果行，日志全走 stderr）
 *   请求 → 回复
 *   {"op":"ping"}                                   → {"ok":true,"ready":true}
 *   {"op":"check"}                                  → {"ok":true,"items":[{video,who,uid,content,date,isReply,replyTo,isSelf}]}
 *   {"op":"reply","target":"评论前20字","text":"…","who":"谁"} → {"ok":true,"sent":true}
 *   {"op":"login"}                                  → {"ok":true,"isLogin":true,"uname":"…","mid":123}
 *   {"op":"quit"}                                   → 进程退出
 *
 * ## ⚠️ 和「上传视频」抢同一个 Chrome profile
 *   `state/bili-profile` 一个 user-data-dir **只能被一个 Chrome 占着** ⇒
 *   这个服务开着的时候，`bili-upload.mjs` 起不来 ✗
 *   ⇒ 上传视频前必须调 `bili-comments.release()` 把它停掉（`bili-publish.js` 里已经接了）。
 *
 * ## ⚠️ 为什么不用 `chromium.launch()` + 单独 profile
 *   那要重新登录一遍 B站。必须复用 `state/bili-profile` 里现成的登录态 ✓
 */

import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// ⚠️ 2026-10-22：统一在这里决定用哪个浏览器
//    （系统 Chrome 优先 + 独立 profile；没有 Chrome 才用内置 Chromium）
import { browserOpts , biliProfileDir } from './lib/browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.BILI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// ⚠️ 2026-10-21：**按 QQ 号分 profile**（主号走老路径 state/bili-profile，别的号 state/bili-profile-<QQ>）
const PROFILE = biliProfileDir();
const URL_COMMENT = 'https://member.bilibili.com/platform/inter-active/comment';

const log = (s) => process.stderr.write(`[bili-browser] ${s}\n`);
const reply = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); };
const nap = (a, b) => new Promise((r) => setTimeout(r, a + Math.random() * (b - a)));

if (!existsSync(CHROME)) { reply({ ok: false, err: `找不到 Chrome：${CHROME}` }); process.exit(1); }
if (!existsSync(PROFILE)) { reply({ ok: false, err: `没有登录态目录 ${PROFILE}（先跑 tools/bili-login.mjs）` }); process.exit(1); }

let ctx = null;
let page = null;

async function boot() {
  const t0 = Date.now();
  ctx = await chromium.launchPersistentContext(PROFILE, {
    ...browserOpts(),
    headless: true,
    viewport: { width: 1600, height: 1100 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });
  page = await ctx.newPage();
  log(`浏览器就绪（${Date.now() - t0}ms）`);
}

/** 查登录态（2026-10-21 加：**登录态被踢了要能第一时间知道**）
 *
 * ⚠️ 真事故：19:02~19:15 之间 B站 把会话踢了，cookie 还在但 `nav` 返回 -101，
 *   ⇒ 评论回复从那时起一直空转（抓到 0 条），**没有人知道** ✗
 *   ⇒ 这个 op 只做一件事：问服务端「我还登录着吗」（**只认 nav，不信 cookie**）✓
 */
async function loginState() {
  try {
    /* ⚠️ 2026-10-21：**别用 `page.evaluate(fetch)` 查** —— 那是从 `www.bilibili.com`
     *   跨子域打 `api.bilibili.com`，CORS 会**把 cookie 丢掉**，
     *   于是永远返回「未登录」，跟真实状态对不上 ✗
     *   ⇒ 用 `ctx.request`（Playwright 的 context 级请求，**自带 cookie、不过浏览器 CORS**）✓ */
    const r = await ctx.request.get('https://api.bilibili.com/x/web-interface/nav', { timeout: 20000 });
    const j = await r.json();
    return {
      ok: true,
      isLogin: j?.data?.isLogin === true,
      uname: String(j?.data?.uname || ''),
      mid: Number(j?.data?.mid) || 0,
      code: Number(j?.code) || 0,
    };
  } catch (e) {
    return { ok: false, err: e.message.slice(0, 120) };
  }
}

/** 打开（或刷新）评论管理页，抓评论列表 */
async function check() {
  const t0 = Date.now();
  await page.goto(URL_COMMENT, { waitUntil: 'domcontentloaded', timeout: 45000 });
  /* ⚠️ 别用固定的 `nap(3500,5000)` 等列表 —— 那白等 3~5 秒 ✗
   *   改成**等元素出现**（有就立刻往下走），实测 5.2s → 2~3s ✓ */
  try {
    await page.waitForSelector('.comment-list-item', { timeout: 15000 });
  } catch { /* 没有评论也算正常 */ }
  await nap(500, 900);   // 给列表渲染完的余量
  const items = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.comment-list-item').forEach((el) => {
      const video = (el.querySelector('.article-wrap .title')?.innerText || '').trim();
      const titleEl = el.querySelector('.ci-title');
      const whoA = titleEl?.querySelector('a');
      const who = (whoA?.innerText || titleEl?.innerText || '').trim();
      // ⚠️ 2026-10-22：**评论者的 B站 uid** 也要抓（用户要求「B站 uid 394060600 等同 QQ 的主人」）
      //    从昵称那个 <a> 的 href 里取：//space.bilibili.com/394060600
      const href = whoA?.getAttribute('href') || '';
      const uid = (String(href).match(/space\.bilibili\.com\/(\d+)/) || [])[1] || '';
      const content = (el.querySelector('.ci-content')?.innerText || '').trim();
      const date = (el.querySelector('.ci-action .date')?.innerText || '').trim();
      const titleText = (titleEl?.innerText || '').trim();
      const isReply = /回复\s*@/.test(titleText);
      /* ⚠️⚠️ 2026-10-21 实测（探针抓到的真实数据，别再照 title 抓）：
       *   title 长这样：`粉丝Dev通道回复@Dev通道的评论查看评论`
       *     —— 中间**没有空格**，而且「回复@」后面跟的是**父评论所在的位置**（谁的评论下），
       *        不是"被回复的人" ⇒ 拿它当 replyTo，正则会把 `的评论查看评论` 一起吞掉 ✗
       *   真正被回复的人在 **content 里**：`回复 @蓝色大Saki :作者是谁`
       *   ⇒ replyTo 一律**从 content 抓**（那是 B站加的固定前缀，算认协议字面 ✓）
       */
      const replyTo = (content.match(/回复\s*@\s*([^\s:：]+)/) || [])[1] || '';
      const isSelf = /蓝色大Saki|Saki|祥子/.test(who);
      if (content) out.push({ video, who, uid, content, date, isReply, replyTo, isSelf });
    });
    return out;
  });
  log(`抓到 ${items.length} 条（${Date.now() - t0}ms）`);
  return items;
}

/** 回一条：按内容前 20 字定位那一行 → 点回复 → 填 → 发送
 *
 * ⚠️⚠️ 2026-10-22 实测踩到：第一版直接 `row.locator('.reply.action a').click()`
 *   ⇒ `locator.click: Timeout 8000ms exceeded` ✗（跑了两次都失败，一条没回成）
 *   真因：**那条评论不在视口里**（列表是长滚动，目标在下面），
 *         Playwright 自动滚动后被页面的固定栏挡住 ⇒ 点不中
 *   ⇒ 修法三件套：
 *     ① 先 `waitFor({state:'visible'})` 确认真的渲染了
 *     ② `scrollIntoViewIfNeeded()` 滚到中间
 *     ③ 选择器**逐级放宽**（`.reply.action a` → `.reply.action` → `.reply`），超时给 15 秒
 *   还失败就**截一张图**存 logs/，下次能直接看是页面变了还是被挡了
 */
async function doReply(target, text, who) {
  const t = String(target || '').trim();
  const body = String(text || '').trim();
  const w = String(who || '').trim();
  if (!t || !body) return { ok: false, err: '缺 target / text' };
  /* ⚠️ 2026-10-21：楼中楼的内容常常**和父评论一模一样**（"回复 @我：哈哈" 挂在我那句下面）
   *   ⇒ 只按内容前 12 字定位会**命中错的那一行** ✗
   *   所以给了 who 就再加一道：**同一行里必须同时出现这个人名** ✓ */
  let row = page.locator('.comment-list-item').filter({ hasText: t.slice(0, 12) });
  if (w) row = row.filter({ hasText: w });
  row = row.first();
  if (!(await row.count())) return { ok: false, err: '页面上找不到那条评论（可能翻页了/已刷新）' };
  try {
    await row.waitFor({ state: 'visible', timeout: 15000 });
    await row.scrollIntoViewIfNeeded();
    await nap(400, 800);

    // 选择器逐级放宽
    let btn = row.locator('.ci-action .reply.action a');
    if (!(await btn.count())) btn = row.locator('.ci-action .reply.action');
    if (!(await btn.count())) btn = row.locator('.reply.action');
    if (!(await btn.count())) {
      await page.screenshot({ path: join(ROOT, 'logs', 'bili-reply-nobtn.png') }).catch(() => {});
      return { ok: false, err: '这条评论上找不到「回复」按钮（已截图 logs/bili-reply-nobtn.png）' };
    }
    await btn.first().click({ timeout: 15000 });
    await nap(600, 1000);

    const box = page.locator('textarea[placeholder^="回复 @"]').first();
    await box.waitFor({ state: 'visible', timeout: 15000 });
    await box.fill(body);
    await nap(500, 1000);
    /* ⚠️⚠️ 2026-10-22 真凶（看截图才发现的）：B站这个回复框的按钮叫「**发表回复**」，
     *   不是「发送」/「发布」⇒ 原来那三个选择器**一个都匹配不到**，于是卡在最后一步 ✗
     *   截图证据：回复框里已经填好了内容，下面那个蓝色按钮写着「发表回复」 */
    const sendBtn = page
      .locator('button:has-text("发表回复"), button:has-text("发送"), button:has-text("发布")')
      .first();
    await sendBtn.click({ timeout: 15000 });
    await nap(2200, 3500);
    return { ok: true, sent: true };
  } catch (e) {
    await page.screenshot({ path: join(ROOT, 'logs', 'bili-reply-fail.png') }).catch(() => {});
    return { ok: false, err: `${e.message.slice(0, 160)}（已截图 logs/bili-reply-fail.png）` };
  }
}

/* ── 主循环：一行一个请求 ─────────────────────────── */
try {
  await boot();
} catch (e) {
  reply({ ok: false, err: `浏览器起不来：${e.message}（多半是 state/bili-profile 被别的 Chrome 占着）` });
  process.exit(1);
}
reply({ ok: true, ready: true, ms: 0 });

let buf = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch (e) { reply({ ok: false, err: '不是 JSON' }); continue; }
    const op = String(req.op || '');
    try {
      if (op === 'ping') reply({ ok: true, ready: true });
      else if (op === 'check') reply({ ok: true, items: await check() });
      else if (op === 'reply') reply(await doReply(req.target, req.text, req.who));
      else if (op === 'login') reply(await loginState());
      else if (op === 'quit') { reply({ ok: true }); break; }
      else reply({ ok: false, err: `不认识的 op：${op}` });
    } catch (e) {
      // ⚠️ 页面崩了/被导航走了 ⇒ 下次 check 会重新 goto，不用重建浏览器
      reply({ ok: false, err: `${op} 失败：${e.message}` });
    }
  }
}

try { await ctx?.close(); } catch { /* ignore */ }
log('退出');
process.exit(0);
