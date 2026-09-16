/**
 * 待发箱（outbox）—— **没发出去的话，等通道正常了自动补发**。
 *
 * 用户要求（2026-09-15）：
 *   「如果因为各种原因没发出，在正常之后要补发。然后自动顺延接下来的」
 *
 * ## 为什么需要
 *
 * 这台机器上的 NapCat 会**间歇性假在线**：`tools/napcat-state.mjs` 报 `online`，
 * 但发消息时 QQ 回 `retcode=1200「网络连接异常」`、而且**群里谁也看不到**。
 * 2026-09-15 实测的时间线：
 *   03:13 之后收不到任何消息 → 11:33 重启协议端后恢复 → 12:28 正常聊天
 *   → 14:28 剧情发出去（报成功）但**用户没看到** → 14:3x 又回 1200
 * 也就是说这个通道**会自己坏、也会自己好**，没有稳定的判据。
 *
 * 所以在"发"和"真的发出去"之间加一层：**发失败的话，把内容留下来，等好了再发**。
 *
 * ## 边界（想清楚才写的，别乱改）
 *
 * 1. **只补"人话"**（聊天回复、剧情、日常事件）。机器格式的（排行榜、加好友通知）
 *    也不该丢，但它们不走 `sendChatLike`，暂时不在这里。
 * 2. **只补"分条里没出去的那几条"** —— `sendChatLike` 会把失败的原文交进来，
 *    所以不会把已经发出去的几条又发一遍。
 * 3. ⚠️ **过期就丢**（默认 30 分钟）：一条 4 小时前的聊天回复补出去只会更怪。
 *    超过 `maxAgeMs` 直接丢掉并记一条日志。
 * 4. **条数上限**（默认 50）：通道坏一整天也不会把文件撑爆。
 * 5. 落盘 + 原子写（和 `state/*.json` 一个路子）——**重启不能丢**，
 *    否则"重启修通道"这个动作本身会把要补的东西弄没。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './log.js';

const FILE = process.env.QQBOT_OUTBOX_FILE
  ? join(ROOT, process.env.QQBOT_OUTBOX_FILE)
  : join(ROOT, 'state', 'outbox.json');

const cfg = () => config.outbox ?? {};
const nz = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** @type {{items: Array<{id:string,groupId:string,parts:string[],kind:string,at:number,tries:number}>}} */
let st = { items: [] };
/** 上次尝试补发的时间（**只在内存里** —— 它是节流用的，重启后立刻试一次是对的） */
let lastTryAt = 0;
let seq = 0;

function load() {
  try {
    if (!existsSync(FILE)) return;
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    st = { items: Array.isArray(j?.items) ? j.items : [] };
  } catch (e) {
    log.debug(`待发箱读取失败（当作空的）：${e.message}`);
    st = { items: [] };
  }
}
load();

function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
    renameSync(tmp, FILE);
  } catch (e) {
    log.warn(`待发箱写盘失败：${e.message}`);
  }
}

/** 这批内容是不是已经在箱子里了（同样的群 + 同样的分条） */
function sameAs(a, b) {
  return String(a.groupId) === String(b.groupId) && a.parts.join('\u0000') === b.parts.join('\u0000');
}

/**
 * 把**没发出去的那几条**放进待发箱。
 *
 * @param {{groupId:string|number, parts:string[], kind?:string, at?:number}} p
 * @returns {boolean} 收下了没有
 */
export function add(p = {}) {
  if (cfg().enable === false) return false;
  const groupId = String(p.groupId ?? '').trim();
  const parts = (Array.isArray(p.parts) ? p.parts : []).map((x) => String(x ?? '')).filter(Boolean);
  if (!groupId || !parts.length) return false;

  const item = { groupId, parts, kind: String(p.kind ?? 'chat'), at: Number(p.at) || Date.now(), tries: 0 };

  // 已经在箱子里就别重复塞（同一个群、同一批分条）
  if (st.items.some((x) => sameAs(x, item))) return false;

  // ⚠️ 下限只卡 1 —— 别写 `Math.max(5, …)`：那样配置里填 3 也变成 5，
  //    界面上的旋钮就变成了骗人的（测试里就是这么发现的）。
  const max = Math.max(1, nz(cfg().maxItems, 50));
  st.items = [...st.items, { id: `o${Date.now()}-${++seq}`, ...item }].slice(-max);
  save();
  log.info(`[待发箱] 收下 ${parts.length} 条（群 ${groupId}，${item.kind}）—— 等通道正常自动补发`);
  return true;
}

