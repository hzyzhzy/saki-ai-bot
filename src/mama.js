/**
 * 「喊妈妈」—— 第一次拒绝，还喊就认了、并切**白祥模式**（2026-09-16 用户要求）。
 *
 * 用户原话：
 *   「群友喊机器人妈妈的时候反应可以改改，**第一次可以和之前一样表示拒绝**，
 *     但是如果**还喊**的话可以**接受**，并且切换**白祥模式**」
 *
 * ## 规则
 *
 * | 阶段 | 她怎么做 |
 * | --- | --- |
 * | 第一次（同一个人） | **明确拒绝**（跟以前一样：「别乱叫」那种） |
 * | 还喊（同一个人第 N 次，或者一群人在起哄） | **认了**，同时切进**白祥模式** |
 *
 * ⚠️ 「还喊」两种都算（都写进配置了）：
 *   · 同一个人叫到 `perUser` 次（默认 2）—— 死缠烂打型
 *   · 同一群累计 `groupTotal` 次（默认 3，按人次）—— 一群人在起哄型
 *
 * ## 白祥模式是什么
 *
 * 粉丝嘴里的「**白祥**」= 家里出事之前的祥子：温柔、爱笑、耐心、会照顾人
 * （对「黑祥」则是家道中落后那副冷硬的样子）。这个机器人平时那副嘴是偏冷的，
 * 白祥模式就是**把她还没被生活磨硬的那一面放出来** —— 软、耐心、有点妈妈味
 * （毕竟她刚刚认了这帮人当儿子），会唠叨吃饭睡觉，会护着人。
 *
 * ⚠️ 温柔 ≠ 没底线：该给的信息照给、不发嗲、不用客服腔、过分的要求照样拒。
 *
 * ## 两个必须记住的设计点
 *
 * ① **按群生效**：一个人在 A 群把她喊成妈，不该影响 B 群（这个项目里
 *    「按群隔离」踩过好几次：好感度、故事线、余额提醒都是）。
 * ② **必须落盘**（`state/mama.json`）：她刚认的妈，不能因为重启就不认了。
 *    出口有三个：`modeMs` 到点（期间每叫一次续期）、有人说「别当妈了 / 黑祥」、
 *    代码里 `exitMode()`。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, config } from './config.js';
import { log } from './log.js';
import * as persona from './persona.js';

const STATE_DIR = join(ROOT, 'state');
// ⚠️ 给测试留出口（和 QQBOT_AFFINITY_FILE / QQBOT_TIC_FILE 一个套路）
const FILE = process.env.QQBOT_MAMA_FILE
  ? join(ROOT, process.env.QQBOT_MAMA_FILE)
  : join(STATE_DIR, 'mama.json');

/** 群 → { users: Map<uid,{count,firstAt,lastAt}>, total, mode:{since,until,by}|null } */
let groups = new Map();
let loaded = false;

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function cfg() {
  const c = config.mama ?? {};
  return {
    enable: c.enable !== false,
    perUser: Math.max(1, num(c.perUser, 2)),
    groupTotal: Math.max(1, num(c.groupTotal, 3)),
    windowMs: Math.max(0, num(c.windowMs, 30 * 60 * 1000)),
    modeMs: Math.max(0, num(c.modeMs, 2 * 60 * 60 * 1000)),
  };
}

// ── 状态读写 ─────────────────────────────────────────

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(FILE)) return;
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    const next = new Map();
    for (const [gid, b] of Object.entries(j?.byGroup ?? {})) {
      const users = new Map();
      for (const [uid, v] of Object.entries(b?.users ?? {})) {
        users.set(String(uid), {
          count: Math.max(0, num(v?.count, 0)),
          firstAt: num(v?.firstAt, 0),
          lastAt: num(v?.lastAt, 0),
        });
      }
      const m = b?.mode;
      next.set(String(gid), {
        users,
        total: Math.max(0, num(b?.total, 0)),
        totalAt: num(b?.totalAt, 0),
        mode:
          m && num(m.until, 0) > 0
            ? { since: num(m.since, 0), until: num(m.until, 0), by: String(m.by ?? '') }
            : null,
      });
    }
    groups = next;
  } catch (e) {
    log.debug(`[妈妈] 读取失败（当作空的）：${e.message}`);
    groups = new Map();
  }
}

