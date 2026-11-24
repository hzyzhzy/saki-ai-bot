/**
 * 好感度 —— 机器人对每个群友的**私人评分**（0~100，默认 50）。
 *
 * 用户需求（2026-09-14）：
 *   「先把群友信息库升级一下，加一个**机器人对这个人的好感度**，类似 galgame 的，
 *    默认 50，最小 0 最大 100。但是**其中优先级是低于我和机器人的特殊关系的**。」
 *
 * ## ⚠️⚠️ 三条铁律（改这个模块之前先读）
 *
 * ### ① 好感度**不影响她对 <主人> 的态度**，那是最高优先级
 *
 * 用户原话：「**优先级是低于我和机器人的特殊关系的**」。
 * 也就是说：`relationship.md` 里那套「对他不端着、不用敬语、接住他的好话」
 * **比好感度高**。哪怕哪天 <主人> 的好感度掉到 0，她还是那个跟他说话的小祥 ——
 * 好感度**只能影响她对普通群友的距离感**，不能反过来覆盖与服主的关系。
 *
 * 代码里靠两件事保证：
 *   · `promptLine()` 会**显式写上这句**
 *   · `attitudeFor('owner')` / `relationshipText()` 的注入**不受这个模块影响**
 *
 * ### ② 好感度**不会自动被改写**
 *
 * 用户原话：「**好感度也不能修改**」—— 那句是接着"按时间压缩"说的，
 * 意思是：**压缩/总结那套自动机制不许动好感度**。
 * 所以本模块**不监听** `observe` 的总结流程，`observe.js` 也**不碰**
 * `state/affinity.json`。要调只能由代码里明确调用 `adjust()`。
 *
 * ### ③ 它**不在 group-memory.md 里**
 *
 * 用户说"加到群友信息库"，但那个文件是**给人看、给模型读的散文**，
 * 而好感度是**程序状态**：
 *   · 要跨重启保留（所以落盘 `state/affinity.json`）
 *   · 一个字都不许被 LLM 重写
 *   · 要能按人查
 * 混进 md 里的话，`observe.js` 每次重写自动区都会把它冲掉。
 * 所以**存 state，注入提示词时单独成段**。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, config, stateDir, KNOWLEDGE_DIR } from './config.js';
import { log } from './log.js';

const STATE_DIR = join(stateDir());
// ⚠️ 给测试留出口（和 QQBOT_TIC_FILE / QQBOT_QZONE_FILE 一个套路）
const FILE = process.env.QQBOT_AFFINITY_FILE
  ? join(ROOT, process.env.QQBOT_AFFINITY_FILE)
  : join(STATE_DIR, 'affinity.json');

/** 默认好感度（用户指定 50） */
export const DEFAULT_AFFINITY = 50;
export const MIN_AFFINITY = 0;
// ⚠️⚠️ 2026-09-20 要求：「**把好感度上限修改为无限**」——
//    原来封顶 100（到顶就是"满分"），现在**不设上限**：处得越久、参与剧情越多，可以一直涨。
//    ⚠️ 保留这个常量名是为了不动调用方；值用 `Infinity`。
//    ⚠️ 对外（`status().range` / 界面）**报 `null` 表示"无上限"** ——
//      `Infinity` 一旦被 JSON.stringify 会变成 `null`，与其让它"意外"变 null，不如我们自己说清楚。
export const MAX_AFFINITY = Infinity;

/**
 * 两条硬边界：
 *   · 单次调整的幅度上限 —— 防止一次"聊得好"就暴涨（那样不像慢慢处出来的）
 *   · 单位时间内的调整上限 —— 防止刷分
 */
const MAX_STEP = 3;
const DAY_CAP = 8;

/**
 * ⚠️⚠️ 2026-09-15 晚：**按群各记各的**（<主人>：「好感度也还没有分群」）。
 *
 *    为什么该分：同一个 QQ 在不同群里的"关系"根本不是一回事 ——
 *    A 群是天天一起玩 MC 的老朋友，B 群是刚进群问问题的陌生人 ✗
 *    合在一起算，她在 B 群会莫名其妙地熟络，在 A 群又可能被别的群的分拖低。
 *
 *    形状：`群号 -> { users: Map<uid,{v,at,note}>, dayBudget }`
 *    ⚠️ `''`（空群号）＝「不知道是哪个群」（私聊/老调用点），照旧能用。
 */
