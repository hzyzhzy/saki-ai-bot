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
// ⚠️⚠️⚠️ 2026-10-31 修（用户：「**--resume 之前用了那么多次都没问题啊**」）——
//    **真 bug 在这儿，不在 resume**：这一段清理跑在 RESUME 判断**之前**，
//    而 `progress.json` 正是 `.json` ⇒ **每次带 --resume 启动时，断点文件先被删了**，
//    然后 resume 读不到 ⇒ 静默退回"从头跑"。
//    ⇒ 之前那么多次"resume 成功"其实都是**碰巧从头跑完了**，不是真的续上 ✗
//    ⇒ 现在：带 `--resume` 时**保留 progress.json** ✓
const _KEEP_PROGRESS = process.argv.includes('--resume');
for (const f of readdirSync(join(ROOT, DIR))) {
  if (_KEEP_PROGRESS && f === 'progress.json') continue;
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
  // ⚠️ 2026-10-24 加 SCENE：现场状态机（道具/攻受/身体进度）—— 不加就会往用户真实的
  //    state/scene.json 里写模拟数据，正在演的那条剧情会被串掉 ✗
  'SCENE',
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
/**
 * `--dual`：**每轮把视角跟着说话的人切** —— 用来验「起因是谁的视角」那一条。
 *
 * ⚠️ 为什么需要它：真实的群里是**两个进程**，各自都把自己的号当成"我" ——
 *    那正是角色错位的根因；而普通模式只有一个视角（永远是自己），
 *    **从结构上复现不了**那个 bug ✗
 *    加了它之后，anon 那一轮会走"起因不是我写的"那个分支，就能验那条提示词有没有生效 ✓
 * ⚠️ 代价：人设正文还是**同一份**（import 时定死的）⇒ 语气不会真的换成另一个人 ——
 *    这里只验"视角判定"，不验语气 ✓
 */
const DUAL = hasFlag('dual');
// ⚠️ 2026-10-29 加：三人模式（`--trio`）—— 三个号轮流演，用于"素世在场"那类场景
const TRIO = hasFlag('trio');

/**
 * ⚠️⚠️⚠️ 2026-10-24 加（用户：「**模拟器也可以模拟一下在群里的手动用 /剧情 推进，
 * 而且这样能让剧情更受控，道具写得更有条理，可以每 8 轮对话之后就你来手动推进一次**」）
 *
 * 真群里是**用户在发 `/剧情 <方向>`** 在导演，模拟器原来从头到尾没人下命令 ⇒
 * 它自己越写越散、道具也想不起来用 ✗
 * 现在每 N 轮自动走一遍真群那条路：`quest.setNextHint()` ⇒ `chatBrief` 里会出现
 * 「🔴🔴🔴 群主刚刚下的剧情命令（最高优先级）」那一段 ✓
 * ⚠️ 方向和真群一样是**一句话**，不写细节（让模型自己去演）✓
 */
const ADVANCE_EVERY = Math.max(0, Number(arg('advance-every', '4')) || 0);

// ⚠️⚠️⚠️ 2026-10-29 加（用户：「**可以每场只拼一次提示词，然后一次直接生成 40 轮吗**」
//    后来定成「**一次生成 N 轮**」）：
//    **调用次数 = 轮数 / chunk**（40 轮 6 段 = 7 次调用），TPM 直接降 5~6 倍 ——
//    gemini 免费额度实测逐轮跑会在第 3 轮 429（9 万字提示词 × 每分钟多次 = 超 TPM）✓
//    ⚠️ 不是一次写 40 轮：那样前几轮细、后面越来越粗，而且第 8 轮跑偏时后面全废 ✓
//    ⚠️ 每段仍重新拼 system（内容一样 ⇒ 前缀缓存能命中），段与段之间的衔接靠
//      "把上一段的最后一段正文当 saidText 传进去" ✓
const CHUNK = Math.max(1, Math.min(12, Number(arg('chunk', '1')) || 1));

/**
 * ⚠️⚠️⚠️ 2026-10-24 加（用户：「**写一个大纲，直接每 4 轮就用大纲推进一次，
 * 这样剧情和道具就肯定不会写偏了**」+「**在推进里直接强调谁开始用道具干什么，
 * 然后对面怎么怎么样**」）
 *
 * 每步都写成「**谁做什么 → 对方什么反应**」，不是一句抽象方向 ⇒
 * 模型拿到就知道这一轮该演谁、演什么、对方怎么接 ✓
 * 用法：`--outline=她把脚递过去|她不接，她把话说白|她嘴硬但开始吸|她做不下去了`
 */
const OUTLINE = String(arg('outline', '') || '')
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean);
const ADVANCE_LINES = [
  '那个东西还没用上吧？拿出来用，别再用手指了。',
  '东西在手里就继续用，别放下，也别关。',
  '档位往上再调一格，或者换个角度用它。',
  '别让它跑出来，按回去，同时另一只手去做别的。',
  '那个东西还开着吧？别关，换姿势也带着它。',
  '差不多了，最后一次用它，然后收尾。',
];