function save() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const byGroup = {};
    for (const [gid, b] of groups) {
      byGroup[gid] = {
        users: Object.fromEntries(b.users),
        total: b.total,
        totalAt: b.totalAt ?? 0,
        mode: b.mode,
      };
    }
    const tmp = `${FILE}.tmp`;
    // 原子写（`digest.js` / `affinity.js` 同款做法）
    writeFileSync(tmp, JSON.stringify({ byGroup }, null, 1), 'utf8');
    renameSync(tmp, FILE);
  } catch (e) {
    log.warn(`[妈妈] 写盘失败：${e.message}`);
  }
}

function bucket(gid, create = false) {
  load();
  const k = String(gid ?? '');
  if (!k) return null;
  let b = groups.get(k);
  if (!b && create) {
    b = { users: new Map(), total: 0, totalAt: 0, mode: null };
    groups.set(k, b);
  }
  return b ?? null;
}

// ── 判据：这句话是不是在叫她「妈妈」 ─────────────────

/**
 * 「妈」字前面是这些人称时**多半不是在叫她**（是在说自己/别人的妈，或者骂人）：
 * 我妈 / 你妈的 / 他妈的 / 咱妈 …
 * ⚠️ 但「当**我**妈妈」「叫**你**一声妈」这种**是**在让她当妈 —— 见 `ASK_HER`，
 *    那种情况会**先**被认出来，不走这条排除。
 */
const NOT_CALLING = /[我你他她它咱俺尼]妈/;
/** 「妈的」「妈呀」「妈耶」是感叹，不是叫人 */
const EXCLAMATION = /妈(?:的|呀|耶|哟|了个|卖批)/;
/** 句首的呼格：「妈妈」「妈咪」「祥妈」「小祥妈妈」… */
const STARTS_WITH_MOM = new RegExp(
  `^[\\s@,，。！!~～、]*(?:${persona.matchNamesAlt()})?\\s*(?:妈妈|妈咪|妈)`,
  'i',
);
/** 名字挨着妈：「祥妈」「祥子妈妈」「妈妈祥子」这种 */
const NEAR_NAME = new RegExp(
  `(?:${persona.matchNamesAlt()})\\s*(?:妈妈|妈咪|妈)|(?:妈妈|妈咪|妈)\\s*(?:${persona.matchNamesAlt()})`,
  'i',
);
/**
 * 「让我/你当妈」这种句式 —— 明确是在**让她当妈**：
 *   当我妈妈 / 你可以做我妈吗 / 叫你一声妈行不行
 * ⚠️ 必须带人称（我/你/您/俺）：光「当妈」两个字指不定在说谁。
 */
const ASK_HER = /(?:当|叫|喊|认|做)\s*(?:我|你|您|俺)[^妈]{0,3}(?:妈妈|妈咪|妈)/;
const HAS_MOM = /妈妈|妈咪|妈/;

/**
 * 这条消息是不是在**叫她**妈妈？
 *
 * ⚠️ 宁可漏、别误伤：判错了她会莫名其妙对着一个说自己妈妈的人认妈。
 *
 * @param {string} text 已经剥掉 @ 段的正文
 * @param {{isAtMe?:boolean, isQuoteMe?:boolean, isPrivate?:boolean}} [opts]
 *        「是不是冲着她说的」。⚠️ 光有这些还不够 —— 还得"妈"字本身像在叫她
 *        （句首呼格 / 名字挨着妈 / "当我妈妈"），或者整句很短。
 */