/** 箱子里有几条（给界面/日志看） */
export function pending() {
  return st.items.length;
}

/** 箱子内容（副本） */
export function items() {
  return st.items.map((x) => ({ ...x, parts: [...x.parts] }));
}

/**
 * 补发一轮。
 *
 * @param {(item:{groupId:string,parts:string[]}) => Promise<string[]>} sendFn
 *   发一批分条，返回**仍然失败的那几条**（全发出去了就返回空数组）。
 *   ⚠️ 契约是"返回剩下的"，不是"返回成功的" —— 这样部分成功时不会重复发。
 * @param {{now?:() => number, force?:boolean}} [opts] `force` 跳过节流（测试/手动用）
 * @returns {Promise<{tried:number, delivered:number, kept:number, dropped:number}>}
 */
export async function flush(sendFn, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const t = now();
  const out = { tried: 0, delivered: 0, kept: 0, dropped: 0 };
  if (cfg().enable === false) return out;
  if (typeof sendFn !== 'function' || !st.items.length) return out;

  // 节流：通道坏的时候不要每 60 秒猛敲一次
  const retryMs = Math.max(30000, nz(cfg().retryMs, 3 * 60 * 1000));
  if (!opts.force && t - lastTryAt < retryMs) return out;
  lastTryAt = t;

  const maxAge = Math.max(60000, nz(cfg().maxAgeMs, 30 * 60 * 1000));
  // ⚠️ 剧情（`kind:'quest'`）给**长得多**的期限（默认 6 小时）。
  //    理由：聊天回复晚到半小时就是"答非所问"，很怪；
  //    但剧情是一条**连续的故事线**，晚一点送到照样看得懂 ——
  //    丢了才真的接不上（用户 2026-09-15 那两句就是这么丢的）。
  const questMaxAge = Math.max(maxAge, nz(cfg().questMaxAgeMs, 6 * 3600 * 1000));
  const keep = [];

  for (const item of st.items) {
    const limit = item.kind === 'quest' ? questMaxAge : maxAge;
    // 过期就丢 —— 迟到的聊天回复比不回复更怪
    if (t - Number(item.at) > limit) {
      out.dropped++;
      log.warn(
        `[待发箱] 过期丢掉 ${item.parts.length} 条（群 ${item.groupId}，${item.kind}，` +
          `放了 ${Math.round((t - item.at) / 60000)} 分钟）—— 太晚了就不补了`,
      );
      continue;
    }
    out.tried++;
    let left = item.parts;
    try {
      left = (await sendFn({ groupId: item.groupId, parts: item.parts })) ?? [];
    } catch (e) {
      log.debug(`[待发箱] 补发出错：${e.message}`);
      left = item.parts; // 出错 = 全都没出去
    }
    if (!Array.isArray(left) || !left.length) {
      out.delivered++;
      log.info(`[待发箱] ✅ 补发成功（群 ${item.groupId}，${item.parts.length} 条）`);
      continue;
    }
    out.kept++;
    keep.push({ ...item, parts: left, tries: (item.tries ?? 0) + 1 });
  }

  st.items = keep;
  save();
  return out;
}

export function status() {
  return {
    enable: cfg().enable !== false,
    pending: st.items.length,
    maxAgeMs: Math.max(60000, nz(cfg().maxAgeMs, 30 * 60 * 1000)),
    retryMs: Math.max(30000, nz(cfg().retryMs, 3 * 60 * 1000)),
    items: st.items.map((x) => ({ groupId: x.groupId, kind: x.kind, at: x.at, parts: x.parts.length, tries: x.tries })),
  };
}

/** 测试用：清空 + 重读 */
export function __clear() {
  st = { items: [] };
  lastTryAt = 0;
  save();
}
export function __set(items = [], at = 0) {
  st = { items: items.map((x, i) => ({ id: `x${i}`, tries: 0, kind: 'chat', ...x })) };
  lastTryAt = at;
  save();
}
export function reload() {
  load();
}