// 群号 / 号 一律用占位符（这个脚本可能被公开副本带出去）
// ⚠️⚠️ 2026-10-24 加（用户：「**模拟验证规则时也比群里差点意思**」）：
//    真实群里的提示词是 **9~10 万字**，模拟只有 **7.6 万** —— 差的 2 万里主要是
//    **群记忆 + 这个群自己的资料**（`knowledge/groups/<群号>.md`、`group-memory.md`），
//    而模拟用的是假群号 ⇒ 那些文件根本不存在 ⇒ 它只能写"通用"的东西 ✗
//    ⇒ 想跟群里一模一样，就跑 `QQBOT_SIM_GID=<真实群号> node tools/quest-sim.mjs`
//      （默认仍是假号，公开副本不会泄露）
const GID = String(process.env.QQBOT_SIM_GID || '999000777');
const ROLE_A = { uid: '10000001', personaId: 'saki', nick: '丰川祥子' };
const ROLE_B = { uid: '10000002', personaId: 'anon', nick: '千早爱音' };
// ⚠️ 2026-10-29 加（用户：「**可以有第三人，现在已经有素世的人设了**」）：
//    第三个号（素世）—— 用 `--trio` 打开，三个号轮流演
const ROLE_C = { uid: '10000003', personaId: 'soyo', nick: '长崎素世' };

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
// ⚠️⚠️⚠️ 2026-10-28 加（用户：「**148 确实反了**」）：
//    seed 的**归属**决定整场攻受会不会对调 —— 原来写死 `by: 'anon'`（seed 算爱音说的），
//    可 s140~s151 这十二场的 seed 全是**祥子（S）说的那句**（「擦干净。」「看着。别动手。」…）
//    ⇒ 爱音在自己那一轮看到历史第一条是"我说的这句命令"⇒ 她把自己当成了 S
//      （s148 第 2 个发言就拿起鞭子、对小东西说「说你现在什么样」）✗
//    ⇒ 现在按 seedBy 分开：seed 是祥子的 ⇒ **第一轮由爱音回应**；seed 是爱音的 ⇒ 祥子回应 ✓
const SEED_BY = String(arg('seed-by', 'saki')).trim() === 'anon' ? 'anon' : 'saki';

