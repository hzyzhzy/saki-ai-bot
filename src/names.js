/**
 * 「谁是谁」—— QQ 号 → **群名片 / 昵称**。
 *
 * ## 为什么要有它（2026-09-15 用户截图）
 *
 * `/好感度` 榜单原来是这么显示的：
 *
 * ```
 * 好感度排行榜（最近有变化的）
 * 1. 30003　54
 * 2. 10000001　51
 * ```
 *
 * 用户原话：「**30003 是谁？建议直接改成以 QQ 昵称显示**」。
 *
 * ⚠️ 根因：代码里其实**早就写了** `this.nameCache?.get(userId) ?? userId`，
 *    但 `nameCache` **只被读、从来没被写过** —— 所以永远退回 QQ 号。
 *    （同一个坑还影响「好感度到线通知」的 @：`atName` 是空的，
 *     而空 name 的 @ 在有些客户端会显示成 **@全体成员** —— 那个更危险。）
 *
 * ## 数据从哪来
 *
 * 每条群消息的 `sender` 里就带着：
 *   · `sender.card`     = **群名片**（这个群里大家都认得的名字，优先用）
 *   · `sender.nickname` = 全局昵称（在这个群没设名片时用）
 *
 * 所以**不用额外调接口**（调 `get_group_member_info` 要一个个问、还可能被风控）——
 * 见到消息顺手记一笔就行。
 *
 * ## 为什么落盘
 *
 * 不落盘的话**每次重启榜单又变回号码**（用户刚看到的就是这个）。
 * 存 `state/names.json`，原子写。
 *
 * ## ⚠️ 群名片是"每个群各一份"
 *
 * 同一个人在 A 群叫「小明」、B 群叫「狗管理」—— 榜单在哪个群显示就用哪个群的：
 *   `of(uid, groupId)` = 这个群的群名片 → 全局昵称 → ''（调用方退回号码）
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { log } from './log.js';

const STATE_DIR = join(ROOT, 'state');
// ⚠️ 给测试留出口（和 QQBOT_AFFINITY_FILE / QQBOT_TIC_FILE 一个套路）
const FILE = process.env.QQBOT_NAMES_FILE
  ? join(ROOT, process.env.QQBOT_NAMES_FILE)
  : join(STATE_DIR, 'names.json');

/** uid -> 全局昵称 */
let nick = new Map();
/** gid -> (uid -> 群名片) */
let card = new Map();

let dirty = false;
let timer = null;
/** 攒一下再写盘：群里刷屏时别一条消息写一次 */
const FLUSH_MS = 5000;

export function reload() {
  try {
    if (!existsSync(FILE)) return;
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    nick = new Map(
      Object.entries(j?.nick ?? {})
        .filter(([k, v]) => k && typeof v === 'string' && v.trim())
        .map(([k, v]) => [String(k), v.trim()]),
    );
    card = new Map();
    for (const [gid, m] of Object.entries(j?.card ?? {})) {
      const mm = new Map(
        Object.entries(m ?? {})
          .filter(([k, v]) => k && typeof v === 'string' && v.trim())
          .map(([k, v]) => [String(k), v.trim()]),
      );
      if (mm.size) card.set(String(gid), mm);
    }
    log.debug(`名字表已载入：${nick.size} 个昵称 / ${card.size} 个群的群名片`);
  } catch (e) {
    log.debug(`名字表读取失败（当作空的）：${e.message}`);
    nick = new Map();
    card = new Map();
  }
}

function save() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const cardObj = {};
    for (const [gid, m] of card) cardObj[gid] = Object.fromEntries(m);
    const tmp = `${FILE}.tmp`;
    // 原子写（`affinity.js` / `digest.js` 同款做法）
    writeFileSync(tmp, JSON.stringify({ nick: Object.fromEntries(nick), card: cardObj }, null, 2), 'utf8');
    renameSync(tmp, FILE);
    dirty = false;
  } catch (e) {
    log.debug(`名字表写盘失败：${e.message}`);
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (dirty) save();
  }, FLUSH_MS);
  // 别因为这个定时器把进程钉住（node 会等它）；`unref` 后进程该退就退
  timer.unref?.();
}

