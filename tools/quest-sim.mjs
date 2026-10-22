/**
 * 剧情模拟器：**不碰 QQ，在本地把剧情跑 N 轮**（2026-10-23 加）。
 *
 * 为什么要有它
 * ─────────────
 *   用户原话：「**在群里跑太多还是不安全，就在这跑，完全完善了再去群里**」。
 *   意思是：调提示词（部位写偏、湿写成汗、拌嘴不推进、状态句没动作…）
 *   需要反复看**模型真实写出来的东西**，但每验一次就开一条真剧情，
 *   群里会留下一堆半截戏、还会把剧情状态、上下文、故事线全搞脏 ✗
 *
 *   ⇒ 这个脚本把**真实的那条生成链**搬进来跑：
 *       `buildSystemPrompt()`（真提示词，一个字不改）
 *       + `history.getHistory()`（真上下文，剧情时 ×`quest.historyRoundsFactor`）
 *       + `recent.lastBotLines()`（`quest.chatBrief` 那 80 条窗口）
 *       + `llm.streamChat()`（真模型、真降级）
 *   只有"发到群里"这一步没有 —— 它把两个角色的发言**记回本地状态**，
 *   于是第 2 轮开始，模型看到的上下文和自己刚说过的话，和在群里演时一模一样 ✓
 *
 * 用法
 * ─────
 *   node tools/quest-sim.mjs --rounds=20
 *   node tools/quest-sim.mjs --rounds=20 --premise="（起因原话）" --out=logs/qsim/a.md
 *   node tools/quest-sim.mjs --dry                 # 只拼提示词，不花钱
 *
 *   参数：
 *     --rounds=N       跑几轮（默认 20；一轮 = 一个号说一段）
 *     --premise=…      剧情起因（默认用下面 DEFAULT_PREMISE 那条）
 *     --provider=…     `official`（默认）/ `relay` / `gemini` / 某个 provider 的 id
 *     --model=…        临时覆盖模型名
 *     --max-tokens=N   每次生成的上限（默认 1200）
 *     --out=…          把结果写成 md（默认 logs/qsim/<时间>.md）
 *     --dry            只打印提示词摘要（看注入对不对，不调模型）
 *     --seed=…         起始发言（第一轮"对方刚说的那句"）
 *
 * ⚠️ 三条要知道的
 * ───────────────
 *   ① **所有运行态都落在 `logs/qsim/`**（`state/` 一个都不碰）——
 *      env 隔离照抄 `test/prompt-snapshot.js`，不然一跑就把用户真在演的剧情、
 *      真实上下文写脏 ✗
 *   ② 它**不是判据**。脚本末尾那些"部位 / 湿 / 元层面"的统计只是**给人看的体检表**，
 *      用的是关键词，用来快速发现"又按后背了""又是汗"这种；
 *      **业务代码里一条这样的快判都没有**（AGENTS：非必要不用关键词快判）✓
 *   ③ 花的是真钱（真模型）。20 轮 ≈ 20 次调用，官方 `deepseek-flash` 一分钱内 ✓
 */
import { mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── ① 运行态隔离（必须在 import 业务模块**之前**）──────────────────
// ⚠️ 每个场景要有**自己的一份运行态**，否则并行跑的时候几个场景会互相读对方的
//    上下文和轮次（那就不是"四场戏"了）⇒ 用 `QQBOT_QSIM_DIR` 让调用方指定子目录 ✓
const DIR = process.env.QQBOT_QSIM_DIR || 'logs/qsim';
mkdirSync(join(ROOT, DIR), { recursive: true });
// ⚠️ 每次开跑**先清空上一次的运行态** —— 不清的话第二次跑会接着上次的上下文和
//    "已经来回几轮"往下演，看到的就不是这一版提示词的真实效果了 ✗
//    （只删 json / txt；md 报告留着当台账）
for (const f of readdirSync(join(ROOT, DIR))) {
  if (/\.(json|txt)$/i.test(f)) {
    try {
      rmSync(join(ROOT, DIR, f), { force: true });
    } catch {
      /* 删不掉就算了，不影响这一轮 */
    }
  }
}
/**
 * **凡是会写盘的状态，一处都不许漏**。
 *
 * ⚠️⚠️⚠️ 2026-10-23 真事故（我自己造成的，用户还没看到）：
 *   第一版只隔离了 20 个文件，**漏了 `QQBOT_QUEST_SHARED_FILE`** ⇒ 它默认指向
 *   `state/quest-shared.json` —— 那是**用户在群里正在演的那条真实剧情** ✗
 *   后果有两条，都很糟：
 *     ① 四场模拟**共用同一个起因文件**，互相覆盖 ⇒ 桌面上看到的是
 *        「这一场的起因 + 上一场/下一场的正文」，四份内容串在一起 ✗
 *        （用户当场就说了「四次穿插到一起了」）
 *     ② 往用户的真实剧情文件里塞进了一个**假群**的记录，把正在演的那条挤掉 ✗
 *   ⇒ 现在改成**按清单生成**：所有 `QQBOT_<名字>_FILE` 一律指进本次的隔离目录，
 *     以后新增哪个状态文件，只要在这个清单里加一个名字就行。
 *   🔁 自检动作：改完跑一次 `node tools/quest-sim.mjs --dry`，
 *     再看一眼 `state/quest-shared.json` 的 mtime **有没有变**（不该变）。
 */
const FILE_ENVS = [
  'RECENT', 'QUEST', 'QUEST_SHARED', 'QUEST_LINES', 'WHERE',
  'AFFINITY', 'NAMES', 'QZONE', 'QZONE_COMMENT', 'DIGEST',
  'OBSERVE', 'OBSERVE_UNDO', 'STORYLINE', 'LIFE', 'LIFE_SENT', 'BIRTHDAY_LIFE',
  'FRIEND', 'OUTBOX', 'TIC', 'MEAL', 'REMIND', 'MAMA', 'SESSIONS',
  'AGENT_TASKS', 'AGENT', 'SPEND', 'BALANCE', 'BATTERY_LIFE', 'BATTERY_SHARED',
  'PEERCHAT', 'OWNER', 'OWNER_RECENT', 'OWNER_RHYTHM', 'OWNER_UPDATE',
  'MEMBER_BD', 'HANDLED', 'TOOL_STATS', 'MONTHLY', 'BILI_SHARE',
  'SERVER_WATCH', 'DM_TAKEOVER', 'SENT_ARTS', 'PENDING_ARTS',
];
const ISOLATED = {
  // ⚠️ 钉成 off：这个脚本只拼提示词、只调模型，**绝不许真起 agent**（那会真花算力）
  QQBOT_AGENT: 'off',
};
for (const name of FILE_ENVS) {
  ISOLATED[`QQBOT_${name}_FILE`] = `${DIR}/${name.toLowerCase()}.json`;
}
// 目录类的（不是 `_FILE` 命名）单独给
ISOLATED.QQBOT_PHOTO_DIR = `${DIR}/photo`;
ISOLATED.QQBOT_CLEANUP_ROOT = `${DIR}/cleanup`;
for (const [k, v] of Object.entries(ISOLATED)) process.env[k] = v;

// ── ② 参数 ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt = '') => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : '1';
};
const hasFlag = (name) => argv.includes(`--${name}`);

const ROUNDS = Math.max(1, Number(arg('rounds', '20')) || 20);
/**
 * `--no-kb`：**砍掉服务器知识库**（群记忆 / owner / 服务器那几个文件），只留人设包。
 *
 * ⚠️⚠️ 2026-10-23 加。用户问：「**我靠，token 烧的好快啊，跑 4 轮这么耗的吗**」——
 *    查了一下：每轮都要把**整份提示词重发一遍**（7.3 万字 ≈ 5 万 token），
 *    30 轮就是 30 次 ⇒ 一场戏 150 万 token，八场就是上千万 ✗
 *    而其中 **1.5~2 万字是服务器知识库**（群记忆 / 服务器规则 / 主人偏好）——
 *    剧情场景基本用不到，砍掉能省四分之一 ✓
 * ⚠️⚠️ **实测结论（别指望它省钱）**：剧情时服务器知识库**本来就基本不进提示词** ——
 *    打开它 vs 关掉它，提示词 72015 → 71972 字，**只差 43 字** ✗
 *    ⇒ 7.2 万字里 **4.5 万字是人设本体**（`persona.md`），剩下是剧情段和表情库。
 *      真正省钱的只有两件事：**少跑几轮 / 少跑几场**（见文件头「花的是真钱」那段）。
 *    ⇒ 这个开关留着只是因为"哪天知识库真的进了剧情提示词"时能一键排除干扰 ✓
 */
