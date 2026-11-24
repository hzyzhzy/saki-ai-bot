/**
 * 「同类机器人」主动搭话 —— 群里**冷场**时，她 @ 一下同类池里的号说一句。
 *
 * ## 用户需求
 *   「加一个机器人同类池放在分群设定里也分群管理…填入的 QQ 号直接默认为同类机器人，
 *     **会随机主动 @ 找那个同类机器人聊天**」
 *   （池本身、界面、同类识别已经在 `bot.js` / `config.js` / `webui.html` 里做好了）
 *
 * 拍板过的两件事：
 *   · 对方回过来时**按普通聊天接** —— 所以防刷靠**现有的连续接话链上限**，
 *     这里**不给它开任何特例**；
 *   · 主动**只在群里冷场时**（不是定时无脑发）；
 * · 开场白**由模型按当下情况现想**（2026-10-05 拍的），不是固定几句里挑。
 *
 * ## 五道闸（缺一个就会变成话痨或被群友嫌）
 *   ① 没配同类池 → 不找（`groupParams.<群号>.peers`）；
 *   ② **只在 9~23 点** —— 凌晨找人聊天很怪（日常事件那边也有同样的规矩）；
 *   ③ **冷场**：群里最后一条消息超过 `idleMs`（默认 15 分钟）；
 *   ④ **冷却**：同一个群主动过一次后至少隔 `cooldownMs`（默认 30 分钟）；
 *   ⑤ **每日上限**：每个群每天最多 `maxPerDay` 次（默认 4 次）。
 *
 * ## 落盘
 *   `state/peer-chat.json`（原子写）—— 冷却和当日次数**重启不能丢**，
 *   否则重启一次就又能发一轮（`life.js` / `qzone.js` 都吃过这个亏）。
 *
 * ## 只在 1 档群
 *   只有进了事件系统的群才可能被搭话（`life.targetGroups()`），
 *   和日常事件 / 剧情同一个口径 —— 2 档群只是"她会在那儿说话"。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config, ROOT, stateDir } from './config.js';
import { log } from './log.js';
import { phrase } from './llm.js';
import { personaText } from './knowledge.js';
import * as recent from './recent.js';
import * as names from './names.js';
import * as life from './life.js';

const FILE = process.env.QQBOT_PEERCHAT_FILE
  ? join(ROOT, process.env.QQBOT_PEERCHAT_FILE)
  : join(stateDir(), 'peer-chat.json');

const cfg = () => config.peerChat ?? {};
const nz = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * 这个功能开着吗。
 *
 * ⚠️⚠️ `QQBOT_PEERCHAT=off` 可以**一刀关掉**（环境变量优先于配置）——
 *    回归里就是这么关的：它会**真往群里发消息**，而套件（比如 `sensitivity`）
 *    跑的正是配了同类池的那个群号，留着它等于埋个雷
 *    （`run-all.js` 里给每个套件都注入了这个 env，照 `QQBOT_REWRITE` 那个先例）。
 */
function enabled() {
  const env = String(process.env.QQBOT_PEERCHAT ?? '').trim().toLowerCase();
  if (env === '0' || env === 'off' || env === 'false') return false;
  return cfg().enable !== false;
}

let state = { day: '', counts: {}, lastAt: {}, lastPeer: {} };
function load() {
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    state = { ...state, ...(j && typeof j === 'object' ? j : {}) };
  } catch {
    /* 第一次还没有这个文件 */
  }
}
function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, FILE);
  } catch (e) {
    log.debug(`[同类] 状态写不进去：${e.message}`);
  }
}
load();

/** 这个群配了哪些同类（没配 = 空数组） */
export function peersOf(groupId) {
  const p = config.groupParams?.[String(groupId ?? '')]?.peers;
  return Array.isArray(p) ? p.map(String) : [];
}

/**
 * 该不该现在主动搭一句。**纯判据**（不碰网络、不写盘），方便单测。
 *
 * @param {number} now
 * @param {string} gid
 * @param {number} lastMsgAt 这个群最后一条消息的时间戳（0 = 不知道）
 * @returns {{ok:boolean, reason?:string, peers?:string[], idleMs?:number}}
 */
export function shouldPing(now, gid, lastMsgAt) {
  if (!enabled()) return { ok: false, reason: '同类聊天功能关着' };
  const peers = peersOf(gid);
  if (!peers.length) return { ok: false, reason: '这个群没配同类池' };

  const hour = new Date(now).getHours();
  if (hour < 9 || hour >= 23) return { ok: false, reason: `这个点（${hour} 点）不去找它` };

  if (!lastMsgAt) return { ok: false, reason: '不知道群里最后一条是什么时候' };
  const idleMs = Math.max(60000, nz(cfg().idleMs, 15 * 60 * 1000));
  const idle = now - Number(lastMsgAt);
  if (idle < idleMs) {
    return { ok: false, reason: `群里刚还有人说话（${Math.round(idle / 1000)} 秒前）` };
  }

  const cool = Math.max(60000, nz(cfg().cooldownMs, 90 * 60 * 1000));
  const last = Number(state.lastAt?.[String(gid)] ?? 0);
  if (now - last < cool) {
    return { ok: false, reason: `还在冷却（${Math.ceil((cool - (now - last)) / 60000)} 分钟后才行）` };
  }

  const cap = capFor(gid);
  const used = dayOf(now) === state.day ? Number(state.counts?.[String(gid)] ?? 0) : 0;
  if (used >= cap) {
    return {
      ok: false,
      reason: `今天已经找过 ${used} 次（这个群收紧度 ${strictnessOf(gid)} ⇒ 上限 ${cap} 次）`,
    };
  }

  return { ok: true, peers, idleMs };
}