let groups = new Map();
/**
 * **分群之前**那份老数据 —— 只当"兜底"：
 *   群桶里查不到这个人时，回退到它（这样现有分数不会因为分群突然消失）。
 *   加载时还会**尽力把它按 names 归属到各个群**（见 `migrateLegacy`）。
 */
let legacy = { users: new Map(), dayBudget: { date: '', used: new Map() } };

const gk = (groupId) => String(groupId ?? '').trim();

/** 拿一个群的桶（`create` = 没有就建一个） */
function bucket(groupId, create = false) {
  const k = gk(groupId);
  let b = groups.get(k);
  if (!b && create) {
    b = { users: new Map(), dayBudget: { date: todayKey(), used: new Map() } };
    groups.set(k, b);
  }
  return b ?? null;
}

const cfg = () => config.affinity ?? {};
const enabled = () => cfg().enable !== false;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/** 把老数据（分群之前那份）尽量按 `names` 归属到群；归属不了的留在 legacy 兜底 */
function migrateLegacy() {
  if (!legacy.users.size) return 0;
  let moved = 0;
  try {
    // 延迟 import，别在模块顶层制造循环依赖
    const gidsOf = (uid) => {
      try {
        const raw = readFileSync(join(stateDir(), 'names.json'), 'utf8');
        const j = JSON.parse(raw);
        const out = [];
        // ⚠️ `names.json` 的 `card` 是**两层**的：`{ "<群号>": { "<uid>": "群名片" } }`
        //    （第一版我按扁平键 `<群号>:<uid>` 去找，结果一个都归属不到 ✗）
        for (const [gid, map] of Object.entries(j?.card ?? {})) {
          if (!map || typeof map !== 'object') continue;
          if (Object.prototype.hasOwnProperty.call(map, String(uid))) out.push(String(gid));
        }
        return out;
      } catch {
        return [];
      }
    };
    for (const [uid, e] of legacy.users) {
      const gids = gidsOf(uid);
      if (!gids.length) continue;
      for (const gid of gids) {
        const b = bucket(gid, true);
        if (!b.users.has(uid)) {
          b.users.set(uid, { ...e });
          moved++;
        }
      }
    }
  } catch (e) {
    log.debug(`好感度按群归属失败（老数据仍作兜底）：${e.message}`);
  }
  return moved;
}

export function reload() {
  try {
    if (!existsSync(FILE)) return;
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    const readUsers = (obj) => {
      const m = new Map();
      for (const [k, v] of Object.entries(obj ?? {})) {
        const n = Number(v?.v);
        if (!k || !Number.isFinite(n)) continue;
        m.set(String(k), {
          v: clamp(n),
          at: Number(v?.at) || 0,
          note: v?.note ? String(v.note).slice(0, 60) : undefined,
          // ⚠️ 2026-11-03 新增：剧情结局单独一个字段。
          //    原来它被塞进 `note`（`quest.js` 的 `settle()` 写「主线剧情：好/坏结局」），
          //    把 `note` 里本该放"这人是谁、聊过什么"的位置占掉了 ⇒
          //    隔天再碰到同一个人，档案里只剩一句剧情标签，她认不出来。
          ending: v?.ending === 'good' || v?.ending === 'bad' ? v.ending : undefined,
        });
      }
      return m;
    };
    const readBudget = (d) => {
      if (d && d.date === todayKey() && d.used && typeof d.used === 'object') {
        return { date: d.date, used: new Map(Object.entries(d.used).map(([k, v]) => [k, Number(v) || 0])) };
      }
      return { date: todayKey(), used: new Map() };
    };

    const next = new Map();
    for (const [gid, b] of Object.entries(j?.byGroup ?? {})) {
      next.set(String(gid), { users: readUsers(b?.users), dayBudget: readBudget(b?.dayBudget) });
    }
    groups = next;
    // 老形状（分群之前：顶层直接 users/dayBudget）→ 进 legacy
    if (j?.users && typeof j.users === 'object') {
      legacy = { users: readUsers(j.users), dayBudget: readBudget(j.dayBudget) };
      const moved = migrateLegacy();
      if (moved) {
        log.info(`[好感度] 把分群之前的老分数按群归属了 ${moved} 条（原来是一份全局的）`);
        save();
      }
    } else if (j?.legacy) {
      legacy = { users: readUsers(j.legacy.users), dayBudget: readBudget(j.legacy.dayBudget) };
    }
  } catch (e) {
    log.debug(`好感度读取失败（当作空的）：${e.message}`);
    groups = new Map();
    legacy = { users: new Map(), dayBudget: { date: todayKey(), used: new Map() } };
  }
}

