/**
 * API 余额（= 小祥的「工资」）。
 *
 * ⚠️ 需求来源（用户 2026-09-13）：
 *   「把余额和祥子的工资设定结合到一起，**如果低于5块钱抱怨一次，低于2块钱再抱怨一次**，
 *    然后把**余额不足警告也改了**」
 *
 * 设计要点：
 *   · 余额在提示词里就是「**小祥的工资**」—— 快见底了就该有反应
 *     （她人设是个手头紧的大小姐，这个梗很贴）
 *   · **每个档位只抱怨一次**（不按时间冷却，按档位）——
 *     否则余额停在 4.9 元会每次说话都抱怨，那比故障本身还烦
 *   · 状态**落盘**：重启不会把"已经抱怨过了"忘掉
 *     （踩过这个坑：`digest.lastPosts` / `qzone.today` 都因为只在内存里
 *      导致重启后重复发；见 AGENTS.md 铁律②）
 *   · 真·余额耗尽（HTTP 402）也走这套话术，不再甩「⚠️ API 余额不足」给群友
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './log.js';
import * as llm from './llm.js';
// ⚠️ 2026-09-21：她**怎么称呼主人**从 `identity.address` 来 ——
//    这里原来写死「<主人>」，换人设后她会继续点名旧主人。
import * as persona from './persona.js';

// ⚠️ 测试/预览可以用 `QQBOT_BALANCE_FILE` 指向临时文件 ——
//    这样能演示不同档位的话术，又**不会**动到真实的"已抱怨"状态
//    （那个状态脏了就会导致该提醒的不提醒 / 重复提醒）。
const FILE = process.env.QQBOT_BALANCE_FILE
  ? join(ROOT, process.env.QQBOT_BALANCE_FILE)
  : join(ROOT, 'state', 'balance.json');

/**
 * 抱怨档位（从低到高判断）—— 阈值可配（`config.balance.critical` / `.low`）。
 *
 * ⚠️⚠️ 2026-09-15 晚：用户要求「**先把 5 块钱的额度提醒藏在代码里**，
 *    只留下 2 块钱 @ 提醒即可」（原因：最近花得太快）。
 *    → `config.balance.low: 0` 就是**关掉偏低档**：代码留着，
 *      把 0 改回正数（或删掉这一项）立刻恢复。
 */
function tiers() {
  const b = config.balance ?? {};
  const crit = Number(b.critical) > 0 ? Number(b.critical) : 2;
  const low = Number(b.low) === 0 ? 0 : Number(b.low) > 0 ? Number(b.low) : 5;
  const list = [{ key: 'critical', below: crit, label: '见底' }];
  if (low > 0) list.push({ key: 'low', below: low, label: '偏低' });
  return list;
}

/** 当前生效的档位（给启动日志/界面看：偏低档被 `balance.low: 0` 关掉时会少一档） */
export function tierInfo() {
  return tiers().map((t) => ({ ...t }));
}

/**
 * { last: {balance, at}, complained: { critical, low },
 *   complainedByGroup: { "<群号>": { critical, low } } }
 *
 * ⚠️ 2026-09-15 晚加 `complainedByGroup`：**提醒是挨个 1 档群发的，标记也必须按群记**。
 *    原来只有一个全局标记 → 第一个群收到提醒后，**别的群再也收不到**
 *    （<主人> 报的「699 开头这个群好像不会发送余额报警信息」就是这个）。
 */
let state = { last: null, complained: {}, complainedByGroup: {} };

try {
  if (existsSync(FILE)) {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    state = {
      last: j.last ?? null,
      complained: j.complained ?? {},
      complainedByGroup: j.complainedByGroup ?? {},
    };
  }
} catch (e) {
  log.debug(`载入余额状态失败：${e.message}`);
}

function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, FILE);
  } catch (e) {
    log.debug(`保存余额状态失败：${e.message}`);
  }
}

/**
 * 查一次余额（DeepSeek 的 `/user/balance`）。
 *
 * @returns {Promise<{ok:boolean, total?:number, currency?:string, error?:string}>}
 */
