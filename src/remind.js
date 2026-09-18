/**
 * 定时提醒（2026-09-18 用户要求）。
 *
 * 用户原话：
 *   「加一个**定时提醒**功能，当我说在几点提醒我干什么的时候，机器人**先答应**，
 *     然后**真的在那个时候 @ 我**、并**用机器人自己的话**提醒我那件事，
 *     如果还说了提醒我和另外一个人的话，就**先找出另外一个人是谁**，
 *     然后把那个人提醒时**也 @**，**如果没找到就要说没找到**。
 *     然后**只在我发消息的那个地方**提醒我。」
 *
 * ## 拆成四条（对着用户那句话）
 *
 * 1. **先答应** —— 靠提示词（`bot.js` 里那段注入）让她当场应一声，别装没听见；
 * 2. **到点 @ 他 + 用她自己的话提醒** —— `due()` 交给机器人发（不是复制用户原话）；
 * 3. **"和另外一个人"** —— 解析时把那个名字翻成 QQ 号（`resolveWho()`），
 *    **翻不到就如实说"没找到这个人"**（绝不瞎 @ 一个）；
 * 4. **只在原地提醒** —— 记下 `groupId`（**空 = 私聊**），到点就往那儿发。
 *
 * ## ⚠️ 落盘（必须）
 *
 * 提醒**天生跨时间**：用户说"明天早上八点"，而这中间机器人可能重启好几次
 * （这个号每几小时掉一次）。不落盘 = 提醒必丢 —— 那比没有这个功能更糟
 * （他会以为设好了，结果那天什么都没发生）。
 * 落盘 `state/remind.json`（`QQBOT_REMIND_FILE` 可改，测试用），原子写。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ROOT, config, CONFIG_FILE } from './config.js';
import { log } from './log.js';

const STATE_DIR = join(ROOT, 'state');

function stateFile() {
  const explicit = process.env.QQBOT_REMIND_FILE;
  if (explicit) return join(ROOT, explicit);
  const cfgName = basename(CONFIG_FILE ?? '');
  if (/test/i.test(cfgName)) {
    return join(STATE_DIR, `__test-${cfgName.replace(/\.ya?ml$/i, '')}-remind.json`);
  }
  return join(STATE_DIR, 'remind.json');
}

const STATE_FILE = stateFile();

/** 测试专用：看它把状态落在哪了 */
export function path() {
  return STATE_FILE;
}

const cfg = () => config.remind ?? {};
const enabled = () => cfg().enable !== false;

/** 最多同时挂多少条（防被刷爆） */
function maxItems() {
  const v = Number(cfg().maxItems);
  return Number.isFinite(v) && v > 0 ? v : 50;
}

/** 一条提醒最多往后推多久（毫秒）—— 默认 7 天，防模型算出一个离谱的时间 */
function maxAheadMs() {
  const v = Number(cfg().maxAheadDays);
  return (Number.isFinite(v) && v > 0 ? v : 7) * 24 * 3600 * 1000;
}

/** @type {{items:Array<object>, nextId:number}} */
let st = { items: [], nextId: 1 };

function blank() {
  return { items: [], nextId: 1 };
}

export function reload() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    st = {
      items: (Array.isArray(j?.items) ? j.items : [])
        .map((x) => ({
          id: Number(x?.id) || 0,
          at: Number(x?.at) || 0,
          what: String(x?.what ?? '').trim(),
          by: String(x?.by ?? '').trim(),
          byName: String(x?.byName ?? '').trim(),
          // 提醒谁：`[{uid, name}]`；`uid` 空 = 没找到这个人（到点要如实说）
          targets: (Array.isArray(x?.targets) ? x.targets : []).map((t) => ({
            uid: String(t?.uid ?? '').trim(),
            name: String(t?.name ?? '').trim(),
          })),
          groupId: String(x?.groupId ?? ''),
          createdAt: Number(x?.createdAt) || 0,
          sentAt: Number(x?.sentAt) || 0,
        }))
        .filter((x) => x.id && x.at && x.what),
      nextId: Math.max(1, Number(j?.nextId) || 1),
    };
    log.debug(`提醒：载入 ${st.items.length} 条（还没发的 ${st.items.filter((x) => !x.sentAt).length} 条）`);
  } catch (e) {
    log.debug(`提醒读取失败（当作空的）：${e.message}`);
    st = blank();
  }
}

