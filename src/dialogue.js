/**
 * 对话状态机（2026-09-15 用户要求「完善对话状态机」）。
 *
 * ## 为什么要有它
 *
 * 原来 `activeConv` 里只有一个 `lastBotReplyAt` + `lastBotReplyTo`，
 * 判断"要不要接着聊"全靠**两个时间窗**（`idleMs` / `sameUserMs`）。于是：
 *
 *   · 「他接着说、但隔了 85 秒」→ 被当成陌生人 → **漏接**
 *     （用户 2026-09-15 截图：「这个也没有接进上文」）
 *   · 「这一段她已经说了 3 句、对方只是在附和」→ **没人知道**，
 *     只能靠"分钟级冷却"硬压 —— 而时间闸天生不像人（真人是一阵一阵说的）
 *   · 「这条是不是她自己刚发的」→ 也得靠 `lastBotReplyTo` 猜
 *
 * 现在把这一段对话当成一个**有生命周期的状态**：
 *
 * ```
 *   idle ──(有人跟她说话 / 她开口)──> active ──(静默超过窗口)──> idle
 * ```
 *
 * `active` 里再看「谁在跟谁说」：
 *
 * | who | 含义 | 该怎么处理 |
 * | --- | --- | --- |
 * | `him` | **就是刚才在跟她聊的那位**，他接着说 | 默认接（对话还没结束） |
 * | `other` | 别人插话 / 换人说话 | 要判断（可能人家在跟别人说） |
 * | `alone` | 没有活跃对话 | 只有点名 / 问题 / 感兴趣的话题才开口 |
 *
 * ## ⚠️ 它同时是"密度"的载体（#4）
 *
 * 它记着「这一段她说了几句、对方说了几句、她上一句是什么、上次开口是多久前」，
 * 这些**原样交给说话判断（speak-judge）** —— 让模型**看着这些数自己决定要不要再说**。
 *
 * 用户 2026-09-15 的判断：「**额度闸和冷却闸背后都是一样的**」——
 * 对：两者都只是"该不该再说一句"的粗糙代理。把状态喂给判断之后，
 * 就不再需要另加"每小时最多说 N 句"那种额度闸了。
 *
 * ⚠️ **不落盘**（有意为之）：一段对话只有几分钟的寿命，
 *    重启后把它记起来反而危险（重启前那句"我们在聊天"早就凉了）。
 *    AGENTS 那条「新加内存状态先问重启会不会出问题」的答案：**不会** ——
 *    最坏结果就是重启后不把下一句当"续话"，跟现在的行为一样。
 *
 * ## 纯函数
 *
 * 这个文件**不持状态、不读配置**：状态就存在 `bot.activeConv` 那个 Map 里，
 * 这里只做「给定旧状态 + 这次发生了什么 → 新状态 / 现在是什么状态 / 怎么描述」。
 * 这样能脱开 Bot 单测（见 `test/dialogue.js`）。
 */

/** 隔这么久没动静，就算"上一段已经散了"，下次开口是新的一段 */
export const ACTIVE_GAP_MS = 10 * 60 * 1000;

/** 一句话压到 40 字，够判断"她上一句说了什么"又不占地方 */
const short = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

/** 新的一段：把"这一段"的计数清掉，但别丢兼容字段 */
function freshBase(prev, now) {
  return {
    ...(prev ?? {}),
    startedAt: now,
    theirTurns: 0,
    herTurns: 0,
    followUpChain: 0,
  };
}

/** 对方说了话 → 更新状态 */
export function userTurn(prev, { uid = '', name = '', text = '', now = Date.now(), gapMs = ACTIVE_GAP_MS } = {}) {
  const fresh = !prev || now - Number(prev.lastActivityAt ?? prev.lastBotReplyAt ?? 0) > gapMs;
  const base = fresh ? freshBase(prev, now) : prev;
  return {
    ...base,
    startedAt: base.startedAt ?? now,
    // 这一段里对方说了几句（用来算"是不是她一个人在那说"）
    theirTurns: Number(base.theirTurns ?? 0) + 1,
    lastUserAt: now,
    lastUserText: short(text),
    lastUserUid: String(uid ?? ''),
    lastUserName: String(name ?? ''),
    // 最后开口的是"对方"
    lastSpeaker: 'user',
    lastSpeakerAt: now,
    lastSpeakerUid: String(uid ?? ''),
    lastActivityAt: now,
  };
}

/** 她说了话 → 更新状态（兼容字段一律保留，别的地方还在读） */
export function botTurn(prev, { uid = '', name = '', text = '', now = Date.now(), gapMs = ACTIVE_GAP_MS } = {}) {
  const fresh = !prev || now - Number(prev.lastActivityAt ?? prev.lastBotReplyAt ?? 0) > gapMs;
  const base = fresh ? freshBase(prev, now) : prev;
  return {
    ...base,
    startedAt: base.startedAt ?? now,
    herTurns: Number(base.herTurns ?? 0) + 1,
    // ── 兼容旧字段（测试和别人都在读）──────────────────
    lastBotReplyAt: now,
    lastBotReplyTo: String(uid ?? '') || String(base.lastBotReplyTo ?? ''),
    followUpChain: Number(base.followUpChain ?? 0) + 1,
    // ── 新增 ──────────────────────────────────────
    lastBotText: short(text),
    lastBotName: String(name ?? ''),
    lastSpeaker: 'bot',
    lastSpeakerAt: now,
    lastSpeakerUid: String(uid ?? '') || String(base.lastSpeakerUid ?? ''),
    lastActivityAt: now,
  };
}