/**
 * 这个群的收紧度（0~100，**越大越严**）。
 * ⚠️ 和 `bot.js` 的 `strictnessOf()` 同一套口径：先看按群的 `groupParams.<群>.chat.strictness`，
 *   没单独配就看全局 `chat.strictness`，都没有按 80（那本来就是默认值）。
 */
export function strictnessOf(gid) {
  const byGroup = Number(config.groupParams?.[String(gid ?? '')]?.chat?.strictness);
  if (Number.isFinite(byGroup)) return Math.min(100, Math.max(0, byGroup));
  const all = Number(config.chat?.strictness);
  return Number.isFinite(all) ? Math.min(100, Math.max(0, all)) : 80;
}

/**
 * 「一天最多主动找它几次」—— **跟这个群的收紧度挂钩**（2026-11-06：
 * 「把同类搭话次数和群收紧度挂钩」）。
 *
 * ## 为什么原来不对
 *   `maxPerDay` 是个**固定数**（原来 4，我昨天提到 10），跟"这个群想让她多安静"完全脱钩 ⇒
 *   一个收紧度 95 的群（几乎不让她说话）和一个 20 的群（很放得开）
 *   **每天主动 @ 同类的次数一模一样** ✗ 今天同一天就发了 38 次。
 *
 * ## 现在
 *   把 `maxPerDay` 当成**上限基数**（= 最宽松那个群能用的次数），再按收紧度打折：
 *     收紧度 0   → 用满（×1.00）
 *     收紧度 20  → ×0.84
 *     收紧度 50  → ×0.60
 *     收紧度 80  → ×0.36
 *     收紧度 100 → ×0.20
 *   ⇒ 基数是 8 的话：20 的群 7 次/天、80 的群 3 次/天、95 的群 2 次/天 ✓
 *   ⚠️ 下限 1：真要配了就至少留一次，别让它变成"永远不搭话"（配置里 `enable` 才是总开关）✓
 */
export function capFor(gid) {
  const base = Math.max(1, nz(cfg().maxPerDay, 8));
  const s = strictnessOf(gid);
  const factor = 1 - 0.8 * (s / 100);
  return Math.max(1, Math.round(base * factor));
}


/**
 * 今天还剩几次「跟同类说话」的额度（2026-11-10 加）。
 *
 * ⚠️ **主动搭话和回答对方的 @ 共用这一本账** —— 原来只有"主动"那次计入 capFor()，
 *    而"对方 @ 我、我回一句"那条路**没有任何每日上限**
 *    （只有 85% 掷骰 + 1 分钟冷却 + botChain 的 10/24 条降速）
 *    ⇒ 两个号能一天来回上百次，**收紧度完全管不到** ✗
 *    现场：群里两个号一直在互 @，capFor 算出来的上限是 2，实际来回了几十条。
 */
export function budgetLeft(gid) {
  const cap = capFor(gid);
  const used = Number(state.counts?.[String(gid)] ?? 0);
  return Math.max(0, cap - used);
}

/**
 * 记一次「回了同类一句」—— **只占预算**，不动主动搭话那几个字段
 * （lastAt / lastPeer / lastTexts 记的是"她主动找过谁、说过什么"，
 *   回复掺进去会让冷却和"别再问同一件事"都算错）。
 */
export function noteReply(gid, now = Date.now()) {
  const t0 = Number(now);
  const at = Number.isFinite(t0) && t0 > 0 ? t0 : Date.now();
  const d = dayOf(at);
  if (state.day !== d) {
    state.day = d;
    state.counts = {};
  }
  const k = String(gid);
  state.counts[k] = Number(state.counts?.[k] ?? 0) + 1;
  save();
  log.info(`[同类] 回复用掉一次额度 → 今天 ${state.counts[k]}/${capFor(gid)} 次`);
}
/**
 * ⚠️⚠️⚠️ 2026-11-21 加（用户：**让位只应该在两个及以上 bot 同时判回的时候启动，其他时候完全没用**）——
 *
 *   原来是**哈希公式**（`pickPeerIndex`）在 judge **之前**就无条件决定"这条轮到谁"：
 *   公式没选中我 ⇒ 直接 return null ⇒ **不管被选中的那个号到底接不接** ✗
 *   现场：<主人> 在跟 saki 说话，公式选中 saki，可 saki 那条万一判"不接" ⇒ 就没人接了；
 *   反过来爱音明明判了"要接"，却因为"公式没选中我"被掐掉 ✗✗
 *
 *   ⇒ 改成**抢答锁**：谁先判"要接"谁先抢，抢到就接、抢不到才让位。
 *     · 只有一个号判要接 ⇒ 它必然抢到 ⇒ 一定会有人接 ✓
 *     · 两个号都判要接 ⇒ 后到的抢不到 ⇒ 让位 ✓（这才是"让位"该起作用的场景）
 *
 *   ⚠️ 用**独占创建文件**（`wx` 模式）做原子锁 —— 跨进程安全，不需要任何外部依赖 ✓
 *   ⚠️ 带 TTL：锁文件 5 分钟后自动作废（万一那个号接了却没删，别把后面全堵死）✓
 */
