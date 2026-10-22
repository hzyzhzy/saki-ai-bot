/**
 * **短期共享记忆**（2026-10-22 用户要求）
 *
 * ## 用户原话
 *   「建立一个新短期记忆**共享**知识库，内容是她**最近发了哪些视频**、她**最近在 b 站收到了什么
 *     评论回复**、还有**在 QQ 这边最近发生了什么事**。都要**标上时间**，并且都是**总结性**内容。
 *     并**删掉过去 48 小时之前**的条目」
 *
 * ## 为什么要"共享"
 *   这三件事原来散在三个地方（`state/bili-publish.json` 的 history、B站评论、群聊 `recent.json`），
 *   而且**谁也不读谁的** ⇒ 她在群里聊不到自己刚发的视频，在 B站回复时也不知道群里发生了什么 ✗
 *   ⇒ 统一成一份，**两边都读**：QQ 聊天提示词 + B站评论回复的提示词 ✓
 *
 * ## 三条硬规矩
 *   ① **每条都带时间**（`at`）—— 没时间的记忆等于没有
 *   ② **只存总结**，不存原文（原文在 `recent.json` / B站那边，这里只放"一句话说清发生了什么"）
 *      ⚠️ 不存原文的另一个好处：这里可以安全地进提示词，不占多少 token
 *   ③ **只留 48 小时**（`prune()` 在每次读写时顺手清）
 *
 * ## 存哪
 *   `state/short-memory.json` —— 原子写（Node 写，绝不用 PowerShell 的 `-Encoding utf8`，那会带 BOM）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './config.js';
import { log } from './log.js';

/** 保留多久（小时）—— 用户定的 48 */
const KEEP_HOURS = 48;
/** 最多存多少条（防它无限长） */
const MAX_ITEMS = 200;

/** 三类的显示名（也是允许的 kind） */
const KINDS = {
  video: '发了视频',
  'bili-comment': 'B站评论',
  qq: 'QQ 这边',
};

const file = () => join(stateDir(), 'short-memory.json');

function loadRaw() {
  try {
    const j = JSON.parse(readFileSync(file(), 'utf8'));
    return Array.isArray(j?.items) ? j.items : [];
  } catch {
    return [];
  }
}

/** 原子写（先写临时文件再改名，进程被杀也不会留半截 JSON） */
function saveRaw(items) {
  const p = file();
  try { mkdirSync(stateDir(), { recursive: true }); } catch { /* ignore */ }
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8');
  try { renameSync(tmp, p); } catch { writeFileSync(p, JSON.stringify({ items }, null, 2), 'utf8'); }
}

/** 删掉 48 小时之前的条目（用户明确要求），返回留下的 */
export function prune(items = loadRaw()) {
  const cut = Date.now() - KEEP_HOURS * 3600 * 1000;
  const kept = items.filter((x) => {
    const t = Date.parse(String(x?.at ?? ''));
    return Number.isFinite(t) && t >= cut;
  });
  if (kept.length !== items.length) {
    log.info(`[短期记忆] 清掉 ${items.length - kept.length} 条超过 ${KEEP_HOURS} 小时的`);
    saveRaw(kept);
  }
  return kept;
}

/**
 * 加一条。
 * @param {'video'|'bili-comment'|'qq'} kind
 * @param {string} text **总结**（一句话，别贴原文）
 * @param {{at?:string, key?:string}} opt `key` 用来去重（同一条评论/同一个视频只记一次）
 */
export function add(kind, text, { at = '', key = '' } = {}) {
  const k = String(kind || '').trim();
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!KINDS[k] || !t) return false;
  const items = prune();
  // 去重：同一个 key 已经有就不重复记（评论会被重复拉到）
  if (key && items.some((x) => x.key === key)) return false;
  items.push({
    at: at || new Date().toISOString(),
    kind: k,
    text: t,
    ...(key ? { key: String(key).slice(0, 120) } : {}),
  });
  // 太长了就丢最老的
  const cut = items.slice(-MAX_ITEMS);
  saveRaw(cut);
  log.info(`[短期记忆] +${KINDS[k]}：${t.slice(0, 60)}`);
  return true;
}

/** 读（自动清理），默认按时间**倒序**（新的在前） */
export function list({ kind = '', limit = 60 } = {}) {
  let items = prune();
  if (kind) items = items.filter((x) => x.kind === kind);
  items.sort((a, b) => Date.parse(String(b.at)) - Date.parse(String(a.at)));
  return items.slice(0, limit);
}

/** 人类可读的时间：`10-22 13:05`（跨年才带年） */
export function fmtAt(at) {
  const d = new Date(String(at));
  if (!Number.isFinite(d.getTime())) return String(at);
  const p = (n) => String(n).padStart(2, '0');
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/**
 * 给提示词用的文本块。
 *
 * ⚠️ 空的就返回 `''`（别塞一句"（暂无）"进去 —— 那会被模型当成"真的什么都没有"到处复述）
 * ⚠️ 按**时间倒序**，新的在前（模型对靠前的更敏感）
 */
export function block({ maxChars = 1200, kinds = ['video', 'bili-comment', 'qq'] } = {}) {
  const items = list({ limit: 60 }).filter((x) => kinds.includes(x.kind));
  if (!items.length) return '';
  const lines = [];
  for (const x of items) {
    const line = `· ${fmtAt(x.at)}｜${KINDS[x.kind] || x.kind}：${x.text}`;
    if (lines.join('\n').length + line.length > maxChars) break;
    lines.push(line);
  }
  return [
    '【最近两天发生的事（你自己记得的，按时间新的在前）】',
    ...lines,
    '（这些是你**自己经历过的**，可以自然地提起来；别一字不差地念，也别编里面没有的）',
  ].join('\n');
}

/** 给界面/自检看 */
export function status() {
  const items = prune();
  const by = {};
  for (const x of items) by[x.kind] = (by[x.kind] || 0) + 1;
  return {
    total: items.length,
    by,
    keepHours: KEEP_HOURS,
    oldest: items.length ? items.reduce((a, b) => (Date.parse(a.at) < Date.parse(b.at) ? a : b)).at : '',
    file: file(),
  };
}

/** 测试用：清空 */
export function __clear() {
  saveRaw([]);
}