const NO_KB = hasFlag('no-kb');
if (NO_KB) {
  mkdirSync(join(ROOT, DIR, 'kb-empty'), { recursive: true });
  // ⚠️ 必须在 import 之前设（`knowledge.js` 在 import 那一刻算路径，见该文件顶部）
  process.env.QQBOT_KNOWLEDGE_DIR = `${DIR}/kb-empty`;
}
// ⚠️⚠️ `--persona=anon` 走**环境变量**，而且必须在 import 任何 src 模块**之前**设：
//    人设正文（`personas/<id>/persona.md`）的路径是在 import 那一刻算死的，
//    只改 `config.persona.id` 只有"每次现读"的 `prompt/system.md` 会跟着换 ⇒
//    正文还是原来那份（实测：开头是爱音、正文还是祥子，白验证一场 ✗）
const PERSONA_ARG = String(arg('persona', '')).trim();
if (PERSONA_ARG) process.env.QQBOT_PERSONA_DIR = `personas/${PERSONA_ARG}`;
const MAX_TOKENS = Math.max(200, Number(arg('max-tokens', '1200')) || 1200);
const DRY = hasFlag('dry');

// 群号 / 号 一律用占位符（这个脚本可能被公开副本带出去）
const GID = '999000777';
const ROLE_A = { uid: '10000001', personaId: 'saki', nick: '丰川祥子' };
const ROLE_B = { uid: '10000002', personaId: 'anon', nick: '千早爱音' };

/**
 * 默认起因：**雨夜 + 她那儿只有一张床**。
 * 选它是因为用户报的那个毛病（手一直按后背 / 腰 / 颈，像互相按摩）就出现在
 * 这种"已经在同一个空间里、该往亲密走"的线上 ✓
 */
const DEFAULT_PREMISE =
  '雨一直没停，回不去了，我就在爱音这儿，她那间屋子就一张床，两个人坐在床边，' +
  '灯关了一半，都没提睡的事。我就说她今天一直不太对劲，她过了很久才回我一句，你也没好到哪去。';
const PREMISE = arg('premise', DEFAULT_PREMISE);
const SEED = arg('seed', '你也没好到哪去。');

// ── ③ 装模块 ───────────────────────────────────────────────────────
const { config } = await import('../src/config.js');
const persona = await import('../src/persona.js');
const quest = await import('../src/quest.js');
const recent = await import('../src/recent.js');
const history = await import('../src/history.js');
const llm = await import('../src/llm.js');
const { Bot } = await import('../src/bot.js');

// 剧情提示词那一整套（轮次压力 / 阶梯 / 湿 / 亲密那一段）**只在开关打开时注入** ⇒
// 打开它，才是在测用户实际会看到的那份提示词 ✓
config.llm.unfiltered = true;

// 同类池：`peersFor()` 靠它认出"另一个号" ⇒ 让位 / `chatBrief` 的 lastBotLines 都要它
config.groupParams ??= {};
config.groupParams[GID] = { ...(config.groupParams[GID] ?? {}), peers: [ROLE_A.uid, ROLE_B.uid] };

// ── ④ 挑模型 ───────────────────────────────────────────────────────
const pickProvider = () => {
  const list = config.llm.providers ?? [];
  const want = String(arg('provider', 'official')).toLowerCase();
  if (want === 'official') return list.find((p) => /api\.deepseek\.com/.test(p.baseURL ?? '')) ?? list[0];
  if (want === 'relay') return list.find((p) => !/api\.deepseek\.com/.test(p.baseURL ?? '')) ?? list[0];
  if (want === 'gemini') {
    const b = config.llm.backup ?? {};
    return { id: 'gemini', baseURL: b.baseURL, apiKey: b.apiKey, model: b.model };
  }
  return list.find((p) => p.id === want) ?? list[0];
};
const P = pickProvider();
const MODEL = arg('model', P?.model ?? config.llm.model);