// ── ③ 装模块 ───────────────────────────────────────────────────────
const { config } = await import('../src/config.js');
const persona = await import('../src/persona.js');
// ⚠️ 2026-10-23 加：`--dual` 要真的切人设，就得能重扫知识库
//    （`personaText()` 读的是 `knowledge.js` 里的内存缓存，只 reload identity 是不够的）
const knowledge = await import('../src/knowledge.js');
// ⚠️ 2026-10-24：现场状态机（道具/攻受/身体进度）—— 模拟器也要认她那行状态标记
const scene = await import('../src/scene.js');
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
config.groupParams[GID] = {
  ...(config.groupParams[GID] ?? {}),
  peers: TRIO ? [ROLE_A.uid, ROLE_B.uid, ROLE_C.uid] : [ROLE_A.uid, ROLE_B.uid],
};

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
// ⚠️ 视角判定要用它（chatBrief 里拿它跟 sharedOpener 的 by 比）⇒ 必须钉成同一个号
config.botQQ = ROLE_A.uid;
// ⚠️⚠️⚠️ 2026-10-24 加（用户：「**模拟验证规则时也比群里差点意思，可能模拟没出规则，但群里能出**」）：
//    真群里这时候 `questLive()` 是 **true**（剧情正在演）⇒ `buildSystemPrompt` **不会带**
//    `persona-chat.md`（群聊专用的那一叠，1 万字）。
//    而模拟器只写了共享起因、**没有真的 begin** ⇒ `questLive` 为假
//    ⇒ **多带 1 万字群聊规矩** ⇒ 模拟出来的东西和群里根本不是同一份提示词 ✗✗
//    ⇒ 直接打补丁：模拟里永远当成"正在演剧情" ✓
bot.questLive = () => true;

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
/**
 * ⚠️⚠️⚠️ 2026-10-24 加断点续跑（用户：「**之前不是跑到35了，为什么还要跑那么久**」）：
 * 原来每次从第 1 轮开始 ⇒ 一次挂在中途（35/40）就全部重来 ✗
 * 今天这种事发生过 4 次（s96 33/40、s97 35/40、s93 35/40…），白烧时间和钱。
 * ⇒ 每跑完一轮就把进度存到 `<QSIM_DIR>/progress.json`，启动时先读：
 *   `--resume` 就从断点接着跑；不带这个参数则照旧从头开始 ✓
 */
const PROGRESS_FILE = join(ROOT, DIR, 'progress.json');
const RESUME = hasFlag('resume');

// ⚠️ 2026-10-28：seed 的归属由 `--seed-by` 决定（默认 saki = 祥子说的那句）✓
let lines = [{ by: SEED_BY, text: SEED }];

/* ⚠️⚠️ 2026-11-07：**开场就把攻受钉住**（用户：「**又出现了之前攻受错乱的问题**」）——
 *
 *   模拟器只走聊天提示词（`buildSystemPrompt`），不进 `quest.begin()`；
 *   而"谁是 S"原来**只有模型自己写了「（状态：… 攻=X …）」之后才存在**
 *   ⇒ 第一轮谁也没写过 ⇒ 两个号都自由发挥 ⇒ 两边都当攻（s220 / s222 / s224 全是这个病）✗
 *
 *   真实群里不是这样：一条线只有**主导方**推进（`bot.js` 里非主导方 `advance` 直接 return），
 *   另一方只接话 ⇒ 攻受天然是定死的。
 *   ⇒ 这里开场写一次 `top`，跟"主导方发起"对齐；之后模型自己报的状态会覆盖它 ✓
 *   ⚠️ 谁当 S 用 `--top=saki|anon`（默认 saki = 祥子），跟着起因改就行 ✓
 */
const TOP_ID = String(arg('top', 'saki')).trim() === 'anon' ? 'anon' : 'saki';
const TOP_NAME = TOP_ID === 'anon' ? '爱音' : '祥子';
try {
  scene.apply(GID, { top: TOP_NAME });
} catch {}
let resumeFrom = 0;
if (RESUME) {
  try {
    const saved = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
    if (Array.isArray(saved.lines) && saved.lines.length) {
      lines = saved.lines;
      resumeFrom = Number(saved.rounds) || 0;
      console.log(`↻ 续跑：从第 ${resumeFrom + 1} 轮接着（已有 ${lines.length} 条历史）`);
    }
  } catch {
    console.log('（没有可续的进度，从头开始）');
  }
}

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
    // ⚠️ 2026-11-08：显式打 tag —— 否则账单上看不出是模拟器烧的
    tag: 'quest-sim',
    report,
  });
  for await (const d of gen) out += d;
  // 空正文（实测偶发：思考链把上限吃光 / 被截断）⇒ 记下来，别让它当"她说了空话"进上下文
  if (!out.trim()) out = '';
  return { out, report };
};

