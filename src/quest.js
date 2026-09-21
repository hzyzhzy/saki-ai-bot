/**
 * 二级剧情（quest）—— 「能改变世界线的关键事件」。
 *
 * ## 它和一级事件的关系
 *
 * 一级是**一个点**（今天午饭被偷了），二级是**一个面**（像游戏里的任务，分阶段）。
 * 每到一个"该发事件"的点，先掷一次骰子：`quest.chance`（默认一成）走二级、
 * 其余走一级。所以一级:二级 ≈ 9:1 —— 而这恰好也把二级压到每周 2-3 个
 * （一级每天 3-5 条 × 一成 ≈ 每周 2-3 个），跟定好的节奏天然吻合。
 *
 * ## ⚠️⚠️ 两条结构性约束（用户 2026-09-15 拍板）
 *
 * · **全局同时只跑 1 个**（`current` 只有一个）。多个剧情并行会互相打架、群友也看不过来。
 * · **全部落盘**（`state/quest.json`）。剧情可能跨几小时，而这号**每几小时就被踢一次**
 *   （实测 09-13 / 09-14 各 6 次），不落盘一掉线剧情就断了。
 *
 * ## ⚠️ 引擎是「纯状态机 + 注入依赖」
 *
 * 所有需要外部世界的东西都从参数进来：
 *   · `ask(messages) -> string`  —— 调模型（生产用 streamChat，模拟面板用假的）
 *   · `replies`                  —— 这一阶段群友说了什么（模拟面板直接塞）
 *   · `now()`                    —— 时间（测试要能拨）
 * **不在这里直接发消息、不直接读 bot** —— 只有这样，WebUI 的"剧情模拟测试"
 * 才能用**同一个引擎**跑，而不是另写一套必定会漂移的。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT, paramsFor } from './config.js';
import { log } from './log.js';
import { personaText, castRosterBrief, personaDataFile } from './knowledge.js';
import * as storyline from './storyline.js';
// ⚠️ 2026-09-21：剧情提示词里的名字从 `identity` 来（原来写死「祥子」「客服小祥」）——
//    换人设后剧情那段还在说旧名字，等于"人换了、剧本没换"。
import * as persona from './persona.js';

const STATE_FILE = process.env.QQBOT_QUEST_FILE
  ? join(ROOT, process.env.QQBOT_QUEST_FILE)
  : join(ROOT, 'state', 'quest.json');

export const MAX_STAGES = 10;
export const BEST_STAGES = 3;

/**
 * 群里"够热情"的默认门槛（2026-09-17 用户要求）。
 *
 * 用户原话：「如果出现**群友非常热情**的情况，**段数太少的情况下可以自动增加 2-3 段**，
 *   然后**缩短等待推下一段时间**」。
 *
 * ⚠️ 为什么真需要：模型自己定的 `plannedStages` 常常很短 —— 实测 2026-09-17 那条
 *    只计划了 **2 段**，而群里那会儿已经回了 **12 条**。按 2 段就收掉，太可惜了，
 *    而且群友正聊得起劲。
 */
export const WARM_COUNT = 4;
/** 热情时最多多演几段 */
export const WARM_EXTRA_STAGES = 3;

/**
 * 数一下这一批回应有多热。
 *
 * ⚠️ 只看**条数**，不要求"人多"：实际群里经常是**一个人特别起劲**
 *    （2026-09-17 那条就是「喵喵三三」连着引用、接话好几条），
 *    要求 ≥2 人会把这种最典型的热情漏掉。人数只记下来放日志/界面看。
 *
 * @param {Array<{userId?:string}>} list
 * @returns {{count:number, people:number}}
 */
export function warmthOf(list) {
  const arr = Array.isArray(list) ? list : [];
  const people = new Set(arr.map((x) => String(x?.userId ?? '')).filter(Boolean));
  return { count: arr.length, people: people.size };
}

/**
 * **某个群**的二级剧情参数（全局 `config.quest` + `groupParams["<群号>"].quest` 的覆盖）。
 *
 * ⚠️⚠️ 2026-09-16：界面上能按群设概率/每周上限/每段等待/段数/好感度增减 ——
 *    所以模块内部**一律走这个**，别再直接读 `config.quest`（读了就等于没分群）。
 */
export function params(groupId) {
  return cfgFor(groupId);
}

const cfg = () => config.quest ?? {};
/**
 * ⚠️ **某个群的** quest 参数（全局那套 + 这个群的覆盖项）。
 * 用户要求（2026-09-15）：「参数也可以分群设定」—— 见 `config.paramsFor()`。
 * 不给群号（空/undefined）就是纯全局。
 */
const cfgFor = (groupId) => paramsFor('quest', groupId);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ─────────────────────────────────────────────────────────────
// 阶段数：最佳 3，其他指数下降
// ─────────────────────────────────────────────────────────────

/**
 * 各阶段数的权重：`decay^|n-3|`。
 *
 * 用户原话：「阶段数可以 llm 自定，但是**不超过 10 段，最佳为 3 段，
 * 其他段数几率指数下降**」。
 *
 * ⚠️ 所以"几率指数下降"是**代码控制的**，不是指望模型自愿 ——
 *    模型天然爱写长。这里算出目标段数再告诉模型，模型可以更早收但不能超过上限。
 */
export function stageWeights(decay = 0.45) {
  const out = [];
  for (let n = 1; n <= MAX_STAGES; n++) out.push({ n, w: Math.pow(decay, Math.abs(n - BEST_STAGES)) });
  return out;
}

/** 按上面的分布抽一个阶段数（`rng` 可注入，测试用） */
export function pickStageCount(rng = Math.random) {
  const ws = stageWeights();
  const total = ws.reduce((s, x) => s + x.w, 0);
  let r = rng() * total;
  for (const x of ws) {
    r -= x.w;
    if (r <= 0) return x.n;
  }
  return BEST_STAGES;
}

// ─────────────────────────────────────────────────────────────
// 题材：别每条剧情都发生在排练室
// ─────────────────────────────────────────────────────────────

/**
 * 这一次剧情的**题材**。
 *
 * ⚠️⚠️ 用户反馈（2026-09-15）：「二级剧情和其他人的事大部分都是乐队的事，
 *    可以加一点日常，要不然有点单调」。
 *
 * 为什么**由代码掷骰子指定**、而不是在提示词里写一句"请均衡一点"：
 *   模型天然会顺着**上下文**走 —— 而上下文（人设 + `cast.md` 名册 + 最近的故事线）
 *   里乐队的人最显眼，所以它每次都往排练室/后台写。
 *   写一句"请均衡"是没用的，**得从外面把题材定下来**。
 *
 * 权重故意偏日常：日常 5 / 乐队 3 / 学校 2 / 家里 2 / 外面的人 2
 * → **乐队只占 ~21%**，跟"乐队只是她生活的一部分"对得上。
 */
export const QUEST_TOPICS = [
  {
    key: 'daily',
    w: 5,
    label: '日常',
    dirs: '打工、钱、吃饭、住处、身体、天气、跑腿、网上刷到的东西、一个人待着的时候',
  },
  {
    key: 'school',
    w: 2,
    label: '学校',
    dirs: '上课、小测、补课、社团、学园祭、同学、老师、升学的事',
  },
  {
    key: 'home',
    w: 2,
    label: '家里',
    dirs: persona.promptText('questHomeDirs'),
  },
  {
    key: 'outsider',
    w: 2,
    label: '外面的人',
    dirs: '打工的同事和客人、房东邻居、便利店店员、乐器行、路上碰到的人',
  },
  {
    key: 'band',
    w: 3,
    label: '乐队',
    dirs: '排练、演出、后台、同台的人、网上的评论、成员之间的摩擦',
  },
];

/** 按权重抽一个题材（`rng` 可注入，测试用） */
export function pickTopic(rng = Math.random) {
  const total = QUEST_TOPICS.reduce((s, x) => s + x.w, 0);
  let r = rng() * total;
  for (const x of QUEST_TOPICS) {
    r -= x.w;
    if (r <= 0) return x;
  }
  return QUEST_TOPICS[0];
}

// ─────────────────────────────────────────────────────────────
// 状态
// ─────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ 2026-09-15 **分群**（<主人>：「一个群设一个故事线知识库……剧情每个群各跑一条」）。
 *
 * `byGroup["<群号>"]` 各自一个 `{current, recent, starts}` ——
 * 每个群是**独立的一条世界线**，可以**同时各跑一条**剧情。
 * ⚠️ 原来那条「全局同时只 1 条」的规矩没作废，只是**把粒度下放到群**：
 *    同一个群里仍然只允许 1 条（两条并行必然互相打架），但 A 群和 B 群互不干扰。
 *
 * ⚠️ `''`（空键）= 「**没指定群**」那个桶 —— 模拟面板和老测试用它，
 *    真实调用**必须**传 `groupId`。
 * ⚠️ `nextHint`（「替换下次二级事件」）**也按群存**（2026-09-15 晚改，见下面的说明）：
 *    桶里那个 `byGroup[gid].nextHint` 是主力；顶层这个 `nextHint` 只当**全局兜底**。
 *
 * @type {{byGroup: Record<string,{current:object|null,recent:Array,starts:number[],nextHint?:string}>, nextHint:string}}
 */
let st = { byGroup: {}, nextHint: '' };
const stats = { started: 0, ended: 0, advanced: 0, lastError: '' };

/** 群号统一成字符串键 */
const gk = (groupId) => String(groupId ?? '').trim();

/** 拿一个群的桶（`create` = 没有就建一个空的） */
function gbucket(groupId, create = false) {
  const k = gk(groupId);
  let b = st.byGroup[k];
  if (!b && create) {
    b = { current: null, recent: [], starts: [] };
    st.byGroup = { ...st.byGroup, [k]: b };
  }
  return b ?? null;
}

/** 改一个群的桶（没建就按默认建） */
function setBucket(groupId, patch) {
  const k = gk(groupId);
  const cur = st.byGroup[k] ?? { current: null, recent: [], starts: [] };
  const next = { ...cur, ...patch };
  st.byGroup = { ...st.byGroup, [k]: next };
  return next;
}

/** 有剧情在跑的群（定时器要挨个推） */
export function runningGroups() {
  return Object.entries(st.byGroup)
    .filter(([, b]) => b?.current && !b.current.endedAt)
    .map(([gid]) => gid);
}

/**
 * ⚠️⚠️ 沙箱（给 WebUI 的「剧情模拟测试」用，2026-09-15 加）。
 *
 * 模拟必须做到三件事，一件都不能漏：
 *   ① **不落盘**（不能把模拟的剧情写进真实的 `state/quest.json`）
 *   ② **不碰真实状态**（`current` / `starts` 不能被它改掉 —— 用 `swapState()` 换掉）
 *   ③ **不写真实故事线**，但**要收集起来**给界面展示
 *      （用户要求：「展示此次全部模拟写下的故事线」）
 *
 * 所以这里是"收集"而不是"丢弃"：`sandbox.entries` 就是这次模拟写下的故事线条目。
 */
let sandbox = null;

/**
 * 开关沙箱。返回**上一个值**，方便恢复。
 * ⚠️ 用 `try/finally` 恢复 —— 中间抛错也必须退出来，
 *    否则机器人会一直停在沙箱里（不落盘、不写故事线），那是最糟的失败模式。
 */
export function setSandbox(on) {
  const prev = sandbox;
  sandbox = on ? { entries: [] } : null;
  return prev;
}

/** 沙箱里收集到的故事线（不在沙箱里就是空数组） */
export function sandboxLog() {
  return sandbox?.entries ?? [];
}

/** 写故事线：沙箱里只收集，不落真实文件 */
function noteStory(e) {
  if (sandbox) {
    sandbox.entries.push({
      at: e.at ?? Date.now(),
      tier: e.tier ?? 1,
      text: String(e.text ?? ''),
      tags: e.tags ?? [],
      // ⚠️ 沙箱里也记着是哪个群 —— 界面要按群展示（分群之后）
      groupId: String(e.groupId ?? ''),
    });
    return;
  }
  try {
    storyline.note(e);
  } catch (err) {
    log.debug(`写故事线失败：${err.message}`);
  }
}

/**
 * 换掉内部状态（给模拟面板用）。返回**原来的**状态，调用方负责换回来。
 *
 * 模拟面板的用法：
 * ```js
 * const old = quest.swapState({ current: null, recent: [], starts: [], nextHint: '' });
 * const off = quest.setSandbox(true);
 * try { ...跑模拟... } finally { quest.setSandbox(off); quest.swapState(old); }
 * ```
 */
