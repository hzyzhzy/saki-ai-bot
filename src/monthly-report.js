/**
 * 月末工资单（2026-09-13 用户要求）。
 *
 * 用户原话：
 *   「可以加个每月末最后一天晚9点自动发送这个月的工资情况，
 *     内容只有这个月拿了多少工资，相比上月变化如何，花了多少token，
 *     并且经过 llm 润滑，和余额不足一样自动发到所有 1 的群，
 *     再加上 qq空间也发送。
 *     如果因为 qq 掉线正好没发送，当恢复上线之后马上补发。」
 *
 * 这个文件只管**判定该不该发**和**什么时候补发**；
 * 内容由 `spend.js` 出（`monthlyReportFacts` / `monthlyReportText`），
 * 发送由 `bot.js` 做（要发群 + 空间，那需要 bot 的连接）。
 *
 * ## ⚠️ 为什么必须落盘（`state/monthly-report.json`）
 * 「已发」这个状态如果只在内存里，**一重启就会重发一份工资单**。
 * 这类"重启就重做一遍"的坑这个项目踩过两次
 * （`digest.lastPosts` 导致同一条说说连发三遍、`qzone.today.count` 导致超发），
 * 所以凡是"做过一次就不该再做"的事，一律写盘。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './log.js';

// ⚠️ 测试用：`QQBOT_MONTHLY_FILE` 可以指向临时文件，避免污染真实的"已发"记录。
//    这个记录**绝不能脏**：脏了就会导致工资单重发 / 该发不发。
const FILE = process.env.QQBOT_MONTHLY_FILE
  ? join(ROOT, process.env.QQBOT_MONTHLY_FILE)
  : join(ROOT, 'state', 'monthly-report.json');
let state = { lastSent: {} };

try {
  if (existsSync(FILE)) state = { lastSent: {}, ...JSON.parse(readFileSync(FILE, 'utf8')) };
} catch (e) {
  log.debug(`载入月末工资单状态失败：${e.message}`);
}

function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(`${FILE}.tmp`, JSON.stringify(state, null, 2), 'utf8');
    renameSync(`${FILE}.tmp`, FILE);
  } catch (e) {
    log.warn(`保存月末工资单状态失败：${e.message}`);
  }
}

/** 重新从盘上读「已发」记录（测试用；也方便人手动清空后不用重启） */
export function reload() {
  try {
    state = existsSync(FILE)
      ? { lastSent: {}, ...JSON.parse(readFileSync(FILE, 'utf8')) }
      : { lastSent: {} };
  } catch (e) {
    log.debug(`重读月末工资单状态失败：${e.message}`);
    state = { lastSent: {} };
  }
  return { sentMonths: Object.keys(state.lastSent).sort() };
}

const pad = (x) => String(x).padStart(2, '0');

/** 某个月该发工资单的时刻（本地时间，当月最后一天 `hour` 点） */
export function dueAt(month = thisMonth()) {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  const lastDay = new Date(y, m, 0).getDate(); // 该月最后一天
  const hour = Math.min(23, Math.max(0, Number(config.monthlyReport?.hour ?? 21)));
  return new Date(y, m - 1, lastDay, hour, 0, 0, 0);
}

/** 当前月份 "YYYY-MM"（按北京时间，和账本口径一致） */
export function thisMonth(at = new Date()) {
  const bj = new Date(at.getTime() + (8 * 60 + at.getTimezoneOffset()) * 60000);
  return `${bj.getFullYear()}-${pad(bj.getMonth() + 1)}`;
}

/** 已经发过工资单的月份列表（自检用） */
export function sentMonths() {
  return Object.keys(state.lastSent).sort();
}

/**
 * 现在该不该发？该发就返回**哪个月的**工资单。
 *
 * ⚠️ 补发逻辑（用户要求「掉线恢复了马上补发」）：
 *    定时器只在**到点那一刻之后**才认为是"该发"。
 *    如果那一刻正好掉线，定时器还是会判定"该发"，但发送会失败 →
 *    **发送成功才记 `lastSent`**，所以下一次检查（或重连时立刻检查）
 *    会再判一次"该发"→ 补发。
 *    超过 `minIntervalMs`（默认 24 小时）就不补了，免得过两天突然冒出来。
 *
 * @param {{now?:Date, month?:string}} [opts] `month` 是给测试用的：假装现在是那个月
 * @returns {{month:string, late:boolean}|null}
 */
export function pending(opts = {}) {
  if (config.monthlyReport?.enable === false) return null;
  const now = opts.now ?? new Date();
  const month = String(opts.month ?? thisMonth(now));
  if (state.lastSent[month]) return null;

  const due = dueAt(month);
  if (now < due) return null;

  if (now - due > Math.max(60000, Number(config.monthlyReport?.minIntervalMs) || 86400000)) {
    log.info(`[月结] ${month} 的工资单过期太久（该发时刻 ${due.toLocaleString()}），跳过不补发`);
    state.lastSent[month] = { skipped: true, at: now.toISOString() };
    save();
    return null;
  }
  return { month, late: true };
}

/**
 * 记「这个月已经发过了」。
 *
 * ⚠️ **必须在真的发出去之后**才调 —— 这就是补发能成立的唯一原因。
 */
export function markSent(month, extra = {}) {
  state.lastSent[month] = { at: new Date().toISOString(), ...extra };
  save();
  log.info(`[月结] ${month} 工资单已发出并记账`);
}

/** 给管理界面/自检看 */
export function status() {
  const month = thisMonth();
  return {
    enable: config.monthlyReport?.enable !== false,
    hour: Number(config.monthlyReport?.hour ?? 21),
    month,
    due: dueAt(month).toISOString(),
    sent: state.lastSent[month] ?? null,
    history: state.lastSent,
  };
}