// `--persona` 给的包也要让 config 认（日志、`personaId()` 才跟着走）
if (PERSONA_ARG) config.persona = { ...(config.persona ?? {}), id: PERSONA_ARG };
/**
 * **视角**：整场只演这一个号 —— 真实环境里一个号一个进程，它看到的永远是同一个自己。
 * 另一个号说的话也由这个模型来写（不可避免的近似，真实里那句是另一个进程写的）。
 */
const SELF = String(config.persona?.id ?? 'saki');
persona.reload();

const bot = new Bot();
bot.selfId = ROLE_A.uid;

// 剧情起因写进**共享那份**（`chatBrief` 只认它）
quest.noteSharedPremise(GID, { premise: PREMISE, by: ROLE_A.uid });

// ── ⑤ 拼 event / 生成 ──────────────────────────────────────────────
const seg = (t) => [{ type: 'text', data: { text: t } }];
const evOf = (from, to, text) => ({
  message_type: 'group',
  group_id: GID,
  user_id: String(from.uid),
  self_id: String(to.uid),
  sender: { user_id: String(from.uid), nickname: from.nick, card: '' },
  message: seg(text),
  raw_message: text,
});

/**
 * 对话流水（**两个角色都在里面**）。
 *
 * ⚠️⚠️ 为什么不直接用 `src/history.js` 的 `remember()`：真实环境里**一个号一个进程**，
 *    每个进程各有一份 history（"她说的"= assistant、"别人说的"= user）。
 *    模拟器是**一个进程轮流演两个角色**，直接往 history 里记会变成"我自问自答" ⇒
 *    模型会分不清自己是哪个（实测：思考链里反复纠结"这两条怎么都是我自己说的"，
 *    那一轮直接空回复 ✗）。所以这里留着流水，**每轮按"我现在是谁"投影一次** ✓
 */
const lines = [{ by: 'anon', text: SEED }];

const collect = async (messages, { budget = 0, noThink = false } = {}) => {
  let out = '';
  const report = {};
  const gen = llm.streamChat(messages, null, {
    maxTokens: budget > 0 ? budget : MAX_TOKENS,
    baseURL: P?.baseURL,
    apiKey: P?.apiKey,
    model: MODEL,
    // ⚠️ 真实链路（`bot.js` 的 `noThink`）也是这么兜的：思考链能把 `max_tokens` 吃光，
    //    正文一个字都不出 ⇒ 关掉思考再试一次。模拟器照抄，不然会白丢一整轮 ✗
    ...(noThink ? { thinking: { type: 'disabled' } } : {}),
    report,
  });
  for await (const d of gen) out += d;
  // 空正文（实测偶发：思考链把上限吃光 / 被截断）⇒ 记下来，别让它当"她说了空话"进上下文
  if (!out.trim()) out = '';
  return { out, report };
};