function save() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const byGroup = {};
    for (const [gid, b] of groups) {
      byGroup[gid] = {
        users: Object.fromEntries(b.users),
        dayBudget: { date: b.dayBudget.date, used: Object.fromEntries(b.dayBudget.used) },
      };
    }
    const tmp = `${FILE}.tmp`;
    // 原子写（`digest.js` 同款做法）
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          byGroup,
          // 老数据留着当兜底（**不删** —— 分群前挣的分不能凭空消失）
          legacy: {
            users: Object.fromEntries(legacy.users),
            dayBudget: { date: legacy.dayBudget.date, used: Object.fromEntries(legacy.dayBudget.used) },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    renameSync(tmp, FILE);
  } catch (e) {
    log.debug(`好感度写盘失败：${e.message}`);
  }
}

function clamp(n) {
  // ⚠️ 2026-09-20：**只保底、不封顶**（用户要求「上限修改为无限」）。
  //    🚫 别在这里加回 `Math.min(MAX_AFFINITY, …)` —— 那会把上限又夹回 100。
  return Math.max(MIN_AFFINITY, Math.round(Number(n) || 0));
}

function rollDay(gid) {
  const b = bucket(gid, true);
  const d = todayKey();
  if (b.dayBudget.date !== d) b.dayBudget = { date: d, used: new Map() };
  return b;
}

/** 花掉今天的额度（**按群各算各的**：在 A 群聊满了不妨碍 B 群） */
function spend(userId, amount, gid) {
  const b = rollDay(gid);
  const used = b.dayBudget.used.get(String(userId)) ?? 0;
  const left = Math.max(0, DAY_CAP - used);
  const can = Math.min(Math.abs(amount), left);
  if (can <= 0) return 0;
  b.dayBudget.used.set(String(userId), used + can);
  return can;
}

/**
 * 读某人在**某个群**里的好感度（没有记录就返回默认 50，**不写盘**）。
 *
 * ⚠️ 群桶里没有时**回退到分群前那份老数据** —— 这样分群不会让现有分数"凭空消失"。
 * @param {string|number} userId
 * @param {string} [groupId] 不给 = 「不知道哪个群」那个桶
 */
export function get(userId, groupId = '') {
  const id = String(userId);
  const e = bucket(groupId)?.users.get(id) ?? legacy.users.get(id);
  return e ? e.v : DEFAULT_AFFINITY;
}

/**
 * ⚠️ 排行榜的**口径已经改了**（2026-09-18 拍板）：
 *    原来是"先按最近变化取 10 个、再按分排"，现在改成**纯按分数从高到低**。
 *    实现见下面的 `top()` / `all()`（它们排在 `dailyLeft` **后面** ——
 *    因为 `dailyLeft` 是它们要用的，那个注释是后来插进来的，所以顺序看着有点乱）。
 */
/**
 * 今天还能给他加多少分（2026-09-17 要求：
 * 「好感度排行加一个**分群友每日达到上限状态**的提示」）。
 *
 * ⚠️ 为什么需要 —— <主人> 问「**喵喵三三为什么在好感度排行找不到了**」：
 *    她那个号 **82 分、是全群最高**，却不在榜上。查出来是两件事叠在一起：
 *      ① 榜单的规则是「先按**最近变化时间**取前 10 个人，再按分排序」；
 *      ② 她今天 **+8 的额度已经用完了**（16:00 那次「回应了她」用掉的），
 *         剧情结局要给她 +5 **加不进去** ⇒ `adjust()` 连**时间戳都不更新**
 *         ⇒ 她永远停在 7 小时前 ⇒ 永远排在第 12 位、永远被截掉。
 *
 *    所以榜上必须能看出「这个人今天加满了」，否则同一件事还会被问第二次。
 *
 * ⚠️ 减分**不占**这个额度（那是之前定的），所以"满了"只挡加分。
 *
 * @returns {number} 还剩多少（0 = 今天满了）
 */
