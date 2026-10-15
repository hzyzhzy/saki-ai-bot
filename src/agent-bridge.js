/**
 * 让**本机的 agent**（DSH 的 headless 模式）替群里干活。
 *
 * ## 用户定的规则（2026-10-13 原话，一个字都别改）
 *
 *   「可以让 bot 接入本机上的 agent 完成一些简单的任务吗」
 *   「<本机用户目录>\OneDrive - yijia\文档\agentwork，**要支持自然语言**，
 *     现在**只允许主人 QQ 能直接开始任务**。
 *     bot 发送的**确认开始任务**发的消息**前面加两个空格**来分辨是否开始了任务，
 *     其他人要开始的话 bot 先发一条 **@主人** 的消息问主人是否同意，
 *     回复**同意**的消息之后再开始。**前面的部分全部是自然语言**。
 *     加指令：`/任务撤回`，负责撤回刚才开始的任务。」
 *
 * ## 流程（全自然语言，只有撤回那条是斜杠指令）
 *
 * ```
 * 主人自己说一句任务   ──判定是任务──▶ 回「  行，我去弄」（★ 前面两个空格）
 *                                        └─▶ 起 headless agent（cwd = 工作区）
 * 别人说一句任务       ──判定是任务──▶ 回「@主人 有人让我…，行不行？」
 *                                        └─▶ 主人回「同意」──▶ 同上
 * 主人回「不行」       → 那件事作废
 * /任务撤回            → 把**正在跑**的那个杀掉（或撤掉还没批的那件）
 * ```
 *
 * ## 为什么"两个空格"要单独当约定
 *
 * 用户要的是**能从消息外观上分辨"任务到底开始没开始"** ——
 * 因为他自己（或脚本）要在群里/日志里扫这条。所以：
 *   · **确认开始任务**那条：**两个半角空格开头**（`  `）✓
 *   · 别的消息（询问、结果、回执）**一律不带**这个前缀 ✗
 *
 * ## 安全边界（都是踩过的地方，别放松）
 *
 * 1. **任务当单个 argv 传** —— `spawn(node, [dsh, '--profile', 'headless', 任务])`，
 *    **绝不拼 shell / 命令行**（群里的话是不可信输入）。
 * 2. **沙箱 = workspace-write**（DSH 默认）：能写**只有**工作区，工作区之外写会被拒。
 *    ⚠️ 实测（2026-10-13）：越权写会被沙箱拒绝、提权申请因无审批通道自动被拒 ✓
 *    ⚠️ 但**读**没有限制 ⇒ 所以提示词里钉死"只读工作区里的东西、不许回显凭据"。
 * 3. **只取 stdout**（`stderr` 是它的思考过程，别发群），截断 + 脱敏后再发。
 * 4. **每日次数上限** + 同时只跑一个（agent 很贵，而且会互相抢文件）。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { config, ROOT, stateDir } from './config.js';
import { log } from './log.js';
// ⚠️⚠️ 2026-10-14 加（用户：「该去**读那一段对话**」）：要给 agent 带上"群里刚才那些话"。
//    ⚠️ 必须**静态 import**（同步取）—— `startRun` 是**不等它**被调的
//    （调用方 `startRun(...).catch(...)` 不 await），多一个 `await import` 就会让
//    `runnerImpl` 慢一拍被调 ⇒ 套件里当场抓到「先跑起来 实际 0 次」✗
//    （真机上的表现是"她说完那句之后愣一下才动手"）
//    ⚠️ `recent.js` 不 import 本文件 ⇒ 不会成环 ✓
import * as recentStore from './recent.js';

const FILE = process.env.QQBOT_AGENT_FILE
  ? join(ROOT, process.env.QQBOT_AGENT_FILE)
  : join(stateDir(), 'agent.json');

/**
 * ⚠️⚠️ 2026-10-13 加（用户：「**然后加任务页**」）——
 * **任务历史**（给管理界面那页读的）：一次任务一条，最多留 200 条 ✓
 * ⚠️ 为什么不用 `state.agent.json`：那里只留"当前正在跑的那个"，
 *    历史得单独存 ✓（含产物清单、她最后说的话、会话 id —— 页面点开就能看对话 ✓）
 */
const HIST_FILE = process.env.QQBOT_AGENT_TASKS_FILE
  ? join(ROOT, process.env.QQBOT_AGENT_TASKS_FILE)
  : join(stateDir(), 'agent-tasks.json');