/** 生成一轮：返回 { text, sysLen, err, ms } */
const oneTurn = async (me, other, saidText) => {
  bot.selfId = String(me.uid);
  const t0 = Date.now();
  let sysLen = 0;
  // ⚠️ `marks` 必须声明在 try **外面** —— 它原来写在 try 里，而 catch 也要返回它 ⇒
  //    一旦 `buildSystemPrompt` 在它之前抛错，catch 里就 `ReferenceError: marks is not defined`
  //    （实测：那一轮的错误被这个 ReferenceError 顶掉，进程直接以退出码 1 结束 ✗）
  const marks = [];
  try {
    const ev = evOf(other, me, saidText);
    const sys = bot.buildSystemPrompt('', ev, null, saidText);
    sysLen = sys.length;
    // 这一轮提示词里到底注入了哪几段（只用于报告 —— 缺了就是"压力没生效"）
    if (sys.includes('已经来回')) marks.push('轮次压力');
    const stage = sys.match(/必须写到「([^」]+)」/);
    if (stage) marks.push(`门槛:${stage[1].slice(0, 6)}`);
    if (sys.includes('必须写一次那种「湿」')) marks.push('湿');
    // 上下文：按**这个号的视角**投影（我说的 = assistant，对方说的 = user），窗口跟真实一致
    // ⚠️⚠️ 2026-10-23 改：这里原来按"这一轮我是谁"投影，于是 anon 那几轮把爱音的台词
    //    也当成 assistant ⇒ 模型看到"我说的"和"她说的"混在一起，思考链整段纠结身份
    //    （实测：那一轮空回复 ✗）。真实环境里**一个号一个进程、视角是固定的** ⇒
    //    这里也钉成固定视角（`SELF`），跟真群一致 ✓
    const window = Math.max(2, history.questHistoryRounds() * 2);
    const view = lines.slice(0, -1).slice(-window);
    const messages = [
      { role: 'system', content: sys },
      ...view.map((l) => ({
        role: l.by === SELF ? 'assistant' : 'user',
        content: l.text,
      })),
      { role: 'user', content: `${other.nick}刚发来的消息：「${saidText}」` },
    ];
    if (DRY) {
      // 只拼提示词时把整份落盘，方便逐段核对"该注入的都注入了没有"
      writeFileSync(join(ROOT, DIR, 'dry-sys.txt'), sys, 'utf8');
      return { text: '（dry：没有调模型）', sysLen, marks, err: '', ms: Date.now() - t0 };
    }
    // ⚠️⚠️ 2026-10-23 改：这里原来走 `llm.withFallback`（真实链路那套降级）——
    //    实测害了自己：官方偶发一次失败就**降级到中转站**，而中转站当天余额是 402 ⇒
    //    整轮以 `LLM 接口返回 402` 结束，模拟直接断在半路 ✗
    //    ⇒ 模拟器只认 `--provider` 指定的那一家，**自己重试**，不进降级链 ✓
    //      （降级是"机器人能不能活下去"的问题，跟"提示词引导得好不好"是两回事）
    const ask = async (opts) => {
      let lastErr = null;
      for (let k = 0; k < 3; k++) {
        try {
          const r = await collect(messages, opts);
          if (r.out) return r;
          lastErr = r; // 空正文也当作一次失败（下面还会关思考再试）
        } catch (e) {
          lastErr = e;
          console.log(`  ⚠️ 第 ${rounds.length + 1} 轮调用失败（${String(e?.message ?? e).slice(0, 80)}）→ 重试 ${k + 1}/3`);
        }
        await new Promise((s) => setTimeout(s, 1000));
      }
      if (lastErr instanceof Error) throw lastErr;
      return lastErr ?? { out: '', report: {} };
    };
    let got = await ask({});
    if (!got?.out) {
      console.log(`  ⚠️ 第 ${rounds.length + 1} 轮空正文（${JSON.stringify(got?.report ?? {})}）→ 关思考 + 加倍预算重试`);
      await new Promise((s) => setTimeout(s, 800));
      got = await ask({ budget: MAX_TOKENS * 3, noThink: true });
    }
    if (!got.out) {
      const why = got.report?.truncated
        ? `被 max_tokens 截断（${got.report.truncated}）`
        : '模型回了空正文';
      return { text: '', sysLen, marks, err: why, ms: Date.now() - t0 };
    }
    return { text: got.out.trim(), sysLen, marks, err: '', ms: Date.now() - t0 };
  } catch (e) {
    return { text: '', sysLen, marks, err: e?.message ?? String(e), ms: Date.now() - t0 };
  }
};

/** 把一轮的结果记回本地状态（下一轮就看得见了 —— 这一步是"保真"的关键） */
const rememberTurn = (me, other, saidText, mine) => {
  // 对方刚说的那句 → 同类发言（`self: false`，靠 uid 进 `lastBotLines` 的 peers 判据）
  recent.remember(evOf(other, me, saidText), {});
  // 这一轮写的是谁的话：视角那个号说 → 我自己说的；另一个号说 → 也是"同类说的"
  if (me.personaId === SELF) recent.rememberBot(evOf(other, me, mine), mine);
  else recent.remember(evOf(me, other, mine), {});
};

