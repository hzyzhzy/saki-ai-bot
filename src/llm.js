import { config } from './config.js';
import { log } from './log.js';
import * as spend from './spend.js';
// ⚠️ 2026-09-21：人设文案从 `personas/<id>/identity.json` 来（见 src/persona.js）。
//    这里原来写死「Saki（丰川祥子）」—— 换人设时它不会跟着变，等于换了个名字还在演小祥。
import * as persona from './persona.js';
// ⚠️⚠️ 2026-10-09 加 `fetch as undiciFetch`（用户报：「**刚才又拉取失败了**」，时通时不通）：
//    这里是**独立的 `undici` 包**（package.json 里 ^8.10.2），而发请求用的却是
//    **Node 内置的全局 `fetch`** —— 两者的 `dispatcher` **不是同一套** ✗
//    ⇒ 把外部 undici 造的 `ProxyAgent` 塞给内置 fetch ⇒ `UND_ERR_INVALID_ARG`
//      ⇒ **"走代理"这一路从来没真正生效过**，只有直连偶尔成功 ⇒ 表现就是时通时不通 ✗
//    ⇒ 而且 `setGlobalDispatcher()`（applyEgress 的出口切换）改的也是 **undici 的**全局，
//      内置 fetch 根本不看它 ⇒ 那个"自动切换出口"一直是个假动作 ✗
//    ⇒ 统一成 undici 自己的 fetch（agent / dispatcher / 全局设置全都同源 ✓）
import { Agent, ProxyAgent, setGlobalDispatcher, fetch as undiciFetch } from 'undici';
import net from 'node:net';

// ⚠️⚠️ 2026-09-16 深夜：**运行中自动切换网络出口**（用户要求：
//    「要能自动切换网络，比如关掉代理」）。
//
//    背景：那晚机器人整晚不能聊天 —— `_run-bot.bat` 写死走本地代理 127.0.0.1:7890，
//    而代理软件关着 → 每个模型请求 ECONNREFUSED。
//    bat 那边已经能在**启动时**自动选（探端口）；这里再补**运行中**的：
//      · 先用当前出口发请求
//      · 网络类失败（ECONNREFUSED / fetch failed / 超时…）→ **换另一种出口重试一次**
//        （走代理挂了就改直连；直连不通就试代理）—— 不用重启机器人
//      · 记住这次哪种通了，之后的请求优先用它
//
//    ⚠️ 只在**网络类**错误时切换；402/401/风控这些业务错误原样抛（那是另一套处理）。
const PROXY_URL = process.env.QQBOT_PROXY || 'http://127.0.0.1:7890';
let egress = 'unknown'; // 'direct' | 'proxy' | 'unknown'
let proxyAgent = null;
let directAgent = null; // ⚠️ 选直连时装到全局，把启动期的 env-proxy 顶掉
let probedAt = 0;
let proxyOk = false;

/** 代理端口通不通（缓存 60 秒；`force` 时立刻重探） */
async function proxyAlive(force = false) {
  if (!force && Date.now() - probedAt < 60000) return proxyOk;
  probedAt = Date.now();
  let u;
  try {
    u = new URL(PROXY_URL);
  } catch {
    proxyOk = false;
    return false;
  }
  proxyOk = await new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(400, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
  return proxyOk;
}

const isNetErr = (e) =>
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timeout|aborted/i.test(
    `${e?.message ?? ''} ${e?.cause?.code ?? ''}`,
  );

/** ⚠️ 这个地址是不是**本机**（本机服务绝不许走代理） */
const isLocalUrl = (u) => {
  try {
    const h = new URL(String(u)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
  } catch {
    return false;
  }
};

/**
 * ⚠️⚠️ 2026-10-22 加（用户：「**可以只冷启动一次吗，把状态保持住**」）：
 *    `new Agent()` 用的是 undici **默认参数** —— `keepAliveTimeout` 只有 **4 秒**：
 *    空闲 4 秒就把 TCP/TLS 连接断掉 ⇒ 群里两条消息之间通常隔十几秒
 *    ⇒ **每条消息都在重新建连**（TLS 握手 + 代理握手），实测首字 1.4 秒 vs 热了之后 0.2 秒 ✗
 *    ⇒ 把空闲保持时间抬到 **5 分钟**：一条线连着聊的时候，连接一直是热的 ✓
 *    （`keepAliveMaxTimeout` 是"服务端 Keep-Alive 头允许的上限"，也一起抬，
 *      不然服务端只给 60 秒的话我们想保也保不住。）
 */
const AGENT_OPTS = {
  keepAliveTimeout: 5 * 60 * 1000, // 空闲 5 分钟才断
  keepAliveMaxTimeout: 30 * 60 * 1000, // 服务端允许的上限也抬
  connections: 32,
};

/** 用指定出口发一次请求 */
function rawFetch(url, opts, mode) {
  // ⚠️⚠️ 2026-10-17 修（真 bug：**回归里 12 个套件全挂**）——
  //    **本机地址一律直连**，不管出口选的是代理还是直连 ✗
  //
  //    现场：套件跑的是"假模型"，地址 `http://127.0.0.1:39xxx/v1` ——
  //    而 `applyEgress()` 探到 7890 在听（Clash 常驻）⇒ 把**全局 dispatcher**
  //    换成了 `ProxyAgent` ⇒ 连**打本机假模型**的请求也丢给代理 ⇒ 打不到 ✗
  //    ⇒ 机器人回的是兜底句「刚卡了一下，你再说一遍行吗」⇒ 12 套全红 ✗
  //
  //    ⚠️ `_run-bot.bat` 里那个 `NO_PROXY=127.0.0.1` 管的是 **Node 自己的
  //      EnvHttpProxyAgent**，管不着这里手装的 `ProxyAgent` ✗（两套东西）
  //    ⚠️ 生产也受益：`baseURL` 配成**本机中转站**的人，以前会被代理砸掉 ✗
  if (isLocalUrl(url)) {
    directAgent ??= new Agent(AGENT_OPTS);
    return undiciFetch(url, { ...opts, dispatcher: directAgent });
  }
  if (mode === 'proxy') {
    proxyAgent ??= new ProxyAgent({ uri: PROXY_URL, ...AGENT_OPTS });
    return undiciFetch(url, { ...opts, dispatcher: proxyAgent });
  }
  // ⚠️ 2026-10-09：直连也走 undici 的 fetch —— 理由见文件顶部那个 import 的注释
  //    （内置 fetch 不认 undici 的 dispatcher，也不看 setGlobalDispatcher ✗）
  return undiciFetch(url, opts);
}

/**
 * 把出口**同时**应用到"自己这条链"和**全局**。
 *
 * ⚠️⚠️ 2026-09-23 修（用户：「要能自动识别并切换」）。
 *
 * 背景：`_run-bot.bat` 在**启动时**探 7890，通就设 `NODE_USE_ENV_PROXY=1` +
 * `HTTPS_PROXY=…` ⇒ **这个进程的所有 fetch 都走代理**。而**代理软件后来被关了**
 * （Clash 退出，7890 没人听）⇒ 机器人**一句话都回不出来**，全线 `ECONNREFUSED`，
 * 直到重启（重启时探到 7890 不通才改成直连）。
 *
 * 原来这里只写 `egress = other` —— **只影响 `rawFetch` 自己传的 dispatcher**，
 * 而 `NODE_USE_ENV_PROXY` 让 Node 的**全局** fetch 走它自己的 EnvHttpProxyAgent，
 * 我们换自己的 ProxyAgent **管不着它**：
 *   · 生图 / 搜索 / 余额这些走**普通 fetch** 的模块照样撞死 ✗
 *   · 连 `rawFetch` 的"直连"分支（`fetch(url, opts)` 不传 dispatcher）
 *     也会落回那个已经死掉的全局代理 ✗
 * ⇒ 所以那次"自动切换"其实是**假的**。切换时**必须 `setGlobalDispatcher`**：
 *   选代理就装 ProxyAgent，选直连就装一个干净的 Agent（把 env-proxy 顶掉）。
 */
function applyEgress(mode) {
  if (mode !== 'proxy' && mode !== 'direct') return;
  const changed = egress !== mode;
  egress = mode;
  try {
    setGlobalDispatcher(mode === 'proxy' ? (proxyAgent ??= new ProxyAgent({ uri: PROXY_URL, ...AGENT_OPTS })) : (directAgent ??= new Agent(AGENT_OPTS)));
  } catch (e) {
    log.warn(`[网络] 设置全局出口失败（${e.message}）—— 可能仍在用启动时那个`);
  }
  if (changed) log.info(`[网络] 出口 → ${mode === 'proxy' ? `代理 ${PROXY_URL}` : '直连'}`);
}

// ⚠️ **启动时就把出口定下来**，别等第一个请求 —— 否则在它定下来之前，
//    生图/搜索那些走普通 fetch 的模块会先撞上那个可能已经死掉的启动期全局代理。
void (async () => {
  if (egress !== 'unknown') return;
  applyEgress((await proxyAlive(true)) ? 'proxy' : 'direct');
})();

// ⚠️ **定期体检当前出口**（用户要求「自动识别并切换」）。
//    光靠"请求失败才切"意味着**先哑一次**（群里先看到一句"卡了一下"）；
//    这里每 5 分钟探一下，代理死了就当场切直连。
//    ⚠️ 只体检"代理死了"这个方向 —— 反过来（直连不通、要走代理）交给
//       `llmFetch` 的失败路径处理，因为**国内 API 直连本来就该是通的**。
//    ⚠️ `unref()` 是必须的：不然这个定时器会把 `test/*` 的进程吊着不退出。
const EGRESS_WATCH_MS = 5 * 60 * 1000;
const egressWatch = setInterval(async () => {
  try {
    if (egress === 'proxy' && !(await proxyAlive(true))) {
      log.warn('[网络] 代理不通了（代理软件可能被关了）→ 自动切直连');
      applyEgress('direct');
    }
  } catch {
    /* 体检失败不该影响任何事 */
  }
}, EGRESS_WATCH_MS);
egressWatch.unref?.();

/**
 * 带**自动切换出口**的 fetch（llm.js 里所有模型请求都走它）。
 * ⚠️ 换出口重试**只做一次**（两次都挂就是真挂，交给上层按故障处理）。
 */
/**
 * 清掉 JSON 文本里**孤立的代理项**（半个 emoji）。
 *
 * ⚠️⚠️ 2026-09-23 加（实测踩到，**持续复现**）：
 *    `JSON.stringify` 只在两种情况下输出 `\uXXXX` —— 控制字符，和**孤立代理项**。
 *    字符串里如果有一个**被切断的 emoji**（高代理后面没跟低代理，或反之），
 *    stringify 会老老实实输出 `"\ud83d"`。这在 JSON 规范里技术上合法、**语义无效**，
 *    而严格的解析器（DeepSeek 那边是 Rust 的 `serde_json`）会**直接拒绝**，报：
 *    ```
 *    Failed to parse the request body as JSON: messages[0].content:
 *    unexpected end of hex escape at line 1
 *    ```
 *    ⇒ 于是**她的回复整个生成失败**（那条消息直接哑掉）。
 *
 *    **来源**：识图返回 405 字描述，而它被 `slice()` 截断 ⇒ 正好切在 emoji 中间。
 *    但**任何**字符串都可能带（模型输出、群友消息、知识库），所以修在**这里**。
 *
 * ⚠️ 为什么在 `llmFetch` 里做、而不是每个调用点：`llm.js` 里有 4 处 `JSON.stringify`，
 *    在这里过一道闸就不用改 4 个地方（改 4 处必漏一处）。
 * ⚠️ 输入是**已经 stringify 过的文本**，所以要匹配的是**转义后的** `\uXXXX` 形式。
 */
function stripLoneSurrogates(body) {
  // ① 高代理（D800-DBFF）后面没紧跟低代理 ⇒ 孤立 ⇒ 去掉
  let s = String(body).replace(/\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})/g, '');
  // ② 低代理（DC00-DFFF）前面没紧跟着高代理 ⇒ 孤立 ⇒ 去掉
  s = s.replace(/(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}/g, '');
  return s;
}