export function dailyLeft(userId, groupId = '') {
  const b = bucket(groupId);
  if (!b) return DAY_CAP;
  if (b.dayBudget?.date !== todayKey()) return DAY_CAP; // 跨天了 → 又是满额
  const used = b.dayBudget?.used?.get(String(userId)) ?? 0;
  return Math.max(0, DAY_CAP - used);
}

/**
 * 排行榜用：**这个群里分数从高到低的前 n 个**。
 *
 * ⚠️⚠️ 口径是2026-09-18 改的：
 *   「还是把好感度排行改成**只按从高到低排序**吧，排前 10 个，
 *     再加个 `/全部好感度` 的指令，直接显示**全部好感度有变化过的**数据」
 *
 * ⚠️ 为什么把老口径（先按最近变化取 10 个、再按分排）废掉：
 *    它就是 2026-09-17 那次「**喵喵三三为什么在好感度排行找不到了**」的成因 ——
 *    她 82 分**全群最高**，但当天 +8 的额度用完了 → `adjust()` 连时间戳都不更新
 *    → 她永远卡在"最近变化"的第 12 位、永远被截掉。
 *    用户拍板：榜单就是**高分榜**；想看"还有哪些人有分"用 `/全部好感度`。
 *
 * ⚠️ 2026-09-15 晚：**按群**（只列这个群里的人，别的群的不掺进来）。
 *
 * @param {number} [n]
 * @param {string} [groupId]
 * @returns {Array<{userId:string, score:number, at:number, note?:string, left:number}>}
 */
export function top(n = 10, groupId = '') {
  return all(groupId).slice(0, Math.max(1, n));
}

/**
 * **这个群里所有"有过变化"的人**（分数从高到低）。
 *
 * ⚠️ 只有 `adjust()` 动过的人才在里面 —— 从没变过的人**没有记录**，
 *    不在这个列表里（他们还是默认的 50 分）。用户要的就是这个口径：
 *    「直接显示**全部好感度有变化过的**数据」。
 */
export function all(groupId = '') {
  const b = bucket(groupId);
  return [...(b?.users ?? new Map()).entries()]
    .map(([userId, e]) => ({
      userId,
      score: e.v,
      at: e.at,
      note: e.note,
      // ⚠️ 2026-11-03：剧情结局另存，界面上能和「印象」分开看（见 `setNote`）
      ending: e.ending,
 // ⚠️ 今天还剩多少加分额度（0 = 满了）—— 榜单要标出来（2026-09-17 要求）
      left: dailyLeft(userId, groupId),
    }))
    .sort((a, b2) => b2.score - a.score || a.at - b2.at);
}

/**
 * 某个群里已经到「可以加好友」那条线的人（≥ 阈值）。
 * ⚠️ 只返回列表，**要不要发通知、发过没有**由 `src/friend.js` 管。
 */
export function atOrAbove(threshold = 90, groupId = '') {
  const t = Number(threshold) || 90;
  const b = bucket(groupId);
  return [...(b?.users ?? new Map()).entries()]
    .filter(([, e]) => e.v >= t)
    .map(([userId, e]) => ({ userId, score: e.v, at: e.at }));
}

/** 有数据的群号（界面上做"看哪个群"的下拉框用） */
export function groupIds() {
  return [...groups.keys()].filter((g) => g).sort();
}

/**
 * 调好感度。
 *
 * @param {string|number} userId
 * @param {number} delta 想加/减多少（会被 `MAX_STEP` 和每日上限夹住）
 * @param {{note?:string, force?:boolean, groupId?:string}} [opts]
 *   `force:true` 绕过夹取（只有测试/人工修正该用）；`groupId` = **在哪个群**
 * @returns {{ok:boolean, from:number, to:number, applied:number, crossed?:boolean, reason?:string}}
 */