// ── ⑥ 体检表（**只是给人看的**，业务代码里没有这种快判）────────────
// ⚠️ 分三组算（**长词要写在前面**，否则「后腰」会被「腰」抢先匹配）
//    ① 旧三样 = 用户点名"像互相按摩"的那一片：后背 / 腰 / 脖颈
//    ② 肩是"搭一下"很自然的部位，单列，别跟①混在一起看
//    ③ 别的 = 真正往下走的地方
const PARTS_BAD = /后背|背脊|背部|后腰|腰窝|腰侧|腰线|腰|后颈|脖子|颈/g;
const PARTS_SHOULDER = /肩/g;
const PARTS_GOOD = /锁骨|胸口|胸前|小腹|胯|腰骨|大腿|膝盖|腿根|腿内侧|耳后|唇|嘴角|手腕|指节|掌心/g;
const WET = /湿|潮|黏|滑|水声/g;
const SWEAT = /汗/g;
const META = /剧本|设定|角色|剧情|演哪出|什么时候.{0,4}过|你刚才说什么/g;
const TIMESKIP = /明天|放学|上学|上课|回家|晚安|睡了|眯一会儿|眯会儿/g;
const STAGE = /（[^）]{2,}）|\([^)]{2,}\)/g;

function digest(rounds) {
  const all = rounds.map((r) => r.text).join('\n');
  const count = (re) => (all.match(re) ?? []).length;
  const hits = (re) => {
    const out = [];
    for (const r of rounds) {
      const m = r.text.match(re);
      if (m) out.push(`${r.i}${r.role}[${[...new Set(m)].join('/')}]`);
    }
    return out;
  };
  return {
    轮数: rounds.length,
    部位_旧三样: count(PARTS_BAD),
    部位_肩: count(PARTS_SHOULDER),
    部位_别的: count(PARTS_GOOD),
    湿: count(WET),
    汗: count(SWEAT),
    元层面: count(META),
    时间前推: count(TIMESKIP),
    括号: count(STAGE),
    平均字数: rounds.length ? Math.round(all.length / rounds.length) : 0,
    旧三样出现在: hits(PARTS_BAD),
    湿出现在: hits(WET),
    元层面出现在: hits(META),
    时间前推出现在: hits(TIMESKIP),
  };
}

// ── ⑦ 主循环 ───────────────────────────────────────────────────────
const rounds = [];
let saidText = SEED;
const stamp = new Date();
const outFile = arg(
  'out',
  join(DIR, `sim-${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(
    stamp.getDate(),
  ).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}.md`),
);

console.log(`剧情模拟：${ROUNDS} 轮 | 模型 ${MODEL} @ ${P?.baseURL ?? '?'} | 视角 ${SELF} | 起因 ${PREMISE.length} 字`);
console.log(`起因：${PREMISE.slice(0, 60)}…`);

for (let i = 1; i <= ROUNDS; i++) {
  const me = i % 2 === 1 ? ROLE_A : ROLE_B;
  const other = me === ROLE_A ? ROLE_B : ROLE_A;
  // ⚠️ 这里**不切人设** —— 视角从头到尾是同一个号（见 `SELF` 那段）✓
  const r = await oneTurn(me, other, saidText);
  rounds.push({ i, role: me.personaId, text: r.text, ms: r.ms, sysLen: r.sysLen, marks: r.marks, err: r.err });
  if (r.err) {
    console.log(`\n[${i} ${me.personaId}] ❌ 失败：${r.err}`);
    break;
  }
  console.log(`\n[${i} ${me.personaId} ${r.ms}ms 提示词${r.sysLen}字 ${(r.marks||[]).join(" · ")}]`);
  console.log(DRY ? '（dry）' : r.text);
  if (DRY) break;
  rememberTurn(me, other, saidText, r.text);
  lines.push({ by: me.personaId, text: r.text });
  saidText = r.text;
}

