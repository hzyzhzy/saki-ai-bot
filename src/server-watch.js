/**
 * 「服务器重新开启的时候 @ 我一下」—— 订阅 + 触发（2026-10-10 用户要求）。
 *
 * 用户原话：「如果有人 @bot 让她在服务器重新开启的时候提醒一下、@他，可以做到吗」
 * 拍板：**谁都能挂**（每人每群一条，重复挂就覆盖）、**一直有效直到触发**。
 *
 * ## 怎么判"重新开启"
 *   **不自己轮询** —— 复用 `sessions.js` 那边**本来就在跑**的状态巡检：
 *   它每 30~180 秒查一次，而且带「**连续 3 次查不到才算真关了**」的确认
 *   ⇒ 它那条「服务器恢复了」的分支就是**天然的触发点** ✓
 *     （见 `sessions.tick()` 里 `state.lastOfflineAt` 那段）
 *
 * ## 为什么必须是"跃迁"
 *   服务器**一直开着**的时候不该触发 —— 只有「确认关过 → 又活了」才算"重新开启"。
 *   那个"关过"的确认由 `sessions.js` 的 `offlineStreak` 负责，这里只管**订阅**和**取走** ✓
 *
 * ## 为什么落盘
 *   订阅可能挂很多天（用户选了"一直有效直到触发"），中间机器人**重启过好几次**
 *   ⇒ 只放内存就白挂了 ✓
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT } from './config.js';
import { log } from './log.js';

const FILE = process.env.QQBOT_SERVER_WATCH_FILE
  ? join(ROOT, process.env.QQBOT_SERVER_WATCH_FILE)
  : join(ROOT, 'state', 'server-watch.json');

/** [{ gid, uid, name, at }] —— 同一个群里同一个人只留一条（重复挂就覆盖） */
let subs = [];
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(FILE)) {
      const j = JSON.parse(readFileSync(FILE, 'utf8'));
      if (Array.isArray(j?.subs)) subs = j.subs.filter((x) => x && x.gid && x.uid);
    }
  } catch (e) {
    log.debug(`开服提醒订阅读不出来（当空）：${e.message}`);
  }
}

function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ subs }), 'utf8');
    renameSync(tmp, FILE);
  } catch (e) {
    log.debug(`开服提醒订阅写盘失败：${e.message}`);
  }
}

/**
 * 挂一条「服务器开了叫我」。
 * ⚠️ 同一个人**在同一个群**重复挂 ⇒ 覆盖（不叠加，免得一次开服 @ 他五遍）✓
 * @returns {boolean} 记下了没有
 */
export function subscribe(groupId, userId, name = '') {
  load();
  const gid = String(groupId ?? '').trim();
  const uid = String(userId ?? '').trim();
  if (!gid || !uid) return false;
  subs = subs.filter((s) => !(s.gid === gid && s.uid === uid));
  subs.push({ gid, uid, name: String(name ?? '').slice(0, 24), at: Date.now() });
  save();
  log.info(`[开服提醒] ${uid}（${name || '没名字'}）在群 ${gid} 挂了「开了叫我」→ 现在共 ${subs.length} 条订阅`);
  return true;
}

/** 某个人在某个群挂的那条（没有就 null） */
export function find(groupId, userId) {
  load();
  const gid = String(groupId ?? '');
  const uid = String(userId ?? '');
  return subs.find((s) => s.gid === gid && s.uid === uid) ?? null;
}

/** 全部订阅（只读快照） */
export function list() {
  load();
  return subs.map((s) => ({ ...s }));
}

/**
 * 服务器**确认恢复**了 ⇒ 把订阅**全部取走**（取走即清空 —— 提醒是一次性的）✓
 * @param {{players?:{online?:number,max?:number}, at?:number}} info
 * @returns {Array<{gid:string,uid:string,name:string}>}
 */
export function takeAll() {
  load();
  if (!subs.length) return [];
  const out = subs.map((s) => ({ gid: s.gid, uid: s.uid, name: s.name }));
  subs = [];
  save();
  log.info(`[开服提醒] 服务器恢复了 → 取走 ${out.length} 条订阅，逐条 @ 出去`);
  return out;
}

/**
 * 触发时的**一句话**（@ 由 `sendToGroup({at})` 负责，文案里**不要再写 @名字**）✓
 */
export function textFor(sub, players) {
  const n = Number(players?.online ?? 0);
  const max = Number(players?.max ?? 0);
  const tail = n > 0 ? `，现在在线 ${n}${max > 0 ? `/${max}` : ''} 人` : '，目前还没人在线';
  return `服务器开了 —— 刚确认能进了${tail}`;
}

/** 测试用 */
export function __reset(raw = { subs: [] }) {
  subs = Array.isArray(raw?.subs) ? raw.subs : [];
  loaded = true;
  save();
}
export function files() {
  return { file: FILE };
}