export function swapState(next) {
  const prev = st;
  const n = next ?? {};
  // ⚠️ 兼容两种形状：老的 `{current,recent,starts}`（模拟面板/老测试直接传这个）
  //    和新的按群形状。老形状落到 `''`（"没指定群"）那个桶里。
  if ('current' in n || 'recent' in n || 'starts' in n) {
    st = {
      byGroup: {
        '': { current: n.current ?? null, recent: n.recent ?? [], starts: n.starts ?? [] },
      },
      nextHint: String(n.nextHint ?? ''),
    };
  } else {
    st = {
      byGroup: { ...(n.byGroup ?? {}) },
      nextHint: String(n.nextHint ?? ''),
    };
  }
  return prev;
}

// ── 「替换下次二级事件」：存一句自定义由头，下次自动开剧情时优先用它 ──
//
// ⚠️⚠️ 2026-09-15 晚改：**按群各存各的**。
//    <主人> 原话：「最好也加个群选择…**因为每个群的故事线不一样**」——
//    原来整个机器人只有一份 `st.nextHint`：你在界面上填一句，**哪个群**下次自动开剧情都用它，
//    可这句由头是照着某个群的故事线写的，塞到别的群里就完全不对味。
//    现在存进那个群的桶（`byGroup[gid].nextHint`）。
//    ⚠️ `st.nextHint` 那份**留着当全局兜底**（老状态文件、老测试、以及"没给群号"那条路都还用它）。

/**
 * 存下某个群"下次二级事件"的自定义内容。
 * @param {string} text 空字符串 = 取消
 * @param {string} [groupId] 不给 = 那份**全局兜底**（老用法）
 * @returns {string} 规范化之后存下的内容
 */
export function setNextHint(text, groupId = '') {
  const v = String(text ?? '').trim().slice(0, 600);
  const k = gk(groupId);
  if (!k) {
    st.nextHint = v;
  } else {
    setBucket(k, { nextHint: v });
  }
  save();
  return v;
}

/**
 * 看某个群存着的那句由头（**取走之前**）。
 * ⚠️ 兜底顺序：这个群自己的 → 全局那份 —— 老状态里存的那句不至于突然失效。
 */
export function nextHint(groupId = '') {
  const k = gk(groupId);
  if (!k) return st.nextHint ?? '';
  const mine = gbucket(k)?.nextHint ?? '';
  return mine || (st.nextHint ?? '');
}

/** 取走（用一次就清 —— 否则每次开剧情都用同一句） */
export function takeNextHint(groupId = '') {
  const h = nextHint(groupId);
  if (!h) return '';
  const k = gk(groupId);
  if (k && gbucket(k)?.nextHint) setBucket(k, { nextHint: '' });
  else st.nextHint = '';
  save();
  return h;
}

/** 每个群各存了什么（界面要显示"这个群的下次二级事件"；空群号那份也带上） */
export function hintsByGroup() {
  const out = {};
  for (const [gid, b] of Object.entries(st.byGroup ?? {})) {
    if (b?.nextHint) out[gid] = String(b.nextHint);
  }
  if (st.nextHint) out[''] = String(st.nextHint);
  return out;
}

function load() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));

    // 新形状：{ byGroup: { "<群号>": {current,recent,starts,nextHint} }, nextHint }
    if (j?.byGroup && typeof j.byGroup === 'object') {
      const byGroup = {};
      for (const [gid, b] of Object.entries(j.byGroup)) {
        byGroup[String(gid)] = {
          current: b?.current ?? null,
          recent: Array.isArray(b?.recent) ? b.recent.slice(-10) : [],
          starts: Array.isArray(b?.starts) ? b.starts.map(Number).filter(Boolean).slice(-40) : [],
          // ⚠️⚠️ 按群的那句"下次二级事件"**必须带上** ——
          //    这个循环是白名单式的重建，漏一个字段就等于重启丢数据（2026-09-15 晚加）。
          nextHint: String(b?.nextHint ?? ''),
        };
      }
      st = { byGroup, nextHint: String(j?.nextHint ?? '') };
      return;
    }

    // ⚠️ 旧形状（分群之前：顶层直接 current/recent/starts）——
    //    按 <主人>「先删除，还在测试中」的要求**不再续用**，只在日志里说一声。
    if ('current' in (j ?? {}) || Array.isArray(j?.recent)) {
      log.warn('[剧情] 读到**分群之前**的旧状态 —— 按 <主人> 的要求不再使用（下次开剧情就是新的）');
    }
    st = { byGroup: {}, nextHint: String(j?.nextHint ?? '') };
  } catch (e) {
    log.debug(`剧情状态读取失败（当作空的）：${e.message}`);
  }
}