/** 她这段被"防刷屏"计数器归零（被 @ / 明确提问时调） */
export function clearChain(conv) {
  if (!conv) return conv;
  return { ...conv, followUpChain: 0 };
}

/**
 * 现在这段对话是什么状态。
 *
 * @param {object|null} conv `bot.activeConv` 里存的那个对象（可能是旧版字段）
 * @param {{now?:number, idleMs?:number, sameUserMs?:number, uid?:string}} opts
 * @returns {{
 *   phase:'idle'|'active', who:'him'|'other'|'alone',
 *   isSamePerson:boolean, inWindow:boolean, inSameUser:boolean,
 *   silenceMs:number, sinceMs:number, herTurns:number, theirTurns:number,
 *   lastSpeaker:string, lastBotText:string, lastUserText:string
 * }}
 */
export function snapshot(conv, { now = Date.now(), idleMs = 45000, sameUserMs = 180000, uid = '' } = {}) {
  const empty = {
    phase: 'idle',
    who: 'alone',
    isSamePerson: false,
    inWindow: false,
    inSameUser: false,
    silenceMs: Infinity,
    sinceMs: 0,
    herTurns: 0,
    theirTurns: 0,
    lastSpeaker: '',
    lastBotText: '',
    lastUserText: '',
  };
  if (!conv) return empty;

  const lastBot = Number(conv.lastBotReplyAt ?? 0);
  const lastActivity = Number(conv.lastActivityAt ?? lastBot ?? 0);
  const silenceMs = lastBot ? now - lastBot : Infinity;
  // ⚠️ 一段对话的"寿命"取两个窗口里长的那个 —— 超过它就算散了
  const aliveMs = Math.max(Number(idleMs) || 0, Number(sameUserMs) || 0);
  const phase = now - lastActivity > aliveMs ? 'idle' : 'active';

  const isSamePerson = !!uid && !!conv.lastBotReplyTo && String(conv.lastBotReplyTo) === String(uid);
  const inWindow = silenceMs < Number(idleMs);
  const inSameUser = silenceMs < Number(sameUserMs);

  return {
    phase,
    // ⚠️ 只有"同一个人 + 还在宽窗口里"才算 him；否则一律当"别人说话"处理
    who: phase === 'active' ? (isSamePerson && inSameUser ? 'him' : 'other') : 'alone',
    isSamePerson,
    inWindow,
    inSameUser,
    silenceMs,
    sinceMs: Number(conv.startedAt ?? 0) ? now - Number(conv.startedAt) : 0,
    herTurns: Number(conv.herTurns ?? 0),
    theirTurns: Number(conv.theirTurns ?? 0),
    lastSpeaker: String(conv.lastSpeaker ?? ''),
    lastBotText: String(conv.lastBotText ?? ''),
    lastUserText: String(conv.lastUserText ?? ''),
  };
}

/** 秒 → 「20 秒」「5 分钟」这种给人看的说法 */
function humanMs(ms) {
  if (!Number.isFinite(ms)) return '没说过';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.round(m / 60)} 小时前`;
}

/**
 * 给"说话判断"看的状态说明（#4：让它自己看着这些数决定要不要再说）。
 *
 * ⚠️ 只给**事实**，标准写在 `speak-judge.js` 的提示词里 ——
 *    这样"怎么算吵"是提示词的事，改起来不动代码。
 *
 * @returns {string} 多行文本；没有活跃对话时返回空串（省 token）
 */
export function describe(conv, opts = {}) {
  const snap = snapshot(conv, opts);
  if (snap.phase !== 'active') return '';
  const lines = [];
  const whoName = conv?.lastBotName || conv?.lastUserName || '';
  lines.push(
    snap.who === 'him'
      ? `· 现在这段对话里，**跟你聊的就是他**（他刚说了：「${snap.lastUserText || '（图/表情）'}」）`
      : `· 这一段上一句**不是你正在聊的那位**说的（说话人：${snap.lastSpeaker === 'bot' ? '你自己' : whoName || '别人'}）`,
  );
  lines.push(`· 你上一次开口：${humanMs(snap.silenceMs)}${snap.lastBotText ? `（「${snap.lastBotText}」）` : ''}`);
  lines.push(
    `· 这一段：已经 ${Math.max(1, Math.round((snap.sinceMs || 0) / 60000))} 分钟了 —— ` +
      `**对方说了 ${snap.theirTurns} 句，你说了 ${snap.herTurns} 句**`,
  );
  return lines.join('\n');
}

/** 测试/诊断用：一个可读的一行摘要 */
export function debugLine(conv, opts = {}) {
  const s = snapshot(conv, opts);
  return (
    `${s.phase}/${s.who} 静默=${Number.isFinite(s.silenceMs) ? Math.round(s.silenceMs / 1000) + 's' : '—'}` +
    ` 她=${s.herTurns}句 对方=${s.theirTurns}句`
  );
}
