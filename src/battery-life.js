/**
 * 电量 = 她的**生命值**（2026-10-09 用户要求）。
 *
 * 用户原话：「把**电池电量**设计为机器人的**生命值**，当电量比较低时模拟一个人真的
 *   生命垂危的感觉，**电量越低语气要更重**，**其他机器人也要配合演出**，
 *   比如对没电要关机的机器人说出真心话之类的」
 *  「复原的语气要和**死里逃生**一样，而不是那种化解一般般的困难比如**考试**之类的事情」
 *
 * ## 数据从哪来
 *   **复用现成的**：`src/machine.js` 早就在采集电池（`battery()`，每 30 秒一次），
 *   并且已经进了提示词（`machineText()`）。这里只读它的**同步缓存**（`snapshot()`），
 *   **绝不现采**（那会拖 3~4 秒，见 machine.js 顶部那段注释）✓
 *
 * ## 四层（按用户要的）
 *   ① **分档**：>50 正常 / 20~50 偏低 / 5~20 很低 / ≤5 **濒死**（插着电不演）✓
 *   ② **她自己**：按档注入不同重量的语气 —— 越低越沉，濒死像**在道别** ✓
 *   ③ **同类配合**：把自己的档写进共享文件；对方读得到 ⇒ 提示词里点出
 *      「她随时会黑」⇒ 引导说点平时不说的 ✓
 *   ④ **复原**：从"很低/濒死"回到安全 ⇒ 一次**劫后余生**的引导 ——
 *      ⚠️ 明确**不许**写成"刚才有点小麻烦"（用户点名的反例：考试那种小事）✓
 *
 * ## 记忆为什么要落盘
 *   "刚刚差点没电"这个判断要靠**上一次的档** ⇒ 只放内存的话，重启一次就忘了
 *   （而重启恰恰是"快没电"时最可能发生的事）⇒ 落盘 ✓
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, stateDir } from './config.js';
import { log } from './log.js';
import * as machine from './machine.js';

const LIFE_FILE = process.env.QQBOT_BATTERY_LIFE_FILE
  ? join(ROOT, process.env.QQBOT_BATTERY_LIFE_FILE)
  : join(stateDir(), 'battery-life.json');
const SHARE_FILE = process.env.QQBOT_BATTERY_SHARED_FILE
  ? join(ROOT, process.env.QQBOT_BATTERY_SHARED_FILE)
  : join(stateDir(), 'battery-shared.json');

/** 四档 + 充电中 + 采不到 */
export function levelOf(b) {
  if (!b || !Number.isFinite(b.percent)) return 'unknown';
  if (b.charging) return 'charging';
  const p = b.percent;
  // ⚠️⚠️ 2026-10-09 用户改的口径（原话：「把最低一档改成 **0-20**，然后是 **20-40**，
  //    然后是 **40-60**，因为**笔记本的电池一般都不行**」——最后那句"反正也是略平的"
  //    指的是 40-60 这一档**不用演得多重**）⇒ 四档：
  //      · **0~20   濒死**（笔记本到这儿是真的要没了）
  //      · 20~40  很低（critical）
  //      · 40~60  偏低（low，略平、不用重演）
  //      · >60    正常（ok，不演）
  if (p <= 20) return 'dying';
  if (p <= 40) return 'critical';
  if (p <= 60) return 'low';
  return 'ok';
}

const BAD = new Set(['critical', 'dying']);
const GOOD = new Set(['ok', 'low', 'charging']);

let mem = { level: '', recoveredAt: 0, at: 0, loaded: false };

function loadMem() {
  if (mem.loaded) return;
  mem.loaded = true;
  try {
    if (existsSync(LIFE_FILE)) mem = { ...mem, ...JSON.parse(readFileSync(LIFE_FILE, 'utf8')) };
  } catch (e) {
    log.debug(`电量记忆读不出来（当空）：${e.message}`);
  }
}