/** 进程要退出时（比如测试收尾）把没写的写掉 */
export function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (dirty) save();
}

/**
 * 记下「这个人叫什么」。每条群消息都该调一次（顺手的事，不用额外接口）。
 * @param {object} event OneBot 消息事件
 * @returns {boolean} 有没有更新到什么
 */
export function note(event) {
  if (!event || event.message_type !== 'group') return false;
  const uid = String(event.user_id ?? '').trim();
  if (!uid) return false;
  const gid = String(event.group_id ?? '').trim();
  const cardName = String(event.sender?.card ?? '').trim();
  const nickName = String(event.sender?.nickname ?? '').trim();
  let changed = false;

  // ⚠️ 群名片**变了要覆盖**（改名片是常事）；空的**不要覆盖**已有的
  //    （有人没设名片时 card 是空的，别把之前记的擦掉）
  if (cardName && gid) {
    const m = card.get(gid) ?? new Map();
    if (m.get(uid) !== cardName) {
      m.set(uid, cardName);
      card.set(gid, m);
      changed = true;
    }
  }
  if (nickName && nick.get(uid) !== nickName) {
    nick.set(uid, nickName);
    changed = true;
  }
  if (changed) {
    dirty = true;
    schedule();
  }
  return changed;
}

/**
 * 查这个人叫什么。
 * @param {string|number} uid
 * @param {string} [groupId] 有群号就用**这个群的群名片**（优先），否则退回全局昵称
 * @returns {string} 查不到返回空串（**调用方自己退回 QQ 号**，别在这里拼）
 */
export function of(uid, groupId = '') {
  const u = String(uid ?? '').trim();
  if (!u) return '';
  const g = String(groupId ?? '').trim();
  if (g) {
    const n = card.get(g)?.get(u);
    if (n) return n;
  }
  return nick.get(u) ?? '';
}

/**
 * 榜单/列表用：`名字　（查不到就 QQ 号）`。
 * ⚠️ 只是图省事的小工具，主要是让 `/好感度` 那种地方一行就写完。
 */
export function label(uid, groupId = '') {
  const u = String(uid ?? '').trim();
  const n = of(u, groupId);
  // 名字太长会把榜单挤歪（QQ 名片可以很长），截一下
  return n ? n.slice(0, 16) : u;
}

/**
 * 用群成员名单**批量**播种（开机拉一次 `get_group_member_list` 的结果）。
 *
 * ⚠️ 名单里同时有 `card`（群名片）和 `nickname`（全局昵称），
 *    和 `note()` 一个口径：**群名片优先**，昵称当全局兜底。
 *
 * @param {string} groupId
 * @param {Array<{user_id:string|number, card?:string, nickname?:string}>} list
 * @returns {number} 更新了几个人的名字
 */
export function noteFromList(groupId, list) {
  const gid = String(groupId ?? '').trim();
  if (!gid || !Array.isArray(list)) return 0;
  let n = 0;
  for (const m of list) {
    const uid = String(m?.user_id ?? '').trim();
    if (!uid) continue;
    const cardName = String(m?.card ?? '').trim();
    const nickName = String(m?.nickname ?? '').trim();
    if (cardName) {
      const map = card.get(gid) ?? new Map();
      if (map.get(uid) !== cardName) {
        map.set(uid, cardName);
        card.set(gid, map);
        n++;
      }
    }
    if (nickName && nick.get(uid) !== nickName) {
      nick.set(uid, nickName);
      n++;
    }
  }
  if (n) {
    dirty = true;
    schedule();
  }
  return n;
}

/**
 * **反查**：名字 → QQ 号（2026-09-18 加，定时提醒要用）。
 *
 * ⚠️ 为什么之前没有：这套表一直是**单向**的（`uid → 名字`，为了"喊得出人"）。
 *    定时提醒反过来 —— 用户说「提醒**我和喵喵三三**」，我手里只有**名字**，
 *    得翻出 QQ 号才能 @ 到人。
 *
 * ⚠️ 两级匹配，**先准后松**：
 *    ① 完全相等（忽略大小写/首尾空格）—— 这是绝大多数情况，也最不会认错人；
 *    ② 包含（"喵喵三三" ↔ "喵喵三三。"）；⚠️ 放第二级是因为它**可能认错人**
 *      （"小" 会命中 "小明"），所以只在前一级没结果时才用。
 *
 * ⚠️ **查不到就返回空串，绝不给一个"大概是谁"** —— 上层会如实告诉用户
 *    "没找到这个人"（用户的要求），乱 @ 一个人比说没找到糟糕得多。
 *
 * @param {string} name 用户嘴里那个名字
 * @param {string} [groupId] 有群号就先在**这个群的群名片**里找
 * @returns {string} QQ 号；查不到返回空串
 */