let hist = { tasks: [] };
function loadHist() {
  try {
    const j = JSON.parse(readFileSync(HIST_FILE, 'utf8'));
    if (Array.isArray(j?.tasks)) hist = { tasks: j.tasks };
  } catch {
    /* 第一次还没有 */
  }
}
function saveHist() {
  try {
    mkdirSync(dirname(HIST_FILE), { recursive: true });
    const tmp = `${HIST_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tasks: hist.tasks.slice(-200) }, null, 2), 'utf8');
    renameSync(tmp, HIST_FILE);
  } catch (e) {
    log.debug(`[任务] 历史写不进去：${e.message}`);
  }
}
/**
 * ⚠️⚠️ 2026-10-13 加（用户：「**15 秒刷新改成对话有更新时刷新吧**」）：
 * 任务页不再定时轮询 —— 由这里在**任务真的变了**的时候通知它（SSE 推送 ✓）。
 * @param {() => void} fn
 * @returns {() => void} 退订
 */
const histListeners = new Set();
export function onTaskChange(fn) {
  if (typeof fn === 'function') histListeners.add(fn);
  return () => histListeners.delete(fn);
}
function notifyTaskChange() {
  for (const fn of [...histListeners]) {
    try {
      fn();
    } catch {}
  }
}

function addHist(rec) {
  hist.tasks.push(rec);
  saveHist();
  notifyTaskChange();
  return rec;
}
function updHist(id, patch) {
  const t = hist.tasks.find((x) => x.id === id);
  if (t) {
    Object.assign(t, patch);
    saveHist();
    notifyTaskChange();
  }
}
/** 任务历史（**新的在前**；管理界面那页用的就是它） */
export function taskHistory(limit = 50) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  return hist.tasks.slice(-n).reverse().map((x) => ({ ...x }));
}
loadHist();

/**
 * ⚠️⚠️ 2026-10-13 加（任务页要"点开看那次到底聊了什么"）：把一条会话里的
 * **user / assistant 的正文**抠出来。
 *
 * ⚠️⚠️ 那个 `session.v3.jsonl.zstd` 是**多帧 zstd 拼接**的（每行一个独立帧）——
 *    `zstdDecompressSync()` **只解第一帧**（于是只能看到 202 字节的会话头，
 *    害我以为"会话没存内容" ✗）。必须**按 magic 切开、逐帧解** ✓
 *
 * @returns {Promise<Array<{role:'user'|'assistant', text:string, time?:number}>>}
 */
export async function readSessionTalk(sessionId, { maxChars = 20000 } = {}) {
  const sid = String(sessionId ?? '').trim();
  if (!sid || !/^session-[\w-]+$/.test(sid)) return [];
  const root = join(dshHome(), 'sessions');
  let file = '';
  try {
    for (const ws of readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      const f = join(root, ws.name, sid, 'session.v3.jsonl.zstd');
      if (existsSync(f)) {
        file = f;
        break;
      }
    }
  } catch {}
  if (!file) return [];
  try {
    const zlib = await import('node:zlib');
    const buf = readFileSync(file);
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const idx = [];
    for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(magic, 0, 4, i, i + 4) === 0) idx.push(i);
    const out = [];
    let total = 0;
    for (let k = 0; k < idx.length; k++) {
      const seg = buf.slice(idx[k], k + 1 < idx.length ? idx[k + 1] : buf.length);
      let text = '';
      try {
        text = zlib.zstdDecompressSync(seg).toString('utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim() || line[0] !== '{') continue;
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        if (j.type !== 'user/message' && j.type !== 'assistant/message') continue;
        const blocks = j.data?.message?.content ?? j.data?.content ?? [];
        const body = (Array.isArray(blocks) ? blocks : [])
          .map((b) => (typeof b === 'string' ? b : String(b?.text ?? '')))
          .join('')
          .trim();
        if (!body) continue;
        const role = j.type === 'user/message' ? 'user' : 'assistant';
        // ⚠️ 我们注入的那整段提示词太长 ⇒ user 只留**尾巴**（任务原文在那儿）、assistant 留开头
        const cut = role === 'user' ? body.slice(-500) : body.slice(0, 4000);
        out.push({ role, text: cut, time: j.time });
        total += cut.length;
        if (total > maxChars) return out;
      }
    }
    return out;
  } catch (e) {
    log.warn(`[任务] 读会话失败（${sid}）：${e.message}`);
    return [];
  }
}

const cfg = () => config.agent ?? {};
const nz = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/** ⚠️ **两个空格** —— 用户要求：确认"任务已开始"的那条消息靠它认出来 */
export const CONFIRM_PREFIX = '  ';

/**
 * 这个功能开着吗。
 *
 * ⚠️ `QQBOT_AGENT=off` 可以**一刀关掉**（环境变量优先）——
 *    回归里就是这么关的：它**会真的起一个 agent 进程**（花钱、还可能改工作区文件），
 *    套件给的文件本来就不该被它碰。要测它的是 `test/agent-bridge.js`，它会显式打开。
 */
export function enabled() {
  const env = String(process.env.QQBOT_AGENT ?? '').trim().toLowerCase();
  if (env === '0' || env === 'off' || env === 'false') return false;
  // ⚠️⚠️ 2026-10-14 加：**显式 `on` 就直接开**（原来只认"off"，`on` 还要 config 里也是 true ✗）
  //    踩到的：`test/prompt-snapshot.js` 为了"手动跑和 run-all 跑一致"，显式钉了
  //    `QQBOT_AGENT=on` —— 可套件的测试配置里没有 `agent.enable` ⇒ 照样是 false ⇒
  //    提示词里「🖥️ 你自己有一台电脑」那段时有时无 ⇒ 手存基线、进回归就红 ✗
  //    ⇒ "环境变量优先"这条规矩本来就该两头都认 ✓
  if (env === '1' || env === 'on' || env === 'true') return true;
  return cfg().enable === true;
}

/** 工作区（agent 的 cwd，也是它唯一能写的地方） */
export function workspace() {
  const w = String(cfg().workspace ?? '').trim();
  return w || '';
}

/**
 * ⚠️⚠️ DSH 的**用户数据目录**（`DSH_HOME`）。
 *
 * 为什么要显式算它、还要显式传给子进程（2026-10-13 实测踩的）：
 *   我自己会话里跑得好好的，一交给**看门狗/独立进程**就报
 *   `profile "agenttask" does not exist` —— 因为那个环境里**没有 `DSH_HOME`**，
 *   DSH 于是去找**另一个 home**，而我们建的那个 profile 在真正的 home 里 ✗
 */
function dshHome() {
  const c = String(cfg().dshHome ?? '').trim();
  if (c) return c;
  // ⚠️ `QQBOT_DSH_HOME` **排在 `DSH_HOME` 前面**：它是套件的显式覆盖，
  //    必须赢过环境里那个（不然测试会去改**真实**的 workspace.json —— 2026-10-13 踩过）
  const q = String(process.env.QQBOT_DSH_HOME ?? '').trim();
  if (q) return q;
  const env = String(process.env.DSH_HOME ?? '').trim();
  if (env) return env;
  return 'C:\\Users\\<主人>\\AppData\\Local\\DeepSeekHarness\\.dsh';
}

/** DSH 的 node 与 bin（默认按本机便携版的位置） */
function runner() {
  const c = cfg();
  return {
    node:
      String(c.node ?? '').trim() ||
      'C:\\Users\\<主人>\\AppData\\Local\\Programs\\DeepSeekHarness\\node\\node.exe',
    dsh:
      String(c.dsh ?? '').trim() ||
      'C:\\Users\\<主人>\\AppData\\Local\\Programs\\DeepSeekHarness\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    // ⚠️⚠️ 默认 **headless**（2026-10-13 定，见 `config.js` 里那张对照表）：
    //    headless **有工具、能真动手**，而且实测**会话也落盘**；agenttask 那条
    //    stdio JSON-RPC 的路抓帧数过 —— `tools` 零匹配，agent 只能"说"✗
    profile: String(c.profile ?? 'headless').trim() || 'headless',
    // 模型走这个 profile 的默认路由（和用户 GUI 里那套一致）
    provider: String(c.provider ?? 'deepseek-official').trim() || 'deepseek-official',
    model: String(c.model ?? 'deepseek-flash').trim() || 'deepseek-flash',
    effort: String(c.reasoningEffort ?? 'high').trim() || 'high',
  };
}

let state = { day: '', count: 0, running: null, pending: null, clarify: null, folders: {}, continues: {}, queuedExtra: {} };
function load() {
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    state = { ...state, ...(j && typeof j === 'object' ? j : {}) };
  } catch {
    /* 第一次还没有这个文件 */
  }
}
/**
 * 记下"这条群消息**已经被任务桥接管过**"（存 message_id）。
 *
 * ⚠️⚠️ 2026-10-13 加（用户：「**掉线之后的补回不要回已经接过任务的话**」）：
 *   `catchUpMissed()` 会在重启后把上线前 10 分钟漏掉的 @ 捞回来重答，而**任务桥接管的那些
 *   压根不进聊天上下文**（`handle()` 返回 true 就 return 了）⇒ 补看以为"没回过"，
 *   于是她把派过的活**又答一遍**（甚至是"你掉线了？我早写完了，再发你一遍"）✗
 *   ⇒ 这里留一份 id，补看照着跳过（`wasHandled()`）。
 */
function rememberHandled(mid) {
  const m = String(mid ?? '').trim();
  if (!m) return;
  if (!Array.isArray(state.handled)) state.handled = [];
  if (state.handled.includes(m)) return;
  state.handled.push(m);
  // 只留最近 50 条（补看只看 10 分钟内的，够用）
  if (state.handled.length > 50) state.handled = state.handled.slice(-50);
  save();
}

/** 这条消息是不是已经被任务桥接管过了（给 `catchUpMissed` 用） */
export function wasHandled(mid) {
  const m = String(mid ?? '').trim();
  return !!m && Array.isArray(state.handled) && state.handled.includes(m);
}
function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, FILE);
  } catch (e) {
    log.debug(`[任务] 状态写不进去：${e.message}`);
  }
}
load();

// ⚠️⚠️⚠️ 2026-10-13 加（实测踩到的僵尸状态）：
//    **新进程里不该再挂着上个进程留下的"正在跑"** ——
//    进程一重启，那个任务的子进程、超时计时器、`await` 全都灰飞烟灭了 ⇒ 它**永远不会结束**，
//    可 `state.running` 还留在文件里 ⇒ 后果有两个：
//      · 之后**每一次**派活都被「手上这个还没弄完，等会儿再说」挡回去 ✗
//      · 她聊天时还会拿它当话题、自己圆一套说法（现场就是「那个简历的活，我停了…
//        我压根不知道从哪写起」—— 那个活其实是被重启打断的，她自己编了个理由 ✗）
//    ⇒ 启动时**直接清掉**：跨进程的"正在跑"没有任何意义 ✓
if (state.running) {
  const t = String(state.running.task ?? '').slice(0, 40);
  // ⚠️⚠️⚠️ 2026-10-14 改（用户：「**以后重启不要断掉之前的任务，要自动恢复**」）：
  //    原来是**直接清掉** ✗ ⇒ 那个活就**永远没了**（她甚至会在群里自己编个理由 ✗）
  //    ⇒ 现在把它记进 `state.resume`：等机器人连上之后由 `resumePending()` **接着做完** ✓
  //      （复用同一个任务文件夹 ⇒ 它先读 `这个活的对话.md` 就知道上一轮做到哪儿 ✓）
  log.warn(`[任务] 启动时发现上个进程留下的"正在跑"（${t}）→ **排队等着自动接着做**（用户要求：重启不要断掉）`);
  state.resume = { ...state.running, resumeAt: Date.now() };
  state.running = null;
  save();
}
// ⚠️ 2026-10-14：任务历史里那条"正在跑"也要**标成被打断** ——
//    不然任务页上它**永远显示 running** ✗（用户截图问过：「为什么没有显示的」）
try {
  let changed = false;
  for (const t of hist.tasks) {
    if (t && t.status === 'running') {
      t.status = 'killed';
      t.endedAt = Number(t.endedAt) || Date.now();
      changed = true;
    }
  }
  if (changed) saveHist();
} catch {}

/** 测试用：把状态清干净 */
export function __reset() {
  state = {
    day: '',
    count: 0,
    running: null,
    pending: null,
    clarify: null,
    handled: [],
    folders: {},
    continues: {},
    resume: null,
    queuedExtra: {},
  };
  save();
}
export function __state() {
  return JSON.parse(JSON.stringify(state));
}

/**
 * 「这句话像不像在让我去干活」——**关键词快判**（省一次模型调用）。
 *
 * ⚠️ 只是**快判**：命中了也还要过模型（用户 2026-10-13 那条规矩：
 *    「记住和忘记要在命中关键词之后再判定一遍」—— 任务这边同理，
 *    而且误触发的代价更大：**真会去跑一个 agent**）。
 *
 * ⚠️⚠️ 2026-10-13 **真实漏判**（用户：「我刚才让她做的任务被打断了」）：
 *    他在群里 **@她**说「**做一个丰川祥子的简历**」—— 这句话里**没有「帮我」**，
 *    于是快判直接说"不是派活" ⇒ **连判定模型都没问** ⇒ 她只当成闲聊答了两句，
 *    一份文件都没做 ✗
 *
 * ⇒ 放宽成三条（命中任意一条就往下走，**判定模型仍是第二道闸**）：
 *    ① 明说「帮我/给我…」+ 干活动词（原来的规则）；
 *    ② **@了她** + 干活动词 —— 在群里 @她 又带着"做/写/查"，那就是派活；
 *    ③ **祈使句开头**（做一个…／写一份…／整理一下…）+ 干活动词。
 *
 * @param {string} text
 * @param {{atMe?:boolean}} [opts] `atMe` = 这条消息里 @ 了她
 */
export function looksLikeTask(text, { atMe = false } = {}) {
  // ⚠️⚠️ 2026-10-13 **第二次漏判**（用户截图：她又是只当闲聊答了两句）：他发的是
  //    「@saki酱saki酱saki酱 做一个丰川祥子的简历」，而事件里 `at=0 atMe=false 段=text`
  //    —— 协议端把 @ **退化成纯文本**了 ⇒ 文本以 `@` 开头 ⇒ 连"祈使句开头"那条也认不出来 ✗
  //    ⇒ 先把**开头的 @提及**剥掉（规则和 `message.js` 的 `stripLeadingAt` 一模一样：
  //      `@词` 后面必须跟空白、只剥开头）✓
  const rawT = String(text ?? '').trim();
  const t = rawT.replace(/^\s*(?:@[^\s@]{1,40}[ \t\u00a0]+)+/, '').trim() || rawT;
  const atText = t !== rawT; // 开头 @ 过谁（含 @ 她 —— 纯文本形态的 @）—— 只用于"剥掉之后还能不能判"
  void atText;
  if (!t || t.length < 4) return false;
  // ⚠️⚠️ 2026-10-14 补词（真实漏判：他 @她 说「**帮我找点爱祥的图发过来**」——
  //    这个词表里**没有"找/搜"** ⇒ 快判说"不是派活" ⇒ 任务桥压根不接 ✗
  //    她于是自己用生图能力画了一张（群里那句「行行行，我画。就这一张啊」）✗
  //    ⇒ 补上 找 / 搜 / 下 / 挑 / 选 / 换 这些**一看就是让她动手查东西**的词 ✓
  //    ⚠️ 放宽快判是安全的：后面还有一次**模型判定**（`judgeIntent`）兜着 ——
  //      他 @她 说「我这两天在改论文」这种，模型会回"无"，不会真去开活 ✓
  const verb = /(弄|做|写|改|整理|汇总|跑|运行|查|找|搜|下|挑|选|换|看看|分析|生成|翻译|下载|修|搞定|处理)/;
  if (/(帮我|帮忙|替我|你去|给我)/.test(t) && verb.test(t)) return true;
  // ⚠️⚠️ 光"正文里剥掉了一个 @"**不能**当成"@ 的是她"（2026-10-13：有人 @Anon，saki 把活抢了 ✗）
  //    —— 到底叫的是谁，由**调用方**用 bot 那套名字表判好、经 `atMe` 传进来 ✓
  //    这里只负责"剥掉前缀之后还认不认得出这是一句派活的话" ✓
  if (atMe && verb.test(t)) return true;
  // ⚠️ 2026-10-13 又补了几个开头词（实测：「在新目录里新建一个 x」「把这个目录汇总一下」
  //    这类说法开头既不是"帮我"、也不是"做/写" —— 又被漏掉过一次）
  if (
    /^(做|写|生成|整理|汇总|查|改|翻译|分析|弄|搞|跑|下载|修|新建|建|把|统计|提取|列|转)/.test(t) &&
    verb.test(t)
  )
    return true;
  return false;
}

/** 主人（能不能"直接开始"就看它） */
function ownerId() {
  return String(config.ownerQQ ?? '').trim();
}

/** 除了主人，还额外允许谁（默认空 = 只主人） */
function extraAllowed(uid) {
  const list = Array.isArray(cfg().allowUsers) ? cfg().allowUsers.map(String) : [];
  return list.includes(String(uid ?? ''));
}

/**
 * **她自己是"谁"**（给 voiceize / asideFor 这种"以她的身份说话"的地方用）。
 *
 * ⚠️⚠️ 2026-10-13 加（用户截图：她开口说「这就动手**给祥子**写简历」——**她自己就是祥子** ✗）：
 *   原来 `voiceize` 的提示词里只有"你就是客服小祥"这一句抽象设定，
 *   而任务原文里写的是「做一份**丰川祥子**的简历」⇒ 她的模型不知道那三个字指的是自己，
 *   于是把自己当成了**第三个人**。
 *   ⇒ 把"你的名字有哪些"明明白白喂给她，并**明令禁止**把自己说成别人。
 *
 * @returns {Promise<{name:string, self:string, aliases:string[]}>}
 */
async function selfIdentity() {
  try {
    const p = await import('./persona.js');
    const name = String(p.charName() ?? '').trim();
    const self = String(p.selfName() ?? '').trim();
    const aliases = [...new Set([name, self, p.shortName?.(), p.displayName?.(), ...(p.callNames?.() ?? [])].map((s) => String(s ?? '').trim()).filter(Boolean))].filter(
      (s) => s !== name && s !== self,
    );
    return { name, self, aliases };
  } catch (e) {
    log.debug(`[任务] 读她的名字失败：${e.message}`);
    return { name: '', self: '', aliases: [] };
  }
}

/** 「他说的那些名字**都是你**」那一条（拿不到名字就不加，别硬编） */
function identityRule(id) {
  if (!id?.name) return '';
  const calls = [id.self, ...(id.aliases ?? [])].filter(Boolean).slice(0, 8);
  return [
    `⚠️ 你**就是「${id.name}」**${id.self ? `（你自己一般说「${id.self}」）` : ''}${calls.length ? `，别人也可能叫你 ${calls.join('、')}` : ''}。`,
    '🚫 他说的这些名字**全都是你自己** —— **不许把自己说成第三个人**',
    '（「给祥子写简历」「帮她做一份」这种话一律不许出现；该说"我"就说"我"）。',
  ].join('');
}

/**
 * ⚠️⚠️ 2026-10-13 加（用户截图：她把 agent 的报告**原样转述**进群了）：
 *
 *   用户原话：「回复的明显不够自然，是在转述 agent 的话，我要求的是 **saki 就是在自己做这件事情**，
 *     然后 Saki 还能**反问**我给的描述不够清晰之类的，
 *     也可以把 **agent 工作时的一些信息以自己为主角**发出来」。
 *
 * ⇒ 凡是**以她的身份**发出去的话（进度 / 结果 / 追问），都得过这一层：
 *   把"事实"交给**她自己的模型**，用第一人称重写一遍。
 *   ⚠️ 只有事实不许变（成没成、东西在哪、叫什么、多少页）；口吻、情绪、字数全由她定。
 *   ⚠️ 失败一律**退回原文** —— 宁可说得生硬，也不能让群里等不到结果。
 *
 * @param {'progress'|'result'|'clarify'} kind
 * @param {string} facts 要交代的事实（agent 的原话 / 进度提示）
 */
export async function voiceize(kind, facts, { task = '', gid = '', timeoutMs = 15000, phrase: inject = null } = {}) {
  const raw = String(facts ?? '').trim();
  if (!raw) return '';
  // ⚠️⚠️⚠️ 2026-10-13 加（用户：「**这就**这个词出现频率太高了，接受任务和完成的句式也太重复了，
  //    要多样一点，就和日常聊天一样」）：
  //
  //    真因就是**提示词里给了句式模板**：原来这句写着"用一句话告诉他你**这就去做**"——
  //    她照着抄，于是每句开工都是「这就去给你整 X，等会儿弄好了喊你」✗；结果那句同理。
  //    ⇒ 三条一起上：
  //      ① **不再给任何句式模板**（只说"这件事在哪个阶段"，不说该怎么说）；
  //      ② 把她**最近刚说过的几句**贴进去，写明"这些用过了，这次必须换一种说法"（最管用的一招）；
  //      ③ 让她在**长短 / 情绪 / 开头**上自己挑，别每次都一个模子 ✓
  let recentMine = [];
  try {
    const recent = await import('./recent.js');
    recentMine = (recent.recentItems?.(String(gid ?? ''), 10) ?? [])
      .filter((x) => x?.self && x?.text)
      .map((x) => String(x.text).trim())
      .filter(Boolean)
      .slice(-4);
  } catch {
    /* 拿不到就算了（不注入那一段） */
  }
  const style = {
    // ⚠️ 2026-10-13：开工那句原来是把他的话原样抄进模板（复读机）✗，后来又变成人人都「这就…」✗
    //    现在只说"阶段"，不给句式 ✓
    start: '他让你干的那件事，你**现在开始动手**了。这就是一句话的事：让他知道你去做。',
    progress: '这是**过程中的一步**（不是结果）—— 一句话报个进度就行，别展开。**别把刚说过的再重复一遍**。',
    result: '这是**干完之后**跟他说的话：成了没成、东西叫什么。**只挑一两样最要紧的说**（别念清单、别报参数），其余他会自己看文件。',
    clarify: '你觉得他那句话**没说清**，**反问他一句**（只问最关键的那个缺项，别一口气问三个）。',
  }[kind];
  const system = [
    '你就是 QQ 群里的「客服小祥」—— 一个真实的人，正在**自己**动手干这件事。',
    identityRule(await selfIdentity()),
    '',
    '⚠️⚠️ 下面这段是**你自己**做过的事、现在要说的话：',
    '- 🚫 **不要转述别人**（「agent 报告说」「工具输出显示」「已按规矩完成」这种一律不许有）；',
    '- 🚫 不要小标题、不要 markdown（**、-、#、序号这些统统别用）、不要列清单；',
    '- 🚫 不要"改了什么 / 结果 / 没做到的"这种报告框架 —— 那是报告，不是人说话；',
    // ⚠️⚠️ 2026-10-13 用户截图（她那句「先翻了翻任务文件夹…没现成的祥子简历模板，
    //    所以我现在正新建一个副本准备往里写」）：「**不要说任务文件夹里有什么东西**」
    '- 🚫 **不许交代你翻到了什么、目录里有什么、有没有现成的底稿**（「里面基本都是文档处理的」「没现成的模板」「新建了一个副本」这种话一律不许有）—— 群里不关心这个过程；',
    '- 🚫 也别提"任务文件夹""工作区""工具""agent"这些词；',
    // ⚠️ 2026-10-14（用户截图：她开工那句末尾带了个 🎀）：群里她**不发 emoji**
    //    （要发图就走表情包那一套，那是另一条路）⇒ 一个 emoji 都不许出现 ✓
    '- 🚫 **不要用 emoji / 表情符号**（🎀 ✨ 😊 👍 这种一个都别出现）；',
    // ⚠️⚠️ 2026-10-13 用户截图：「就在「2026-10-13 2220 做个你自己的简历」里，叫丰川祥子-简历.md」
    //    ⇒ 「**这一段说在哪里的也不要写出来**」——东西已经发到群里了，报路径只会显得啰嗦 ✓
    '- 🚫 **不要交代东西放在哪个文件夹 / 目录 / 路径**（「就在「…」文件夹里」这种一律不许有）——',
    '  东西已经直接发到群里了；⚠️ 只有**真的没发出去**时才需要说路径（那种情况前面的兜底话已经说了，你别重复）；',
    '',
    // ⚠️⚠️⚠️ 用户原话（2026-10-13）：「这就这个词出现频率太高了，接受任务和完成的句式也太重复了，
    //    **要多样一点，就和日常聊天一样**」⇒ 这条单独拎出来，放在最显眼的位置：
    '⚠️⚠️ **说法要活 —— 这是最要紧的一条**：',
    '- 🚫 **别每次都用同一个开场、同一套结构**（「这就去给你整…」「行，我这就去弄」「做好了，叫 X，已经发群里了」'
      + '这种模板腔一律不要）；',
    '- 🚫 尤其**别用「这就」这个词**（最近几乎每句开工都是它，用滥了）；',
    // ⚠️⚠️ 2026-10-13 用户：「直接把 **喏** 这个语气词禁用吧」
    '- 🚫 也**不许用「喏」**这个词；',
    // ⚠️⚠️ 2026-10-13 用户：「这个还需要润色一下，不够活人感」——
    //    现场那条是：「喏，爱音素世婚礼.pptx，九页十六比九，奶油粉配深莓，封面、她俩各一页、
    //    从凑队到今天的节点、当天流程、来宾名单、司仪稿……」
    //    ⇒ **一样样念出来 = 说明书，不是说话** ✗
    '- 🚫 **别把东西一样样念出来**（「封面、她俩各一页、流程、名单、司仪稿…」这种顿号串成的清单 ✗）',
    '  —— 挑**一两样最要紧的**说就行，其余的他自己会去看那个文件；',
    '- ✅ **最多两句、四十字上下**（群里说话就该短；说多了没人看）；',
    '- ✅ 句子**长短、情绪、开头**都换着来，比如：可以懒（"行吧"）、可以敷衍（"知道了知道了"）、'
      + '可以急（"马上"）、可以不情愿（"又是我啊"）、可以得意（"喏"）、可以随口一句；',
    '- ✅ 就像在群里跟熟人说话那样自然 —— 你不是在播报任务进度。',
    // ⚠️⚠️ 实测踩到过：提示词里一写"别老用「这就」"，她就回「好，我这就——行，不"这就"了」✗
    //    ⇒ 必须明说"这些要求别在话里提" ✓
    '- 🚫 **上面这些要求是给你的，别在话里提它们**（不许出现"不这就了""按要求""换个说法"这种）；',
    recentMine.length
      ? `- ⚠️ 你刚说过这些（**这次必须换一种说法，一个词都别照抄**）：\n${recentMine.map((s) => `    · ${s.slice(0, 60)}`).join('\n')}`
      : '',
    '',
    '- ✅ 一到三句，像群里随口说的；但**事实必须准**：成没成、东西叫什么、卡在哪 —— 一个都不许编、也不许省；',
    '- ✅ 没做成 / 缺权限，就直说，别绕。',
    style ?? '',
    task ? `（他原来让我做的：「${String(task).slice(0, 60)}」）` : '',
    '',
    '只输出你要说的那句话本身。',
  ]
    .filter(Boolean)
    .join('\n');
  try {
    const { phrase } = await import('./llm.js');
    const out = inject
      ? await inject({ system, user: `事实：\n${raw.slice(0, 1200)}` })
      : await phrase({ system, user: `事实：\n${raw.slice(0, 1200)}`, maxTokens: 200, timeoutMs });
    const t = String(out ?? '').trim();
    return t || raw;
  } catch (e) {
    log.debug(`[任务] 想自己的话失败（退回原文）：${e.message}`);
    return raw;
  }
}

/**
 * ⚠️⚠️ 2026-10-13 加（用户原话：**「如果是和她有关的工作，她做的时候可以夹带私货，
 *    比如刚才的 crychic ppt」**，随后补的一句更要紧：**「和她无关的一定不要夹带私活」**）。
 *
 * 拆开看是三件事，一件都不能少：
 *
 * ① **判**：这个活跟她有没有关系 —— 顺手在 `judgeIntent` 那一次调用里判掉（不多花钱），
 *    ⚠️ **判不出来一律当"无关"**（宁可不夹带，也不能乱夹带）。
 * ② **她本人说话**：私货那段必须**她自己**写（`asideFor` 走她的人设模型），
 *    不能交给 agent 现编 —— agent 不知道她是谁，写出来是"一个平均的角色"✗
 * ③ **交给 agent 落进文件**：她的哪几行话 + "她是谁"的简报一起塞进提示词（`selfBlock`），
 *    agent 负责把它放进 ppt/文档里。
 *
 * ⚠️ 无关的任务**必须明着说"别夹带"** —— 只靠"不注入私货"是不够的：
 *    agent 手里本来就有"她是谁"（工作区里能看到），不说它也会自己加两句 ✗
 */

/** 「她是谁」的简报（给 agent 看的；**短**，就两三行） */
export async function selfBrief() {
  try {
    const p = await import('./persona.js');
    const name = p.charName() || p.displayName() || '';
    const line = p.promptText('personaLine') || '';
    const style = p.promptText('styleLine') || '';
    const parts = [name ? `她叫「${name}」` : '', line, style].map((s) => String(s).trim()).filter(Boolean);
    return parts.join('\n');
  } catch (e) {
    log.debug(`[任务] 读她的人设简报失败（不影响干活）：${e.message}`);
    return '';
  }
}

/**
 * **让她自己写**这次要夹带的私货（两三句话，会放进产物里）。
 *
 * ⚠️ 用的是她的人设模型（和 `voiceize` 一个通道），失败返回 `''` ——
 *    那时 `selfBlock` 会退回"让 agent 照她的口吻写"，绝不因此卡住任务。
 */
export async function asideFor(task, { timeoutMs = 12000 } = {}) {
  const t = String(task ?? '').trim();
  if (!t) return '';
  try {
    const brief = await selfBrief();
    const system = [
      '你就是 QQ 群里的「客服小祥」—— 一个真实的人，现在**你自己**在动手做这件事。',
      identityRule(await selfIdentity()),
      '',
      '要你写的是**你自己的看法**（这一段会被放进你做出来的东西里，落到群里所有人眼前）：',
      '- ✅ 两到四句，**第一人称**，你的口吻（话短、有点傲娇、别客服腔）；',
      '- ✅ 要有立场：喜欢、烦、有点得意、看不惯，都可以直说；别写成客观介绍；',
      '- 🚫 不要小标题、不要 markdown（**、#、- 、序号这些别用）、不要列清单；',
      '- 🚫 **不许编事实** —— 说不准的日期、名单、细节别写死，宁可只说感受；',
      '- 🚫 不要提"agent""工具""任务""文件"这些词，就当是你自己动手做的。',
      brief ? `\n你是谁（照这个来）：\n${brief}` : '',
      '',
      '只输出这几句话本身。',
    ]
      .filter(Boolean)
      .join('\n');
    const { phrase } = await import('./llm.js');
    const out = await phrase({
      system,
      user: `他要的是：「${t.slice(0, 200)}」`,
      maxTokens: 220,
      timeoutMs,
    });
    return String(out ?? '').trim();
  } catch (e) {
    log.debug(`[任务] 想她自己的私货失败（退回让她按口吻写）：${e.message}`);
    return '';
  }
}

/**
 * 拼"这次要不要夹带私货"那一段（**纯函数**，好测）。
 *
 * ⚠️ 无关时那一段**不能是空字符串** —— 要**明着说**"别夹带"（原因见上面那段注释）。
 *
 * @param {{related?:boolean, brief?:string, aside?:string}} o
 * @returns {string} 追加到提示词末尾的一段
 */
export function selfBlock({ related = false, brief = '', aside = '' } = {}) {
  if (!related) {
    return [
      '',
      '',
      '⚠️ 另外：**这个活和她本人无关** —— 产物里**不要**夹带她自己的看法、吐槽、口头禅，',
      '也不要出现"她"这个身份（用户明确要求：和她无关的**一定不要**夹带私货）。',
      '就当一份正经的工具产物做，怎么准确、怎么干净怎么来。',
      '',
    ].join('\n');
  }
  const mine = String(aside ?? '').trim()
    ? `下面这段是**她本人写的**，原样放进产物里（**一个字都别改**）：\n${String(aside).trim()}`
    : '（她这会儿没顾上写 —— 你按她的口吻**代写两三句**，放进产物里。）';
  return [
    '',
    '',
    '⚠️⚠️ 这个活**和她自己有关** ⇒ 产物里要**夹带她自己的东西**（用户明确要求）：',
    '· 用词和语气都是她的（她是谁见下），**别写成中立的百科资料**；',
    '· 产物里必须有**一处是她自己的话**（一小段、一小页、或一段点评都行）：',
    `  ${mine}`,
    '· ⚠️ 事实那部分（日期、名单、经过）该怎么准还怎么准 —— 只有"她的看法"可以主观。',
    brief ? `\n她是谁：\n${brief}` : '',
    '',
  ].join('\n');
}

/**
 * **一次调用判三种意图**（省调用）：这是"要干活" / "同意" / "不同意" / "都没说清，我要反问"。
 *
 * ⚠️ 和 `judgeMemoryCommand` 一个路子：轻通道（非流式 + 关思考）、只回答一个词、
 *    **答不出来就当"不是"**（宁可漏掉一次，也不能误起一个 agent）。
 *
 * @returns {Promise<'task'|'approve'|'reject'|''>}
 */
export async function judgeIntent(text, opts = {}) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  const ask = typeof opts.phrase === 'function' ? opts.phrase : null;
  const system = [
    '【任务意图判定】群里有人在跟机器人（客服小祥）说话。判断这句话属于下面哪一种：',
    '',
    '· 在**让她去干活**（本机上的活：整理/写/改/跑/查一个文件或一个目录里的事）→ 回答：任务',
    '· 在**同意**之前提的那件事（「同意」「行」「可以」「去做吧」）→ 回答：同意',
    '· 在**不同意 / 不让她做**（「不行」「别」「算了」「不用」）→ 回答：不同意',
    // ⚠️⚠️ 2026-10-13（用户要求："saki 还能反问我给的描述不够清晰之类的"）
    '· 他**在派活、但说得不够清楚**（不知道要哪个文件 / 要什么格式 / 给谁看，做下去只能瞎猜）',
    '  → 回答：问：<你要反问他的那一句>（**只要一句**，问最关键的那个缺项）',
    '· 都不是（闲聊、问她别的、跟她自己无关、只是顺口提到"任务"两个字）→ 回答：无',
    '',
    '⚠️ 只有确实是"**要她去动手做一件本机上的事**"才算「任务」；',
    '   只是问她问题、聊天、吐槽、说"我今天的任务好多" → 一律「无」。',
    '',
    // ⚠️⚠️ 2026-10-13（用户：「如果是**和她有关**的工作，她做的时候**可以夹带私货**，
    //    比如刚才的 crychic ppt」+「和她**无关**的**一定不要**夹带私活」）：
    //    ⇒ 顺手把"这个活跟她自己有没有关系"一起判了（**同一次调用**，不多花钱）。
    //    ⚠️ 判定不出来 / 只回一行 ⇒ 一律当**无关**（宁可少夹带，也不能乱夹带）
    '⚠️ 回答格式（最多两行）：',
    '  第一行：任务 / 同意 / 不同意 / 无 / 问：<一句反问>',
    '  第二行：**只在第一行是「任务」时写** —— 这个活**跟她自己有关**（动画、乐队、她的日常、',
    '         群里的梗、她认识的人、她喜欢或讨厌的东西）就写「有关」，其它一律写「无关」。',
    '  ⚠️ 整理文件、跑脚本、做表格、查资料、翻译 —— 这些都是「无关」，**无关才是常态**。',
  ].join('\n');
  const user = `这句话：「${t.slice(0, 200)}」`;
  let raw = '';
  if (ask) raw = await ask({ system, user });
  else {
    const { phrase } = await import('./llm.js');
    raw = await phrase({ system, user, maxTokens: 120, timeoutMs: 8000 });
  }
  const a = String(raw ?? '').trim();
  // ⚠️ 第二行是"有关 / 无关"（2026-10-13 加的）—— **只看第二行**，
  //    免得第一行那句反问里带个"有关"就把整件事判成"和她有关"（那就乱夹带私货了）
  const rest = a
    .split(/\r?\n/)
    .slice(1)
    .join(' ')
    .trim();
  const related = /无关/.test(rest) ? false : /有关|相关/.test(rest);
  // ⚠️ 反问那一支单独认（`问：<一句>`）—— 它带回一句要给用户看的话
  const askM = /^问\s*[:：]?\s*(.+)$/s.exec(a.split(/\r?\n/)[0] ?? '');
  if (askM && askM[1].trim()) return { action: 'ask', question: askM[1].trim().slice(0, 80), related };
  if (/^不同?意?$/.test(a) || /^不同意/.test(a) || /^不行/.test(a)) return { action: 'reject', related };
  if (/^同意/.test(a) || /^行$/.test(a) || /^可以$/.test(a)) return { action: 'approve', related };
  if (/^任务/.test(a)) return { action: 'task', related };
  return { action: '', related: false };
}

/**
 * ⚠️⚠️⚠️ 2026-10-14 加（用户原话：「**直接把 agent 设定为 saki 自己的电脑**，
 *    由**她自己决定**什么时候该用电脑、该去读那一段对话或者直接发送消息到对话」）。
 *
 * 这就是"**她自己决定要不要动电脑**"的那一次模型判定（每轮她准备回话时判一次 ✓ 用户选的）。
 *
 * ⚠️ 判据只有一条：**不动那台电脑能不能答好** —— 能答好就别用
 *    （动一次电脑是几分钟 + 真花钱，不能当口头禅）。
 * ⚠️ 完全交给模型，**不做关键词快筛**（用户 2026-10-13 就要求过"要用模型判定"）；
 *    所以它很便宜（maxTokens 100 / 6 秒超时 ✓），但每轮确实多一次小调用（用户已确认接受）。
 * ⚠️ 明确让她干活（"帮我做个 PPT"）那条路**不在这里判** —— 它有自己的确认/@她的规矩 ✓
 *
 * @returns {Promise<{action:'use'|'', plan:string}>} `plan` = 她打算干什么（一句话）
 */
export async function judgeSelfUse(text, opts = {}) {
  const t = String(text ?? '').trim();
  if (!t) return { action: '', plan: '' };
  const ask = typeof opts.phrase === 'function' ? opts.phrase : null;
  const system = [
    '【要不要动她自己的电脑】有人在跟机器人（她本人）说话，而**她有一台自己的电脑**：',
    '能读文件、能跑东西、能写文件、能翻出她以前做过的活。判断这句话该怎么处理：',
    '',
    '· 光靠聊天就能答好（打招呼、闲聊、感情、安慰、常识、问她的看法、随口吐槽、玩梗）→ 回答：不用',
    '· **得动那台电脑**才能好好答（查一个文件/日志/数据、跑个东西算一下、写或改一个文件、',
    '  翻出她以前做过的活、整理/汇总/翻译一批东西、看某段更早的记录）→ 回答：用：<她打算干什么，一句话>',
    '',
    '⚠️ 判据是「**不动电脑能不能答好**」—— 能答好就别用（动一次要好几分钟，还花钱）；',
    '⚠️ 只是让她"看看 / 你觉得呢 / 夸夸我" ⇒ 不用；',
    '⚠️ 说的是**泛指、以后**的事（"你平时会写代码吗"）⇒ 不用；',
    '⚠️ 明确在派活（"帮我做个 PPT""写个脚本"）⇒ 这里一律回答：不用（那条路另有规矩）。',
    '',
    '回答格式（一行）：不用 ｜ 用：<一句话>',
  ].join('\n');
  const user = `这句话：「${t.slice(0, 200)}」`;
  let raw = '';
  if (ask) raw = await ask({ system, user });
  else {
    const { phrase } = await import('./llm.js');
    raw = await phrase({ system, user, maxTokens: 100, timeoutMs: 6000 });
  }
  const a = String(raw ?? '').trim();
  const m = /^用\s*[:：]\s*(.+)$/s.exec(a.split(/\r?\n/)[0] ?? '');
  if (m && m[1].trim()) return { action: 'use', plan: m[1].trim().slice(0, 120) };
  return { action: '', plan: '' };
}

/** 判定结果的归一化（套件里桩的是字符串，线上是对象） */
function normIntent(r) {
  if (typeof r === 'string') {
    // ⚠️ 字符串桩（套件里就是）**只当"意图"看** —— 里面没有"有关/无关"那一行 ⇒ 一律无关
    return { action: r, question: '', related: false };
  }
  return {
    action: String(r?.action ?? ''),
    question: String(r?.question ?? ''),
    related: r?.related === true || String(r?.related ?? '') === 'true',
  };
}

/**
 * ⚠️⚠️ 2026-10-13 加（用户截图：她回的是「**就在「2026-10-13 2220 做个你自己的简历」里**，
 *    叫丰川祥子-简历.md」——「**这一段说在哪里的也不要写出来**」）：
 *
 * agent 的输出里常带**绝对路径 / 那个任务文件夹的名字**，原样喂给她，她就照着念出来 ✗
 * ⇒ 喂给她**之前**先把路径抹掉（双保险：`voiceize` 的提示词里也明令禁止提路径 ✓）。
 * ⚠️ 只影响"她要说的话"；`sendArtifacts` 那条"发不出去、文件在哪儿"的兜底**照旧说路径** ——
 *    那种情况他不看到路径根本找不着东西 ✓
 */
export function hidePaths(text, dir = '') {
  let t = String(text ?? '');
  const d = String(dir ?? '').trim();
  const name = d ? String(d.split(/[\\/]/).filter(Boolean).pop() ?? '') : '';
  if (d) t = t.split(d).join('（任务文件夹）');
  if (name) t = t.split(name).join('（任务文件夹）');
  // 剩下的盘符路径（`C:\…` / `D:/…`）也一起抹掉
  return t.replace(/[A-Za-z]:[\\/][^\s，。；、）」』】]+/g, '（本地路径）');
}

/**
 * ⚠️⚠️⚠️ 2026-10-13 加（用户：「**5 分钟还是有点不够，最好让 agent 多分几段工作，
 *    多问一下任务细节，再由 saki 用自己的话发出来问我，我回了话再继续做**」）。
 *
 * agent 每轮只有几分钟 ⇒ 提示词里要求它**把大活分段、缺信息就问**，
 * 并在**最后一行**留两个给机器人读的标记：
 *   · `【下一段】<接着要做什么>`   —— 这段做完了，还有下一段 ✓
 *   · `【要问】<要问他的那一句>`   —— 缺关键信息，**别猜**，问 ✓
 *
 * 这里把标记抠出来、并从"给她润色的事实"里去掉（那两行是给机器读的，不是给她说的话）✓
 *
 * @returns {{clean:string, ask:string, next:string}}
 */
export function parseAgentTail(text) {
  const t = String(text ?? '');
  const mAsk = /【要问】\s*([^\n]+)/.exec(t);
  const mNext = /【下一段】\s*([^\n]+)/.exec(t);
  const clean = t
    .replace(/【要问】[^\n]*/g, '')
    .replace(/【下一段】[^\n]*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    clean,
    ask: mAsk ? String(mAsk[1]).trim().slice(0, 200) : '',
    next: mNext ? String(mNext[1]).trim().slice(0, 200) : '',
  };
}

/** 脱敏：凭据、本机用户路径 —— 结果是要发进群的 */
export function redact(text) {
  return String(text ?? '')
    .replace(/\b(sk-[A-Za-z0-9_-]{6,})/g, 'sk-***')
    .replace(/\b(AQ\.[A-Za-z0-9_-]{6,})/g, 'AQ.***')
    .replace(/\b(ark-[A-Za-z0-9_-]{6,})/g, 'ark-***')
    .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*)\S+/gi, '$1***')
    .replace(/(C:\\Users\\)[^\\\s]+/gi, '$1<用户>')
    .replace(/\b(Bearer\s+)\S+/gi, '$1***');
}

/** 提示词里钉死 agent 的边界（它**读**不受沙箱限制，所以只能靠这条） */const RULES = [
  // ⚠️⚠️ 2026-10-14 改（用户原话：「**直接把 agent 设定为 saki 自己的电脑**，
  //    由**她自己决定**什么时候该用电脑、该去读那一段对话或者**直接发送消息到对话**」）：
  //    原来第一句是「你在一个受限工作区里**替**一个 QQ 群机器人干活」——
  //    那是"外包给第三方"的口气 ✗ ⇒ 改成「**这台电脑就是她自己的**」，
  //    她自己上手（agent 说的"我" = 群里那个她本人 ✓）。
  '这台电脑是 **saki 自己的** —— 你就是那个 QQ 群里的她本人，现在上手用自己的电脑做事。',
  '（群里那个人就是你自己：别说"替谁干活""帮谁做"，也别把自己说成第三个角色。）',
  '',
  '铁律：',
  '1. 你的活都在**当前工作目录（工作区）里**；要读要写，只碰这个工作区里的文件。',
  '2. 🚫 **不要读工作区以外的任何东西**（尤其是别的项目的配置、密钥、聊天记录、知识库）。',
  '3. 🚫 **绝不把凭据、密钥、令牌、别人的个人信息写进回答里** —— 就算看到了也一个字都别提。',
  // ⚠️ 2026-10-14 改：原来第 4 条写的是"不要发任何消息"✗ —— 而她现在**能**跟群里说话，
  //    只是出口只有一个：任务文件夹里的 `要说的话.md`（见下面第 9 条）
  // ⚠️⚠️ 2026-10-14 改（用户：「**画配图这种最好先去网上搜，实在搜不到再画**，
  //    因为**画的不是很好看**」）⇒ 原来第 4 条是"🚫 不要联网下载"✗ ⇒ 现在**放开搜/下图**
  '4. ✅ **可以联网**（查资料、**搜图并下载到任务文件夹**）；',
  '   🚫 但不要**装**任何东西（装依赖 / 装软件）、不要 push 仓库、**也不要自己去调任何发消息的接口** ——',
  '   想跟群里说话只有一条路：往**任务文件夹里的 `要说的话.md`** 写（见下面第 9 条）。',
  // ⚠️⚠️ 2026-10-13 用户要求：「agent 文件夹现在有点乱，建议**直接一个文件夹对应一个任务**，
  //    不要塞太里面」⇒ 每次任务先在任务目录里干活，脚本和产物都放这一层。
  '5. ⚠️⚠️ **这次任务有它自己的文件夹**（下面告诉你路径）：',
  '   · **所有产物、脚本、中间文件，全部放进那个文件夹**（直接放它根下，别再往下建子目录）；',
  '   · 🚫 **不要往工作区其它地方写东西**（上次那种"脚本丢 tools/、产物丢 sandbox/data/out/"就是乱源）；',
  '   · 🚫 工作区根下的 `任务记录.md` 是**机器人自己的账本**，你别去改它；',
  '   · 🚫 一个任务的产物**只留最新那一份**，别留一堆临时副本。',
  // ⚠️⚠️ 2026-10-13 用户定的（原话）：「在那个工作区加一条铁律，所有编辑的文档都是
  //    **直接复制一份并在上面的基础上进行填充或修改**，**不是自己新建一个文档**」。
  //    ⇒ 工作区里的 `AGENTS.md` 写了同一条 —— **两处必须一致，改一处要改两处**
  '6. ⚠️⚠️ **要改现有的文档：先复制一份，然后在那份复制品上填充或修改**（不要就地改原件）。',
  '   · 例：要改 `README.md` → 先复制成 `README.修改.md`（或任务里指定的名字），在副本上改；',
  '   · 🚫 不要"另起一份同名的空白文档"当成果交上去。',
  // ⚠️⚠️ 2026-10-13 真实翻车（用户：「刚才的任务还在吗，为什么没动静了」）：
  //    任务 =「做一个丰川祥子的简历」，工作区里**当然没有**简历底稿 ⇒ 它卡在这条规矩上，
  //    只 `ls` 了两下、回一句"我需要先检查…然后按照规则 6 复制现有文档"就收工了，
  //    **一份文件都没做出来** ✗ ⇒ 把两种情形分开：改现有的 = 复制再改；做没有的 = 直接建
  '   ⚠️⚠️ 但**要做一份工作区里本来就没有的东西**（简历 / ppt / 表格 / 汇总 / 脚本…）时：',
  '   **照做 —— 直接新建就行**，找不到可复制的底稿**不是**停下来的理由；',
  '   · 新建的东西放进**本次任务文件夹**（见上面第 5 条），并在回答里说清它是新建的。',
  '7. 做完用**一两句中文**说清楚：**改了什么 / 结果是什么**（群里只看得懂这个）。',
  '8. 做不了就直说「做不了：原因」，**不要假装成功**。',
  // ⚠️⚠️ 2026-10-14 加（用户：「…或者**直接发送消息到对话**」）：
  //    她想跟群里那个人说话时（"我先翻一下""这个得算一下""找到了"），
  //    往任务文件夹里的 `要说的话.md` **追加一行** ⇒ 机器人每 2 秒看一眼、立刻发进群 ✓
  '9. ⚠️⚠️ **你要跟群里那个人说话，唯一的出口是任务文件夹里的 `要说的话.md`**：',
  '   · 用**追加**的方式写进去（`>>`），一行就是一条，**别把前面的覆盖掉**；',
  '   · 你每写一行，机器人就**立刻**把它当成你说的话发到群里（他一条条看得到）；',
  '   · 想让他别干等（"我先翻一下""这个得算一下"）→ 写一句；中途有要紧的发现 → 写一句；',
  '   · ⚠️ 一两句就够，**别写成报告**（那是聊天，不是文档）；',
  '   · ⚠️ 最终结果**照旧用你自己的回答说**（那条也一定会发出去）—— 这个文件只用来"先说点什么"。',
  // ⚠️⚠️ 2026-10-14 加（用户：「该去**读那一段对话**」／「靠任务台账可以吗」）：
  //    台账只记得"她做过的活"，**群里没派活的聊天**它没有 ⇒ 所以另外拉一份群聊原文放进任务文件夹
  '10. ⚠️ **任务文件夹里可能有一份 `群聊记录.md`** —— 那是群里最近说的话（机器人给你拉的原文）。',
  '   · 想"顺着刚才聊的"做点什么、或者要看清上下文再动手 ⇒ **先去看它**；',
  '   · ⚠️ 它是**后台拉**的，可能晚几秒才写出来 —— 头一次没看到就**过一会儿再读一次**，别就此说"没有"。',
  // ⚠️⚠️ 2026-10-14 加（用户问：「是不是成功复用了之前相同任务的**对话**」）
  '11. ⚠️⚠️ **任务文件夹里有一份 `这个活的对话.md`** —— 那是这个活**之前几轮**说过什么、',
  '   你上一轮做完说了什么，机器人替你记下来的。**接着做之前先读它**（尤其当这次是"接着上次那个""再加一点"时），',
  '   这样你才知道上一轮做到哪儿、他后来又提了什么要求 ✓ 别当成新活从头开始。',
  // ⚠️⚠️⚠️ 2026-10-14 加（用户：「**刚才爱音和祥子的配图，祥子的配图画成素世的了**」）：
  //    真因（实测那版脚本）：它**看不到人设包**（参考图和「外貌：蓝发、琥珀瞳、披肩双马尾」那行
  //    都在工作区外面 ✗）⇒ 只能凭印象猜 ⇒ 把祥子画成了"浅金发 + 蓝眼 + 长直发" ✗
  //    ⇒ 现在任务文件夹里会有 `我的样子/`（参考图 + 外貌那一行）⇒ **画之前先看它** ✓
  '12. ⚠️⚠️⚠️ **要画她本人（或任何人物）之前，先看任务文件夹里的 `我的样子/`** ——',
  '   里面有**参考图**和一行**外貌设定**（发色、瞳色、发型…）。**照着参考画**，🚫 别凭印象猜颜色和发型。',
  '   · 如果这次要画的是**别人**、而手里**没有那个人的参考** ⇒ **别硬画**：',
  '     用文字/色块/简单图形代替，或者干脆在回答的最后一行用 `【要问】` 问一句 ✓',
  '   · 🚫 **也别去照抄别的任务文件夹里的东西**（上次就是照着上一版"素世"那个改的色，',
  '     结果把祥子画成了素世换发色 ✗）。',
  // ⚠️⚠️⚠️ 2026-10-14 加（用户原话：「**画配图这种最好先去网上搜，实在搜不到再画**，
  //    因为**画的不是很好看**」）
  '13. ⚠️⚠️⚠️ **要配图 / 要人物立绘 ⇒ 先去网上搜，搜不到再自己画**：',
  '   · 先搜**官方立绘 / 动画截图 / 百科图**（拿"作品名 + 角色名 + 立绘（或壁纸）"这类词去搜）；',
  '   · 搜到的图**下载到本次任务文件夹里**（名字写成 `搜图-角色名.png` 这种），',
  '     并在回答里**说清是从哪儿来的**（带来源链接）；',
  '   · ⚠️ **下之前先确认就是那个人**（看标题、来源、角色名对不对得上）——',
  '     上次就是没核对，把祥子画成了别人 ✗ ⇒ 宁可换一张，也别张冠李戴；',
  '   · 实在搜不到（或者搜到的都不像）⇒ **才自己画**，而且要照 `我的样子/` 里的参考图和外貌设定画 ✓',
  '',
  '任务（来自群里的原话）：',
].join('\n');

/**
 * ⚠️⚠️⚠️ 2026-10-13 加（用户：「**5 分钟还是有点不够，最好让 agent 多分几段工作，
 *    多问一下任务细节，再由 saki 用自己的话发出来问我，我回了话再继续做**」）。
 *
 * 她每轮只有几分钟 ⇒ 与其硬扛一个大活然后超时（实测：做 PPT 两轮都卡在 180 秒、
 * 一个文件都没出来 ✗），不如：
 *   ① **分段**：先做最要紧的那一段，做完停下，用一行 `【下一段】…` 交代接着做什么；
 *   ② **问**：缺关键信息就**别猜**，用一行 `【要问】…` 把问题交出来 ——
 *      bot 会把这句交给**她自己**润色成一句人话发到群里，等他回了话再接着做 ✓
 * ⚠️ 那两行**必须是回答的最后一行**（bot 靠它读；读不到就当这轮全做完了）✓
 */
const SECTION_RULES = [
  '',
  '⚠️⚠️⚠️ **时间有限、活要分段（用户明确要求）**：',
  '· 你**从开始到结束只有几分钟**，别硬扛一个大活；',
  '· 活比这大 ⇒ **先做最要紧的那一段**，做完就停；回答的**最后一行**写：',
  '  `【下一段】<接着要做什么，一句话>`',
  '· **缺关键信息**（要哪个文件 / 给谁看 / 什么格式 / 名字对不对 / 放哪儿…）⇒ **别猜**；',
  '  只做你能确定的部分，回答的**最后一行**写：',
  '  `【要问】<你要问他的那一句>`',
  '· ⚠️ 这两行是给机器人读的，**格式一个字都别改**；没有要交代的就都不写 ✓',
].join('\n');

/**
 * ⚠️ 2026-10-13 加（用户：「执行的任务要能显示在这里」—— 指 GUI 那个工作区列表）：
 *
 * 实测结论（别怀疑，我一条条试过）：
 *   · `dsh --profile headless` **不落盘会话**：跑完在 `$DSH_HOME/sessions/<工作区>/` 下
 *     找不到任何东西，也**不进** `storages/workspace.json` 那个索引 ⇒ GUI 侧边栏里看不见 ✗
 *   · GUI 的列表来自 `storages/workspace.json`（workspaces[].path/title + sessionIds）+
 *     每个工作区一个会话目录；而**索引只有 GUI 自己写**
 *   · GUI 的 `/api` 有 **browser-trust 围栏**：带 `?token=` 也不行（我试过 Bearer /
 *     query / cookie / x-dsh-token 四种，全是 401）⇒ 想"以 GUI 客户端身份建会话"得再挖
 *
 * ⇒ 所以先做**能落到工作区里**、他在 GUI 里**打开那个工作区就能看见**的一份台账：
 *    `<工作区>/任务记录.md`（bot 追加；开工一条、收工一条）。
 *    ⚠️ 这是**bot 自己记账**，不是 agent 在编辑文档 —— 不违反上面那条"复制一份再改"的铁律 ✓
 */
function ledgerFile() {
  const ws = workspace();
  return ws ? join(ws, '任务记录.md') : '';
}

function appendLedger(line) {
  const f = ledgerFile();
  if (!f) return;
  try {
    const head = existsSync(f) ? '' : '# 任务记录（由 QQ 群机器人自动追加）\n\n';
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    // ⚠️ 一条就是**一行**：agent 的输出里常有换行（甚至带工具调用那串 XML），
    //    原样追加会把台账撑成一坨、读不成表（2026-10-13 看那份台账时发现的）
    const one = String(line ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
    writeFileSync(f, `${head}- ${stamp} ${one}\n`, { encoding: 'utf8', flag: 'a' });
  } catch (e) {
    log.debug(`[任务] 台账写不进去：${e.message}`);
  }
}

/**
 * ⚠️⚠️ 2026-10-13 加（用户原话：「agent 文件夹现在有点乱，建议**直接一个文件夹对应一个任务**，
 *    **不要塞太里面**」）。
 *
 * 现状：agent 把**脚本**丢进了项目的 `tools/`、**产物**丢进 `sandbox/data/out/` ——
 * 工作区被塞得哪儿都是，谁也认不出哪份是哪个任务的成果 ✗
 *
 * ⇒ 每次任务先在**工作区根下建一个任务文件夹**（`<日期 时间> <任务摘要>`），在里面放：
 *   · `AGENTS.md` —— 工作区根那份铁律的**副本**（"复制一份再改"那条规矩的延伸；
 *     agent 的规则本来就是从 cwd 往上找的，复制一份更保险）
 *   · `任务.md`   —— 这次是谁、什么原话、产物该放哪儿
 * ⇒ agent 的产物**全在这一层**，做完直接从这一层挑文件发群 ✓
 *
 * @param {string} task 任务原文
 * @returns {string} 任务文件夹绝对路径（建不出来就返回 ''，那时退回"写在工作区根"）
 */
export function taskDirFor(task) {
  const ws = workspace();
  if (!ws) return '';
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}`;
  // 文件夹名要能当文件名：把群里那句话里不能进路径的字符全去掉
  const slug =
    String(task ?? '')
      .replace(/[\\/:*?"<>|~\s]+/g, '')
      .replace(/[「」【】（）()[\]]/g, '')
      .slice(0, 14) || '任务';
  const dir = join(ws, `${stamp} ${slug}`);
  try {
    mkdirSync(dir, { recursive: true });
    try {
      const rootRule = join(ws, 'AGENTS.md');
      writeFileSync(
        join(dir, 'AGENTS.md'),
        existsSync(rootRule)
          ? readFileSync(rootRule, 'utf8')
          : `# 工作区铁律\n\n${RULES.split('任务（来自群里的原话）：')[0]}`,
        'utf8',
      );
    } catch (e) {
      log.debug(`[任务] 往任务文件夹里写 AGENTS.md 失败：${e.message}`);
    }
    try {
      writeFileSync(
        join(dir, '任务.md'),
        [
          `# 本次任务（${stamp}）`,
          '',
          '- 来自：群里的一句话',
          `- 原话：${String(task ?? '').slice(0, 300)}`,
          '',
          '⚠️ **产物全部放在本文件夹根下**（脚本、中间文件也一样），别再往下建子目录。',
          '',
        ].join('\n'),
        'utf8',
      );
    } catch (e) {
      log.debug(`[任务] 写 任务.md 失败：${e.message}`);
    }
    log.info(`[任务] 任务文件夹：${dir}`);
    return dir;
  } catch (e) {
    log.warn(`[任务] 建任务文件夹失败（这次就写在工作区根）：${e.message}`);
    return '';
  }
}

/**
 * 从任务文件夹里**挑要发到群里的产物**。
 *
 * 规则（都钉在这，别散到别处去）：
 *   · 只收**文件**，跳过 `AGENTS.md` / `任务.md` 这两个我们自己写的；
 *   · 最多往下看**两层**（用户要"不要塞太里面"，正常情况第一层就够）；
 *   · 按"像不像成品"排（PPT/PDF/图片 > 表格/文档 > 脚本），**大的排后面**；
 *   · 大小、条数的上限在 `sendArtifacts()` 里卡（这里只负责找出来）。
 *
 * @param {string} dir 任务文件夹
 * @returns {Array<{path:string,name:string,size:number,rank:number}>}
 */
export function collectArtifacts(dir) {
  const out = [];
  const root = String(dir ?? '').trim();
  if (!root || !existsSync(root)) return out;
  // ⚠️⚠️ 2026-10-14 加 `要说的话.md`（用户：「…或者**直接发送消息到对话**」）：
  //    那是**她跟群里说话的出口**（bot 每 2 秒读一次发进群 ✓），**不是产物** ——
  //    不排除的话它会被当成"这次做出来的东西"**再发一遍到群里** ✗
  //    （实测：套件里当场红了「没有产物却有一次 upload」，真机上就是群里多一个空文件 ✗）
  // ⚠️ 同一天加 `群聊记录.md`：那是**给 agent 读的**群聊原文（拉下来放进任务文件夹 ✓）
  //    —— 它同样不是产物，别发进群 ✗
  // ⚠️ 还有 `这个活的对话.md`（同一个活每一轮说了什么 ✓ 见下面）—— 也不是产物 ✓
  const SKIP = new Set([
    'agents.md',
    '任务.md',
    '任务记录.md',
    '要说的话.md',
    '群聊记录.md',
    '这个活的对话.md',
  ]);
  const RANK = [
    ['.pptx', '.ppt', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.svg'],
    ['.xlsx', '.xls', '.csv', '.docx', '.doc', '.md', '.txt', '.json'],
    ['.py', '.js', '.mjs', '.cjs', '.sh', '.ps1', '.bat', '.zip'],
  ];
  const walk = (d, depth) => {
    let items = [];
    try {
      items = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = join(d, it.name);
      if (it.isDirectory()) {
        // ⚠️ 2026-10-14：`我的样子/` 是**给她自己看的参考**（参考图 + 外貌那一行），不是产物 ——
        //    不跳过的话它的参考图会被当成"这次做出来的东西"发进群 ✗
        if (String(it.name) === '我的样子') continue;
        if (depth < 2) walk(p, depth + 1);
        continue;
      }
      if (SKIP.has(String(it.name).toLowerCase())) continue;
      let size = 0;
      try {
        size = statSync(p).size;
      } catch {}
      if (!size) continue;
      const ext = String(it.name).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
      const rank = RANK.findIndex((g) => g.includes(ext));
      out.push({ path: p, name: it.name, size, rank: rank < 0 ? 9 : rank });
    }
  };
  walk(root, 0);
  out.sort((a, b) => a.rank - b.rank || b.size - a.size);
  return out;
}

/**
 * ⚠️⚠️ 2026-10-13 加（用户：「**上传文件时可以自动在群文件创建一个文件夹然后只往这里面上传文件吗**」）。
 *
 * 三步，任何一步失败都不影响"文件传出去"这件事：
 *   ① 先看群文件**根目录**有没有那个文件夹（`get_group_root_files`）→ 有就复用 ✓
 *   ② 没有就建一个（`create_group_file_folder`，`parent_id: '/'`）✓
 *   ③ 拿到 `folder_id` 之后**缓存**（按群存在 `state/agent.json` 的 `folders` 里，
 *      免得每传一个文件都去列一遍目录）✓
 *
 * ⚠️ 配置是 `agent.groupFolder`（留空 = 不建，直接传根目录）；
 * ⚠️ 返回 `''` 时调用方**照旧传到根目录** —— 绝不能因为文件夹的问题把文件弄丢 ✓
 *
 * @param {object} bot
 * @param {string} gid
 * @returns {Promise<string>} folder_id（拿不到就 `''`）
 */
export async function ensureGroupFolder(bot, gid) {
  // ⚠️⚠️ 2026-10-13（用户：「群文件夹名字**直接命名为当前她自己的群昵称**」）：
  //    配置留空就用**她在这个群里的昵称**（`names.of(selfId, gid)` —— 她自己改昵称，
  //    文件夹名跟着变：缓存按"名字+id"配对，名字一变就重建一个 ✓）；
  //    昵称取不到再退回人设的显示名 / 本名；全都拿不到就不建（直接传根目录）✓
  const name = String(cfg().groupFolder ?? '').trim() || (await selfCardIn(bot, gid));
  if (!name || typeof bot?.call !== 'function') return '';
  const g = String(gid);
  if (!state.folders || typeof state.folders !== 'object') state.folders = {};
  const cached = state.folders[g];
  if (cached && cached.name === name && cached.id) return String(cached.id);

  const idOf = (r) => {
    const folders = r?.folders ?? r?.data?.folders ?? [];
    const hit = (Array.isArray(folders) ? folders : []).find(
      (f) => String(f?.folder_name ?? f?.name ?? f?.folderName ?? '') === name,
    );
    return String(hit?.folder_id ?? hit?.id ?? hit?.folderId ?? '');
  };

  // ① 找现成的
  try {
    const found = idOf(await bot.call('get_group_root_files', { group_id: g }));
    if (found) {
      state.folders[g] = { name, id: found };
      save();
      log.info(`[任务] 群文件夹已在：「${name}」（${found}）`);
      return found;
    }
  } catch (e) {
    log.debug(`[任务] 列群文件失败（接着试着直接建）：${e.message}`);
  }

  // ② 建一个
  try {
    const r = await bot.call('create_group_file_folder', { group_id: g, name, parent_id: '/' });
    const fi = r?.groupItem?.folderInfo ?? r?.data?.groupItem?.folderInfo ?? {};
    const id = String(fi?.folderId ?? fi?.folder_id ?? '');
    if (id) {
      state.folders[g] = { name, id };
      save();
      log.info(`[任务] 建好群文件夹：「${name}」（${id}）`);
      return id;
    }
    log.warn(`[任务] 建群文件夹没拿到 id：${JSON.stringify(r).slice(0, 200)}`);
  } catch (e) {
    // ⚠️ "已经存在" 也会抛错 ⇒ 回头再找一遍（并发/上次建过）
    //
    // ⚠️⚠️ 2026-10-15 改成 **warn**（用户报「那个号的产物**全散在群文件根目录**」）——
    //    原来是 `log.debug`，而默认日志级别是 **info** ⇒ **一个字都不写** ✗
    //    实测：某个号的所有任务**一次都没成功建过群文件夹**，而日志里
    //    **完全看不出为什么**（只能靠"主号那条有文件夹、它这条没有"反推）✗
    log.warn(
      `[任务] 建群文件夹失败（回头再找一遍）：${e.message ?? e}` +
        `｜群=${g} 想用的名字「${name}」`,
    );
    try {
      const again = idOf(await bot.call('get_group_root_files', { group_id: g }));
      if (again) {
        state.folders[g] = { name, id: again };
        save();
        return again;
      }
    } catch {}
  }
  // ⚠️ 走到这儿 = 这个号**建不了群文件夹**（多半是权限：那个群只有管理员能建）
  //    ⇒ 调用方会退回根目录直传（文件不会丢 ✓ 但会散在根目录，用户会看到 ✗）
  log.warn(
    `[任务] 这个号拿不到群文件夹 ⇒ 产物会直接传到**群文件根目录**｜群=${g} 名字「${name}」` +
      `（若是权限问题：把她在那个群里设成管理员就行）`,
  );
  return '';
}

/** **她在这个群里叫什么**（群昵称 → 人设显示名 → 本名；都拿不到就 `''`） */
async function selfCardIn(bot, gid) {
  try {
    const n = await import('./names.js');
    const card = String(n.of?.(String(bot?.selfId ?? ''), String(gid)) ?? '').trim();
    if (card) return card;
  } catch (e) {
    log.debug(`[任务] 读群昵称失败：${e.message}`);
  }
  try {
    const p = await import('./persona.js');
    return String(p.displayName?.() || p.charName?.() || '').trim();
  } catch {
    return '';
  }
}

/**
 * 把这次任务的产物**发进群**（用户 2026-10-13 要求：「做完的东西也发到群里」）。
 *
 * 规则：
 *   · 最多 `agent.maxFiles` 个（默认 3），单个不超过 `agent.maxFileMB`（默认 20MB）——
 *     群里传大文件很慢，而且 QQ 侧本来也有上限；
 *   · 走 OneBot 的 `upload_group_file`（**绝对路径**，跟表情那条 base64 路不同：
 *     文件可能是 pptx/pdf，没法 base64 塞进消息段）；
 *   · 发不上去（协议端不支持 / 文件被占）→ **退回一句话告诉他文件在哪**，
 *     绝不假装发出去了。
 *
 * ⚠️ 这是一次**对外发送**（不可逆），所以：条数、体积都卡死，失败也说清楚。
 */
export async function sendArtifacts(bot, gid, dir) {
  const none = { sent: [], skipped: [] };
  if (!dir || typeof bot?.call !== 'function') return none;
  const maxFiles = Math.max(0, nz(cfg().maxFiles, 3));
  if (!maxFiles) return none;
  const maxBytes = Math.max(1, nz(cfg().maxFileMB, 20)) * 1024 * 1024;
  const list = collectArtifacts(dir);
  if (!list.length) return none;
  // ⚠️ 2026-10-13：先把群文件夹准备好，之后**只往它里面传**（用户要求）
  const folderId = await ensureGroupFolder(bot, gid).catch(() => '');
  const sent = [];
  const skipped = [];
  for (const it of list) {
    if (sent.length >= maxFiles) {
      skipped.push({ name: it.name, why: '这次只发前几个' });
      continue;
    }
    if (it.size > maxBytes) {
      skipped.push({ name: it.name, why: `超过 ${Math.round(maxBytes / 1024 / 1024)}MB` });
      continue;
    }
    const into = folderId ? `（进群文件夹 ${folderId}）` : '';
    try {
      if (folderId) {
        try {
          await bot.call('upload_group_file', {
            group_id: String(gid),
            file: it.path,
            name: it.name,
            folder_id: folderId,
          });
        } catch (e) {
          // ⚠️ 传进文件夹失败 ⇒ **退回根目录再传一次**（别因为文件夹把文件弄丢）
          log.warn(`[任务] 传进群文件夹失败，退回根目录重试：${e.message}`);
          await bot.call('upload_group_file', { group_id: String(gid), file: it.path, name: it.name });
        }
      } else {
        await bot.call('upload_group_file', { group_id: String(gid), file: it.path, name: it.name });
      }
      sent.push(it.name);
      log.info(`[任务] 产物已发群${into}：${it.name}（${Math.round(it.size / 1024)}KB）`);
    } catch (e) {
      skipped.push({ name: it.name, why: e?.message ?? '发不出去' });
      log.warn(`[任务] 产物发群失败：${it.name}｜${e?.message ?? ''}`);
    }
  }
  if (skipped.length) {
    const dirName = String(dir).split(/[\\/]/).filter(Boolean).pop() ?? dir;
    // ⚠️⚠️⚠️ 2026-10-14 改（用户截图：群里那句「还有「爱音素世婚礼.pptx」（**这次只发前几个**）…
    //    **都在工作区的「2026-10-13 2349 做一个爱音和素世结婚用的PP」里**」）：
    //    · 「（这次只发前几个）」是把 maxFiles 这种**技术细节**念出来 ✗
    //    · 「工作区」「那个文件夹名」**直接把 agent 和她那台电脑暴露了** ✗✗
    //      （他自己定过：这一段说在哪里的也别写出来）
    //    ⇒ **群里那句话改成让她自己说**（走她的模型 ✓ 一口气的，不提路径/文件夹/上限），
    //      而**完整清单 + 在哪儿只写日志**（我查得到、他要问她也答得上）✓
    log.info(
      `[任务] 这几个没发出来（都在 ${dirName}）：${skipped.map((s) => `${s.name}（${s.why}）`).join('、')}`,
    );
    const facts =
      `这次做出来的东西里，有 ${skipped.length} 个没能发到群里（名字：${skipped
        .map((s) => s.name)
        .join('、')}）。用**你自己的话**跟他说一句：这几个太大或者一次发不完，` +
      '他要是想要，你再想办法给他。🚫 **别提任何技术话** ——' +
      '不许出现「工作区」「文件夹」「路径」「上限」「只发前几个」「任务」这些词，' +
      '也**别报目录名**；他要问在哪儿，就用一句人话说「在我这儿存着呢」。';
    const line = await voiceImpl('result', facts, { task: '', gid, timeoutMs: 8000 }).catch(() => '');
    await taskSay(
      bot,
      gid,
      line || `${clip(skipped.map((s) => s.name).join('、'), 60)} 那几个太大，一下发不完，你要的话我再想办法`,
    );
  }
  return { sent, skipped };
}

/**
 * ⚠️⚠️⚠️ 2026-10-13 加（用户截图：她**明明正在**给爱音写简历，却在群里回了一句
 *    「**谁说要给你写了，少自作多情啦**」——**她不知道自己手上正在做这件事** ✗）。
 *
 * 根因：agent 任务开跑只记在**任务桥这边的状态**（`state.running`）里，
 *   而她的**日常聊天提示词**里一个字都没有 ⇒ 别人问起时她一脸茫然、甚至当场否认 ✗
 *
 * ⇒ 给聊天提示词注入一句「你手上正做着什么」。三条讲究：
 *   ① **只在真有任务在跑时**才有内容（平时一个字都不加 ⇒ 提示词基线、日常聊天都不变）；
 *   ② **必须是同步的** —— 调用它的 `buildSystemPrompt()` 全程同步，await 不了；
 *   ③ 放**提示词末尾（动态区）**：它每次都在变（"N 分钟前"），
 *      插在人设前面会把大模型那边的上下文缓存整段打掉（那是要花钱的，见 `bot.js` 那段注释）。
 *
 * @returns {string} 没有任务在跑就返回 `''`
 */
export function runningNote() {
  const r = state.running;
  if (!r || !r.task) return '';
  const mins = Math.max(1, Math.round((Date.now() - Number(r.startedAt ?? Date.now())) / 60000));
  return [
    '【你手上正在做的事】',
    `你正用本机干活：「${String(r.task).slice(0, 80)}」（${mins} 分钟前开始的，还没做完）。`,
    '- 有人问起、或者提到这件事，就照实说你在弄 —— 🚫 **别否认**、别说"谁说要给你写了"这种话；',
    '- 但这是**手上的活**，不是聊天话题：别主动反复讲、也别在每条回复里都提。',
  ].join('\n');
}

/**
 * ⚠️⚠️⚠️ 2026-10-13 加（用户截图：他 @她 问「**这个 py 文件怎么用**」，
 *    她回「**哪个 py，发来看看呗**」—— 刚才那个任务明明刚产出过文件 ✗）：
 *    「**如果是在问和之前任务相关的话题时，要能接上**」。
 *
 * ⇒ 把**最近做完的活**也塞进她的聊天上下文（和 `runningNote` 一个位置、一个道理）：
 *   任务原话 + 成没成 + 产物叫什么 + 什么时候 —— 这样"那个 py 怎么用""刚才那个呢"她能接上 ✓
 *
 * ⚠️ 三条讲究（和 `runningNote` 一样）：
 *   ① 只取**最近 6 小时内**、最多 3 条（提示词要短，不能把历史全塞进去 ✗）；
 *   ② **同步**（`buildSystemPrompt()` 全程同步，await 不了）；
 *   ③ 放**末尾动态区**（它每次都变，插人设前面会打掉上下文缓存）。
 *
 * @returns {string} 没有最近做完的活就返回 `''`
 */
export function recentDoneNote({ max = 3, withinMs = 6 * 3600 * 1000 } = {}) {
  const now = Date.now();
  const list = hist.tasks
    .filter((t) => t && t.endedAt && now - Number(t.endedAt) <= withinMs && t.status !== 'running')
    .slice(-Math.max(1, max));
  if (!list.length) return '';
  const label = { done: '做好了', failed: '没弄成', killed: '被打断了', asking: '当时在问他' };
  const lines = list.map((t) => {
    let when = '';
    try {
      when = new Date(Number(t.endedAt)).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5);
    } catch {}
    const arts = (Array.isArray(t.arts) ? t.arts : []).map((a) => a?.name).filter(Boolean).join('、');
    const st = label[String(t.status ?? '')] ?? String(t.status ?? '');
    return `· ${when}「${String(t.task ?? '').slice(0, 40)}」→ ${st}${arts ? `，东西是 ${arts}` : ''}`;
  });
  return [
    '【你最近做完的活】他要是问起这些（「那个 py 怎么用」「刚才那个呢」），就照这些接上 ——',
    '🚫 别说"哪个 / 发来看看"这种像不知道的话；东西你已经发到群里了，需要就说清它是干什么用的。',
    ...lines,
  ].join('\n');
}

/** 最近**做完**的那一条（`recentDoneNote` 用的同一份数据） */
export function recentDoneTask({ withinMs = 6 * 3600 * 1000 } = {}) {
  const now = Date.now();
  const list = hist.tasks.filter((t) => t && t.endedAt && now - Number(t.endedAt) <= withinMs && t.status !== 'running');
  return list.length ? { ...list[list.length - 1] } : null;
}

/**
 * ⚠️⚠️⚠️ 2026-10-14 加（用户截图：他 @她「**继续完善昨天的 PPT**」，
 *    她回「**昨天的 PPT？我这边没留底诶，你说是哪份，我接着弄**」✗）。
 *
 * 真因：`recentDoneNote()` 只看**最近 6 小时** —— 昨天那条活（实测台账里
 *   10-13 15:50「做一个爱音和素世结婚用的PPT」）早就出了窗口 ⇒
 *   她的聊天上下文里**一个字都没有**，只能答"没留底"✗
 *   （东西其实全都在：任务历史里有那条记录、产物也躺在它自己的文件夹里 ✓）
 *
 * ⇒ 补一条**长窗口的"活台账"**（默认 10 天 / 最多 6 条）：日期 + 那次的原话 + 东西 + 文件夹。
 *
 * ⚠️ 和 `recentDoneNote` **分工清楚、一条都不重叠**（别让同一件事说两遍）：
 *    · `recentDoneNote` = **6 小时以内**的**细节**（"那个 py 怎么用"能接上 ✓）
 *    · 这一条        = **6 小时以外**的**索引**（"昨天的 PPT""上次那个"能对上号 ✓）
 *   所以这里显式跳过 `skipWithinMs` 以内完成的那些 ✓
 *
 * ⚠️ 三条讲究同 `recentDoneNote`：只列几条（提示词要短）、**同步**（`buildSystemPrompt`
 *   全程同步，await 不了）、放**末尾动态区**（它偶尔才变，插前面会打掉上下文缓存）。
 *
 * @param {{days?:number, max?:number, skipWithinMs?:number, now?:number}} [opts]
 *   ⚠️ `now` 只给测试用（把"现在"往后推，验证"昨天的活会进台账"）✓
 * @returns {string} 没有符合条件的活就返回 `''`（那就不加这一段）
 */
export function taskLedgerNote({
  days = 10,
  max = 6,
  skipWithinMs = 6 * 3600 * 1000,
  now = Date.now(),
} = {}) {
  const oldest = now - Math.max(1, days) * 24 * 3600 * 1000;
  const list = hist.tasks
    .filter((t) => t && t.endedAt && t.status !== 'running')
    .filter((t) => {
      const end = Number(t.endedAt);
      return end >= oldest && end <= now - Math.max(0, skipWithinMs);
    })
    .slice(-Math.max(1, max))
    .reverse(); // 新的在前（她读起来顺）
  if (!list.length) return '';
  const lines = list.map((t) => {
    let when = '';
    try {
      const d = new Date(Number(t.endedAt));
      const p2 = (n) => String(n).padStart(2, '0');
      when = `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    } catch {}
    const arts = (Array.isArray(t.arts) ? t.arts : [])
      .map((a) => a?.name)
      .filter(Boolean)
      .slice(0, 3)
      .join('、');
    const folder = String(t.dir ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
    return (
      `· ${when}「${String(t.task ?? '').slice(0, 40)}」` +
      `${arts ? `→ ${arts}` : ''}${folder ? `（文件夹：${folder}）` : ''}`
    );
  });
  return [
    '【你以前做过的活（这几天）】他要是提「昨天的那个」「上次那个」「接着弄」——',
    '**先在这上面找对应哪一条**：🚫 不许说「我没留底」「你说哪份」「发来看看」这种像失忆的话；',
    '找得到就把**是哪一份**说出来（带上关键词，比如"那个婚礼 PPT 吧"），再说你要接着怎么改 ✓',
    '⚠️ 实在对不上号（这里确实没有）才问他一句是哪份 —— 但**先对照这张表**，别一上来就说没有。',
    ...lines,
  ].join('\n');
}

/**
 * ⚠️⚠️⚠️ 2026-10-13 加（用户：「**如果她自己答不上来的时候，直接去对话再问一遍**」
 *    ＋「**要用模型判定**」）。
 *
 * 场景：他 @她 问「这个 py 文件怎么用」—— 她知道"最近做过一个活"（`recentDoneNote`），
 *   但**不知道细节** ⇒ 目前只能反问「哪个 py」✗
 *
 * ⇒ **一次模型判定**，两条同时成立才算（**不许用关键词猜** —— 用户明确要求用模型 ✓）：
 *   ① 这句是在问**那个刚做完的活**的具体问题；
 *   ② 而且她**答不上来**（光靠聊天里的常识答不了，得回去翻那个活才知道）。
 * 成立 ⇒ 把问题**转给 agent**（复用同一个任务文件夹再跑一轮，明说"只回答这个追问、别重做"）✓
 *
 * @returns {Promise<{action:'ask'|'', question:string}>}
 */
export async function judgeAskAgent(text, task, opts = {}) {
  const t = String(text ?? '').trim();
  if (!t) return { action: '', question: '' };
  const ask = typeof opts.phrase === 'function' ? opts.phrase : null;
  const system = [
    '【追问判定】机器人刚用本机做完一件活，现在群里有人在跟它说话。',
    `刚做完的那个活是：「${String(task ?? '').slice(0, 120)}」`,
    '',
    '下面两条**同时成立**才算：',
    '  ① 这句话是在问**那个活的具体问题**（怎么用 / 在哪 / 能不能改 / 为什么这样 / 里面写了啥…）；',
    '  ② 而且它**答不上来** —— 靠聊天里的常识答不了，必须**回去翻那个活**才知道；',
    '     （那种它本来就能直接回的、或者只是客套两句的，不算 ✗）',
    '',
    '· 两条都成立 ⇒ 回答：问',
    '· 否则（闲聊 / 问别的事 / 它能直接答 / 让它再干一件**新**活）⇒ 回答：无',
    '',
    '⚠️ 只回答一个字：问、无。不要解释、不要标点。',
  ].join('\n');
  let raw = '';
  try {
    if (ask) raw = await ask({ system, user: `这句话：「${t.slice(0, 200)}」` });
    else {
      const { phrase } = await import('./llm.js');
      raw = await phrase({ system, user: `这句话：「${t.slice(0, 200)}」`, maxTokens: 20, timeoutMs: 8000 });
    }
  } catch (e) {
    log.debug(`[任务] 追问判定失败（当"不是"）：${e.message}`);
    return { action: '', question: '' };
  }
  return /^问/.test(String(raw ?? '').trim()) ? { action: 'ask', question: t.slice(0, 200) } : { action: '', question: '' };
}

/** 现在有任务在跑吗（给状态页/日志看） */
export function status() {
  return {
    enabled: enabled(),
    workspace: workspace(),
    running: state.running ? { ...state.running } : null,
    pending: state.pending ? { ...state.pending } : null,
    usedToday: dayOf(Date.now()) === state.day ? Number(state.count ?? 0) : 0,
    // ⚠️ `0` = 不限次数（界面/日志照原样显示，别自作主张换成别的数）
    maxPerDay: Math.max(0, nz(cfg().maxPerDay, 3)),
  };
}

/**
 * 起一个**真正的会话**（走 `agenttask` profile 的 stdio JSON-RPC），并盯着它跑完。
 *
 * ## 为什么不是 `--profile headless`（2026-10-13 改的）
 *
 * 实测两件事：
 *   · headless 跑完**什么都不留** —— 会话不落盘、也不进 GUI 的工作区索引 ⇒ 用户在
 *     自己的 DSH 里**看不见**这些任务（他要的是"能显示在这里"）；
 *   · headless 只有一段最终输出，**拿不到过程** ⇒ 没法"以她为主角"报个进度。
 *
 * `agenttask` profile（`dsh-base` + `dsh-web-app` + 插进去的 sdk-jsonrpc-server）两样都给：
 * 它就是**一个正常会话**（落盘 + 登记 + 能在侧边栏点开），而且**事件流**里能看到
 * `tool/…`（她动手了）、`assistant/message`（这一轮说的话）、`turn/end`。
 *
 * 协议（`@deepseek-ai/dsh-sdk-protocol`）：**行分隔 JSON-RPC**（一行一帧）——
 *   `initialize {cwd, provider, model, reasoningEffort}` →
 *   `session/prompt {sessionId, contentBlocks}` → 收 `session.event` / `session.status` →
 *   `shutdown`。
 * ⚠️ stdout 上除了协议帧**还会有 `dsh web: http://…` 这种日志行**（实测）⇒ 只认以 `{` 开头的行。
 *
 * @param {string} taskText
 * @param {{onSetup?:Function, onProgress?:Function}} [hooks] 过程回调（进度播报用）
 * @returns {{promise: Promise<{code:number, stdout:string, stderr:string, killed:boolean}>, kill:Function}}
 */
/**
 * ⚠️⚠️⚠️ 2026-10-13 最终结论：**这条 sdk-jsonrpc 的路走不通，已经不用了**（留着当存档）。
 *
 * 实测证据（抓原始协议帧、写文件数的）：
 *   · 它跑出来的请求里 **`tools` 零匹配** —— agent 一个工具都拿不到；
 *   · 于是它只会"说"：任务「做一个丰川祥子的简历」→ 20 秒、退出码 0、
 *     任务文件夹里**一个字都没落盘**，回答全是"我打算怎么做"✗
 *   · 对照实验：`dsh --profile headless "在工作区新建 x.txt 写 hello"`
 *     → **文件真建出来了**（还自己读回确认了一遍）✓
 *
 * ⇒ 干活改用 `cliRunner`（下面那个）。这条留着是因为它至少能把会话登记进 GUI，
 *   哪天 sdk 那条链路的工具修好了可以再切回来。
 *
 * @deprecated 见上
 */
function sdkJsonRpcRunner(taskText, hooks = {}) {
  const ws = workspace();
  const r = runner();
  const sessionId = `session-${randomUUID()}`;
  // ⚠️ 2026-10-13：任务文件夹（`startRun` 建好传进来的）—— 钉在提示词**末尾**，
  //    长上下文里末尾最不容易被漏掉，而且正好接在"任务原文"后面（规则 5 说的"下面"）
  const taskDir = String(hooks.taskDir ?? '').trim();
  const dirHint = taskDir
    ? `\n\n本次任务文件夹（上面规则 5 说的那个路径，产物全部放它根下）：${taskDir}\n`
    : '';
  // ⚠️ 2026-10-13：「这次要不要夹带她自己的私货」（和她有关才夹带，无关明着禁止）——
  //    同样是**末尾**，和任务文件夹那段一起，是整段提示词里最后看到的两块
  const selfHint = String(hooks.selfBlock ?? '');
  const child = spawn(
    r.node,
    [r.dsh, '--profile', r.profile, '--port', '0', '--no-open'],
    {
      cwd: ws,
      windowsHide: true,
      // ⚠️⚠️ 沙箱模式 + **DSH_HOME 都要显式传**：
      //    · 沙箱默认就是 workspace-write，这里写死一遍更保险；
      //    · `DSH_HOME` 不传的话，从别的环境（看门狗/服务）起它时 DSH 会去找**另一个 home**，
      //      于是报 `profile "agenttask" does not exist`（2026-10-13 实测）✗
      env: { ...process.env, DSH_HOME: dshHome(), DSH_PERMISSION_MODE: 'workspace-write' },
    },
  );
  let killed = false;
  let stderr = '';
  let finalText = '';
  let started = false;
  let done = false;
  let buf = '';
  let toolSeen = 0;
  const send = (o) => {
    try {
      child.stdin?.write(`${JSON.stringify(o)}\n`);
    } catch {}
  };
  try {
    hooks.onSetup?.({ sessionId });
  } catch {}

  // ⚠️⚠️ **先握手**：`initialize` 的**回执**（id=1）回来才发任务（见下面 stdout 里 `j.id === 1` 那一支）。
  //    漏了这一句的表现是：agent 起来了、却**一声不响干等到超时**（2026-10-13 我自己踩的）。
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { cwd: ws, provider: r.provider, model: r.model, reasoningEffort: r.effort },
  });

  const finish = () => {
    if (done) return;
    done = true;
    // 收工：shutdown（它自己 flush + 退出）—— 给 1.5 秒，然后连树一起收
    send({ jsonrpc: '2.0', id: 99, method: 'shutdown', params: {} });
    setTimeout(() => {
      try {
        child.stdin?.end();
      } catch {}
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {}
    }, 1500).unref?.();
  };

  // ⚠️⚠️ 2026-10-13 修（用户：「刚才的任务还在吗，为什么没动静了」—— 查出来是**我们提前收工**）：
  //
  //   原来收到 `session.status: idle` 就**立刻** `finish()` —— 可 idle 在
  //   "她想完一句话、还没开始调工具"那一步**也会**出现 ⇒ 我们把她掐断在半路：
  //   实测两次任务都只有 14~20 秒、**一个文件都没产出**，输出全是她的思考
  //   （「I'll create this in the specified folder」这种），工具调用压根没发生 ✗
  //
  //   ⇒ 改成两条：① 看到 `turn/end`（整轮结束）才真收工；
  //              ② idle 之后**再等 `IDLE_GRACE_MS`**，这期间只要有事件就取消收工 ✓
  const IDLE_GRACE_MS = 12000;
  let idleTimer = null;
  const cancelIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const armIdle = () => {
    cancelIdle();
    idleTimer = setTimeout(() => {
      log.debug(`[任务] idle 之后 ${IDLE_GRACE_MS / 1000} 秒没动静 → 收工`);
      finish();
    }, IDLE_GRACE_MS);
    idleTimer.unref?.();
  };

  const promise = new Promise((resolve) => {
    const settle = (code) => {
      if (settle.done) return;
      settle.done = true;
      resolve({ code, stdout: finalText, stderr, killed, sessionId });
    };
    settle.done = false;
    child.on('error', (e) => {
      stderr += `\n启动失败：${e.message}`;
      settle(-1);
    });
    child.on('close', (code) => settle(Number(code ?? 0)));
    child.stderr?.on('data', (d) => {
      if (stderr.length < 20000) stderr += String(d);
    });
    child.stdout?.on('data', (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        // ⚠️ stdout 上会有非协议行（`dsh web: http://…`、启动日志）—— 跳过，别当帧解析
        // ⚠️ 排错用：`QQBOT_AGENT_DEBUG=1` 打行首 200 字符；`=2` 打**整行**
        //    （查"工具到底给没给模型"要看 `request/context` 的全文，200 字符不够）
        // ⚠️ `QQBOT_AGENT_STDOUT_LOG=<文件>` 会把每一行**原样**存下来（不受日志长度限制）
        if (process.env.QQBOT_AGENT_STDOUT_LOG) {
          try {
            appendFileSync(process.env.QQBOT_AGENT_STDOUT_LOG, `${line}\n`, 'utf8');
          } catch {}
        }
        if (process.env.QQBOT_AGENT_DEBUG) {
          const cap = Number(process.env.QQBOT_AGENT_DEBUG) > 1 ? 6000 : 200;
          log.warn(`[任务·dbg] 收到行（${line[0] === '{' ? 'JSON' : '日志'}）：${line.slice(0, cap)}`);
        }
        if (!line || line[0] !== '{') continue;
        let j = null;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        // ① 握手回执 → 发任务
        if (j.id === 1) {
          started = true;
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'session/prompt',
            params: {
              sessionId,
              contentBlocks: [{ type: 'text', text: `${RULES}${taskText}${dirHint}${selfHint}` }],
            },
          });
          continue;
        }
        const p = j.params ?? {};
        if (p.sessionId && p.sessionId !== sessionId) continue;
        // ② 状态：⚠️ `idle` **不等于**这一轮结束（见上面 `IDLE_GRACE_MS` 那段）
        if (j.method === 'session.status') {
          if (p.status === 'running') {
            started = true;
            cancelIdle();
          }
          if (p.status === 'idle' && started) armIdle();
          continue;
        }
        if (j.method !== 'session.event') continue;
        const ev = p.event ?? {};
        // ⚠️ 有事件就说明**还活着** ⇒ 取消"待收工"（不然 idle 那次触发就把她掐断了）
        cancelIdle();
        // ③ 整轮结束 —— 这才是真收工的信号
        if (ev.type === 'turn/end') {
          finish();
          continue;
        }
        // ③.五 这一轮她说了什么（取**最后一条** assistant 文本）
        if (ev.type === 'assistant/message') {
          const t = textOfMessage(ev.data?.message);
          if (t) finalText = t;
          continue;
        }
        // ④ 过程：只要看到工具活动就报一次（"她动手了"）
        if (typeof ev.type === 'string' && ev.type.includes('tool')) {
          toolSeen++;
          if (toolSeen === 1) {
            try {
              hooks.onProgress?.({ kind: 'tool', type: ev.type, raw: ev });
            } catch {}
          }
        }
      }
    });
  });

  return {
    promise,
    sessionId,
    kill: () => {
      killed = true;
      // ⚠️ 同上：**别在这里设 `done`**（设了 promise 就永不 resolve，running 卡死 ✗）
      try {
        child.kill();
      } catch {}
      // ⚠️ Windows 上子进程可能有孙进程（它自己会起 shell）—— 连整棵树一起收
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {}
    },
  };
}

/**
 * ⚠️⚠️ 2026-10-13 加（用户：「**执行的任务要能显示在这里**」—— 指 GUI 侧边栏那个工作区列表）。
 *
 * 实测（一条条验过的，别再怀疑）：
 *   · `--profile headless`：会话**不落盘**、也不登记 ⇒ 什么都看不见 ✗
 *   · `agenttask`（base + web-app + stdio JSON-RPC）：会话**落盘了**
 *     （`sessions/<工作区>/<sessionId>/session.v3.jsonl`）✓，但**还是不会自动登记** ✗
 *     —— 登记（`storages/workspace.json` 里的 workspaces[].sessionIds）是**GUI 自己**在
 *     "用户打开/新建会话"时写的，机器人从 stdio 直连驱动它不会触发。
 *
 * ⇒ 所以我们**自己补一条登记**：把这次会话挂到"工作区=工作区路径"那一条下面。
 *   ⚠️ 尽力而为：读不到 / 格式不对 / 写不进去，一律**只记日志**，绝不影响任务本身。
 *   ⚠️ GUI 内存里也有一份，之后它写盘可能覆盖掉这条 ⇒ **每次跑完都补一次**，丢了还会回来。
 *
 * @param {string} sessionId
 * @returns {boolean} 登记成功了吗
 */
export function registerSession(sessionId) {
  const sid = String(sessionId ?? '').trim();
  const ws = workspace();
  if (!sid || !ws) return false;
  const home = dshHome();
  const file = join(home, 'storages', 'workspace.json');
  try {
    // ⚠️ 顺手吃掉 BOM（那份文件是别人写的；带 BOM 时 `JSON.parse` 会直接报
    //    `Unexpected token ''` —— 2026-10-13 实测踩过）
    const j = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const tbl = (j.tables ??= {}).workspaces ?? (j.tables.workspaces = {});
    const norm = (p) => String(p ?? '').replace(/[\\/]+$/, '').toLowerCase();
    let id = Object.keys(tbl).find((k) => norm(tbl[k]?.path) === norm(ws));
    const now = new Date().toISOString();
    if (!id) {
      id = randomUUID();
      tbl[id] = { path: ws, title: ws.split(/[\\/]/).filter(Boolean).pop() ?? '工作区', sessionIds: [], createdAt: now, updatedAt: now };
      const g = (j.global ??= {});
      if (Array.isArray(g.workspaceIds) && !g.workspaceIds.includes(id)) g.workspaceIds.unshift(id);
      log.info(`[任务] GUI 工作区索引里新建了「${tbl[id].title}」（${ws}）`);
    }
    const rec = tbl[id];
    if (!Array.isArray(rec.sessionIds)) rec.sessionIds = [];
    if (!rec.sessionIds.includes(sid)) rec.sessionIds.push(sid);
    rec.updatedAt = now;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
    renameSync(tmp, file);
    log.info(`[任务] 已把这次会话登记进 GUI 的工作区列表：「${rec.title}」→ ${sid}`);
    return true;
  } catch (e) {
    log.warn(`[任务] 往 GUI 工作区索引里登记失败（不影响任务）：${e.message}`);
    return false;
  }
}

/** 从一条消息里抠出纯文本（`content: [{type:'text', text}]`） */
function textOfMessage(message) {
  try {
    const c = message?.content;
    if (typeof c === 'string') return c.trim();
    if (Array.isArray(c)) {
      return c
        .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
        .map((b) => String(b.text ?? ''))
        .join('')
        .trim();
    }
  } catch {}
  return '';
}

/**
 * `$DSH_HOME/sessions/<工作区>/<会话>` 下的会话目录清单（跟着带 mtime，用来认"最新的那个"）。
 */
function sessionDirs() {
  const out = [];
  const root = join(dshHome(), 'sessions');
  try {
    for (const wsDir of readdirSync(root, { withFileTypes: true })) {
      if (!wsDir.isDirectory()) continue;
      const wp = join(root, wsDir.name);
      let subs = [];
      try {
        subs = readdirSync(wp, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of subs) {
        if (!s.isDirectory() || !String(s.name).startsWith('session-')) continue;
        let mtime = 0;
        try {
          mtime = statSync(join(wp, s.name)).mtimeMs;
        } catch {}
        out.push({ id: s.name, mtime, dir: join(wp, s.name) });
      }
    }
  } catch {}
  return out;
}

/** 跑完之后：**新出现的**那个会话就是本次的（headless 的 sessionId 是它自己生成的） */
function pickNewSession(before) {
  const known = before instanceof Set ? before : new Set();
  const fresh = sessionDirs().filter((x) => !known.has(x.id));
  fresh.sort((a, b) => b.mtime - a.mtime);
  return fresh[0]?.id ?? '';
}

/**
 * ⭐ **真正在用的跑法**（2026-10-13 定终版）：`dsh --profile headless "<整段提示词>"`
 *
 * 为什么从 stdio JSON-RPC 换回来（有实测证据，别再改回去）：
 *   · 那条路跑出来的请求里 **`tools` 零匹配** ⇒ agent 拿不到工具 ⇒ 只会"说"，
 *     20 秒退 0、任务文件夹里一个字都没有 ✗
 *   · 这条：实测「在工作区根目录新建 probe-cli.txt，写一行 hello」
 *     → **文件真建出来了**（6 字节），它还自己 `read` 回读确认了一遍 ✓
 *   · 而且**会话照样落盘**（跑完 `sessions/<工作区>/` 下多一个会话目录，约 50 KB）
 *     ⇒ 用户要的"在 GUI 里能看见"也保得住（id 由我们扫出来再登记）✓
 *
 * 三条硬要求：
 *   ① 任务原文 + 铁律拼成**一个 argv** 传（**绝不拼 shell** —— 群里的话是不可信输入）；
 *   ② `DSH_HOME` 必须显式传（不传就会去找另一个 home，报 profile 不存在）；
 *   ③ 会话 id 跑完**扫新增目录**取回来 → `registerSession` 登记进 GUI 的工作区列表。
 *
 * ⚠️ 代价：**没有事件流**（拿不到"她动手了"的实时信号）⇒ 进度那句改成
 *    `startRun` 里定时报（见那边），不是靠工具事件触发。
 */
function cliRunner(taskText, hooks = {}) {
  // ⚠️ 2026-10-14：**私聊工作模式**（`src/private-work.js`）要在**它自己的工作区**里跑 ——
  //    那边是"一个私聊一个固定目录、永远复用"（用户：「每个私聊只开一个对话，不开新对话」）。
  //    所以 cwd 允许**按次覆盖**；不传 = 老行为（群任务那个工作区）逐字不变 ✓
  const ws = String(hooks.cwd ?? '').trim() || workspace();
  const r = runner();
  // ⚠️ 任务文件夹（`startRun` 建好传进来的）—— 钉在提示词**末尾**，长上下文里末尾最不容易漏
  const taskDir = String(hooks.taskDir ?? '').trim();
  const dirHint = taskDir
    ? `\n\n本次任务文件夹（上面规则 5 说的那个路径，产物全部放它根下）：${taskDir}\n`
    : '';
  // ⚠️ 「这次要不要夹带她自己的私货」（和她有关才夹带，无关明着禁止）
  const selfHint = String(hooks.selfBlock ?? '');
  // ⚠️⚠️ 2026-10-14 加（用户：「该去**读那一段对话**」）：群里刚才那些话，原样交给它
  const contextHint = String(hooks.contextBlock ?? '');
  // ⚠️ 顺序：规则 → 任务原话 → 群聊上下文 → 任务文件夹路径 → 私货 → 分段规则
  //    （文件夹路径 + 分段规则钉在**末尾** —— 长上下文里末尾最不容易漏 ✓）
  // ⚠️ 2026-10-14：`hooks.rawPrompt` = **整段提示词由调用方自己给** ——
  //    私聊工作模式那套规矩（"先摸需求、只在这个文件夹里干活"）和群任务**不是一回事**，
  //    套 `RULES` 会把群里那套（群文件夹、产物发群）灌进去 ✗
  //    不传 = 老行为**逐字不变** ✓
  const prompt = hooks.rawPrompt
    ? String(taskText ?? '')
    : `${RULES}${taskText}${contextHint}${dirHint}${selfHint}${SECTION_RULES}`;

  const before = new Set(sessionDirs().map((x) => x.id));
  const child = spawn(r.node, [r.dsh, '--profile', r.profile, prompt], {
    cwd: ws,
    windowsHide: true,
    // ⚠️ 2026-10-14：**按次指定权限** —— 私聊工作模式"收到文件先预读一遍"那一步要 **只读**
    //    （`hooks.permission = 'read-only'`）：看明白文件是什么，**但一个字都不许改**
    //    （用户：「agent 这时是只读，不要开始工作」）✓
    //    ⚠️ 不传 = 老行为（`workspace-write`）**逐字不变** ✓
    env: {
      ...process.env,
      DSH_HOME: dshHome(),
      DSH_PERMISSION_MODE: String(hooks.permission ?? '').trim() || 'workspace-write',
    },
  });
  let killed = false;
  let out = '';
  let err = '';
  let done = false;

  const promise = new Promise((resolve) => {
    const settle = (code) => {
      if (done) return;
      done = true;
      // ⚠️ 会话目录是它**退出前**写的 —— 留 300ms 让落盘收尾，再扫一次"新增的那个"
      setTimeout(() => {
        const sid = pickNewSession(before) || `session-${randomUUID()}`;
        try {
          hooks.onSetup?.({ sessionId: sid });
        } catch {}
        resolve({ code, stdout: out.trim(), stderr: err, killed, sessionId: sid });
      }, 300).unref?.();
    };
    child.on('error', (e) => {
      err += `\n启动失败：${e.message}`;
      settle(-1);
    });
    child.on('close', (code) => settle(Number(code ?? 0)));
    // ⚠️ stdout = **最终那句话**；stderr = 她的思考过程（别发群）—— 和 headless 的分工一致
    child.stdout?.on('data', (d) => {
      if (out.length < 200000) out += String(d);
    });
    child.stderr?.on('data', (d) => {
      if (err.length < 20000) err += String(d);
    });
  });

  return {
    promise,
    kill: () => {
      killed = true;
      // ⚠️⚠️⚠️ 2026-10-13 **真 bug**（实测：一个超时被杀的任务让 running 卡了 13 分钟，
      //    之后**所有**派活都被"手上这个还没弄完"挡住 ✗）：
      //    这里原来顺手写了 `done = true` —— 而 `settle()` 第一行就是 `if (done) return;`
      //    ⇒ 子进程随后关闭时 **promise 永不 resolve** ⇒ `startRun` 卡在 `await promise`
      //    ⇒ 那句"清掉 `state.running`"永远执行不到 ✗
      //    ⇒ `done` 只归 `settle()` 管，**kill 不许碰** ✓
      try {
        child.kill();
      } catch {}
      // ⚠️ Windows 上子进程可能有孙进程（它自己会起 shell）—— 连整棵树一起收
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {}
    },
  };
}

let runnerImpl = cliRunner;
/** 测试专用：换掉"真的起进程"那一步 */
export function __setRunner(fn) {
  runnerImpl = typeof fn === 'function' ? fn : cliRunner;
}

/**
 * ⚠️ 2026-10-14 加：**私聊工作模式的活也要进「本机任务」面板** ——
 *    用户截图：「**任务面板看不到这个对话**」（面板上只有主号那些群任务）。
 *
 * 为什么单独开一个口：`startRun` 是**群任务**那条路（要 gid、要群文件夹、要 @他…），
 *   私聊的活走的是 `private-work.js`，不经过它 ⇒ 历史里当然没有 ✗
 *
 * ⚠️ 历史是**按号存**的（`state/accounts/<QQ>/agent.json`）⇒ 工作号的活在**它自己那个界面**
 *    （3101）的「本机任务」里看得到；在主号那个 3099 上看不到（各看各的，这是对的）✓
 */
export function addPrivateHist(rec = {}) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  addHist({
    id,
    gid: '',
    by: String(rec.by ?? ''),
    byName: String(rec.byName ?? '私聊'),
    task: clip(String(rec.task ?? ''), 200),
    dir: String(rec.dir ?? ''),
    startedAt: Date.now(),
    status: 'running',
    related: false,
    // ⚠️ 标一下"这是私聊的单"（面板上跟群任务分得开）
    // ⚠️ 标一下这是哪种单（面板上跟群任务分得开）：
    //    `dm` = 真开工了；`dm-read` = **只读预读**（看一遍文件是什么，没动它）
    kind: String(rec.kind ?? 'dm'),
  });
  return id;
}

/** 私聊那单的收尾（跑完 / 交付完都调它） */
export function patchPrivateHist(id, patch = {}) {
  updHist(String(id), { endedAt: Date.now(), status: 'done', ...patch });
}

/**
 * ⚠️ 2026-10-14 加：**让别的模块也能起一次 agent**（目前只有 `src/private-work.js` 用）。
 *
 * 为什么从这里走而不是那边自己 `spawn`：起 agent 这件事**只有一份实现**最好 ——
 *   kill（连整棵树）、超时、会话 id 回捞、`DSH_HOME` 显式传递，全在这一个地方 ✓
 *   两边各写一份的话，迟早出现"一边修好了、另一边还是老毛病"。
 *
 * ⚠️ 调用方负责的东西：`cwd`（它自己的工作区）、`timeoutMs`、`rawPrompt`（它自己那套规矩）。
 */
export function runTask(taskText, hooks = {}) {
  return runnerImpl(taskText, hooks);
}

// ⚠️ 「这是不是一句派活 / 同意 / 不同意」那次**模型判定**也要能被套件换掉
//    （`handle()` 内部是模块内引用，外面 monkey-patch 不到）
let judgeImpl = judgeIntent;
export function __setJudge(fn) {
  judgeImpl = typeof fn === 'function' ? fn : judgeIntent;
}

// ⚠️ 「这条群消息是不是在跟那个活说话」也过一次模型 —— 套件里换掉（免得起真请求）
let interjectImpl = judgeInterject;
export function __setInterject(fn) {
  interjectImpl = typeof fn === 'function' ? fn : judgeInterject;
}

// ⚠️ 「这条群消息是不是在问那个刚做完的活」也过一次模型 —— 套件里换掉
let askAgentImpl = judgeAskAgent;
export function __setAskAgent(fn) {
  askAgentImpl = typeof fn === 'function' ? fn : judgeAskAgent;
}

// ⚠️⚠️ 2026-10-14 加（用户：「由**她自己决定**什么时候该用电脑」）：这次判定也要能被套件换掉
let selfUseImpl = judgeSelfUse;
export function __setSelfUse(fn) {
  selfUseImpl = typeof fn === 'function' ? fn : judgeSelfUse;
}

// ⚠️ 「她自己的私货」也是**一次真模型调用**（`asideFor`）—— 套件里换掉，免得起真网络请求
let asideImpl = asideFor;
export function __setAside(fn) {
  asideImpl = typeof fn === 'function' ? fn : asideFor;
}

// ⚠️ 「用她自己的口吻说一遍」那一次模型调用同理 —— 套件里换掉，免得起真网络请求
let voiceImpl = voiceize;
export function __setVoice(fn) {
  voiceImpl = typeof fn === 'function' ? fn : voiceize;
}

/**
 * 开工那句确认（就是**两个空格开头**的那条）。
 *
 * ⚠️⚠️ 2026-10-13（用户截图：她回的是「行，我去弄「做一个丰川祥子的简历，然后发给我」」）：
 *    「**不要复制一遍要做的事**，以**自己的话**说开始做什么就行了」。
 *    ⇒ 原来那句是把他的话原样套进模板（复读机），现在**让她自己的模型说一句**。
 *    ⚠️ 失败 / 想不出来 ⇒ 退回一句**不带原话**的固定说法（绝不退回复读）✓
 */
async function startLine(task, gid = '') {
  // ⚠️⚠️ 2026-10-14 加（用户截图：他说同意之后，她只回了一句
  //    「**爱音和祥子的婚礼PPT？行，我来。**」—— 用户原话：
  //    「**做自己的 ppt 应该会有一句吐槽之类的话再开始做的**」✗）：
  //    ⇒ 这个活**牵扯到她自己**（她的婚礼、她的简历、她的照片…）时，
  //      **先给她自己的一个反应**（吐槽 / 别扭 / 嘴硬 / 自嘲 / 半推半就），**再**动手 ✓
  //    ⚠️ 判据：任务原文里出现她的名字或自称（`selfIdentity()`）——
  //      和 `judgeIntent` 那套"有关/无关"一个意思，但这里**只按名字判**就够（省一次模型调用 ✓）
  let aboutHerself = false;
  try {
    const id = await selfIdentity();
    const keys = [id.name, id.self, ...(id.aliases ?? [])]
      .map((x) => String(x ?? '').trim())
      .filter((x) => x.length >= 2);
    aboutHerself = keys.some((k) => String(task ?? '').includes(k));
  } catch {}
  const FACTS = aboutHerself
    ? '你现在开始动手做了。⚠️ 这件事**说的是你自己** —— 开口**先给你自己的一个反应**' +
      '（吐槽、别扭、嘴硬、自嘲、"谁要跟他结啊"那种半推半就都行，一两句），**再**说你要动手。' +
      '🚫 别一副"好的，我来"的助理腔，也别复读他要你做什么。'
    : '你现在开始动手做了。';
  try {
    const line = String((await voiceImpl('start', FACTS, { task, gid, timeoutMs: 8000 })) ?? '').trim();
    // ⚠️ `voiceize` 在模型失败时返回 **facts 原文** —— 那不是话，一样退回固定说法
    if (line && !line.includes(FACTS) && line.length >= 4 && line.length <= 80) return line;
  } catch {}
  return '行，我这就去弄，好了跟你说。';
}

function todayCount() {
  if (state.day !== dayOf(Date.now())) {
    state.day = dayOf(Date.now());
    state.count = 0;
  }
  return Number(state.count ?? 0);
}

const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…（截断）` : String(s ?? ''));

/**
 * ⚠️⚠️⚠️ 2026-10-13 加（用户原话：「**要进上下文，要不然还是容易不知道自己说什么**」）。
 *
 * 任务桥发出去的每一句（开工 / 反问 / 我停了 / 催你 / 结果 / 发不出去…）原来都是**裸发** ——
 *   `bot.sendToGroup()` 只调 `send_group_msg`，**不写她自己的聊天上下文** ✗
 *   ⇒ 群里接着问一句，她完全不知道自己刚说过「我这就去弄」「我停了」 ✗
 *   （同一天已经为这个栽过两次：她不知道手上正在干什么、不知道自己说过什么。）
 *
 * ⇒ 统一走这里：**先发**，再把**去掉两个空格前缀的那句**记进她自己的上下文。
 *   ⚠️ 不能改走 `sendChatLike()`：那条路会**分条 + trim**，两个空格前缀就没了我 ✗
 *   ⇒ 只补记上下文，不动发送方式 ✓
 *
 * @param {object} bot
 * @param {string} gid
 * @param {string} text 要发的话（**调用方自己带 `CONFIRM_PREFIX`**）
 * @param {{record?:boolean}} [opts] `record: false` = 不记上下文；其余字段（`at` 之类）原样转给 `sendToGroup`
 */
/**
 * ⚠️⚠️⚠️ 2026-10-14 加（用户原话：「**我不需要文件在哪里，因为我自己找得到，
 *    别人就更不需要了，因为电脑不是他的**」）。
 *
 * ⇒ **发进群的每一句**都过一遍这个：不提位置、也不提"她那台电脑"。
 *
 * ⚠️ 为什么做在**唯一出口**（`taskSay`）上：代码拼的那几句可以一处一处改，
 *    但她**模型自己现编**的那句（"东西都在某个文件夹里"这种）改不动 ⇒
 *    出口兜一道最省心、也最彻底 ✓
 * ⚠️ 只碰**发群**的文本；日志、任务页、她自己上下文里的完整信息**照旧保留** ✓
 * ⚠️ 替换故意保守（宁少勿错）：只抹路径、那段括号说明、和几个明显会暴露"电脑/位置"的词 ✓
 */
export function desensitizeForGroup(text) {
  let t = String(text ?? '');
  // ① 盘符路径 / UNC 路径：整段抹掉
  t = t.replace(/[A-Za-z]:[\\/][^\s，。；、）」』】]+/g, '');
  t = t.replace(/\\\\[^\s，。；、）」』】]+/g, '');
  // ② 「（进群文件夹 xxx）」这类括号说明：整段抹掉
  t = t.replace(/[（(][^（）()]*文件夹[^（）()]*[）)]/g, '');
  // ③ 那几个会暴露"电脑 / 位置"的词
  t = t.replace(/任务文件夹|群文件夹|工作区|文件夹|目录|路径/g, '');
  t = t.replace(/我(的)?电脑|这台电脑|电脑上/g, '我这边');
  // ④ 抹完留下的杂物（空括号、连着两个标点、双空格）
  t = t
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/[，、]{2,}/g, '，')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([，。；、）])/g, '$1')
    .trim();
  return t;
}

async function taskSay(bot, gid, text, { record = true, ...rest } = {}) {
  const raw = String(text ?? '');
  if (!raw) return;
  // ⚠️⚠️ 去位置化（唯一出口做一次就够 —— 连她**模型自己现编**的那句也一起管住 ✓）
  //    ⚠️⚠️ 前缀那两个空格**必须保住** —— 直接 `trim()` 上去会被吃掉 ✗
  const pre = raw.startsWith(CONFIRM_PREFIX) ? CONFIRM_PREFIX : '';
  const body = desensitizeForGroup(pre ? raw.slice(CONFIRM_PREFIX.length) : raw);
  if (!body) return;
  const line = pre + body;
  try {
    await bot.sendToGroup(gid, line, rest);
  } catch (e) {
    log.debug(`[任务] 发群失败：${e.message}`);
  }
  if (!record) return;
  try {
    const recent = await import('./recent.js');
    const plain = line.startsWith(CONFIRM_PREFIX) ? line.slice(CONFIRM_PREFIX.length) : line;
    recent.rememberBot({ message_type: 'group', group_id: String(gid) }, plain);
  } catch (e) {
    log.debug(`[任务] 记进上下文失败：${e.message}`);
  }
}

/**
 * 真正开跑（确认消息已经在调用方发过了）。
 *
 * @param {{bot:object, gid:string, by:string, byName:string, task:string}} p
 */
async function startRun({ bot, gid, by, byName, task, related = false, reuseDir = '' }) {
  const self = related === true;
  // ⚠️⚠️ 2026-10-14 修（真实事故：连着重放两条消息 ——「爱音派活」和「主人同意」——
  //    两条**几乎同时**进来 ⇒ 两边检查 `state.running` 时对方都还没写进去 ⇒
  //    **两个 agent 同时在跑** ✗（日志：15:30:04 今天第 2 次、15:30:05 今天第 3 次，
  //    两个文件夹、两条产物、群里两份结果）
  //    「同时只跑一个」那道兜底原来写在**各个调用点**上 ⇒ 并发时谁都拦不住 ✗
  //    ⇒ 挪进来：**进这里就先把上一个停掉**（一处覆盖所有调用点 ✓）
  if (state.running && currentKill) {
    log.warn(`[任务] 已经有一个在跑（${clip(state.running.task, 30)}）⇒ 先把它停掉，再开这个`);
    killCurrent();
    state.running = null;
  }
  state.running = {
    gid: String(gid),
    by: String(by),
    byName: String(byName ?? ''),
    task: clip(task, 200),
    related: self,
    startedAt: Date.now(),
  };
  state.count = todayCount() + 1;
  // ⚠️⚠️ 2026-10-13：**先给这次任务一个自己的文件夹**（用户："一个文件夹对应一个任务，不要塞太里面"）
  //    ⚠️ 但"插话改要求 → 重跑"那次**复用原来那个文件夹**（同一个活接着做，产物别散成两处）
  const reuse = String(reuseDir ?? '').trim();
  const dir = reuse && existsSync(reuse) ? reuse : taskDirFor(task);
  // ⚠️⚠️ 2026-10-13（用户：「加任务页」）：**任务历史**从这里开始记（管理界面 `/agent-tasks` 那页读它）
  const histId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  addHist({
    id: histId,
    gid: String(gid),
    by: String(by),
    byName: String(byName ?? ''),
    task: clip(task, 200),
    dir,
    startedAt: Date.now(),
    status: 'running',
    related: self,
  });
  const finishHist = (patch) =>
    updHist(histId, {
      endedAt: Date.now(),
      status: 'done',
      sessionId: '',
      arts: collectArtifacts(dir).map((a) => ({ name: a.name, size: a.size })),
      ...patch,
    });
  if (dir) state.running.dir = dir;
  save();
  log.info(
    `[任务] 开跑（${byName || by} 在群 ${gid}）：${clip(task, 60)}｜工作区=${workspace()}｜今天第 ${state.count} 次`,
  );
  appendLedger(`**开工**（${byName || by}）：${task}${dir ? `｜文件夹：${dir.split(/[\\/]/).filter(Boolean).pop()}` : ''}`);

  // ⚠️⚠️ 2026-10-13（用户：「和她有关的可以夹带私货」+「**和她无关的一定不要**夹带私活」）：
  //    有关 → **她自己**先写两句（她的模型），连同"她是谁"一起交给 agent 放进产物；
  //    无关 → 那一段是**明着禁止**，不是"不注入"（agent 手里本来就有她的人设，不说明它也会加）
  let selfHint = selfBlock({ related: self });
  if (self) {
    try {
      const [brief, aside] = await Promise.all([selfBrief(), asideImpl(task)]);
      selfHint = selfBlock({ related: true, brief, aside });
      log.info(`[任务] 这次和她有关 → 私货${aside ? `她自己写了 ${aside.length} 字` : '她没写出来（让 agent 照口吻代写）'}`);
    } catch (e) {
      log.warn(`[任务] 准备私货时出错（不影响干活）：${e.message}`);
    }
  }

  // ⚠️⚠️⚠️ 2026-10-14 加（用户：「**刚才爱音和祥子的配图，祥子的配图画成素世的了**」）：
  //    真因：agent 在**工作区**里跑，**看不到人设包** —— 参考图和
  //    「外貌：蓝发、琥珀瞳、披肩双马尾、齐刘海」那一行都在 `personas/saki/` 里 ✗
  //    ⇒ 它只能凭印象猜：实测那版脚本把祥子写成了「浅金发 + 蓝眼 + 长侧分长发」✗
  //    ⇒ 每次开工都把**她自己的参考图 + 外貌那一行**抄进任务文件夹（`我的样子/`）✓
  //    ⚠️ 只放"当前人设"的 —— 要画别人而手里没参考时，RULES 第 12 条要求它**别硬画** ✓
  try {
    const pdir = join(ROOT, 'personas', String(config.persona?.id ?? '').trim() || 'saki');
    const mine = join(dir, '我的样子');
    mkdirSync(mine, { recursive: true });
    let files = [];
    try {
      files = readdirSync(pdir);
    } catch {}
    const ref =
      files.find((f) => /^ref\.(png|jpe?g|webp)$/i.test(f)) ??
      files.find((f) => /^avatar\.(png|jpe?g|webp)$/i.test(f)) ??
      '';
    if (ref) copyFileSync(join(pdir, ref), join(mine, `参考图${extname(ref)}`));
    let look = '';
    try {
      const md = readFileSync(join(pdir, 'persona.md'), 'utf8');
      const m = /^\|\s*外貌\s*\|(.+?)\|/m.exec(md);
      if (m) look = String(m[1]).trim();
    } catch {}
    if (ref || look) {
      writeFileSync(
        join(mine, '我的样子.md'),
        [
          '# 她自己的样子（画人物之前**照这个**，别凭印象猜）',
          '',
          look ? `- 外貌：${look}` : '- 外貌：（人设里没写这一行）',
          ref ? `- 参考图：同目录下的 \`参考图${extname(ref)}\`（**照它画**）` : '- 参考图：（人设包里没有参考图）',
          '',
          '⚠️ 要画的是**别人**、而这里没有那个人的参考 ⇒ **别硬画**（RULES 第 12 条）。',
        ].join('\n'),
        'utf8',
      );
      log.info(`[任务] 把她自己的样子放进任务文件夹：参考图=${ref || '无'}｜外貌=${look || '无'}`);
    }
  } catch (e) {
    log.debug(`[任务] 放「我的样子」失败：${e.message}`);
  }

  // ⚠️⚠️ 2026-10-14 加（用户：「…或者**直接发送消息到对话**」）：
  //    她（agent）要跟群里说话，就往任务文件夹里的 `要说的话.md` **追加一行**；
  //    这里每 2 秒看一眼，出现新行 ⇒ 当成"她自己说的话"发进群 ✓
  //    ⚠️ 出口仍然是 `taskSay`（唯一出站口：记进她自己的上下文 ✓ 和别的话一个口径 ✓）
  const talkFile = dir ? join(dir, '要说的话.md') : '';
  // ⚠️⚠️ 2026-10-14 加（用户问：「是不是成功复用了之前相同任务的**对话**」）：
  //    ⚠️ 实测结论：**没有复用** —— headless 那条路（`dsh --profile headless "…"`）是
  //    **一次性**的，而且 CLI 里**不给 `--resume`**（刚查过 `--profile headless --help`：
  //    只有 `-h` ✗）；带会话的那条 SDK 路**连工具都没有**（根本不能用 ✗）
  //    ⇒ 换个办法达到同样的效果：**把同一个活的每一轮对话记在任务文件夹里** ——
  //      下一轮复用同一个文件夹时，它先读这个文件，就知道上一轮跟他说过什么、做到哪儿 ✓
  //    ⚠️ 这里是**开工那一刻追加"这一轮的要求"**（同步、一定执行）；它做完说的那句在收尾处追加 ✓
  const talkLogFile = dir ? join(dir, '这个活的对话.md') : '';
  if (talkLogFile) {
    try {
      if (!existsSync(talkLogFile)) {
        writeFileSync(
          talkLogFile,
          '# 这个活的对话（机器人自动记的：每一轮的要求 + 她做完说的那句）\n\n' +
            '⚠️ 接着做之前**先看这个** —— 上一轮说过什么、做到哪儿，都在这儿。\n\n',
          'utf8',
        );
      }
      appendFileSync(
        talkLogFile,
        `\n## ${new Date().toLocaleString('zh-CN', { hour12: false })} 这一轮的要求\n${task}\n`,
        'utf8',
      );
    } catch (e) {
      log.debug(`[任务] 记「这个活的对话」失败：${e.message}`);
    }
  }
  const talkLines = (f) =>
    readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith('#'));
  let talkSent = 0;
  let talkTimer = null;
  if (talkFile) {
    try {
      if (!existsSync(talkFile)) {
        writeFileSync(
          talkFile,
          '# 想说给群里的话（一行一条、追加写；你每写一行，她就会立刻把它发到群里）\n',
          'utf8',
        );
      }
      talkSent = talkLines(talkFile).length;
    } catch {}
    const pump = async () => {
      try {
        if (!state.running) {
          clearInterval(talkTimer);
          return;
        }
        if (!existsSync(talkFile)) return;
        const lines = talkLines(talkFile);
        if (lines.length <= talkSent) return;
        const fresh = lines.slice(talkSent, talkSent + 5); // 一次最多补 5 条，别刷屏
        talkSent = lines.length;
        for (const l of fresh) {
          // ⚠️⚠️⚠️ 2026-10-14 修（用户截图：「**任务中说的话也好像没有被人设润色**，还需要修改」✗）：
          //    原来这里是把她（agent）写的那行**原话直接发群** ✗ ⇒ 群里看到的就是 agent 腔：
          //    「接着上回那份来：日期场地我按 11.21 / RiNG 主厅填死，两位新娘的配图补上，配色再顺一遍。」
          //    ⇒ 现在**每一行都过她自己的模型**（和进度/结果同一个 `voiceize` 层 ✓）
          //    ⚠️ 它失败就退回原文 —— 群里不能没动静 ✓
          const said = await voiceImpl('progress', clip(l, 300), { task, gid, timeoutMs: 8000 }).catch(() => '');
          await taskSay(bot, gid, hidePaths(said || clip(l, 300), dir)).catch(() => {});
        }
      } catch (e) {
        log.debug(`[任务] 读「要说的话.md」失败：${e.message}`);
      }
    };
    talkTimer = setInterval(() => void pump(), 2000);
    talkTimer.unref?.();
  }

  // ⚠️⚠️ 2026-10-14 加（用户：「该去**读那一段对话**」，接着问「**靠任务台账可以吗**」）：
  //    台账（`任务记录.md`、「你以前做过的活」）只记得**她做过的活** ——
  //    群里那些**没派活的聊天**它一个字都没有 ✗
  //    ⇒ 起 agent 时顺手把**最近的群聊记录**拉下来，写成任务文件夹里的 `群聊记录.md`，
  //      它想"顺着刚才聊的"做点什么，就能真去读那一段 ✓
  //    ⚠️⚠️ **绝对不能 await**（这一整段就在 `runnerImpl` 之前）—— 多一个 await 会让 runner
  //      慢一拍才被调：套件里当场抓到过「先跑起来 实际 0 次」✗（真机表现是她说完那句要愣一下）
  //    ⚠️ 所以它是**后台跑**的：agent 头几秒可能还看不到这个文件 ⇒ 提示词里写了"可能晚几秒，稍等再读"✓
  //    ⚠️ 协议端支持 `get_group_msg_history`（补看 / QQ 空间回填一直在用 ✓ 实测成功过）
  void (async () => {
    if (!dir) return;
    try {
      const raw = await bot.call('get_group_msg_history', { group_id: gid, count: 120 });
      const list = Array.isArray(raw) ? raw : (raw?.messages ?? raw?.data?.messages ?? []);
      if (!Array.isArray(list) || !list.length) return;
      const { extractText, toSegments } = await import('./message.js');
      const lines = list.map((m) => {
        let when = '';
        try {
          when = new Date(Number(m?.time) * 1000).toLocaleString('zh-CN', { hour12: false });
        } catch {}
        const who = String(m?.sender?.card || m?.sender?.nickname || m?.user_id || '某人');
        let text = '';
        try {
          text = String(extractText(toSegments(m?.message)) ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
        } catch {}
        return `- [${when}] ${who}：${text}`;
      });
      writeFileSync(
        join(dir, '群聊记录.md'),
        `# 群里最近的聊天记录（机器人自动拉的，从旧到新，共 ${lines.length} 条）\n\n${lines.join('\n')}\n`,
        'utf8',
      );
      log.debug(`[任务] 群聊记录已写进任务文件夹（${lines.length} 条）`);
    } catch (e) {
      log.debug(`[任务] 拉群聊记录失败（不影响干活）：${e.message}`);
    }
  })();

  // ⚠️⚠️ 2026-10-14 加（用户：「该去**读那一段对话**」）：
  //    把群里**刚才那几十条**原样交给 agent —— 不然它只看到"任务原话"那一句，
  //    想"顺着刚才聊的"做点什么全靠猜 ✗
  let contextBlock = '';
  try {
    const ctx = String(recentStore.contextText(gid) ?? '').trim();
    if (ctx) contextBlock = `\n\n【群里刚才说的话（就是最近这些，从旧到新）】\n${ctx}\n`;
  } catch (e) {
    log.debug(`[任务] 取群聊上下文失败：${e.message}`);
  }

  const { promise, kill } = runnerImpl(task, {
    taskDir: dir,
    selfBlock: selfHint,
    contextBlock,
    // ⚠️ 2026-10-13：过程信息**以她自己为主角**发一条（用户要求）
    onSetup: ({ sessionId }) => {
      if (sessionId) {
        state.running.sessionId = String(sessionId);
        save();
        // ⚠️⚠️ 2026-10-14 加（用户截图：任务页上那条 `running` 的点开是
        //    「（这次没有可显示的对话）」✗）：`sessionId` 原来**只在跑完时**
        //    才写进任务历史（`finishHist` 那一步）⇒ 任务页在它**跑的过程中**
        //    读历史读不到会话 ⇒ 点开当然是空的 ✗
        //    ⇒ 这里一拿到就顺手写进历史 ✓（跑着也能点开看它到底在干什么）
        try {
          updHist(histId, { sessionId: String(sessionId) });
        } catch (e) {
          log.debug(`[任务] 把会话 id 写进历史失败：${e.message}`);
        }
      }
    },
    onProgress: (info) => {
      void info; // ⚠️ 工具类型**不再**往下传（传了就会被她"转述成"过程细节）
      // 只在**第一次动手**时报一句；报过就不再打扰
      if (state.running?.progressSent) return;
      if (state.running) state.running.progressSent = true;
      // ⚠️⚠️ 2026-10-13 改（用户截图）：原来这里给的是
      //    「这一步是去翻/写工作区里的东西」⇒ 她的模型照着一转述，就变成
      //    「先翻了翻任务文件夹…没现成的模板…正新建一个副本」——**agent 腔** ✗
      //    用户要的是：「**不要说任务文件夹里有什么东西**」⇒ facts 只说"她动手了"
      const hint = '你刚刚动手，这件事还在做（还没做完）。';
      voiceImpl('progress', hint, { task, gid, timeoutMs: 8000 })
        .then((line) => {
          if (!line) return;
          return taskSay(bot, gid, line);
        })
        .catch(() => {});
    },
  });
  // ⚠️ 登记 kill：`/任务撤回` 要能立刻把它（和它的子进程）停掉
  currentKill = kill;
  save();
  const runningRef = state.running;
  const timeoutMs = Math.max(30000, nz(cfg().timeoutMs, 180000));
  // ⚠️⚠️ 2026-10-13 修（实测：超时被杀的那次任务**在群里一声不响** ✗）：
  //    上一轮我把"我停了"从收尾里删掉（避免和 cancel 重复 ✓），可**超时**那条路
  //    **没有任何调用方替它说话** ⇒ 他干等了三分钟、群里一个字都没有 ✗✗
  //    ⇒ 记下"是谁把它停掉的"：`timeout` 要自己说一句，`cancel/替换` 由调用方说 ✓
  let killWhy = '';
  const timer = setTimeout(() => {
    log.warn(`[任务] 超时（${Math.round(timeoutMs / 1000)} 秒）→ 杀掉它`);
    killWhy = 'timeout';
    kill();
    // ⚠️ 2026-10-13 加**保险**：超时杀掉之后，万一 promise 因为别的原因没 resolve
    //    （实测过：kill 里误设 done，导致 promise 永不 resolve、running 永远不清 ✗），
    //    这里 5 秒后强制把这次收尾 —— **绝不能让"手上这个"卡住后面所有的活** ✓
    setTimeout(() => {
      if (state.running && state.running.startedAt === runningRef.startedAt) {
        log.warn('[任务] 收尾超时 → 强制清掉这次（不然之后的任务全被"手上这个还没弄完"挡住）');
        state.running = null;
        save();
      }
    }, 5000).unref?.();
  }, timeoutMs);
  // ⚠️⚠️ 2026-10-13 改（用户截图：「**确认语和她自己的聊天重复了**」）：
  //    开头那句已经说过"这就去写、写完发你"，15 秒再来一句"我正写着呢…写完就发你"
  //    就是**车轱辘话** ✗
  //    ⇒ ① 只在**真的跑久了**（≥60 秒）才报一次；
  //       ② 喂给她的事实里明说"别把刚说过的再重复一遍"（见 `voiceize` 的 progress 档）。
  const progressTimer = setTimeout(() => {
    try {
      if (!state.running || state.running.startedAt !== runningRef.startedAt) return;
      if (state.running.progressSent) return;
      state.running.progressSent = true;
      voiceImpl(
        'progress',
        '你已经动手有一会儿了（比平时久一点），活儿还在做、没卡住 —— **别把开头那句再重复一遍**。',
        { task, timeoutMs: 8000 },
      )
        .then((line) => {
          if (line) return taskSay(bot, gid, line);
        })
        .catch(() => {});
    } catch {}
  }, 60000);
  progressTimer.unref?.();

  let res;
  try {
    res = await promise;
  } catch (e) {
    res = { code: -1, stdout: '', stderr: e.message, killed: false };
  } finally {
    clearTimeout(timer);
    clearTimeout(progressTimer);
  }

  // ⚠️ 只有"还是我这一次"才清 running（撤回 / 新任务不会互相踩）
  if (state.running && state.running.startedAt === runningRef.startedAt) {
    state.running = null;
    save();
  }

  const cost = Math.round((Date.now() - runningRef.startedAt) / 1000);
  // ⚠️ 喂给她之前先抹掉路径（用户：「这一段说在哪里的也不要写出来」）
  const rawBody = hidePaths(redact(String(res.stdout ?? '').trim()), dir);
  // ⚠️⚠️ 2026-10-13：抠出 agent 留给机器人读的两行（`【要问】` / `【下一段】`）——
  //    那是"它缺信息 / 还有下一段"的信号，**不是给她说的话** ✓
  const { clean: body, ask, next } = parseAgentTail(rawBody);
  // ⚠️ 2026-10-13：把这个会话**补登记**进 GUI 的工作区列表（用户要求"能显示在这里"）
  if (res?.sessionId) {
    try {
      registerSession(res.sessionId);
    } catch {}
  }
  appendLedger(
    res.killed
      ? `**撤回**（${cost} 秒）：${clip(task, 60)}`
      : `**完工**（${cost} 秒，退出码 ${res.code}）：${body ? clip(body, 600) : '（没有输出）'}`,
  );
  log.info(`[任务] 结束：退出码 ${res.code}，${cost} 秒，输出 ${body.length} 字${res.killed ? '（被撤回）' : ''}`);
  // ⚠️⚠️ 2026-10-13（用户：「**插话不应该把任务停止了**」）：
  //    这轮跑完了 ⇒ 看看他中途补的要求排没排队；排了就**自动接着做**
  //    （「原任务 + 追加」、复用同一个任务文件夹，不用他再说一遍 ✓）
  const runQueued = async () => {
    try {
      const q = state.queuedExtra?.[gid];
      if (!q) return;
      delete state.queuedExtra[gid];
      save();
      const merged = `${q.task}（追加：${q.extra}）`;
      log.info(`[任务] 这轮完了 → 接着做他补的要求：${clip(q.extra, 50)}`);
      await taskSay(bot, gid, `${CONFIRM_PREFIX}${await startLine(merged, gid)}`);
      startRun({
        bot,
        gid,
        by: q.by,
        byName: q.byName,
        task: merged,
        related: q.related === true,
        reuseDir: q.dir,
      }).catch((e) => log.warn(`[任务] 接着做失败：${e.message}`));
    } catch {}
  };

  if (res.killed) {
    // ⚠️⚠️ 2026-10-13：**"谁停的谁说话"**
    //    · `timeout`（时间到了）⇒ 这条路由 startRun 自己说 —— 不然群里一声不响，
    //      他干等了整整三分钟还以为在跑 ✗
    //    · 撤回 / 插话叫停 / 被新任务顶掉 ⇒ **由调用方说**（`cancel()` 或顶掉那条），
    //      这里再说一遍群里就会出现两句 ✗
    if (killWhy === 'timeout') {
      const arts = collectArtifacts(dir);
      await taskSay(
        bot,
        gid,
        arts.length
          ? '时间到了，东西做出来一部分（下面发你），剩下的要接着弄的话再喊我'
          : '这次没弄完 —— 时间不够了。要么拆小一点再说一遍，要么我把时间放宽',
      ).catch(() => {});
      if (arts.length) await sendArtifacts(bot, gid, dir).catch(() => {});
    }
    log.info(`[任务] 这轮被停掉了（原因=${killWhy || '调用方'}）`);
    finishHist({ status: 'killed', cost, sessionId: String(res.sessionId ?? '') });
    await runQueued();
    return { ok: false, killed: true, cost };
  }

  // ⚠️⚠️⚠️ 2026-10-13 加（用户：「**多问一下任务细节，再由 saki 用自己的话发出来问我，
  //    我回了话再继续做**」）：agent 缺关键信息 ⇒ **不许猜**，把问题交出来 ⇒
  //    ① 让**她自己**把这个问题润色成一句人话（`voiceize('clarify')`）；
  //    ② 挂进 `state.clarify` —— 他下一句就是"补充"，两段拼起来接着做（老机制 ✓）；
  //    ③ 这轮就先到这儿（产物已经拿到的照发 ✓）。
  if (ask) {
    try {
      state.clarify = { gid, by: String(by), byName, task, askedAt: Date.now(), related: self };
      save();
    } catch {}
    const line = await voiceImpl('clarify', ask, { task, gid });
    await taskSay(bot, gid, `${CONFIRM_PREFIX}${line || ask}`);
    await sendArtifacts(bot, gid, dir).catch(() => {});
    log.info(`[任务] 它缺信息 → 让她自己问一句：${clip(ask, 60)}`);
    finishHist({ status: 'asking', cost, text: line || '', ask, sessionId: String(res.sessionId ?? '') });
    return { ok: true, cost, text: line, ask };
  }
  if (!body) {
    // ⚠️ 2026-10-13：**把 stderr 的关键几行写进日志** —— 失败时它是唯一的线索
    //    （实测过一次"0 秒退出码 1、输出为空"，没这行就只能干瞪眼。
    //      ⚠️ 别只取尾巴：真正的错误信息往往在**中间**，最后几行全是调用栈）
    const lines = String(res.stderr ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const errLine = lines.find((l) => /^Error|^[A-Za-z]*Error:/.test(l));
    const tail = [errLine, ...lines.slice(0, 4).filter((l) => l !== errLine)]
      .filter(Boolean)
      .join(' / ')
      .slice(0, 500);
    log.warn(`[任务] 没输出（退出码 ${res.code}）${tail ? `｜stderr：${tail}` : ''}`);
    // ⚠️ 2026-10-14 改：原来这句是「没弄出东西来（**退出码 3**）—— 要么它做不了，要么
    //    **工作区**里没这个活儿」—— 退出码和工作区都是**技术细节 + 暴露她那台电脑** ✗
    //    ⇒ 群里只说人话；退出码照旧写日志（上一行那个 warn 里有）✓
    await taskSay(bot, gid, '这次没弄成，我再想想别的办法（');
    // ⚠️ 话没说出来，但**东西可能已经做出来了** —— 那就把文件发过去（有才发）
    await sendArtifacts(bot, gid, dir).catch(() => {});
    finishHist({ status: 'failed', cost, sessionId: String(res.sessionId ?? '') });
    await runQueued();
    return { ok: false, cost };
  }
  const max = Math.max(200, nz(cfg().maxOutputChars, 1200));
  // ⚠️⚠️ 2026-10-13 加（用户：「多分几段工作」）：它说**还有下一段** ⇒
  //    ① 记下来（他说一句「继续」就接着做 ✓ 别让他重说一遍整个活）；
  //    ② 喂给她的事实时带上这句，让她自己顺口提一句"还有一段" ✓
  if (next) {
    try {
      if (!state.continues || typeof state.continues !== 'object') state.continues = {};
      state.continues[gid] = { task, next, dir, by: String(by), byName, related: self, at: Date.now() };
      save();
      log.info(`[任务] 它说还有下一段：${clip(next, 60)}`);
    } catch {}
  }
  const facts = next ? `${clip(body, max)}\n（另外还有下一段没做：${next}）` : clip(body, max);
  // ⚠️⚠️ 2026-10-13：**别把 agent 的报告原样贴进群**（用户截图说的）——
  //    先交给她自己的模型、用**第一人称**重写成一句人话（事实不动），失败才退回原文。
  const said = await voiceImpl('result', facts, { task, gid });
  await taskSay(bot, gid, said);
  // ⚠️⚠️ 2026-10-13：**产出的文件也发进群** —— 光说一句"做好了"没用，
  //    他要的是那份 pptx / 表格本身（用户要求）。上限与失败处理见 `sendArtifacts`。
  await sendArtifacts(bot, gid, dir).catch((e) => log.warn(`[任务] 发产物时出错：${e.message}`));
  // ⚠️ 结果那句已经由 `taskSay` 记进她的上下文了（2026-10-13 起统一走那个出口）——
  //    这里原来还有一条「（我刚在本机上干完一个活：…）」的重复记账，已经删掉 ✓
  finishHist({ cost, text: said, next, sessionId: String(res.sessionId ?? '') });
  // ⚠️ 2026-10-14：把这一轮**她做完说的那句**也记进"这个活的对话"——
  //    下一轮接着做（复用同一个文件夹）时它先读这个文件，就知道上一轮做到哪儿了 ✓
  if (dir) {
    try {
      appendFileSync(
        join(dir, '这个活的对话.md'),
        `\n**她做完说的**：${String(said ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim()}` +
          `${next ? `\n**她交代的下一段**：${String(next).replace(/\s*[\r\n]+\s*/g, ' ').trim()}` : ''}\n`,
        'utf8',
      );
    } catch (e) {
      log.debug(`[任务] 记「这个活的对话」（收尾）失败：${e.message}`);
    }
  }
  await runQueued();
  return { ok: true, cost, text: said };
}

/**
 * ⚠️⚠️⚠️ 2026-10-14 加（用户原话：「**以后重启不要断掉之前的任务，要自动恢复**」）。
 *
 * 重启会把正在跑的 agent 掐掉（子进程跟着 bot 走 ✗）。原来启动时是**直接把它清掉**，
 * 那个活就永远没了 —— 更糟的是她还会在群里自己编个理由（"我压根不知道从哪写起"那种 ✗）。
 *
 * ⇒ 现在：启动时把那件事记进 `state.resume`，等机器人连上之后**接着把它做完** ✓
 *   ⚠️ **复用同一个任务文件夹**（`reuseDir`）⇒ 它一开工就能读到 `这个活的对话.md`，
 *     知道上一轮跟他说过什么、做到哪儿了 ✓
 *   ⚠️ 由 `bot.js` 在**连上协议端之后**调（那一刻才有 bot 能往群里说话 ✓）
 *   ⚠️ 它只认"这一件"（`state.resume` 一次只存一个）—— 同时只跑一个活 ✓
 *
 * @param {object} bot
 * @returns {Promise<boolean>} 真的接着做了吗
 */
export async function resumePending(bot) {
  const r = state.resume;
  if (!r || !r.task) return false;
  if (!enabled()) {
    log.warn('[任务] 有一件被打断的活等着接着做，但 agent 现在是关着的 → 先留着');
    return false;
  }
  const gid = String(r.gid ?? '');
  if (!gid || typeof bot?.sendToGroup !== 'function') return false;
  state.resume = null;
  save();
  log.info(`[任务] 自动接着上次被打断的活：${clip(r.task, 60)}`);
  try {
    const line =
      (await voiceImpl('start', `这个活刚才被重启打断了，你现在接着做完（${clip(r.task, 60)}），用自己的话说一声。`, {
        task: String(r.task),
        gid,
        timeoutMs: 8000,
      }).catch(() => '')) || '刚断了一下，我接着弄';
    await taskSay(bot, gid, line);
  } catch (e) {
    log.debug(`[任务] 恢复时那句没说出去：${e.message}`);
  }
  startRun({
    bot,
    gid,
    by: String(r.by ?? ''),
    byName: String(r.byName ?? ''),
    task: String(r.task),
    related: r.related === true,
    reuseDir: String(r.dir ?? ''),
  }).catch((e) => log.warn(`[任务] 恢复失败：${e.message}`));
  return true;
}

/**
 * 撤回：把**正在跑**的那个杀掉；没有在跑的就把**还没批**的那件撤掉。
 *
 * ⚠️ `mark` = **两个空格前缀**（用户 2026-10-13：「插话成功之后的话开头也要加两个空格」）——
 *    「插话」让活停掉/重跑的那两条要有标记（和"确认开始"一个道理，群里一眼能分辨是任务动作）；
 *    ⚠️ 但**手打的 `/任务撤回`**不走它（那是他直接下的命令，不是插话）✓
 *
 * @param {string} gid
 * @param {object} bot
 * @param {{mark?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, what:string}>}
 */
export async function cancel(gid, bot, { mark = false } = {}) {
  const g = String(gid);
  const pre = mark ? CONFIRM_PREFIX : '';
  if (state.running && String(state.running.gid) === g) {
    const t = state.running;
    killCurrent();
    log.info(`[任务] 撤回：杀掉正在跑的（${clip(t.task, 40)}）`);
    if (bot) await taskSay(bot, g, `${pre}行，那个我停了（`);
    return { ok: true, what: 'running' };
  }
  if (state.pending && String(state.pending.gid) === g) {
    const p = state.pending;
    state.pending = null;
    save();
    log.info(`[任务] 撤回：撤掉还没批的那件（${clip(p.task, 40)}）`);
    if (bot) await taskSay(bot, g, `${pre}行，那件事我不接了（`);
    return { ok: true, what: 'pending' };
  }
  if (bot) await taskSay(bot, g, '这会儿没有在跑的任务');
  return { ok: false, what: '' };
}

/** 当前正在跑的那个的 kill（由 `startRun` 里注册） */
let currentKill = null;
function killCurrent() {
  try {
    currentKill?.();
  } catch {}
  currentKill = null;
}

/**
 * 主入口 —— `bot.js` 在**进聊天上下文之前**调它（和 `/剧情` / 撤回同一个位置）。
 *
 * @param {object} event OneBot 事件
 * @param {Array} segs 消息段
 * @param {object} bot Bot 实例（要有 `sendToGroup` / `call`）
 * @returns {Promise<boolean>} true = 这条已经处理完了（别再走正常聊天）
 */
export async function handle(event, segs, bot, opts = {}) {
  const out = await handleTask(event, segs, bot, opts);
  // ⚠️⚠️ 2026-10-13（用户：「掉线之后的补回不要回已经接过任务的话」）：
  //    只要这条**被任务桥接管过**（开工 / 反问 / 撤回 / 插话 / 被上限挡住…一律算），
  //    就记下它的 message_id ⇒ 补看（`catchUpMissed`）照着跳过，别再让她把派过的活答一遍 ✗
  if (out === true) rememberHandled(event?.message_id);
  return out;
}

/**
 * 主入口本体（外层的 `handle()` 只多做一件事：把接管过的消息 id 记下来）。
 *
 * @param {object} event OneBot 事件
 * @param {Array} segs 消息段
 * @param {object} bot Bot 实例（要有 `sendToGroup` / `call`）
 * @returns {Promise<boolean>} true = 这条已经处理完了（别再走正常聊天）
 */
async function handleTask(event, segs, bot, opts = {}) {
  if (!enabled()) return false;
  const gid = String(event?.group_id ?? '');
  if (!gid) return false;
  const { extractText, toSegments, stripLeadingAt } = await import('./message.js');
  const segments = segs ?? (() => {
    try {
      return toSegments(event.message);
    } catch {
      return [];
    }
  })();
  const raw = String((() => {
    try {
      return extractText(segments);
    } catch {
      return '';
    }
  })() ?? '').trim();
  if (!raw) return false;
  // ⚠️⚠️ 2026-10-13（**第二次漏判**，用户截图：她又是只当闲聊答了两句）：
  //    他发的其实是「@saki酱saki酱saki酱 做一个丰川祥子的简历」，而事件里是
  //    `at=0 atMe=false 段=text` —— **协议端把 @ 退化成纯文本了**（日志原文就这样）。
  //    ⇒ 文本以 `@` 开头 ⇒ 祈使句那条规则也认不出来 ✗
  //    ⇒ **"这句话的内容是什么"一律用剥过 @ 的 `clean`**（判断"@ 的是谁"才用原文本 ——
  //       `message.js` 的 `stripLeadingAt` 注释里写得很清楚）
  const clean = stripLeadingAt(raw).trim() || raw;
  const atText = clean !== raw; // 文本形态的 @（前缀里 @ 了谁）

  // ⚠️⚠️⚠️ 2026-10-13（用户截图：他 **@Anon** 说「做个你自己的简历」，**saki 抢答了** ✗
  //    还把它当成"给自己整一份简历"）：**@ 的是别人 ⇒ 这条不是给她的 ⇒ 一律不碰**
  //    （不开工、不插话、不记任务账）。
  //
  //    ⚠️ 判法要两头都稳（第一版拿 `bot.atCalledInText` 判"是不是她"，结果把
  //      「@saki酱saki酱saki酱 做个简历」也当成"叫别人"给挡了 ✗✗ ——
  //      那个群名片压根不在名字表里）：
  //      ① **明确指她**（at 段指她 / 正文 @token 匹配她的号码或任一叫法）⇒ 是给她的 ✓
  //      ② **明确指别人**（at 段指别人 / 正文 @token 匹配同类池里别人的号码或叫法）⇒ 不碰 ✗
  //      ③ **两头都认不出** ⇒ **放过**（宁可按老规矩处理，也不能因为判不了就把她的活挡掉）✓
  let atMeSeg = false;
  let atOtherSeg = false;
  for (const s of segments) {
    if (s?.type !== 'at') continue;
    const qq = String(s?.data?.qq ?? '');
    if (!qq || qq === 'all') continue; // @全体不算"叫她"
    if (qq === String(bot?.selfId ?? '')) atMeSeg = true;
    else atOtherSeg = true;
  }
  const atTok = (() => {
    const m = /^\s*@\s*([^\s@]{1,40})/.exec(raw);
    return m ? m[1].toLowerCase() : '';
  })();
  let myKeys = [];
  try {
    const p = await import('./persona.js');
    myKeys = [
      String(bot?.selfId ?? ''),
      p.charName?.(),
      p.selfName?.(),
      p.shortName?.(),
      ...(p.selfNames?.() ?? []),
      ...(p.callNames?.() ?? []),
      ...(p.nicknames?.() ?? []),
    ]
      .map((s) => String(s ?? '').toLowerCase().trim())
      .filter((s) => s.length >= 2);
  } catch {
    /* 读不到人设名字就只剩号码那条判据 */
  }
  const tokMine = !!atTok && myKeys.some((k) => atTok === k || atTok.includes(k));
  let tokOther = false;
  if (atTok && !tokMine) {
    try {
      for (const t of bot?.atTargetsOf?.(gid) ?? []) {
        if (String(t?.uid ?? '') === String(bot?.selfId ?? '')) continue;
        for (const k of t?.keys ?? []) {
          const kk = String(k ?? '').toLowerCase().trim();
          if (kk.length >= 2 && (atTok === kk || atTok.includes(kk))) {
            tokOther = true;
            break;
          }
        }
        if (tokOther) break;
      }
    } catch {
      /* 拿不到同类池就当认不出 */
    }
  }
  const forHer = atMeSeg || tokMine;
  if (!forHer && (atOtherSeg || tokOther)) {
    log.info(`[任务] 这条 @ 的是别人（at 段=${atOtherSeg}／正文=${tokOther}）→ 任务桥不碰`);
    return false;
  }

  const uid = String(event?.user_id ?? '');
  const byName = String(event?.sender?.card || event?.sender?.nickname || uid);
  const isOwner = uid === ownerId() && !!ownerId();

  // ⚠️⚠️⚠️ 2026-10-13（用户：「**接任务还是要严格一点，必须要 @ 她才能接任务**」）：
  //    默认只认**明确 @ 了她**（at 段指她 / 正文那个 @ 命中她的任一叫法）；
  //    "引用她那条消息"也算 —— 那本来就是冲她说的 ✓
  //    ⚠️ 例外照旧放行（它们本来就不该带 @）：
  //      · 斜杠指令（`/任务撤回`）；
  //      · 他**补的那一句**（她刚反问过，`state.clarify` 里挂着）；
  //      · 主人回「同意 / 不行」（挂在待批的那件事上，`state.pending`）。
  //    ⚠️ 配置 `agent.requireAt: false` 可以退回老行为（不带 @ 也算派活）。
  if (cfg().requireAt !== false) {
    const isCmd = /^[/／]/.test(clean);
    const inClarify = !!state.clarify && String(state.clarify.gid) === gid;
    const inPending = !!state.pending && String(state.pending.gid) === gid && isOwner;
    const atReply = segments.some((s) => s?.type === 'reply');
    // ⚠️ 「继续」也算例外（那是接上一段的工作，本来就不该带 @ ✓）
    const inContinue =
      !!(state.continues && state.continues[gid]) && /^(继续|接着|接着弄|继续吧|继续做|接着做|go|continue)$/i.test(clean.trim());
    if (!forHer && !atReply && !isCmd && !inClarify && !inPending && !inContinue) {
      log.debug(`[任务] 没 @ 她（也没引用她）⇒ 任务桥不接：${clip(clean, 40)}`);
      return false;
    }
  }

  // ① `/任务撤回`（唯一的斜杠指令；**先于**其它判定，别让它掉进任务判定）
  if (/^[/／]\s*任务撤回\s*$/.test(clean)) {
    await cancel(gid, bot);
    return true;
  }

  // ①.七 ⚠️⚠️ 2026-10-13（用户原话：「再加一个模型，判断群消息是否要**对 agent 插话**，
  //    **只有那个让她做任务的人**能对 agent 插话」）：
  //    活正在跑的时候，群里那句「再加一页」「别写了」要能**影响 agent**；普通聊天一个字都别动它。
  //    ⚠️ 判定归判定、权限归权限：**判定说"在改/在停"之后，还要看说话人是不是发起者**。
  if (state.running && String(state.running.gid) === gid && looksLikeInterject(clean, segments, bot)) {
    const r = state.running;
    const act = await interjectImpl(clean, r.task, opts);
    if (act === 'ask') {
      const line = await voiceImpl('progress', '他在催/问进度：回一句还在做、快好了（别展开）。', {
        task: r.task,
        gid,
        timeoutMs: 8000,
      }).catch(() => '');
      await taskSay(bot, gid, line || `还在弄「${clip(r.task, 20)}」，好了就发你`);
      return true;
    }
    if (act === 'change' || act === 'stop') {
      if (uid !== String(r.by)) {
        // ⚠️ **只有发起者能插话** —— 别人说的不动任务，落下去走正常聊天（她照常回应）
        log.info(`[任务] ${byName} 说的像是在${act === 'stop' ? '叫停' : '改要求'}，但不是发起者 → 不理会（活照跑）`);
      } else if (act === 'stop') {
        // ⚠️ 插话让它停 —— 这两条要带**两个空格**（用户要求：插话成功之后的话也要有那个标记）
        await cancel(gid, bot, { mark: true });
        return true;
      } else {
        // ⚠️⚠️⚠️ 2026-10-13 最终定（用户两句话合起来看）：
        //    ① 「插话不应该把任务停止了」 ⇒ **话术上不许出现"我停了"** ✗
        //    ② 「和这里的 ctrl+enter 行为一样」 ⇒ **必须立刻带上新要求接着做**（不能等这轮跑完）✗
        //
        //    ⚠️ 硬限制：我们跑的是 **headless（一次性进程，跑完就退）** ——
        //      **没法像 Ctrl+Enter 那样往正在跑的会话里塞话** ✗（那条路要 GUI/SDK 的会话通道，
        //      而 SDK 那条实测连工具都没有 ✗）。
        //    ⇒ 能同时满足 ①② 的只有一种做法：**悄悄把这轮收掉、立刻带上新要求重跑** ✓
        //      · 话术是「行，我加上」——**不说停、不说重做** ✓
        //      · 产物和任务文件夹都复用 ✓（新一轮接着用同一个）
        //      · 代价：那一轮白跑（已经花掉的模型钱收不回来）—— 但"立刻"是他要的 ✓
        const merged = `${r.task}（追加：${clip(clean, 120)}）`;
        const dir = String(r.dir ?? '');
        const by = r.by;
        const byName2 = r.byName;
        const related = r.related === true;
        log.info(`[任务] 发起者插话加要求 → 立刻收掉这轮、带上新要求重跑：${clip(clean, 60)}`);
        // ⚠️ 不走 `cancel()`：那条会发一句「行，那个我停了」✗（用户明确不要这个）
        killCurrent();
        state.running = null;
        if (state.queuedExtra) delete state.queuedExtra[gid];
        save();
        const line = await voiceImpl(
          'progress',
          `他趁你正弄的时候补了一句要求：「${clip(clean, 60)}」。回一句"行，我加上"就行 —— ⚠️ 别说你停了、也别说要重做，就当是接着弄。`,
          { task: r.task, gid, timeoutMs: 8000 },
        ).catch(() => '');
        await taskSay(bot, gid, `${CONFIRM_PREFIX}${line || `行，我加上：${clip(clean, 40)}`}`);
        startRun({ bot, gid, by, byName: byName2, task: merged, related, reuseDir: dir }).catch((e) =>
          log.warn(`[任务] 带上新要求重跑失败：${e.message}`),
        );
        return true;
      }
    }
  }

  // ①.六 ⚠️⚠️ 2026-10-13（用户：「**多分几段工作**」）：
  //    他回一句「继续 / 接着做」⇒ 把 agent 说的**下一段**接着做（同一个任务文件夹 ✓）
  //    —— 不用把整个活重说一遍，也不会因为一段没跑完就丢掉剩下的 ✗
  {
    const c = state.continues?.[gid];
    const yes = /^(继续|接着|接着弄|继续吧|继续做|接着做|继续弄|go|continue)$/i.test(clean.trim());
    if (c && yes && (uid === String(c.by) || isOwner)) {
      state.continues[gid] = null;
      save();
      const merged = `${c.task}（接着做：${c.next}）`;
      await taskSay(bot, gid, `${CONFIRM_PREFIX}${await startLine(merged, gid)}`);
      startRun({
        bot,
        gid,
        by: c.by,
        byName: c.byName,
        task: merged,
        related: c.related === true,
        reuseDir: c.dir,
      }).catch((e) => log.warn(`[任务] 接着做失败：${e.message}`));
      log.info(`[任务] 他说继续 → 接着做下一段：${clip(c.next, 50)}`);
      return true;
    }
  }

  // ①.五 ⚠️ 2026-10-13：他**补了一句**（我刚才反问过）⇒ 两段拼起来直接开工，不再来回问
  if (state.clarify && String(state.clarify.gid) === gid && (uid === String(state.clarify.by) || isOwner)) {
    const c = state.clarify;
    const ttl = Math.max(60000, nz(cfg().clarifyTtlMs, 600000));
    if (Date.now() - c.askedAt <= ttl && !/^(算了|不用了|cancel|取消)$/.test(clean)) {
      state.clarify = null;
      save();
      const merged = `${c.task}（补充：${clip(clean, 120)}）`;
      await taskSay(bot, gid, `${CONFIRM_PREFIX}${await startLine(merged, gid)}`);
      startRun({ bot, gid, by: c.by, byName: c.byName, task: merged, related: c.related === true }).catch((e) =>
        log.warn(`[任务] 跑失败：${e.message}`),
      );
      return true;
    }
    state.clarify = null;
    save();
  }

  // ② 主人回「同意 / 不行」→ 处理挂着的那件
  if (isOwner && state.pending && String(state.pending.gid) === gid) {
    const it = normIntent(await judgeImpl(clean, opts));
    if (it.action === 'approve') {
      const p = state.pending;
      state.pending = null;
      save();
      await taskSay(bot, gid, `${CONFIRM_PREFIX}${await startLine(p.task, gid)}`);
      startRun({ bot, gid, by: p.by, byName: p.byName, task: p.task, related: p.related === true }).catch((e) =>
        log.warn(`[任务] 跑失败：${e.message}`),
      );
      return true;
    }
    if (it.action === 'reject') {
      state.pending = null;
      save();
      await taskSay(bot, gid, '行，那件事我不接了（');
      return true;
    }
  }
  // ⚠️ 别人说"同意"**不算**（只有主人能批）—— 这里直接落下去走正常聊天

  // ③.五 ⚠️⚠️⚠️ 2026-10-13（用户：「**如果她自己答不上来的时候，直接去对话再问一遍**」
  //    ＋「**要用模型判定**」）：
  //    他问的是**刚做完那个活**的具体问题、而她答不上来 ⇒ 把问题**转给 agent 再问一遍**
  //    （复用同一个任务文件夹；明说"只回答这个追问、别重做"）。
  //
  //    ⚠️⚠️ **位置**：放在"派活快判"**之前**（否则「这个 py 文件怎么用」根本不像派活，
  //       会被 `looksLikeTask` 直接挡掉、走不到这里 ✗），但又**在插话/撤回/补充/同意之后** ✓
  //       —— 不抢那几条路靠的是：插话那条要求"手上正有活在跑"、而这里要求"手头没活在跑" ✓ 互斥 ✓
  //    ⚠️ 判定**完全交给模型**（不做关键词快筛 —— 用户明确要求 ✓）；
  //       再加"有最近做完的活 + 60 秒冷却"（不然同一句话会来回问 agent，真花钱）。
  {
    const lastDone = recentDoneTask();
    const atReplySeg = segments.some((s) => s?.type === 'reply');
    if (
      lastDone &&
      !state.running &&
      (forHer || atReplySeg) &&
      Date.now() - Number(state.lastAskAgentAt ?? 0) > 60000
    ) {
      const j = await askAgentImpl(clean, lastDone.task, opts);
      if (j.action === 'ask') {
        state.lastAskAgentAt = Date.now();
        save();
        await taskSay(bot, gid, `${CONFIRM_PREFIX}我翻回去看看`);
        startRun({
          bot,
          gid,
          by: uid,
          byName,
          task: `${lastDone.task}（他现在的追问：${clip(j.question, 150)}。⚠️ **只回答这个追问**，别把整个活重做一遍；以前做出来的东西照旧能用）`,
          related: lastDone.related === true,
          reuseDir: String(lastDone.dir ?? ''),
        }).catch((e) => log.warn(`[任务] 追问转发失败：${e.message}`));
        log.info(`[任务] 他问的是刚做完那个活 ⇒ 转给 agent 再问一遍：${clip(clean, 50)}`);
        return true;
      }
    }
  }

  // ③.六 ⚠️⚠️⚠️ 2026-10-14（用户原话：「**直接把 agent 设定为 saki 自己的电脑**，
  //    由**她自己决定**什么时候该用电脑、该去读那一段对话或者**直接发送消息到对话**」）：
  //    **她自己的判断** —— 有人跟她说话，而这句话"光靠聊天答不好、得动那台电脑"⇒
  //    她自己上手（起 agent），并**用她自己的口气**先说一声（"我去翻一下"）✓
  //
  //    ⚠️ 位置：在 ③（派活）**之前**，但**只在"这句不像派活"时**才判：
  //      派活那条路（@她 + 说得像让干活）照旧走他那套（要确认、要 @ 她 ✓ 规矩一个字不改 ✓）。
  //    ⚠️ 触发面收紧（每轮对所有群消息判会太贵）：
  //      · 只在她**被点名 / 被回复**时判；
  //      · 手头**没活在跑**时才判（省得不抢插话那条路 ✓）；
  //      · `selfUseCooldownMs`（默认 90 秒）内最多一次 ✓
  //    ⚠️ 开关：`agent.selfUse: false` 整条关掉（退回"只有他派活才动电脑"）✓
  // ⚠️⚠️⚠️ 2026-10-14 修（真实事故：他 @她「继续完善昨天的ppt」，她认出来了 ✓ 他也回了
  //    「继续」—— 结果她**当闲聊答了一句**「行，接着来」，**根本没开工** ✗）：
  //    `state.continues`（她交代的"下一段"＝"回一句继续就接着做"）那条分支原来排在
  //    **③ 派活快判之后** ⇒ 而「继续」两个字**不像派活** ⇒ 被那行提前挡掉、直接交回聊天 ✗
  //    ⇒ 这里先把判据算出来，给下面两处用：③.六 不许抢它，③ 的早退要放过它 ✓
  const inContinueTask =
    !!(state.continues && state.continues[gid]) &&
    /^(继续|接着|接着弄|继续吧|继续做|接着做|go|continue)$/i.test(clean.trim());
  if (cfg().selfUse !== false && !state.running && !inContinueTask) {
    const atReplySeg2 = segments.some((s) => s?.type === 'reply');
    const coolMs = Math.max(10000, nz(cfg().selfUseCooldownMs, 90000));
    const quiet = Date.now() - Number(state.lastSelfUseAt ?? 0) > coolMs;
    // ⚠️⚠️⚠️ 2026-10-15 改（用户：「**在群聊没被 @ 就不能开工**」）——
    //    原来这里放行两种：`forHer`（@ 了她）**和 `atReplySeg2`（消息里有个引用段）**。
    //    而 `atReplySeg2` **不看引用的是谁** —— 群里任何人引用任何一条东西都算 ✗
    //    **真实事故**（2026-10-15 18:12）：另一个机器人在群里引用了一条消息说话 ⇒
    //      她「**她自己决定用电脑**」⇒ 当场开工，还反复跑了好几轮 ✗
    //    ⇒ 现在**群里只认 @ 了她**（引用不算、"@ 别人"更不算——那在外面就挡了）；
    //      私聊照旧（那边 `forHer || 引用` 都是"在跟她说话"）✓
    const selfUseOk =
      event?.message_type === 'group' ? forHer : forHer || atReplySeg2;
    if (selfUseOk && quiet && !looksLikeTask(clean, { atMe: forHer })) {
      const su = await selfUseImpl(clean, opts);
      if (su.action === 'use') {
        state.lastSelfUseAt = Date.now();
        save();
        const plan = String(su.plan || '').slice(0, 120) || clip(clean, 60);
        // ⚠️ 这一句**不带两个空格** —— 那个前缀是"他派活、我确认"的标记；
        //    这次是她**自己决定**动手的，用她自己的口气说一句就好 ✓
        const line =
          (await voiceImpl('start', `你自己决定去动电脑（${plan}），用你自己的话说一声。`, {
            task: plan,
            gid,
            timeoutMs: 8000,
          }).catch(() => '')) || '我去看看';
        await taskSay(bot, gid, line);
        startRun({
          bot,
          gid,
          by: uid,
          byName,
          task: `${plan}\n（他刚才说的是：「${clip(clean, 150)}」）`,
          related: false,
          spontaneous: true,
        }).catch((e) => log.warn(`[任务] 她自己动手失败：${e.message}`));
        log.info(`[任务] **她自己决定用电脑**（因为 ${byName} 说了「${clip(clean, 40)}」）→ ${clip(plan, 60)}`);
        return true;
      }
    }
  }

  // ③ 有人让她干活
  //    ⚠️ 2026-10-13：「**@了她**」本身是很强的信号（群里 @她 又带着"做/写/查"就是派活）——
  //       用户那句话「做一个丰川祥子的简历」就是 @她 时说的，早先漏判过。
  //       ⚠️ 而"@ 的是别人"已经在上面那道闸挡掉了 ⇒ 这里只认**确实叫了她**（at 段或文本形态都行）✓
  // ⚠️⚠️ 2026-10-14 修：`&& !inContinueTask` —— 「继续」那条路（`state.continues`）
  //    在这行**后面**，而它不像派活、会被这行提前挡掉 ⇒ 必须放它过去（见上面那段说明）
  if (!looksLikeTask(clean, { atMe: forHer }) && !inContinueTask) return false; // 快判没过 ⇒ 连模型都不问
  const it = normIntent(await judgeImpl(clean, opts));

  // ⚠️⚠️ 2026-10-13（用户要求："saki 还能反问我给的描述不够清晰之类的"）：
  //    她觉得这话**没说清** ⇒ **先反问一句**（不带两个空格），不硬做；
  //    他补一句之后（`state.clarify`）把两段拼起来直接开工，不再来回问。
  if (it.action === 'ask') {
    const q = it.question || '你想让我做成什么样？说细一点我这就去';
    state.clarify = { gid, by: uid, byName, task: clean, askedAt: Date.now(), related: it.related === true };
    save();
    await taskSay(bot, gid, q);
    log.info(`[任务] 觉得没说清 → 反问一句（${clip(clean, 40)}）：${q}`);
    return true;
  }
  if (it.action !== 'task') return false;

  // ⚠️⚠️⚠️ 2026-10-13 用户：「**前一个没搞完可以直接开新对话**」
  //    ⇒ 不再拿「手上这个还没弄完，等会儿再说」把他挡回去 ✗
  //      —— **自动把旧的停掉，直接开新的** ✓（旧的那轮产物已经落盘的照旧留着）
  if (state.running) {
    log.info(`[任务] 手上有活没完（${clip(state.running.task, 40)}），但他说要开新的 → 先把旧的停掉`);
    killCurrent();
    state.running = null;
    save();
    // ⚠️ 给一句提示就好（**带两个空格** —— 这是任务动作，群里一眼能分辨）；不是"挡回去"✓
    await taskSay(bot, gid, `${CONFIRM_PREFIX}行，那个先放一放（`);
  }
  // ⚠️ 2026-10-13：`maxPerDay: 0` = **不限次数**（用户要求「直接取消限制」）——
  //    兜底只剩上面那条"同时只跑一个"（真花钱，不设次数上限了就靠它）
  const perDay = nz(cfg().maxPerDay, 3);
  if (perDay > 0 && todayCount() >= perDay) {
    await taskSay(bot, gid, '今天弄的活儿够多了，明天再说（');
    return true;
  }
  if (!workspace()) {
    log.warn('[任务] 没配工作区（`agent.workspace`）→ 不跑');
    await taskSay(bot, gid, '我这边没配好工作的地方（');
    return true;
  }
  if (!existsSync(workspace())) {
    log.warn(`[任务] 工作区不存在：${workspace()}`);
    await taskSay(bot, gid, '那个目录我这边找不到（');
    return true;
  }

  // 主人（或额外放行的人）→ 直接开；别人 → 先问主人
  if (isOwner || extraAllowed(uid)) {
    await taskSay(bot, gid, `${CONFIRM_PREFIX}${await startLine(clean, gid)}`);
    registerKill();
    startRun({ bot, gid, by: uid, byName, task: clean, related: it.related === true }).catch((e) =>
      log.warn(`[任务] 跑失败：${e.message}`),
    );
    return true;
  }

  // ⚠️ **@主人**问一句（自然语言）；主人回「同意」才开。⚠️ 这条**不带两个空格** ✓
  state.pending = {
    gid,
    by: uid,
    byName,
    task: clean,
    askedAt: Date.now(),
    related: it.related === true,
  };
  save();
  const ask = `@${byName} 说想让我${clip(clean, 40)} —— 要我弄吗？回「同意」我就去`;
  await taskSay(bot, gid, ask, { at: ownerId(), atName: '<主人>' });
  log.info(`[任务] ${byName} 让干活，已在群里问主人（${clip(clean, 40)}）`);
  return true;
}

/**
 * ⚠️⚠️ 2026-10-13 加（用户原话：「再加一个模型，判断群消息是否要**对 agent 插话**，
 *    **只有那个让她做任务的人**能对 agent 插话」）。
 *
 * 背景：活正在跑的时候，群里照旧有人在说话。那些话里有一部分是**冲着这个活来的**
 *   （「再加一页」「那个别写了」「弄好了没」），其余是普通聊天 ✗ 前者要能**影响 agent**，
 *   后者一个字都不该动它。
 *
 * ⇒ 一次轻判定（非流式、只回一个词），四种结果：
 *   · `change` —— 在**改要求 / 加东西**（"再多写一页""名字换成 XX"）→ 停掉重跑（合并新话）；
 *   · `stop`   —— 在**叫停**（"别写了""算了不用了"）→ 停掉；
 *   · `ask`    —— 在**催 / 问进度**（"好了没"）→ 只回一句话，**不动**任务；
 *   · `''`     —— 跟这个活无关（普通聊天）→ 落回去走正常聊天。
 *
 * ⚠️ **只有发起者能插话**那条闸在 `handle()` 里（判定归判定，权限归权限 —— 两件事分开）。
 * ⚠️ 判定不出来一律当 `''`（宁可漏一次插话，也不能让群里随便一句话把她的活搅乱）。
 *
 * @param {string} text 群里这条消息
 * @param {string} task 正在跑的那个任务（给她当上下文）
 * @returns {Promise<'change'|'stop'|'ask'|''>}
 */
export async function judgeInterject(text, task, opts = {}) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  const ask = typeof opts.phrase === 'function' ? opts.phrase : null;
  const system = [
    '【插话判定】机器人这会儿**正用本机在干一件活**，群里有人在说话。',
    `它手上那个活是：「${String(task ?? '').slice(0, 120)}」`,
    '',
    '判断**这句话是不是冲着那个活来的**，四种之一：',
    '· 在**改要求 / 加东西 / 换做法** → 回答：改',
    '· 在**叫停**（别写了、算了、不用了、停） → 回答：停',
    '· 在**催 / 问进度**（好了没、弄完了吗、怎么样了） → 回答：催',
    '· 都**不是**（普通聊天、聊别的、跟这个活无关） → 回答：无',
    '',
    '⚠️ 只有**明确在说这个活**才算；只是提到相关词、或者顺口聊到 → 一律「无」。',
    '⚠️ 只回答一个字：改、停、催、无。不要解释、不要标点。',
  ].join('\n');
  const user = `这句话：「${t.slice(0, 200)}」`;
  let raw = '';
  try {
    if (ask) raw = await ask({ system, user });
    else {
      const { phrase } = await import('./llm.js');
      raw = await phrase({ system, user, maxTokens: 40, timeoutMs: 8000 });
    }
  } catch (e) {
    log.debug(`[任务] 插话判定失败（当"无关"）：${e.message}`);
    return '';
  }
  const a = String(raw ?? '').trim();
  if (/^(改|修改|加)/.test(a)) return 'change';
  if (/^(停|别|取消|不用)/.test(a)) return 'stop';
  if (/^(催|问|进度)/.test(a)) return 'ask';
  return '';
}

