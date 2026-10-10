/**
 * 生日 + **动态年龄**（2026-10-09 用户要求）。
 *
 * 用户原话：「把所有角色的信息**只留下生日**，**年龄变为真实动态的**，
 *   这样随机事件和剧情可以出现**互相庆祝生日**的好事」。
 *
 * ## 为什么这么设计
 *
 * · **年龄不许写死在文本里** —— 写死的话过一年就不对了，而且两个号会越差越多
 *   （用户报「再留几年就变成高中留级生了」这类穿帮的根子就是这个）。
 *   所以只在 `identity.json` 里记两样东西：
 *     · `birthday {month, day}` —— 月日（唯一"每人都该有、而且每年都会到"的日子）；
 *     · `birthYear` —— 出生年，**年龄随时算**：
 *         2026 年（生日已过）= 15 岁 ⇒ 2027 年自动 16 岁 ✓ 不用改任何文本。
 * · 生日正好也是"**互相庆祝**"这个需求的载体：她自己的生日、同类那个号的生日，
 *   都是每年必到、又天然带着情绪的日子 —— 日常事件和剧情都能拿它做文章。
 *
 * ## 数据在哪
 *   `personas/<id>/identity.json`：
 *   ```json
 *   "birthday": { "month": 2, "day": 14 },
 *   "ageBase": { "year": 2026, "age": 15, "note": "官方设定：高一，15 岁" }
 *   ```
 *   ⚠️⚠️ `ageBase` 记的是**官方设定"哪一年几岁"**（用户 2026-10-09 要求）——
 *      **不要写"出生年"**：官方没有那个设定，写进去就是编的（他当场纠正过）。
 *   ⚠️ 缺这两个字段的人设包**不会报错**，只是拿不到生日（返回 `null`）——
 *      新加的角色可以先跑起来，之后再补数据。
 *
 * ## 谁调用它
 *   · `src/bot.js` 的 `buildSystemPrompt`：把"你今天几岁 / 今天谁过生日 / 谁快过生日"
 *     拼进提示词（她自己算不明白这个，必须算给她看）；
 *   · （计划）`src/life.js` 的日常事件池：生日当天换成生日专属事件；
 *   · （计划）`src/quest.js`：临近生日时给剧情一个"互相庆祝"的引子。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
// ⚠️ 顶层 import 就行：`accounts.js` 不引用本模块，没有循环依赖。
import * as accounts from './accounts.js';

const DIR = join(ROOT, 'personas');

/** 所有人设包的 id（目录名） */
export function ids() {
  try {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function readIdentity(id) {
  const p = join(DIR, String(id ?? ''), 'identity.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * 这个人设的生日。拿不到就返回 `null`（缺字段 / 包不存在 / 数字不合法）。
 *
 * ⚠️⚠️ 年龄基准记的是「**官方故事背景的年份 + 那时几岁 ⇒ 反推的出生年**」：
 *   ```json
 *   "age": { "storyYear": 2026, "atStory": 15, "bornYear": 2011, "derived": true,
 *            "note": "官方故事背景 2026 年、那时 15 岁 ⇒ 反推出生年 2011" }
 *   ```
 *   用户连着纠正过两次，这条别改回去：
 *     · 「出生年份不对，**不是官方设定的年份**」⇒ 出生年不能当成官方原文写；
 *     · 「如果官方没给，可以**从官方设定故事背景的时间反推**」⇒ 把**推法**写进数据，
 *       这样谁都能照着核（`storyYear` 是哪一年、`atStory` 是几岁、`bornYear` 是推出来的）。
 *   ⚠️ 兼容更早的两种写法：`ageBase:{year,age}` / `birthYear:2011`（后者是自造的，已废弃）。
 *
 * @returns {{id:string,name:string,month:number,day:number,birthYear:number|null,
 *            ageBase:{year:number,age:number}|null, derived:boolean}|null}
 */
export function of(id) {
  const j = readIdentity(id);
  if (!j) return null;
  const month = Number(j.birthday?.month);
  const day = Number(j.birthday?.day);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;

  const ag = j.age ?? {};
  const storyYear = Number(ag.storyYear);
  const atStory = Number(ag.atStory);
  const bornRaw = Number(ag.bornYear);
  const baseYear = Number(j.ageBase?.year);
  const baseAge = Number(j.ageBase?.age);
  const legacy = Number(j.birthYear);
  const okYear = (n) => Number.isFinite(n) && n > 1900;

  let birthYear = null;
  let ageBase = null;
  let derived = false;
  if (okYear(bornRaw)) {
    // ① 当前写法：出生年是**反推**出来的（`derived` 标明这一点）
    birthYear = bornRaw;
    derived = ag.derived === true || (Number.isFinite(storyYear) && Number.isFinite(atStory));
    if (Number.isFinite(storyYear) && Number.isFinite(atStory)) {
      ageBase = { year: storyYear, age: atStory };
    }
  } else if (okYear(baseYear) && Number.isFinite(baseAge) && baseAge >= 0) {
    // ② 上一版写法：「哪一年几岁」
    birthYear = baseYear - baseAge;
    derived = true;
    ageBase = { year: baseYear, age: baseAge };
  } else if (okYear(legacy)) {
    // ③ 最初那版：直接写出生年（自造的，留着只为不让旧数据文件当场失效）
    birthYear = legacy;
  }

  return {
    id: String(id),
    name: String(j.name ?? id),
    month,
    day,
    birthYear,
    ageBase,
    derived,
  };
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * **动态年龄**（按当天日期算，不是写死的）。
 *
 * ⚠️ 生日那天算**已经长了一岁**（`>=` 而不是 `>`）—— 否则生日当天会报小一岁，
 *    而那正是最需要说对的一天。
 */
export function ageOf(id, now = Date.now()) {
  const b = of(id);
  if (!b || !b.birthYear) return null;
  const t = new Date(now);
  const passed =
    t.getMonth() + 1 > b.month || (t.getMonth() + 1 === b.month && t.getDate() >= b.day);
  return t.getFullYear() - b.birthYear - (passed ? 0 : 1);
}

/** 距离下一次生日还有几天（今天过生日 = 0） */
export function daysUntil(id, now = Date.now()) {
  const b = of(id);
  if (!b) return null;
  const t = new Date(now);
  const y = t.getFullYear();
  const today = startOfDay(t);
  let target = new Date(y, b.month - 1, b.day).getTime();
  if (target < today) target = new Date(y + 1, b.month - 1, b.day).getTime();
  return Math.round((target - today) / 86400000);
}

export function isToday(id, now = Date.now()) {
  return daysUntil(id, now) === 0;
}

/** 今天过生日的**所有人设包**（给日常事件用） */
export function onDay(now = Date.now()) {
  return ids()
    .filter((id) => isToday(id, now))
    .map((id) => of(id))
    .filter(Boolean);
}

/**
 * 群里的 QQ 号 → 它当前用的人设包 id。
 *
 * 为什么需要它：「另一个号过生日」得先知道**那个号现在是谁**（`accounts/<QQ>.yml`
 * 的 `persona.id`）—— 否则只知道"某个包今天过生日"，跟群里的人对不上。
 * ⚠️ 读不到就返回空串（多号没配 / 文件被手改坏），调用方当作"没有这个人"处理。
 */
export function personaIdOfQQ(qq) {
  try {
    const a = accounts.read(String(qq ?? '').trim());
    return String(a?.persona?.id ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * **cast.md 里那些角色的生日**（2026-10-09 第二批）。
 *
 * 为什么需要：`identity.json` 只管"会说话的那几个号"（saki / anon / mortis …），
 * 而"给灯过生日"这种桥段要的是**名册里的人**的生日 —— 那些写在
 * `personas/<id>/cast.md` 里（格式两种，见下面两条正则）：
 *   · 角色条目里：`- 生日：**11 月 22 日**（官方设定 …）`
 *   · 整团那一段：`> 生日：户山香澄 8/12、花园多惠 12/6、…`
 *
 * ⚠️ 配角**只有生日、没有年龄**（用户要的「只留下生日」）—— 所以这里不返回岁数。
 * ⚠️ 各个包的 cast.md 内容基本一样（同一套角色）⇒ 按名字去重。
 *
 * @param {string[]|null} packs 要读哪几个包；不给就**所有**包
 * @returns {{name:string, month:number, day:number}[]}
 */
export function castBirthdays(packs = null) {
  const out = [];
  const seen = new Set();
  const add = (name, month, day) => {
    const n = String(name ?? '').trim();
    if (!n || !(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return;
    const key = `${n}|${month}|${day}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: n, month, day });
  };
  for (const id of packs ?? ids()) {
    const f = join(DIR, String(id), 'cast.md');
    if (!existsSync(f)) continue;
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    let cur = '';
    for (const line of text.split('\n')) {
      const h = /^###\s+(.+)$/.exec(line);
      if (h) {
        cur = h[1].split('/')[0].trim();
        continue;
      }
      const m = /^-\s*生日：\*{0,2}\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(line);
      if (m) {
        add(cur, Number(m[1]), Number(m[2]));
        continue;
      }
      const t = /^>\s*生日：(.+)$/.exec(line);
      if (t) {
        for (const p of t[1].matchAll(/([^\s、,，]+?)\s*(\d{1,2})\/(\d{1,2})/g)) {
          if (/^(名单|生日)$/.test(p[1])) continue;
          add(p[1], Number(p[2]), Number(p[3]));
        }
      }
    }
  }
  return out;
}

const _md = (m, d) => `${m} 月 ${d} 日`;

/**
 * 今天过生日的人（**自己**在第一个，然后是名册里的人）。
 * @returns {{name:string, month:number, day:number, self:boolean, age:number|null}[]}
 */
export function todayAll(now = Date.now(), selfId = '', packs = null) {
  const out = [];
  const me = selfId ? of(selfId) : null;
  if (me && daysUntil(selfId, now) === 0) {
    out.push({ name: me.name, month: me.month, day: me.day, self: true, age: ageOf(selfId, now) });
  }
  for (const c of castBirthdays(packs)) {
    if (me && c.name === me.name) continue;
    if (sameMD(c.month, c.day, now)) out.push({ ...c, self: false, age: null });
  }
  return out;
}

/** **还有几天**到生日（今天 = 0）；给"临近"用 */
function daysToMD(month, day, now) {
  const t = new Date(now);
  const y = t.getFullYear();
  const today = startOfDay(t);
  let target = new Date(y, month - 1, day).getTime();
  if (target < today) target = new Date(y + 1, month - 1, day).getTime();
  return Math.round((target - today) / 86400000);
}
const sameMD = (month, day, now) => {
  const t = new Date(now);
  return t.getMonth() + 1 === month && t.getDate() === day;
};

/**
 * 未来几天内要过生日的人（**自己 + 名册里的人**）—— 剧情/日常事件用。
 * @returns {{name:string, month:number, day:number, self:boolean, inDays:number, age:number|null}[]}
 */
export function upcomingAll(now = Date.now(), days = 14, selfId = '', packs = null) {
  const out = [];
  const me = selfId ? of(selfId) : null;
  if (me) {
    const d = daysUntil(selfId, now);
    if (d !== null && d <= days) {
      out.push({ name: me.name, month: me.month, day: me.day, self: true, inDays: d, age: ageOf(selfId, now) });
    }
  }
  for (const c of castBirthdays(packs)) {
    if (me && c.name === me.name) continue;
    const d = daysToMD(c.month, c.day, now);
    if (d <= days) out.push({ ...c, self: false, inDays: d, age: null });
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}

/**
 * 给**日常事件**（`src/life.js`）用的那一段：今天/最近是谁的生日。
 *
 * ⚠️ 写法上的讲究（不然会出事）：
 *   · **关系和分寸按人设来** —— 名册里每个人"怎么相处"都写在 cast 里，
 *     这里只给"今天是谁生日"这个事实 + 一句"怎么表示看关系"，不替她定调；
 *   · 自己生日**别写成"她一定会广播"**（她不是那种人）；别人生日也别写成"必须热络"。
 */
export function lifeNote(now = Date.now(), { selfId = '', packs = null, soonDays = 0 } = {}) {
  const list = upcomingAll(now, soonDays, selfId, packs);
  if (!list.length) return '';
  const lines = [];
  for (const p of list) {
    if (p.self) {
      lines.push(
        p.inDays === 0
          ? `· **今天是你自己的生日**（${_md(p.month, p.day)}）${p.age ? ` —— 你 ${p.age} 岁了` : ''}。` +
              '要不要提、怎么提，你自己定（你不爱张扬）。'
          : `· 你自己的生日是 ${_md(p.month, p.day)}（**还有 ${p.inDays} 天**）。`,
      );
    } else if (p.inDays === 0) {
      lines.push(
        `· **今天是 ${p.name} 的生日**（${_md(p.month, p.day)}）。` +
          '⚠️ 要不要有表示、说到什么程度，**按你和她的关系来**（关系多远、有多久没联系，都在设定里）——' +
          '别一律热络，也别当成没看见。' +
          '（这件小事可以是：**挑礼物**、**被叫去她家**、顺路买个蛋糕、路上碰见、或者只发一句话 ——' +
          '按关系挑一种，别硬凑。）' +
          // ⚠️ 2026-10-09 用户要求：「**机器人可以直接 @ 那个过生日的人**」——
          //    她写 `@名字`，发送层会转成真正的 at 段（不用打标记）。
          `要当面说就写 \`@${p.name}\`（会真的 @ 到她）。`,
      );
    } else {
      lines.push(
        `· ${p.inDays} 天后是 ${p.name} 的生日（${_md(p.month, p.day)}）——` +
          '可以提前想、也可以就当不知道（按关系定）。',
      );
    }
  }
  if (!lines.length) return '';
  return ['', '### 🎂 生日（今天和最近）', '', ...lines].join('\n');
}

/**
 * 给**剧情**（`src/quest.js`）用的那一段：可选的生日线索。
 *
 * ⚠️ 只给"线索"，不强制 —— 剧情本来该由她（和同类）自己走，
 *    硬塞"你必须给谁过生日"会把戏演成任务清单。
 *
 * ⚠️ 2026-10-09 用户补的例子（原话）：「可以有**去对方家里参加生日派对**的剧情，
 *    或者**送礼物**的剧情」⇒ 下面列了四种**具体桥段**给他挑。
 *    ⚠️ 但**不是让她全用**（写了"挑一个，别全塞"）—— 四件事挤在一段里就成流水账了。
 */
export function questNote(now = Date.now(), { selfId = '', packs = null, soonDays = 0 } = {}) {
  const list = upcomingAll(now, soonDays, selfId, packs).filter((p) => p.name);
  if (!list.length) return '';
  const head = list
    .slice(0, 4)
    .map((p) => (p.self ? `你自己（${p.inDays === 0 ? '今天' : `${p.inDays} 天后`}）` : `${p.name}（${p.inDays === 0 ? '今天' : `${p.inDays} 天后`}）`))
    .join('、');
  return [
    '',
    '### 🎂 顺带一提（**可以用，也可以不用**）',
    '',
    `· 最近要过生日的人：${head}。`,
    '· 想把这条线往"过生日"上带的话，**挑一个**（别全塞，四件事挤一段就成了流水账）：',
    '   · **去对方家里**给他过 —— 提前到、帮忙布置、被拉去买东西、散场后一起收拾；',
    '   · **送礼物** —— 挑的时候拿不定主意（预算、对方喜欢什么、会不会显得太刻意）；',
    '     也可以反过来写：**准备了但没送出去**、或者**送出去那一刻**比礼物本身更重要；',
    '   · **被邀请 / 收到邀请** —— 要不要去、几点到、还有谁在、要不要带点东西；',
    '   · **嘴上说不过、结果还是去了**（或者压根没去，只在心里过了一遍）。',
    '· ⚠️ 两条底线：',
    '   · **别提前说破**（本人不能先知道细节 —— 惊喜全靠这一点）；',
    '   · **按你们之间真实的关系定分寸**（该别扭的别扭、该有距离的有距离，别写成和气一团）。',
    // ⚠️ 2026-10-09 用户要求：「**机器人可以直接 @ 那个过生日的人**」——
    //    写 `@名字` 就行（发送层转真 at），所以剧情里"当面祝一句"是能演出来的。
    '· 要当面说就直接写 `@名字`（会真的 @ 到对方）—— 不用打任何标记。',
  ].join('\n');
}

/**
 * 拼进提示词的那段（没有可说的内容时返回空串 —— 不占字数、也不破坏缓存前缀）。
 *
 * 为什么**必须算给她看**：她自己在对话里推不准"我今天几岁"（模型对日期算术不可靠），
 * 而这两个信息恰好是**每年必到、且最容易说错**的。
 *
 * @param {number} now
 * @param {{selfId?:string, peerIds?:string[], soonDays?:number}} opts
 *        `peerIds` 里放"同类那个号现在用的人设 id"（用 `personaIdOfQQ()` 换出来）。
 */
export function note(now = Date.now(), { selfId = '', peerIds = [], soonDays = 0 } = {}) {
  const lines = [];
  const me = selfId ? of(selfId) : null;
  if (me) {
    const age = ageOf(selfId, now);
    const d = daysUntil(selfId, now);
    const bd = `${me.month} 月 ${me.day} 日`;
    if (d === 0) {
      lines.push(
        `· **今天是你自己的生日**（${bd}）${age ? ` —— 你满 ${age} 岁了` : ''}。` +
          '别人提起来就好好接住；没人提也别自己开场广播（你不爱张扬）。',
      );
    } else if (age) {
      // ⚠️ 只写"现在几岁"这个事实 —— 具体怎么说是她自己的事（傲娇 / 不想被算年纪）。
      lines.push(
        `· 你现在 **${age} 岁**（生日 ${bd}${d <= soonDays ? `，还有 ${d} 天` : ''}）。` +
          '⚠️ 年龄按**当天日期**算，别人问到就按这个，别凭印象报。',
      );
    }
  }

  const seen = new Set();
  for (const pid of peerIds) {
    const o = of(pid);
    if (!o || o.id === me?.id || seen.has(o.id)) continue;
    seen.add(o.id);
    const d = daysUntil(o.id, now);
    const bd = `${o.month} 月 ${o.day} 日`;
    if (d === 0) {
      lines.push(
        `· **今天 ${o.name} 过生日**（${bd}）—— 祝贺一句、或者做点什么都行` +
          '（关系近就别太客气，硬邦邦的祝福反而假）。',
      );
    } else if (d !== null && d <= soonDays) {
      lines.push(
        `· ${o.name} 的生日是 ${bd}（**还有 ${d} 天**）—— 想准备就悄悄准备，别提前说破。`,
      );
    }
  }

  if (!lines.length) return '';
  return ['', '### 🎂 生日', '', ...lines].join('\n');
}
