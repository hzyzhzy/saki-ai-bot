/**
 * 主人的「作息 / 固定习惯」统计（2026-10-19 用户要求）。
 *
 * 用户原话：「**改2，3就行了，只要她能记住这类事情就行了，除了作息，**
 *            还可以加一下其他固定要记的习惯之类的东西」。
 *
 * ## 为什么要有它
 * `owner.md` 里"作息"那一栏一直是空的（原文：「生日、**作息**、常玩什么、爱吃什么
 * （现在只知道他会关心"吃没吃"）」）—— 因为**没人记过**：
 *   · `owner.md` 靠 `owner-update` 从聊天里提炼，那种"某几天几点还在说话"的**统计**
 *     模型提炼不出来（它只看得到最近这一批消息）；
 *   · `owner-recent` 只记"事"，不记"时间分布"。
 * ⇒ 于是她永远说不出「**天天**这么晚」这种带统计的话 ✗
 *
 * ## 记什么（都是**数出来**的，不猜、不用关键词判人话）
 * 只记**主人**（`config.ownerQQ`）每条消息的 **日期 + 小时**，按天聚合：
 *   `{ days: { '2026-10-18': { hours: [0,1,2,9], n: 12, first: '00:30', last: '03:40' } } }`
 * ⚠️ 按天聚合 ⇒ 文件**不会无限长大**；30 天前的自动清掉 ✓
 *
 * ## 注意
 * ⚠️ 这里只管"**记住**"。人设里那条「深夜别劝他睡觉（提过一次就够）」**没动** ——
 *    统计只是让她**知道**，要不要提、什么时候提，照旧听人设的 ✓
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT, stateDir } from './config.js';
import { log } from './log.js';

const FILE = process.env.QQBOT_OWNER_RHYTHM_FILE
  ? join(ROOT, process.env.QQBOT_OWNER_RHYTHM_FILE)
  : join(stateDir(), 'owner-rhythm.json');

/** 留多少天（够算"最近 7 天"，再多留一点给"通常几点"） */
const KEEP_DAYS = 30;
/** 算"凌晨"的那几个小时 */
const NIGHT = [0, 1, 2, 3, 4];

let data = null;

function load() {
  if (data) return data;
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    data = j && typeof j === 'object' ? j : { days: {} };
  } catch {
    data = { days: {} };
  }
  if (!data.days || typeof data.days !== 'object') data.days = {};
  return data;
}

function save() {
  try {
    writeFileSync(FILE, JSON.stringify(data), 'utf8');
  } catch (e) {
    log.warn(`[作息] 存不进去（不影响聊天）：${e.message}`);
  }
}

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function prune(d) {
  const keep = [];
  const now = Date.now();
  for (const k of Object.keys(d.days)) {
    const t = new Date(`${k}T00:00:00`).getTime();
    if (Number.isFinite(t) && now - t <= KEEP_DAYS * 86400000) keep.push(k);
  }
  for (const k of Object.keys(d.days)) if (!keep.includes(k)) delete d.days[k];
}

/** 记一条（**只记主人**；别人发的一律不记 ✓） */
export function note(uid, at = new Date()) {
  try {
    const id = String(uid ?? '').trim();
    if (!id || id !== String(config.ownerQQ ?? '').trim()) return;
    const d = load();
    const k = dayKey(at);
    const rec = d.days[k] ?? (d.days[k] = { hours: [], n: 0, first: '', last: '' });
    const h = at.getHours();
    if (!Array.isArray(rec.hours)) rec.hours = [];
    if (!rec.hours.includes(h)) rec.hours.push(h);
    rec.n = Number(rec.n || 0) + 1;
    const p = (n) => String(n).padStart(2, '0');
    const hhmm = `${p(h)}:${p(at.getMinutes())}`;
    if (!rec.first) rec.first = hhmm;
    rec.last = hhmm;
    prune(d);
    save();
  } catch (e) {
    log.debug(`[作息] 记录失败（不影响聊天）：${e.message}`);
  }
}

/** 最近 n 天的记录（按日期倒序） */
function lastDays(n = 7) {
  const d = load();
  const now = Date.now();
  return Object.entries(d.days)
    .filter(([k]) => {
      const t = new Date(`${k}T00:00:00`).getTime();
      return Number.isFinite(t) && now - t <= n * 86400000;
    })
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([k, v]) => ({ day: k, ...v }));
}

/**
 * 给提示词的一段（**只在 `role === 'owner'` 时注入**）。
 * 没有数据就返回 `''`（别塞一段空的占位 ✓）
 */
export function digest() {
  try {
    const days = lastDays(7);
    if (!days.length) return '';
    const L = [];

    // ① 凌晨活跃：最近 7 天里有几天在 0-4 点还在说话
    const nightDays = days.filter((x) => (x.hours ?? []).some((h) => NIGHT.includes(Number(h))));
    if (nightDays.length >= 2) {
      const latest = nightDays
        .map((x) => String(x.last ?? ''))
        .filter((t) => /^\d\d:\d\d$/.test(t))
        .sort()
        .pop();
      L.push(
        `- 最近 7 天里，他有 **${nightDays.length} 天**在凌晨（0~4 点）还发着消息` +
          (latest ? `，最晚一次 **${latest}**` : ''),
      );
    }

    // ② 通常几点出现（把各天的小时汇总，找最集中的两段）
    const hourAll = [];
    for (const x of days) for (const h of x.hours ?? []) hourAll.push(Number(h));
    // ⚠️ 至少 3 天的数据才敢说"他一般在几点出现"（样本太少会得出错的规律 ✗）
    if (days.length >= 3 && hourAll.length) {
      const cnt = {};
      for (const h of hourAll) cnt[h] = (cnt[h] || 0) + 1;
      const top = Object.entries(cnt)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([h]) => Number(h))
        .sort((a, b) => a - b);
      if (top.length) L.push(`- 他一般在 **${top.map((h) => `${h} 点`).join(' / ')}** 前后出现`);
    }

    // ③ 每天大概说多少句（"常不常来"）
    const total = days.reduce((s, x) => s + Number(x.n || 0), 0);
    if (total >= 10) {
      L.push(`- 这 ${days.length} 天他一共找你说过 **${total} 次**（平均每天 ${Math.round(total / days.length)} 次）`);
    }

    if (!L.length) return '';
    return [
      '',
      '# 【他最近的生活规律（**你记得的这些**，不是每句都要提）】',
      '',
      ...L,
      '',
      '⚠️ 这些只是让你**心里有数**：他大概什么时候在、作息怎么样。',
      '🚫 **不要每次都拿出来念**（人设里「深夜别劝睡」那条照旧有效）；',
      '✅ 只有**正好聊到**（他说困了 / 说今天又晚了 / 你顺口关心一句）时才用得上 ✓',
    ].join('\n');
  } catch (e) {
    log.debug(`[作息] 生成提示词失败（跳过）：${e.message}`);
    return '';
  }
}

/** 测试用 */
export function __reset() {
  data = { days: {} };
}
export function __raw() {
  return load();
}