function save() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(st, null, 0), 'utf8');
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.warn(`提醒写盘失败：${e.message}`);
  }
}

/**
 * 加一条提醒。
 *
 * @param {{at:number, what:string, by:string, byName?:string,
 *          targets?:Array<{uid?:string,name?:string}>, groupId?:string, now?:number}} r
 * @returns {{ok:boolean, item?:object, reason?:string}}
 */
export function add(r = {}) {
  if (!enabled()) return { ok: false, reason: '提醒功能没开' };
  const now = Number(r.now) || Date.now();
  const at = Number(r.at) || 0;
  const what = String(r.what ?? '').trim();
  if (!at || !what) return { ok: false, reason: '时间或内容缺一个' };
  if (at <= now) return { ok: false, reason: '那个时间已经过了' };
  if (at - now > maxAheadMs()) return { ok: false, reason: '时间太远了（超过 7 天）' };

  const live = st.items.filter((x) => !x.sentAt);
  if (live.length >= maxItems()) return { ok: false, reason: `挂着的提醒太多了（${live.length} 条）` };

  const item = {
    id: st.nextId++,
    at,
    what: what.slice(0, 200),
    by: String(r.by ?? '').trim(),
    byName: String(r.byName ?? '').trim(),
    targets: (Array.isArray(r.targets) ? r.targets : [])
      .map((t) => ({ uid: String(t?.uid ?? '').trim(), name: String(t?.name ?? '').trim() }))
      .filter((t) => t.uid || t.name)
      .slice(0, 5),
    groupId: String(r.groupId ?? ''),
    createdAt: now,
    sentAt: 0,
  };
  st.items = [...st.items, item];
  // 发过的只留最近 20 条（别让文件无限长）
  const sent = st.items.filter((x) => x.sentAt);
  if (sent.length > 20) {
    const keep = new Set(sent.slice(-20).map((x) => x.id));
    st.items = st.items.filter((x) => !x.sentAt || keep.has(x.id));
  }
  save();
  return { ok: true, item };
}

/** 12/24 小时制 → 当天的小时数（0-23） */
function to24(h, period) {
  if (h === 0 || h >= 13) return h; // 他直接说了"20点""22:40"
  if (h === 12) return period === 'pm' ? 0 : 12; // 「晚上12点」= 次日 0 点
  return period === 'am' ? h : h + 12; // ⚠️ 没说 am/pm 时按**晚上**口径（见下）
}

/**
 * 把用户嘴里的时间算成**绝对时刻**（2026-09-18 用户补充要求）。
 *
 * ## 用户原话 + 追问结论
 *
 * > 「注意要能**分清「明天早上8点」和「只说8点」**（也就是**今天晚上20点**），
 * >   然后**已经过了晚上8点再只说8点那就是明天8点**，要能自动判断是哪一个」
 *
 * 追问「今天20点过了之后，只说8点算哪个」→ 他选 **明天早上 8:00**（离现在最近的那个8点）。
 *
 * 于是规则是（⚠️ 这三条就是用户要的"自动判断"）：
 *
 * | 他说的 | 算成 |
 * | --- | --- |
 * | 「早上/上午 8点」 | 今天 08:00；**过了就是明天 08:00** |
 * | 「晚上 8点」 | 今天 20:00；过了就是明天 20:00 |
 * | **只说「8点」** | **今天 20:00**（默认晚上）；**过了 → 明天 08:00**（最近的下一个8点） |
 * | 「22:40」「20点」 | 今天该时刻；过了 → 明天该时刻 |
 * | 「明天/今天/下周一 8点」 | 按**那天**算（说了哪天就**不自动顺延**） |
 *
 * ## ⚠️ 为什么不交给模型直接给"绝对时间"
 *
 * 这类歧义**模型会漂**（同一个"8点"，它有时给 08:00 有时给 20:00），
 * 而且"过了就顺延"这种**带 now 的判断**更是时对时错 —— 而错的后果是
 * **他以为定了、到时候没人喊他**。所以：**模型只负责"照他说的记"**
 * （钟点 + 有没有说早上/晚上 + 有没有说哪天），**换算全在这一个函数里**，
 * 可以单独测（`test/remind.js` 里那组时间用例就是钉这个的）。
 *
 * @param {{hour?:number, minute?:number, period?:string, day?:string}} spec
 *   `period`: `'am'` 早上/上午/凌晨 · `'pm'` 晚上/下午/傍晚 · `''` 没说
 *   `day`: `''` 没说 · `'today'` · `'tomorrow'` · `'YYYY-MM-DD'`
 * @param {number} [now]
 * @returns {number} 时间戳；算不出来返回 0
 */
