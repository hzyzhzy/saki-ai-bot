/**
 * 素材库：攒群里值得发到 QQ 空间的瞬间。
 *
 * 和 recent.js 的区别：
 *   recent.js  —— 短窗口（15 条），给模型理解当前对话用，随用随丢
 *   digest.js  —— 长窗口（几小时到一天），攒着给「发说说」挑素材用
 *
 * ⚠️ 素材（items）只在内存里，重启就清空 —— 那没关系，素材是「最近的群消息」，
 *    重新攒就行。
 *
 * ⚠️ 但**「已经发过哪些说说」（lastPosts）必须持久化**！
 *    以前它也在内存里，结果机器人一重启就忘了刚发过什么，
 *    把同一个梗连着发三遍（用户反馈：「连发三遍一模一样的事情」）。
 *    调试期间频繁重启时特别明显。现在存到 state/qzone-posts.json。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './log.js';
import * as persona from './persona.js';

const STATE_DIR = join(ROOT, 'state');
// ⚠️ 路径可以用环境变量覆盖 —— **给测试用**（2026-09-14 加）。
//
//    原来写死 `state/qzone-posts.json`，于是测试一调 `qzone.publish()`，
//    `markPosted()` 就往**真实文件**里塞了一条假说说
//    （`tid=fake-tid-1` / 「测试说说1789391672129」）—— 真踩了。
//    `qzone.js` 那边加了 `QQBOT_QZONE_FILE`，这里必须同样处理，
//    不然隔离只做了一半（测试照样污染真实"已发记录"，会影响判重和提示词）。
const POSTS_FILE = process.env.QQBOT_DIGEST_FILE
  ? join(ROOT, process.env.QQBOT_DIGEST_FILE)
  : join(STATE_DIR, 'qzone-posts.json');

/** [{ name, userId, text, time, chatty }] */
let items = [];
/** 已经发过的说说（持久化，重启不丢） */
let lastPosts = [];

const MAX_ITEMS = 400;
/** 已发记录留这么多条（够模型判断「这个话题发过了」） */
const MAX_POSTS = 20;

function loadPosts() {
  try {
    if (!existsSync(POSTS_FILE)) return [];
    const j = JSON.parse(readFileSync(POSTS_FILE, 'utf8'));
    const list = Array.isArray(j?.posts) ? j.posts : [];
    // 只留最近 7 天，太老的没参考价值
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    return list.filter((p) => Number(p.at) > cutoff).slice(0, MAX_POSTS);
  } catch (e) {
    log.debug(`读已发说说记录失败：${e.message}`);
    return [];
  }
}

function savePosts() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${POSTS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ posts: lastPosts.slice(0, MAX_POSTS) }, null, 2), 'utf8');
    renameSync(tmp, POSTS_FILE);
  } catch (e) {
    log.warn(`保存已发说说记录失败：${e.message}`);
  }
}

// 启动就载入，这样重启后仍然记得发过什么
lastPosts = loadPosts();
if (lastPosts.length) log.info(`已载入 ${lastPosts.length} 条已发说说记录（避免重复发同一个话题）`);

/**
 * 记一条群消息。
 * @param {object} event
 * @param {{text:string}} parsed
 * @param {(text:string)=>boolean} [isInteresting] 判定有没有意思，不传就全收
 */
