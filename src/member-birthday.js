/**
 * 群友的生日 —— **直接取 QQ 个人资料里的那个字段**（2026-10-09 用户要求）。
 *
 * 用户原话：「还可以加一条，除了庆祝机器人的生日，**还可以对好感度 90 以上群友庆祝生日**」
 *   「**日期直接从个人名片那里取**」
 *
 * ## 怎么取
 *   走协议端的 `get_group_member_list` —— 那个调用**本来就有**（`bot.seedNames()`
 *   开机要拉一次成员名单来播种姓名，见 `src/names.js`）⇒ 这里**顺手读同一个返回**
 *   里的 `birthday` 字段，**不额外发一次请求** ✓
 *   ⚠️ 字段格式各协议端不一致，`parseBirthday()` 全兼容：
 *      `"1998-01-01"` / `"01-01"` / `"1-1"` / `"1998/01/01"` / `{month,day}` / `"0101"`
 *   ⚠️ **只存月日**，不存出生年 —— QQ 资料里的完整生日是隐私，
 *      而且这个项目要的只是"今天谁过生日"（用户：「只留下生日」）✓
 *
 * ## 谁用它
 *   · `bot.seedNames()`（开机时拉成员名单那一下）→ `noteList()` 存下来；
 *   · `buildSystemPrompt` → `today()` 取"今天过生日、且好感度够高的群友"，写进提示词，
 *     并且**允许她直接 @ 那个人**（`@名字` 那套由 `msg` 层转成真正的 at 段）。
 *
 * ⚠️ 拿不到 `birthday` 时**什么都不做**（不报错、不瞎猜）：那样她照旧只过机器人的生日。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, stateDir } from './config.js';
import { log } from './log.js';
// ⚠️ 好感度门槛直接在模块里取（`affinity.js` 不引用本模块，没有循环依赖）——
//    调用方就不用自己传 `atOrAbove` 了，"90 以上"这条口径也不会两处漂移。
import * as affinity from './affinity.js';

/** 群友生日要祝贺的门槛（用户要求：**好感度 90 以上**） */
export const MIN_SCORE = 90;

const FILE = process.env.QQBOT_MEMBER_BD_FILE
  ? join(ROOT, process.env.QQBOT_MEMBER_BD_FILE)
  : join(stateDir(), 'member-birthdays.json');

/** `{ "<群号>": { "<uid>": { name, month, day, seen } } }` */
let data = {};
let loaded = false;
let dirty = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(FILE)) data = JSON.parse(readFileSync(FILE, 'utf8')) ?? {};
  } catch (e) {
    log.debug(`群友生日读不出来（当空）：${e.message}`);
    data = {};
  }
}

function save() {
  if (!dirty) return;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, FILE); // 原子写：写 `.tmp` 再改名，防写一半断电
    dirty = false;
  } catch (e) {
    log.warn(`群友生日写盘失败：${e.message}`);
  }
}

/**
 * 协议端给的生日 -> `{month, day}`；认不出来就 `null`。
 * ⚠️ 空值 / `"0-0"` / `"0000-00-00"` 都算没有（QQ 里没填的朋友一大把）。
 */
export function parseBirthday(v) {
  if (v && typeof v === 'object') {
    const m = Number(v.month);
    const d = Number(v.day);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { month: m, day: d };
    return null;
  }
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = /(\d{1,4})\D{1,2}(\d{1,2})\D{1,2}(\d{1,2})/.exec(s); // 1998-01-01 / 1998/1/1
  if (m) {
    const mon = Number(m[2]);
    const day = Number(m[3]);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) return { month: mon, day: day };
  }
  const m2 = /^(\d{1,2})\D{1,2}(\d{1,2})$/.exec(s); // 01-01 / 1/1
  if (m2) {
    const mon = Number(m2[1]);
    const day = Number(m2[2]);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) return { month: mon, day: day };
  }
  const m3 = /^(\d{2})(\d{2})$/.exec(s); // 0101
  if (m3) {
    const mon = Number(m3[1]);
    const day = Number(m3[2]);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) return { month: mon, day: day };
  }
  return null;
}

/**
 * 从 `get_group_member_list` 的返回里把生日抠出来存下（`bot.seedNames()` 里顺手调）。
 * @returns {{total:number, withBirthday:number}} 拿到几条 / 其中有几人有生日
 */