export function resolveWhen(spec = {}, now = Date.now()) {
  const hourRaw = Number(spec.hour);
  if (!Number.isFinite(hourRaw) || hourRaw < 0 || hourRaw > 23) return 0;
  const minute = Math.min(59, Math.max(0, Number(spec.minute) || 0));
  const period = String(spec.period ?? '').trim().toLowerCase();
  const day = String(spec.day ?? '').trim();
  const base = new Date(now);
  const onDay = (offset) => {
    const x = new Date(base);
    x.setDate(x.getDate() + offset);
    return x;
  };
  const at = (d, h, m) => {
    const x = new Date(d);
    x.setHours(h, m, 0, 0);
    return x.getTime();
  };

  // ① 他**说了哪天** → 就按那天算（不自动顺延：明说了今天却已过，就该如实说"过了"）
  if (day === 'today' || day === 'tomorrow' || /^\d{4}-\d{1,2}-\d{1,2}$/.test(day)) {
    const d =
      day === 'today' ? onDay(0) : day === 'tomorrow' ? onDay(1) : new Date(`${day}T00:00:00`);
    if (Number.isNaN(d.getTime())) return 0;
    return at(d, to24(hourRaw, period), minute);
  }

  // ② 没说哪天 → 排候选时刻，取**最近的一个"还没到"的**
  //    ⚠️ 顺序就是用户的规则本身，别改：
  const cands = [];
  const push = (offset, h) => {
    const t = at(onDay(offset), h, minute);
    if (t > now) cands.push(t);
  };
  if (hourRaw === 0 || hourRaw >= 13) {
    push(0, hourRaw);
    push(1, hourRaw);
  } else if (hourRaw === 12) {
    if (period === 'pm') {
      push(1, 0);
      push(2, 0);
    } else {
      push(0, 12);
      push(1, 12);
    }
  } else if (period === 'am') {
    push(0, hourRaw);
    push(1, hourRaw);
  } else if (period === 'pm') {
    push(0, hourRaw + 12);
    push(1, hourRaw + 12);
  } else {
    // ⚠️ 只说「8点」这条路 —— 用户拍板的默认口径，三个候选的**顺序**就是答案：
    push(0, hourRaw + 12); // ① 今天 20:00（默认）
    push(1, hourRaw); //      ② 明天 08:00（过了今晚8点就是它）
    push(1, hourRaw + 12); // ③ 明天 20:00
  }
  return cands.sort((a, b) => a - b)[0] ?? 0;
}

/**
 * 他在**这个会话**里最近一条还没发出的提醒（2026-09-18 用户要求"补充式追加/修改"）。
 *
 * ⚠️ 为什么需要：他说「顺便改成五点」「也提醒一下老王」时，得先知道**他在说哪一条**。
 *    答案就是"这个会话里他自己最近定的那条" —— 人说话就是这样接着说的。
 *    ⚠️ 只认**同一个会话**（群 / 私聊）：他在 A 群定的，不能在 B 群被改掉。
 *
 * @param {{by?:string, groupId?:string}} q `groupId` 空串 = 私聊
 * @returns {object|null}
 */
export function latest({ by = '', groupId = '' } = {}) {
  const u = String(by ?? '').trim();
  const g = String(groupId ?? '');
  const live = st.items.filter((x) => !x.sentAt);
  for (let i = live.length - 1; i >= 0; i--) {
    if (String(live[i].by) === u && String(live[i].groupId) === g) return live[i];
  }
  return null;
}

/**
 * 改一条（**只改给了的字段**）。给"补充式的追加/修改"用。
 * ⚠️ 时间改成已经过去的 → 拒绝（返回 ok:false，上层会如实说）。
 * ⚠️ 加人时**自动去重**（同一个人说两遍不会 @ 两次）。
 */
