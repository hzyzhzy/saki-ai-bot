/**
 * 好友系统 —— 好感度到线 → 通知 → 自动通过 → 白天概率主动私聊。
 *
 * ## ⚠️⚠️ 先说清一个**协议层做不到**的事（查证于 2026-09-15）
 *
 * 用户原本的设计是「好感度到 90 时**发送加好友的请求**，验证消息是…」。
 * 但那**做不到** —— 我把 NapCat 的全部 action 挖了一遍，跟好友有关的只有：
 *
 * ```
 * set_friend_add_request        ← 同意/拒绝「**收到的**」申请
 * set_doubt_friends_add_request  ← 同上（"可能认识的人"那类）
 * get_friend_list / get_unidirectional_friend_list / delete_friend / set_friend_remark
 * ```
 *
 * **没有任何"发起申请"的能力** —— 这是 QQ 协议层的限制，不是 NapCat 偷懒。
 * （`friend_add` 是**收到**申请时推过来的事件，不是能调的接口。）
 *
 * 所以按 <主人> 拍板的形态做（选的是①）：
 *   **群里 @ 他 + 报验证消息，让他来加，机器人自动通过。**
 *   而且他特意要求：「**@他的消息完全机器化，不计入上文**」——
 *   所以那条消息是**固定模板**（故意不像祥子说话），而且**不进聊天上下文**。
 *
 * ## 三条不变量
 *
 * 1. **只有好感度真的到线才发**（而且只发**一次**，落盘记住）。
 * 2. **不是所有好友都会收到主动私聊** —— 每天按概率挑**一个**，绝大多数日子不发。
 * 3. **只在白天发**（用户要求），深夜绝不发。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './log.js';
import { phrase } from './llm.js';
import * as affinity from './affinity.js';
import * as storyline from './storyline.js';
import { personaText } from './knowledge.js';

const STATE_FILE = process.env.QQBOT_FRIEND_FILE
  ? join(ROOT, process.env.QQBOT_FRIEND_FILE)
  : join(ROOT, 'state', 'friend.json');

const cfg = () => config.friend ?? {};
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** @type {{noticed:Object, friends:Object, lastDmAt:number, lastPickDate:string}} */
let st = { noticed: {}, friends: {}, lastDmAt: 0, lastPickDate: '' };
const stats = { notices: 0, approved: 0, dms: 0, lastError: '' };

function load() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    st = {
      noticed: j?.noticed && typeof j.noticed === 'object' ? j.noticed : {},
      friends: j?.friends && typeof j.friends === 'object' ? j.friends : {},
      lastDmAt: Number(j?.lastDmAt) || 0,
      lastPickDate: String(j?.lastPickDate ?? ''),
    };
  } catch (e) {
    log.debug(`好友状态读取失败（当作空的）：${e.message}`);
  }
}