/** 生成一轮：返回 { text, sysLen, err, ms } */
/**
 * chunk 模式：把「【轮1·祥子】正文【轮2·爱音】正文…」切成 [{by, text}, …]
 * ⚠️ 标记必须从正文里剥掉 —— 模型会连标记一起写进正文（这个项目踩过好几次）
 */
function splitBatch(raw, me, other, batch) {
  const re = /【\s*轮\s*\d+\s*[·.、:：]?\s*([^】\n]{1,12})】/g;
  const hits = [...raw.matchAll(re)];
  if (!hits.length) return [];
  const out = [];
  for (let k = 0; k < hits.length; k++) {
    const from = hits[k].index + hits[k][0].length;
    const to = k + 1 < hits.length ? hits[k + 1].index : raw.length;
    const text = raw
      .slice(from, to)
      .replace(/【\s*轮\s*\d+[^】\n]{0,14}】?/g, '')
      .trim();
    if (!text) continue;
    const tag = hits[k][1];
    const isOther = other.nick && tag.includes(other.nick);
    out.push({ by: isOther ? other.personaId : me.personaId, text });
  }
  return out.slice(0, batch);
}

const oneTurn = async (me, other, saidText, batch = 1) => {
  bot.selfId = String(me.uid);
  // `--dual`：**真·双人设** —— 视角 + identity + 人设正文一起切（2026-10-23 补）
  // ⚠️ 之前只切了 `config.botQA`（视角）和 selfId，**漏了 persona.reload() 和
  //    knowledge.reloadKnowledge()** ⇒ 正文永远是第一次加载的那份 ⇒
  //    anon 那几轮其实是"爱音的身份 + 祥子的人设"在打架，所以测不准角色错位 ✗
  if (DUAL || TRIO) {
    config.botQQ = String(me.uid);
    // ⚠️⚠️⚠️ 2026-10-24 修（用户：「**s119 出现了比较严重的角色错位和剧情重复的问题**」）：
    //    **`bot.selfId` 之前只在这个文件开头设过一次**（`ROLE_A.uid`，也就是祥子的号）⇒
    //    爱音那几轮 `bot.selfId` 还是祥子的 QQ ⇒ 它里面所有按 selfId 的判定（含 `chatBrief`
    //    的视角、`buildSystemPrompt` 里"我是谁"）**全按祥子走**，可人设已经切成了爱音
    //    ⇒ **身份和设定打架** ⇒ 角色错位 + 把对方的台词当成自己的重复一遍 ✗✗
    // ⚠️ 2026-10-25 撤回：改成 me.uid 之后爱音那轮输出空正文
    // bot.selfId = String(me.uid);
    if (String(config.persona?.id ?? '') !== String(me.personaId)) {
      config.persona = { ...(config.persona ?? {}), id: me.personaId };
      persona.reload(); // ② 名字 / 自称 / 称呼
      knowledge.reloadKnowledge(); // ③ persona.md / cast / life-events 的正文缓存
    }
  }
  const t0 = Date.now();
  let sysLen = 0;
  // ⚠️ `marks` 必须声明在 try **外面** —— 它原来写在 try 里，而 catch 也要返回它 ⇒
  //    一旦 `buildSystemPrompt` 在它之前抛错，catch 里就 `ReferenceError: marks is not defined`
  //    （实测：那一轮的错误被这个 ReferenceError 顶掉，进程直接以退出码 1 结束 ✗）
  const marks = [];
  try {
    const ev = evOf(other, me, saidText);
    // ⚠️⚠️⚠️ 2026-10-24 改（用户：「**大纲要明确名字，每 4 轮按大纲推进**」，实测 setNextHint 读回来是空）
    //    ⇒ 不再走那个中转，**直接把这一步拼进提示词的 extra**（第一个参数），
    //      它一定看得见 ✓ 并且要求"至少两三句把这步演完" ✓
    // ⚠️⚠️⚠️ 2026-10-24 修（实测：写了"至少两三句"之后平均字数从 137 掉到 19 ——
    //    模型把那个数字当成**上限**，写够两三句就收 ✗）
    //    ⇒ **只给大纲内容，一个句数/字数都不提** ✓
    // ⚠️⚠️⚠️ 2026-10-24 再修（实测链：有大纲+指令 24 字 → 去掉"两三句"仍 24 → 干脆不传 extra 48 字）
    //    ⇒ 结论：**extra 里只要带指令口吻，字数就减半**（模型转成"执行任务"模式）
    //    ⇒ 现在**只放大纲正文**，一个 ✅/🚫/"演透"都不放 ✓
    // ⚠️⚠️⚠️ 2026-10-24 四改（用户：先报"群主"、再报"攻受混乱"、再发现"大纲被抄进正文"）：
    //    结论：**模拟器不该自己注入大纲** ——
    //      · 放 `user` 历史 ⇒ 冒出"群主"、还把它当角色 ✗
    //      · 放 `assistant` 历史 ⇒ 被原样照抄进正文 ✗
    //      · 放 `extra` ⇒ 实测字数砍半（48→24→19）✗
    //    ⇒ 正解：**`quest.js` 的 `chatBrief` 里已经有 `OUTLINE_BY_ROUND`**（按轮次自动推），
    //      而模拟器调的就是**真的 `chatBrief`** ⇒ 它本来就会走那条路 ✓ 这里不要再注入一遍 ✗
    const extra = '';
    // ⚠️⚠️⚠️ 2026-10-29 加（用户：「**模拟剧情的时候可以少拼一点知识库，群里真跑的时候再拼全量**」）：
    //    第 10 个参数 `lean` —— 传 true 时 `buildSystemPrompt` **只留人设**，
    //    服务器库 / 群记忆 / 故事线 / 学习档案 / 表情清单**全都不带** ✓
    //    ⇒ 提示词从 9 万多字掉到 3 万左右（实测 gemini 每轮从 19 秒降到几秒）；
    //    ⚠️ 剧情那几段（成人铁律 / 门槛 / 大纲 / 湿与到顶）**不受影响** ——
    //       它们走的是 `config.llm.unfiltered` 那条路，跟知识库无关 ✓
    //    ⚠️ 只影响**模拟器**；群里真跑还是全量 ✓
    const sys = bot.buildSystemPrompt(extra, ev, null, saidText, '', '', '', '', false, true);
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
        // ⚠️⚠️⚠️ 2026-10-24 修严重重复（用户截图：第 9 轮祥子和第 10 轮爱音的正文一字不差）：
        //    `SELF` 是**启动时定死的**（saki），`--dual` 只切了 botQQ / persona / 知识库，
        //    **漏了这个投影** ⇒ 爱音那轮看到的「assistant」全是**祥子**说的话 ⇒
        //    它以为那是自己说过的 ⇒ 原样复述上一轮 ✗✗
        role: l.by === (DUAL ? String(me.personaId) : SELF) ? 'assistant' : 'user',
        content: l.text,
      })),
      // ⚠️⚠️⚠️ 2026-10-24 三改（用户：「**119 攻受混乱**」修好之后又发现**大纲被抄进正文**）：
      //    `role: 'assistant'` 那条「（这一轮我心里有数：…）」⇒ 模型以为"我说过这种格式"，
      //    正文里原样照抄了一遍：
      //      `（这一轮我心里有数：（第 2/10 步）【仍是祥子动手】祥子捏着爱音的下巴…）` ✗✗
      //    ⇒ 模型会模仿历史里的任何格式 ⇒ **大纲不能放历史**。
      //    也不能放 extra 里带指令口吻（实测会让字数砍半）⇒ 折中：
      //    **放进 extra，但只放内容本身、一个指令词都没有**（就一行【本段走向】+ 内容）✓
      // ⚠️⚠️⚠️ 2026-10-26 尝试（用户：「**别退了，直接以现在为基础去把字少修好**」）：
      //    今天唯一的"长文"（325 字）是**大纲放在对话历史里**那版；
      //    改成 `chatBrief`（系统提示）之后掉到 41 字 ⇒ 系统提示里的任何附加内容都会被当成"任务说明"✗
      //    ⇒ 现在把大纲包成**对方的反应暗示**塞进对话历史：
      //      以 user 角色、像一句描写（不出现"群主"、也不是台词模板）✓
      // ⚠️ 2026-10-25 恢复（那次"第 2 轮空正文"其实是代理 7890 挂了，不是注入的问题）：
      //    大纲以「对方的反应」形式塞进对话历史 —— 放系统提示会被当成任务说明（41 字），
      //    放对话历史才按对话写（260 字）✓ 不出现"群主"、也不是台词模板 ✓
      ...(CURRENT_STEP
        ? [
            {
              role: 'user',
              content: `（${other.nick}那边忽然变了节奏 —— ${CURRENT_STEP}）`,
            },
          ]
        : []),
      { role: 'user', content: `${other.nick}刚发来的消息：「${saidText}」` },
      // ⚠️ 2026-10-29 加（chunk 模式）：一次要 N 轮，用固定标记分隔，解析时把标记剥掉
      //    ⚠️ 第一版写成"（接着往下写 6 轮…）"，实测模型**只写一轮**就停
      //      （它已经习惯了历史里"一次回一段"）⇒ 必须把格式摆出来、
      //      并且明说"不许只写一轮"✓
      ...(batch > 1
        ? [
            {
              role: 'user',
              content:
                `（这一条只做一件事：**连续写 ${batch} 轮，一轮都不许少**。${me.nick}和${other.nick}交替，` +
                `第一轮是${me.nick}。格式严格如下 ——\n` +
                `【轮1·${me.nick}】\n正文…\n【轮2·${other.nick}】\n正文…\n……一直到【轮${batch}】\n` +
                `🚫 不许只写一轮、不许总结。⚠️ 每一轮都要写成完整的一整段（像单独回一条消息那样），不许因为一次写好几轮就把每轮写短。）`,
            },
          ]
        : []),
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
    // ⚠️ 2026-10-29 加（chunk 模式）：把【轮K·角色】标记切成一堆轮
    //    ⚠️ 标记要**从正文里剥掉**（模型可能连标记一起写进正文）
    const raw = got.out.trim();
    if (batch > 1) {
      const segs = splitBatch(raw, me, other, batch);
      if (segs.length >= 2) return { texts: segs, sysLen, marks, err: '', ms: Date.now() - t0 };
      // 解析不出来就退回"整段当一轮"（保守，别丢内容）—— ⚠️ 标记一定要剥掉
      const only = raw.replace(/【\s*轮\s*\d+[^】\n]{0,14}】?/g, '').trim();
      console.log(`  ⚠️ chunk 解析失败（只切出 ${segs.length} 段）→ 整段当作第 1 轮`);
      return { texts: [{ by: me.personaId, text: only || raw }], sysLen, marks, err: '', ms: Date.now() - t0 };
    }
    return { text: raw, sysLen, marks, err: '', ms: Date.now() - t0 };
  } catch (e) {
    return { text: '', sysLen, marks, err: e?.message ?? String(e), ms: Date.now() - t0 };
  }
};