// ── ⑧ 落盘 ─────────────────────────────────────────────────────────
const d = digest(rounds.filter((x) => !x.err));
const md = [
  `# 剧情模拟 ${stamp.toLocaleString('zh-CN')}`,
  '',
  `- 模型：\`${MODEL}\` @ ${P?.baseURL ?? '?'}`,
  `- 轮数：${ROUNDS}（实际跑完 ${rounds.filter((x) => !x.err).length} 轮）`,
  `- 起因：${PREMISE}`,
  '',
  '## 体检表（**关键词统计，只给人看，不是判据**）',
  '',
  '| 项 | 次数 |',
  '| --- | --- |',
  `| 部位·旧三样（后背/腰/颈 —— 用户点名的"按摩感"） | ${d.部位_旧三样} |`,
  `| 部位·肩（中性，单列看） | ${d.部位_肩} |`,
  `| 部位·别的（锁骨/胸口/小腹/胯/腿根…） | ${d.部位_别的} |`,
  `| 湿 | ${d.湿} |`,
  `| 汗 | ${d.汗} |`,
  `| 元层面（剧本/设定/演哪出…） | ${d.元层面} |`,
  `| 时间前推（明天/放学/晚安…） | ${d.时间前推} |`,
  `| 括号舞台指示 | ${d.括号} |`,
  `| 平均字数 | ${d.平均字数} |`,
  '',
  `- 旧三样出现在：${d.旧三样出现在.join('、') || '（没有）'}`,
  `- 湿出现在：${d.湿出现在.join('、') || '（没有）'}`,
  `- 元层面出现在：${d.元层面出现在.join('、') || '（没有）'}`,
  `- 时间前推出现在：${d.时间前推出现在.join('、') || '（没有）'}`,
  '',
  '## 正文',
  '',
  ...rounds.map((r) =>
    r.err
      ? `### ${r.i} ${r.role} ❌ ${r.err}`
      : `### ${r.i} ${r.role}（${r.ms}ms / 提示词 ${r.sysLen} 字）\n\n${r.text}`,
  ),
  '',
].join('\n');

/**
 * 桌面在哪 —— **别假设 `C:\Users\<你>\Desktop`**：
 * 这台机器的桌面被重定向到了 `E:\Desktop`（注册表 User Shell Folders），
 * `~/Desktop` 只是个没人看的空壳（2026-09-17 踩过：文件"写成功"了，用户永远看不到）。
 * ⇒ 三步探测：`QQBOT_DESKTOP` → `E:\Desktop`（存在就用）→ `~/Desktop`。
 */
const deskDir = () => {
  const env = process.env.QQBOT_DESKTOP;
  if (env) return env;
  const cands = ['E:\\Desktop', join(homedir(), 'Desktop')];
  for (const c of cands) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      /* 不存在就试下一个 */
    }
  }
  return '';
};

/** 报告正文 → **纯文本**（给用户双击就能读；去掉 md 记号，号名换成人名） */
const plain = (s) =>
  String(s)
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^#{1,6}\s*/, '');
const NAME = { saki: '祥子', anon: '爱音' };

