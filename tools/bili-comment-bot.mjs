#!/usr/bin/env node
/**
 * B站**评论回复管家**（2026-10-22 加）
 *
 * ## 用户要求
 *   「继续接管 b 站账号的下一步，要能**回复在 b 站对她的回复消息**」
 *
 * ## 走哪条路（调研过同类项目之后的决定）
 *   参考项目（[bilibili-ai-bot](https://github.com/chenluQwQ/bilibili-ai-bot) 那一类）都是
 *   **Cookie + 接口**（`/x/v2/reply/add`）。那条路要自己算 **wbi 签名** + 处理 csrf，
 *   而且 B站对"接口直发评论"风控很严（新号尤其）。
 *   ⇒ 这里走**真浏览器**（复用 `state/bili-profile` 的登录态，和上传视频同一套）：
 *     在「创作中心 → 评论管理」页上**真实点击**「回复」→ 填输入框 → 点发送。
 *     慢一点，但**不需要逆向签名、行为就是人在点**，被封的风险小得多 ✓
 *     ⚠️ 实测：`el.click()` 不触发（React 合成事件）⇒ 必须用 Playwright 的真实鼠标点击。
 *
 * ## 用法
 *   node tools/bili-comment-bot.mjs --dry            # 只抓+生成，**不发**（先看效果）
 *   node tools/bili-comment-bot.mjs --max 2          # 真发，最多回 2 条
 *   node tools/bili-comment-bot.mjs --since-hours 720 --dry   # 放宽到 30 天内的评论（测试用）
 *
 * ## 三条保守设定（别随便调）
 *   ① 默认只看 **48 小时内**的评论（和短期记忆一个窗口）—— 老视频的旧评论不翻出来回 ✗
 *   ② 一次最多回 **3 条**（`--max`），两条之间**随机等 20~50 秒**
 *   ③ 已经处理过的评论记进短期记忆（`key` 去重），**同一辈子只回一次**
 */
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import * as shortMemory from '../src/short-memory.js';
import { SAKI_VOICE, loadState as loadPublishState } from '../src/bili-publish.js';
import { biliProfileDir } from './lib/browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (n) => argv.includes('--' + n);
const say = (s) => console.log(`[评论] ${s}`);

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// ⚠️ 2026-10-21：**按 QQ 号分 profile**（主号走老路径 state/bili-profile，别的号 state/bili-profile-<QQ>）
const PROFILE = biliProfileDir();
const URL_COMMENT = 'https://member.bilibili.com/platform/inter-active/comment';

const DRY = flag('dry');
const MAX = Math.max(1, Math.min(6, Number(arg('max', '3')) || 3));
const SINCE_H = Math.max(1, Number(arg('since-hours', '48')) || 48);
/** 只回命中这些关键词的评论（空 = 都回）—— 和 biliShare.keywords 一个用法 */
const KEYWORDS = String(arg('keywords', '') || '')
  .split(/[,，、|]/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const SHOT_DIR = join(ROOT, 'logs', `bili-comment-${stamp}`);
mkdirSync(SHOT_DIR, { recursive: true });

const cfg = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) || {};
const llm = cfg.llm || {};
if (!llm.apiKey || !llm.baseURL) { say('❌ config.yml 里没有 llm.apiKey / llm.baseURL'); process.exit(2); }

const nap = (a, b) => new Promise((r) => setTimeout(r, a + Math.random() * (b - a)));

/** 让模型写一句回复 */
/**
 * 这条视频是不是**她自己发的**？是就把当时的台词找出来。
 *
 * ⚠️⚠️ 用户 2026-10-22：「评论上下文如果是自己发的视频，还需要有**自己那条视频的台词**」
 *   观众常常是**针对某一句**在评论（"第三句啥意思""你不是说…"），没台词她只能瞎编 ✗
 * ⚠️ 匹配用**标题前 12 字**互相比 —— B站列表里的标题可能被截断（末尾带 …）
 * ⚠️ 不在 history 里 ⇒ 返回 null ⇒ 走"别认领创作"那条（账号下还有别人的旧视频）
 */
