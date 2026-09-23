/**
 * 节日（日本 + 中国）—— 给一级日常事件用。
 *
 * 数据在 `knowledge/holidays.md`（可编辑）。
 *
 * ## ⚠️⚠️ 两类节日**不是一回事**（这是设计的核心）
 *
 * · **日本节日**：她自己会过的 → 那天事件池换成节日专属的，
 *   **放假的日子还会屏蔽「上课 / 赶电车」那类事**。
 * · **中国节日**：一个住东京的日本高中生不会自己过 →
 *   **不按日期自动出事件**，是「群友跟她说了她才知道」的素材。
 *   所以 `on()` 把它们标成 `foreign: true`，调用方（`life.js`）会区别对待。
 *
 * ## 农历不用手写表
 *
 * Node 自带的 `Intl` 就支持中国农历（`u-ca-chinese`）：
 *
 * ```
 * new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {month:'numeric',day:'numeric'})
 *   2026-02-17 → month:"1"  day:"1"     ← 正月初一 = 春节 ✓
 *   2026-09-25 → month:"8"  day:"15"    ← 八月十五 = 中秋 ✓
 *   2025-07-25 → month:"闰6" day:"1"    ← **闰月**（会按"闰"识别，直接跳过）
 * ```
 *
 * ⚠️ 闰月必须跳过：闰六月初一 **不是** 六月初一，把它当节日是错的。
 *    （实测过：2025 年有闰六月，两种都能被 Intl 区分出来。）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT, KNOWLEDGE_DIR } from './config.js';
import { log } from './log.js';

const FILE = join(KNOWLEDGE_DIR, 'holidays.md');

/**
 * @typedef {{name:string, region:string, foreign:boolean, off:boolean, note:string,
 *            rule:object, events:Array<{w:number,text:string,tags:string[]}>}} Holiday
 */

/** @type {Holiday[]} */
let list = [];
let loadedAt = 0;

/** 农历月日（`闰` 会被识别出来） */
export function lunarMD(date) {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(date);
    const m = String(parts.find((p) => p.type === 'month')?.value ?? '');
    const d = Number(parts.find((p) => p.type === 'day')?.value);
    if (!m || !Number.isFinite(d)) return null;
    const leap = m.includes('闰');
    const month = Number(m.replace(/[^\d]/g, ''));
    if (!month) return null;
    return { month, day: d, leap };
  } catch {
    return null;
  }
}

/** 这个月第 n 个星期 d 是几号 */
function nthWeekday(year, month, nth, dow) {
  const first = new Date(year, month - 1, 1);
  const shift = (dow - first.getDay() + 7) % 7;
  return 1 + shift + (nth - 1) * 7;
}

/** `01-01` / `04-29..05-05` / `01-W2-1` / `L08-15` → 规则对象 */
export function parseDate(spec) {
  const s = String(spec ?? '').trim();
  let m;
  if ((m = /^L(\d{1,2})-(\d{1,2})$/.exec(s))) {
    return { kind: 'lunar', month: Number(m[1]), day: Number(m[2]) };
  }
  if ((m = /^(\d{1,2})-W(\d)-(\d)$/.exec(s))) {
    return { kind: 'nth', month: Number(m[1]), nth: Number(m[2]), dow: Number(m[3]) };
  }
  if ((m = /^(\d{1,2})-(\d{1,2})\.\.(\d{1,2})-(\d{1,2})$/.exec(s))) {
    return { kind: 'range', from: [Number(m[1]), Number(m[2])], to: [Number(m[3]), Number(m[4])] };
  }
  if ((m = /^(\d{1,2})-(\d{1,2})$/.exec(s))) {
    return { kind: 'day', month: Number(m[1]), day: Number(m[2]) };
  }
  return null;
}