export async function llmFetch(url, opts = {}) {
  /* ⚠️⚠️ 2026-10-22 加（用户：「**402/401 立即停，不再重试整轮**」）——
   *    **死锁期间直接抛错、一个字节都不发** ✓
   *    今天实测：DeepSeek 余额不足（402）之后，每条消息还是完整地发请求、
   *    带 8 万字提示词、等 402、降级、再 402 ⇒ 一天撞 **570 次** ✗
   *    ⚠️ 这里抛的错**故意不带 401/402/429 字样** —— 免得被 `isHardFail()` 再判成硬失败、
   *      又绕一圈（死锁期间不该再记账）✓ */
  if (FO.deadUntil > Date.now()) {
    const left = Math.ceil((FO.deadUntil - Date.now()) / 60000);
    throw new Error(`LLM 已暂停（${FO.deadReason || '欠费/凭据'}，还要等 ${left} 分钟）—— 期间不发任何请求`);
  }
  // ⚠️⚠️ 所有 llm 请求都在这里过一道「孤立代理项」闸 —— 理由见上面那个函数。
  if (opts && typeof opts.body === 'string') {
    opts = { ...opts, body: stripLoneSurrogates(opts.body) };
  }
  // ⚠️⚠️ 2026-10-09 加（用户：「有没有**不用充钱直接用免费额度**的？」）：
  //    要白嫖 **Gemini 官方免费额度**，就**必须走代理**（国内直连不到 Google ✗）；
  //    可整个进程只有一个全局出口，而主模型（DeepSeek）在国内**直连更合适** ✗
  //    ⇒ 这里按**目标域名**决定优先级：国外域名（Google / OpenAI / Anthropic）**优先代理**，
  //      其余按全局出口走 ✓
  //    ⚠️ 只改"先试哪个"，**失败重试那条路一个字没动**（仍然会试另一个出口 ✓）
  //      ⇒ 代理真挂了也不会卡死，只是多一次失败重试 ✓
  const host = (() => {
    try {
      return new URL(String(url)).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const needProxy = /(^|\.)(googleapis\.com|google\.com|openai\.com|anthropic\.com)$/.test(host);
  if (egress === 'unknown') applyEgress((await proxyAlive()) ? 'proxy' : 'direct');
  const first = needProxy && (await proxyAlive()) ? 'proxy' : egress;
  try {
    return await rawFetch(url, opts, first);
  } catch (e) {
    /* ⚠️ 2026-10-22：**两个出口都试不通 ⇒ 说明这家服务真的连不上** ⇒ 触发降级
     *   （用户：「优先级在前的模型不可用，兜底自动使用后一级的模型 10 分钟」）
     *   ⚠️ 只在**最终**失败时降（下面那个 `throw e` 之前），中间换出口那次不算 ✗ */
    if (!isNetErr(e)) throw e;
    const other = first === 'proxy' ? 'direct' : 'proxy';
    if (other === 'proxy' && !(await proxyAlive(true))) {
      noteLlmFailure(`网络：${e?.cause?.code || e?.message}`);
      throw e;
    }
    log.warn(
      `[网络] ${first === 'proxy' ? '代理' : '直连'}失败（${e?.cause?.code || e?.message}）→ 换` +
        `${other === 'proxy' ? '代理' : '直连'}重试一次（运行中自动切换，2026-09-16）`,
    );
    try {
      const res = await rawFetch(url, opts, other);
      // ⚠️ 必须走 `applyEgress`（它会把全局 dispatcher 一起换掉），别只赋 `egress`
      applyEgress(other);
      return res;
    } catch (e2) {
      // 换出口也失败 ⇒ 这家确实连不上 ⇒ 降级
      if (isNetErr(e2)) noteLlmFailure(`网络：${e2?.cause?.code || e2?.message}`);
      throw e2;
    }
  }
}

// 注意：不要在模块顶层解构 config.llm —— 那样会把配置固化在加载时，
// 管理界面改了模型或 Key 之后就不生效了。统一在函数里现读。
/* ══════════════════════════════════════════════════════════════════
 * ⚠️⚠️ 2026-10-22 加：**模型故障转移**（用户原话：
 *   「如果优先级在前的模型不可用，要**兜底自动使用后一级的模型 10 分钟**，
 *     **10 分钟之后自动重试**」）
 *
 * ## 规则
 *   1. 正常用**优先级最高**的那个（`llm.providers[0]`，或者没配列表时用扁平字段那套）
 *   2. 调用**失败**（连不上 / 401 / 403 / 429 / 5xx / 超时）⇒
 *      立刻**降一级**，并且**这个降级状态保持 10 分钟**
 *   3. 10 分钟到 ⇒ **自动回到主模型重试**（主模型要是又挂了，再降一次，如此往复）
 *
 * ## 为什么要"保持 10 分钟"而不是每次现试
 *   主模型挂的时候，每个请求都先试主、超时、再试备 ⇒ 每条消息白等一个超时 ✗
 *   ⇒ 记住"刚挂过"，接下来 10 分钟**直接走备的**，不再浪费一次失败 ✓
 *
 * ## ⚠️ 别改的地方
 *   `llmCfg()` 是**所有调用点的唯一入口**（`streamChat` / `phrase` / `ping` / `quickAck`…）
 *   ⇒ 只在这一层做切换，调用链一行都不用动 ✓
 * ══════════════════════════════════════════════════════════════════ */

/** 降级状态（**内存**，重启就清 —— 重启本身就是一次"重试"，不用持久化） */
const FO = {
  /** 降级到第几个提供商（0 = 没降级；1 = 用 providers[1]，以此类推） */
  level: 0,
  /* ⚠️⚠️ 2026-10-22 加（用户：「**那个主模型如果是被限流报错的话，先换相同供应商正常模型**」）
   *    背景：主模型现在是中转站上的 `kimi-k3`，今天日志里已经出现过 `HTTP 429 upstream rate limit`
   *    ⇒ 老逻辑直接**跳到下一家供应商**（DeepSeek 官方）—— 可同一家明明还有十几个能用的模型
   *      （kimi-k2.8-preview / glm-5.3 / gpt-5.6-terra …），换一家等于把上下文风格也换了 ✗
   *    ⇒ 现在多一层：**限流时先在同一个 baseURL + 同一个 key 下换模型**，
   *      这一家的备用模型都试完了，才跨到下一家 ✓
   *    ⚠️ 只有**限流（429）**才走这条路；401/403（密钥错）和 5xx 换模型没用，直接跨家 ✓ */
  modelIdx: 0,
  /** 这个时刻之前都保持降级（毫秒时间戳）；到点自动回主模型重试 */
  until: 0,
  /* ⚠️⚠️ 2026-10-22 加（用户：「**402/401 立即停，不再重试整轮**」）
   *
   *    今天实测：16:40 起 DeepSeek 官方 `Insufficient Balance`（402），
   *    一天里 402 出现了 **570 次** —— 也就是**每条消息都还完整地发一次请求、
   *    带 8 万字提示词、等它 402、再降级、再失败** ✗
   *
   *    ⇒ 现在：**402（余额不足）/ 401（凭据失效）且已经无路可降** ⇒
   *      进 10 分钟"死锁"，期间 `llmFetch` **直接抛错、一个字节都不发** ✓
   *      （欠费了本来就说不了话，快速失败比反复撞省钱得多）
   *      `noteLlmOk()` 一次成功就清掉；10 分钟到自动恢复 ✓ */
  deadUntil: 0,
  deadReason: '',
  /** 连续几次"整家不能用"（402/401）—— 到 3 次就进死锁，成功一次清零 */
  deadStrikes: 0,
  /** 最近一次失败的原因（给日志/界面看） */
  lastErr: '',
  /** 连续失败次数 */
  fails: 0,
};

/** 降级保持多久（2026-10-22 用户：「**改成 2 分钟重试**」—— 原来是 10 分钟，太久了：
 *  主模型只是偶发抖动时，10 分钟内全都用不上它 ✗） */
const FALLBACK_HOLD_MS = 2 * 60 * 1000;

/* ⚠️ 2026-10-22 加：**欠费/凭据失效的死锁时长**
 *    用户：「402/401 立即停，不再重试整轮」——
 *    连续 3 次 402/401 ⇒ 暂停 **10 分钟**，期间一个字节都不发 ✓ */
const DEAD_HOLD_MS = 10 * 60 * 1000;

/** 现在的"优先级列表"：providers 数组（**顺序 = 优先级，第 0 个就是主模型**） */
function providerChain() {
  const l = config.llm || {};
  const list = (Array.isArray(l.providers) ? l.providers : [])
    .filter((p) => p && p.baseURL)
    .map((p) => ({
      id: String(p.id || ''),
      name: String(p.name || ''),
      baseURL: String(p.baseURL || ''),
      apiKey: String(p.apiKey || ''),
      model: String(p.model || ''),
      /* ⚠️ 2026-10-22 加：**这一家的备用模型**（同一个 baseURL + 同一个 key，只换 model 名）。
       *   限流时按顺序试；试完才跨到下一家供应商 ✓
       *   ⚠️ 字段名 `fallbackModels`（数组），界面上是逗号分隔的一行 ✓ */
      fallbackModels: (Array.isArray(p.fallbackModels) ? p.fallbackModels : [])
        .map((x) => String(x || '').trim()).filter(Boolean),
      /* ⚠️ 2026-10-22 加（用户：「**把大模型那里本来有的设置直接全部剪切过来**」）——
       *    温度 / 单次最大 token / 超时原来只存在**扁平**字段里，提供商卡片里没有 ⇒
       *    切成别的提供商之后，这三项还是用全局那套，等于没切干净 ✗
       *    ⇒ 每个提供商都可以带自己的一套（**没填就沿用扁平值**）✓ */
      temperature: Number.isFinite(p.temperature) ? p.temperature : null,
      maxTokens: Number.isFinite(p.maxTokens) ? p.maxTokens : null,
      timeout: Number.isFinite(p.timeout) ? p.timeout : null,
    }));
  // ⚠️ 列表为空 ⇒ 只有一份（扁平字段），不存在降级
  return list;
}

/**
 * **现在该用哪套配置**
 * @returns {object} 形如 `{ baseURL, apiKey, model, temperature, maxTokens, timeout, ... }`
 */
function llmCfg() {
  const l = config.llm || {};
  const chain = providerChain();

  // 降级到期 ⇒ 自动回主模型重试（用户要求"10 分钟之后自动重试"）
  if ((FO.level > 0 || FO.modelIdx > 0) && Date.now() >= FO.until) {
    try {
      log.info(`[模型] 降级 ${Math.round(FALLBACK_HOLD_MS / 60000)} 分钟到 ⇒ 回到主模型重试`);
    } catch { /* ignore */ }
    FO.level = 0;
    FO.modelIdx = 0;
    FO.until = 0;
    FO.fails = 0;
  }

  // 没配提供商列表 ⇒ 老行为（扁平字段）
  if (!chain.length) return l;

  const idx = Math.min(FO.level, chain.length - 1);
  const p = chain[idx];
  /* ⚠️ 2026-10-22：**同家备用模型**（限流时换的那个）。
   *    `FO.modelIdx` = 0 表示用主模型名；1 表示 fallbackModels[0]，以此类推 ✓ */
  const fb = p.fallbackModels || [];
  const useFb = FO.modelIdx > 0 && fb[FO.modelIdx - 1];
  // ⚠️ 把提供商的值**盖在扁平配置上**：提供商没填的项（温度/超时/maxTokens）沿用全局的 ✓
  return {
    ...l,
    baseURL: p.baseURL,
    apiKey: p.apiKey || l.apiKey,
    model: useFb || p.model || l.model,
    temperature: p.temperature ?? l.temperature,
    maxTokens: p.maxTokens ?? l.maxTokens,
    timeout: p.timeout ?? l.timeout,
    _provider: p.name || p.id,
    _level: idx,
    _modelIdx: FO.modelIdx,
  };
}

/**
 * **记一次失败 ⇒ 先在同家换模型，再跨家降级**（由调用点在自己的 catch 里调）
 *
 * ## ⚠️⚠️ 2026-10-22 改（用户：「**那个主模型如果是被限流报错的话，先换相同供应商正常模型**」）
 *
 * 老逻辑：只要失败就 `level += 1`（跳到**下一家供应商**）。
 * 问题：主模型是中转站上的 `kimi-k3`，一被限流（`HTTP 429 upstream rate limit`）
 * 就直接切到 DeepSeek 官方 —— 可同一家还有十几个能用的模型
 * （kimi-k2.8-preview / glm-5.3 / gpt-5.6-terra …），换家等于把上下文风格也换了 ✗
 *
 * ⇒ 现在两级：
 *   ① **限流（429）且这家还有没试过的备用模型** ⇒ `modelIdx += 1`（**同一个 baseURL + 同一个 key**）✓
 *   ② 这家试完了 / 不是限流（401/403 密钥错、5xx 服务挂、网络不通）⇒ 才 `level += 1` 跨家 ✓
 *
 * ⚠️ 为什么 401/403/5xx **不**换模型：密钥错了换哪个模型都一样错；5xx 是这家服务挂了，
 *    换模型也救不回来 —— 换家才有意义 ✓
 *
 * @param {string} why 失败原因（日志用）
 * @param {'rate'|'other'} kind 失败类型 —— 只有 `rate`（限流）才会同家换模型
 * @returns {boolean} 降级/换模型了吗（false = 已经在最后一家且模型也试完了）
 */
export function noteLlmFailure(why = '', kind = 'other') {
  const chain = providerChain();
  if (!chain.length) return false;
  FO.lastErr = String(why || '').slice(0, 200);
  FO.fails += 1;

  /* ⚠️⚠️ 2026-10-22 加（用户：「**402/401 立即停，不再重试整轮**」）——
   *    402（余额不足）/ 401（凭据失效）是**整家不能用**，不是限流。
   *    今天 402 撞了 **570 次**：每条消息都完整地发一次请求（8 万字提示词）→ 402 → 降级 → 再失败 ✗
   *    ⇒ 连续撞到 **3 次**就认定"这条链上没有一家能用" ⇒ **进 10 分钟死锁**：
   *      期间 `llmFetch` 直接抛错，**一个字节都不发** ✓
   *      （欠费了本来就说不了话，快速失败比反复撞省钱得多） */
  if (kind === 'credits' || kind === 'auth') {
    FO.deadStrikes = (Number(FO.deadStrikes) || 0) + 1;
    if (FO.deadStrikes >= 3) {
      FO.deadUntil = Date.now() + DEAD_HOLD_MS;
      FO.deadReason = kind === 'credits' ? '余额不足（402）' : '凭据失效（401）';
      FO.deadStrikes = 0;
      try {
        log.error(
          `[模型] ⛔ ${FO.deadReason} 连续 3 次 ⇒ **暂停所有模型调用 ${Math.round(DEAD_HOLD_MS / 60000)} 分钟**` +
            `（期间不发送任何请求，不再烧钱；到点自动重试）`,
        );
      } catch { /* ignore */ }
      return false;
    }
  }

  const curIdx = Math.min(FO.level, chain.length - 1);
  const cur = chain[curIdx];
  const fb = cur?.fallbackModels || [];

  // ① 限流 ⇒ 先在**同一家**换个模型（用户要求的那一层）
  if (kind === 'rate' && FO.modelIdx < fb.length) {
    FO.modelIdx += 1;
    FO.until = Date.now() + FALLBACK_HOLD_MS;
    try {
      log.warn(
        `[模型] ⚠️ 限流：${FO.lastErr} ⇒ 同一家（${cur.name || cur.id}）换成备用模型「${fb[FO.modelIdx - 1]}」，` +
          `接下来 ${Math.round(FALLBACK_HOLD_MS / 60000)} 分钟用它`,
      );
    } catch { /* ignore */ }
    return true;
  }

  // ② 只有一个提供商 ⇒ 没得跨家（模型也试完了就真的没辙）
  if (chain.length < 2) {
    FO.until = Date.now() + FALLBACK_HOLD_MS;
    try {
      if (fb.length) log.warn(`[模型] ${cur?.name || ''} 这一家的模型都试过了（${FO.lastErr}）⇒ 没有下一家可换`);
    } catch { /* ignore */ }
    return false;
  }

  if (FO.level >= chain.length - 1) {
    // ⚠️⚠️⚠️ 2026-10-22 修（用户：「**现在不应该降级吧，主模型中转站是能用的**」）——
    //    **真 bug**：原来这里又把 `until` 续了一整个周期 ⇒ 降级到一家**欠费（402）**的之后，
    //    每次失败都续期 ⇒ **永远回不到主模型** ✗✗
    //    实测：主模型（中转站）单独测 200 完全正常，可 17:38 的剧情推进连续两次 402，
    //    而且之前十几分钟一直 402 —— 就是降级状态被无限续期、卡在欠费那家。
    //    ⇒ 最低一级也失败 = 这条链上**没有任何一家能用** ⇒ **立刻回主模型重试** ✓
    //      （主模型真挂了的话，下一次请求会再降一次，不会死循环；
    //        但它只是偶发抖动时，这样能马上回到能用的那家 ✓）
    FO.level = 0;
    FO.modelIdx = 0;
    FO.until = 0;
    try {
      log.warn(`[模型] 最低一级也失败了（${FO.lastErr}）⇒ **立刻回主模型重试**（不再续期）`);
    } catch {
      /* ignore */
    }
    return false;
  }
  FO.level += 1;
  FO.modelIdx = 0;   // ⚠️ 换家必须把模型序号清零（不然会去拿上一家的备用模型名）
  FO.until = Date.now() + FALLBACK_HOLD_MS;
  const nxt = chain[FO.level];
  try {
    log.warn(`[模型] ⚠️ 降级：${FO.lastErr} ⇒ 接下来 ${Math.round(FALLBACK_HOLD_MS / 60000)} 分钟改用「${nxt?.name || nxt?.id}」（${nxt?.model}）`);
  } catch { /* ignore */ }
  return true;
}

/** 一次成功 ⇒ 清掉失败计数（⚠️ **不立刻回主模型**：用户要的是"10 分钟后再试"） */
export function noteLlmOk() {
  if (FO.fails) FO.fails = 0;
  /* ⚠️ 2026-10-22：成功一次就把"欠费/凭据"的连续计数和死锁清掉 ✓
   *    （可能只是某一家恢复了，或者用户刚充了钱） */
  if (FO.deadStrikes) FO.deadStrikes = 0;
  if (FO.deadUntil) { FO.deadUntil = 0; FO.deadReason = ''; }
}

/** 给界面看：现在是不是降级中、降的是谁、还有多久回主 */
export function llmFallbackStatus() {
  const chain = providerChain();
  // ⚠️ 2026-10-22：**同家换模型也算"降级中"** —— 不然界面显示"没降级"，
  //    可实际用的已经不是主模型了（用户会以为模型没切过去）✗
  const degraded = FO.level > 0 || FO.modelIdx > 0;
  const left = degraded ? Math.max(0, Math.round((FO.until - Date.now()) / 1000)) : 0;
  const cur = chain[Math.min(FO.level, Math.max(0, chain.length - 1))];
  const fb = cur?.fallbackModels || [];
  const usingFb = FO.modelIdx > 0 && fb[FO.modelIdx - 1];
  return {
    level: FO.level,
    modelIdx: FO.modelIdx,
    total: chain.length,
    /* ⚠️ 2026-10-22 加：**死锁状态**（402/401 连续 3 次 ⇒ 暂停 10 分钟）
     *    界面上要能一眼看出"不是坏了，是欠费了在等" ✓ */
    dead: FO.deadUntil > Date.now(),
    deadReason: FO.deadReason || '',
    deadLeftMinutes: FO.deadUntil > Date.now() ? Math.ceil((FO.deadUntil - Date.now()) / 60000) : 0,
    deadStrikes: Number(FO.deadStrikes) || 0,
    activeName: cur?.name || '',
    mainName: chain[0]?.name || '',
    /** 现在实际在用的模型名（界面直接显示这个最直观） */
    activeModel: usingFb || cur?.model || '',
    /** 是不是"同一家换了个模型"（而不是换了家供应商）——
     *  ⚠️ 只判 `modelIdx > 0`：**降级到第 2 家之后再在它自己家换模型，也算同家换** ✓
     *     （原来写成 `level === 0 && modelIdx > 0`，第 2 家换模型时界面会误显示成"换家"✗） */
    sameVendor: FO.modelIdx > 0,
    /** 这一家还剩几个备用模型没试 */
    fbLeft: Math.max(0, fb.length - FO.modelIdx),
    secondsLeft: left,
    lastErr: FO.lastErr,
    fails: FO.fails,
    holdMinutes: Math.round(FALLBACK_HOLD_MS / 60000),
  };
}

/** 手动复位（界面上"立刻回主模型"用） */
export function llmFallbackReset() {
  FO.level = 0;
  FO.modelIdx = 0;
  FO.until = 0;
  FO.fails = 0;
  FO.lastErr = '';
}

/**
 * **统一的"这次调用算不算硬失败"判据**（2026-10-22）
 *
 * ⚠️ 只在**这些**情况降级：
 *   · 网络层彻底失败（连不上 / DNS / 超时）—— 说明这家服务挂了
 *   · 401 / 403（key 失效或没权限）
 *   · **402（余额不足 / 欠费）** ← 2026-10-22 加，见下面那条注释
 *   · 429（限流 —— 换一家能继续用）
 *   · 5xx（对方服务端故障）
 * 🚫 **不降**：400（多半是自己请求体写错，换模型一样错）、内容层面的截断/空回复
 */
function isHardFail(e) {
  const msg = String(e?.message || '');
  /* ⚠️⚠️ 2026-10-22 加 **402**（真事故）：
   *    用户问「今天下午主动发评论成功没有」⇒ 查出来 16:49 明明**挑到视频了**，
   *    但写评论时 `HTTP 402 Insufficient Balance`（DeepSeek 余额不足）⇒
   *    402 **原来不在这个白名单里** ⇒ 不降级 ⇒ 主模型一直欠费、一直 402，
   *    主动评论 / 说话判断 / 润色全废，日志里只留一行"润色失败 HTTP 402" ✗
   *    ⇒ 余额不足 = 这家**彻底不能用了**，必须降级到下一家 ✓ */
  if (/^(LLM 接口返回 (401|402|403|429|5\d\d))/.test(msg)) return true;
  const code = String(e?.cause?.code || e?.code || '');
  if (/^(ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR)/.test(code)) return true;
  if (/fetch failed|timeout|超时|socket hang up/i.test(msg)) return true;
  return false;
}

/**
 * **这次失败是不是"被限流"**（2026-10-22 加）
 *
 * ⚠️ 只有限流才走"**同一家换个模型**"那条路（用户要求：「**那个主模型如果是被限流
 *   报错的话，先换相同供应商正常模型**」）——
 *   · 401/403：密钥错/没权限 ⇒ 换哪个模型都一样错，必须换家
 *   · 5xx：这家服务挂了 ⇒ 换模型救不回来，必须换家
 *   · 网络不通 ⇒ 同上
 *   ⇒ 只有 **429 / rate limit** 属于"这个模型这会儿用不了，但这家别的模型还能用" ✓
 */
function isRateLimit(e) {
  const msg = String(e?.message || '');
  if (/(^|[^0-9])429([^0-9]|$)/.test(msg)) return true;
  return /rate.?limit|too many requests|限流|频率超限/i.test(msg);
}

/** 这次失败该按什么类型记账（给 `noteLlmFailure` 的第二个参数） */
const failKind = (e) => {
  const m = String(e?.message || '');
  /* ⚠️ 2026-10-22 细分：`rate`（限流，同家换模型）/ `credits`（402 余额不足）/
   *    `auth`（401 凭据失效）—— 后两种是**整家不能用**，跟限流不是一回事 ✓ */
  if (/(^|[^0-9])429([^0-9]|$)/.test(m) || /rate.?limit|too many requests|限流|频率超限/i.test(m)) return 'rate';
  if (/(^|[^0-9])402([^0-9]|$)/.test(m) || /insufficient|余额|欠费|credits exhausted/i.test(m)) return 'credits';
  if (/(^|[^0-9])401([^0-9]|$)/.test(m) || /authentication|unauthorized|凭据|api key/i.test(m)) return 'auth';
  return 'other';
};

/**
 * **包一层：失败就降级、成功就记一笔**（2026-10-22）
 *
 * ⚠️ 所有非流式调用点（`phrase` / `quickAck` / `ping` …）都套这个，
 *   省得每处都写一遍 try/catch —— 也保证"降级判据"只有一份 ✓
 *
 * @param {() => Promise<any>} fn
 * @param {string} label 日志里显示是哪个调用
 */
export async function withFallback(fn, label = '') {
  try {
    const r = await fn();
    noteLlmOk();
    return r;
  } catch (e) {
    if (isHardFail(e)) {
      const changed = noteLlmFailure(`${label ? label + '：' : ''}${e.message}`, failKind(e));
      // ⚠️ 刚降级 ⇒ **立刻用新的一级重试一次**（别让用户白等这一条）
      if (changed) {
        try {
          const r = await fn();
          noteLlmOk();
          return r;
        } catch (e2) {
          if (isHardFail(e2)) noteLlmFailure(`${label}（重试）：${e2.message}`, failKind(e2));
          throw e2;
        }
      }
    }
    throw e;
  }
}

/** 兼容老写法：原来 `llmCfg` 是常量箭头函数，别处可能直接引用 */
const _llmCfgCompat = llmCfg;

/**
 * 调用 OpenAI 兼容接口，流式产出文本增量。
 * @param {{role:string, content:string}[]} messages
 * @param {AbortSignal} [outerSignal]
 * @param {{maxTokens?:number, timeoutMs?:number, thinking?:object, report?:object}} [opts]
 *        按次覆盖参数：解题模式要更大的上限；`thinking:{type:'disabled'}`
 *        用来**关掉思考链**（压缩故事线就靠它 —— 见 2026-09-18 那条注释）
 *        ⚠️ `report`：**调用方传一个空对象进来**，这次生成要是被截断，
 *        这里会往里写 `report.truncated`（`'length'` = 被 max_tokens 截断；
 *        `'reasoning-only'` = 思考链把上限吃光、正文一个字都没出）。
 *        用它判断"要不要关掉思考重试一次"（解题模式那段，2026-10-02 加）。
 *        ⚠️ 为什么按调用传对象、而不是用模块级全局：预搜索 / 说话判断 / 归属核对
 *        会**并发**调这个函数，全局变量会被别的那次冲掉。
 * @returns {AsyncGenerator<string>}
 */
export async function* streamChat(messages, outerSignal, opts = {}) {
  const llm = llmCfg();

  // ⚠️ 解题模式要更大的 max_tokens（2026-09-12）：
  //    flash 的**思考链也计入 completion_tokens** —— 一道折叠最值题想清楚了
  //    可能就烧掉几千 token，正文没写几句就被截断（表现是"空回复"或"说到一半没了"）。
  const maxTokens = Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : llm.maxTokens;

  // ⚠️⚠️ 2026-09-13 修：**超时要跟着 token 预算放大**。
  //
  //    踩过（用户截图）：他发了张图 + 一句短话，被判成「解题模式」→
  //      `max_tokens` 抬到 **24000**，而超时**还是写死的 60 秒** →
  //      推理模型产出 24k token 根本不可能 60 秒内完成 →
  //      **`LLM 请求超时`** → 群里显示「⚠️ 模型调用出错了，请稍后再试」。
  //
  //    也就是说：**解题模式在旧代码下几乎必然超时** ——
  //    max_tokens 调大了、但等它的时间没跟着调大，等于白调。
  //
  //    现在：按「每 1000 token ≈ 3 秒」估算，最少用 `llm.timeout`，
  //    上限 `llm.timeoutMax`（默认 180 秒）。普通回复（8000）→ 仍是 60 秒左右；
  //    解题（24000）→ 放宽到 ~72 秒以上。
  const estMs = Math.ceil(maxTokens / 1000) * 3000;
  const timeoutMs =
    Number(opts.timeoutMs) > 0
      ? Number(opts.timeoutMs) // 按次指定（压缩故事线要等它把几千字写完）
      : Math.min(
          Math.max(llm.timeout, estMs),
          Number(llm.timeoutMax) > 0 ? Number(llm.timeoutMax) : 180000,
        );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('LLM 请求超时')), timeoutMs);
  const onAbort = () => controller.abort(outerSignal?.reason);
  outerSignal?.addEventListener('abort', onAbort, { once: true });

  if (timeoutMs !== llm.timeout) {
    log.debug(`本次超时放宽到 ${Math.round(timeoutMs / 1000)} 秒（max_tokens=${maxTokens}）`);
  }

  // ⚠️ `usage` 必须声明在 **try 外面** —— 它要在 `finally` 里用来记账，
  //    而 finally 是 try 的**兄弟作用域**，看不到 try 块里声明的变量。
  //    （第一版就写在了 try 里面 → `ReferenceError: usage is not defined`。）
  let usage = null;
  // ⚠️ 收尾原因，同样要声明在 try 外面 —— `length` = **被 max_tokens 截断**，
  //    `finally` 里要拿它报警（2026-09-18 那次"日志里什么都没有"的故障就靠这个说清）
  let finishReason = '';

  // ⚠️⚠️ 2026-10-09 加（用户原话：「可以把这两个接入 **gemini** 吗，然后和关思考链一样
  //    也加个按钮**选择是否使用 gemini**，即**备选模型**」）：
  //    按**这一次调用**覆盖「模型 / 地址 / 密钥」——
  //    让「机器人之间的日常聊天 + 剧情里和同类对戏」这两类走**备选模型**，其余照旧 ✓
  //    ⚠️ 记账也要用**实际用的那个模型名**（不然月度账单里两个模型混成一个、对不上账 ✗）
  //    ⚠️ 只有传了才覆盖；不传就完全是原来的行为（默认这条路一个字都没变 ✓）
  const useModel = String(opts.model || llm.model);
  const useBase = String(opts.baseURL || llm.baseURL);
  const useKey = String(opts.apiKey || llm.apiKey);
  // ⚠️⚠️ 2026-10-10：**这次用的是不是主模型那个地址**？
  //    不是 ⇒ 是备选模型（Gemini）⇒ 下面那个 `thinking` 字段**一个都不能带**（见那段注释）。
  const usingMainBase =
    useBase.replace(/\/+$/, '') === String(llm.baseURL ?? '').replace(/\/+$/, '');

  // ⚠️ 2026-10-19：思考链**每次调用重新攒** —— 同一个 `report` 对象会被"重跑/切备选"
  //    复用（见 `bot.js` 的 `_genOnce`），不清空就会把两次的思考拼在一起 ⇒
  //    上一次写过的工具暗号会被**执行两遍** ✗
  if (opts.report) opts.report.reasoning = '';

  try {
    const res = await llmFetch(`${useBase.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${useKey}`,
      },
      body: JSON.stringify({
        model: useModel,
        messages,
        // ⚠️ 2026-10-20 加（用户：「**把备用模型也加个模型温度的调整框吧**」）：
        //    备选模型（Gemini 那类）可以有自己的温度 —— `opts.temperature` 有值就用它，
        //    没有就照旧用主模型那个（**老配置一个字都不变**）✓
        temperature: Number.isFinite(Number(opts.temperature))
          ? Number(opts.temperature)
          : llm.temperature,
        max_tokens: maxTokens,
        // ⚠️ 关掉思考链（2026-09-18）：flash 的**思考链计入 completion_tokens**，
        //    压缩故事线时它烧掉 7479/8000，正文只写了 819 字就被截断 → 整次作废。
        // ⚠️⚠️ 2026-09-23 加（用户实测：她说「行，给你看一眼」却**没发图**）：
        //    日志：`LLM 输出被 max_tokens(8000) 截断了（其中**思考链吃了 7999 token**）`
        //    ⇒ 思考链把输出预算吃光 ⇒ **`[拍照]` 标记正好被截掉** ⇒ 她嘴上答应、实际没标记 ⇒ 没有图 ✗
        //    ⇒ 主聊天**默认给思考链设上限**（`config.llm.thinkingBudget`，默认 3000），把剩下的留给输出。
        //      辅助请求（说话判断/润色/识图）本来就显式传 `thinking:{type:'disabled'}`，不受影响 ✓
        //    ⚠️ 实测过这个字段被接受（带 `budget_tokens` 打 API 返回 200，不报 400）。
        //    ⚠️ 设 0 或负数 = 不限制（退回旧行为）。
        // ⚠️⚠️⚠️ 2026-10-10 修（**这才是"备选模型 400"的真正根因**）：
        //    `thinking` 是 **DeepSeek 专用**字段，而它会从**两个地方**被带上：
        //      ① 调用方显式传 `thinking:{type:'disabled'}`（"关思考链"那条路）；
        //      ② **没传时下面补的这个默认值**（`config.llm.thinkingBudget`）。
        //    ⇒ 只在调用方那一处删掉**没用** —— 默认值照样把请求打到 Gemini，然后被 400 拒：
        //      `Invalid JSON payload received. Unknown name "thinking": Cannot find field.`
        //    实测后果（14:27 日志）：机对机**每句都失败** ⇒ 走"生成失败"的兜底话术 ⇒
        //      两个号反复说同一句「……我这边有点小状况，等下再说」**并互相引用**，
        //      在群里看着像复读机 ✗
        //    ⇒ 判据放在**这里**最省事：**只要这次不是主模型的 baseURL，就不带 thinking** ✓
        //      （一次覆盖所有调用方：主聊天 / followUp / 润色 / 抽取 / 剧情…谁走备选模型都自动剥离）
        ...(!usingMainBase
          ? {}
          : opts.thinking
            ? { thinking: opts.thinking }
            : (() => {
              // ⚠️⚠️ 2026-10-07：**试过默认关掉，用户要求调回**（原话：「直接调回思考链」）——
              //    实测数据：生成耗时一直在 8~20 秒（那次 52 秒是异常尖峰），
              //    所以"慢"的主因**不是**它；而关掉它确实会让回答少一层推敲 ⇒ 按用户要求恢复。
              //    ⚠️ 留个记号：思考链**不受 `budget_tokens` 约束**（实测能烧满 8000 token / 72 秒），
              //      哪天真要提速，改 `config.llm.thinkingBudget`（0 = 不传 thinking 字段）。
              const b = Number(config.llm?.thinkingBudget ?? 3000);
              return Number.isFinite(b) && b > 0 ? { thinking: { type: 'enabled', budget_tokens: b } } : {};
            })()),
        stream: true,
        // ⚠️⚠️ 2026-10-15 加（用户：黑祥那台用的是**中转站**的同款模型）——
        //    **中转站不认 DeepSeek 的 `thinking:{type:`disabled`}`** ⇒ 它照样思考，
        //    而有些中转的适配层会把思考**拼进 content** ⇒ 推理混进正文 ✗
        //    客户端没法把"已经混进 content 的推理"再分离（那已经是正文了），
        //    但可以**换一种关法**：给配置开个口子，把"那家中转认的参数"原样塞进请求体 ——
        //      `llm.extraBody: { enable_thinking: false }` /
        //      `chat_template_kwargs: { thinking: false }` / `reasoning_effort: none`
        //    ⚠️ 具体认哪个**得看那家中转的文档**，但改配置就能试，不用改代码 ✓
        //    ⚠️ 放在最后 ⇒ 它**覆盖**前面算出来的同名字段（想手工压过默认行为就靠这个）✓
        ...(llmCfg().extraBody && typeof llmCfg().extraBody === "object" ? llmCfg().extraBody : {}),
        // ⚠️ 加了这行，流式响应才会在**最后一块**带 `usage`
        //    （记账要用它，见 spend.js；不加的话只能估算）
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      /* ⚠️ 2026-10-22：**主模型不可用 ⇒ 触发降级**（用户：「优先级在前的模型不可用，
       *   兜底自动使用后一级的模型 10 分钟，10 分钟之后自动重试」）
       *   ⚠️ 只在"确实是服务端/鉴权/限流"这类**硬失败**时降级；
       *     400（参数错）多半是自己请求体写错了，换模型也一样错 ⇒ 不降 ✓ */
      if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 429 || res.status >= 500) {
        // ⚠️ 2026-10-22：**429 单独记成 rate** ⇒ 同一家换个模型（用户要求），
        //    其余（含 **402 余额不足**）照旧跨家 —— 欠费了换哪个模型都一样欠 ✗
        noteLlmFailure(`HTTP ${res.status}`, res.status === 429 ? 'rate' : 'other');
      }
      throw new Error(`LLM 接口返回 ${res.status} ${res.statusText}${body ? ` :: ${body.slice(0, 400)}` : ''}`);
    }
    if (!res.body) throw new Error('LLM 接口没有返回响应体');

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let sawAny = false;
    /** 有没有产出过思考链 —— 用来判断「正文为空」是不是被思考吃光了 token */
    let sawReasoning = false;

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });

      // SSE 以空行分隔事件
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const rawLine of block.split('\n')) {
          const line = rawLine.trim();
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;

          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;

          let json;
          try {
            json = JSON.parse(payload);
          } catch {
            continue; // 半包/噪声，跳过
          }
          if (json.error) {
            throw new Error(`LLM 返回错误: ${json.error.message ?? JSON.stringify(json.error)}`);
          }

          // ⚠️⚠️ **先抓 usage，再判 delta**（2026-09-13）。
          //    DeepSeek 把用量放在**最后一块**，而那一块 `choices` 是**空数组** ——
          //    所以必须放在下面 `if (!delta) continue` **之前**，
          //    否则永远拿不到用量（记账就全空了）。
          //    （请求里要带 `stream_options:{include_usage:true}`，见下面 body。）
          if (json.usage) usage = json.usage;

          // ⚠️ 收尾原因也要抓（这一块常常没有 delta，所以要放在下面 `continue` 之前）
          const fr = json.choices?.[0]?.finish_reason;
          if (fr) finishReason = String(fr);

          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          // 推理模型的思维链单独放在 reasoning_content 里，不发给用户。
          // ⚠️ 但要记一下「有没有思考过」—— 用来判断正文为空是不是被思考吃光了。
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            sawReasoning = true;
            // ⚠️⚠️ 2026-10-19 加（用户：「**直接只在思考链输出调用工具的信息吧，正文一概不输出，
            //    和 dsh 一模一样**」）：
            //    工具调用要从**思考链**里读 ⇒ 这里必须把它**攒下来**交给调用方 ✓
            //    （原来只记了个布尔 `sawReasoning`，思考链的内容**直接扔掉**了）
            //    ⚠️ 落点：`opts.report.reasoning` —— 和 `truncated` 同一个"按次隔离"的对象，
            //      不用模块级全局变量（并发两条请求会互相串 ✗）
            //    ⚠️ 上限 20000 字：思考链一般两三千 token，够用；真超了留**尾部**
            //      （暗号多半写在"决定动手"那一段，靠近末尾 ✓）—— 也防止把内存吃爆。
            if (opts.report) {
              const r = String(opts.report.reasoning ?? '') + delta.reasoning_content;
              opts.report.reasoning = r.length > 20000 ? r.slice(-20000) : r;
            }
          }
          const text = delta.content;
          if (typeof text === 'string' && text) {
            sawAny = true;
            yield text;
          }
        }
      }
    }

    if (!sawAny) {
      // ⚠️ 这里**不能只用 debug** —— 正文为空是个很容易被忽略的故障：
      //    表现是「群里只回一句莫名其妙的空话」，而日志里什么都看不到。
      //    真实踩过三次（vision / extract / 教学回执），都是同一个原因：
      //    **推理模型的思考链把 max_tokens 吃光了**，正文一个字都写不出来。
      if (sawReasoning) {
        // ⚠️⚠️ 2026-10-02：**这个分支也是一种"被截断"** ——
        //    正文一个字都没有，全被思考链吃了。解题模式要靠这个信号决定重试。
        if (opts.report) opts.report.truncated = opts.report.truncated || 'reasoning-only';
        log.warn(
          `LLM 只产出了思考链、没有正文 —— 很可能是 max_tokens(${llmCfg().maxTokens}) 被思考吃光了。` +
            `可以把 max_tokens 调大，或者对这类任务设 thinking:{type:'disabled'}`,
        );
      } else {
        log.warn('LLM 流结束，但没有任何产出（模型返回空）');
      }
    }
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
    // ⚠️ **记账**（2026-09-13）：把这次的 token 用量记下来
    //    （用户要"问它今天花了多少钱 / 这个月用了多少 token"）。
    //    放在 finally：**报错也要记** —— 失败的调用同样烧 token。
    // ⚠️⚠️ **被截断必须报警**（2026-09-18 踩的，属于"日志里什么都没有"的故障）：
    //    压缩故事线时思考链烧掉 7479/8000 token，正文只写了 819 字就被切断，
    //    JSON 自然不完整 → 调用方只能报「模型没给可解析的 JSON」，
    //    而真正的线索（`finish_reason=length`）**一个字都没记**，白查半天。
    //    注意：下面 `sawAny` 那条只在"正文**完全为空**"时报警，救不了这种情况。
    if (finishReason === 'length') {
      if (opts.report) opts.report.truncated = 'length';
      const rt = usage?.completion_tokens_details?.reasoning_tokens;
      log.warn(
        `LLM 输出被 max_tokens(${maxTokens}) 截断了` +
          (rt ? `（其中思考链吃了 ${rt} token）` : '') +
          ' —— 这一次的结果是**不完整的**（调用方多半会说"格式不对"，其实是没写完）',
      );
    }

    if (usage) {
      try {
        spend.record({ model: useModel, usage });
      } catch (e) {
        // ⚠️ 这里**必须用 warn 而不是 debug** —— 我第一次就是把
        //    `spend` 的 import 漏了，`ReferenceError` 被 debug 吞掉，
        //    表现是"记账永远是 0"，查了很久。记账失败要看得见。
        log.warn(`记账失败（用量没记上）：${e.message}`);
      }
    }
  }
}