export function claimReply(gid, msgKey, selfId, ttlMs = 5 * 60 * 1000) {
  try {
    const dir = join(stateDir(), 'claims');
    mkdirSync(dir, { recursive: true });
    // key 只取哈希，避免文件名里有中文/特殊字符
    let h = 0;
    const s = `${gid}|${msgKey}`;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    const f = join(dir, `${gid}-${Math.abs(h)}.json`);
    // ① 先看老的还在不在（过期就当没锁）
    try {
      const old = JSON.parse(readFileSync(f, 'utf8'));
      if (Number(old?.at ?? 0) && Date.now() - Number(old.at) < ttlMs) {
        return { ok: String(old.by ?? '') === String(selfId ?? ''), by: String(old.by ?? '') };
      }
    } catch {
      /* 没有 / 坏了 ⇒ 当没锁 */
    }
    // ② 抢：独占创建（失败 = 别人刚抢到）
    try {
      const fd = openSync(f, 'wx');
      writeFileSync(fd, JSON.stringify({ by: String(selfId ?? ''), at: Date.now() }));
      closeSync(fd);
      return { ok: true, by: String(selfId ?? '') };
    } catch {
      // 别人抢到了（或文件刚被建）⇒ 读出来看是谁
      try {
        const cur = JSON.parse(readFileSync(f, 'utf8'));
        return { ok: String(cur?.by ?? '') === String(selfId ?? ''), by: String(cur?.by ?? '') };
      } catch {
        return { ok: true, by: String(selfId ?? '') }; // 读不到就别卡死自己
      }
    }
  } catch (e) {
    log.debug(`[抢答] 出错（照常接）：${e.message}`);
    return { ok: true, by: String(selfId ?? '') };
  }
}

/** 挑一个同类：随机，但**尽量别跟上一次同一个**（池里只有一个就还是它） */
export function pickPeer(gid, peers, rng = Math.random) {
  const list = (peers ?? []).map(String);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  const last = String(state.lastPeer?.[String(gid)] ?? '');
  const rest = list.filter((x) => x !== last);
  const pool = rest.length ? rest : list;
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

/**
 * 记一次"主动过了"（冷却 + 当日计数），供发送成功后调用。
 *
 * ⚠️⚠️ 2026-10-16 修（用户截图：「**这个 @ 一下虽然显示发送失败，但是实际发送出去了**」，
 *    报错就是 `没成: Invalid time value`）——
 *    现场：界面那个「立刻试一次」调的是 `note(gid, peer, text)`，
 *    而本函数的第三个参数是 **`now`（时间戳）**、第四个才是 `text` ✗ ⇒
 *    时间戳变成了那句中文话 ⇒ `new Date('…').toISOString()` 直接抛
 *    `RangeError: Invalid time value` ⇒ **消息明明发出去了，界面却报"没成"** ✗✗
 *    （调用处已经改对了；这里再兜一道：**参数不是有效时间戳就按"现在"算**，
 *      以后谁再传错也不会把一次成功的发送变成"失败" ✓）
 */
export function note(gid, peer, now = Date.now(), text = '') {
  const t0 = Number(now);
  const at = Number.isFinite(t0) && t0 > 0 ? t0 : Date.now();
  const d = dayOf(at);
  if (state.day !== d) {
    state.day = d;
    state.counts = {};
  }
  state.counts[String(gid)] = Number(state.counts?.[String(gid)] ?? 0) + 1;
  state.lastAt[String(gid)] = at;
  state.lastPeer[String(gid)] = String(peer ?? '');
  // ⚠️ 有人把 `text` 传在第三位时（老写法）⇒ 顺手把话也一起记下来，别把它当时间戳丢掉 ✓
  const maybeText = typeof now === 'string' ? now : '';
  text = String(text ?? '').trim() || maybeText;
  // ⚠️ 2026-10-13：记下**最近发过的原话**（只留 5 条）—— 下次拼提示词时摆给她看，
  //    提醒"别再问同一件事"（她跟同一个号的对话就那么几个话题，不摆出来会天天问同一句）。
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t) {
    // ⚠️⚠️ 2026-10-15 加（用户截图：她 @Anon「周末有空吗，陪我去趟秋叶原」，
    //    Anon 回「祥祥你主动约我？」，**她下一句却否认说自己没约** ✗）——
    //    真因：同类搭话是**她主动发**的，那句话**压根没进群聊上下文** ⇒
    //    下一轮 Anon 提起时，她**不记得自己说过**，只能否认，甚至现编一句 ✗
    //    ⇒ 发出去之后，按「我自己说的」记进上下文（`rememberBot`）——
    //      跟主聊天回复一个待遇 ✓（`recent` 那边早就说了：不记自己的发言，
    //      模型就不知道上一句自己说了什么 ✗）
    try {
      recent.rememberBot({ message_type: "group", group_id: String(gid) }, String(text ?? ""), "");
    } catch (e) {
      log.debug(`[同类] 搭话没记进上下文：${e.message}`);
    }

    state.lastTexts ??= {};
    const k = String(gid);
    const arr = Array.isArray(state.lastTexts[k]) ? state.lastTexts[k] : [];
    arr.push(t.slice(0, 60));
    state.lastTexts[k] = arr.slice(-5);
  }
  save();
}

/**
 * ⚠️⚠️ 2026-10-13 加（用户要求）：
 *
 *   「另外机器人互相 @ 的消息**不一定**要全部由群里的消息生成，也可以和**随机事件**
 *     一样**自己生成**，比如 saki@爱音出去玩，或者一起去干什么其他事情，
 *     或者问爱音一些**自己想了解的**、关于爱音的事情」。
 *
 *   原来提示词里钉着「✅ 接着上面那些话说 —— …… **别自己编一件不相干的事**」
 *   ⇒ 她只会承接群里的话题，永远不会自己起个头 ✗
 *   ⇒ 现在**两种来源都允许**，由 `peerChat.selfTopicChance`（默认 0.5）随机决定这次走哪种：
 *     · `reply` —— 承接群里刚才的话（老行为）；
 *     · `self`  —— **自己起一个**：约对方出去玩 / 一起干点什么 / 问一件自己想知道的关于对方的事。
 *
 *   ⚠️ 放宽的只是**内容来源** —— **频率不变**（还是冷场 + 冷却 30 分钟 + 每日上限），
 *     所以不会变成两个机器人整天互相约饭。
 */
