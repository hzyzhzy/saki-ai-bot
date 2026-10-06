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
 *   · 开场白**由模型按当下情况现想**（用户 2026-10-05 拍的），不是固定几句里挑。
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
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
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

  const cool = Math.max(60000, nz(cfg().cooldownMs, 30 * 60 * 1000));
  const last = Number(state.lastAt?.[String(gid)] ?? 0);
  if (now - last < cool) {
    return { ok: false, reason: `还在冷却（${Math.ceil((cool - (now - last)) / 60000)} 分钟后才行）` };
  }

  const cap = Math.max(1, nz(cfg().maxPerDay, 4));
  const used = dayOf(now) === state.day ? Number(state.counts?.[String(gid)] ?? 0) : 0;
  if (used >= cap) return { ok: false, reason: `今天已经找过 ${used} 次了` };

  return { ok: true, peers, idleMs };
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

/** 记一次"主动过了"（冷却 + 当日计数），供发送成功后调用 */
export function note(gid, peer, now = Date.now()) {
  const d = dayOf(now);
  if (state.day !== d) {
    state.day = d;
    state.counts = {};
  }
  state.counts[String(gid)] = Number(state.counts?.[String(gid)] ?? 0) + 1;
  state.lastAt[String(gid)] = now;
  state.lastPeer[String(gid)] = String(peer ?? '');
  save();
}

/** 生成那句话（开场白）—— **模型按当下情况现想**（用户拍板） */
export async function compose(gid, peer, idleMs, timeoutMs = 25000) {
  const name = names.of(peer, gid) || String(peer);
  const ctx = String(recent.contextText(gid) ?? '').slice(0, 2500);
  const mins = Math.max(1, Math.round((Number(idleMs) || 0) / 60000));
  const user = [
    `【现在的情况】群里已经 **${mins} 分钟**没人说话了。`,
    `你想找「${name}」搭一句 —— 就说**一句**，短一点。`,
    '',
    // ⚠️⚠️ 2026-10-05 修（**第一次触发就翻车了**）：生成出了一句**俄语**
    //    （`очередь ещё не выстроилась — 你先说说打算拿什么插队`）——
    //    因为这里只给了人设文本，**没写"说中文"** ✗
    //    （主聊天那条路是靠 `buildSystemPrompt` 里那一堆约束压住的，包括语言。）
    //    ⇒ 在这儿把语言、标点、"别自己编一件不相干的事"都写死。
    '⚠️⚠️ **必须用中文说** —— 她平时在群里就是中文，🚫 一个外文词都不许混进来。',
    '',
    ctx ? `【群里刚才是这么聊的】\n${ctx}` : '（群里最近没什么可接的话）',
    '',
    '⚠️ 就一句（**8~20 字**），像群里随口搭话：',
    '· ✅ **接着上面那些话**说 —— 提一句刚才聊到的人或事，别自己编一件不相干的事；',
    '· 🚫 别写小作文、别连着说两三句；',
    '· 🚫 别用「在吗」「你好」这种客服腔；',
    '· 🚫 别用破折号（——）、别用书面标点；',
    '· 🚫 别解释「我为什么找你」；',
    `· 🚫 **别提他名字**（「${name}」这三个字不用写）—— @ 由代码加，你写了就重复了。`,
    '直接给那句话本身 —— 🚫 **不要自己加 @**（@ 由代码来加）。',
  ].join('\n');

  const out = await phrase({ system: personaText(), user, maxTokens: 120, timeoutMs });
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
      note(gid, peer, now);
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
