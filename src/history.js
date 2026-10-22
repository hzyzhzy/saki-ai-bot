import { config } from './config.js';

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
  const list = store.get(key) ?? [];
  const r = Number(rounds) > 0 ? Number(rounds) : Number(config.trigger?.historyRounds) || 0;
  const limit = Math.max(0, r) * 2;
  if (limit <= 0) return [];
  return limit >= list.length ? list : list.slice(-limit);
}

export function remember(key, userText, assistantText) {
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
}

export function clearHistory(key) {
  store.delete(key);
}

export function clearAll() {
  store.clear();
}

export function stats() {
  return { sessions: store.size };
}