export const SELF_TOPIC_ROLLS = Object.freeze([
  '约她一起出去玩：去哪儿、什么时候、看什么吃什么（**说得随意一点，别像在排行程**）',
  '约她一起干点什么：练琴 / 排练 / 买东西 / 看演出 / 顺路走一段',
  '问她一件**你自己想知道的、关于她的事**：最近在忙什么、练得怎么样、喜欢什么、某件事她怎么看',
  '说一句**你自己的事**（今天干了什么、碰上什么），让她接',
  '吐槽一句，或者顺着你们俩那条"不太对付、又有点在意"的线撩一下',
  /* ⚠️⚠️⚠️ 2026-11-12 **删掉了原来那条「往今晚/待会儿撩她一句（带荤）」** ——
   *    2026-11-08 只给它加了前置条件「仅当你们俩刚才抬过杠」，但那条**永远不成立**：
   *    走"自己起头"的前提就是 `peerSaid` 为空（对方刚才没说话），哪来的"刚才抬过杠" ⇒
   *    条件等于没写，它照样每次往荤上撩 ✗
   *    现场（同一个群，09:33 / 10:03 / 10:33 连发三条）：
   *      「半夜闲得慌，想看你会不会脸红嘛」
   *      「脸红没红你自己心里没数吗，还反过来说我呀」
   *      「那今晚别急着闭眼呀，视频那头我可没打算让你好睡哦」
   *    ⇒ 用户原话：「**老是发这种啊，而且完全没有来由**」
   *    ⇒ **自己起头这一路彻底不许荤**：要荤只能出现在"接她刚才那句话"的时候（那里才有由头）✓
   */
]);