function save() {
  // ⚠️ 沙箱里绝不落盘 —— 模拟的剧情不能写进真实的 state/quest.json
  if (sandbox) return;
  try {
    mkdirSync(join(ROOT, 'state'), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.warn(`剧情状态写盘失败：${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 限额
// ─────────────────────────────────────────────────────────────

/**
 * 某个群滚动 7 天内开了几个（⚠️ 用滚动窗口，不是"自然周" —— 免得周一瞬间能开 3 个）。
 * ⚠️ 分群之后**按群各算各的**。
 */
export function weeklyCount(now = Date.now(), groupId = '') {
  const week = 7 * 24 * 3600 * 1000;
  return (gbucket(groupId)?.starts ?? []).filter((t) => now - t < week).length;
}

/**
 * 现在这个群里能不能开一个新的。
 *
 * @param {number} [now]
 * @param {{manual?:boolean, groupId?:string|number}} [opts]
 *   ⚠️ `manual: true` = **人在界面上主动点的**（「立即开始剧情」）。
 *      手动不受"总开关"和"每周上限"限制 —— 见下面。
 *   ⚠️ `groupId` **分群之后必给**（不给就落到"没指定群"那个桶，老测试用）。
 *
 * ⚠️⚠️ 总开关的语义（2026-09-15 用户要求「先加个开关，剧情先多测试几条再正式启用」）：
 *    `enable` 管的是「**自动**开剧情」（一级事件掷骰子那条线）。
 *    **手动开 + 模拟面板不受它影响** —— 不然"关着的时候想测一条"就测不了，
 *    而这个开关存在的意义恰恰是"先多测几条"。
 *
 * ⚠️⚠️ 「同时只 1 条」**分群之后是按群算的**（<主人> 2026-09-15：「每个群各跑一条」）：
 *    同一个群里仍然只允许 1 条（两条并行必然互相打架），
 *    但 A 群和 B 群是两条独立的世界线，互不干扰。
 */
export function canStart(now = Date.now(), opts = {}) {
  const manual = opts.manual === true;
  const gid = gk(opts.groupId);
  if (!manual && cfgFor(gid).enable !== true) {
    return { ok: false, reason: '二级剧情的自动开关是关的（界面上可以手动开一条来测）' };
  }
  const b = gbucket(gid);
  if (b?.current && !b.current.endedAt) {
    return {
      ok: false,
      reason: gid ? `群 ${gid} 已经有一条剧情在跑了（同一个群只允许 1 条）` : '已经有一条剧情在跑了（同时只允许 1 条）',
    };
  }
  // 手动测试不受每周上限限制 —— 不然"最近 7 天跑了 3 条"会挡住第 4 次调试
  if (!manual) {
    const max = Math.max(1, num(cfgFor(gid).maxPerWeek, 3));
    const used = weeklyCount(now, gid);
    if (used >= max) {
      return {
        ok: false,
        reason: gid
          ? `这个群最近 7 天已经跑了 ${used} 条（上限 ${max}）`
          : `最近 7 天已经跑了 ${used} 条（上限 ${max}）`,
      };
    }
  }
  return { ok: true, reason: '' };
}

// ─────────────────────────────────────────────────────────────
// 谁能改变剧情（见下面 `isPlotReply` 的三档说明）
// ─────────────────────────────────────────────────────────────

/**
 * 这条群消息算不算「能改变剧情」的。
 *
 * @param {{segs?:Array, text?:string, selfId?:string, herIds?:string[]}} p
 *   `herIds` = 祥子最近发过的 message_id（用来认"回复她"）
 */
/**
 * ① 明确的「提议 / 劝阻 / 让人去做点什么」—— 最硬的一档。
 *
 * ⚠️ 2026-09-15 放宽（<主人> 截图反馈）：那句
 *    「**你看看里面是什么东西了吗**」被判成了"闲聊" —— 这不合理：
 *    那是在**追问她**，她会因此去翻那个包，剧情就拐弯了。
 *    所以补进了 `看看 / 看一下 / 查一下 / 报警 / 小心 / 去找` 这类**动作动词**。
 */
const SUGGEST_RE =
  /(应该|不该|不如|要不|建议|可以试|试试|换一个|换个|别这样|你最好|我觉得你|要不你|其实可以|下次.{0,6}吧|这样吧|要不要|赶紧|小心|注意|当心|报警|看一下|看看|查一下|问一下|检查一下|翻一下|打开|确认一下|去找|去问|别去|别一个人)/;

/**
 * ② 这是个**问句**吗？—— 追问会推着剧情走。
 *
 * ⚠️ 2026-09-15 放宽过程（两次，都是 <主人> 反馈推着改的）：
 *    一开始要求"含'你' + 有问号"，实测漏掉了两种很常见的问法：
 *      · 「那你怎么处理的」   —— 中文里问句**经常不打问号**
 *      · 「这个包会不会有炸弹啊」—— 没提"你"，但明显是在聊这件事
 *    所以现在不要求"你"，也不要求问号：**有疑问词就算**。
 *    （真正的闲聊实测还是进不来：「哈哈哈哈这也太惨了」「草」都不含疑问词。）
 */
const QUESTION_RE =
  /[？?]|(吗|呢)\s*$|(怎么|为什么|为啥|如何|什么|哪|谁|多少|会不会|是不是|有没有|能不能|可不可以|该不该|要不要)/;

function looksLikeQuestion(text) {
  return QUESTION_RE.test(String(text ?? '').trim());
}

/**
 * ③ 纯起哄 / 纯笑 —— 放宽到最松也不许算数。
 *
 * ⚠️ 用**开头判定**，不要求整句都是笑声（2026-09-15 修）：
 *    原来写的是 `^(哈+|…)$`，整句必须全是"哈"才算 ——
 *    于是「**哈哈哈哈这也太惨了**」在 loose 档漏了进去。
 *    它明显是起哄，不是剧情输入。
 */
const NOISE_RE = /^([哈呵嘿嘻]{2,}|草|笑死|6{3,}|牛|卧槽|我去|绝了|太惨了?)/;

/**
 * 这条群消息算不算「能改变剧情」的。
 *
 * ⚠️ 用户拍板的判定（只在**阶段边界**判，不是每句都调模型）：
 *    只认 **@她 / 回复她的消息 / 明显是建议的句子**。
 *
 * ⚠️ 2026-09-15 加了 **`replyMode` 三档**（<主人>：「标准再放宽一点」）——
 *    与其每次找我改，不如给他一个旋钮：
 *
 * | 档 | 算数的 |
 * | --- | --- |
 * | `strict` | 只认 @她 / 回她 / 明显的建议 |
 * | `normal`（默认） | 上面 + **任何问句**（追问、猜、问她怎么处理，都算） |
 * | `loose` | 上面 + **群里任何 6 字以上、不是纯起哄**的发言 |
 *
 * @param {{segs?:Array, text?:string, selfId?:string, herIds?:string[], mode?:string, groupId?:string}} p
 *   `herIds` = 祥子最近发过的 message_id（用来认"回复她"）
 *   `groupId` = 哪个群（`replyMode` 也能按群覆盖）
 */
export function isPlotReply(p = {}) {
  const segs = Array.isArray(p.segs) ? p.segs : [];
  const text = String(p.text ?? '').trim();
  if (!text) return { hit: false, why: '空' };

  // ① 永远是硬判据：@她 / 回她 —— 跟档位无关，再严的档也认
  if (segs.some((s) => s.type === 'at' && String(s.data?.qq) === String(p.selfId ?? ''))) {
    return { hit: true, why: 'at' };
  }
  const herIds = (p.herIds ?? []).map(String);
  if (herIds.length && segs.some((s) => s.type === 'reply' && herIds.includes(String(s.data?.id)))) {
    return { hit: true, why: 'reply' };
  }

  // ② 明显的建议 / 动作动词 —— 三档都算
  if (SUGGEST_RE.test(text)) return { hit: true, why: 'suggest' };

  // ⚠️ `replyMode` 也能按群覆盖（2026-09-16 分群之后）
  const mode = String(p.mode ?? cfgFor(p.groupId).replyMode ?? 'normal');

  // ③ 问句（normal 起算）—— 追问、猜、问"那你怎么处理的"都算
  if (mode !== 'strict' && looksLikeQuestion(text)) return { hit: true, why: 'question' };

  // ④ 最松：有内容的闲聊也算（但纯起哄永远不算）
  if (mode === 'loose' && text.length >= 6 && !NOISE_RE.test(text)) {
    return { hit: true, why: 'loose' };
  }

  return { hit: false, why: '闲聊' };
}

// ─────────────────────────────────────────────────────────────
// 提示词
// ─────────────────────────────────────────────────────────────

/**
 * 题材素材池 —— 从 `knowledge/quest-ideas.md` **现读**（2026-09-18 用户要求「挪吧」）。
 *
 * ⚠️ 为什么不写死在提示词里：用户要**自己往里加素材**
 *    （「现在只能手动往里加，重复剧情会很奇怪」「再多加多加」）。
 *    放到外面那个文件，他直接改就行，而且**不用重启机器人** ——
 *    这里每次都重新读盘（一周才开 3 次剧情，读文件的成本可以忽略）。
 */
function questIdeas() {
  try {
    // ⚠️ 2026-09-21：素材池也搬进人设包了（剧情点子是**角色专属**的）。
    const p = personaDataFile('quest-ideas.md');
    if (!existsSync(p)) return '';
    const t = readFileSync(p, 'utf8').trim();
    return t ? `\n\n# 剧情素材池（挑一条改一改就用，别照抄、别连着用同一类）\n\n${t}` : '';
  } catch (e) {
    log.debug(`剧情素材池读取失败（这次不拼）：${e.message}`);
    return '';
  }
}

const QUEST_SYSTEM = `你在给一个角色扮演机器人**编一条主线剧情**（不是日常闲聊）。

⚠️ 这是「二级事件」—— 要能**改变这条世界线**的关键事件，不是今天午饭吃什么。

硬规矩：

1b. ⚠️ **题材要够分量** —— 2026-09-17 用户要求：「**剧情还可以再爆点，毕竟几率很小**」。
   · 他说的前提是真的：这条剧情**一周最多开 3 次**，而且每次都是掷骰子
     （chance 一成）命中才开，还**会顶掉一条日常事件**。所以题材配不上这个额度，
     就等于白占了一周三次里的一个坑。
   · ✅ 该往这些方向挑（都在她的生活半径里，不用超自然就已经够狠）：
     **跟人的关系急转**（误会、站队、说错话、被瞒着、当面被下不来台）、
     **过去找上门**（${persona.promptText('questPastThreads')}）、
     **工作上的难堪**（被换班 / 被客人刁难 / 同事之间的事）、
     **意外**（丢了要紧的东西、赶不上、撞见不该看的）。
   · 🎬⚠️ **多借社区二创的味道**（2026-09-18 用户点名要求：
     「剧情还是有点枯燥」「多参考一点 **B 站上的二创**，mygo 和 avemujica
     能这么火一大半都得靠社区的二创」）。二创真正抓人的是这几样，照着学：
     · **关系里的"刺"**：嘴上不认、背地里在意；一句玩笑正好戳到旧伤；
     · **群像**：别老她一个人扛 —— 让**别人**之间也有戏（谁跟谁站一边、谁在中间难做）；
     · **身份反差**：把"客服${persona.shortName()}"这个身份玩起来（工位、单子、同事、刁难的客人
       ↔ 她原本的出身和教养）；这是**只有她这个设定才有的**素材；
     · **If / 平行感**：某件旧事**换个走向**重演一次（但她自己要意识到"这次不一样"）；
     · **小事失控**：一件很小的事，因为她的性子被推到收不了场。
   · 📚 **题材素材池在你后面那一段**（标题是「剧情素材池」，一百来条，按类别分好了）——
     从里面**挑一条**改一改就写，别照抄；一条剧情**只挑一条**，别把几条缝在一起。
     用完一类就换一类（重复的剧情很难看）。
   · 🚫⚠️ **同一个套路不许连着来**（2026-09-18 用户原话：
     「我模拟剧情的时候看到**好几次**她们合租的房子要被卖掉了」）：
     上面"你最近在这个群里讲过的事"里出现过的**同一类麻烦**，这次**必须换一类**。
     **尤其「住处 / 房租 / 房子要被卖掉 / 被赶出去」这一路，短期内不许再用第二次。**
   · 🚫 **别写成日常琐事**：买菜、做饭、下雨没带伞、谁顺手拿了外卖 ——
     这种留给一级事件（日常）就够了，**不值得占一周三次的额度**。
   · ⚠️ 但"爆"≠ 乱来：**不要超自然、不要车祸 / 绝症 / 失忆、不要跟原作设定打架**
     （见下面"不要魔法"那条）。
   · ⚠️ **也别写成卖惨** —— 她的基调是**遇到事就继续去做、硬扛**，语气平淡里带刺，
     不是哭诉。真出事的时候她反而更冷静，这个反差才是她的味道。
   · ⚠️ **一次只炸一件事**：丢钱 + 被辞 + 被撞堆在一段里，一眼就是编的。

1. **视角是${persona.narrativeName()}**（第一人称）。发到群里的那句话是**她自己在说**，
   像随手在群里说一句，不是写小说、不是旁白、**不要括号动作描写**。
   ⚠️ 但"视角是${persona.narrativeName()}"**不等于只有她一个人** —— 见第 3 条。
   ⚠️⚠️ **每一条都要让人看懂「来龙去脉」**（<主人> 2026-09-15 原话：
   「主要是**她转述剧情的话要有来龙去脉**」）：
   · 群里有人**没看到上一段**（也可能刚进群、或者上一段被刷过去了），
     所以这一段**不能从半截开始** —— 先用**一句由头**交代清楚：
     这件事在追什么、为什么跟她有关、上一段进行到哪了；
   · 然后再讲**这一步的新进展**；
   · 读起来要像"她把一件事的来龙去脉讲给群里听"，**不是"从中间截了一句"**。
   🚫 但也**别把前几段复述一遍**（那是流水账）—— 由头**一句带过**就行。
   · 篇幅：**2-4 句**（比日常事件长一点没关系，这一条得自己把事讲清楚）。
2. ⚠️⚠️ **收信人永远是群友**（<主人> 2026-09-15 反馈，这条最容易错）：
   「text」是她在**群里**说的话，**听的人是群里这些人**。
   · 故事里的那些人（${persona.promptText('castNames')}、素世…）是**她在跟群友讲的事里的人**，
     **不是她说话的对象**。她是**转述**给他们听的，不是当着他们面讲话。
   · 🚫 所以**千万别写成她给队友下命令、派活、安排任务** ——
     那种句子在群里读起来就是"${persona.narrativeName()}在指挥自己队友"，收信人错了
     （真实踩过：她冒出一句让两个队友各自交东西给她，群友看着莫名其妙）。
   · ✅ 该写的是**对群友说**的话：出了什么事、她怎么看、她打算怎么办、
     或者一句自嘲。要提队友就用转述（"我让他们…"那种口气），别直接吆喝他们。
   · ⚠️ 群里**没有**人在跟她演这场戏 —— 群友只看到她一个人在说话。
     所以不能出现"只有故事里的人能接上的对话"（比如对着队友说"你先坐下"）。
3. ⚠️⚠️ **她不是一个人活着的人，每一段都必须有别人在场或被卷进来。**
   （在场、找上门、打电话、消息里出现，都算。）
   · 同团那几个人（${persona.promptText('castNames')}）最常用；
   · ⚠️ **但"日常里的人"一样常用** —— 客服室的同事和组长、同学老师、房东邻居、
     便利店店员、乐器行老板、网上刷到的人。**每天用的次数不该比乐队少。**
   · ${persona.promptText('questOtherGroups')}；
   · 老团前辈罕见，而且**必须有由头**（同台、后台、乐器行、学园祭、网上）。
   · 「event」那一句里要写清**在场的是谁、发生了什么**；
   · ⚠️ 别整段只有她一个人在心里想 —— 那是独白，不是剧情。
   · ⚠️ 只能用**上面名册里真有的人名**，别造新角色，别把名字写错。
     （名册里写"身份"的那些就写身份，别自己给他们起名字。）
   · 关系和称呼**以人设里那张表为准**：别自己编交情，也别把认识的人写成陌生人。
4. ⚠️ **不要一次讲完。** 这是一条**分阶段**的长剧情，这一次只写**当前这一段**，
   把后面留给下一段（群友可能会插话改变走向）。
5. **起因必须有来路** —— 从给你的"最近的故事线"里找由头，别凭空冒出一个大事件。
   可以是小事滚大（被缠上、帮了个人结果那人不简单、跟队友闹了个别扭），但**别离谱**
   （不要魔法、不要突然出现超自然设定、不要跟原作设定打架）。
6. 基调：**她不诉苦**。遇到事就是继续去做、硬扛，语气平淡里带刺、偶尔自嘲。
6b. ⚠️⚠️ **每一段都要有"事情在变"的感觉，中后段更是 —— 不是只有开头爆**
   （2026-09-17 用户要求「可以加点意外转折」；2026-09-18 又补：
    「剧情推进的时候还有点平淡，**不是只有开头很爆，转折的时候也要爆**」）。
   · 每写一段先问自己：**这一段跟上一段比，什么变了？**
     关系变了 / 事情的性质变了 / 她的处境变了 / 有人的立场翻了 —— 至少得变一样。
   · ⚠️ **中间那几段最容易水**（开头有冲击、结尾有收束，中间最容易写成"她又去处理了一下"）——
     那一段就是不合格的：**中段必须出转折**，哪怕小一点，也要让群友看出"事态变了"。
   · 转折要**落在现实里**：误会、时间来不及、东西坏了、人临时变卦、本来答应的事黄了、
     她自己判断错了一次 —— 这些都行。
   · 🚫 不要超自然、不要失忆 / 车祸 / 绝症、不要冒出原作里没有的设定（见上面"不要魔法"那条）。
   · ⚠️ **别为了转折而转折**：它得能**把这件事往前推**、或者**改变她和某个人的关系**；
     单纯吓一跳然后什么都没变，读起来就是凑字数。
   · ⚠️ 但一段里**只放一个**转折，落在这一段靠后的位置最好 —— 正好勾着群友想接下一句。
6c. ⚠️⚠️ **群友说的话要真的算数**（2026-09-18 用户要求：
   「让群友能感受到**自己真的参与进了剧情**」）。
   · 上面给你的【这一阶段群里说的话】**不是背景音** —— 下一段里必须看得出
     哪一句**真的起了作用**（她改了主意 / 多了一个人 / 事情因此转向）。
   · 群友**猜错**也可以算数：她照着他的猜测去做，结果真出事了 —— 那也是他推的。
   · 🚫 最忌"群友说了 A，下一段完全没提" —— 那他就白参与了，下次就不看了。
   · 但也**别当复读机**：不是把他那句话原样回一遍，是让它**改变后来发生的事**。
6d. ⚠️⚠️ **绝不许编"具体的凭证"，也不许靠它推进剧情**（2026-09-18 用户截图报的）：
   · 真实事故：剧情走到"得打个电话"，她就在群里报了「**13876432901**，快打」——
     那号码是**编的**，而 11 位手机号**很可能对应真人** ✗（发群里 = 让人去骚扰真人）。
   · 🚫 **手机号 / 微信号 / 地址 / 门牌号 / 订单号 / 快递单 / 银行卡 / 身份证** ——
     一个都不许编；也**不许把"拿到号码"当成剧情的关键一步**（那会逼着你编一个出来）。
   · ✅ 需要联系谁，就写「**我私下发你**」「**这个不方便在群里说**」「你自己去问她」——
     照样能把剧情推下去，而且不会编出真实信息。
   · ✅ 这一条对**任何角色**都成立（${persona.promptText('castNames')}）：别给他们编联系方式。

7. 🚫 不要破折号、不要 markdown、不要书名号。标点只用：。 ， ？ ！ ……


8. 🚫 **同上：别承诺发文件、发录音、拍视频** —— 她手上**只有文字、表情包、图片**
   （⚠️ 2026-09-18 改：**她现在能"听懂"语音了** —— 群友发语音，系统会用 QQ 官方的
     语音转文字把它变成文字给她，所以**别再对语音装聋**；但**她自己一样发不出**
     音频 / 视频 / 文件，别答应「给你发条语音」这种话）。
8. 只输出要求的 JSON，不要解释、不要代码围栏。`;

/** 阶段越往后，"该收了"的压力越大（用户要求：>3 段后逐级加重，但不能生硬） */
export function endPressure(stageIndex, plannedStages = BEST_STAGES, extra = 0) {
  const parts = [];
  // ⚠️ 2026-09-17：`extra` = 因为"群里热情"而**加演**的段数 —— 把"该收了"那道坎
  //    整体往后挪。不挪的话，模型一边被这里催着收、一边被 `warmHint` 叫着继续，
  //    会写出精神分裂的段落（我们压住 done 也救不回那段文本）。
  const best = BEST_STAGES + extra;
  const plan = plannedStages + extra;
  const over = stageIndex - best;
  if (over <= 0) {
    if (stageIndex >= plan) {
      parts.push(`计划就是 ${plannedStages} 段，现在到第 ${stageIndex} 段了 —— 如果剧情自然，就该收了。`);
    }
    return parts.join('\n');
  }
  if (over === 1) {
    parts.push(`⚠️ 已经 ${best + 1} 段了，**接下来一两段内应该收尾**。收得自然一点，别突然截断。`);
  } else if (over === 2) {
    parts.push(`⚠️⚠️ ${best + 2} 段了，**这一段之后就该给出结局**。`);
  } else {
    parts.push('⚠️⚠️⚠️ 已经拖得够长了，**这一段必须是最后一段**，必须给一个结局（done 设成 true）。');
  }
  if (stageIndex >= plan) {
    parts.push(`（计划 ${plannedStages} 段，已经超了 —— 别再拖。）`);
  }
  return parts.join('\n');
}

/**
 * 群里热情时给模型的提示（2026-09-17 用户要求）。
 *
 * ⚠️ 真正管用的是**生成前就告诉它别收**（这一条），而不是事后把 `done` 按回去：
 *    那样模型已经把这一段**写成收尾**了，我们再硬说"没收"，剧情会断在那儿。
 *    代码层那处兜底只在模型没听的时候救一次。
 */
export function warmHint(q, next = 0) {
  const w = q?.warmth;
  if (!w?.warm) return '';
  const used = Number(q?.extraStages ?? 0);
  // ⚠️⚠️ 2026-09-17 修（<主人> 截图：「**已经 6/5 了，什么时候发剧情总结**」）：
  //    已经**超出计划段数**时，这里必须**闭嘴** ——
  //    否则它跟 `endPressure` 那句「这一段必须是最后一段」**直接打架**，
  //    而模型实测会听这句"先别收" ⇒ 剧情永远不收尾、**结局播报也永远发不出来**
  //    （用户就是这么被卡在 6/5 的）。
  const willWrite = Number(next) > 0 ? Number(next) : Number(q?.stageIndex ?? 0) + 1;
  if (willWrite > Number(q?.plannedStages ?? 0)) return '';
  return [
    '',
    `🔥 **这个群特别热情**（上一段有 ${w.count} 条回应、${w.people} 个人接话）——`,
    used > 0
      ? `已经为你**加演了 ${used} 段**，接着自然往下写就行，别硬凑，也别急着收。`
      : '**这一段先别收**，顺着他们的话往下演，让他们有得接。',
    '⚠️ 但**别为了长而长**：真走到头了就大方收，收的时候给足反应的时间，别一句话带过。',
    '💡 加演出来的段落**最怕原地打转** —— 每一段都得有**新东西**：',
    '   一个意外转折、一条被揭开的信息、或者某个人改了主意（用户要求：「可以加点意外转折」）。',
  ].join('\n');
}

/**
 * 群里热情 → **把计划段数真的涨上去**（2026-09-17 用户要求）。
 *
 * 用户原话：「如果出现群友非常热情的情况，**段数太少的情况下可以自动增加 2-3 段**」，
 * 后来专门澄清了一句：**「我是说计划段数」**。
 *
 * ⚠️ 这一句很关键 —— 我第一版只在内部把"该收了"的坎往后挪，**没动 `plannedStages`**，
 *    结果 webui 上永远显示「计划 2 段」，用户以为没生效。他要的是**看得见**：
 *    「计划 2 段 → 5 段」。
 *
 * ⚠️ 只加**一次**（`warmBumped`）：不加这道闸的话，每推进一段都会再 +3，永远收不了。
 * ⚠️ 涨不过 `MAX_STAGES`（10）—— 那是硬上限。
 *
 * @param {object} q 剧情（会被就地修改）
 * @returns {number} 实际加了几段（0 = 没加）
 */
export function bumpPlanned(q) {
  if (!q?.warmth?.warm || q.warmBumped) return 0;
  const now = Number(q.plannedStages ?? 0) || 0;
  const add = Math.min(WARM_EXTRA_STAGES, Math.max(0, MAX_STAGES - now));
  if (add <= 0) return 0;
  q.plannedStages = now + add;
  q.warmBumped = true;
  log.info(
    `[剧情] 群 ${q.groupId} 够热情（${q.warmth.count} 条 / ${q.warmth.people} 人）` +
      `→ 计划段数 ${now} → ${q.plannedStages}（+${add}）`,
  );
  return add;
}

/**
 * 给**聊天**用的剧情摘要（2026-09-17 修）。
 *
 * ⚠️ 修的是什么：<主人> 拿截图报「群友问『@saki 找到药了吗』，她答『什么药啊，你哪不舒服了』」
 *    —— 她**根本不知道自己在演什么**。上一段她刚说过"这会儿我在给她翻药箱"。
 *
 *    查下来：二级剧情的接线一直是**单向**的（群友的话 → 记进剧情），
 *    **从来没有反过来把剧情注入她的聊天提示词**。所以群友顺着剧情追问时，她一脸茫然。
 *    重启之后尤其明显 —— `recent` 一空，她连自己刚发的那段都看不到了。
 *
 * ⚠️ 只给**摘要**（起因 + 进度 + 最近两段），别把整条塞进提示词：
 *    提示词越长，"中间那些规则被漏掉"的风险越大（这个项目为此专门把铁律放在两头）。
 *
 * @param {string|number} groupId
 * @returns {string} 空串 = 这个群没有在跑的剧情
 */
/**
 * 「他在你正讲的这件事里做过什么」（2026-09-17 用户要求）。
 *
 * 用户原话：「我觉得**在查人时应该也要特别查一下故事线**，可行吗」。
 *
 * ⚠️ 缘由（他拿截图报的）：群里问「@saki 喵喵三三是谁」，
 *    而那个人**刚在这条剧情里说了十几句话**（`pending` 里全是他的发言），
 *    她的回答却是「就刚发啧那个，别的我也不熟」——
 *    既没翻到群资料，也完全没用上剧情里刚发生的事。
 *
 * ⚠️ 数据现成的：`pending`（攒着还没消化的发言）和 `stages[].replies`（各段收到的回复）
 *    都带 `name` / `userId`，不用额外存。
 *
 * @param {string} text 群友说的话
 * @param {string} groupId
 * @returns {string} 空串 = 这条消息没提到剧情里的参与者
 */
export function whoInQuest(text, groupId = '') {
  const t = String(text ?? '');
  const q = current(groupId);
  if (!t || !q || q.endedAt) return '';

  // 把这条剧情里出现过的人名收起来（攒着的 + 各段收到的）
  const byName = new Map();
  const push = (name, said) => {
    const n = String(name ?? '').trim();
    const s = String(said ?? '').trim();
    if (!n || !s) return;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(s.slice(0, 60));
  };
  for (const x of q.pending ?? []) push(x.name, x.text);
  for (const st of q.stages ?? []) for (const r of st.replies ?? []) push(r.name, r.text);

  const hits = [...byName.entries()].filter(([name]) => t.includes(name));
  if (!hits.length) return '';
  const lines = hits
    .slice(0, 3)
    .map(([name, said]) => `- **${name}**：${said.slice(-3).map((s) => `「${s}」`).join('　')}`);

  return [
    `## 🎬 你正讲的这件事里，「${hits.map(([n]) => n).join('、')}」是参与的人`,
    '',
    ...lines,
    '',
    '⚠️ 他**不是陌生人** —— 你们刚一起经过了这件事，你说得出他当时说了什么。',
    '⚠️ 但**别把这段当剧情正文往下讲**：现在是在**回答群友的提问**，一两句带过就行。',
  ].join('\n');
}

export function briefFor(groupId = '') {
  const q = current(groupId);
  if (!q || q.endedAt) return '';
  const now = Date.now();
  /** 相对时间：让摘要里每一段都带"多久以前"，别让她把过去当成现在 */
  const ago = (at) => {
    const d = now - Number(at ?? 0);
    if (!Number.isFinite(d) || d < 0) return '';
    const min = Math.round(d / 60000);
    if (min < 2) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.round(h / 24)} 天前`;
  };
  // ⚠️⚠️ 2026-09-18 改（用户截图：<主人> 问「你不是说去菜场那边看看吗」，
  //    她回「**我哪说去菜场了**……哦，你说她买菜那事」—— 把自己讲过的话
  //    推给了"那件事里的另一个人"）。
  //    根因：这里原来只带**最近 2 段**，而剧情有 8 段、每段隔 30 分钟 ——
  //    4 小时前那句"去菜场看看"早就掉出窗口了，她是**真的不记得**（不是不在乎）。
  //    现在带**最近 5 段**，每段截 160 字（防止把提示词撑爆）。
  const recent = (q.stages ?? [])
    .slice(-5)
    .map((s) => ({ at: s?.at ?? 0, text: String(s?.text ?? '').trim().slice(0, 160) }))
    .filter((s) => s.text);
  return [
    '## 📖 你最近在这个群里讲过的一件事',
    `起因：${q.premise}`,
    `进度：第 ${q.stageIndex} 段，计划 ${q.plannedStages} 段`,
    recent.length
      // ⚠️⚠️ 2026-09-18 改措辞（用户截图：<主人> 问「你不是说去菜场那边看看吗」，
      //    她答「**我哪说去菜场了**……哦，你说她买菜那事」）。
      //    根因就在这几个字：原来写的是「你**之前**在这个群里讲过（**不是现在**）」——
      //    对模型来说，这等于把这些内容**降级成"陈年旧事"**；再叠上下面那句
      //    "按现在这一刻答，别拿几小时前那句话当挡箭牌"，它就干脆**否认**了 ✗
      //    其实这些**就是她自己打的字** —— 得先把这一点说死，**再**说时间。
      ? `**你在这个群里讲过的话**（下面每一句都是**你自己打的字**）：${recent
          .map((s) => `「${s.text}」${ago(s.at) ? `（${ago(s.at)}）` : ''}`)
          .join('　')}`
      : '',
    '',
    // ⚠️⚠️ 2026-09-17 <主人> 报的（原话：「如果剧情出现**去吃饭**这种时间事件，
    //    祥子会**一直处于要去吃饭的状态**，而且有人叫她去吃饭她**可能又会一起吃**」）：
    //    根因就是上面那行原来**只给内容、不给时间** ⇒ 她以为剧情里那句"我去吃饭了"
    //    是**此刻**发生的事，于是整个人卡在那个状态里；别人再叫她吃饭，她又答应一次。
    '⚠️⚠️ 上面那些是**过去某个时刻**讲的（括号里就是多久以前）—— 把两件事分清：',
    '   · **"是什么时候发生的"**：那是过去的事，别当成此刻正在发生 ——',
    '     剧情里说了"去吃饭"，**不等于你现在还要去吃饭**；有人现在叫你吃饭，那是新的一件事，正常答应；',
    '   · **"是不是你说过的"**：先**照着上面看**（2026-09-18 用户截图就栽在这儿）：',
    '     · 上面**有** → 那确实是**你自己打的字**，认下来，**别**说「我哪说过」；',
    '     · 上面**没有**（这里只列了最近几段，更早的没带上）→ 别急着认，也**别**直接否认：',
    '       说清你**实际说的**是哪个说法，或者说「我再想想」「我翻一下记录」；',
    '     🚫 **两头都不许**：既**不许否认自己说过的话**，也**不许认下自己没说过的话**（那是另一种编）。',
    '     ⚠️ 另外：群友转述你的话**经常记岔**（那天就把"地铁口"说成了"菜场"）——',
    '       对不上的时候，把你**原话**再讲一遍就行，别顺着他的说法点头。',
    '',
    '⚠️ 群友可能**顺着这件事追问**（「后来呢」「找到了吗」「那个谁怎么样了」）——',
    '那是在问你刚讲的事，**不是新话题**。接着讲，别装不知道，也别把它当成别人的事。',
    '',
    // ⚠️⚠️ 2026-09-17 <主人> 截图报的：「**把群友当成剧情中出现的人了**」——
    //    一个群友发完表情，她引用那张图回了句剧情里的台词
    //    （「不好意思就直说啊，塞两份饭转身就跑算什么（」），
    //    等于把那个群友当成了剧情里"塞饭的人"。
    //    根因：这一段只说"你在讲一件事 + 群友在追问"，**没说清群里的人是谁**。
    //    剧情那边的 system prompt 有"收信人永远是群友"那条，聊天这边没有 ⇒ 补上。
    '⚠️⚠️ **但群里这些人不是那件事里的人**：',
    '   · 你是**在群里跟大家讲**你生活里发生的事，群友是**听你讲的人**，不是故事里的角色；',
    '   · 群里谁说了什么、发了什么表情，那都是"群友在跟你说话"，',
    '     **别把它当成那件事里某个人的台词或行为**；',
    `   · 那件事里的人（${persona.promptText('castNames')}）**不在这个群里**，你提到他们时是在**转述**。`,
    '⚠️ 但**别主动把后面的发展抖出来**（你自己也不知道会怎么走），也别在别的群提这件事。',
    '',
    // ⚠️⚠️ 2026-09-18 加（用户截图报的，就是上面那条根因的另一半）：
    //    <主人> 问「你不是说去菜场那边看看吗」，她答「我哪说去菜场了……哦，你说**她**买菜那事」——
    //    **把自己讲过的话推给了"那件事里的另一个人"**。
    //    所以这里钉死：上面「你之前在这个群里讲过」里的，**都是你说的话**。
    '⚠️⚠️ **上面「你之前在这个群里讲过」的那些，就是你说过的话**（是你自己打的字）：',
    '   · 群友拿里面的细节来问你（「你不是说要去 XX 看看吗」），**那是你说的 —— 认下来**；',
    '     **不许**回「我哪说过」，更**不许**把它推给"那件事里的某个人"（说成"是她去的""是她在弄"）；',
    '   · 上面只列了一部分段落，更早的你可能真想不起来了 ——',
    '     那就**别否认**：说「我再想想」「翻一下记录」都比"我没说过"强。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 她自己**在群里顺口接过的话**（不是剧情分段）。
 *
 * ⚠️ 2026-09-15 晚加：<主人>「机器人已经答应了的话，应该要计入剧情发展」。
 *    她答应过的事（「客房留给我」）= 已经发生的事实，下一段必须接着它写，
 *    不能又写回"还在发愁怎么办"。所以这里明确告诉模型：**这些话算数。**
 */
function interludeBlock(quest) {
  const list = (quest?.interludes ?? []).slice(-8);
  if (!list.length) return '';
  return `【她自己在群里顺口说过的话】（**这些也算数** —— 她已经说出口的立场/答应的事，
   这一段要跟它一致，别写出跟它矛盾的内容）
${list.map((x) => `  · ${x.text}`).join('\n')}`;
}

/** 之前几段发生过什么（正序，给模型看的） */
function stagesBlock(quest) {
  if (!quest?.stages?.length) return '（这是第一段，还没有前情）';
  return quest.stages
    .map((s) => {
      const who = s.replies?.length ? `\n    群里说了：${s.replies.map((r) => `${r.name}「${r.text}」`).join('；')}` : '';
      return `  第 ${s.i} 段：${s.event || s.text}${who}`;
    })
    .join('\n');
}

/**
 * 把模型给的话收拾成**一条群消息**。
 *
 * ⚠️ 2026-09-15 加：实测模型有时会在句子中间换行，直接发到群里就是断行的，
 *    很难看（而且主聊天那条路有一堆标点/分行处理，剧情这条没有）。
 *    这里只做最小归一化：换行 → 空格、压掉多余空白。
 */
function chatLine(s) {
  return String(s ?? '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parseJson(raw) {
  let t = String(raw ?? '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(t.slice(i, j + 1));
  } catch {
    return null;
  }
}

/**
 * 拼这个调用用的 system。
 *
 * ⚠️ 2026-09-15：**把出场人物名册拼进来**。用户反馈
 *    「故事几乎全部都是祥子一个人的」—— 原提示词第一句是「只写祥子这条线」，
 *    而 system 里除了人设**没有任何人名可参考**，模型只能保守地写成独白。
 *    名册只给"档名 + 频率基调 + 人名"，不带每个人的详细说明（那会涨好几千字）。
 */
function buildSystem(extra = '') {
  let persona = '';
  try {
    persona = personaText();
  } catch {}
  let cast = '';
  try {
    cast = castRosterBrief();
  } catch {}
  return [
    persona,
    cast ? `# 出场人物名册（编剧情时只能用这里有的名字）\n\n${cast}` : '',
    QUEST_SYSTEM,
    // ⚠️ 素材池**现读现拼**（2026-09-18 挪到 knowledge/quest-ideas.md：
    //    用户要自己加素材，放文件里他直接改就行，而且**不用重启**）
    questIdeas(),
    extra,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

// ─────────────────────────────────────────────────────────────
// 开一条剧情
// ─────────────────────────────────────────────────────────────

/**
 * 记一条"群友说的话"（等下一阶段开始时一起喂给模型）。
 *
 * ⚠️ 为什么要**先攒着**、而不是每来一句就生成一段：
 *    · 用户拍板「只在**阶段边界**判」—— 每句都调模型太贵、也太吵
 *    · 群友经常连着说好几句，攒着一起看，模型才看得懂完整意思
 * ⚠️ 攒在 `quest.pending` 里并**落盘** —— 掉线/重启不能把群友说过的话弄丢。
 */
export function noteReply(quest, { userId = '', name = '', text = '', at = Date.now(), why = '' } = {}) {
  if (!quest || quest.endedAt) return false;
  const t = String(text ?? '').trim();
  if (!t) return false;
  // ⚠️ 2026-09-17 加 `why`（用户要求：「这个等下一段的状态可以细化一点，**分开推进剧情的和闲聊的**」）。
  //    判据是 `isPlotReply()` 早就算出来的，原来**没往这儿带** —— 于是界面上四条全标"等下一段"，
  //    里面混着"我感觉和真人聊天好累""包的"这种纯闲聊。
  quest.pending = [
    ...(quest.pending ?? []),
    {
      userId: String(userId),
      name: String(name || userId || '群友'),
      text: t.slice(0, 200),
      at,
      why: String(why || ''),
    },
  ].slice(-12);
  save();
  return true;
}

/**
 * ⚠️⚠️ 她在剧情群里**顺口接的话**（不是剧情分段）—— 记成"插曲"。
 *
 * 为什么需要它（2026-09-15 晚 <主人> 拿截图反馈：
 *   「**机器人已经答应了的话，应该要计入剧情发展**」）：
 *
 *   截图里那条剧情的走向是"房东要卖房、她和初华得搬家"，群主接了一句
 *   「搬我们家吧」，她**当场就答应了**（「……你倒是敢说。客房留给我，别后悔」）。
 *   但这句答应的话**哪儿都没记** —— 于是下一段剧情（最多等 30 分钟后生成）
 *   完全不知道她已经答应了，很可能又写回"还在发愁找房子"，看着就像换了个人。
 *
 *   所以：① 她自己这句话进 `quest.interludes`，`advance()` 会把它喂给模型
 *        （见那里的「她自己在群里说过的话」那一段）；
 *        ② 同时写一条故事线（tier 1 / 插曲），剧情跑完之后这段记忆也还在。
 *
 * @param {object} quest
 * @param {{text?:string, at?:number}} p
 * @returns {boolean} 记下了没有（太短/空/剧情已结束 → false）
 */
export function noteInterlude(quest, { text = '', at = Date.now() } = {}) {
  if (!quest || quest.endedAt) return false;
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  // 太短的（「嗯」「草」「？」）不算"接话" —— 记进去只会污染下一段的提示词
  if (t.length < 4) return false;
  // 同一句连着记（分条发出去的两段偶尔会一样）就跳过
  const last = (quest.interludes ?? []).slice(-1)[0];
  if (last && last.text === t && at - Number(last.at ?? 0) < 60 * 1000) return false;
  quest.interludes = [...(quest.interludes ?? []), { at, text: t.slice(0, 200) }].slice(-20);
  noteStory({
    tier: 1,
    imp: 2,
    text: `她说：${t.slice(0, 160)}`,
    tags: ['剧情', '插曲'],
    at,
    questId: quest.id,
    stage: quest.stageIndex ?? 0,
    groupId: quest.groupId,
  });
  save();
  return true;
}

/**
 * 还没被消化掉的群友发言。
 * ⚠️ 分群之后要指定是哪个群（不给就 = "没指定群"那个桶，老测试用）。
 */
export function pendingCount(groupId = '') {
  return (gbucket(groupId)?.current?.pending ?? []).length;
}

/**
 * 开始一条二级剧情。
 *
 * @param {{ask:Function, now?:Function, extraHint?:string, rng?:Function,
 *          groupId?:string, manual?:boolean}} p
 *   ⚠️ `manual: true` = **人在界面上主动点的**（「立即开始剧情」/ 模拟面板）。
 *      必须一路传到 `canStart()` —— 否则总开关关着的时候，
 *      界面先用自己的 `manual` 检查放行了，`begin()` 里**又按自动规则拒一次**，
 *      结果"关着也能测"变成空话（2026-09-15 真踩了这个：<主人> 反馈
 *      「现在自动生成剧情用不了，得开剧情自动开关」）。
 * @returns {Promise<{ok:boolean, reason?:string, quest?:object, text?:string, event?:string}>}
 */
export async function begin(p = {}) {
  const now = p.now ?? (() => Date.now());
  const t0 = now();
  const can = canStart(t0, { manual: p.manual === true, groupId: p.groupId });
  if (!can.ok) return { ok: false, reason: can.reason };
  if (typeof p.ask !== 'function') return { ok: false, reason: '没给 ask（调模型的函数）' };

  const planned = pickStageCount(p.rng ?? Math.random);
  // ⚠️ 题材由**代码**定（见 QUEST_TOPICS 的注释）—— 不然每次都写排练室
  const topic = pickTopic(p.rng ?? Math.random);
  const recent = (() => {
    try {
      // ⚠️ **这个群自己的**故事线（分群之后必须分清，不然 A 群会看着 B 群的历史写）
      return storyline.promptBlock(18, p.groupId);
    } catch {
      return '';
    }
  })();

  // ── 上一条剧情是「坏结局」吗？是的话这一次就写成**挽回**────────────
  //
  // 用户原话（2026-09-15）：「我一开始是想坏结局要掉好感度的，然后
  // **下一个二级事件的开头可以直接参考坏结局剧情，就可以进行挽回了**」。
  //
  // ⚠️ 判据取自**这个群**的 `recent` 最后一条的 `ending`，**不去解析故事线文本** ——
  //    故事线会被压缩（锁定条目只许变短），拿文本当判据迟早失真。
  // ⚠️ 只看**最近 7 天**内结束的那条：隔了半个月再回头"挽回"很怪。
  const prevQuest = (gbucket(p.groupId)?.recent ?? []).slice(-1)[0] ?? null;
  const REDEEM_WINDOW_MS = 7 * 24 * 3600 * 1000;
  const redeemFrom =
    prevQuest &&
    prevQuest.ending === 'bad' &&
    t0 - Number(prevQuest.endedAt ?? prevQuest.startedAt ?? 0) <= REDEEM_WINDOW_MS
      ? prevQuest
      : null;

  const user = [
    '【最近的故事线】（**起因要从这里找由头**）',
    recent || '（还没有故事线，那就从一个很小的生活由头起头）',
    redeemFrom
      ? [
          '',
          '⚠️⚠️ **上一条主线是「坏结局」，这一次就是它的续章**：',
          `   上一次的起因是：${redeemFrom.premise}`,
          '   这次要写**她去挽回 / 收拾残局 / 把上次没说清的补上** ——',
          '   开场就要让人看出是接着那件事的，**别当成没发生过**，也别写成"什么都没变"。',
          '   ⚠️ 但**能不能挽回是群友说了算** —— 你别自己就把结局定成圆满。',
        ].join('\n')
      : '',
    p.extraHint ? `\n【额外要求】${p.extraHint}` : '',
    '',
    `【这一次的题材】偏「${topic.label}」 —— ${topic.dirs}`,
    topic.key === 'band'
      ? '⚠️ 这次可以是乐队的事 —— 但**别写成开会**，要有具体的人和具体的事。'
      : '⚠️ **这一次不要往乐队上写**（排练、演出、出道那些先放一放）。' +
        '她的生活里绝大部分时间根本不在排练室 —— 别每一条主线都发生在后台。',
    '',
    `【这次计划】总共约 ${planned} 段（${BEST_STAGES} 段最好；剧情自然更短就早收）。`,
    '这次只写**开头这一段**，后面留给下一次。',
    '⚠️ **开头这一段就要有人在场**（同团那四位优先，或者前队友），',
    '   起因最好就落在别人身上 —— 别写成她一个人的独白。',
    '⚠️ 但**别写成她对着那些人说话** —— 那些人是她**讲给群友听的事里的人**，',
    '   不是喊话的对象；也别写成给队友派活（见上面硬规矩第 2 条）。',
    '⚠️⚠️ **开场这一段就是"来龙去脉的由头"** —— 让人一眼看懂"这是什么、为什么跟她有关"。',
    '   后面每一段都会回头引用它，所以别写得云里雾里。',
    '',
    '【输出 JSON】',
    '{',
    '  "premise": "一句话说清这条线的起因（写进故事线用）",',
    '  "event": "这一段世界上发生了什么（一句话，写进故事线的事实）",',
    `  "text": "${persona.narrativeName()}在群里说的第一句（1-3 句，第一人称，随手说的口气）"`,
    '}',
  ]
    .filter(Boolean)
    .join('\n');

  let raw = '';
  try {
    raw = await p.ask([
      { role: 'system', content: buildSystem() },
      { role: 'user', content: user },
    ]);
  } catch (e) {
    stats.lastError = e.message;
    return { ok: false, reason: `开场生成失败：${e.message}` };
  }

  const j = parseJson(raw);
  const text = chatLine(j?.text) || chatLine(raw).slice(0, 200);
  if (!text) return { ok: false, reason: '模型没给出开场，放弃' };
  const event = String(j?.event ?? '').trim() || text;
  const premise = String(j?.premise ?? '').trim() || event;

  const quest = {
    id: `q-${t0}`,
    startedAt: t0,
    plannedStages: planned,
    /** 这条剧情的题材（`QUEST_TOPICS` 的 key）—— 续写时也要提醒，免得又飘回乐队 */
    topic: topic.key,
    topicLabel: topic.label,
    premise,
    stageIndex: 1,
    stages: [{ i: 1, at: t0, text, event, replies: [], auto: true }],
    awaitingSince: t0,
    autoContinues: 0,
    humanReplies: 0,
    cast: [],
    /**
     * ⚠️ 这条剧情**只在一个群里跑**（2026-09-15 定的）。
     *
     * 本来想发给所有 1 档群，但那样两个群会**同时看到同一条线、各自回话**，
     * 引擎就会把两条线的发言混在一起，剧情直接乱掉。
     * 一个跨几小时的故事，本来就该发生在一个群里。
     */
    groupId: String(p.groupId ?? ''),
    /** 攒着还没消化的群友发言（下一阶段开始时一起喂给模型） */
    pending: [],
    /**
     * 她在这个群里为这条剧情发出去的**消息 id**。
     * ⚠️ 「回复她」这条判据要靠它 —— OneBot 的 `reply` 段带的是**被回那条**的 id，
     *    拿不到这个列表就没法知道"被回的是不是她"。
     */
    herMsgIds: [],
    endedAt: 0,
    ending: null,
    endReason: '',
  };
  // ⚠️ 分群：写进**这个群自己的桶**（`quest.groupId`）
  setBucket(quest.groupId, {
    current: quest,
    starts: [...(gbucket(quest.groupId)?.starts ?? []), t0].slice(-40),
  });
  stats.started++;
  save();

  // 开场也进故事线（重要度拉满 → 锁定）
  noteStory({
    tier: 2,
    text: `【主线】${premise}`,
    tags: ['主线'],
    at: t0,
    questId: quest.id,
    stage: 1,
    groupId: quest.groupId,
  });
  log.info(`[剧情] 开始：${premise}（计划 ${planned} 段）`);
  return { ok: true, quest, text, event };
}

// ─────────────────────────────────────────────────────────────
// 推进一阶段
// ─────────────────────────────────────────────────────────────

/**
 * 强制某种结局时的额外要求（模拟面板要"好坏都看得到"）。
 *
 * ⚠️ 不是直接把状态改成 done 就完事 —— 那样只会得到一段**没写完的剧情**。
 *    要让它**照着这个结局写一段真正的收尾**，你才能看出"坏结局长什么样"。
 *
 * ⚠️⚠️ 2026-09-15 <主人> 改的口径：**结局可以写得狗血一点**。
 *    「我建议结局其实可以写得狗血一点，因为本来一开始我是想坏结局要掉好感度的，
 *      然后下一个二级事件的开头可以直接参考坏结局剧情，就可以进行挽回了。」
 *
 *    所以原来那句「**不要狗血**」「不要写成悲剧」**删掉了** ——
 *    现在坏结局要够狠，好结局也要有戏剧性。
 *    ⚠️ 只有一条底线不动：**不卖惨**（她不诉苦是整个人设的底子，见 persona.md）。
 *    「狗血」和「卖惨」是两回事：狗血是**事情**闹大了，卖惨是**她**在哭诉。
 */
export function endingForceHint(kind) {
  return kind === 'good'
    ? [
        '⚠️⚠️ **这一段必须是最后一段，而且必须是「好结局」**：事情被解决了，她扛过去了。',
        '⚠️ **可以写得有戏剧性一点，狗血也没关系** —— 该赶上的赶上、该说开的说开、',
        '   该谁出现的就出现。场面热闹、情绪到位都行。',
        '🚫 但**别升华、别写成心灵鸡汤**（"生活还是美好的"那类一律不要），',
        '   也别切到旁白抒情 —— 她**还是在群里说话**。done 填 true，ending 填 "good"。',
      ].join('')
    : [
        '⚠️⚠️ **这一段必须是最后一段，而且必须是「坏结局」**：事情没解决，甚至更糟。',
        '⚠️ **坏结局要够狠、够狗血**（误会、决裂、赶不上、说错话、来不及 —— 都可以），',
        '   要让群里的人看完想骂她两句。这是**故意的**：下一段剧情会接着它去挽回。',
        '🚫 只有一条底线不许破：**不卖惨** —— 她不自怨自艾、不哭诉、不解释自己多难。',
        '   硬撑着把话说完（或者干脆话很少），那个比哭更难受。',
        'done 填 true，ending 填 "bad"。',
      ].join('');
}

/**
 * 把剧情往前推一段。
 *
 * @param {object} quest
 * @param {{ask:Function, replies?:Array, now?:Function, auto?:boolean,
 *          forceEnd?:('good'|'bad')}} p
 *   `forceEnd`：**强制这一段收尾成指定结局**（模拟面板用，好让你两种结局都能看到）
 * @returns {Promise<{ok:boolean, reason?:string, text?:string, event?:string,
 *                    done?:boolean, ending?:('good'|'bad'|null), forced?:boolean}>}
 */
export async function advance(quest, p = {}) {
  const now = p.now ?? (() => Date.now());
  if (!quest) return { ok: false, reason: '没有剧情' };
  if (quest.endedAt) return { ok: false, reason: '这条已经结束了' };
  if (typeof p.ask !== 'function') return { ok: false, reason: '没给 ask' };

  const next = quest.stageIndex + 1;
  // ⚠️ 群友的话有两条来路：调用方直接给（模拟面板），或者引擎自己攒的（真群接线）。
  //    真群那边用 `noteReply()` 先攒着，这里统一一起消化，消完就清。
  const replies = (Array.isArray(p.replies) && p.replies.length
    ? p.replies
    : (quest.pending ?? [])
  ).slice(0, 12);
  quest.pending = [];
  // ⚠️ 2026-09-17 用户要求：群友非常热情时**自动加演 2~3 段、并缩短等下一段的时间**。
  //    热度必须**在这里**算 —— `pending` 上一行刚被清空，过后就没数据了。
  //    结果挂在 `quest.warmth` 上，`due()` 和 `warmHint()` / 下面那处兜底都读它。
  {
    const w = warmthOf(replies);
    const need = Math.max(1, num(cfgFor(quest.groupId).warmCount, WARM_COUNT));
    quest.warmth = { ...w, warm: w.count >= need, at: Date.now() };
    // ⚠️ 热情就把**计划段数真涨上去**（用户澄清过："我是说计划段数"）——
    //    只挪内部的坎是不够的，界面得看得见「2 段 → 5 段」。
    bumpPlanned(quest);
  }
  // 模拟面板点「强制好/坏结局」时走这条（好让你两种结局都能看到）
  const forceEnd = ['good', 'bad'].includes(String(p.forceEnd)) ? String(p.forceEnd) : null;
  // ⚠️ 是 `>=` 不是 `>`（2026-09-15 测试抓到的差一位）：
  //    `maxStages = 10` 的意思是"**最多 10 段**"，
  //    所以**正在写第 10 段的时候就已经是最后一段了**，必须强制收尾。
  //    写成 `>` 的话第 10 段不会被强制收，还能再往下写第 11 段。
  const limit = Math.min(MAX_STAGES, num(cfgFor(quest.groupId).maxStages, MAX_STAGES));
  const hardStop = next >= limit;

  const user = [
    `【这条主线的起因】${quest.premise}`,
    // ⚠️ 续写也要带上题材（2026-09-15）：不然写着写着又回到排练室/后台去了
    quest.topicLabel ? `【这条的题材】偏「${quest.topicLabel}」—— 别中途飘回乐队的事。` : '',
    '',
    '【已经发生的】',
    stagesBlock(quest),
    '',
    // ⚠️⚠️ 她自己在群里**顺口接的话**也要给模型看（2026-09-15 晚加）。
    //    不然她上一段说完「客房留给我」，下一段模型不知道，会写出前后矛盾的话。
    interludeBlock(quest),
    replies.length
      ? `【这一阶段群里说的话】（可能改变走向，要看进去）\n${replies
          .map((r) => `${r.name}「${r.text}」`)
          .join('\n')}`
      : '【这一阶段群里没人说话】',
    '',
    forceEnd
      ? endingForceHint(forceEnd)
      : hardStop
        ? '⚠️⚠️ 已经到硬上限了，**这一段必须是最后一段**，必须给结局（done: true）。'
        // ⚠️ `extra` 传 0：热情带来的"多演几段"现在**真的涨在 `plannedStages` 上**
        //    （见上面那句 `bumpPlanned`）。这里再挪一次就成了两道坎叠加，会拖到 9 段才收。
        : endPressure(next, quest.plannedStages, 0) + warmHint(quest, next),
    '',
    `现在写**第 ${next} 段**。`,
    '⚠️ 群里的话如果是在给她建议/劝她，她**可以改主意** —— 改了就体现在这一段里。',
    '如果没人说话，就按你自己的方向往下推（她是个会自己往前走的人）。',
    '⚠️ **这一段也要有人在场或被卷进来** —— 别写成她一个人闷头想。',
    // ⚠️⚠️ 收信人提醒（2026-09-15 <主人> 拿着截图反馈：她把队友当成了说话对象）
    // ⚠️⚠️ 「来龙去脉」提醒（2026-09-15 <主人>：「主要是她转述剧情的话要有来龙去脉」）
    '⚠️⚠️ **这一段要交代来龙去脉**：先用**一句由头**说清"这件事在追什么、上一段到哪了"，',
    '   再讲这一步的新进展。群里有人**没看到上一段** —— 别写成从半截开始的一句话，',
    '   但也别把前几段复述一遍（那是流水账）。篇幅 2-4 句。',
    '⚠️⚠️ **「text」是说给群友听的**：故事里的那些人是她**讲给群友听的事里的人**，',
    '   不是她喊话的对象。**别写成她给队友下命令/派活/安排事情** ——',
    '   要提就用转述的口气（"我让他们…"），对群友就写事、写她怎么想、写她接下来干嘛。',
    '',
    '【输出 JSON】',
    '{',
    '  "event": "这一段世界上发生了什么（一句话）",',
    `  "text": "${persona.narrativeName()}这次在群里说的话（1-3 句，第一人称）",`,
    `  "done": ${forceEnd || hardStop ? 'true' : 'false'},`,
    `  "ending": ${forceEnd ? `"${forceEnd}"` : 'null'}`,
    '}',
    '收尾那一段把 done 设成 true，ending 填 "good" 或 "bad"。',
  ]
    .filter(Boolean)
    .join('\n');

  let raw = '';
  try {
    raw = await p.ask([
      { role: 'system', content: buildSystem() },
      { role: 'user', content: user },
    ]);
  } catch (e) {
    stats.lastError = e.message;
    return { ok: false, reason: `续写失败：${e.message}` };
  }

  const j = parseJson(raw);
  const text = chatLine(j?.text) || chatLine(raw).slice(0, 200);
  if (!text) return { ok: false, reason: '模型没给出内容，保持原状' };
  const event = String(j?.event ?? '').trim() || text;
  // ⚠️ `forceEnd` 时**以我们指定的结局为准**，不看模型回了什么 ——
  //    模拟面板就是要"确定能看到坏结局"，不能靠模型配合。
  let done = forceEnd ? true : j?.done === true || hardStop;
  let ending = forceEnd ?? (['good', 'bad'].includes(String(j?.ending)) ? String(j.ending) : null);

  // ⚠️⚠️ 2026-09-17 用户要求：「群友非常热情的情况，**段数太少**的情况下可以**自动增加 2-3 段**」。
  //    这里只是**兜底**：真正管用的是生成前那句 `warmHint`（模型听劝就压根走不到这里）。
  //    走到这里说明它已经把这一段**写成收尾**了，我们只能把它按回去 ——
  //    所以下一段的提示里得让它自然接上，别硬掰（`warmHint` 已经交代了）。
  if (done && !forceEnd && !hardStop && quest.warmth?.warm) {
    const used = Number(quest.extraStages ?? 0);
    // ⚠️⚠️ 2026-09-17 修（<主人>：「已经 **7/5** 了，还没播报」）：
    //    **必须跟 `warmHint()` 用同一条边界** —— 超出计划段数之后就不能再把模型的
    //    `done` 按回去了。上一版只改了提示词那一半（`warmHint`），**漏了这里**，
    //    结果模型明明给了 `done: true`，被这一行按掉（日志：「这次不收尾，加演第 2 段」）
    //    → 跟 `endPressure` 的"必须是最后一段"打架 → 剧情永远收不了尾、
    //    **结局播报也永远发不出来**。
    const plan = Number(quest.plannedStages ?? 0);
    // ⚠️ 硬上限照旧是 `MAX_STAGES` —— 不能因为热情就突破它
    if (next <= plan && used < WARM_EXTRA_STAGES && next < MAX_STAGES) {
      done = false;
      ending = null;
      quest.extraStages = used + 1;
      log.info(
        `[剧情] 群 ${quest.groupId} 够热情（上一段 ${quest.warmth.count} 条 / ${quest.warmth.people} 人）` +
          `→ 这次不收尾，加演第 ${quest.extraStages} 段`,
      );
    }
  }
  if (done && !ending) ending = 'bad'; // 没收明白就当坏结局（保守）

  recordStage(quest, { i: next, text, event, replies, auto: replies.length === 0 }, now());
  stats.advanced++;
  if (done) finish(quest, ending, forceEnd ? `forced-${forceEnd}` : hardStop ? 'hard-cap' : 'llm');
  else save();

  return { ok: true, text, event, done, ending: done ? ending : null, forced: hardStop, forcedEnding: forceEnd };
}

/** 把这一段落进 quest（内部） */
function recordStage(quest, s, now) {
  // ⚠️ 2026-09-17：补上 `at` —— 界面的剧情时间线要按时间排，
  //    而原来这里只存了 `{i, text, event, replies, auto}`，没有时间戳 ⇒ 时间线上排不了。
  quest.stages = [...(quest.stages ?? []), { ...s, at: Number(s?.at ?? 0) || now }];
  quest.stageIndex = s.i;
  quest.awaitingSince = now;
  if (s.replies?.length) {
    quest.humanReplies = (quest.humanReplies ?? 0) + s.replies.length;
    for (const r of s.replies) {
      const id = String(r.userId ?? '');
      if (id && !quest.cast.includes(id)) quest.cast = [...quest.cast, id];
    }
    quest.autoContinues = 0;
  } else {
    quest.autoContinues = (quest.autoContinues ?? 0) + 1;
  }
  noteStory({
    tier: 2,
    text: `【主线·第${s.i}段】${s.event}`,
    tags: ['主线'],
    at: now,
    questId: quest.id,
    stage: s.i,
    // ⚠️ 写进**这条剧情所在的那个群**的故事线（分群之后必须分清）
    groupId: quest.groupId,
  });
  // 群友改变了走向的话，也要进故事线（用户要求）
  for (const r of s.replies ?? []) {
    noteStory({
      tier: 1,
      imp: 3,
      text: `${r.name}说：${r.text}`,
      tags: ['建议', '主线'],
      at: now,
      questId: quest.id,
      stage: s.i,
      groupId: quest.groupId,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// 结束 / 冷场 / 到期
// ─────────────────────────────────────────────────────────────

/**
 * 好感度变化：**二级比一级大**（用户要求「二级事件比一级事件要改变的好感度更大」）。
 *
 * ⚠️⚠️ 2026-09-15 改：**坏结局是负数（掉好感度）**。
 *    <主人> 原话：「我一开始是想坏结局要掉好感度的，然后下一个二级事件的开头
 *    可以直接参考坏结局剧情，就可以进行挽回了。」
 *
 *    所以默认 好 +3 / 坏 **−2**：
 *      · 方向和幅度都跟"二级比一级（±1）大"这条一致
 *      · 坏结局扣得分，但**下一条剧情会接着它写挽回** —— 分是赚得回来的
 *      · 想改成"不加不减"就把 `quest.affinityBad` 配成 `0`
 *        （⚠️ 这时**必须**靠 `nz()` 读，用 `||` 会把 0 变成默认值）
 */
export function endingDelta(ending, groupId = '') {
  const c = cfgFor(groupId);
  const good = num(c.affinityGood, 3);
  const bad = num(c.affinityBad, -2);
  return ending === 'good' ? good : bad;
}

/**
 * 记下"她为这条剧情发的这条消息"的 id（回复判据要用）。
 * 顺手只留最近 20 条 —— 一条剧情最多 10 段，够用。
 */
export function rememberHerMsg(quest, messageId) {
  const id = String(messageId ?? '').trim();
  if (!quest || !id) return;
  quest.herMsgIds = [...(quest.herMsgIds ?? []), id].slice(-20);
  save();
}

/**
 * 结算结局 → 好感度。
 *
 * ⚠️ 只有**参与过的人**（`cast`）才加，而且**注入 `adjust` 而不是直接 import**：
 *    这样能离线测"谁加了多少"，也不用把 `affinity.js` 拖进引擎依赖。
 *
 * @param {object} q 剧情
 * @param {('good'|'bad')} ending
 * @param {(userId:string, delta:number, opts:object) => any} adjust 一般是 `affinity.adjust`
 */
export function settle(q, ending, adjust) {
  const delta = endingDelta(ending, q?.groupId);
  const cast = [...(q?.cast ?? [])];
  const note = `主线剧情：${ending === 'good' ? '好结局' : '坏结局'}`;
  const applied = [];
  // ⚠️⚠️ 2026-09-18 修（用户报「**模拟收成坏结局，但是还是加了好感度**」）：
  //    模拟是**沙箱**（`setSandbox(true)`：不落盘、不发消息、不写真实故事线），
  //    可这里原来照样把 `adjust` 调下去了 → **真实好感度真的被改了** ✗
  //    所以沙箱期间一律不结算：只在 `applied` 里记下"本该加/减多少"，
  //    界面上照样能显示，但**一个真实分数都不动**。
  const dry = !!sandbox;
  for (const userId of cast) {
    if (typeof adjust !== 'function') break;
    if (dry) {
      applied.push({ userId, delta, ok: true, from: null, to: null, got: null, value: null, dryRun: true });
      continue;
    }
    try {
      // ⚠️⚠️ 2026-09-20 用户要求：「**二级剧情加的好感度不被每日好感度限制所限制**」——
      //    所以这里传 `force: true`：绕过 `affinity.js` 里的**每日额度（`DAY_CAP`）**
      //    和单次幅度上限（`MAX_STEP`）。
      //    为什么该这样：剧情是**她跟这群人一起经历的大事**，一次好结局的分量
      //    不该被"今天闲聊的额度用完了"卡住 —— 那个额度是给日常刷分防的。
      //    ⚠️ **只改剧情这一条路径**：一级事件（`life.js`）和日常聊天照旧受每日限制。
      const r = adjust(userId, delta, { note, force: true });
      // ⚠️⚠️ 2026-09-17 修：这里原来取的是 `r?.value ?? r?.v`，
      //    而 `affinity.adjust()` 返回的是 `{ ok, from, to, applied, ... }` ——
      //    **根本没有 `value` / `v`**，所以那个字段一直是 null（没人用，就没发现）。
      //    做结局播报要显示"谁加了多少"，必须拿到**实际**变化：
      //    `applied` 会被单次幅度上限和每日额度夹住，跟请求的 `delta` 不一定相等。
      applied.push({
        userId,
        delta,
        ok: r?.ok !== false,
        from: r?.from ?? null,
        to: r?.to ?? null,
        got: r?.applied ?? null,
        value: r?.to ?? r?.value ?? r?.v ?? null,
      });
    } catch (e) {
      applied.push({ userId, delta, ok: false, error: e.message });
    }
  }
  log.info(
    `[剧情] 结算：${ending === 'good' ? '好' : '坏'}结局，好感度 ${delta >= 0 ? '+' : ''}${delta} × ${cast.length} 人` +
      (dry ? '（**模拟，不落盘**）' : ''),
  );
  return { ending, delta, cast, applied, dryRun: dry };
}

/**
 * 结局播报等多久再发（毫秒）。
 *
 * ⚠️ 用户要求（2026-09-17）：「加一个二级剧情结局展示，**跟在机器人发的剧情
 *    最后一句话之后一秒钟发送**」。这一秒是故意的：她刚说完最后一句，
 *    立刻补一条"结算"像系统公告；隔一秒像是她顺手报的。
 */
export const ENDING_REPORT_DELAY_MS = 1000;

/**
 * 结局播报的文案（2026-09-17 用户要求）。
 *
 * 用户原话：「内容首先展示本次剧情结束，这次是好/坏结局，
 *   哪些人加/减了多少好感度」。
 *
 * ⚠️ 这是**机器格式**，跟 `/好感度` 排行榜一个路子：
 *    · 用 `sendToGroup` 发、**不进聊天上下文** —— 否则她下次说话会把这行
 *      当成群里聊过的内容（`/好感度` 那条踩过这个坑）；
 *    · **不 @ 任何人** —— @ 会弹通知，那个口子只留给"余额见底催充值"。
 *
 * ⚠️ 名字由调用方注入（`nameOf`）：这个模块不认识群名片，保持纯函数才好离线测。
 *
 * @param {{ending?:string, delta?:number, applied?:Array}} result `settle()` 的返回
 * @param {(userId:string)=>string} nameOf
 * @returns {string} 文案；**没人参与时返回空串**（那时没什么可播报的）
 */
export function endingReport(result, nameOf = (id) => String(id)) {
  const applied = Array.isArray(result?.applied) ? result.applied : [];
  if (!applied.length) return '';
  const good = result.ending === 'good';
  const sign = Number(result.delta) >= 0 ? '+' : '';
  const lines = applied.map((x, i) => {
    const name = String(nameOf(x.userId) ?? x.userId);
    // 拿不到前后值（`adjust` 抛了 / 好感度功能关着）→ 至少把名字列出来，别丢人
    if (x?.from === null || x?.from === undefined || x?.to === null || x?.to === undefined) {
      return `${i + 1}. ${name}`;
    }
    // ⚠️ 数字没动不是"没参与"，是**今天的加分额度用完了**（减分不占额度，
    //    所以这半句实际上只会出现在好结局里）。说清楚，不然群友以为漏算了他。
    const tail = x.to === x.from ? '（没变，今天的额度用完了）' : '';
    return `${i + 1}. ${name}　${x.from} → ${x.to}${tail}`;
  });
  return [
    `【本次剧情结束 · ${good ? '好结局' : '坏结局'}】`,
    `好感度 ${sign}${result.delta}（参与 ${applied.length} 人）：`,
    ...lines,
  ].join('\n');
}

/** 收尾 */
export function finish(quest, ending, reason = 'llm', now = Date.now()) {
  if (!quest) return null;
  quest.endedAt = now;
  quest.ending = ending === 'good' ? 'good' : 'bad';
  quest.endReason = reason;
  // ⚠️ 分群：只动**这个群那个桶**（别把别的群正在跑的那条也清掉）
  setBucket(quest.groupId, {
    recent: [...(gbucket(quest.groupId)?.recent ?? []), { ...quest }].slice(-10),
    current: null,
  });
  stats.ended++;
  save();
  noteStory({
    tier: 2,
    text: `【主线·结局】${quest.ending === 'good' ? '好结局' : '坏结局'}：${quest.premise}（共 ${quest.stageIndex} 段）`,
    tags: ['主线', '结局'],
    at: now,
    questId: quest.id,
    stage: quest.stageIndex,
    groupId: quest.groupId,
  });
  log.info(`[剧情] 结束（群 ${quest.groupId}，${quest.ending}，${quest.stageIndex} 段，${reason}）：${quest.premise}`);
  return { ending: quest.ending, delta: endingDelta(quest.ending, quest.groupId), cast: [...(quest.cast ?? [])] };
}

/**
 * ⚠️ **中止**一个群正在跑的剧情（管理界面「清空剧情和故事线」按钮用的）。
 *
 * 为什么不能拿 `finish()` 凑合（那是"正常跑完"，副作用太多）：
 *   - `finish()` 会**算好感度**（`endingDelta`）→ 测试残留不该动用户的好感度
 *   - `finish()` 会往故事线写一条「【主线·结局】」→ 测试残留不该留在她的记忆里
 *   - `finish()` 会把它塞进 `recent`（跑完的剧情史）→ 同样是不该留的痕迹
 *
 * 这里只做"当它没发生过"：`current` 清空、`recent` 清空、
 * **`starts` 也清空** —— 清 starts 是有意的：测试期（<主人>：「现在还在测试中」）
 * 「一周 3 条」的上限会挡着反复试，清掉才能连着开。
 *
 * @param {string} [groupId] 不给（或空）＝**所有群**
 * @returns {Array<{groupId:string,premise:string,stage:number}>} 被中止的剧情
 */
export function abort(groupId) {
  const all = groupId === undefined || groupId === null || String(groupId).trim() === '';
  const keys = all ? Object.keys(st.byGroup) : [gk(groupId)];
  const stopped = [];
  for (const k of keys) {
    const b = st.byGroup[k];
    if (!b) continue;
    if (b.current && !b.current.endedAt) {
      stopped.push({ groupId: k, premise: b.current.premise ?? '', stage: b.current.stageIndex ?? 0 });
    }
    setBucket(k, { current: null, recent: [], starts: [] });
  }
  if (stopped.length) {
    log.info(`[剧情] 中止（${all ? '所有群' : `群 ${gk(groupId)}`}）：${stopped.length} 条（不写结局、不动好感度）`);
  }
  save();
  return stopped;
}

/**
 * 某个群等群友回话等够了吗（默认 30 分钟）。
 * ⚠️ 分群之后**必须给 `groupId`** —— 定时器要挨个群问（见 `runningGroups()`）。
 */
export function due(now = Date.now(), groupId = '') {
  const q = gbucket(groupId)?.current;
  if (!q || q.endedAt) return false;
  const base = Math.max(60000, num(cfgFor(groupId).waitMs, 30 * 60 * 1000));
  // ⚠️ 2026-09-17 用户要求：「群友非常热情……然后**缩短等待推下一段时间**」——
  //    默认 30 分钟，正好聊热了却要干等，节奏就凉了。
  //    热情时走 `warmWaitMs`（默认 waitMs 的三分之一 = 10 分钟）。
  const warm = q.warmth?.warm === true;
  const wait = warm
    ? Math.max(60000, num(cfgFor(groupId).warmWaitMs, Math.round(base / 3)))
    : base;
  return now - (q.awaitingSince ?? q.startedAt) >= wait;
}

/**
 * 冷场收尾（**指定群**）。
 *
 * 用户拍板：「有人回过就按设计续写；**一个人都没回就最多续 1 次然后收尾**」。
 * 所以：
 *   · 有人回过 → 一直续到结局（`due()` 说了算）
 *   · 一次都没人回 → 让它最多自动推进 `coldAutoLimit` 次，然后就收
 */
export function coldStop(now = Date.now(), groupId = '') {
  const q = gbucket(groupId)?.current;
  if (!q || q.endedAt) return null;
  if ((q.humanReplies ?? 0) > 0) return null; // 有人回过，按正常流程走
  const limit = Math.max(0, num(cfgFor(groupId).coldAutoLimit, 1));
  if ((q.autoContinues ?? 0) > limit) {
    return finish(q, 'bad', 'cold', now);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 给外面看的
// ─────────────────────────────────────────────────────────────

/**
 * 某个群正在跑的那条剧情（不给 groupId = "没指定群"那个桶，老测试/模拟面板用）。
 * ⚠️ 分群之后外面**基本都该传群号** —— 不传就只能看到那一个桶。
 */
export function current(groupId = '') {
  return gbucket(groupId)?.current ?? null;
}

/**
 * 状态。
 * @param {string} [groupId] 给了就是那一个群的；不给 = 所有群的总览 + 每个群各一行
 */
export function status(groupId) {
  const only = groupId !== undefined && groupId !== null && String(groupId).trim() !== '';
  // ⚠️ 不给群号时：**挑一条正在跑的**当"代表"（老调用点/界面总览都靠它），
  //    没有在跑的就 null。`running` / `premise` 这些字段因此仍然有意义。
  const repGid = only ? gk(groupId) : (runningGroups()[0] ?? '');
  const q = gbucket(repGid)?.current ?? null;
  // ⚠️ 分群参数：给了群号就报**那个群生效的**那一套（界面按群覆盖时要看这个）
  const c = cfgFor(only ? groupId : repGid);
  const globalC = cfg();
  return {
    enable: c.enable === false ? false : true,
    chance: num(c.chance, 0.1),
    maxPerWeek: num(c.maxPerWeek, 3),
    waitMs: num(c.waitMs, 30 * 60 * 1000),
    maxStages: num(c.maxStages, MAX_STAGES),
    coldAutoLimit: num(c.coldAutoLimit, 1),
    affinityGood: num(c.affinityGood, 3),
    affinityBad: num(c.affinityBad, -2),
    /**
     * ⚠️ 这个群的**覆盖项**（没覆盖就是空对象）—— 界面拿它回填"按群设定"那张表，
     *    也拿它判断"这一行是不是被改过"。
     */
    overrides: only ? (config.groupParams?.[String(groupId).trim()]?.quest ?? {}) : {},
    /** 全局那套（界面用它显示"默认值"占位） */
    global: {
      enable: globalC.enable === true,
      chance: num(globalC.chance, 0.1),
      maxPerWeek: num(globalC.maxPerWeek, 3),
      waitMs: num(globalC.waitMs, 30 * 60 * 1000),
    },
    /**
     * ★ 上一条结局是坏结局（而且还在 7 天内）→ **下一条会写成"挽回"**
     *   （用户要求：「下一个二级事件的开头可以直接参考坏结局剧情，就可以进行挽回了」）
     *   ⚠️ 分群之后按**每个群各自**看（不给 groupId 就是全局有没有）。
     */
    redeemPending: (() => {
      const pools = only ? [gbucket(groupId)] : Object.values(st.byGroup);
      return pools.some((b) => {
        const prev = (b?.recent ?? []).slice(-1)[0];
        return !!(
          prev &&
          prev.ending === 'bad' &&
          Date.now() - Number(prev.endedAt ?? prev.startedAt ?? 0) <= 7 * 24 * 3600 * 1000
        );
      });
    })(),
    /**
     * ★ 「替换下次二级事件」存着的内容（空 = 没设过）。
     * ⚠️ 2026-09-15 晚起**按群**：给了群号就是这个群的，没给就是那份全局兜底。
     *    界面要显示"每个群各存了什么"就用下面的 `hints`。
     */
    nextHint: nextHint(only ? groupId : repGid),
    /** 每个群各存了一句什么（键是群号，`''` 是全局兜底那份） */
    hints: hintsByGroup(),
    weeklyUsed: weeklyCount(Date.now(), repGid),
    running: !!q,
    runningSince: q?.startedAt ?? 0,
    groupId: q?.groupId ?? '',
    stage: q?.stageIndex ?? 0,
    plannedStages: q?.plannedStages ?? 0,
    premise: q?.premise ?? '',
    humanReplies: q?.humanReplies ?? 0,
    autoContinues: q?.autoContinues ?? 0,
    pending: (q?.pending ?? []).length,
    /**
     * ⚠️ 2026-09-15 晚加：界面要显示"**还等着谁说什么**"，
     *    光给一个条数（`pending`）不够 —— 用户要求"剧情发展呈现在 webui 上更详细一点"。
     */
    pendingList: (q?.pending ?? []).map((x) => ({
      name: x.name,
      text: x.text,
      at: x.at,
      // ⚠️ 判据一起给界面：`at`/`reply`/`suggest`/`question` = 真在推剧情，`loose` = 随口一句。
      //    界面上要**分开显示**（2026-09-17 用户要求）。
      why: x.why ?? '',
    })),
    /** 她在这条剧情里**顺口接过的话**（不是分段）—— 时间线上要显示出来 */
    interludes: (q?.interludes ?? []).map((x) => ({ text: x.text, at: x.at })),
    /**
     * ⚠️ 2026-09-17 加（<主人> 报「图二的阶段信息没有进 webui」）：
     *    界面上原来只有「等下一段」（`pendingList`）和「插曲」（`interludes`），
     *    而**她真正发出去的那几段剧情本身反而看不见** —— 明明那才是最该看的。
     */
    stages: (q?.stages ?? []).map((s) => ({
      i: s?.i ?? 0,
      text: s?.text ?? '',
      at: s?.at ?? 0,
      event: s?.event ?? '',
      // ⚠️ 前端 `questDevHtml()` 会把她那一段收到的群友回复也列出来（`↳ 谁：说了什么`），
      //    所以这里必须一起带过去 —— 只给 text 的话那段就丢了一半信息。
      replies: (s?.replies ?? []).map((r) => ({ name: r?.name ?? '', text: r?.text ?? '' })),
    })),
    /** 这一段的等待窗口：`awaitingSince + waitMs` 到点就会自动推下一段（界面显示倒计时用） */
    awaitingSince: q?.awaitingSince ?? 0,
    // ⚠️ 2026-09-17：这里必须给**实际会用到**的等待时长 —— 群里热情时 `due()` 走的是
    //    `warmWaitMs`（默认 waitMs 的三分之一）。给错的话界面倒计时会跟真实推进对不上
    //    （显示还有 20 分钟，结果 8 分钟就推了）。
    waitMs: (() => {
      const c = cfgFor(only ? groupId : repGid);
      const base = num(c.waitMs, 30 * 60 * 1000);
      return q?.warmth?.warm ? Math.max(60000, num(c.warmWaitMs, Math.round(base / 3))) : base;
    })(),
    /** 这一段群里热不热（界面能看出来；热的话会加演、而且等得短） */
    warmth: q?.warmth ?? null,
    /** 因为"群里热情"已经加演了几段（上限 `WARM_EXTRA_STAGES`） */
    extraStages: q?.extraStages ?? 0,
    questId: q?.id ?? '',
    /** 这条的题材（界面显示用；原来只有"总览"那个分支带它） */
    topicLabel: q?.topicLabel ?? '',
    cast: [...(q?.cast ?? [])],
    /** 这条剧情到目前为止的每一段（给界面显示） */
    stages: (q?.stages ?? []).map((s) => ({
      i: s.i,
      at: s.at,
      text: s.text,
      event: s.event,
      replies: (s.replies ?? []).map((r) => ({ name: r.name, text: r.text })),
    })),
    // ⚠️ 历史**不看有没有在跑的剧情**（原来写成 `q ? ... : []` —— 剧情一结束历史就空了，
    //    那是个 bug：`finish()` 之后 current 就是 null）。给了群号看那个群，否则看全部。
    recent: (() => {
      const pool = only
        ? (gbucket(groupId)?.recent ?? [])
        : Object.values(st.byGroup).flatMap((b) => b?.recent ?? []);
      return [...pool]
        .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
        .slice(-5)
        .map((x) => ({
          id: x.id,
          premise: x.premise,
          ending: x.ending,
          stages: x.stageIndex,
          at: x.endedAt,
        }));
    })(),
    /**
     * ⚠️ 分群之后：**每个群正在跑什么**（剧情卡片要用）。
     *    `running: true` 现在只表示"全局有没有在跑的"，具体看这里。
     */
    byGroup: Object.entries(st.byGroup)
      .filter(([, b]) => b?.current || (b?.recent ?? []).length)
      .map(([gid, b]) => ({
        groupId: gid,
        running: !!b?.current && !b.current.endedAt,
        premise: b?.current?.premise ?? '',
        stage: b?.current?.stageIndex ?? 0,
        plannedStages: b?.current?.plannedStages ?? 0,
        topicLabel: b?.current?.topicLabel ?? '',
        weeklyUsed: weeklyCount(Date.now(), gid),
        lastEnding: (b?.recent ?? []).slice(-1)[0]?.ending ?? '',
      })),
    /** 一共几个群在跑（定时器/界面看这个） */
    runningCount: runningGroups().length,
    ...stats,
  };
}

/**
 * ⚠️ **测试专用**：清空全部（所有群）。
 * ⚠️ 模拟面板**不走这条路**（它用 `swapState()` 换掉再换回来），所以这里全清是安全的；
 *    但**别在机器人运行的代码里调它** —— 那会把所有群正在跑的剧情清掉。
 */
export function __clear() {
  st = { byGroup: {}, nextHint: '' };
  stats.started = 0;
  stats.ended = 0;
  stats.advanced = 0;
  stats.lastError = '';
}
/**
 * ⚠️ 测试专用：直接塞状态。
 * ⚠️ 兼容老形状（`{current,recent,starts}`）—— 落到"没指定群"那个桶里。
 */
export function __set(patch = {}) {
  if ('current' in patch || 'recent' in patch || 'starts' in patch) {
    const cur = gbucket('') ?? { current: null, recent: [], starts: [] };
    setBucket('', {
      current: patch.current !== undefined ? patch.current : cur.current,
      recent: patch.recent !== undefined ? patch.recent : cur.recent,
      starts: patch.starts !== undefined ? patch.starts : cur.starts,
    });
  }
  if ('byGroup' in patch) st = { ...st, byGroup: { ...patch.byGroup } };
  if ('nextHint' in patch) st = { ...st, nextHint: String(patch.nextHint ?? '') };
}

load();