/**
 * 生成一句**「等一下」的过渡话**（回复超过若干秒时才用）。
 *
 * ⚠️ 为什么要有这个（2026-09-13，用户要求）：
 *    用户原话：「**建议超出20秒时，机器人先随便回复一句你等等之类的话**」，
 *    接着又补：「**回复的话不要太死板，也可以经过 llm**」。
 *
 *    背景：生成慢的时候（识图、联网搜、解题）群友会以为它死了，
 *    发「怎么不回我」。所以要在等的时候先应一声。
 *
 *    ⚠️ 但**不能用固定的三句话**（原来写死「哦，等下，我看看」那种）——
 *    同一句反复出现很机械，而且接不上对方具体问了什么。
 *    所以这里花一次**很轻**的调用，让它自己说一句。
 *
 * ⚠️ 关键：必须**关掉思考链**并给很小的 max_tokens。
 *    这是推理模型 —— 不关思考的话它会开始"想"，几秒起步、还可能把
 *    token 吃光（那就变成又一次超时了）。目标是**1~2 秒出话**。
 *
 * ⚠️ 提示词里必须明确「**先别答**」—— 否则它可能把答案一起说了，
 *    等真正的回复出来就变成答两遍。
 *
 * @param {{name?:string, text?:string, extra?:string}} p
 * @returns {Promise<string>} 一句话；失败就返回空串（调用方会退回兜底话术）
 */
