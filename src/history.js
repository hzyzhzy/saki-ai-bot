import { config } from './config.js';

/** 每个会话（私聊用户 / 群）保留的最近若干轮对话 */
const store = new Map(); // key -> { role, content }[]

export function sessionKey(event) {
  return event.message_type === 'group'
    ? `group:${event.group_id}`
    : `private:${event.user_id}`;
}

export function getHistory(key) {
  return store.get(key) ?? [];
}

export function remember(key, userText, assistantText) {
  const limit = config.trigger.historyRounds * 2;
  if (limit <= 0) return;

  const list = store.get(key) ?? [];
  list.push({ role: 'user', content: userText });
  list.push({ role: 'assistant', content: assistantText });

  // 只保留最近 limit 条
  while (list.length > limit) list.shift();
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