/** 解析 `holidays.md` */
export function parse(text) {
  const out = [];
  let region = '日本';
  let cur = null;
  /** 节日专属事件段的名字 */
  let evName = null;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('<!--')) continue;

    const rg = /^##\s*(.+?)\s*$/.exec(line);
    if (rg && !/^###/.test(line)) {
      region = rg[1].trim();
      evName = null; // 换了地区 → 离开"节日专属事件"那一段
      continue;
    }
    const ev = /^###\s*(.+?)\s*$/.exec(line);
    if (ev) {
      evName = ev[1].trim();
      continue;
    }
    if (line.startsWith('>')) {
      // 紧跟在节日后面 → 是它的"她怎么过这天"；否则当注释丢掉
      if (cur) cur.note = [cur.note, line.replace(/^>\s?/, '')].filter(Boolean).join(' ');
      continue;
    }

    // ⚠️⚠️ 顺序很重要：`###` 段里的事件行长这样 `- 4 | 事件内容 #标签`，
    //    而节日条目长这样 `- 01-01 | 元日 | 假` —— **两者都能被同一条正则匹配**。
    //    第一版把"节日条目"放在前面判，于是事件行被当成节日条目、
    //    再因为 `parseDate('4')` 是 null 被丢掉 → **节日专属事件一条都读不出来**（实测 0 条）。
    //    所以：**在 `###` 段里先按事件行判**。
    if (evName) {
      const t = /^-\s*(\d)\s*\|\s*(.+)$/.exec(line);
      if (t) {
        const owner = out.find((h) => h.name === evName);
        if (owner) {
          let body = t[2].trim();
          const tags = [];
          body = body.replace(/#([^\s#|]+)/g, (_, tag) => {
            tags.push(String(tag));
            return '';
          });
          body = body.replace(/\s+/g, ' ').trim();
          if (body) owner.events.push({ w: Math.min(5, Math.max(1, Number(t[1]))), text: body, tags });
        }
        continue;
      }
    }

    const item = /^-\s*([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|\s*(\S+)\s*)?$/.exec(line);
    if (item) {
      const rule = parseDate(item[1]);
      if (!rule) continue;
      cur = {
        name: item[2].trim(),
        region,
        foreign: /中国|中華/.test(region) && !/日本/.test(region),
        off: String(item[3] ?? '').includes('假'),
        note: '',
        rule,
        events: [],
      };
      out.push(cur);
    }
  }
  return out;
}

export function reload() {
  try {
    list = parse(readFileSync(FILE, 'utf8'));
    loadedAt = Date.now();
    log.debug(`节日：${list.length} 个（日本 ${list.filter((h) => !h.foreign).length}）`);
  } catch (e) {
    log.warn(`节日表读不到（${e.message}），节日相关事件不生效`);
    list = [];
  }
}

function hit(h, now) {
  const d = new Date(now);
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const da = d.getDate();
  const r = h.rule;
  if (r.kind === 'day') return mo === r.month && da === r.day;
  if (r.kind === 'range') {
    const key = mo * 100 + da;
    const from = r.from[0] * 100 + r.from[1];
    const to = r.to[0] * 100 + r.to[1];
    // 跨年的区间（年末年始 12-29..01-03）
    return from <= to ? key >= from && key <= to : key >= from || key <= to;
  }
  if (r.kind === 'nth') return mo === r.month && da === nthWeekday(y, r.month, r.nth, r.dow);
  if (r.kind === 'lunar') {
    const l = lunarMD(d);
    // ⚠️ 闰月直接跳过 —— 闰六月初一不是六月初一
    return !!l && !l.leap && l.month === r.month && l.day === r.day;
  }
  return false;
}

/**
 * 今天是什么日子。
 *
 * @param {number} [now]
 * @returns {{all:Array, names:string[], off:boolean,
 *            local:Array, foreign:Array, events:Array, noteText:string}}
 */