export async function quickAck(p = {}) {
  const llm = llmCfg();
  const who = String(p.name ?? '').trim() || '群友';
  const asked = String(p.text ?? '').trim().slice(0, 60);
  const extra = String(p.extra ?? '').trim();

  const sys = [
    // ⚠️ 2026-09-21：这句搬到 `personas/<id>/identity.json` 的 `prompt.quickAside` 了 ——
    //    换人设时它跟着换，代码不用动（取不到就是空串，那种人设自己负责补上）。
    persona.promptText('quickAside'),
    '',
    '现在对方刚发来一条消息，**你还在处理**（可能是在想怎么说，也可能真的要去查一下），需要先说一句让他别等急。',
    '',
    '## 要求',
    '· **只回一句话**，不超过 15 字',
    '· 自然、像随手打的，**别客套**（不要「请稍等」「正在为您处理」这种客服腔）',
    '· ⚠️ **先别回答他问的问题** —— 你只是在说"我看看"，答案等下再说',
    // ⚠️⚠️ 2026-09-16 用户截图报的：「问动画的信息，说**翻翻**有点奇怪」——
    //    她答的是「嗯…等我翻翻」。问题在于：**她是本人，手边没有资料库**，
    //    "翻翻/查查/搜搜"这种话说出来就成了"客服台在翻档案"，一秒露馅。
    //    所以这里把两件事分开：
    //      · 只是**在想/在组织语言**（问她自己的事、回忆、看法）→ 说「我想想」「嗯…」
    //      · **真的要去上网查**（新番、别人的歌、游戏数据）→ 才可以用"查/搜"
    '· ⚠️⚠️ **除非真的要上网查，否则不许说「翻 / 查 / 搜 / 资料 / 档案 / 记录」这类词** ——',
    '  那听起来像你手边有一份资料可翻（你不是客服台，也没有档案）。',
    '  问**你自己的事、你的回忆、你的想法**（「你还记得…」「月之森有没有…」）→',
    '  说「我想想」「让我回忆一下」「嗯…」这种就行；',
    '  真的在**上网查**（别人的歌 / 新出的东西 / 游戏数值）→ 才可以用「我去查查」「等我搜一下」',
    // ⚠️ 2026-09-13 用户反馈「**吵死了**这个有点不好听」——
    //    它本意是"我看看"，但说成"吵死了"就是在训人。
    //    这句话的功能是**安抚**（让人知道我在处理），语气不能反着来。
    '· ⚠️ **语气要是"别急、我在看"，不是在训人** ——',
    '  不要说「吵死了」「别催」「烦不烦」「催什么催」这种**嫌弃对方**的话；',
    '  也不要反问、不要抱怨。你是随口应一声，不是被打扰了在发火',
    // ⚠️⚠️ 2026-09-17 用户截图报的（原话：「**等等机制的文案不对**」）：
    //    群友发的是一张**几何题图**，题面清清楚楚写着「求 △DEF 周长的最小值？」，
    //    而过渡话说的是「**喊我五遍有什么用，题呢，打字发过来**」——
    //    **断言了"图里没有题面"**，可她根本还没看完那张图（正文里答案是发出来了的）。
    //    这和上面"不许说翻/查"是同一类毛病：**还没看就先下结论**。
    '· ⚠️⚠️ **对方发了图的时候，绝对不许说「图我看不到」「看不清」「你打字发过来」',
    '  「题呢」「文字呢」「没看到题目」这类话** —— 你**正在看图**，只是还没看完。',
    '  这时候只要应一声（「我看看」「嗯…等下」「这图我瞅瞅」），或者顺着图说一句中性的。',
    '  ❌ 尤其**不许断言图里缺少什么**：等正文一给出答案，那句过渡话就成了打自己脸。',
    '· ⚠️ 可以带点你自己的语气（好奇、随口应一声都行）',
    // ⚠️ 实测（2026-09-13）：不加这条会**六条里五条都是「我看看」** ——
    //    同一句反复出现就成模板了（人设里专门有一条反对固定句式）。
    // ⚠️ 2026-09-16：例句里**删掉了「等我翻翻」**（用户就是被这句击中的），
    //    并把它换成了"回忆型"的说法。
    '· ⚠️ **别老用「我看看」这个说法**（偶尔可以）：换换词 ——',
    '  「稍等」「等我一下」「让我想想」「嗯…我想想」「让我回忆一下」…',
    '  或者就应一声（「哦」「嗯」「收到」）加半句你自己的话，别每次同一个句式',
    '· 直接给这句话，不要引号、不要解释',
  ].join('\n');

  const user = [`${who}：${asked || '（发了个东西）'}`];
  if (extra) user.push(`（${extra}）`);

  try {
    const res = await llmFetch(`${llm.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user.join('\n') },
        ],
        temperature: 1.0,
        max_tokens: 200,
        thinking: { type: 'disabled' },
        stream: false,
      }),
      // 这句话本身不能慢 —— 它就是为了"显得没卡住"，自己卡住就没意义了
      signal: AbortSignal.timeout(Number(llm.ackTimeoutMs) > 0 ? Number(llm.ackTimeoutMs) : 8000),
    });
    if (!res.ok) {
      log.debug(`过渡话生成失败 HTTP ${res.status}`);
      return '';
    }
    const json = await res.json();
    // 记账（非流式也有 usage）
    if (json.usage) {
      try {
        spend.record({ model: llm.model, usage: json.usage });
      } catch {}
    }
    const t = String(json.choices?.[0]?.message?.content ?? '')
      .trim()
      .replace(/^["'「『]|["'」』]$/g, '')
      .replace(/\s*\n+\s*/g, ' ')
      .trim();
    // 太长就不像"随口一句"了，截断
    const out = t.length > 30 ? t.slice(0, 30) : t;
    if (out) log.debug(`过渡话：「${out}」`);
    return out;
  } catch (e) {
    log.debug(`过渡话生成出错：${e.message}`);
    return '';
  }
}

/**
 * 润色类请求共用的**人设一句话**。
 *
 * ⚠️ 为什么要抽出来（2026-09-13）：同一句自我介绍我复制到了
 *    `quickAck` / `phraseMoney` / `spend.earnReply` 三处，
 *    一改自称就漏一处（真的漏了 —— 用户要求自称改「Saki」时，
 *    我改了两个地方才发现第三个还写着「客服小祥」）。
 *
 * ⚠️ **自称用「Saki」**（用户原话：「祥子的话遇到没看过 MyGO 的
 *    很容易误认为骆驼祥子」——中文里「祥子」第一反应是老舍那个车夫）。
 *    别人怎么叫她另说（小祥/祥子都认，见 `knowledge/anime.md` 的外号表）。
 */
/**
 * ⚠️ 2026-09-21：从 `const` 改成**函数**。
 *
 *    原来它在**模块加载时求值** —— 换人设（热切换）时这个常量不会更新，
 *    表现就是"人换了、开场白还是旧的"，而且查起来很难想到是常量求值时机的问题。
 *    内容搬到了 `personas/<id>/identity.json` 的 `prompt.personaLine`。
 *
 *    历史（为什么自称不用「祥子」）：2026-09-13 用户说「祥子的话遇到没看过 MyGO 的
 *    很容易误认为骆驼祥子」—— 中文里「祥子」第一反应是老舍那个人力车夫。
 *    这条现在写在 identity.json 的那句里，不再由代码保证。
 */
export function personaLine() {
  return persona.promptText('personaLine');
}

/**
 * 「把一段事实用她的口吻说出来」—— 一次**非流式、关思考**的短调用。
 *
 * ⚠️ 用途（2026-09-13 用户要求）：「回复的话不要太死板，也可以经过 llm」——
 *    典型场景是报账（`spend.js` 的 `spendReply`）和月末工资单
 *    （`monthly-report.js`）：数字必须准，但**说法不能像念报表**，
 *    所以把数字交给模型润色。
 *
 * 为什么关思考 + 非流式：
 *   · 内容已经定死了，不需要它推理，开着思考只是白等几秒
 *   · 非流式拿到的是一整段，不用自己拼
 *
 * **任何失败都返回空串**，调用方退回模板 —— 宁可说法死板，也不能不回答。
 *
 * @param {{system:string, user:string, maxTokens?:number, timeoutMs?:number}} p
 * @returns {Promise<string>}
 */
export async function phrase(p = {}) {
  const llm = llmCfg();
  const sys = String(p.system ?? '').trim();
  const user = String(p.user ?? '').trim();
  if (!sys || !user) return '';
  const maxTokens = Math.max(60, Math.min(900, Number(p.maxTokens) || 220));
  const timeoutMs = Math.max(3000, Number(p.timeoutMs) || Number(llm.phraseTimeoutMs) || 15000);

  try {
    const res = await llmFetch(`${llm.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature: 1.0,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn(`润色失败 HTTP ${res.status}`);
      /* ⚠️ 2026-10-22：**硬失败 ⇒ 触发降级**（用户：「优先级在前的模型不可用，
       *   兜底自动使用后一级的模型 10 分钟」）
       *   ⚠️ 这条路径原来是**静默返回空串** ⇒ 主模型挂了也永远不降级 ✗
       *     而 `phrase` 是**润色/说话判断/抽取**这些高频调用用的，
       *     它一直空着 ⇒ 那些功能全退化，但日志里只看得到"润色失败" ✗ */
      if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 429 || res.status >= 500) {
        noteLlmFailure(`phrase HTTP ${res.status}`, res.status === 429 ? 'rate' : 'other');
      }
      return '';
    }
    const json = await res.json();
    if (json.usage) {
      try {
        spend.record({ model: llm.model, usage: json.usage });
      } catch {}
    }
    const t = String(json.choices?.[0]?.message?.content ?? '')
      .replace(/```[a-z]*\n?/gi, '')
      .replace(/\*\*/g, '')
      .replace(/^["'「『]|["'」』]$/g, '')
      .trim();
    if (t) log.debug(`润色：「${t.replace(/\s+/g, ' ').slice(0, 80)}」`);
    return t;
  } catch (e) {
    log.warn(`润色出错：${e.message}`);
    // ⚠️ 2026-10-22：网络层硬失败（连不上/超时）也触发降级
    if (isHardFail(e)) noteLlmFailure(`phrase：${e.message}`);
    return '';
  }
}

/**
 * 账目类润色的**共用提示词**（报账 + 月末工资单都走这里）。
 *
 * ⚠️ 为什么抽出来：这两处的铁律完全一样（数字不许改、不许说净赚、
 *    别解释算式）。各写一份的话，改了一处忘了另一处 —— 这种"两套规矩"
 *    迟早会让同一个问题在不同路径下答得不一样，用户一眼就能看出是机器人。
 *
 * @param {{facts:string, asked:string, style?:string, maxLines?:number,
 *          extraRules?:string[]}} p
 * @returns {Promise<string>}
 */
export async function phraseMoney(p = {}) {
  const facts = String(p.facts ?? '').trim();
  if (!facts) return '';
  const asked = String(p.asked ?? '').trim().slice(0, 80);
  const maxLines = Math.max(1, Number(p.maxLines) || 2);

  const sys = [
    personaLine(),
    persona.promptText('styleLine'),
    '',
    '系统已经把**准确的数字**给你了。你的任务只是**用你自己的口吻把数字说出来**。',
    '',
    '## 铁律',
    '· ⚠️ **数字一个字都不能改、不能四舍五入、不能自己算** —— 照抄系统给的数',
    '· ⚠️ 系统没给的数字**不要编**（比如余额、单价、汇率）',
    '· ⚠️ **不要解释算式**（别说"成本乘一百"这种）—— 就当是你自己挣的钱',
    '· ⚠️ **绝对不要说「净赚」「利润」这两个词** —— 用「工资」',
    // ⚠️⚠️ 方向问题（2026-09-13 用户截图）：<主人> 问「你现在工资多少钱」，
    //    她答「1876，就这点，**别嫌少了**」——「别嫌少」是**发钱的人**说的话，
    //    一句话就把自己摆到老板位置上，人设整个翻掉。
    //    这条必须放进**每一个报钱路径**（不能只写在余额那段，报账/月结也要有）。
    '· ⚠️⚠️ **你是领工资的那个，<主人> 是发工资的**（他雇你）—— 别说发钱方的台词：',
    '  不说「别嫌少」「将就一下」「这个月就发这么多」「省着点用」—— 那是老板口吻。',
    // ⚠️⚠️ 这里**故意不给领钱方的示例台词**（2026-09-14 用户反馈）。
    //
    //    原来这条写的是：
    //      '  要说也只能是领钱方的：「就这么点」「还不够花」「你还没发呢」'
    //    —— 结果模型**直接抄**了「就这么点」当成口头禅，
    //    用户看到的原话：「**就这么多**和**九牛一毛**这两个词汇都反复出现了」。
    //
    //    教训：**提示词里凡是带引号的短句，都可能被逐字抄进回复。**
    //    要示范"方向"就描述方向（上面那半句），别给可直接复用的句子。
    //    （同类问题见 `anime.md` 一点六和 `earnReply` 的 extraRules。）
    '  判据是**立场**：这句话像不像"发钱的人在安抚拿钱的"？像就换掉。',
    '  ⚠️ 至于"领钱方该怎么说"，**上面那几句是反例，不是模板** ——',
    '    自己按那个立场想新说法，别把上面任何一句的字面措辞搬进回复。',
    '· 问什么答什么：问花销就只说花销，问工资就只说工资，别把整张账单糊过去',
    '· 谁问都照实说（**群友问工资也报** —— 那是你自己挣的，没什么好藏的）',
    `· 短，${maxLines} 行以内，不要分点列表，不要 markdown`,
    ...(p.extraRules ?? []),
  ].join('\n');

  const user = [
    asked ? `他问/要的是：「${asked}」` : '',
    String(p.style ?? '').trim(),
    '',
    '## 系统实测数据（照这个说）',
    facts,
  ]
    .filter((x) => x !== '')
    .join('\n');

  const t = await phrase({ system: sys, user, maxTokens: p.maxTokens, timeoutMs: p.timeoutMs });
  // ── 防跑偏（这里拦不住的话就会**原样发到群里**）──
  //  · 把提示词原话吐出来（踩过：把「别解释算式」发到群里了）
  //  · 说了「净赚/利润」（用户明确不许）
  //  · 把 token 说成「烧了/消耗了」（那是程序员的话，不是她的话）
  //    ⚠️ 这条原来只在预览脚本里查，结果生产路径漏出去过（实测出现过
  //      「吭哧吭哧烧了一百多万 token」）—— 黑名单必须在**发送路径**上。
  //  · 把自己当发工资的那方（踩过：「别嫌少了」）
  if (!t) return '';
  // ⚠️ "在复述提示词"的形状 —— 实测漏过一次「**说我叫丰川祥子**，工资 1850」
  //    （它把「他问的是：『你叫什么名字』」里的内容当成自己要说的东西了）。
  //    这类句子发到群里非常明显是机器人在读稿。
  //    ⚠️ 判据要收窄：「说你什么好」这种正常话别误伤。
  if (/别解释算式|系统实测|铁律|照抄|##/.test(t)) return '';
  if (/^(说|回答|回复)我(叫|是|的|有|该|这)/.test(t) || /^我(应该|要)(说|回答|回复)/.test(t)) return '';
  if (/净赚|利润/.test(t)) return '';
  if (/烧了|烧掉|消耗了\s*\d|花掉了\s*\d/.test(t)) return '';
  // 把自己当发工资的那方（踩过：「别嫌少了」）
  if (/别嫌少|将就一下|这个月就发这么多|省着点用/.test(t)) return '';
  // ⚠️ 自称别用「祥子」（2026-09-13 用户：「祥子的话遇到没看过 MyGO 的
  //    很容易误认为骆驼祥子」）。人设里的示例台词大量用「小祥」，
  //    模型很容易顺手写「我祥子可没说过」——「小祥」没问题，「祥子」要拦。
  //
  //    ⚠️ 不能简单搜「我祥子」：**"别喊我祥子，叫我 Saki" 是她在纠正别人**，
  //      那句话该放行（把纠正也拦掉，等于逼她接受这个称呼）。
  //      所以只拦**自我断言**的形状：「我祥子」后面紧跟动词/助词。
  {
    const nn = persona.escapeRe(persona.narrativeName());
    if (
      nn &&
      (new RegExp(`我${nn}[可也的确是不没就别能会要想来在说从干做]`).test(t) ||
        new RegExp(`${nn}我[觉认以想说]`).test(t))
    )
      return '';
  }
  // ⚠️⚠️ 她**不该去管别人怎么叫她**（用户 2026-09-13：「别人叫她所有外号都应该
  //    没关系，正常回应」）。纠正称呼 = 答非所问，而且显得在意外号。
  //    只有对方**认真问"该怎么称呼"**时才该答，那种情况下面这些形状也不会出现。
  {
    const ro = persona.renameObjection();
    const alt = ro.dislike.map((x) => persona.escapeRe(x)).join('|');
    const prefer = persona.escapeRe(ro.prefer);
    if (alt && new RegExp(`我不叫(?:${alt})|别叫我(?:${alt})`).test(t)) return '';
    if (prefer && new RegExp(`叫我\\s*${prefer}\\s*就(?:行|好)|请叫我\\s*${prefer}`).test(t)) return '';
  }
  // ⚠️⚠️ 168 亿 **不是她的债、她没有偿还义务** —— 但**也不能因此撇清**
  //    （用户 2026-09-13：「**反正也不是我要还的**感觉也有点 OOC 了，
  //      她之前努力打工也有一部分努力在这里」）。
  //
  //    三种口气要分清（前两种对，第三种 OOC）：
  //      ✅ 自嘲：      "跟 168 亿比这点算什么"「九牛一毛都算不上」
  //      ✅ 事实澄清：  "那是损失，不是欠条"（不承认自己在还债）
  //      ⛔ 冷漠撇清：  "反正不是我要还的""关我什么事"← **人设崩在这**
  //
  //    ⚠️ 为什么不用"穷举句式"来判：我试过写一串正则（把跟它没关系/关我什么事/
  //      又不是我要还…全列上），结果**标点一插就漏**（「那又不是欠条，关我什么事」
  //      的逗号让 `.*` 的写法失效）。改成**算两边的证据分**，稳得多：
  //        · dismissal = 撇清用的词（反正、关我什么事、轮不到我…）
  //        · owning    = 认这件事的词（我在挣、我没说跟我无关、那是我们家的事…）
  //      有撇清 / 没有"认"的迹象 → 拦。
  if (/168\s*亿|一六八亿/.test(t)) {
    // ① 宣布自己在还债（这是"负债少女"，也不对）
    //    正则按形状写，别写死短语 —— 第一版写「我在还」，
    //    结果「我还**在**还那 168 亿呢」直接漏了（中间插了个字）。
    const declaring = /还[在得要想该能会]{0,2}\s*还|还债|还清|还完|偿还|我欠|欠着|还不上/;
    // ⚠️ 「不是欠条」**不能**算作澄清 —— 「那又**不是欠条**，关我什么事」
    //    里的"不是欠条"是**撇清的一部分**，不是事实澄清（这个误判害我白查一轮）。
    //    真正的澄清要带"损失 / 不是我的债 / 没说我在还"。
    const factOnly = /那是损失|不是我的债|不是我欠|没签欠条|我没在还|我没说我在还/;
    if (declaring.test(t) && !factOnly.test(t)) return '';

    // ② 冷漠撇清（OOC）
    const dismissal = /反正|关我什么|关我啥|不关我|跟我没关系|跟我无关|轮不到我|不是我要还/;
    const owning = /我在.{0,3}(挣|做|干|忙)|我一直在|我没说跟我|是(我|我们)家|你以为是为什么|不然我|我图什么/;
    if (dismissal.test(t) && !owning.test(t)) return '';
  }
  return t;
}

/**
 * 数字 → 中文读法（"1834" → "一千八百三十四"）。
 *
 * ⚠️ 为什么要它：发给群里的东西如果写成「工资 ¥1834」，一眼就是机器打印的。
 *    写成「一千八百三十四」才像人在说话。
 *
 * 只处理整数；不支持的超大数就原样返回。
 *
 * @param {number} num
 * @returns {string}
 */
/**
 * 剥掉**带标记的**思考块（2026-10-15 加）。
 *
 * 起由：用户报「黑祥把推理混进正文了」，而那台用的是**中转站**的同款模型 ——
 *   中转站不认 `thinking:{type:`disabled`}`，有的还会把思考拼进 content ✗
 *   混进 content 的那部分客户端**没法**再分离（它已经是正文了），
 *   但**带标签**的那种能剥（`<thinking>…</thinking>`、`<reasoning>…</reasoning>`）。
 *
 * ⚠️ 只认 HTML 式标签 —— 她平时聊天**不可能**写出这种东西 ⇒ 零误伤 ✓
 * ⚠️ 只有开标签、没有闭标签（被 max_tokens 截断）⇒ 从开头剥到结尾（宁可少说一句）✓
 */
export function stripThinking(text) {
  let s = String(text ?? "");
  s = s.replace(/<think(?:ing)?\s*>[\s\S]*?<\/think(?:ing)?\s*>/gi, "");
  s = s.replace(/<reasoning\s*>[\s\S]*?<\/reasoning\s*>/gi, "");
  s = s.replace(/^\s*<think(?:ing)?\s*>[\s\S]*$/i, "");
  s = s.replace(/^\s*<reasoning\s*>[\s\S]*$/i, "");
  return s.trim();
}

export function cjkNum(num) {
  const v = Math.round(Number(num) || 0);
  if (!Number.isFinite(v) || v < 0 || v > 99999999) return String(v);
  if (v === 0) return '零';
  const D = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const U = ['', '十', '百', '千'];
  const section = (x) => {
    let s = '';
    let zero = false;
    for (let i = 3; i >= 0; i -= 1) {
      const d = Math.floor(x / 10 ** i) % 10;
      if (d === 0) {
        zero = s !== '';
      } else {
        if (zero) s += '零';
        zero = false;
        // "一十"读作"十"
        s += (d === 1 && i === 1 && s === '' ? '' : D[d]) + U[i];
      }
    }
    return s;
  };
  const yi = Math.floor(v / 1e8);
  const wan = Math.floor((v % 1e8) / 1e4);
  const rest = v % 1e4;
  let out = '';
  if (yi) out += `${section(yi)}亿`;
  if (wan) out += `${wan < 1000 && out ? '零' : ''}${section(wan)}万`;
  if (rest) out += `${rest < 1000 && out ? '零' : ''}${section(rest)}`;
  return out || '零';
}

/**
 * 非流式调用，用于自检 / 界面上「测试连通性」。
 *
 * @param {object|null} over 想**临时覆盖**的那套配置（`{baseURL, apiKey, model, timeout}`）
 *   ⚠️⚠️ 2026-10-22 加这个参数的原因（真 bug，用户当场被误导）：
 *     原来不管传什么，内部一律走 `llmCfg()`，而 `llmCfg()` 在 `providers` 非空时会用
 *     **chain[0] 的 baseURL/model 盖掉**传入的值 ⇒ 界面上"测试第二个提供商"其实测的是
 *     **第一个**，甚至因为降级测的是第三个 ✗
 *     实测就是：用户填了个免费账号用不了的模型（gemini-3.8-flash），点「测试连通性」
 *     居然全绿 —— 因为请求根本没发到他填的那个模型上 ✓ 假绿灯比红灯更害人。
 *   ⇒ 传了 `over` 就**完全按它来**，不碰 `llmCfg()`、不碰降级状态 ✓
 * @returns {Promise<string>}
 */
export async function ping(over = null) {
  const llm = over ? { ...llmCfg(), ...over } : llmCfg();
  const res = await llmFetch(`${llm.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({
      model: llm.model,
      messages: [{ role: 'user', content: '回复"ok"两个字母即可' }],
      // ⚠️ 原来只给 16 —— 主模型是推理模型，思考一下就没 token 写正文了，
      //    自检会**误报「模型不可用」**（明明它是好的）。给足 + 关思考。
      max_tokens: 200,
      thinking: { type: 'disabled' },
      stream: false,
    }),
    signal: AbortSignal.timeout(llm.timeout || 60000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` :: ${body.slice(0, 300)}` : ''}`);
  }
  const json = await res.json();
  // ⚠️ 2026-09-15 补：自检这条路原来也没记账（一次 200 token 的量级，很小，
  //    但结构测试要求**每一处打模型的地方都记账** —— 免得下次又漏一个大的）。
  try {
    if (json.usage) spend.record({ model: llm.model, usage: json.usage });
  } catch {}
  return json.choices?.[0]?.message?.content ?? '';
}