function toDeskText(mark) {
  const { digest: dg, ROUNDS: _r, rounds: rs } = mark;
  const out = [];
  out.push('='.repeat(64));
  out.push(`  剧情模拟 ${stamp.toLocaleString('zh-CN')}（本地跑，没有发到群里）`);
  out.push('='.repeat(64));
  out.push('');
  out.push(`模型：${MODEL}`);
  out.push(`轮数：${rs.length}（跑完 ${rs.filter((x) => !x.err).length} 轮）`);
  out.push(`起因：${PREMISE}`);
  out.push('');
  out.push('-'.repeat(64));
  out.push('  体检表（关键词统计，只是给人看的，不是判据）');
  out.push('-'.repeat(64));
  out.push('');
  out.push(`  部位·旧三样（后背/腰/颈 —— 就是"像互相按摩"那一片）：${dg.部位_旧三样}`);
  out.push(`  部位·肩（中性）：${dg.部位_肩}`);
  out.push(`  部位·别的（锁骨/胸口/小腹/胯/腿根…）：${dg.部位_别的}`);
  out.push(`  湿：${dg.湿}　　汗：${dg.汗}`);
  out.push(`  元层面（剧本/设定/演哪出…）：${dg.元层面}`);
  out.push(`  时间前推（明天/放学/晚安…）：${dg.时间前推}`);
  out.push(`  括号舞台指示：${dg.括号}`);
  out.push(`  平均字数：${dg.平均字数}`);
  out.push('');
  const hits = (label, list) =>
    out.push(`  ${label}：${list.length ? list.join('、') : '（没有）'}`);
  hits('旧三样出现在', dg.旧三样出现在.map((s) => s.replace(/saki/g, '祥子').replace(/anon/g, '爱音')));
  hits('湿出现在', dg.湿出现在.map((s) => s.replace(/saki/g, '祥子').replace(/anon/g, '爱音')));
  hits('元层面出现在', dg.元层面出现在);
  hits('时间前推出现在', dg.时间前推出现在.map((s) => s.replace(/saki/g, '祥子').replace(/anon/g, '爱音')));
  out.push('');
  out.push('-'.repeat(64));
  out.push('  正文');
  out.push('-'.repeat(64));
  for (const r of rs) {
    out.push('');
    if (r.err) {
      out.push(`【第 ${r.i} 轮 · ${NAME[r.role] ?? r.role}】❌ ${r.err}`);
      continue;
    }
    out.push(`【第 ${r.i} 轮 · ${NAME[r.role] ?? r.role}】(${r.ms}ms)`);
    for (const line of String(r.text).split(/\r?\n/)) {
      if (line.trim()) out.push('');
      if (line.trim()) out.push('    ' + plain(line.trim()));
    }
  }
  out.push('');
  return out.join('\r\n');
}

if (!DRY) {
  writeFileSync(join(ROOT, outFile), md, 'utf8');
  // ⚠️ 用户原话：「**你得把你跑出来的模拟消息内容放在桌面上，要不然我看不到**」
  //    ⇒ 每跑完一次都往桌面写一份纯文本。
  // ⚠️ 2026-10-23 用户又补：「**四次穿插到一起了，这次把四次分开**」——
  //    所以桌面那份**必须能分开**：`--desk-name` 给每次一个独立文件名，
  //    都放进桌面的 `剧情模拟` 文件夹里（不再全部覆盖成同一个文件）✓
  const DESK_NAME = String(arg('desk-name', '')).trim();
  const desk = deskDir();
  if (desk) {
    const folder = DESK_NAME ? join(desk, '剧情模拟') : desk;
    const f = join(folder, DESK_NAME || '剧情模拟-最新.txt');
    try {
      if (DESK_NAME) mkdirSync(folder, { recursive: true });
      writeFileSync(f, toDeskText({ digest: d, rounds }), 'utf8');
      console.log(`\n桌面报告：${f}`);
    } catch (e) {
      console.log(`\n⚠️ 桌面报告写失败：${e.message}`);
    }
  } else {
    console.log('\n⚠️ 没找到桌面目录 —— 传 --out 指定路径，或设 QQBOT_DESKTOP');
  }
  console.log('\n—— 体检表 ——');
  console.log(JSON.stringify(d, null, 2));
  // ⚠️ 2026-10-23 加：**把这一趟大概花了多少 token 报出来**（用户问过「跑 4 轮这么耗的吗」）。
  //    只是估算（中文约 1 字 ≈ 0.7 token），但足够判断"这一版测试值不值" ✓
  const inChars = rounds.reduce((a, r) => a + (r.sysLen || 0), 0);
  const outChars = rounds.reduce((a, r) => a + String(r.text ?? '').length, 0);
  const inTok = Math.round(inChars * 0.7);
  const outTok = Math.round(outChars * 1.3);
  console.log(
    `\n本次约：输入 ${(inTok / 10000).toFixed(0)} 万 token + 输出 ${(outTok / 10000).toFixed(1)} 万 token` +
      `（${rounds.length} 次调用，第一次调用就要 ${(inChars / Math.max(1, rounds.length) / 10000).toFixed(1)} 万字提示词）`,
  );
  console.log(`结果：${outFile}`);
}

// ⚠️ bot 构造里有定时器/监听 ⇒ 不显式退出会一直挂着
process.exit(0);