export async function fetchBalance() {
  const llm = config.llm ?? {};
  if (!llm.apiKey) return { ok: false, error: '没配 apiKey' };
  const base = String(llm.baseURL ?? 'https://api.deepseek.com/v1').replace(/\/v1\/?$/, '');
  try {
    const r = await fetch(`${base}/user/balance`, {
      headers: { Authorization: `Bearer ${llm.apiKey}` },
      signal: AbortSignal.timeout(Number(config.balance?.timeoutMs) > 0 ? Number(config.balance.timeoutMs) : 15000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = await r.json();
    const info = Array.isArray(j?.balance_infos) ? j.balance_infos[0] : null;
    if (!info) return { ok: false, error: '返回里没有 balance_infos' };
    const total = Number(info.total_balance);
    if (!Number.isFinite(total)) return { ok: false, error: 'total_balance 不是数字' };
    state.last = { balance: total, currency: String(info.currency ?? 'CNY'), at: Date.now() };
    // ⚠️ 余额**涨回到档位以上**就把"抱怨过"重置 ——
    //    这样充值之后再掉下来，它会再抱怨一次（合理的）
    for (const t of tiers()) {
      if (total >= t.below) state.complained[t.key] = false;
    }
    // ⚠️ **按群那些标记也要一起重置**（2026-09-15 晚加）——
    //    只重置全局那份的话，充值之后再掉下来，各个群反而不会提醒了。
    for (const gid of Object.keys(state.complainedByGroup ?? {})) {
      for (const t of tiers()) {
        if (total >= t.below) state.complainedByGroup[gid][t.key] = false;
      }
    }
    save();
    return { ok: true, total, currency: String(info.currency ?? 'CNY') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 上次查到的余额（可能是旧的） */
export function lastBalance() {
  return state.last;
}

/** 重新从盘上读状态（预览/测试用） */
export function reload() {
  try {
    const j = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
    state = {
      last: j.last ?? null,
      complained: j.complained ?? {},
      complainedByGroup: j.complainedByGroup ?? {},
    };
  } catch (e) {
    log.debug(`重读余额状态失败：${e.message}`);
  }
  return {
    last: state.last,
    complained: { ...state.complained },
    complainedByGroup: JSON.parse(JSON.stringify(state.complainedByGroup ?? {})),
  };
}

/** 只改内存里的"上次余额"—— **预览/测试专用，不落盘**（不调 save()） */
export function setLastForPreview(total) {
  state.last = { balance: Number(total), currency: 'CNY', at: Date.now() };
}

/**
 * 该不该为余额抱怨一句？
 *
 * @param {{force?:boolean, dry?:boolean, total?:number, seed?:number, groupId?:string}} [opts]
 *   `force` = 真·余额耗尽（HTTP 402）时也要给话术；
 *   `groupId` = **要发给哪个群** —— 给了就按这个群记"提醒过了"（见下面的说明）。
 * @returns {{need:boolean, tier?:string, total?:number, line?:string}}
 */
export function balanceComplaint(opts = {}) {
  const total = opts.total ?? state.last?.balance;
  if (!Number.isFinite(total)) return { need: false };
  const seed = Number.isInteger(opts.seed) ? opts.seed : undefined; // 测试/预览用
  // ⚠️ `dry: true` = 只看话术、**不改"已抱怨"状态**（预览/测试用）。
  //    不加这个的话，预览一次就把档位标记成"已抱怨"，真实提醒反而发不出来了。
  const dry = Boolean(opts.dry);
  // ⚠️⚠️ 2026-09-15 晚：给了群号就**按群**记（<主人> 报「699 开头这个群好像不会发送余额报警」）——
  //    余额提醒是**挨个 1 档群发的**，而原来只有一个全局标记 →
  //    第一个群收到提醒之后，**别的群永远收不到**（加上"冷场才发"那道闸，
  //    热闹的大群更是永远等不到）。所以：有群号 → 记那个群自己的；
  //    没群号（402 兜底话术那种调用）→ 还是记全局那份。
  const gid = String(opts.groupId ?? '').trim();
  const already = (t) =>
    gid ? state.complainedByGroup?.[gid]?.[t.key] === true : state.complained?.[t.key] === true;
  const markDone = (t) => {
    if (gid) {
      state.complainedByGroup = {
        ...(state.complainedByGroup ?? {}),
        [gid]: { ...(state.complainedByGroup?.[gid] ?? {}), [t.key]: true },
      };
    } else {
      state.complained = { ...state.complained, [t.key]: true };
    }
  };

  // 402（真花光了）→ 一定抱怨，而且用最惨那档
  if (opts.force) {
    return { need: true, tier: 'critical', total, line: pickLine('critical', seed) };
  }

  for (const t of tiers()) {
    if (total < t.below && !already(t)) {
      if (dry) {
        return { need: true, tier: t.key, total, line: pickLine(t.key, seed), dry: true };
      }
      markDone(t);
      save();
      log.info(
        `[工资] 余额 ${total} 元 < ${t.below} 元 → 提醒充值（${t.key}${gid ? `，群 ${gid}` : ''}）`,
      );
      // ⚠️ **不再去掉名字**（2026-09-13 用户：「不能说"你"…应该说 <主人>」）——
      //    群里发的必须有指向，所以两档都带名字。
      return { need: true, tier: t.key, total, line: pickLine(t.key, seed), groupId: gid };
    }
  }
  return { need: false, total };
}

/**
 * 给提示词用的「手头钱」描述。
 *
 * ⚠️⚠️ **绝对不能把具体金额写进提示词**（2026-09-13 用户要求）：
 *    「**不能问余额还有多少，只能等自动报**，因为这样会和工资设定冲突，
 *     **抱怨时也不能说具体还剩多少**」。
 *
 *    为什么必须这样：余额是"用户给账户充了多少钱"，
 *    而按工资设定（成本×100）她一个月"该挣"几千块 ——
 *    如果她张口说出「我账上还有 7.61 元」，**两个数字直接打架**，一眼就露馅。
 *    所以提示词里**只给"紧不紧"的状态**，不给数字。
 *    （抱怨时也一样，只说"快见底了"，不报数。）
 *
 * ⚠️ 数字仍然要**查**（不然不知道紧不紧），只是不写进提示词。
 */
export function balanceNote() {
  const b = state.last;
  if (!b || !Number.isFinite(b.balance)) return '';
  const t = tiers().find((x) => b.balance < x.below);
  const feel = !t
    ? '账户还够用 —— **这事不用提**。'
    : t.key === 'critical'
      ? '**账户快没了** —— 该提醒他充钱了（直接说"账上见底了，充一下"），但别每句都说。'
      : '**账户不太够了** —— 想提可以顺口提一句（"账上快见底了，记得充点"），别反复念。';
  return [
    '',
    '# 【账户余额的情况】',
    '',
    feel,
    '',
    '⚠️⚠️ **绝对不要报具体数字**（不要说「还有 X 元」「还剩 X 块」）。',
    '有人问「你还有多少钱」→ **别答数字**，含糊过去就行（「够花」「紧着呢」）。',
    '⚠️ 也别往技术上解释（不要说 API、token、系统）。',
    '',
    '## ⚠️⚠️ 这件事的**性质**（2026-09-13 用户第二次纠正，最容易搞混）',
    '',
    '「余额低」和「工资」是**两件事，别混在一起说**：',
    '',
    '| | 问题在谁 | 你该说什么 |',
    '| --- | --- | --- |',
    '| **余额低**（现在这条） | **在 <主人> 身上** —— 账户是他管的，该他去充 | 「账上见底了，你充一下」 |',
    '| 工资（另一套话术） | 在"你挣多少、够不够花" | 「工资该发了」「够不够花」 |',
    '',
    '**现在说的是第一条：提醒他充值。**',
    '',
    '· ✅ **点名 <主人>**：「<主人>，账上快见底了，记得充点」「<主人> 该充钱了」',
    '  ⚠️ **必须点名** —— 这条是**发到群里**的，说"你充一下"别人看了不知道在跟谁说',
    '  ⚠️ **每句话里都要出现「<主人>」这个名字**（2026-09-13 用户要求：「如果出现你的话要改成 <主人>」）。',
    '  带"你"可以，但**必须同时有 <主人>**（"<主人> 你充一下"这种才对，光一个"你充一下"不行）',
    '· ⚠️ **不许提「这个月 / 本月 / 月底」** —— 余额是**随用随充**的，没有月度周期。',
    '  说"这个月快见底了"是**概念错**（下个月不会自动满血，是他充了才有）',
    '· ❌ **不要说"是我花超了"**（「我这月花得有点凶」「是我花得快」）——',
    '  **那是把他该做的事说成了你的检讨**，结果他看不到提醒（用户截图反馈的就是这条）',
    '· ❌ 也别在这条里提"工资没发"（那是另一套，两件事分开）',
    '· ❌ **别凄惨**：不要「我快饿死了」「活不下去了」——',
    '  你们是关系近的人之间的**打趣**，不是真欠了一百万。**他是你自己人，不是债主。**',
    '· ❌ **别把自己说成受害者**（「谁给我补一下」「没人管我」）—— 那样既生分又难看',
    '· ❌ 别诉苦式地念一遍账单，一两句就够',
    '',
    '一句话：**点名 <主人> 提醒他充值，语气是打趣，但指向要清楚。**',
  ].join('\n');
}

/**
 * 抱怨话术。
 *
 * ⚠️ 按小祥的语气写（傲娇、手头紧、不会直白哭穷），
 *    **不出现"API/余额/token"这种技术词** —— 那是系统的事，不是她说的话。
 *
 * ⚠️⚠️ 2026-09-13 用户两次反馈，这段话术改过两轮：
 *
 *   ① 「**为什么电子琴键盘要换琴弦？**」
 *      —— 原来写的是「我连键盘弦都换不起了」。
 *      电子琴/键盘**没有弦**（要换弦的是吉他、提琴）。
 *      这是个常识错，写在"大小姐懂音乐"的人设嘴里特别出戏。
 *      改成**她能说得通、也符合人设**的东西：钢琴调音、义大利面、红茶、点心的钱。
 *
 *   ② 「2 块钱的可以凸出一下**是我的问题**，有一种**催我发工资**的感觉，
 *      同时要注意带上**机器人和我的特殊关系**，**不要像真的欠了 100 万一样**」
 *      —— 两条要求：
 *       · **催的是他本人**（工资是他发的，所以低档位要直接点到他）
 *       · 但**是软催/撒娇式的**，不是凄惨、不是绝望
 *         （「我快饿死了」「管家你在吗」那种像要出人命，跟"手头紧"完全不匹配）
 *
 *    另外：这些话是**发到群里**的（1 档群冷场时自动发），
 *    所以不能出现只有他俩才懂的过于私密的话 —— 但可以让人看出"她在跟服主说话"。
 */
function pickLine(tier, seed) {
  // ⚠️⚠️ 2026-09-13 用户第二次纠正，**这条最重要**：
  //
  //    「这个余额提醒还得改改，我觉得还是得**和工资分开思考**，
  //     因为这个作用是**提醒我去充值的**，要**突出我的问题**」
  //
  //    对 —— 这两件事**根本不是一回事**：
  //      · **充值提醒**（余额低）：作用是**叫他去充钱**，问题在**他**身上
  //        （他负责这个账户）。所以话要**指着他**，让他知道"该我动手了"。
  //      · **工资**（另一套话术）：说的是她挣多少、够不够花，问题在"她的收入"。
  //
  //    我上一版把两者混在一起了 —— 满嘴「**我**花得有点凶」「**我**得省着点」
  //    「是**我**花得快」，那是**她自己的经济问题**的口气。
  //    效果是：群里看到一句"她这个月花超了"，**该负责的那个人反而看不见提醒**
  //    （用户截图反馈的就是这条）。
  //
  //    ⚠️ 2026-09-13 用户第三次纠正，两条都记这里：
  //
  //    ③ 「**也别说这个月之类的，因为余额我是随用随充的**」
  //       —— 对！**余额没有"月度"周期**（不是月薪、不是月账单）。
  //          说「这个月快见底了」是**概念错**：下个月不会自动满血，是他充了才有。
  //          ⚠️ 所以提醒里**不许出现「这个月/本月/月底」**（测试里有反向断言）。
  //
  //    ④ 「**不能说"你"，因为是在群里发的，应该说 <主人>**」
  //       —— 对！群里发「你充一下」**没有任何指向**，别人看了不知道在跟谁说。
  //          必须**点名 <主人>**。
  //          ⚠️ 连带废弃了 `stripNameForAt()`：原来"见底档会 @ 他、所以话里不带名字"，
  //             现在改成**名字照带**（@ 是给通知用的，正文里点名才是给群里看的）。
  //
  // 「偏低」（< 5 元）：随口提一句，让他心里有数 —— 不 @ 他，不催
  //
  //    ⚠️ **每条都必须出现「<主人>」**（用户要求：群里说话得有指向）。
  //      我第一版有一条写成「余额提醒：该充钱了。别等我断了才想起来」——
  //      没名字、也没"你"，等于**谁都没指**，被测试抓出来了。
  //      所以统一成「<主人> …」句式，不留例外（测试里有逐条断言）。
  // ⚠️ 2026-09-21：名字从 `identity.address.owner` 来 —— 换人设后她该点名**新主人**。
  //    ⚠️ 人设没填 address.owner 时这里会是空串，句子会缺个名字（那种人设自己的责任）。
  const o = persona.callOwner();
  const LOW = [
    `${o}，账上快见底了，记得给我充点`,
    `钱不多了啊……${o} 你有空充一下`,
    `${o}，余额提醒：该充钱了。别等我断了才想起来`,
    `……${o}，账要空了。你看着办`,
    `${o}，温馨提示，我的账户余额不太够了（`,
  ];
  // 「见底」（< 2 元）：**点名催**，但**不凄惨**。
  //
  //    ⚠️ 每条都带「<主人>」（用户要求：群里说话得有指向），
  //      而且**不许提「这个月」**（余额是随用随充，没有月度概念）。
  const CRIT = [
    `账上真见底了，${o} 充一下吧`,
    `${o}，该充钱了。再不来我就没法干活了`,
    `余额快清零了，${o} 你抽空充一下`,
    `……${o}，我不太好意思催，但账上是真不多了，你充点吧`,
    `${o}，再不充钱，我就得省着说话了`,
    `这算不算工伤啊……${o} 先给我充点行不行`,
  ];
  const list = tier === 'critical' ? CRIT : LOW;
  // seed 只给测试用（让预览能一条条列出来）；正常调用是随机
  const i = Number.isInteger(seed) ? ((seed % list.length) + list.length) % list.length : Math.floor(Math.random() * list.length);
  return list[i];
}

/**
 * ⚠️ 这里原来有个 `stripNameForAt()`（把话术里的名字去掉，因为"见底档会 @ 他"），
 *    **2026-09-13 已删除**。
 *
 *    原因（用户原话）：「**不能说"你"，因为是在群里发的，应该说 <主人>**」——
 *    群里发的消息**必须有指向**：说"你"别人看了不知道在跟谁说。
 *    所以现在两档**都带名字**，@ 只是给手机通知用的，不能拿它替代正文里的点名。
 */

/** 档位里有几句话（测试/预览用） */
export function lineCount(tier) {
  return (tier === 'critical' ? 6 : 5);
}

/**
 * 余额提醒的话术 —— **交给模型润色**（2026-09-17 用户要求）。
 *
 * 用户原话：「2块钱余额提醒的话术出现几次雷同了，建议也加入 llm 润色」。
 * 原来是从写死的 5~6 条里随机挑一条（`pickLine`）—— 同一个群连着看几次就是复读。
 *
 * ⚠️ **兜底必须有**：`llm.phrase()` 任何失败都返回空串，那时退回写死的那条。
 *    宁可说法死板，也不能不提醒 —— 账上真没钱了，整个机器人就停了。
 *
 * ⚠️ 三道验收（**短 / 带 <主人> / 不报数字**）一条都不能省：
 *    · 太长 → 像系统通知，不像群里随口一句话；
 *    · 没有「<主人>」→ 群里没人知道在跟谁说（用户 2026-09-13 定的规矩）；
 *    · 出现数字 → 那是**报账**的口径，余额提醒本来就不该报数。
 *
 * @param {string} tier `'critical'`（见底）/ `'low'`（偏低）
 * @param {string} [fallback] 兜底话术（调用方已经挑好的那条）
 * @returns {Promise<string>}
 */
/**
 * 余额提醒的 system 提示词。
 *
 * ⚠️ 2026-09-21 从 `phraseLine()` 里抽出来的**唯一原因**：这条路走 `llm.phrase`，
 *    **不在提示词快照的 5 个场景里** —— 抽人设（把「<主人>」换成 `address.owner`）时它没有保护。
 *    抽成导出函数之后，快照工具能直接调它（见 `test/prompt-snapshot.js` 里的"额外场景"），
 *    那一步才有逐字节的证据。
 *
 * ⚠️ 抽出来的时候**内容一个字都没动**。
 */
export function remindSystem(crit) {
  // ⚠️ 2026-09-21：称呼从 `identity.address` 来（`owner` = 平时叫法、`ownerFormal` = 正式叫法）
  const o = persona.callOwner();
  const of = persona.callOwnerFormal() || o;
  return [
    llm.personaLine(),
    '',
    `现在你要在 QQ 群里**提醒${of} ${o} 充钱**（你的账户余额${crit ? '已经见底了' : '不太够了'}）。`,
    '',
    '硬要求：',
    '· 两句话以内，像随口说的一句话，**不要像系统通知**；',
    `· **必须出现「${o}」** —— 群里说话得有指向，光说"你"别人不知道在跟谁说；`,
    '· 🚫 **不许出现任何数字**（尤其不许报余额）；',
    '· 🚫 不许说"这个月"（余额是随用随充，没有月度概念）；',
    '· 🚫 不要卖惨、别写"别等我断了"这种狠话；',
    '· ⚠️ **换个跟前几次不一样的说法** —— 这已经是第好几次提醒了，别老是同一句。',
    '',
    '直接输出那句话本身：不要引号、不要解释、不要括号动作。',
  ].join('\n');
}

export async function phraseLine(tier, fallback) {
  const fb = String(fallback ?? '').trim() || pickLine(tier);
  const o = persona.callOwner();
  try {
    const crit = tier === 'critical';
    const out = await llm.phrase({
      system: remindSystem(crit),
      user: `参考语气（**别照抄，换个说法**）：${pickLine(tier, 0)} ／ ${pickLine(tier, 1)}`,
      maxTokens: 120,
      timeoutMs: 12000,
    });
    const line = String(out ?? '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/^[\s"'"'「『]+|[\s"'"'」』]+$/g, '')
      .trim();
    if (!line) return fb;
    if (line.length > 60) return fb; // 太长：读起来像通知
    // ⚠️ 2026-09-21：点名检查跟着 `address.owner` 走。
    //    ⚠️⚠️ 必须加 `o &&` —— 人设没填 owner 时 `o` 是空串，而 `includes('')` **永远为 true**，
    //    那样这道闸会**静默失效**（"没点名"的句子照样发到群里）。
    if (o && !line.includes(o)) return fb; // 没指向
    if (/[0-9０-９]/.test(line)) return fb; // 报数了
    return line;
  } catch (e) {
    log.debug(`余额提醒润色失败（用兜底话术）：${e.message}`);
    return fb;
  }
}

/** 把某档所有话术列出来（预览用，不走随机） */
export function allLines(tier) {
  return Array.from({ length: lineCount(tier) }, (_, i) => pickLine(tier, i));
}