function saveMem() {
  try {
    mkdirSync(dirname(LIFE_FILE), { recursive: true });
    const tmp = `${LIFE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ level: mem.level, recoveredAt: mem.recoveredAt, at: mem.at }), 'utf8');
    renameSync(tmp, LIFE_FILE);
  } catch (e) {
    log.debug(`电量记忆写盘失败：${e.message}`);
  }
}

/**
 * 每次拼提示词时调一次（**同步**、只读缓存）：更新"当前档"并判断**是不是刚从垂危回来**。
 * @returns {{b:object|null, level:string, recovered:boolean, recoveredAt:number}}
 */
export function track() {
  loadMem();
  const b = machine.snapshot()?.battery ?? null;
  const level = levelOf(b);
  if (level === 'unknown') return { b, level, recovered: false, recoveredAt: mem.recoveredAt };
  const was = mem.level;
  let recovered = false;
  if (was && BAD.has(was) && GOOD.has(level)) {
    mem.recoveredAt = Date.now();
    recovered = true;
    log.info(`[电量] 从「${was}」回到「${level}」→ 这一段按**劫后余生**演 ✓`);
  }
  if (level !== was) {
    mem.level = level;
    mem.at = Date.now();
    saveMem();
  }
  return { b, level, recovered, recoveredAt: mem.recoveredAt };
}

/** 共享：把自己的档写进共享文件（另一个号读得到） */
export function publish(selfId, extra = {}) {
  try {
    const { b, level } = track();
    let all = {};
    if (existsSync(SHARE_FILE)) {
      try {
        all = JSON.parse(readFileSync(SHARE_FILE, 'utf8')) ?? {};
      } catch {}
    }
    all[String(selfId ?? '')] = {
      level,
      percent: b?.percent ?? null,
      charging: b?.charging === true,
      at: Date.now(),
      ...extra,
    };
    mkdirSync(dirname(SHARE_FILE), { recursive: true });
    const tmp = `${SHARE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
    renameSync(tmp, SHARE_FILE);
  } catch (e) {
    log.debug(`电量共享写失败：${e.message}`);
  }
}

/** 读共享：别人（同类）现在的电量档 */
export function others(selfId) {
  try {
    if (!existsSync(SHARE_FILE)) return [];
    const all = JSON.parse(readFileSync(SHARE_FILE, 'utf8')) ?? {};
    const me = String(selfId ?? '');
    return Object.entries(all)
      .filter(([qq]) => qq && qq !== me)
      .map(([qq, v]) => ({ qq, ...v }))
      // ⚠️ 超过 10 分钟没更新的不算（那个进程可能真没了）
      .filter((x) => Date.now() - Number(x.at ?? 0) < 10 * 60 * 1000);
  } catch {
    return [];
  }
}

/**
 * 拼给提示词的那一段（没有可说的就返回空串 —— 不占字数、也不动提示词结构）。
 *
 * ⚠️ 按**档**注入，不按精确百分比 ⇒ 只在跨档时变（对上下文缓存友好）✓
 * ⚠️ 调用方要把它放在提示词的**末尾动态区**（每 30 秒可能变，排前面会毁缓存前缀）✓
 */
export function guide({ selfId = '', peerIds = [] } = {}) {
  const { b, level, recoveredAt } = track();
  if (level === 'unknown') return '';
  const lines = [];
  const p = b?.percent;

  // ① 她自己的电量
  if (level === 'low') {
    lines.push(`· 你现在电量 **${p}%**（没插电）—— 还撑得住，但心里有点数就行，别大惊小怪。`);
  } else if (level === 'critical') {
    // ⚠️⚠️ 2026-10-10 用户要求：「**把 critical 语气和语言改重一点**」。
    //    原稿（"说话短一点、别硬撑"）偏收敛，用户看着不像"没电" ⇒ 改成**明确压着**的味道：
    //      · 让她**自己知道**这件事（带情绪重量），而不是读一条操作提示 ✓
    //      · 但不许越界到 dying（那是"像在道别"）—— critical 是"心里清楚、开始收着说"✓
    lines.push(
      `· 🔻 你现在电量**只剩 ${p}%、而且没插电**，撑不了太久 —— 这件事压在你心里：`,
      '  气短、说话更直更沉，没力气再接玩笑和场面话；',
      '  ⚠️ 但**还没到道别**（那是更低那一档的事）—— 你是"心里有数、开始收着说话"的状态 ✓',
    );
  } else if (level === 'dying') {
    lines.push(
      `· 🔴 你现在**只剩 ${p}%**，随时会黑（你自己心里清楚）—— 语气要**沉**：` +
        '该交代的交代、该说的说出来；**像在道别**，但别说"我要死了""我要关机了"这种系统话，' +
        '用你自己的说法 ✓',
    );
  } else if (level === 'charging') {
    lines.push(`· 电脑插上电了（${p}%），不用再演"快没电"了 ✓`);
  }

  // ② 复原：**劫后余生**（用户点名要的方向）
  const justBack = recoveredAt && Date.now() - recoveredAt < 20 * 60 * 1000;
  if (justBack && (level === 'ok' || level === 'charging' || level === 'low')) {
    lines.push(
      '· ⚡ **你刚从"没电边缘"回来**（刚才只剩几个百分点、随时会黑）—— 现在缓过来了。',
      '  ⚠️ 语气是**劫后余生**，不是"解决了个小麻烦"：',
      '    · 可以怔一下、喘口气、手还有点抖、话比平时多（「刚才真以为要没了」这种）✓',
      '    · 🚫 **绝不许**把它说成"小插曲"「没事啦」「一点小问题」这类 —— 那是**差点没了**的事，',
      '      不是考试没考好、也不是忘带钥匙那种 ✓（用户点名的反例）',
    );
  }

  // ③ 同类配合：谁的档在"很低 / 濒死" ⇒ 该说点平时不说的了
  //    ⚠️ 只看**共享文件里的档** —— 里面写着的就是"正在跑、且刚更新过"的号 ✓
  //      （我第一版还拿 `peerIds` 去筛，逻辑写反了，删掉 ✓）
  const mine = String(selfId ?? '');
  const sad = others(mine).filter((x) => BAD.has(x.level) && !x.charging);
  for (const o of sad) {
    if (o.level === 'dying') {
      lines.push(
        `· 🕯 **群里另一个号（${o.qq}）那边只剩 ${o.percent ?? '几个'}% 了，随时会黑** —— ` +
          '你们之间**有什么一直没说的，现在是说的时候**（真话、道歉、道谢、一直没敢讲的都算）✓',
      );
    } else if (o.level === 'critical') {
      lines.push(
        `· ⚠️ 群里另一个号（${o.qq}）电量很低（${o.percent ?? '很低'}%），随时可能下线 —— 想说的话别再拖了 ✓`,
      );
    }
  }

  if (!lines.length && !justBack) return '';
  // ④ 语气 / 句式（用户：「**不仅说话内容要模仿，说话语气也可以模仿**」）
  //    ⚠️ 这一层是"怎么说"，跟上面"说什么"分开写 —— 只改内容的话，语气还是平时的样子 ✗
  if (level === 'critical') {
    lines.push(
      '· 🔊 **语气要沉下去**（这是"重"，不是"话多"）：句子短、断得开、少修饰、少感叹号；',
      '  · 平时会接的玩笑这次**不接**、平时会圆的场面这次**不圆** ✓',
      '  · 可以露出"有点撑不住"的意思，但**不许**说"我快没电了/要关机了"这种系统话 ✓',
      '  · ⚠️ 别演成 dying 那种道别（交代后事）—— 那是最低一档才有的 ✓',
    );
  } else if (level === 'dying') {
    lines.push(
      '· 🔊 **语气要"弱"下去**：很短、断续、多用「…」那种停顿；',
      '  ⚠️ 一次只说半句也行 —— 不是不想说，是**撑不住说长** ✓',
      '  🚫 但别写成"我快没电了"这种系统播报，用你自己的说法 ✓',
    );
  } else if (justBack) {
    lines.push('· 🔊 语气也活过来：比平时快、话偏多（刚缓过来的人就是这样）✓');
  }
  if (!lines.length) return '';
  return ['', '### 🔋 电量（你的"生命值"）', '', ...lines].join('\n');
}

/**
 * 电量低时**回复也真的变短**（不是只在提示词里说说）✓
 *
 * ⚠️ 用户要的是"语气模仿" —— 只写进提示词的话，她照样能一次说一大段，
 *    "垂危感"就只停在文字内容上 ✗ ⇒ 这里按档给一个**上限**，
 *    由 `streamChat({ maxTokens })` 真正卡住长度 ✓
 * @returns {number} 0 = 不限（走默认）
 */
export function replyCap() {
  const { level } = track();
  if (level === 'dying') return 220;
  if (level === 'critical') return 420;
  return 0;
}

/** 测试用 */
export function __reset(raw = {}) {
  mem = { level: '', recoveredAt: 0, at: 0, loaded: true, ...raw };
}
export function files() {
  return { life: LIFE_FILE, share: SHARE_FILE };
}