export function findByName(name, groupId = '') {
  const q = String(name ?? '').trim().toLowerCase().replace(/^@/, '');
  if (!q) return '';
  const g = String(groupId ?? '').trim();
  const pools = [];
  const m = g ? card.get(g) : null;
  if (m) pools.push(m);
  pools.push(nick);
  for (const pool of pools) {
    for (const [uid, n] of pool) if (String(n ?? '').trim().toLowerCase() === q) return uid;
  }
  for (const pool of pools) {
    for (const [uid, n] of pool) if (String(n ?? '').trim().toLowerCase().includes(q)) return uid;
  }
  return '';
}

/**
 * 从一句话里认出**名字表里确实有的人**（2026-09-19 加）。
 *
 * ⚠️ 为什么需要（用户截图：他问「还记得mei吗」，她答「**mei？没听过这名字，不认识**」）：
 *    名字表（`state/names.json`）是**程序用的**，从来不进提示词 ——
 *    所以 MEI 虽然是群成员（群名片就叫 "MEI"），但聊天记录里没人这么叫过，
 *    她就真的"不认识" ✗。这个函数把"他这句话里提到、而且表里真有"的人挑出来，
 *    让调用方写进提示词（"群里确实有这个人"）。
 *
 * ⚠️ 只认**长度 ≥ 2** 的名字 —— 单字名（"小"、"王"）满屏误命中，宁可漏也别乱认。
 *
 * @param {string} text
 * @param {string} [groupId] 有群号就先认**这个群的名片**
 * @returns {Array<{uid:string, name:string}>} 最多 3 个
 */
export function mentioned(text, groupId = '') {
  const t = String(text ?? '').toLowerCase();
  if (t.length < 2) return [];
  const g = String(groupId ?? '').trim();
  const out = [];
  const seen = new Set();
  const pools = [];
  const m = g ? card.get(g) : null;
  if (m) pools.push(m);
  pools.push(nick);
  for (const pool of pools) {
    for (const [uid, name] of pool) {
      const n = String(name ?? '').trim();
      if (n.length < 2) continue;
      if (seen.has(uid)) continue;
      if (!t.includes(n.toLowerCase())) continue;
      seen.add(uid);
      out.push({ uid: String(uid), name: n });
      if (out.length >= 3) return out;
    }
  }
  return out;
}

export function status() {
  return { nick: nick.size, groups: card.size, file: FILE };
}

/**
 * 这个人在**哪些群**里露过面（2026-09-17 加）。
 *
 * 用途只有一个：**私聊时决定这次观察该归到哪套资料库**。
 * 用户要求（原话）：「我建议私聊和群用一套，也就是如果那个人在同一个群时，
 * 现在不会有没有群只加好友的」「**同一套资料库**」——
 * 所以私聊优先归到他跟机器人**共有的群**，只有他一个群都没有（纯好友）才单独存。
 *
 * ⚠️ 依据是"他在这个群发过言 / 拿过群名片"。机器人**没有群成员的完整名单**
 *    （`noteFromList` 只在少数时机被调用），所以这是**尽力而为**：
 *    查不到就退回单独存 —— 宁可分裂一次，也**不能**把私聊内容写进一个他不在的群。
 *
 * @param {string|number} uid
 * @returns {string[]} 群号数组（顺序 = 首次记录到的顺序，稳定）
 */
export function groupsOf(uid) {
  const u = String(uid ?? '').trim();
  if (!u) return [];
  const out = [];
  for (const [gid, m] of card) if (m.has(u)) out.push(gid);
  return out;
}

/** 测试用 */
export function __clear() {
  nick = new Map();
  card = new Map();
  dirty = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

// 启动时读一次
reload();