/** 把一轮的结果记回本地状态（下一轮就看得见了 —— 这一步是"保真"的关键） */const rememberTurn = (me, other, saidText, mine) => {
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
// ⚠️ 当前该走的大纲步骤（主循环每轮更新，oneTurn 里拼进提示词的 extra）
let CURRENT_STEP = '';
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

for (let i = resumeFrom + 1; i <= ROUNDS; i++) {
  // ⚠️ 2026-10-24：每 N 轮，模拟群主发一次 `/剧情 <方向>`（走的是真群那条路）
  if (ADVANCE_EVERY && i > 1 && (i - 1) % ADVANCE_EVERY === 0) {
    const step = Math.floor((i - 1) / ADVANCE_EVERY - 1);
    // ⚠️ 带进度（用户：「**建议大纲不要循环，就按 60 轮的次数和进度去认真写好**」）：
    //    让它知道"这是第几步、总共几步" ⇒ 不会以为做过了就完事 ✓
    const pool = OUTLINE.length ? OUTLINE : ADVANCE_LINES;
    const idx = step % pool.length;
    const dir = `（第 ${idx + 1}/${pool.length} 步）${pool[idx]}`;
    try {
      quest.setNextHint(GID, dir);
      console.log(`\n=== 【群主推进 #${(i - 1) / ADVANCE_EVERY}】${dir} ===`);
    } catch (e) {
      console.log(`\n⚠️ 推进注入失败：${e.message}`);
    }
  }
  // ⚠️⚠️ 2026-10-28 改（用户：「**148 确实反了**」）：
  //    第一轮由**不是 seed 说话人**的那个号开始回应 ——
  //    seed 是祥子的（默认）⇒ 第 1 轮爱音接；seed 是爱音的 ⇒ 第 1 轮祥子接 ✓
  //    原来固定"第 1 轮祥子"，配上写死的 `by:'anon'` 就等于"爱音先发了祥子那句命令"，
  //    于是爱音那一轮把自己当 S（拿鞭子、喊小东西）⇒ 整场攻受对调 ✗
  const firstIsB = SEED_BY === 'saki';
  // ⚠️ 2026-10-29：三人模式三号轮换（seed 是祥子的 ⇒ 第一轮从爱音开始，然后素世、祥子…）
  const ROLES = TRIO ? [ROLE_A, ROLE_B, ROLE_C] : [ROLE_A, ROLE_B];
  const me = TRIO
    ? ROLES[(i - 1 + (firstIsB ? 1 : 0)) % ROLES.length]
    : (i % 2 === 1) === firstIsB
      ? ROLE_B
      : ROLE_A;
  // ⚠️ 每 4 轮换一步大纲（第 1~4 轮是第 1 步，5~8 是第 2 步…）
  {
    const pool = OUTLINE.length ? OUTLINE : ADVANCE_LINES;
    const stepIdx = Math.floor((i - 1) / Math.max(1, ADVANCE_EVERY)) % pool.length;
    CURRENT_STEP = `（第 ${stepIdx + 1}/${pool.length} 步）${pool[stepIdx]}`;
  }
  const other = TRIO ? ROLES[(ROLES.indexOf(me) + 1) % ROLES.length] : me === ROLE_A ? ROLE_B : ROLE_A;
  // ⚠️ 这里**不切人设** —— 视角从头到尾是同一个号（见 `SELF` 那段）✓
  const batch = Math.min(CHUNK, ROUNDS - i + 1);
  const r = await oneTurn(me, other, saidText, batch);
  // ── chunk 模式：一次拿回 N 轮 ──────────────────────────────────
  if (r.texts && r.texts.length) {
    for (const item of r.texts) {
      if (i > ROUNDS) break;
      let text = item.text;
      try {
        const _sc = scene.takeMarker(text);
        if (_sc.patch) scene.apply(GID, _sc.patch);
        if (_sc.text) text = _sc.text;
      } catch {}
      rounds.push({
        i,
        role: item.by,
        text,
        ms: Math.round(r.ms / r.texts.length),
        sysLen: r.sysLen,
        marks: r.marks,
        err: '',
        advance: false,
      });
      lines.push({ by: item.by, text });
      saidText = text;
      console.log(`\n[${i} ${item.by} ${r.ms}ms 提示词${r.sysLen}字 · chunk ${r.texts.length} 轮]`);
      console.log(text);
      i++;
    }
    try {
      writeFileSync(PROGRESS_FILE, JSON.stringify({ rounds: i - 1, lines }, null, 0), 'utf8');
    } catch {}
    i--; // for 的 i++ 会补上
    // ⚠️⚠️ 2026-10-29 加（实测 gemini 免费额度：9 万字提示词 ≈ 5~9 万 token，
    //    TPM 上限 25 万 ⇒ **一分钟只能调 2 次**，第 3 次就 429）
    //    ⇒ chunk 模式下每段之间歇 25 秒，整场就再也不会撞限流 ✓
    if (CHUNK > 1 && i + 1 <= ROUNDS) {
      const waitMs = Math.max(0, Number(arg('chunk-gap', '25')) || 0) * 1000;
      if (waitMs) {
        console.log(`（歇 ${Math.round(waitMs / 1000)} 秒避开限流…）`);
        await new Promise((s) => setTimeout(s, waitMs));
      }
    }
    continue;
  }
  // ⚠️ 2026-10-24：她可能在末尾写一行（状态：…）—— 存进现场状态机、从正文里剥掉
  try {
    const _sc = scene.takeMarker(r.text);
    if (_sc.patch) scene.apply(GID, _sc.patch);
    if (_sc.text) r.text = _sc.text;
  } catch {}
  rounds.push({ i, role: me.personaId, text: r.text, ms: r.ms, sysLen: r.sysLen, marks: r.marks, err: r.err, advance: ADVANCE_EVERY && i > 1 && (i - 1) % ADVANCE_EVERY === 0 });
  if (r.err) {
    console.log(`\n[${i} ${me.personaId}] ❌ 失败：${r.err}`);
    break;
  }
  console.log(`\n[${i} ${me.personaId} ${r.ms}ms 提示词${r.sysLen}字 ${(r.marks||[]).join(" · ")}]`);
  console.log(DRY ? '（dry）' : r.text);
  if (DRY) break;
  rememberTurn(me, other, saidText, r.text);
  lines.push({ by: me.personaId, text: r.text });
  // 断点续跑：每轮存一次（挂了下次 --resume 接着跑）
  try {
    writeFileSync(
      PROGRESS_FILE,
      JSON.stringify({ rounds: i, lines }, null, 0),
      'utf8',
    );
  } catch {}
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
  // ⚠️⚠️ 2026-10-23 改（用户：「**以后每次跑完测试直接把每轮润滑成一篇小说形式吧，
  //    更有方便阅读和找毛病**」）：
  //    ⇒ 去掉「第 N 轮 / 14916ms / 提示词 76590 字」那堆元信息（体检表里已经有统计了），
  //      正文**按段落排成小说**：段首缩进、段间空行、**段首只留一个极小的 `【轮次 名字】`**
  //      用来定位（找毛病时还得知道这句话是谁说的、在第几轮）✓
  for (const r of rs) {
    if (r.err) {
      out.push(`　　【${r.i} ${NAME[r.role] ?? r.role}】❌ 这一段失败了：${r.err}`);
      out.push('');
      continue;
    }
    const lines = String(r.text ?? '')
      .split(/\r?\n/)
      .map((x) => plain(x.trim()))
      .filter(Boolean);
    if (!lines.length) continue;
    out.push(`　　【${r.i} ${NAME[r.role] ?? r.role}】${lines[0]}`);
    for (const line of lines.slice(1)) out.push(`　　${line}`);
    out.push('');
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