export function note(event, parsed = {}, isInteresting = null) {
  if (!config.qzone?.enable) return;
  if (event.message_type !== 'group') return;

  const text = String(parsed.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return;
  if (text.length < (config.qzone?.minChars ?? 4)) return;
  if (text.length > 400) return; // 太长的不适合当素材

  // 明显没营养的丢掉
  if (/^[\s\d.、，,。!！?？~～h]+$/i.test(text)) return;

  if (isInteresting && !isInteresting(text)) return;

  items.push({
    name: event.sender?.card || event.sender?.nickname || String(event.user_id),
    userId: String(event.user_id),
    text,
    time: Date.now(),
  });

  // 只保留配置的时间窗内
  const maxAge = config.qzone?.windowMs ?? 12 * 3600 * 1000;
  const now = Date.now();
  items = items.filter((m) => now - m.time < maxAge).slice(-MAX_ITEMS);
}

/**
 * ⚠️⚠️ **记一条她自己说的话**（2026-09-15 深夜加）。
 *
 * 为什么必须收：素材库原来**只收群友说的** ✗ —— 于是发说说的时候，
 * 她只看到「有人问我回滚点是什么」，**看不到那句话是她自己先说的** ✗，
 * 结果发了一条「有人问我回滚点是什么。……我说过这个词吗。」
 * （<主人> 的原话：「她自己造的这个词自己居然还不知道自己说过了」）
 *
 * 所以：她在群里说的话也进素材（标上"你自己"），发说说 / 汇总时才不会
 * 把自己的话当成别人的、或者怀疑自己的记忆。
 *
 * @param {string|number} groupId
 * @param {string} text
 */
export function noteBot(groupId, text) {
  if (!config.qzone?.enable) return;
  const gid = String(groupId ?? '').trim();
  if (!gid) return;
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return;
  if (t.length < (config.qzone?.minChars ?? 4)) return;
  if (t.length > 400) return;
  if (/^[\s\d.、，,。!！?？~～h]+$/i.test(t)) return;
  items.push({ name: persona.narrativeName(), userId: '__self__', self: true, groupId: gid, text: t, time: Date.now() });
  const maxAge = config.qzone?.windowMs ?? 12 * 3600 * 1000;
  const now = Date.now();
  items = items.filter((m) => now - m.time < maxAge).slice(-MAX_ITEMS);
}

/** 攒了多少条、时间跨度多长 */
export function stats() {
  if (!items.length) return { count: 0, spanMinutes: 0, newest: 0 };
  const now = Date.now();
  return {
    count: items.length,
    spanMinutes: Math.round((now - items[0].time) / 60000),
    newest: Math.round((now - items[items.length - 1].time) / 60000),
  };
}

/** 取最近的素材，从旧到新 */
export function take(limit = null) {
  const n = limit ?? config.qzone?.maxMaterial ?? 60;
  return items.slice(-n);
}

/** 拼成给模型看的文本 */
export function materialText(limit = null) {
  const list = take(limit);
  if (!list.length) return '';
  return list
    .map((m) => {
      // ⚠️ 她自己说的要**明确标出来**（2026-09-15 深夜）——
      //    不然发说说时她认不出自己的话（踩过：「我说过这个词吗」）。
      const who = m.self ? '**你自己在群里说的**（不是群友说的）' : m.name;
      return `${who}：${m.text}`;
    })
    .join('\n');
}

/** 发完说说后记一笔，避免下次重复发同样的内容 */
export function markPosted(content, meta = {}) {
  lastPosts.unshift({ content: String(content ?? '').slice(0, 200), at: Date.now(), ...meta });
  lastPosts = lastPosts.slice(0, MAX_POSTS);
  savePosts(); // ⚠️ 必须落盘：不然重启就忘了发过什么，会把同一个梗重发（踩过）
  // 发完之后素材清掉，下一次从新内容里挑
  items = [];
}

/**
 * 直接灌入素材（从群历史导入时用）。
 * @param {Array<{name:string, userId?:string, text:string, time?:number}>} list
 */
export function load(list = []) {
  const maxAge = config.qzone?.windowMs ?? 12 * 3600 * 1000;
  const now = Date.now();
  for (const m of list) {
    const text = String(m.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < (config.qzone?.minChars ?? 4) || text.length > 400) continue;
    if (/^[\s\d.、，,。!！?？~～h]+$/i.test(text)) continue;
    items.push({
      name: String(m.name ?? '群友'),
      userId: String(m.userId ?? ''),
      text,
      // 没给时间就当作「刚刚」，免得被时间窗过滤掉
      time: Number(m.time) || now,
    });
  }
  items = items.filter((m) => now - m.time < maxAge).slice(-MAX_ITEMS);
  return items.length;
}

/** 最近发过的说说（给模型看，避免重复） */
export function recentPostsText() {
  if (!lastPosts.length) return '';
  return lastPosts.map((p, i) => `${i + 1}. ${p.content}`).join('\n');
}

export function posts() {
  return [...lastPosts];
}

export function clearAll() {
  items = [];
  lastPosts = [];
}