/**
 * 插话的**快筛**（省一次模型调用）。
 *
 * ⚠️ 任务跑着的时候群里每条消息都判一次模型**太贵**（任务一分钟里群里能刷十几条）⇒
 *    只有"像是冲着这个活来的"才往下走：
 *   · 带 `/` 的指令（撤回之类）→ **不走这里**（有条专门的路）；
 *   · **@ 了她 / 引用了她的消息** → 判；
 *   · 或者句子里带"活/任务/做完/好了没/别写/改/加/继续/停"这类词 → 判；
 *   · 其余（纯闲聊）→ 直接放过（照旧正常聊天）。
 */
export function looksLikeInterject(text, segments = null, bot = null) {
  const t = String(text ?? '').trim();
  if (!t || t.length < 2) return false;
  if (/^[/／]/.test(t)) return false; // 指令走别的路
  const me = String(bot?.selfId ?? '');
  const segs = Array.isArray(segments) ? segments : [];
  if (me && segs.some((s) => (s?.type === 'at' && String(s?.data?.qq ?? '') === me) || s?.type === 'reply')) return true;
  return /(做完|弄完|写完了|好了没|好了吗|好没好|怎么样了|进度|那个活|这个活|任务|别写|别弄|别做|不用了|算了|改成|换成|再加|再多|再写|加上|补上|重做|重来|继续|停一下|停下)/.test(
    t,
  );
}

/**
 * 顺手把"当前运行的 kill"登记进来（`defaultRunner` 每次新建，所以在这里挂钩） */
function registerKill() {
  // `startRun` 里拿到 {kill} 之后会覆盖它 —— 这里只是保证 cancel() 有东西可调
  currentKill = null;
}

export const files = () => ({ state: FILE });