export function adjust(userId, delta, opts = {}) {
  const gid = gk(opts.groupId);
  if (!enabled()) {
    return { ok: false, from: get(userId, gid), to: get(userId, gid), applied: 0, reason: '好感度功能已关闭' };
  }
  const id = String(userId ?? '').trim();
  if (!id) return { ok: false, from: DEFAULT_AFFINITY, to: DEFAULT_AFFINITY, applied: 0, reason: '没有 userId' };

  const from = get(id, gid);
  let want = Number(delta) || 0;
  if (!want) return { ok: true, from, to: from, applied: 0 };

  // 单次幅度上限
  const capped = opts.force ? want : Math.sign(want) * Math.min(Math.abs(want), MAX_STEP);
  // 每天的总量上限（刷分保护）—— ⚠️ **按群各算各的**
  // ⚠️⚠️ 2026-09-17：**减分不占这个额度**。
  //    缘由是用户那句「有人骂她那肯定得减，而且减2，因为加上来很容易」——
  //    额度是防"刷分"的，减分不需要防；反倒是"今天已经和她聊满 8 分"的人
  //    再骂她就减不动了，那等于「先聊熟、再随便骂」，正好是最该扣分的情形。
  const allowed = opts.force || capped < 0 ? Math.abs(capped) : spend(id, capped, gid);
  const applied = Math.sign(capped) * allowed;
  const to = clamp(from + applied);

  if (to !== from || opts.force) {
    const b = bucket(gid, true);
    const prevE = b.users.get(id);
    b.users.set(id, {
      v: to,
      at: Date.now(),
      note: opts.note ? String(opts.note).slice(0, 60) : prevE?.note,
      // ⚠️ 见 `readUsers` 里那段说明：剧情结局走 `ending`，不再写 `note` ✓
      ending: opts.ending === 'good' || opts.ending === 'bad' ? opts.ending : prevE?.ending,
    });
    save();
  }
  log.debug(
    `[好感度] ${id}${gid ? `@群${gid}` : ''}: ${from} → ${to}（请求 ${delta > 0 ? '+' : ''}${delta}，实际 ${applied > 0 ? '+' : ''}${applied}）`,
  );
  // ⚠️ `crossed`：这次**刚刚越过**加好友那条线（之前没到、现在到了）。
  //    调用方（`src/friend.js`）靠它决定要不要发那个"到 90 了"的通知 ——
  //    必须是**越过**，不是 `>= 阈值`，否则每次加分都会重发一遍。
  const threshold = Number(config.affinity?.friendThreshold) || 90;
  const crossed = from < threshold && to >= threshold;
  return { ok: true, from, to, applied, crossed, groupId: gid };
}

/**
 * 给某人写一句「你对他的印象」（**只动 note，不碰分数**）。
 *
 * ⚠️⚠️ 2026-11-03 新增，修「saki 记不住人」：
 *    用户截图里群友 @ 她「还记得我不」，她只能答「你是哪个来着」。
 *    查下来是三层：群聊原文只留 1 小时/300 条（跨天全没）、
 *    好感度档案只有一个分数、`note` 又被剧情结局占着 ⇒
 *    她手里关于这个人的信息是**空的**，那句「不记得」其实是诚实。
 *
 *    ⇒ 现在 `note` 专门放"这人是谁 / 聊过什么"这一句话，由
 *      `bot.js` 的 `[工具:记住]` 在真的记下一件事时顺手写进来（不新开工具）。
 *
 * @param {string|number} userId
 * @param {string} note 一句话（超 60 字截断）
 * @param {string} [groupId]
 * @returns {{ok:boolean, reason?:string}}
 */
/* ══════════════════════════════════════════════════════════════════════
 * 「对某个人的印象」**合并进群资料库**（2026-11-06 定）
 *
 * 用户原话：「**印象不应该和群资料库的记忆方式一样吗**」
 *          「**直接合在一起啊，本来记得东西就差不多**」
 *
 * 原来印象存在 `affinity.json` 的 `note` 字段里，三个毛病：
 *   ① **只有 `[工具:记住]` 会写** ⇒ 平时基本是空的（实测 124 个群友、0 条印象）；
 *   ② 界面上看不见也改不了（要翻 json）；
 *   ③ 和群资料库（`knowledge/groups/<群号>.md`）是两套，两处维护。
 *
 * ⇒ 现在统一进群资料库的「## 群里的人」那节，格式和别的条目一样：
 *     - **名字**（uid）：这个人是干嘛的 / 聊过什么
 *   · knowledge 是**热重载**的，写完下一轮就能读到 ✓
 *   · 提到某人时 `promptLine()` 从 md 里**抽他那一行**注入 ⇒ 精准度不丢 ✓
 * ══════════════════════════════════════════════════════════════════════ */
