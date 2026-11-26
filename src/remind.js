/**
 * 定时提醒（2026-09-18 要求）。
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
import { ROOT, config, CONFIG_FILE, stateDir } from './config.js';
import { log } from './log.js';

const STATE_DIR = join(stateDir());

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

/** 分配一个**不撞已有 id** 的编号（2026-11-26：撞号会让 markSent 标错条目） */
function newId() {
  let id = Math.max(1, Number(st.nextId) || 1);
  const used = new Set(st.items.map((x) => x.id));
  while (used.has(id)) id++;
  st.nextId = id + 1;
  return id;
}

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
          /* ⚠️⚠️⚠️ 2026-11-25 修（全链路测试抓到的真 bug）：
           *   原来这里只映射旧字段 ⇒ 重启后 kind/history/mention/again **全被丢掉**，
           *   所有 watch 任务都退化成普通 remind（日志走"到点已发出"而不是"到点跑 watch"）✗
           *   ⇒ 四个字段必须一起读回来 ✓ */
          kind: String(x?.kind ?? 'remind').trim() === 'watch' ? 'watch' : 'remind',
          mention: x?.mention !== false,
          again: x?.again !== false,
          until: Number(x?.until) || 0,
          history: (Array.isArray(x?.history) ? x.history : [])
            .slice(-5)
            .map((h) => ({
              at: Number(h?.at) || 0,
              note: String(h?.note ?? '').trim().slice(0, 200),
            }))
            .filter((h) => h.at && h.note),
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
      /* ⚠️⚠️ 2026-11-26 修（真 bug，我自己插测试数据时炸出来的）：
       *   原来只信文件里的 `nextId` ⇒ 万一它落后于已有 id（手写过 / 老版本写的），
       *   新任务会拿到**和旧任务一样的 id** ⇒ `markSent(id)` 命中的是旧那条，
       *   新那条永远「没发过」⇒ **每分钟重复触发**（实测 00:54、00:55 连着跑两次）✗
       *   ⇒ 载入时保证 `nextId` 严格大于现有最大 id ✓ */
      nextId: Math.max(
        1,
        Number(j?.nextId) || 1,
        ...((Array.isArray(j?.items) ? j.items : []).map((x) => (Number(x?.id) || 0) + 1)),
      ),
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

  /* ⚠️⚠️⚠️ 2026-11-25 加 `kind`（用户：「bot 还可以自己设定定时任务」）——
   *   · `remind`：到点发一句固定的话（原来那套）
   *   · `watch` ：到点**真的跑一次**（自己去搜、用自己的话转述、附来源链接），
   *              完没完成、要不要接着排下一次，**都由她自己看搜索结果决定** ✓
   *   ⚠️ 这里只做**频率护栏**，不判断"这件事值不值得盯"——那是她的判断。
   */
  const kind = String(r.kind ?? 'remind').trim() === 'watch' ? 'watch' : 'remind';
  if (kind === 'watch') {
    const minGap = Math.max(5 * 60 * 1000, Number(config.remind?.watchMinGapMs) || 30 * 60 * 1000);
    if (at - now < minGap) {
      // 不拒绝，直接**帮她推到最早允许的时刻** —— 免得她排太密把群刷了
      r = { ...r, at: now + minGap };
      return addByOnce({ ...r, at: now + minGap, kind, _pushed: true }, now);
    }
    const perDay = Math.max(1, Number(config.remind?.watchPerDay) || 8);
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const usedToday = st.items.filter(
      (x) => String(x.kind ?? '') === 'watch' && Number(x.sentAt) >= dayStart.getTime(),
    ).length;
    if (usedToday >= perDay) {
      return { ok: false, reason: `今天自动关注任务已经跑过 ${usedToday} 次（上限 ${perDay}），明天再来` };
    }
  }

  /* ⚠️⚠️⚠️ 2026-11-25 加 `until`（用户：「如果是和她说**接下来 24 个小时要持续观测**，
   *   自动续期要能确实续到 24 小时然后结束，但是如果目标提前完成了可以提前结束」）——
   *
   *   `until` = 这件事观测到什么时候为止（时间戳，0=单次）。
   *   · 续期时（同一主题再排一次）**自动继承**上一次的 until ⇒ 她不用每次重算；
   *   · 新任务时间超过 until ⇒ 直接拒（"这次观测只到 X"）⇒ 24 小时到了自然停 ✓
   *   · 目标提前完成 ⇒ 她自己不排了（那是她的判断，代码不管）✓
   */
  let until = Number(r.until) || 0;
  if (!until) {
    try {
      const same = st.items
        .filter((x) => String(x.what ?? '') === what && String(x.groupId ?? '') === String(r.groupId ?? ''))
        .sort((a, b) => (b.at || 0) - (a.at || 0))[0];
      if (same?.until && Number(same.until) > now) until = Number(same.until);
    } catch {}
  }
  if (until && at > until) {
    const d = new Date(until);
    const p2 = (n) => String(n).padStart(2, '0');
    return {
      ok: false,
      reason: `这次观测只到 ${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}，那之后别再排了`,
    };
  }

  const live = st.items.filter((x) => !x.sentAt);
  if (live.length >= maxItems()) return { ok: false, reason: `挂着的提醒太多了（${live.length} 条）` };

  const item = {
    id: newId(),
    at: Number(r.at) || at,
    what: what.slice(0, 200),
    /* ⚠️ 2026-11-25：任务类型 + 她自己的两个判断（到点要不要 @、没完成要不要接着排） */
    kind,
    mention: r.mention !== false,
    again: r.again !== false,
    until,
    history: [],
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

/** watch 排太密时用它把时间往后推（内部递归入口，避免重复校验死循环） */
function addByOnce(r = {}, now = Date.now()) {
  const live = st.items.filter((x) => !x.sentAt);
  if (live.length >= maxItems()) return { ok: false, reason: `挂着的提醒太多了（${live.length} 条）` };
  const item = {
    id: newId(),
    at: Number(r.at) || now,
    what: String(r.what ?? '').trim().slice(0, 200),
    kind: 'watch',
    mention: r.mention !== false,
    again: r.again !== false,
    /* ⚠️ 2026-11-25：**接续时要带上一条的历史**（用户：「这次游戏能到30帧，
     *   下次到了60帧会自己拉出来对比」）—— 从被接续那条继承 ✓ */
    history: Array.isArray(r.history) ? r.history.slice(-5) : [],
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
  save();
  return { ok: true, item, pushedTo: item.at };
}

/**
 * ⚠️⚠️ 2026-11-25 加（用户：「连续生成的定时任务，输入的内容要有前几次任务的输出和记忆，
 *   比如这次游戏能到30帧，下次到了60帧会自己拉出来对比」）——
 *
 *   一条 watch 任务每跑一次，就把**她这次说的话**记进它的 `history`；
 *   下次到点时把最近几次一起拼进提示词里 ⇒ 她自己能说出"上次 30 帧，这次 60 了" ✓
 *
 *   ⚠️ 只留最近 5 次（再多就是噪音，也省 token）。
 *   @param {number} id  任务 id
 *   @param {string} note 她这次说的（截断到 200 字）
 */
export function pushHistory(id, note, at = Date.now()) {
  const it = st.items.find((x) => Number(x.id) === Number(id));
  if (!it) return false;
  it.history = Array.isArray(it.history) ? it.history : [];
  it.history.push({ at: Number(at) || Date.now(), note: String(note ?? '').trim().slice(0, 200) });
  if (it.history.length > 5) it.history = it.history.slice(-5);
  save();
  return true;
}

/** 12/24 小时制 → 当天的小时数（0-23） */
function to24(h, period) {
  if (h === 0 || h >= 13) return h; // 他直接说了"20点""22:40"
  if (h === 12) return period === 'pm' ? 0 : 12; // 「晚上12点」= 次日 0 点
  return period === 'am' ? h : h + 12; // ⚠️ 没说 am/pm 时按**晚上**口径（见下）
}

/**
 * 把用户嘴里的时间算成**绝对时刻**（2026-09-18补充要求）。
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
  // ⚠️⚠️ 2026-09-29 加（用户实测：一语未尽说「10分钟之后叫 起床」，她应了
  //    「行，十分钟后叫你」，但那条提醒**压根没记上** ✗）。
  //
  //    根因：这套只认"**几点**"（`hour` 0-23），而「10分钟之后」是**相对时间** ——
  //    `hour` 留空 ⇒ 下面那个 `hourRaw` 检查直接 `return 0` ⇒ `add()` 拿不到 `at`
  //    ⇒ 不记。可她嘴上已经答应了，于是变成"答应了却没办" ✗。
  //
  //    ⇒ 相对时间单独走这一条：`afterMin` 就是"从现在起多少分钟"，直接算出来。
  //    ⚠️ 圆到整分钟 —— 他说"10分钟之后"不该变成"10 分 37 秒之后"。
  const afterMin = Number(spec.afterMin);
  if (Number.isFinite(afterMin) && afterMin > 0) {
    const d = new Date(now + Math.round(afterMin) * 60000);
    d.setSeconds(0, 0);
    return d.getTime();
  }
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
    // ⚠️⚠️ 2026-09-29 修（用户报：「今天3点提醒起床」被设成了**下午** 15:00，
    //    实际他指的是**13 分钟后**的凌晨 3 点）。
    //
    //    `to24()` 对"只说钟点"（没说上午/下午）一律按**晚上**口径 +12 ——
 // 这在**白天**说话时是对的（2026-09-18 明确要的：「只说8点 = 今天晚上20点」），
    //    但**凌晨**说话时就荒唐了：凌晨 2:47 说「今天3点」，绝不可能是"今天下午3点" ✗。
    //
    //    ⇒ 只说钟点、且钟点落在有歧义的 1~11 点时：取「今天这个点」和「今天+12」里
    //      **第一个还没到的**。两个都过了（比如下午 4 点说"今天3点"）就退回原来的 +12，
    //      让上层如实说"那个点已经过了"。
    //    ⚠️ 白天 9 点说"今天8点" ⇒ 8:00 已过、20:00 没到 ⇒ 取 20:00 ✓（和原来一致）
    //       白天 9 点说"今天10点" ⇒ 10:00 没到 ⇒ 取 10:00 ✓（本来就该是上午十点）
    //    ⚠️⚠️ 但**只在凌晨**才这么判 —— 白天说"8点"仍然按用户明确要的口径算成今晚 20:00
    //       （实测：早上 7 点说"8点"，如果也套这条就会算成 1 小时后 ✗，
    //        `test/remind.js` 的「早上只说8点 → 今晚20:00」那条抓到了）。
    const hh0 = new Date(now).getHours();
    if (period === '' && hourRaw >= 1 && hourRaw <= 11 && hh0 < 5 && hh0 < hourRaw) {
      const early = at(d, hourRaw, minute);
      const late = at(d, hourRaw + 12, minute);
      if (early > now) return early;
      if (late > now) return late;
      return late;
    }
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
    // ⚠️ 只说「8点」这条路 —— 用户拍板的默认口径，候选的**顺序**就是答案：
    //
    // ⚠️⚠️ 2026-09-29 加了第一个候选（用户报的那个 bug：凌晨说「3点」被算成下午）。
    //    ⚠️ 但**只在凌晨**加 —— 白天/早上说"8点"必须仍然是今晚 20:00（用户明确要的），
    //       否则早上 7 点说"8点"会被算成 1 小时后 ✗（`test/remind.js` 抓到过）。
    //    ⚠️ 它也不会破坏那条规矩：凌晨说"3点"时 `3:00 > now` ⇒ 被收进来 ✓；
    //       白天说"8点"时这一行**根本不执行** ⇒ 最近仍是今天 20:00 ✓。
    const hh = new Date(now).getHours();
    if (hh < 5 && hh < hourRaw) push(0, hourRaw); // ⓪ 今天 08:00（只在凌晨才有意义）
    push(0, hourRaw + 12); // ① 今天 20:00（默认）
    push(1, hourRaw); //      ② 明天 08:00（过了今晚8点就是它）
    push(1, hourRaw + 12); // ③ 明天 20:00
  }
  return cands.sort((a, b) => a - b)[0] ?? 0;
}

/**
 * 他在**这个会话**里最近一条**已经发出去**的提醒（2026-09-29 加）。
 *
 * ⚠️ 为什么需要（用户截图：他连着三次说「把**下次**提醒的被提醒人改成XXX」，
 *    她三次都应「行，改好了」—— 实际一次都没改 ✗）：
 *    `latest()` 只找**还没发**的那条，而他要改的**已经发过了**（03:00 那两条）
 *    ⇒ 判成"没定过"，可她明明刚定过 ⇒ 提示词那句「你没让我提醒过什么呀」
 *    **自相矛盾**，她不信就自己编了个"改好了"。
 *    ⇒ 这个函数用来区分「真没定过」和「定过但已经发掉了」，
 *      好让她如实说出**准确**的那一种。
 *
 * @param {{by?:string, groupId?:string}} q `groupId` 空串 = 私聊
 * @returns {object|null}
 */
export function latestSent({ by = '', groupId = '' } = {}) {
  const u = String(by ?? '').trim();
  const g = String(groupId ?? '');
  const sent = st.items.filter((x) => x.sentAt);
  for (let i = sent.length - 1; i >= 0; i--) {
    if (String(sent[i].by) === u && String(sent[i].groupId) === g) return sent[i];
  }
  return null;
}

/**
 * 他在**这个会话**里最近一条还没发出的提醒（2026-09-18 要求"补充式追加/修改"）。
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
  /* 2026-11-26：优先标记**还没发**的那条 —— 撞号时原来的 find 会标到旧那条，
   * 新的一条永远发不出去、每分钟重复触发 */
  const nid = Number(id);
  const it = st.items.find((x) => x.id === nid && !x.sentAt) ?? st.items.find((x) => x.id === nid);
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
 * 给聊天提示词用：**这个会话里还没到点的提醒**（2026-09-18反馈：「提醒不会进聊天上下文」）。
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

/**
 * **早就过了、还一直没发出去的**（该直接丢掉，别再重试）。
 *
 * ⚠️⚠️⚠️ 2026-10-08 加（用户看着那 12 条 9 月的提醒问：
 *    「**真人的都是已经过去的事情，为什么不会自动删除**」）。
 *
 * 根因在 `index.js` 那个 tick 里：它靠一个**内存** Map 记"试了多久"
 * （`fails: id → {n, since}`）+ `giveUpMs`（默认 2 小时）决定什么时候放弃。
 * 可内存态**一重启就归零** —— 机器人本来就每天都要重启几次
 * （2026-10-07 那晚我自己就重启了十几次）⇒ 那 2 小时**永远等不到**
 * ⇒ 发不出去的提醒**永远挂在那儿** ✗✗（9 月定的一直躺到 10 月）
 *
 * ⇒ 换一条**跟重启无关**的判据：**看提醒自己到点多久了**。
 *    到点超过 `staleMs`（默认 24 小时）还没发出去 ⇒ 直接当"已经没意义了"丢掉 ✓
 *    —— 提醒的价值全在"到点说出来"，隔了一天的提醒发出去反而是打扰。
 *
 * @param {number} before 到点早于这个时刻的就算过期
 */
export function stale(before = Date.now()) {
  return st.items
    .filter((x) => !x.sentAt && Number(x.at) > 0 && Number(x.at) <= before)
    .sort((a, b) => a.at - b.at);
}

/** 标成"发过了" */
export function markSent(id, at = Date.now()) {
  /* ⚠️ 2026-11-26：**优先标记还没发的那条** —— id 万一撞号（老数据 / 手写数据），
   *   原来的 find 会标到旧那条 ⇒ 新那条永远"没发过" ⇒ **每分钟重复触发** ✗ */
  const nid = Number(id);
  const it =
    st.items.find((x) => x.id === nid && !x.sentAt) ?? st.items.find((x) => x.id === nid);
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