function save() {
  try {
    mkdirSync(join(ROOT, 'state'), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.warn(`好友状态写盘失败：${e.message}`);
  }
}

const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ─────────────────────────────────────────────────────────────
// ① 到线通知（群里 @ 他，机器格式）
// ─────────────────────────────────────────────────────────────

/**
 * 到线通知的**固定模板**（用户原话里的那句）。
 *
 * ⚠️ 放在配置里是为了**你能改**，不是为了让它"有文采" ——
 *    这条消息**故意是机器化的**（用户要求），不要往里面加祥子的口气。
 */
export function noticeText(userId) {
  const tpl =
    String(cfg().notice ?? '').trim() ||
    '@{at} 恭喜你的好感度到达90!达到加好友的标准,同意之后有几率主动发消息过来';
  return tpl.replace(/\{at\}/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 这个人（在**这个群**里）还没发过通知吗？
 *
 * ⚠️ 2026-09-15 晚：**按群记** —— 好感度分群之后，他在 A 群到 90 了
 *    不该让 B 群的那条通知永远发不出来（余额提醒就踩过这个坑）。
 *    不给群号 = 那份"没指定群"的旧标记（兼容老状态）。
 */
export function shouldNotice(userId, groupId = '') {
  const id = String(userId ?? '').trim();
  if (!id) return false;
  const k = String(groupId ?? '').trim();
  return !st.noticed[k ? `${k}:${id}` : id];
}

/** 记下"（在某个群里）通知过了"（只发一次，落盘） */
export function markNoticed(userId, groupId = '', at = Date.now()) {
  const id = String(userId ?? '').trim();
  if (!id) return false;
  const k = String(groupId ?? '').trim();
  st.noticed[k ? `${k}:${id}` : id] = at;
  stats.notices++;
  save();
  return true;
}

/** 已通知过的人数 / 名单（给界面看） */
export function noticedList() {
  return Object.entries(st.noticed).map(([userId, at]) => ({ userId, at }));
}

// ─────────────────────────────────────────────────────────────
// ② 收到好友申请 → 自动通过
// ─────────────────────────────────────────────────────────────

/** 这个号加进来了吗 */
export function isFriend(userId) {
  return !!st.friends[String(userId ?? '').trim()];
}

export function markFriend(userId, at = Date.now()) {
  const id = String(userId ?? '').trim();
  if (!id) return false;
  st.friends[id] = at;
  stats.approved++;
  save();
  return true;
}

export function friendList() {
  return Object.entries(st.friends).map(([userId, at]) => ({
    userId,
    at,
    lastDmAt: Number(st.friends[userId]?.lastDmAt) || 0,
    score: affinity.get(userId),
  }));
}

/**
 * 「可疑好友申请」里**已经到线的人** → 自动通过（2026-09-18 用户要求，选项 C）。
 *
 * ## 为什么需要它
 *
 * 用户报「喵喵三三好感度到 90 了，向机器人发了好友邀请，但是没有自动通过」。
 * 查下来：**NapCat 日志里根本没有 `friend_add` 事件** —— 因为 QQ 会把一部分
 * 好友申请判成**「可疑好友申请」**，那类**不走标准的 `friend_add` 通知**，
 * 而是进另一个队列（NapCat 的 `get_doubt_friends_add_request` / 非标准 action，
 * 源码里 actionSummary 写的是「获取可疑好友申请」）。
 * 所以光挂 `friend_add` 是不够的，**这个队列也得扫**。
 *
 * ## ⚠️ 为什么不是"全自动通过"
 *
 * 那个队列里什么都有（广告、陌生人）。这里**只通过好感度已经到线的人**，
 * 口径跟"到线通知"完全一致（`threshold`，默认 90）；
 * 没到线的**原样留着**（记一条日志）—— 既不误放陌生人，也不把人家的申请弄丢。
 *
 * ⚠️ `call` 由调用方注入（跟 `quest.settle(q, ending, adjust)` 一个路子）——
 *    免得这个模块反过来依赖 `bot.js`。
 *
 * @param {(action:string, params:object)=>Promise<any>} call 一般是 `bot.call`
 * @param {{threshold?:number, max?:number}} [opts]
 * @returns {Promise<{ok:boolean,total:number,approved:number,approvedIds:string[],skipped:string[],reason?:string}>}
 */
export async function sweepDoubtRequests(call, opts = {}) {
  const none = { ok: false, total: 0, approved: 0, approvedIds: [], skipped: [] };
  if (cfg().enable === false) return { ...none, reason: '好友功能没开' };
  if (typeof call !== 'function') return { ...none, reason: '没有注入 call' };

  const threshold = num(opts.threshold ?? cfg().friendThreshold ?? config.affinity?.friendThreshold, 90);
  let list = [];
  try {
    const r = await call('get_doubt_friends_add_request', { count: num(opts.max, 50) });
    list = Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [];
  } catch (e) {
    // ⚠️ 这不是标准 OneBot11 action，别的协议端可能没有 → 安静降级，别刷日志
    return { ...none, reason: `查可疑好友申请失败：${e.message}` };
  }
  if (!list.length) return { ...none, ok: true };

  const approvedIds = [];
  const skipped = [];
  for (const x of list) {
    const uid = String(x?.user_id ?? '').trim();
    const flag = String(x?.flag ?? '').trim();
    if (!uid || !flag) continue;
    // 「到线」按**任意一个群**算（跟"到线通知"同一个口径）
    let hit = false;
    try {
      for (const gid of affinity.groupIds()) {
        if (affinity.get(uid, gid) >= threshold) {
          hit = true;
          break;
        }
      }
    } catch {}
    if (!hit) {
      skipped.push(uid);
      continue;
    }
    try {
      await call('set_doubt_friends_add_request', { flag, approve: true });
      markFriend(uid, Date.now());
      approvedIds.push(uid);
      log.info(`[好友] ★ 自动通过了 ${uid} 的**可疑**好友申请（好感度已到 ${threshold}）`);
    } catch (e) {
      log.warn(`[好友] 通过 ${uid} 的可疑申请失败：${e.message}`);
    }
  }
  if (skipped.length) {
    log.info(`[好友] 可疑申请里 ${skipped.length} 个还没到线，先留着：${skipped.join('、')}`);
  }
  return { ok: true, total: list.length, approved: approvedIds.length, approvedIds, skipped };
}

// ─────────────────────────────────────────────────────────────
// ③ 每天白天，按概率主动私聊**一个**好友
// ─────────────────────────────────────────────────────────────

/** 现在允许发私聊吗（只在白天） */
export function inDayWindow(now = Date.now()) {
  const h = new Date(now).getHours();
  const from = num(cfg().dayFromHour, 9);
  const to = num(cfg().dayToHour, 22);
  return h >= from && h < to;
}

/**
 * 今天该挑谁私聊？
 *
 * ⚠️⚠️ 用户明确要求的两条：
 *   · **每天有几率**主动发一次（不是每天都发）
 *   · **一定不是所有好友都会发**，要不然就尴尬了
 *
 * 所以：先掷一次"今天要不要发"的骰子（`dailyChance`，默认 0.35），
 * 中了再从好友里**挑一个**（挑最近没发过的、好感度最高的那个）。
 * 一天最多一条 —— `lastPickDate` 落盘，重启也不会补发第二条。
 *
 * @returns {{userId:string}|{skip:string}}
 */
export function pickForToday(now = Date.now(), rng = Math.random) {
  if (cfg().enable === false) return { skip: '好友功能没开' };
  if (!inDayWindow(now)) return { skip: '不在白天时段' };
  const today = dayKey(now);
  if (st.lastPickDate === today) return { skip: '今天已经挑过了' };

  // 距上次私聊太近也不发（别连着两天打扰同一个人）
  const minGap = num(cfg().minGapMs, 20 * 60 * 60 * 1000);
  if (st.lastDmAt && now - st.lastDmAt < minGap) return { skip: '距上次私聊太近' };

  const all = friendList().filter((f) => !f.lastDmAt || now - f.lastDmAt > minGap);
  if (!all.length) return { skip: '还没有可发的好友' };

  if (!(rng() < num(cfg().dailyChance, 0.35))) {
    // ⚠️ 没中的日子也要**记下来"今天挑过了"** ——
    //    否则这个 tick 每分钟都掷一次骰子，等于把概率放大成"迟早会中"。
    st.lastPickDate = today;
    save();
    return { skip: '今天掷骰子没中' };
  }

  // 好感度最高的优先（她更想跟谁说话），同分则最久没联系的优先
  const best = [...all].sort((a, b) => b.score - a.score || a.lastDmAt - b.lastDmAt)[0];
  st.lastPickDate = today;
  save();
  return { userId: best.userId };
}

/**
 * 写一条主动私聊的话。
 * ⚠️ 走 `phrase()`（非流式）—— 和一级事件同一套，失败返回空串由调用方兜底。
 */
export async function composeDm(userId, extra = {}) {
  let persona = '';
  try {
    persona = personaText();
  } catch {}
  let block = '';
  try {
    // ⚠️ 分群之后（2026-09-15）：**私聊不属于任何一个群** ——
    //    只能挑一条世界线当底子，统一挑**主群**（她"主战场"那条）。
    block = storyline.promptBlock(12, String(config.chat?.group ?? ''));
  } catch {}
  return phrase({
    system: [
      persona,
      '现在你要**主动私聊**一个群友（不是他先找你，是你想起来找他说话）。',
      '',
      '⚠️ 规矩：',
      '1. **一到两句，最好 30 字以内**。主动找人说话不会一上来就长篇大论。',
      '2. 第一人称，像随手发的消息，别写旁白、别加括号动作。',
      '3. 🚫 不要破折号、不要 markdown、不要书名号。',
      '4. 🚫 **别提"好感度"这个数**，别说什么"我们关系好"这类话 —— 那会很怪。',
      '5. 可以顺口提一句你最近的事（下面给了），但**别像汇报**。',
      '6. 只输出那一句话，不要引号、不要解释。',
    ]
      .filter(Boolean)
      .join('\n'),
    user: [block, extra.hint ? `\n${extra.hint}` : ''].filter(Boolean).join('\n') || '（没什么特别的，随口问一句就行）',
    maxTokens: 200,
    timeoutMs: 20000,
  });
}

/** 记下"给这个人发过私聊了" */
export function markDm(userId, at = Date.now()) {
  const id = String(userId ?? '').trim();
  if (!id) return false;
  st.friends[id] = { ...(st.friends[id] ?? {}), at: st.friends[id]?.at ?? at, lastDmAt: at };
  st.lastDmAt = at;
  stats.dms++;
  save();
  return true;
}

export function status() {
  return {
    enable: cfg().enable !== false,
    threshold: num(cfg().friendThreshold ?? config.affinity?.friendThreshold, 90),
    dayWindow: `${num(cfg().dayFromHour, 9)}:00-${num(cfg().dayToHour, 22)}:00`,
    dailyChance: num(cfg().dailyChance, 0.35),
    friends: Object.keys(st.friends).length,
    noticed: Object.keys(st.noticed).length,
    todayPicked: st.lastPickDate === dayKey(),
    lastDmAt: st.lastDmAt,
    friendList: friendList(),
    noticedList: noticedList(),
    ...stats,
  };
}

/** ⚠️ 测试专用 */
export function __clear() {
  st = { noticed: {}, friends: {}, lastDmAt: 0, lastPickDate: '' };
  stats.notices = 0;
  stats.approved = 0;
  stats.dms = 0;
  stats.lastError = '';
}
/** ⚠️ 测试专用 */
export function __set(patch = {}) {
  st = { ...st, ...patch };
}
/** ⚠️ 测试专用：直接看内部状态 */
export function __state() {
  return st;
}

load();