export function noteList(groupId, list) {
  load();
  const gid = String(groupId ?? '').trim();
  if (!gid || !Array.isArray(list)) return { total: 0, withBirthday: 0 };
  const bucket = data[gid] ?? {};
  let total = 0;
  let withBirthday = 0;
  const now = Date.now();
  for (const m of list) {
    const uid = String(m?.user_id ?? '').trim();
    if (!uid) continue;
    total++;
    const name = String(m?.card ?? '').trim() || String(m?.nickname ?? '').trim() || uid;
    const bd = parseBirthday(m?.birthday);
    if (!bd) continue;
    withBirthday++;
    const prev = bucket[uid];
    // ⚠️ 只在"真的有变化"时才算脏（不然每次开机都重写一遍文件）
    if (!prev || prev.month !== bd.month || prev.day !== bd.day || prev.name !== name) {
      bucket[uid] = { name, month: bd.month, day: bd.day, seen: now };
      dirty = true;
    } else {
      prev.seen = now;
    }
  }
  data[gid] = bucket;
  if (dirty) save();
  return { total, withBirthday };
}

/**
 * 今天过生日的群友。
 * @param {string} groupId
 * @param {{minScore?:number, atOrAbove?:Function, now?:number}} opts
 *        `minScore` + `atOrAbove` 一起给 ⇒ **只留好感度够高的**（用户要的"90 以上"）。
 *        ⚠️ 好感度模块用注入的方式传（`src/affinity.js`），免得两个模块互相 import。
 * @returns {{uid:string, name:string, month:number, day:number, score:number|null}[]}
 */
export function today(groupId, { minScore = 0, atOrAbove = affinity.atOrAbove, now = Date.now() } = {}) {
  load();
  const gid = String(groupId ?? '').trim();
  const bucket = data[gid] ?? {};
  const t = new Date(now);
  const mon = t.getMonth() + 1;
  const day = t.getDate();

  let allow = null;
  if (minScore > 0 && typeof atOrAbove === 'function') {
    try {
      allow = new Map((atOrAbove(minScore, gid) ?? []).map((x) => [String(x.userId), Number(x.score)]));
    } catch (e) {
      log.debug(`好感度名单取不到（这次不按好感度过滤）：${e.message}`);
    }
  }

  const out = [];
  for (const [uid, e] of Object.entries(bucket)) {
    if (e.month !== mon || e.day !== day) continue;
    let score = null;
    if (allow) {
      if (!allow.has(uid)) continue;
      score = allow.get(uid);
    }
    out.push({ uid, name: e.name || uid, month: e.month, day: e.day, score });
  }
  return out;
}

/** 某个群的生日表（排错/界面用） */
export function all(groupId = '') {
  load();
  const gid = String(groupId ?? '').trim();
  if (gid) return { ...(data[gid] ?? {}) };
  return JSON.parse(JSON.stringify(data));
}

/**
 * 拼进提示词的那段（今天群里谁过生日 + **可以 @ 他**）。
 *
 * ⚠️ 门槛必须和 `bot.js` 的 `atTargetsOf()` 用同一个（`MIN_SCORE`）——
 *    否则会出现"提示词让她 @，代码却不给转成真 at"的空炮（对方收不到任何提醒）。
 * ⚠️ 今天没人过生日 ⇒ 返回空串（不占字数、也不改提示词结构）。
 */
export function note(groupId, { minScore = MIN_SCORE, now = Date.now() } = {}) {
  const ppl = today(groupId, { minScore, now });
  if (!ppl.length) return '';
  return [
    '',
    '### 🎂 群里今天有人过生日',
    '',
    ...ppl.map(
      (p) =>
        `· **${p.name}**${p.score != null ? `（好感度 ${p.score}）` : ''}今天过生日 —— ` +
        `**你可以直接 @ 他**：在话里写 \`@${p.name}\` 就会真的 @ 到他（不用打任何标记）。` +
        '祝贺一句、或者做点什么（挑个礼物、问一句要不要过去），都在你。',
    ),
    '',
    '⚠️ **只有好感度到这条线的人**才这样 —— 别人过生日你不一定该凑上去，分寸你自己拿。',
  ].join('\n');
}

/** 测试用：清空内存里的表（不落盘） */
export function __reset(raw = {}) {
  data = raw;
  loaded = true;
  dirty = false;
}

export function file() {
  return FILE;
}