function myVideoOf(title) {
  const t = String(title || "").trim();
  if (!t) return null;
  try {
    const st = loadPublishState();
    const head = t.slice(0, 12);
    return (st.history || []).find((x) => {
      if (!x || !x.ok || !x.title) return false;
      const h = String(x.title);
      return h.slice(0, 12) === head || h.includes(head) || t.includes(h.slice(0, 12));
    }) || null;
  } catch {
    return null;
  }
}

async function makeReply({ video, who, text, isSelfThread, lines, when }) {
  const mem = shortMemory.block({ maxChars: 700 });
  const isMine = Array.isArray(lines) && lines.length > 0;
  const sys = [
    '你在 B 站自己的视频下面**回复一条评论**。',
    '',
    SAKI_VOICE,
    '',
    mem ? mem + '\n' : '',
    '要求：',
    '0. ⚠️⚠️ **这个视频不一定是"你做的"** —— 这个账号下面还有别人发的旧视频（比如轨交、铁路那些）。',
    '   ⇒ **别认领创作细节**（不要说"我铺的""我调的""我试了三回"这种）✗',
    '   被问技术细节 ⇒ 老实说不清楚 / 让他问作者；被夸 ⇒ 接一句就行（可以自嘲"我也就看看"）',
    '   ⚠️ 只有**明确是你自己发的**（那种情况下面会**直接把台词给你**）才按作者口吻回',
    '1. **一句话就够**，最多两句（8~30 字），别写小作文',
    '2. 别 @ 人、别加「感谢支持」「欢迎关注」这种客套 ✗',
    '3. 对方是**夸你**就接一句（可以嘴硬、可以自嘲）；**提问**就直接答；',
    '   **挑刺/阴阳**就按你的脾气怼回去（但别骂人、别上纲上线）；**没营养的**（就一个表情）',
    '   就短促接一下，别硬聊',
    '4. 别重复对方的话，别解释自己是 AI（除非对方直接问、且你已经承认过的口径）',
    '5. 只输出**回复正文**，不要引号、不要前缀',
  ].filter(Boolean).join('\n');
  const user = [
    `视频：《${video}》`,
    when ? `评论时间：${when}（**就是最近的事**，别当成好几天前的老黄历）` : '',
    `${isSelfThread ? '（这条是回复你的评论下面的）' : ''}`,
    `评论者：${who}`,
    `评论内容：${text}`,
    isMine
      ? '\n⚠️ **这个视频是你自己发的**，你当时说的台词是：\n' +
        lines.map((l, i) => `${i + 1}. ${l}`).join('\n') +
        '\n（评论很可能就是在说其中某一句 —— 对得上就直接接，别装作不记得；' +
        '但也不用逐句复述台词，一句话回完就行）'
      : '',
  ].filter(Boolean).join('\n');

  const r = await fetch(String(llm.baseURL).replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llm.apiKey },
    body: JSON.stringify({
      model: llm.model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0.8,
      max_tokens: 300,
      thinking: { type: 'disabled' },
    }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`模型 HTTP ${r.status} ${body.slice(0, 200)}`);
  const j = JSON.parse(body);
  let out = String(j?.choices?.[0]?.message?.content ?? '').trim();
  out = out.replace(/^["'「『]|["'」』]$/g, '').replace(/\s+/g, ' ').trim();
  if (!out) throw new Error('模型给了空回复');
  return out.slice(0, 120);
}

/* ── 主流程 ─────────────────────────────────────── */
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: true,
  viewport: { width: 1600, height: 1100 },
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = await ctx.newPage();
say(`打开评论管理页…`);
await page.goto(URL_COMMENT, { waitUntil: 'domcontentloaded', timeout: 45000 });
await nap(5000, 7000);

/** 抓列表：视频标题 / 评论者 / 内容 / 时间 / 是否子回复 */
const items = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.comment-list-item').forEach((el) => {
    const video = (el.querySelector('.article-wrap .title')?.innerText || '').trim();
    const titleEl = el.querySelector('.ci-title');
    // `.ci-title` 里可能有"回复 @xxx 的评论"，真正的评论者名字在它的 <a> 里
    const who = (titleEl?.querySelector('a')?.innerText || titleEl?.innerText || '').trim();
    const content = (el.querySelector('.ci-content')?.innerText || '').trim();
    const date = (el.querySelector('.ci-action .date')?.innerText || '').trim();
    const isReply = /回复\s*@/.test(titleEl?.innerText || '');
    const isSelf = /蓝色大Saki|Saki|祥子/.test(who);
    if (content) out.push({ video, who, content, date, isReply, isSelf });
  });
  return out;
});
say(`抓到 ${items.length} 条评论`);