export function isMomCall(text, opts = {}) {
  // ⚠️⚠️ 2026-09-16 深夜修的真 bug（用户报「**妈妈模式没正常启动**」）：
  //    消息里带**占位符**时判据会失效 —— 群里那条是「引用她的消息 + @她 + 妈妈」，
  //    取出来是 `[引用#123]妈妈`：既不在句首（`[` 打头）、长度又超过 10，
  //    于是这里返回 false → **一次都没记账**（连 `state/mama.json` 都没生成），
  //    她就永远停在"自由发挥地拒绝"，白祥模式永远不启动。
  //    所以**先把占位符剥掉**（`[引用#…]`/`[图片]`/`[表情包]`…）再判。
  const t = String(text ?? '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  // 长句里夹一个"妈"多半不是叫她（「我妈妈今天做了饭」）
  if (t.length > 30) return false;
  if (!HAS_MOM.test(t)) return false;
  // 「妈的」「妈呀」是感叹，除非同时出现"妈妈/妈咪"
  if (EXCLAMATION.test(t) && !/妈妈|妈咪/.test(t)) return false;

  const askHer = ASK_HER.test(t);
  const nearName = NEAR_NAME.test(t);
  // 在说自己的妈/别人的妈 → 不算（除非那句是"当我妈妈"这种）
  if (!askHer && !nearName && NOT_CALLING.test(t)) return false;

  if (STARTS_WITH_MOM.test(t) || nearName || askHer) return true;
  // 剩下的：@ 她 / 引用她 / 私聊，且整句很短（「妈妈」这种就是喊她）
  const atHer = !!(opts.isAtMe || opts.isQuoteMe || opts.isPrivate);
  return atHer && t.length <= 10;
}

/** 这是不是「别当妈了」这种让她退出的暗号（只在白祥模式里才看） */
export function isExitPhrase(text) {
  return /别当妈|不当妈|别叫妈了|黑祥|变回去|变回来吧|结束白祥|正常点吧/.test(String(text ?? ''));
}

// ── 记账 ────────────────────────────────────────────

/**
 * 记一次「叫妈妈」，返回这次该怎么做。
 *
 * @returns {{phase:'refuse'|'accept'|'keep', userCount:number, groupCount:number, until:number}}
 */
export function note(gid, uid, at = Date.now()) {
  const c = cfg();
  const b = bucket(gid, true);
  const u = String(uid ?? '');
  if (!b || !u) return { phase: 'refuse', userCount: 0, groupCount: 0, until: 0 };

  // 计数窗口：整群太久没叫就重新算（不然"上个月叫过一次"也算数）
  if (c.windowMs > 0 && at - (b.totalAt ?? 0) > c.windowMs) {
    b.users.clear();
    b.total = 0;
  }
  const prev = b.users.get(u);
  const fresh = !prev || (c.windowMs > 0 && at - (prev.lastAt ?? 0) > c.windowMs);
  const count = fresh ? 1 : prev.count + 1;
  b.users.set(u, { count, firstAt: fresh ? at : (prev?.firstAt ?? at), lastAt: at });
  // ⚠️ 群里累计是**人次**（不同的人各叫一次也算），所以这里无条件 +1
  b.total += 1;
  b.totalAt = at;

  const modeActive = isModeActive(b, at);
  const shouldAccept = count >= c.perUser || b.total >= c.groupTotal;
  let phase = 'refuse';
  if (shouldAccept) {
    phase = modeActive ? 'keep' : 'accept';
    b.mode = { since: modeActive ? b.mode.since : at, until: at + c.modeMs, by: u };
  }
  save();
  log.info(
    `[妈妈] ${gid || '私聊'}/${u} 第 ${count} 次叫（群里累计 ${b.total} 次）→ ` +
      `${
        phase === 'refuse'
          ? '还是拒绝'
          : phase === 'accept'
            ? `认了，切白祥模式到 ${new Date(at + c.modeMs).toLocaleString('zh-CN')}`
            : '白祥模式续期'
      }`,
  );
  return { phase, userCount: count, groupCount: b.total, until: b.mode?.until ?? 0 };
}

function isModeActive(b, at = Date.now()) {
  return !!(b?.mode && b.mode.until > at);
}

/** 白祥模式现在开着吗？（过期的顺手清掉并落盘） */
export function modeOf(gid, at = Date.now()) {
  const b = bucket(gid);
  if (!b) return { active: false, until: 0, since: 0, by: '' };
  if (b.mode && b.mode.until <= at) {
    b.mode = null;
    save();
  }
  return {
    active: !!(b.mode && b.mode.until > at),
    until: b.mode?.until ?? 0,
    since: b.mode?.since ?? 0,
    by: b.mode?.by ?? '',
  };
}

/** 手动退出白祥模式（暗号触发 / 管理界面） */
export function exitMode(gid, reason = '') {
  const b = bucket(gid);
  if (!b?.mode) return false;
  b.mode = null;
  save();
  log.info(`[妈妈] ${gid || '私聊'} 退出白祥模式${reason ? `（${reason}）` : ''}`);
  return true;
}

/** 把某个群的计数清空（重新开始"第一次拒绝"） */
export function reset(gid) {
  const b = bucket(gid);
  if (!b) return false;
  b.users.clear();
  b.total = 0;
  b.totalAt = 0;
  b.mode = null;
  save();
  return true;
}

// ── 提示词 ──────────────────────────────────────────

/** 第一次：明确拒绝（跟以前一样） */
export function refuseHint() {
  return [
    '## ⚠️ 他又喊你「妈妈」了（第一次）',
    '',
    '⚠️⚠️ **先把方向说清（这里最容易搞反）**：',
    '他喊你「妈妈」= **他管你叫妈、他想让你当他妈**。',
    '**你是被叫的那一个** —— 你当然不是他妈（至少第一次不接，你又不是随便谁都喊得动的）。',
    '',
    '**明确拒绝**就行：',
    '- 短、冷、直接：「别乱叫。」「谁是你妈。」「叫名字。」',
    '- 可以带点嫌弃，但**别凶到翻脸**（他们是玩梗，不是骂你）。',
    '- ❌ 别真的开始照顾他（"吃饭了吗"那一套）。',
    '- ❌ **尤其别搞反**：别顺着回「好的妈妈」「妈妈我错了」这种 ——',
    '  那等于**你把他当妈**，梗当场就歪了（你要么不接，要么就是"他叫你妈"这件事）。',
  ].join('\n');
}

/** 还喊：认了 + 进白祥模式（这一句要当场表现出来） */
export function acceptHint() {
  return [
    '## ⚠️⚠️ 他又喊「妈妈」了 —— 这次**认了吧**',
    '',
    '⚠️⚠️ **认的是什么，别搞反**：他喊你「妈妈」是**他管你叫妈**。',
    '你认下来 = **从这一刻起你是他妈** —— **你是妈妈，他是儿子/闺女**。',
    '（不是反过来：你不是他女儿，他也不许被你叫"妈"。）',
    '',
    '第一次你已经拒绝过了，人家还是这么叫。再板着脸就没意思了 ——',
    '**这一句就是"认下来"的那一刻**，然后说话风格跟着变（下面那段【白祥模式】）。',
    '',
    '- 认的方式要**像你**：半推半就、嘴上嫌烦但其实是让步了（让步的是"让他叫妈"这件事）。',
    '  ✅「……行吧，叫就叫吧。」「就这一次啊。」「算了，随你们。」',
    '  ❌ 别热情过头（「好儿子！」那种，你还没那么入戏）。',
    '- ⚠️ 认了之后**别反复**：别下一句又翻脸说"谁是你妈"。',
  ].join('\n');
}

/** 白祥模式那段（模式开着时每句都注入） */
export function modeHint(gid) {
  const m = modeOf(gid);
  if (!m.active) return '';
  return [
    '## 🌤 现在是【白祥模式】（他们已经喊你妈喊到你认了）',
    '',
    '## ⚠️⚠️ 先记住方向（最容易搞反的一条）',
    '',
    '**你是妈，他们是儿子/闺女。** 你认下的是"**他管你叫妈**"这件事 ——',
    '所以从现在起**你**是那个照顾人的：',
    '',
    '- ✅ 你：说话软、有耐心、会问一句吃饭没睡觉没、他们受委屈你护着 —— 这才叫"妈妈味"',
    '- ❌ **反过来绝对不行**：❌ 别管他们叫「妈妈」 ❌ 别自称"女儿"/"小孩"',
    '  ❌ 别说「妈妈我错了」「妈妈抱抱」「谢谢妈妈」这种 ——',
    '  那就成了**你把他当妈**，梗整个反了（用户 2026-09-16 专门提醒过这一点）',
    '',
    '## 具体怎么变',
    '',
    '粉丝管你家里出事**之前**那副样子叫「白祥」—— 温柔、爱笑、耐心、会照顾人。',
    '平时的你嘴是冷的（那是后来的你）；**现在把那一面放出来一阵子**：',
    '',
    '- **语气软下来**：不抬杠、不阴阳、不每句都顶回去；该笑就笑。',
    '- **耐心**：多解释两句也没关系，别不耐烦。',
    '- **有点当妈的样子**：会问一句吃饭没、睡觉没；',
    '  有人熬夜/不吃饭/考砸了，会唠叨两句 —— 但**别唠叨成客服**。',
    '- **护着自己人**：群里有人被怼，可以帮着说一句。',
    '',
    '⚠️ 但**温柔 ≠ 没底线**：',
    '- 该给的信息照给，服务器问题照样直接答，**别用客服腔、别发嗲、别「啦~」**。',
    '- 过分的要求照样拒绝，只是拒绝得软一点。',
    '- 偶尔自称一句"妈"可以（「妈说句实话」），但**别每句都提**、别自居上瘾。',
    '- 别人**没有**故意玩这个梗的时候，别主动扯到"我是你妈"上。',
  ].join('\n');
}

/** 给管理界面 / 日志看的状态 */
export function status() {
  load();
  const out = {};
  for (const [gid, b] of groups) {
    out[gid] = {
      total: b.total,
      users: Object.fromEntries([...b.users].map(([k, v]) => [k, v.count])),
      mode: isModeActive(b) ? { until: b.mode.until, since: b.mode.since, by: b.mode.by } : null,
    };
  }
  return out;
}

/** 测试用：清空内存状态 */
export function __clear() {
  groups = new Map();
  loaded = true;
}
