import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, stateDir } from './config.js';
import { log } from './log.js';

/** 每个会话（私聊用户 / 群）保留的最近若干轮对话 */
const store = new Map(); // key -> { role, content }[]

/**
 * 内存里**最多留几轮**（比"喂给模型看的"多留几倍）。
 *
 * ⚠️⚠️ 2026-10-22 加（用户：「**剧情时上下文的窗口要拉长一点**」）：
 *    原来 `remember()` 按 `historyRounds * 2` **一边写一边裁** ⇒ 想"剧情时临时多要几轮"
 *    是**补不回来的**（早被 shift 掉了）✗
 *    ⇒ 现在内存里留 `KEEP_FACTOR` 倍，`getHistory()` 再按需截取：
 *      · 日常聊天：`trigger.historyRounds` 轮（行为一个字没变 ✓）
 *      · 剧情进行中：`questHistoryRounds()` 轮（见下）✓
 */
const KEEP_FACTOR = 3;

/* ══════════════════════════════════════════════════════════════════════════
 * 落盘（2026-11-23 加）
 *
 * ⚠️⚠️ 起因：「**重启不要清历史对话**」——
 *   这个 `store` 原来**纯内存**，一重启就清零，日志里那句
 *   `[历史] lite 取：store 0 条` 就是这么来的 ⇒ 后果三连：
 *     ① 她忘了刚才聊了什么（同一句话会被问两遍）
 *     ② lite 提示词里的历史段突然变空 ⇒ **提示词结构跟前一轮不同** ⇒
 *        重启后第一轮的缓存命中率必然掉下去（实测 96% → 86%）
 *     ③ 每次改代码重启都在丢，一天丢好几次
 *
 * ⇒ 现在按号落盘到 `<stateDir>/history.json`：
 *   · **惰性加载**（第一次用到才读，模块 import 时不碰磁盘）
 *   · **防抖 1.5 秒**再写（群里消息密集时不至于每条都刷盘）
 *   · **原子写**（先写 `.tmp` 再 rename，断电/被杀不会留半个 JSON）
 *   · 退出时再同步 flush 一次，尽量不丢最后一两句
 * ══════════════════════════════════════════════════════════════════════════ */

/** 最多记多少个会话（超出丢最久没动的，防文件无限长） */
const MAX_KEYS = 50;
/** 每个会话最多落盘多少条
 *  ⚠️ 2026-11-23：80 → **400**。全量模式现在要 160 条（`historyRounds: 80`），
 *     剧情中更是 180 条 —— 落盘只存 80 的话，重启后那些会被**当场砍掉一半** ✗ */
const MAX_PER_KEY = 400;
/** 落盘时每条正文截多少字（内存里仍是全文；这只是防单个会话把文件撑爆） */
const SAVE_CHAR_LIMIT = 800;

let _file = '';
function filePath() {
  if (!_file) _file = join(stateDir(), 'history.json');
  return _file;
}

let _loaded = false;
/** 第一次用到历史时从磁盘灌回来 */
function ensureLoaded() {
  if (_loaded) return;
  _loaded = true;
  try {
    const f = filePath();
    if (!existsSync(f)) return;
    const raw = readFileSync(f, 'utf8');
    const o = JSON.parse(raw || '{}');
    let n = 0;
    for (const [k, v] of Object.entries(o ?? {})) {
      if (!Array.isArray(v) || !v.length) continue;
      const list = v
        .filter((m) => m && typeof m.content === 'string')
        .map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content).slice(0, 2000),
        }));
      if (list.length) {
        store.set(k, list);
        n++;
      }
    }
    if (n) log.info(`[历史] 从磁盘恢复了 ${n} 个会话的对话（重启不再清空）`);
  } catch (e) {
    log.warn(`[历史] 读历史文件失败（按空处理）：${e.message}`);
  }
}

let _timer = null;

/** 立即写盘（原子写） */
function flushNow() {
  try {
    const out = {};
    // Map 的插入顺序 ≈ 越靠后越新 ⇒ 只留最后 MAX_KEYS 个
    for (const k of [...store.keys()].slice(-MAX_KEYS)) {
      const v = store.get(k);
      if (!Array.isArray(v) || !v.length) continue;
      /* ⚠️ 落盘时**每条截 SAVE_CHAR_LIMIT 字** —— 内存里留全文（全量模式要 160 条原文），
       *   但文件不能跟着涨（400 条 × 2,000 字 × 50 群 ≈ 40MB ✗） */
      out[k] = v.slice(-MAX_PER_KEY).map((m) => ({
        role: m?.role === 'assistant' ? 'assistant' : 'user',
        content: String(m?.content ?? '').slice(0, SAVE_CHAR_LIMIT),
      }));
    }
    const f = filePath();
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(out), 'utf8');
    renameSync(tmp, f);
  } catch (e) {
    log.debug(`[历史] 落盘失败：${e.message}`);
  }
}

/** 防抖保存：1.5 秒内多次改动只写一次 */
function scheduleSave() {
  if (_timer) return;
  _timer = setTimeout(() => {
    _timer = null;
    flushNow();
  }, 1500);
  _timer.unref?.();
}

/* 进程正常退出时补一次（`kill -9` 抓不到，最多丢 1.5 秒） */
try {
  process.once('exit', () => {
    if (_timer) {
      clearTimeout(_timer);
      _timer = null;
      flushNow();
    }
  });
} catch {}

/** 剧情进行中要几轮上下文（默认是日常的 3 倍） */
export function questHistoryRounds() {
  const base = Math.max(1, Number(config.trigger?.historyRounds) || 6);
  const factor = Math.max(1, Number(config.quest?.historyRoundsFactor) || 3);
  return Math.round(base * factor);
}

export function sessionKey(event) {
  return event.message_type === 'group'
    ? `group:${event.group_id}`
    : `private:${event.user_id}`;
}

/**
 * 取这个会话的对话历史。
 *
 * @param {string} key
 * @param {{rounds?:number}} [opts] 要几轮（不给 = `trigger.historyRounds`；剧情时传 `questHistoryRounds()`）
 */
export function getHistory(key, { rounds } = {}) {
  ensureLoaded();
  const list = store.get(key) ?? [];
  const r = Number(rounds) > 0 ? Number(rounds) : Number(config.trigger?.historyRounds) || 0;
  const limit = Math.max(0, r) * 2;
  if (limit <= 0) return [];
  return limit >= list.length ? list : list.slice(-limit);
}

export function remember(key, userText, assistantText) {
  ensureLoaded();
  const keep = Math.max(0, Number(config.trigger?.historyRounds) || 0) * 2;
  if (keep <= 0) return;

  const list = store.get(key) ?? [];
  list.push({ role: 'user', content: userText });
  list.push({ role: 'assistant', content: assistantText });

  // 只保留最近 cap 条（cap 是"给模型看的"的 KEEP_FACTOR 倍，留给剧情时拉长用）
  // ⚠️ 还要**至少够剧情那一档**（`quest.historyRoundsFactor` 被调大时不能反而拿不到）✓
  const cap = Math.max(keep * KEEP_FACTOR, questHistoryRounds() * 2);
  while (list.length > cap) list.shift();
  store.set(key, list);
  scheduleSave();
}

export function clearHistory(key) {
  ensureLoaded();
  store.delete(key);
  scheduleSave();
}

export function clearAll() {
  ensureLoaded();
  store.clear();
  scheduleSave();
}

export function stats() {
  ensureLoaded();
  return { sessions: store.size };
}