/** 把模型吐出来的东西清成「能直接发的一句」（去 @、去引号、掐长度） */
function cleanPeerText(s) {
  return String(s ?? "")
    .replace(/@\S{1,24}/g, "")
    .replace(/^[「『"']|[」』"']$/g, "")
    // ⚠️ 2026-11-06 加：结尾残留的**半个左括号**清掉 ——
    //    实测生成过「今晚要不要过来睡，我都把被子让出一半了（」，那个「（」发进群
    //    就是个**话没说完的坏符号**（模型爱用它表示"欲言又止"）✗
    //    ⚠️ 只去**结尾**的，句中正常的「（笑）」不碰 ✓
    .replace(/[（(]+$/g, "")
    .trim()
    .slice(0, 60);
}

/**
 * 这句话**能不能发**（2026-10-15 加）。
 *
 * ⚠️ 用户报的原话：「**看看为什么就发一个点**」—— 实测她 @ 了对方，
 *    正文只有「（.）」✗ ⇒ 抠掉标点 / 符号 / 空白之后**至少得剩 3 个字**，
 *    而且里面得有中文（别是纯符号、也别是别国语言）✓
 */
function peerTextOk(s) {
  const t = String(s ?? "").replace(/[\s\p{P}\p{S}]/gu, "");
  return t.length >= 3 && /[\u4e00-\u9fa5]/.test(t);
}

/** 生成那句话（开场白）—— **模型按当下情况现想**（用户拍板） */
export async function compose(gid, peer, idleMs, timeoutMs = 25000, opts = {}) {
  const name = names.of(peer, gid) || String(peer);
  const ctx = String(recent.contextText(gid) ?? '').slice(0, 2500);
  const mins = Math.max(1, Math.round((Number(idleMs) || 0) / 60000));
  // ⚠️⚠️ 2026-10-13：这次是「承接群话题」还是「**自己起个头**」（见上面 SELF_TOPIC_ROLLS 的注释）。
  //    `opts.rng` / `opts.phrase` 只是**为了让套件能离线测**（不起模型、不联网），
  //    生产调用方一个都不传 ⇒ 走 Math.random 和真模型 ✓
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const ask = typeof opts.phrase === 'function' ? opts.phrase : phrase;
  const selfChance = Math.min(1, Math.max(0, nz(cfg().selfTopicChance, 0.5)));
  // ⚠️ 2026-10-15 加（用户报「**就发一个点**」）：群里**没什么可接的话**的时候，
  //    必须走「自己起个头」那条路 —— 不然模型硬憋，实测憋出过一个「（.）」✗
  // ⚠️ 2026-10-15 注意：这里**故意不看**"群里有没有话可接" ——
  //    一度想"没话可接就强制自己起头"，但那会**干掉 `selfTopicChance: 0` 的回退**
  //    （用户想永远承接时就没法退了）✗ ⇒ 兜底放在下面那道"生成不成句就重试"里 ✓
  /* ⚠️⚠️ 2026-11-06 改（用户：「**如果冷场的话应该去接同类的话，而不是自己新开话题**」）——
   *   原来是 `rng() < selfChance`（默认 **0.5**）⇒ **一半概率凭空开一个新话题**。
   *   现场就是这样：她 10:51 跟 Anon 说过一句，11:26 又冒出「周六那事，你没忘吧」，
   *   两句之间没有任何关系，看着就是各说各的 ✗
   *   ⇒ 现在**先看它刚才有没有说话**：
   *     · 说了 ⇒ **必须接着它那句说**（不掷骰，连"自己起头"的选项都不给）
   *     · 没说（隔了很久 / 这个群一直没它的话）⇒ 才允许自己起个头 ✓
   */
  const peerSaid = (() => {
    try {
      return recent.lastFromUid(gid, peer, 3).map((t) => t.slice(0, 80));
    } catch {
      return [];
    }
  })();
  const self = peerSaid.length ? false : rng() < selfChance;
  /* 承接那一段：**把它的原话直接摆出来**。
   * ⚠️ 原来这里只写「接着上面那些话说」—— 太笼统，实测它就是会另起一个话题 ✗ */
  const relayBlock = peerSaid.length
    ? [
        `⚠️⚠️ **「${name}」刚才亲口说了下面这几句 —— 你要接着它的话说，别另起一个话题**：`,
        ...peerSaid.map((t) => `· 「${t}」`),
        '',
        '· ✅ 接它那句：回它、反驳它、顺着它往下说、或者问它话里那件事，都行；',
 // ⚠️ 2026-11-06：「**对面可以害羞或者傲娇地答应，最好不拒绝**」
        '· ✅ **它那句要是在撩你**（往床上的事上递话）⇒ 你可以脸红、可以傲娇地推回去，',
        '  **但别真拒绝**：嘴上推一把、实际应下来；🚫 「不行」「别闹」然后就没了 = 把这句断了 ✗',
        '  （说「不要」可以是撒娇、可以是嘴硬，但不能是那个意思上的关门）；',
        '· 🚫 **别换话题** —— 突然说起一件跟它这几句无关的事，那就是各说各的 ✗',
        '· 🚫 **别复述它的话**（那不是接话，是复读）。',
      ].join('\n')
    : '⚠️ 接着群里刚才那些话说 —— 提一句刚才聊到的人或事。';
  const roll =
    SELF_TOPIC_ROLLS[Math.floor(rng() * SELF_TOPIC_ROLLS.length) % SELF_TOPIC_ROLLS.length];
  const lastTexts = (state.lastTexts?.[String(gid)] ?? []).slice(-3);
  const user = [
    `【现在的情况】群里已经 **${mins} 分钟**没人说话了。`,
    `你想找「${name}」搭一句 —— 就说**一句**，短一点。`,
    '',
 // ⚠️⚠️ 2026-11-06：「**增加一点女同之间会说的话**」「**要突出色色的感觉，
    //    而且要是带一点玩笑意味的，要不然就搞得和老夫老妻一样**」——
    //    ⚠️ 这条**故意放在最前面**：实测放在中后段时，被后面一堆"别写小作文/别客服腔"
    //    的约束压住，生成出来还是「今晚别睡太早，我过去找你」那种**通知口吻** ✗
    //    ⇒ 前置 + 明确"什么样的算失败"，才压得住 ✓（下面 372 行那段是详细说明）
    /* ⚠️⚠️⚠️ 2026-11-08 改（用户：「**bot 互相在群里发的那个有点过于频繁了，而且没有来由，
     *    很奇怪。应该她们聊着遇到冲突或者拌嘴的时候再合理地引出来**」，
     *    随后又明确「**我只针对荤味引导说的话，其他不变**」）——
     *
     *    原来这两段荤味引导是**每次搭话都注入** ⇒ 不管有没有由头，
     *    它都被往"今晚那事"的方向推 ⇒ 群里看着就是"动不动就开荤、还莫名其妙" ✗
     *    ⇒ **只改荤味这一块**：荤话只在「你俩正顶着」的时候才用；
     *      平时（正常聊天 / 商量事）**一句都不许往那引** ✓
     *    ⚠️ 触发时机、频率、每日上限、自己起头那套 —— **一个字都没动**（用户：其他不变）✓
     */
    /* ⚠️⚠️⚠️ 2026-11-12：**加了 `peerSaid.length`** —— 荤味引导只在"接她刚才那句话"时才给，
     *    走"自己起头"那一路（对方刚才根本没说话）时**一句都不给**。
     *    原来两处都是无条件注入 ⇒ 每半小时一句「今晚别急着闭眼呀」（见上面 SELF_TOPIC_ROLLS 的注释）✗
     */
    config.llm?.unfiltered === true && peerSaid.length
      ? [
          '⚠️⚠️ **荤话不是每句都要带 —— 先判这一条**：',
          '· 刚才那几句里你俩**有摩擦**（抬杠 / 互不相让 / 阴阳 / 抢话）',
          '  ⇒ 这会儿可以带点荤，**笑着怼回去**那种；',
          '· 刚才**没有摩擦**（正常聊天 / 在商量事 / 气氛正好）',
          '  ⇒ 🚫 **这次一句都别往那方面引**，就正常说话 ✓',
          '',
          '（下面这些是**决定要用荤的时候**才照的写法）',
          '⚠️⚠️ **那一句要有味道 —— 逗她、有点坏，不是正经安排**：',
          '· 写成「今晚别睡太早，我过去找你」这种 = **失败**（读着像约吃饭、像老夫老妻）；',
          '· 只说到「别想好好睡」这种**警告**也不够（那是威胁，不是撩）——',
          '  要把**你会对她做的那个动作说破一半**，让她听出是那种事；',
          '· ⚠️ **句末带个语气词**（哦 / 嘛 / 呀 / 咯 / 啦）—— ⚠️ **语气词就是「玩笑味」的来源**：',
          '  同一句狠话，加个语气词就是在逗她，不加就变成下通知；',
          '· 要的是**笑着说的那种下流话**：她听完会红脸、会骂你一句、会嘴硬地顶回来；',
          '· 只说半截、别把过程铺完；🚫 违禁词不写（会封号），意思到了就行。',
        ].join('\n')
      : '',
    '',
    // ⚠️⚠️ 2026-10-05 修（**第一次触发就翻车了**）：生成出了一句**俄语**
    //    （`очередь ещё не выстроилась — 你先说说打算拿什么插队`）——
    //    因为这里只给了人设文本，**没写"说中文"** ✗
    //    （主聊天那条路是靠 `buildSystemPrompt` 里那一堆约束压住的，包括语言。）
    //    ⇒ 在这儿把语言、标点、分寸都写死。
    '⚠️⚠️ **必须用中文说** —— 她平时在群里就是中文，🚫 一个外文词都别混进来。',
    '',
    // ⚠️ 2026-10-13：**自己起个头**那套 —— 不接群话题，方向随机给一个
    self
      ? [
          '⚠️⚠️ **这次不用接群里刚才的话题** —— 是你**自己**突然想找她。',
          '',
          '🎲 这次的方向（**挑一个**，别全用）：',
          `· ${roll}`,
          '',
          '· ✅ 可以是「约她出去玩 / 一起去干什么」，也可以是「问她一件你自己想知道的、关于她的事」；',
          '· ⚠️ **贴着你们俩的关系**写（人设里写着你怎么看她 —— 别写成对谁都一样的口气）；',
          '· 🚫 别写成通知、别把时间地点排得像日程表；',
          '· 🚫 别打听得太直接（不是采访，是随口问一句）。',
        ].join('\n')
      : [relayBlock, '', '⚠️ 就一句（**8~20 字**），像群里随口搭话：'].join('\n'),
    '',
    ctx ? `【群里刚才是这么聊的】\n${ctx}` : '（群里最近没什么可接的话）',
    '',
    // ⚠️ 2026-10-13：最近已经说过的那几句摆出来 —— 她跟同一个号的对话就那么几件事，
    //    不摆出来会天天问同一句（实测过「你今天怎么样」连着一周）。
    lastTexts.length
      ? `⚠️ 你最近已经找过她这些（**别再问同一件事、也别用同样的句式**）：\n${lastTexts
          .map((t) => `· ${t}`)
          .join('\n')}`
      : '',
    self ? '⚠️ 就一句（**8~20 字**），像随手发来的一句。' : '',
    // ⚠️ 2026-11-06 加（用户：「**增加一点女同之间会说的话**」+「**收拾/熬/折腾还是太模糊了**」）——
    //    ⚠️ 只给**落点和尺度**，不给能照抄的句子（项目铁律：写死她就照念、两个号还会撞同一句）✓
    // ⚠️⚠️ 2026-11-08（用户：「**我只针对荤味引导说的话，其他不变**」）：
    //    这一段也是**每次搭话都注入**的，同样改成**只在有摩擦时**才生效 ——
    //    否则它天天教它"拿夜里的事互相撩"，就成了"没来由地开荤" ✗
    config.llm?.unfiltered === true && peerSaid.length
      ? [
          '⚠️ 这一段**只在上面判过"你俩有摩擦"时才用**；没摩擦就别照它写 ✓',
          '（用的时候：你俩不只是同伴，是**会开荤腔、会拿夜里的事互相撩**的那种关系）',
          '· ✅ **落点落在「今天 / 今晚 / 待会儿」**这种马上就到的时刻；',
          '· ⚠️⚠️ **口气是「嘴上占便宜」，不是郑重约定** —— 写成「今晚别睡太早，我过去找你」那种，',
          '  读起来跟约吃饭喝水一样、还像老夫老妻 ✗；要**带笑、有点坏、逗她**；',
          '· ⚠️⚠️ **要让人一听就知道在说什么**：含糊到像约饭 / 约睡 = 失败；',
          '  可以笑着把话说破一半，但**话必须轻**，像逗她不像下通知；',
          '· ✅ 可以点到她身上，**说半截就停**（剩下的让她自己脑补），别把过程铺完；',
          '· 🚫 群里是当着别人的面说给**她一个人**听的 ⇒ **狠在口气，不在细节**；',
          '· 🚫 违禁词不写（会封号），意思到了就行。',
          '· 🔁 **自检**：① 现在这句要是带荤，她是"顶回来"还是"被吓一跳"？后者 ⇒ 重写；',
          '  ② 没摩擦却带了荤 ⇒ **这次别带** ✓',
        ].join('\n')
      : '',
    '· 🚫 别写小作文、别连着说两三句；',
    '· 🚫 别用「在吗」「你好」这种客服腔；',
    '· 🚫 别用破折号（——）、别用书面标点；',
    '· 🚫 别解释「我为什么找你」；',
    `· 🚫 **别提她名字**（「${name}」这三个字不用写）—— @ 由代码加，你写了就重复了。`,
    // ⚠️⚠️ 2026-10-20 加（用户：「为什么老是说『她怎么怎么样』，而不是直接说『你怎么怎么样』」）：
    //    上面那些"找她 / 约她"是**给她的说明**，但输出那句话是**对着对方说的** ⇒
    //    称呼必须是「你」。实测漏了这条时，生成出来是「问她周末有没有空」这种转述口气 ✗
    '· ✅ **那句话是直接对她说的话 ⇒ 称呼用「你」**（「你周六有空吗」「你最近练得怎么样」）。',
    '· 🚫 别用「她 / 他 / 对方」指代她（那是跟第三方谈论的口气 ✗）。',
    '直接给那句话本身 —— 🚫 **不要自己加 @**（@ 由代码来加）。',
  ]
    .filter(Boolean)
    .join('\n');

  const out = await ask({ system: personaText(), user, maxTokens: 120, timeoutMs });
  let text = cleanPeerText(out);
  // ⚠️⚠️ 2026-10-15 加（用户报：「**看看为什么就发一个点**」）——
  //    实测她 @ 了对方，正文只有「（.）」✗ 而且这种事**根本不该发出去**：
  //    宁可这次不搭话，也不能在群里 @ 一个人然后只发个句号。
  //    ⇒ ① 先按「自己起个头」重来一次（多半是"群里没话可接"憋出来的）；
  //       ② 还不成句就**返回空**（调用方会报"没生成出内容"，不会把垃圾发出去）✓
  if (!peerTextOk(text)) {
    /* ⚠️ 2026-11-06 改：重试**不能无脑换成"自己起个头"** —— 这一轮本来就是承接，
     *   换成就等于又开了个新话题（正是用户要修的那个毛病）✗
     *   ⇒ 它刚才说过话 ⇒ **还用承接重试**，只要求更短 ✓ */
    const retrySelf = !peerSaid.length;
    log.warn(
      `[同类] 生成的内容不成句（「${text}」）→ 换成「${
        retrySelf ? '自己起个头' : '接着它那句'
      }」再试一次`,
    );
    const retryRoll =
      SELF_TOPIC_ROLLS[Math.floor(rng() * SELF_TOPIC_ROLLS.length) % SELF_TOPIC_ROLLS.length];
    const retryUser = (
      retrySelf
        ? [
      `【现在的情况】你想找「${name}」搭一句 —— 就说**一句**，短一点。`,
      "",
      "⚠️⚠️ **必须用中文说** —— 她平时在群里就是中文，🚫 一个外文词都不许混进来。",
      "",
      "⚠️ **这次不用接群里刚才的话题** —— 是你自己突然想找她。",
      "",
      "🎲 方向（**挑一个**）：",
      `· ${retryRoll}`,
      "",
      "· ⚠️ **贴着你们俩的关系**写（人设里写着你怎么看她）；",
      "· ✅ 像「约她出去玩 / 一起去干什么」或者「问一件你自己想知道的、关于她的事」都行；",
      "· 🚫 别写成通知、别把时间地点排得像日程表、别打听得太直接；",
      "· 🚫 别提她名字、别自己加 @（@ 由代码加）。",
      "直接给那句话本身。",
        ]
        : [
      `【现在的情况】群里冷场，你想接「${name}」刚才那句话。`,
      "",
      "⚠️⚠️ **必须用中文说** —— 她平时在群里就是中文，🚫 一个外文词都不许混进来。",
      "",
      relayBlock,
      "",
      "· ⚠️ **这次必须比上次更短**（**6~15 字**），直接说那句话，别铺垫；",
      "· 🚫 别提她名字、别自己加 @（@ 由代码加）。",
      "直接给那句话本身。",
        ]
    ).join("\n");
    text = cleanPeerText(await ask({ system: personaText(), user: retryUser, maxTokens: 120, timeoutMs }));
    if (!peerTextOk(text)) {
      log.warn("[同类] 两次都没生成出成句的内容 → 这次不搭话（不发垃圾）");
      return "";
    }
  }
  return text;
  return String(out ?? '')
    .replace(/@\S{1,24}/g, '')
    .replace(/^[「『"']|[」』"']$/g, '')
    .trim()
    .slice(0, 60);
}

/**
 * 跑一轮检查（定时器调它）。**只在真的发出去之后才记账**。
 * @param {{sendToGroup:Function, selfId?:string}} bot
 */
export async function tick(bot, now = Date.now()) {
  if (!bot?.selfId) return { ok: false, reason: 'QQ 没在线' };
  const groups = (() => {
    try {
      return life.targetGroups();
    } catch {
      return [];
    }
  })();
  for (const gid of groups) {
    // ⚠️⚠️ 2026-10-07 加（用户原话：「**发了清除剧情应该强制 bot 停发消息一分钟**，
    //    要不然她们会接着上文继续聊」）：
    //    这个群在静默期 ⇒ **连主动搭话 / 戳一戳也不做**。
    //    ⚠️ 这一条不能省：`tick()` 是**定时任务**，走的是 `sendToGroup` 直发，
    //      **不经过 `decide()`** —— 只在 `bot.decide()` 那边拦的话，
    //      静默期里她照样会主动戳同类，那就不叫"停发消息"了。
    if (bot.isMuted?.(gid)) {
      log.info(`[同类] 群 ${gid} 在静默期（清剧情之后那一分钟）→ 这次主动搭话跳过`);
      continue;
    }
    /* ⚠️⚠️ 2026-11-06 加（用户：「**为什么她们互相的对话完全没有关联，在各说各的**」）
     *
     *   现场（群 200000001，2026-11-06 一整天）：
     *     10:51 她主动找 Anon「那家店要是不好吃，我可不替你兜着啊」
     *     11:10 Anon 回「你那条消息是不是打到一半就发出去了呀」
     *     11:26 她**完全没接那句**，自己又开一个新话题「周六那事，你没忘吧」
     *   两处日志写着同一个原因：
     *     [同类] ⚠️ 硬闸：两个机器人已刷到 12+12 条 / 7842 秒（真人 0 条） → **直接静默**
     *
     *   那个群整天真人 0 条、只有两个机器人在说 ⇒ 硬闸判"刷屏"⇒ **对方 @ 她也不回**；
     *   可**主动搭话走的是这条路**（`sendToGroup` 直发，不经过 `decide()`）——
     *   硬闸根本挡不住它 ⇒ 一边闭嘴、一边不停开新话题 ⇒ 看起来就是各说各的 ✗
     *
     *   ⇒ 硬闸已经判"这个群只剩机器人在刷"时，**主动搭话也停** ✓
     *     （跟上面静默期同一条道理：定时任务绕过了 `decide()`，就得在这里自己拦）
     *   ⚠️ `botChainHard()` 是**纯查询**（只读条数、命中时打一行日志），调它不改任何状态 ✓
     */
    if (bot.botChainHard?.(gid)) {
      log.info(`[同类] 群 ${gid} 已刷到"只剩两个机器人"的硬闸 → 这次主动搭话跳过（别再各说各的）`);
      continue;
    }
    const peers = peersOf(gid);
    if (!peers.length) continue;
    const lastMsgAt = (() => {
      try {
        return recent.lastAt(gid);
      } catch {
        return 0;
      }
    })();
    const v = shouldPing(now, gid, lastMsgAt);
    if (!v.ok) {
      log.debug(`[同类] 群 ${gid} 这次不找：${v.reason}`);
      continue;
    }
    const peer = pickPeer(gid, v.peers);
    if (!peer) continue;

    // ⚠️ 2026-10-05 补（用户原话：「**有时候还可以主动去戳池里的机器人**」）：
    //    按 `peerChat.pokeChance`（默认 0.3）随机决定这次是**戳一下**还是**说一句**。
    //    ⚠️ 戳比说话更容易激起对方回应（它的戳处理是"必须回"）——
    //      所以这个概率**别调高**：配上"冷却 30 分钟 + 每日上限 4 次"，
    //      一天最多也就戳一两次，不会变成两个机器人在那儿互戳。
    const pokeChance = Math.min(1, Math.max(0, nz(cfg().pokeChance, 0.3)));
    if (Math.random() < pokeChance) {
      try {
        await bot.call('send_poke', { user_id: peer, group_id: gid });
        // ⚠️⚠️ 2026-10-05 修（用户截图：**她自己不知道自己在戳**）：
        //    `send_poke` 是**裸调用**，不像 `sendChatLike` 会自己写上下文 ⇒
        //    群里显示「saki 戳了戳 大肥鱼」，而她上下文里**没有这条** ⇒
        //    对方说「还戳上瘾了呀」，她回「还赖我呀，明明是你手闲」——**她不知道那是自己干的** ✗
        //    ⇒ 把这次动作当**旁白**记一条（跟 `bot.js` 里"拍照"那处同一个道理）。
        try {
          recent.rememberBot(
            { message_type: 'group', group_id: gid },
            `（我戳了「${names.of(peer, gid) || peer}」一下）`,
          );
        } catch (e) {
          log.debug(`[同类] 记"我戳了他"失败（不影响发送）：${e.message}`);
        }
        note(gid, peer, now);
        log.info(`[同类] 群里冷场 → 她戳了「${names.of(peer, gid) || peer}」一下`);
        return { ok: true, gid, peer, poke: true };
      } catch (e) {
        log.warn(`[同类] 群 ${gid} 戳一戳失败（不记账，下次还能试）：${e.message}`);
        continue;
      }
    }

    let text = '';
    try {
      text = await compose(gid, peer, v.idleMs, Math.max(8000, nz(cfg().timeoutMs, 25000)));
    } catch (e) {
      log.warn(`[同类] 群 ${gid} 生成开场白失败：${e.message}`);
      continue;
    }
    if (!text) {
      log.info(`[同类] 群 ${gid} 没生成出开场白，这次算了`);
      continue;
    }
    try {
      await bot.sendToGroup(gid, text, { at: peer, atName: names.of(peer, gid) || '' });
      // ⚠️ 2026-10-13：把**原话**一起记下来（下次提示词里摆出来，别重复同一件事）
      note(gid, peer, now, text);
      log.info(`[同类] 群里冷场 → 她主动找「${names.of(peer, gid) || peer}」搭话：「${text}」`);
    } catch (e) {
      log.warn(`[同类] 群 ${gid} 发送失败（不记账，下次还能试）：${e.message}`);
    }
    return { ok: true, gid, peer, text };
  }
  return { ok: false, reason: '这轮没有该找的群' };
}

let timer = null;
/** 起定时器（`index.js` 里调；测试不调） */
export function start(bot) {
  if (timer) return timer;
  // ⚠️ 关掉时**压根不起定时器**（回归里就是这么干的，见 `enabled()` 的注释）
  if (!enabled()) {
    log.info('同类机器人搭话：已关闭（没有定时器）');
    return null;
  }
  const every = Math.max(60000, nz(cfg().checkIntervalMs, 5 * 60 * 1000));
  timer = setInterval(() => {
    tick(bot).catch((e) => log.warn(`[同类] 出错：${e.message}`));
  }, every);
  timer.unref?.();
  log.info(`同类机器人搭话：每 ${Math.round(every / 60000)} 分钟看一次（冷场 ${Math.round(nz(cfg().idleMs, 900000) / 60000)} 分钟才开口）`);
  return timer;
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 测试用：读状态 */
export function __stateForTest() {
  return state;
}
/** 测试用：重置 */
export function reset() {
  state = { day: '', counts: {}, lastAt: {}, lastPeer: {} };
  save();
}