export function amend(id, patch = {}, now = Date.now()) {
  const it = st.items.find((x) => x.id === Number(id));
  if (!it || it.sentAt) return { ok: false, reason: '这条已经不在待发里了' };
  if (patch.at !== undefined) {
    const at = Number(patch.at) || 0;
    if (!at || at <= now) return { ok: false, reason: '新时间已经过了' };
    if (at - now > maxAheadMs()) return { ok: false, reason: '时间太远了（超过 7 天）' };
    it.at = at;
  }
  if (patch.what !== undefined) {
    const w = String(patch.what).trim();
    if (w) it.what = w.slice(0, 200);
  }
  if (patch.targets !== undefined) {
    const seen = new Set(it.targets.map((t) => t.uid || t.name));
    for (const t of Array.isArray(patch.targets) ? patch.targets : []) {
      const key = String(t?.uid ?? '') || String(t?.name ?? '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      it.targets.push({ uid: String(t?.uid ?? ''), name: String(t?.name ?? '') });
    }
    it.targets = it.targets.slice(0, 5);
  }
  save();
  return { ok: true, item: it };
}

/** 取消一条（「不用提醒了」）。真的删掉，不是标记 —— 他不需要它再出现在任何地方。 */
export function cancel(id) {
  const n = st.items.length;
  st.items = st.items.filter((x) => x.id !== Number(id));
  if (st.items.length === n) return false;
  save();
  return true;
}

/**
 * 给聊天提示词用：**这个会话里还没到点的提醒**（2026-09-18 用户反馈：「提醒不会进聊天上下文」）。
 *
 * ⚠️ 为什么必须有：原来只在"他说那句话的那一轮"把提醒塞进提示词（`bot.js` 的 `event._remind`），
 *    **下一轮她就完全不知道有这回事了** —— 用户一问「你等会儿要提醒我什么」她就答不上来，
 *    甚至可能否认自己答应过 ✗。挂着的提醒是"她此刻的状态"，
 *    和"她在哪 / 在做什么"（`whereState`）、"她吃了没"（`meal`）是同一类东西 →
 *    **每次聊天都该带上**。
 *
 * ⚠️ **只给这个会话的**（群 / 私聊）—— 和"只在原地提醒"同一个口径：
 *    A 群定的提醒，不该在 B 群被她说出来。
 *
 * ⚠️ 只列**还没到点**的（到点的立刻就会被发出去）。
 *
 * @param {string} groupId 空串 = 私聊
 * @returns {string} 提示词片段；没有就返回空串
 */
export function hint(groupId = '', now = Date.now()) {
  const g = String(groupId ?? '');
  const live = st.items
    .filter((x) => !x.sentAt && x.at > now && String(x.groupId) === g)
    .sort((a, b) => a.at - b.at)
    .slice(0, 3);
  if (!live.length) return '';
  const fmt = (t) => {
    const d = new Date(t);
    const sameDay = d.toDateString() === new Date(now).toDateString();
    const day = sameDay ? '今天' : `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return [
    '## ⏰ 你**还记着**这些提醒（就在这个会话里，还没到点）',
    ...live.map(
      (x) =>
        `· ${fmt(x.at)} 提醒他「${x.what}」` +
        `${x.targets.length ? `（还要一并提醒 ${x.targets.map((t) => t.name || t.uid).join('、')}）` : ''}`,
    ),
    '⚠️ 这些是你**答应过、还没到点**的 —— 有人问起你要说得出来（「我四点得喊他」）。',
    '🚫 别主动催、别提前提醒、别当成已经发生的事，也别编没定过的提醒。',
  ].join('\n');
}

/** 到点、还没发过的（按时间正序） */
export function due(now = Date.now()) {
  return st.items.filter((x) => !x.sentAt && x.at <= now).sort((a, b) => a.at - b.at);
}

/** 标成"发过了" */
export function markSent(id, at = Date.now()) {
  const it = st.items.find((x) => x.id === Number(id));
  if (!it) return false;
  it.sentAt = at;
  save();
  return true;
}

/** 谁挂着的（给管理界面 / 排查用） */
export function pending(now = Date.now()) {
  return st.items.filter((x) => !x.sentAt).sort((a, b) => a.at - b.at);
}

export function status(now = Date.now()) {
  const live = pending(now);
  return {
    enable: enabled(),
    total: st.items.length,
    pending: live.length,
    next: live[0] ? { id: live[0].id, at: live[0].at, what: live[0].what } : null,
    maxItems: maxItems(),
    path: STATE_FILE,
  };
}

/** 测试专用 */
export function __clear() {
  st = blank();
  save();
}

reload();