const GROUP_NOTE_HEADING = '## 群里的人';

/** 群资料库路径（群号不合法 ⇒ 空串） */
function groupMdPath(groupId) {
  const gid = String(groupId ?? '').trim();
  if (!/^\d+$/.test(gid)) return '';
  return join(KNOWLEDGE_DIR, 'groups', `${gid}.md`);
}

/** 从群资料库里抽「这个人」那一行（没有 ⇒ 空串） */
export function readNote(userId, name, groupId = '') {
  const p = groupMdPath(groupId);
  if (!p || !existsSync(p)) return '';
  const nm = String(name ?? '').trim();
  const uid = String(userId ?? '').trim();
  if (!nm && !uid) return '';
  try {
    const lines = readFileSync(p, 'utf8').split(/\r?\n/);
    const i = lines.findIndex((l) => l.trim() === GROUP_NOTE_HEADING);
    if (i < 0) return '';
    for (let k = i + 1; k < lines.length; k++) {
      if (/^## /.test(lines[k])) break;
      const l = lines[k];
      if (!/^\s*[-*]\s/.test(l)) continue;
      const hitName = nm && l.includes(`**${nm}**`);
      const hitUid = uid && l.includes(`（${uid}）`);
      if (hitName || hitUid) {
        return l
          .replace(/^\s*[-*]\s*/, '')
          .replace(/^\*\*[^*]+\*\*\s*/, '')
          .replace(/^（\d+）\s*/, '')
          .replace(/^[:：]\s*/, '')
          .trim();
      }
    }
    return '';
  } catch (e) {
    log.debug(`读群资料库里的印象失败：${e.message}`);
    return '';
  }
}

/**
 * 写「对某个人的印象」→ **写进群资料库**（不再写 affinity.json 的 note）。
 *
 * @param {string|number} userId
 * @param {string} note 一句话（超 80 字截断）
 * @param {string} [groupId]
 * @param {string} [name] 显示名（不传就用 uid）
 * @returns {{ok:boolean, file?:string, replaced?:boolean, reason?:string}}
 */
export function setNote(userId, note, groupId = '', name = '') {
  const uid = String(userId ?? '').trim();
  const t = String(note ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (!uid) return { ok: false, reason: '没有 userId' };
  if (!t) return { ok: false, reason: '内容为空' };
  const p = groupMdPath(groupId);
  if (!p) return { ok: false, reason: '没有群号（印象只写进群资料库）' };
  const nm = String(name ?? '').trim() || uid;
  try {
    mkdirSync(join(KNOWLEDGE_DIR, 'groups'), { recursive: true });
    let lines = existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/) : [];

    // ① 新文件 ⇒ 起个头
    if (!lines.length) {
      lines = [`# 群 ${String(groupId)} 资料库`, '', '> 这个群自己的资料（只给这个群的对话用）。', '', GROUP_NOTE_HEADING, ''];
    }

    // ② 找「## 群里的人」节（没有就在文末开一节）
    let h = lines.findIndex((l) => l.trim() === GROUP_NOTE_HEADING);
    if (h < 0) {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push('', GROUP_NOTE_HEADING, '');
      h = lines.length - 1;
    }
    let end = lines.length;
    for (let k = h + 1; k < lines.length; k++) {
      if (/^## /.test(lines[k])) {
        end = k;
        break;
      }
    }

    // ③ 已有这人 ⇒ 替换那行；没有 ⇒ 加在节内最后一条之后
    const row = `- **${nm}**（${uid}）：${t}`;
    let replaced = false;
    for (let k = h + 1; k < end; k++) {
      if (!/^\s*[-*]\s/.test(lines[k])) continue;
      if (lines[k].includes(`**${nm}**`) || lines[k].includes(`（${uid}）`)) {
        lines[k] = row;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      let ins = h + 1;
      for (let k = h + 1; k < end; k++) if (lines[k].trim()) ins = k + 1;
      lines.splice(Math.min(ins, end), 0, row);
    }

    // ④ 原子写（knowledge 是热重载的，读到半截文件会崩）
    const tmp = `${p}.tmp-${process.pid}`;
    /* ⚠️ 标题和列表之间**必须有空行** —— 第一次实测就漏了（`## 群里的人` 紧贴 `- **…**`，
     *    markdown 里那样列表不会被识别成列表）✓ */
    const outText = lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(new RegExp(`(${GROUP_NOTE_HEADING})\\n(?!\\n)`), '$1\n\n')
      .trimEnd();
    writeFileSync(tmp, outText + '\n', 'utf8');
    renameSync(tmp, p);
    log.info(`印象写进群资料库：群 ${groupId} · ${nm}（${replaced ? '更新' : '新增'}）`);
    return { ok: true, file: `groups/${groupId}.md`, replaced };
  } catch (e) {
    log.warn(`写印象失败：${e.message}`);
    return { ok: false, reason: e.message };
  }
}

/**
 * 好感度在提示词里怎么给她看。
 *
 * ⚠️ 措辞直接决定她的行为，别乱改：
 *   · 必须**显式写明**「这只影响你对普通群友的距离感，
 *     不能改变你对 <主人> 的态度（那是最高的，见 relationship）」
 *   · 必须**禁止她说出来**（报好感度 = 像 galgame 数值面板，破坏真人感）
 *   · 必须**禁止她说出具体数字**（"我对你 73 分"这种非常出戏）
 *
 * @param {string|number} userId
 * @param {{isOwner?:boolean, name?:string}} [opts]
 * @returns {string} 空串 = 不注入（功能关了 / 服主不需要）
 */
export function promptLine(userId, opts = {}) {
  if (!enabled()) return '';
  // ⚠️⚠️ 服主**不注入**这一段 —— 见顶部铁律①。
  //    给他注入好感度等于让"私人评分"去和"特殊关系"打架，
  //    而用户明确说了那段关系优先级更高。所以直接不给他这份数据。
  if (opts.isOwner) return '';

  const id = String(userId ?? '').trim();
  if (!id) return '';
  const v = get(id, opts.groupId);
  const name = opts.name || '这个群友';
  // ⚠️ 2026-09-17 加了 90 这一档 —— 90 正好是"加好友"那条线（`friendThreshold`），
  //    所以这一档的语义是**已经是自己人**，不只是"好感度数字高"。
  const band =
    v >= 90
      ? '非常亲近（已经是熟人 / 朋友那种）'
      : v >= 80
        ? '很熟、挺喜欢跟他聊'
        : v >= 65
          ? '有好感'
          : v >= 40
            ? '普通'
            : v >= 20
              ? '有点不耐烦'
              : '很不想理';

  // ⚠️⚠️ 2026-11-03 新增：把 `note`（这人对她的既有印象）也给她看。
  //    原来这里**只给分数** —— 分数里没有任何"这人是谁"的信息 ⇒
  //    她隔天再碰到同一个人，只剩「54 分，普通」，只能答「你是哪个来着」
  //    （用户截图那次就是这么来的）。`note` 现在专放这件事（见 `setNote`）。
  /* ⚠️ 2026-11-06 改：印象**从群资料库读**（`knowledge/groups/<群号>.md` 的「## 群里的人」），
   *    不再读 affinity.json 的 `note` —— 两套合并成一套了（见 `setNote` 上面那段）。
   *    ⚠️ 匹配靠名字：`opts.name` 是调用方从 `sender.card / nickname` 拿的真名 ✓
   */
  let note = '';
  try {
    note = readNote(id, opts.name, opts.groupId);
  } catch {
    note = '';
  }

  return [
    '## 你对这个人的好感度（私人印象，**别说出来**）',
    '',
    `你对 **${name}** 的好感度：**${v}**（${band}）`,
    '',
    // ⚠️ 有印象才插，没有就一个字都不多说（空 `note` 是常态 ——
    //    只被 `[工具:记住]` 写过才有内容，别让模型以为"必须有印象"）
    ...(note
      ? [
          `你对这个人的**既有印象**：${note}`,
          '（这是你自己以前记下的。他要是问"还记得我不"、或者提到相关的事，',
          '  **就照这个自然地接上**；但别念出来、别说"我记着你的档案"。）',
          '',
        ]
      : []),
    '- ⚠️⚠️ **绝对不许说出数字、也不许提"好感度"这个词** ——',
    '  那是游戏面板，说出来一秒出戏。它只影响你的**语气松紧**：',
    '  · 高（≥65）→ 会主动接话、愿意多聊两句、开得起玩笑',
    '  · 中（40~64）→ 正常客服，礼貌里带点距离',
    '  · 低（<40）→ 更短、更淡，不主动搭理（但**该答的还是答**）',
    '- ⚠️⚠️ **它管不到 <主人>** —— 你对 <主人> 的态度由 `relationship` 那套决定，',
    '  **优先级高于好感度**。就算哪天他在这儿的分很低，你也还是那样跟他说话。',
    '- ⚠️ 别因为好感度低就不好好回答 —— 你是客服，**该给的答案要给**，',
    '  只是语气冷一点。',
 // ⚠️ 2026-09-17 要求：「**当好感度到 90 以上，就不用推开宝宝这种称呼了**」。
    //    缘由（<主人> 截图）：群友引用她的话说「谁让你是我宝宝」，
    //    她回「……你少来这套。明天记得提醒我买药就行，别的不用记这么清（」——
    //    90 正是"加好友"那条线（`friendThreshold`），到这儿的已经是**自己人**了，
    //    还用对陌生人的那套推开，就显得没心没肺。
    v >= 90
      ? [
          '- ⚠️⚠️ **这个人已经过了加好友那条线（90）—— 他是熟人，不是"群友"了**：',
          '  · 他叫你亲昵的称呼（宝宝、亲爱的、宝、老婆…）→ **别推开、别嫌弃**；',
          '    可以嘴硬一下、可以不好意思，但**不能一口回绝**（那是陌生人才有的反应）。',
          '  · 也**别突然变腻**：你的人设是外柔内刚 —— 接住了就是接住了，不用反过来叫他。',
          '  · ✅ 大概这个味道：「……随你吧」「少来（但没真生气）」「就这一次啊」。',
        ].join('\n')
      : '',
  ].join('\n');
}

/** 给管理界面/自检看。给了群号 = 那个群的明细；不给 = 总览 + 每个群一行 */
export function status(groupId = '') {
  const one = (gid) => {
    const b = bucket(gid);
    const list = [...(b?.users ?? new Map()).entries()].map(([id, e]) => ({ userId: id, v: e.v, at: e.at, note: e.note }));
    list.sort((a, b2) => b2.v - a.v);
    return {
      enable: enabled(),
      default: DEFAULT_AFFINITY,
      range: [MIN_AFFINITY, null], // ⚠️ 2026-09-20：上限改无限 → 对外用 null 表示"不封顶"
      groupId: gid,
      tracked: b?.users.size ?? 0,
      users: list,
      todayUsed: Object.fromEntries(b?.dayBudget?.used ?? []),
    };
  };
  if (gk(groupId)) return one(gk(groupId));
  const byGroup = [...groups.entries()]
    .filter(([g]) => g)
    .map(([g, b]) => ({ groupId: g, tracked: b.users.size }))
    .sort((a, b2) => b2.tracked - a.tracked);
  return {
    ...one(''),
    /** 每个群各有多少人在记（界面显示"好感度也分群了"） */
    byGroup,
    /** 分群之前那份老数据还剩多少人（已经尽量归属到各群了） */
    legacyTracked: legacy.users.size,
  };
}

/** 测试用：不给群号 = 全清 */
export function __clear(groupId) {
  if (gk(groupId)) {
    groups.delete(gk(groupId));
  } else {
    groups = new Map();
    legacy = { users: new Map(), dayBudget: { date: todayKey(), used: new Map() } };
  }
  save();
}

// ⚠️ 模块加载时就恢复（和 `tic.js` / `qzone.js` 同一个做法）
reload();
