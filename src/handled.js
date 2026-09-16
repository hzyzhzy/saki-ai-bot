/**
 * 「这条消息我**已经看过**了」—— 落盘的一份 message_id 记录。
 *
 * ## 为什么必须有它（2026-09-15 用户报的真 bug）
 *
 * 用户原话：「**补发机制还有点问题，现在出现了重启多少次回多少次消息的 bug**」。
 *
 * 根因：`bot.catchUpMissed()`（掉线补看）的去重**全在内存里**：
 *   · `catchUpSeen`（Set）—— 每进程一份，重启就空
 *   · `recent.hasMessageId()` —— 群聊上下文也是内存态，重启就空
 * 于是它判断"要不要补"只剩一个时间条件：**这条比我这次上线早、而且在 10 分钟内**
 * → **每重启一次，就把这 10 分钟里 @ 她的消息再答一遍** ✗✗
 *
 * ## 语义（很重要，别搞混）
 *
 * 记的是「**我见过**」，不是「我回过」：
 *   · 见过一条消息（哪怕判断成"不说"、没回），重启后**不该**再当漏消息补答
 *   · 只有**真正没见过**的（断线/假在线/重启期间到达的）才值得补
 * 所以要在"收到群消息"那条路上就记一笔，而不是在"回复成功"之后。
 *
 * ## 存多久
 *
 * 补看只看**10 分钟**内的，所以这里保留 **30 分钟**就够（多留点余量），
 * 超时的自动清掉，文件不会涨。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { log } from './log.js';

const STATE_DIR = join(ROOT, 'state');
// ⚠️ 给测试留出口（和 QQBOT_AFFINITY_FILE / QQBOT_NAMES_FILE 一个套路）
const FILE = process.env.QQBOT_HANDLED_FILE
  ? join(ROOT, process.env.QQBOT_HANDLED_FILE)
  : join(STATE_DIR, 'handled.json');

/** 保留多久（毫秒）—— 补看窗口是 10 分钟，这里给 3 倍余量 */
const KEEP_MS = 30 * 60 * 1000;
/** 上限（防止某个群刷屏把文件撑大） */
const MAX = 2000;

/** id -> 时间戳 */
let seen = new Map();
let dirty = false;
let timer = null;

export function reload() {
  try {
    if (!existsSync(FILE)) return;
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    const now = Date.now();
    seen = new Map(
      Object.entries(j?.ids ?? {})
        .map(([k, v]) => [String(k), Number(v) || 0])
        .filter(([k, t]) => k && now - t < KEEP_MS),
    );
    log.debug(`[已见消息] 载入 ${seen.size} 条`);
  } catch (e) {
    log.debug(`[已见消息] 读取失败（当作空的）：${e.message}`);
    seen = new Map();
  }
}

function save() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // 顺手清过期的
    const now = Date.now();
    for (const [k, t] of seen) if (now - t > KEEP_MS) seen.delete(k);
    // 还超上限就丢最老的
    if (seen.size > MAX) {
      const sorted = [...seen.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of sorted.slice(0, seen.size - MAX)) seen.delete(k);
    }
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ids: Object.fromEntries(seen) }), 'utf8');
    renameSync(tmp, FILE);
    dirty = false;
  } catch (e) {
    log.debug(`[已见消息] 写盘失败：${e.message}`);
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (dirty) save();
  }, 3000);
  timer.unref?.();
}

/** 记一笔「这条消息我见过了」 */
export function note(idOrEvent) {
  let id = '';
  if (idOrEvent && typeof idOrEvent === 'object') {
    id = String(idOrEvent.message_id ?? '').trim();
  } else {
    id = String(idOrEvent ?? '').trim();
  }
  if (!id || id === 'undefined') return false;
  seen.set(id, Date.now());
  dirty = true;
  schedule();
  return true;
}

/** 这条见过吗 */
export function has(id) {
  const k = String(id ?? '').trim();
  if (!k) return false;
  const t = seen.get(k);
  if (!t) return false;
  if (Date.now() - t > KEEP_MS) {
    seen.delete(k);
    return false;
  }
  return true;
}

export function status() {
  return { count: seen.size, file: FILE, keepMinutes: Math.round(KEEP_MS / 60000) };
}

/** 进程退出前把没写的写掉 */
export function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (dirty) save();
}

/** 测试用 */
export function __clear() {
  seen = new Map();
  dirty = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

// 启动时读一次
reload();
