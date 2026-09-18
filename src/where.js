/**
 * 「她人在哪 / 正在做什么」状态机（2026-09-18 用户要求）。
 *
 * 用户原话：
 *   「我觉得还要做一个她**人位置在哪里，正在做什么事**的状态机」
 *   「**用模型判断**应不应该改，**判定松一点**，**上限 2 小时**吧」
 *
 * ## 它解决什么（这一串 bug 的共同根源）
 *
 * 现在"在哪、在干什么"是 `bot.js` 的 `whereAmI()` **按小时硬算**的
 * （`hh < 15` = 在教室上课）。可剧情和日常事件会让她**真的离开那里**：
 *   · 剧情里她已经「出后门、往地铁口那边去」了，日程却还写着"在教室上课"
 *     → 于是 14 点能发出「放学直接去打工」这种自相矛盾的事（用户截图报过）
 *   · 一级事件想拿"她现在在哪"时，也只能各自硬算
 *
 * 所以这一层的分工是：
 *   · **日程（`whereAmI`）算默认值** —— 没别的信息时就用它
 *   · **她说过的话可以覆盖它** —— 覆盖最多活 `KEEP_MINUTES`（2 小时）
 *
 * ## 判断为什么交给模型（用户拍板的）
 *
 * 「用模型判断应不应该改，判定**松一点**」——
 * 不做关键词匹配：「我出后门了」「这就往地铁口去」「我得先走了」……
 * 这种说法**穷举不完**，写词表必然漏（`meal.js` 那边是"吃"这一类封闭动作，
 * 位置不是）。所以交给一次**轻量**模型调用（`llm.phrase`，几十 token），
 * 而且是**松**判据：拿不准就改 —— 宁可多改，也别让日程和剧情打架。
 *
 * ⚠️⚠️ 覆盖**只有 2 小时**（用户定的上限）。到点自动**回落**到日程 ——
 *    这条是防"像上次那样卡在某个状态里出不来"（那次是"卡在要去吃饭"）。
 *
 * ## 落盘
 *
 * `state/where.json`（`QQBOT_WHERE_FILE` 可改，测试用），原子写。
 * 隔离沿用 `tic.js` / `meal.js` 那套三步：显式 env → 配置名带 test → 真实文件。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ROOT, config, CONFIG_FILE } from './config.js';
import { log } from './log.js';

const STATE_DIR = join(ROOT, 'state');

function stateFile() {
  const explicit = process.env.QQBOT_WHERE_FILE;
  if (explicit) return join(ROOT, explicit);
  const cfgName = basename(CONFIG_FILE ?? '');
  if (/test/i.test(cfgName)) {
    return join(STATE_DIR, `__test-${cfgName.replace(/\.ya?ml$/i, '')}-where.json`);
  }
  return join(STATE_DIR, 'where.json');
}

const STATE_FILE = stateFile();

/** 测试专用：看它把状态落在哪了 */
export function path() {
  return STATE_FILE;
}

const cfg = () => config.where ?? {};
const enabled = () => cfg().enable !== false;

/** 覆盖最多活多久（分钟）—— 用户拍板：**2 小时**。 */
export const DEFAULT_KEEP_MINUTES = 120;
const keepMs = () => {
  const v = Number(cfg().keepMinutes);
  return (Number.isFinite(v) && v > 0 ? v : DEFAULT_KEEP_MINUTES) * 60 * 1000;
};

/**
 * 状态。
 * @typedef {{where:string, doing:string, since:number, until:number, source:string}} Where
 */

/** @type {Where} */
let state = { where: '', doing: '', since: 0, until: 0, source: '' };

function blank() {
  return { where: '', doing: '', since: 0, until: 0, source: '' };
}

export function reload() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    state = {
      where: String(j?.where ?? '').trim(),
      doing: String(j?.doing ?? '').trim(),
      since: Number(j?.since ?? 0) || 0,
      until: Number(j?.until ?? 0) || 0,
      source: String(j?.source ?? ''),
    };
  } catch (e) {
    log.debug(`位置状态读取失败（当作没有）：${e.message}`);
    state = blank();
  }
}

function save() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 0), 'utf8');
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.debug(`位置状态写盘失败：${e.message}`);
  }
}

/**
 * 记一次"她在哪 / 在做什么"的覆盖。
 *
 * ⚠️ **判据在外面**（`bot.js` 用一次轻量模型调用决定"要不要改"），
 *    这里只管**怎么存**：合法就覆盖、`until` 一律重算成"now + 2 小时"。
 *
 * @param {{where?:string, doing?:string, source?:string, at?:number}} patch
 * @returns {boolean} 有没有真的改掉
 */
export function apply(patch = {}) {
  if (!enabled()) return false;
  const where = String(patch.where ?? '').trim().slice(0, 40);
  const doing = String(patch.doing ?? '').trim().slice(0, 60);
  if (!where && !doing) return false;
  const at = Number(patch.at) || Date.now();
  state = {
    where,
    doing,
    since: at,
    until: at + keepMs(),
    source: String(patch.source ?? '').slice(0, 40),
  };
  save();
  log.info(
    `[位置] → ${where || '（地点不变）'}${doing ? `／${doing}` : ''}` +
      `（${Math.round(keepMs() / 60000)} 分钟后回落日程；来源 ${state.source || '群里'}）`,
  );
  return true;
}

/**
 * 当前状态 —— **顺手处理过期**（超过 2 小时就作废，回落到日程）。
 * @returns {{active:boolean, where:string, doing:string, since:number, until:number, source:string, leftMs:number}}
 */
export function current(now = Date.now()) {
  const active = !!(state.where || state.doing) && state.until > now;
  return {
    active,
    where: active ? state.where : '',
    doing: active ? state.doing : '',
    since: active ? state.since : 0,
    until: active ? state.until : 0,
    source: active ? state.source : '',
    leftMs: active ? Math.max(0, state.until - now) : 0,
  };
}

/** 相对时间（"23 分钟前"） */
function agoText(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  return `${Math.round(min / 60)} 小时前`;
}

/**
 * 给提示词用的一段；没有覆盖 → **返回空串**（那就照日程说的来，不占提示词）。
 *
 * ⚠️ 措辞带**行为指令**，不是只报状态（跟 `meal.hint()` 一个道理：
 *    只写"你现在在外面"，她会当背景信息忽略掉）。
 */
export function hint(now = Date.now()) {
  if (!enabled()) return '';
  const s = current(now);
  if (!s.active) return '';
  const bits = [s.where, s.doing].filter(Boolean).join('，');
  return [
    '## 📍 你现在在哪、在干什么（**今天早些时候你亲口说过**）',
    '',
    `你 ${agoText(now - s.since)}说过：**${bits}**。`,
    '⚠️ 这就是你**此刻**的位置和正在做的事 —— **优先于**下面按日程算出来的那个（日程是死的）；',
    '⚠️ 所以别再说"我在教室上课""我坐了一天"这类跟它对不上的话；',
    '  有人问你在哪儿、在忙什么，**按这个答**。',
    `（这条最多再算 ${Math.max(1, Math.round(s.leftMs / 60000))} 分钟，之后自动回到日程。）`,
  ].join('\n');
}

/** 给管理界面 / 自检看 */
export function status(now = Date.now()) {
  const s = current(now);
  return { ...s, enable: enabled(), keepMinutes: Math.round(keepMs() / 60000), path: STATE_FILE };
}

/** 测试专用 */
export function __clear() {
  state = blank();
  save();
}

// ⚠️ 模块加载时就恢复（和 `tic.js` / `meal.js` 同一个做法）
reload();