/* 只处理窗口内的、不是她自己发的、且没处理过的 */
const cut = Date.now() - SINCE_H * 3600 * 1000;
const todo = [];
for (const it of items) {
  if (it.isSelf) continue;                       // 她自己发的跳过
  if (it.isReply) continue;                      // 已经是一层回复了，先不往里插话
  const t = Date.parse(it.date.replace(/-/g, '/'));
  if (!Number.isFinite(t) || t < cut) continue;
  // ⚠️ 关键词筛选（用户要求"照 B站分享那套"）：空数组 = 都回
  if (KEYWORDS.length && !KEYWORDS.some((k) => it.content.includes(k))) continue;  // 老评论不翻出来回
  const key = `bili-c:${it.video.slice(0, 30)}|${it.who}|${it.content.slice(0, 40)}`;
  if (shortMemory.list({ limit: 200 }).some((x) => x.key === key)) continue; // 回过
  todo.push({ ...it, key, at: t });
}
todo.sort((a, b) => b.at - a.at);
say(`窗口内（${SINCE_H}h）待回 ${todo.length} 条，本次最多处理 ${Math.min(MAX, todo.length)} 条`);
if (!todo.length) {
  say('没有要回的（要么没新评论，要么都回过了）');
  try { await ctx.close(); } catch {}
  process.exit(0);
}

let done = 0;
for (const it of todo.slice(0, MAX)) {
  say(`—— 处理：${it.who}「${it.content.slice(0, 40)}」（${it.date}）`);
  let reply = '';
  try {
    const mine = myVideoOf(it.video);
    if (mine) {
      const nl = (mine.lines || []).length;
      say(`   这条是她自己发的（${String(mine.title).slice(0, 24)}）⇒ 带上当时的台词 ${nl} 句`);
    }
    reply = await makeReply({
      video: it.video, who: it.who, text: it.content, isSelfThread: it.isReply,
      lines: mine ? mine.lines : null, when: it.date,
    });
    say(`   生成回复：${reply}`);
  } catch (e) {
    say(`   ❌ 生成失败：${e.message} ⇒ 跳过这条`);
    continue;
  }
  if (DRY) { done++; continue; }

  /* 真发：找到对应的那条列表项 → 点回复 → 填 → 发送 */
  try {
    const row = page.locator('.comment-list-item').filter({ hasText: it.content.slice(0, 20) }).first();
    await row.locator('.ci-action .reply.action a').first().click({ timeout: 8000 });
    const box = page.locator('textarea[placeholder^="回复 @"]').first();
    await box.waitFor({ state: 'visible', timeout: 8000 });
    await box.fill(reply);
    await nap(600, 1200);
    // 发送按钮：回复框附近、文字是"发送/发布/回复"
    const sendBtn = page.locator('button:has-text("发送"), button:has-text("发布"), .btn:has-text("发送")').last();
    await sendBtn.click({ timeout: 8000 });
    await nap(2500, 4000);
    await page.screenshot({ path: join(SHOT_DIR, `sent-${done + 1}.png`) });
    say(`   ✅ 已发送`);
    shortMemory.add('bili-comment', `回复了 ${it.who} 的评论（${it.video.slice(0, 20)}）：他说「${it.content.slice(0, 40)}」，我回「${reply.slice(0, 40)}」`, { key: it.key });
    done++;
  } catch (e) {
    say(`   ❌ 发送失败：${e.message}`);
    await page.screenshot({ path: join(SHOT_DIR, `fail-${done + 1}.png`) }).catch(() => {});
  }
  await nap(20000, 50000);   // ⚠️ 两条之间必须间隔（像人一样，别连发）
}

say(`完成：${done} 条${DRY ? '（dry，没有真的发）' : ''}；截图在 ${SHOT_DIR}`);
try { await ctx.close(); } catch {}
process.exit(0);