export function on(now = Date.now()) {
  const all = list.filter((h) => hit(h, now));
  const local = all.filter((h) => !h.foreign);
  const foreign = all.filter((h) => h.foreign);
  const events = local.flatMap((h) =>
    h.events.map((e) => ({ ...e, holiday: h.name, tags: [...(e.tags ?? []), h.name] })),
  );
  const noteText = local
    .filter((h) => h.note)
    .map((h) => `${h.name}：${h.note}`)
    .join('\n');
  // ⚠️⚠️ 2026-09-23 加：**连休区间**（用户截图：「为什么我记得昨天小祥也是这么说的」）。
  //
  //    现场：日本 **9/21 敬老の日 + 9/23 秋分の日**，中间夹着的 **9/22 按「国民の休日」
  //    也放假**（`holidays.md` 里那行就写着 `09-22..09-23`）⇒ 所以**她 9/22 说放假是对的** ✓
  //    可她在 9/23 说成了「**就今天啊，秋分之日**」✗ —— 她只判断了"**今天**是不是假日"，
  //    没人告诉她**这几天是连着的**，于是顺口讲成"只有今天"。群友说"放了三天"才是对的 ✓
  //
  //    ⇒ 这里补一句「连休：9/21–9/23 连休 3 天（敬老の日、秋分の日）」。
  //      它**会自动进提示词**（`life.js:542` 把 `noteText` 拼进 `bits`）⇒ 不用改别的地方 ✓
  const vacation = streakAround(now);
  const holidayText = [noteText, vacation.days > 1 ? `连休：${vacation.label}` : '']
    .filter(Boolean)
    .join('\n');
  return {
    all,
    names: all.map((h) => h.name),
    /** 放假（会屏蔽「上课 / 赶电车」那类事件） */
    off: local.some((h) => h.off),
    local,
    foreign,
    events,
    noteText: holidayText,
    /** ⚠️ 含今天的**连续放假区间**（`days === 0` = 今天不放假） */
    vacation,
  };
}

/**
 * 含 `now` 的那一段**连续放假日**。
 *
 * ⚠️ 为什么逐天扫、而不是去查表里"哪几条规则挨着"：`holidays.md` 里既有区间写法
 *    （`09-22..09-23`）又有**星期规则**（`09-W3-1` = 9 月第 3 个周一），
 *    逐天调 `hit()` 最省事、也最不容易算错 ✓
 * ⚠️ 前后各扫 10 天封顶 —— 日本最长连休（白银周）也就 5 天，够用。
 */
function streakAround(now) {
  const DAY = 24 * 60 * 60 * 1000;
  const offOn = (t) => list.some((h) => !h.foreign && h.off && hit(h, t));
  if (!offOn(now)) return { from: 0, to: 0, days: 0, names: [], label: '' };
  let from = now;
  for (let i = 0; i < 10 && offOn(from - DAY); i++) from -= DAY;
  let to = now;
  for (let i = 0; i < 10 && offOn(to + DAY); i++) to += DAY;
  const days = Math.round((to - from) / DAY) + 1;
  const at = (t) => list.filter((h) => !h.foreign && h.off && hit(h, t)).map((h) => h.name);
  const names = [...new Set([...at(from), ...at(now), ...at(to)])];
  const md = (t) => {
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  return {
    from,
    to,
    days,
    names,
    label:
      days > 1
        ? `${md(from)}–${md(to)} 连休 ${days} 天（${names.join('、')}）`
        : `${md(from)}（${names.join('、')}）`,
  };
}

export function status() {
  return {
    total: list.length,
    local: list.filter((h) => !h.foreign).length,
    foreign: list.filter((h) => h.foreign).length,
    withEvents: list.filter((h) => h.events.length).length,
    loadedAt,
    today: on().names,
  };
}

/** ⚠️ 测试专用 */
export function __set(raw) {
  list = raw;
}

reload();

/** 节日功能开关（配置里留个口子；默认开） */
export function enabled() {
  return config.life?.holidays !== false;
}
