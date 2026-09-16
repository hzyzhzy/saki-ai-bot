import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, validate, ROOT, DEFAULT_LIFE, DEFAULT_QUEST, paramsFor } from './config.js';
import { log } from './log.js';
import { Bot } from './bot.js';
import { startWebUI } from './webui.js';
import * as observe from './observe.js';
import * as life from './life.js';
import * as storyline from './storyline.js';
import * as quest from './quest.js';
import * as affinity from './affinity.js';
import * as friend from './friend.js';
// ⚠️ 待发箱（2026-09-15 用户要求：没发出去的，通道正常之后自动补发）
import * as outbox from './outbox.js';
import { streamChat } from './llm.js';
import { faceTags, faceFiles } from './faces.js';
import { initCollector } from './collector.js';
import * as machine from './machine.js';
import * as sessions from './sessions.js';

const bot = new Bot();
let reconnectTimer = null;
let stopping = false;

// ── 启动前体检 ────────────────────────────────────────
const problems = validate();
if (problems.length) {
  log.error('配置有问题，无法启动：');
  for (const p of problems) log.error('  • ' + p);
  log.error('请编辑 config.yml 后重新运行：npm start');
  process.exit(1);
}

// ── 鉴权 ──────────────────────────────────────────────
function tokenOf(req) {
  const header = req.headers?.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (m) return m[1].trim();
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams.get('access_token') ?? '';
  } catch {
    return '';
  }
}

function authOk(provided) {
  const want = config.onebot.accessToken?.trim();
  if (!want) return true; // 未设 token，不校验（仅建议本机使用）
  return provided === want;
}

// ── 正向连接：机器人主动连 NapCat ─────────────────────
function connectForward() {
  const url = config.onebot.url;
  log.info(`正在连接 NapCat：${url}`);

  const headers = {};
  const token = config.onebot.accessToken?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  const ws = new WebSocket(url, { headers });

  ws.on('open', () => {
    log.info('连接成功');
    bot.attach(ws);
    // ⚠️ 重连 = 可能"刚掉线恢复" → 立刻查一次月末工资单要不要补发
    //    （用户要求：「如果因为 QQ 掉线正好没发送，当恢复上线之后马上补发」）
    setTimeout(() => {
      bot.checkMonthlyReport?.().catch((e) => log.debug(`月结补发检查失败：${e.message}`));
    }, 5000);
  });

  ws.on('error', (err) => {
    log.warn(`连接失败: ${err.message}`);
  });

  ws.on('close', (code) => {
    if (stopping) return;
    bot.onClose();
    if (code === 1008 || code === 4001) {
      log.error('被 NapCat 拒绝：accessToken 不匹配。请检查 config.yml 与 NapCat 网络配置里的 token 是否一致。');
    }
    const wait = config.onebot.reconnectInterval;
    log.info(`${wait / 1000}s 后重连…（确认 NapCat 已启动并已登录 QQ）`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectForward, wait);
  });
}

// ── 反向连接：机器人开端口等 NapCat 来连 ──────────────
function listenReverse() {
  const url = new URL(config.onebot.url);
  const port = Number(url.port || 80);

  const wss = new WebSocketServer({ port, host: url.hostname || '0.0.0.0' });

  wss.on('listening', () => {
    log.info(`已监听 ${url.hostname}:${port}，请在 NapCat 里新建「WebSocket 客户端」指向这个地址`);
  });

  wss.on('connection', (ws, req) => {
    if (!authOk(tokenOf(req))) {
      log.warn('拒绝了一个 token 不匹配的连接');
      ws.close(1008, 'token mismatch');
      return;
    }
    log.info('NapCat 已接入');
    bot.attach(ws);
    // 同上：重连 = 可能刚掉线恢复 → 查一次月结要不要补发
    setTimeout(() => {
      bot.checkMonthlyReport?.().catch((e) => log.debug(`月结补发检查失败：${e.message}`));
    }, 5000);
  });

  wss.on('error', (err) => {
    log.error(`监听失败: ${err.message}`);
    if (err.code === 'EADDRINUSE') log.error(`端口 ${port} 已被占用，请改 config.yml 里的 url 或关掉占用它的程序`);
    process.exit(1);
  });

  return wss;
}

// ── 优雅退出 ──────────────────────────────────────────
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  bot.closed = true;
  log.info(`收到 ${signal}，正在退出…`);
  clearTimeout(reconnectTimer);
  try {
    bot.ws?.close();
  } catch {}
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// ⚠️ 2026-09-13：原来的实现只打 message，看不到出错位置 ——
//    今天遇到 s is not defined 查了很久都定位不到。加上堆栈。
process.on('unhandledRejection', (r) => log.error('未处理的 Promise 异常:', r?.stack ?? r?.message ?? r));
process.on('uncaughtException', (e) => log.error('未捕获异常:', e?.stack ?? e));

// ── 启动 ──────────────────────────────────────────────
log.info('═══════════════════════════════════════');
log.info(' QQ AI 机器人启动中');
log.info(` 连接模式 : ${config.onebot.mode}`);
log.info(` 模型     : ${config.llm.model}`);
log.info(` 群聊回复 : ${config.trigger.groupChat ? (config.trigger.requireAtInGroup ? '开启（需 @）' : '开启（所有消息）') : '关闭'}`);
log.info(` 私聊回复 : ${config.trigger.privateChat ? '开启' : '关闭'}`);
log.info('═══════════════════════════════════════');

if (config.onebot.mode === 'forward') {
  connectForward();
} else {
  listenReverse();
}

// 表情收集器：记录群友发过的图，待审核后进正式库
initCollector(faceFiles());

// 管理界面（本地）
startWebUI(bot);

// ⚠️ 2026-09-17 用户要求：「启动机器人就自动打开 webui」（三道闸见 `open-webui.js`）
(await import('./open-webui.js')).maybeOpenWebUI();

// ⚠️⚠️ 2026-09-16 深夜加：**开机就报一次"大模型从哪儿出去"**。
//    那天"机器人忽然不能聊天"，查了半天才发现是 `_run-bot.bat` 里写死了
//    `HTTPS_PROXY=127.0.0.1:7890`，而**代理软件没开** → 每个请求 ECONNREFUSED。
//    这一行以后一眼就能看出来（直连 / 走代理）。
{
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  log.info(
    proxy
      ? `大模型出口：**走代理** ${proxy}（⚠️ 代理软件没开的话会全线 ECONNREFUSED）`
      : '大模型出口：直连（没设 HTTP(S)_PROXY）',
  );
}

// QQ 空间：定期判断要不要把群里的趣事发到空间
bot.startQzoneScheduler();

// ⚠️ API 余额 = 小祥的「工资」（2026-09-13 用户要求）：
//    低于 5 元抱怨一次、低于 2 元再抱怨一次；402 也走这套话术。
try {
  bot.startBalanceWatch();
} catch (e) {
  log.debug(`工资余额监控启动失败（不影响其他功能）：${e.message}`);
}

// 月末工资单（2026-09-13 用户要求）：每月最后一天 21 点发到所有 1 档群 + QQ空间
try {
  bot.startMonthlyReport();
} catch (e) {
  log.debug(`月末工资单启动失败（不影响其他功能）：${e.message}`);
}

// 玩家在线时长跟踪（2026-09-12 加，用户要求「能读取玩家上线时间吗」）
//
// ⚠️ mcstatus.io 的 players 字段**只有名字**，没有任何时间信息 ——
//    所以以前机器人只能编「他刚上来的」（被 luomoSan 当场纠正）。
//    现在自己做：每 60 秒查一次名单，记下谁什么时候上来的。
try {
  sessions.startSessionTracker();
} catch (e) {
  log.debug(`在线时长跟踪启动失败（不影响其他功能）：${e.message}`);
}

// 网络可达性探测（2026-09-12 加，用户要求）
// 群里老有人问「你能上油管吗 / 能不能翻墙」—— 这个后台每 5 分钟探一次，
// 结果会拼进「电脑状态」那段提示词，让她能如实回答而不是含糊其辞。
try {
  machine.startNetworkProbe();
  log.info('网络可达性探测已启动（每 5 分钟一次，国内 + 海外两组）');
} catch (e) {
  log.debug(`网络探测启动失败（不影响其他功能）：${e.message}`);
}

// ── 群友性格/大事的「暗中观察」──
// 需求：「不能用『你记住』这种模式，只能暗中总结」。
// 这里只负责**定期去问一句「攒够了吗」**，真正跑总结的是 observe.summarize()，
// 它自己判断够不够 threshold，不够就直接返回 —— 所以这个定时器很轻。
if (config.observe?.enable !== false) {
  const every = config.observe?.checkIntervalMs ?? 600000;
  setInterval(() => {
    observe.summarize().then((r) => {
      if (r.ok) {
        if (r.added) log.info(`[观察] 自动总结完成，新增 ${r.added} 条`);
      } else if (!/还没攒够|没有新消息|还在跑/.test(r.reason ?? '')) {
        log.debug(`[观察] 这次没跑：${r.reason}`);
      }
    }).catch((e) => log.debug(`[观察] 出错：${e.message}`));
  }, every).unref();
  log.info(`群友观察：每 ${Math.round(every / 60000)} 分钟检查一次，攒够 ${config.observe.threshold} 条消息就总结`);
}

// ── 群记忆的「按时间压缩」（2026-09-14 用户要求）──
// 用户原话：「再加一个**按时间压缩**的功能，**压缩不重要的事情**，
//   但是**性格要不断细化，不能删除**，**好感度也不能修改**」。
// ⚠️ 这里只负责定期问一句"该压了吗"，判断在 observe.compress() 里
//    （它看距离上次压缩够不够 minIntervalMs）—— 所以这个定时器很轻。
if (config.observe?.enable !== false && config.observe?.compress?.enable !== false) {
  const every = config.observe.compress.checkIntervalMs;
  const minGap = config.observe.compress.minIntervalMs;
  setInterval(() => {
    observe.compress().then((r) => {
      if (r.ok) {
        log.info(
          `[观察] 压缩完成：性格 ${r.peopleBefore}→${r.peopleAfter} 条、大事 ${r.eventsBefore}→${r.eventsAfter} 条`,
        );
      } else if (!/还不多|没什么可压|还在跑/.test(r.reason ?? '')) {
        log.debug(`[观察] 这次没压：${r.reason}`);
      }
    }).catch((e) => log.debug(`[观察] 压缩出错：${e.message}`));
  }, every).unref();
  log.info(`群记忆压缩：每 ${Math.round(every / 3600000)} 小时检查一次，距上次满 ${Math.round(minGap / 3600000)} 小时才压`);
}

// 表情库完整性自检：index.json 里登记了但文件不在，是很容易踩的坑
{
  const stats = faceTags().length;
  const registered = (() => {
    try {
      const j = JSON.parse(readFileSync(join(ROOT, 'library', 'index.json'), 'utf8'));
      return (j.faces ?? []).length;
    } catch {
      return 0;
    }
  })();
  if (registered > stats) {
    log.warn(`表情库有 ${registered - stats} 张登记了但文件不存在。`);
    log.warn('重新生成：node test/make-fish.js   （或在管理界面重新上传）');
  }
}

// ── 一级随机事件（日常小事）──────────────────────────────
// 用户要求（2026-09-15）：「随机事件分两级……一级就是生活中的一些小事……
//   这些随机事件生成时要按照时间生成……机器人在收到随机事件后生成吐槽或者炫耀信息，
//   生成时也要经过人设和 llm 润色，然后主动地在 1 级群聊发送。」
//
// ⚠️ 这里只负责"定期问一句该发了吗 + 发出去"。
//    **排程、抽模板、润色、落盘、写故事线全在 `src/life.js`** ——
//    这样 WebUI 那个"剧情模拟测试"才能复用同一套引擎，而不是另写一套会漂移的。
//
// ⚠️ 二级剧情的掷骰函数定义在下面（它要用同一个 ask/发送逻辑），
//    所以这里先声明一个变量，跑到时再调 —— 不能用 const（会踩暂时性死区）。
let questRollFromLife = null;

// ⚠️⚠️ 2026-09-16：定时器**无条件注册**（原来被 `config.life?.enable` 包着）——
//    因为参数已经"完全按群"了：**有的群开着、有的群关着**，
//    看全局那一个开关没有意义（关了它反而会让开着的群也停）。
//    每个群自己的开/关在 `life.plan(..., 群号)` 里判。
if (true) {
  const every = DEFAULT_LIFE.checkIntervalMs;

  const tick = async () => {
    try {
      const groups = life.targetGroups();
      if (!groups.length) {
        log.debug('[日常] 没有 1 档群，不发');
        return;
      }

      // ⚠️ 掉线时别发：QQ 没登录时 sendToGroup 必然失败，
      //    而且这时候发也发不出去。等重连后下一个 tick 会再判一次
      //    （life.plan 里"迟到超时就跳过"保证了不会半夜补一条午饭被偷）。
      if (!bot.selfId) {
        log.debug('[日常] 到点了但还没登录 QQ，先不发');
        return;
      }

      // ⚠️ 通道明显不通时**先别润色**（2026-09-15）——
      //    省一次模型调用，而且反正也发不出去。
      //    真正的"顺延"交给 `plan()`：不记账，它会在今天剩下的时段里再排一次。
      if (typeof bot.sendLooksBroken === 'function' && bot.sendLooksBroken()) {
        log.debug('[日常] 通道刚失败过（假在线），这一格先不发，等它恢复 —— 今天会顺延重排');
        return;
      }

      // ⚠️⚠️ 2026-09-16：**每个群各排各的**（用户要求：
      //    「把日常事件的节奏设置…分群调节…**不同群的数据一定不要混在一起**」）。
      //
      //    参数（每天几条 / 两条之间隔多久 / 时段）走 `paramsFor('life', 群号)`，
      //    计数和排程也是**每个群一个桶** —— 所以这里必须**挨个群问**
      //    "你这个群到点了吗"，而不是问一次、再把同一句话发给所有群。
      //    ⚠️ 代价：到点的那一刻**每个群各润色一次**（原来是一份文案发所有群）——
      //       这是"分群"的必然结果，而且每个群的故事线本来就不一样，说的话也该各是各的。
      for (const g of groups) {
        const plan = life.plan(Date.now(), Math.random, g);
        if (!plan.fire) continue; // 这个群没到点 / 今天发完 / 不在时段 —— 静默

        // ★ 先掷骰：这个群这一格是一级还是二级？
        //   ⚠️ 每个 1 档群**各掷各的**（HZY 选的是"每个群各跑一条"）。
        //      中了骰子的群这一格走剧情、**不再发日常事件**。
        if (questRollFromLife && (await questRollFromLife(plan, g))) continue;

        // 润色失败退回事件原文（宁可说得平，也不能卡住不发）
        const text = (await life.compose(plan)) || plan.template.text;

        // ⚠️⚠️ **别把"发过"当成"发出去了"**（2026-09-15 修，用户就是被这句坑的）。
        //
        //    `sendChatLike` **自己吞掉每条的错误**，只把**成功**的返回回来 ——
        //    所以外面加 `.catch()` 永远不会触发。原来这里不管结果都打「已发」，
        //    11:22 那次所有分条其实全失败（NapCat 登录态假在线），
        //    日志照打「已发 200000002,200000001」，用户那边一个字都没收到，
        //    却看到"今天已发 1 条" —— 查这条费了很大劲。
        // ⚠️ 同样走 `sendChatLike`（会分条）—— 日常小事也是"她说的话"。
        // ⚠️ `outbox:false`：日常事件**不进待发箱**，见下面「顺延」那段的原因。
        const sent = await bot
          .sendChatLike(g, text, { kind: 'life', outbox: false })
          .catch(() => []);
        if (!Array.isArray(sent) || !sent.length) {
          // ⚠️⚠️ **一条都没发出去 → 不记账**（`fired` 不加）→ 这就是「自动顺延」：
          //    `plan()` 会把它挪到今天剩下的时段里重排一次，今天该看到的条数不会少。
          //    ⚠️ 而且**不进待发箱**：日常事件是"几点的事几点说"，
          //       半小时后补一条"午饭被偷了"很怪（这条规矩早就定过）。
          log.warn(
            `[日常] 群 ${g}「${plan.template.text}」→ ❌ 没发出去` +
              ' → **不记账，这个群今天顺延重排**（去查协议端是不是假在线：tools/napcat-state.mjs）',
          );
          continue;
        }
        // ⚠️ 只给这个群记账、只写这个群的故事线（分群之后各算各的）
        life.commit(plan, text, Date.now(), { groups: [g], groupId: g });
        log.info(`[日常] 群 ${g}「${plan.template.text}」→ 已发（这个群今天第 ${life.status(g).fired} 条）`);
      }
    } catch (e) {
      log.warn(`[日常] 出错：${e.message}`);
    }
  };

  setInterval(tick, every).unref();
  // ⚠️ 启动先等 60 秒 —— 别刚开机就冒话（和余额提醒"等 90 秒"一个道理）
  setTimeout(tick, 60 * 1000).unref();
  log.info(
    `日常事件：每 ${Math.round(every / 60000)} 分钟检查一次（**每个群各排各的**，参数可在界面按群改）；` +
      (life
        .targetGroups()
        .map((g) => {
          const s = life.status(g);
          return `${g} 今天 ${s.fired}/${s.target}`;
        })
        .join('、') || '现在没有 1 档群'),
  );
}

// ── 待发箱：通道恢复之后自动补发 ─────────────────────────────
//
// 用户要求（2026-09-15）：「如果因为各种原因没发出，在正常之后要补发。」
//
// ⚠️ 为什么必须轮询而不是"重连时补一次"：这台机器上的坏法不是"断开连接"
//    （WS 一直连着、探针一直说 online），而是**发消息时 QQ 回 1200「网络连接异常」**。
//    所以没有"恢复了"这个事件可以监听 —— 只能隔一会儿**真发一次**去试。
//    `outbox.flush` 自己也做了节流（`retryMs`），这里再按间隔调用一次就够了。
function startOutboxTick() {
  const every = Math.max(30000, Number(config.outbox?.checkIntervalMs) || 60 * 1000);
  const tick = async () => {
    try {
      if (!bot?.selfId) return; // 没登录就别试
      if (!outbox.pending()) return;
      const r = await outbox.flush((item) => bot.sendParts(item.groupId, item.parts));
      if (r.delivered || r.dropped) {
        log.info(
          `[待发箱] 这轮：补发成功 ${r.delivered} 批、过期丢掉 ${r.dropped} 批，` +
            `还剩 ${outbox.pending()} 批`,
        );
      }
    } catch (e) {
      log.debug(`[待发箱] 轮询出错：${e.message}`);
    }
  };
  setInterval(tick, every).unref();
  log.info(
    `待发箱：每 ${Math.round(every / 60000)} 分钟看一次，` +
      `现在有 ${outbox.pending()} 批没发出去（超过 ${Math.round((config.outbox?.maxAgeMs ?? 0) / 60000)} 分钟就丢掉）`,
  );
}

// ⚠️ 待发箱的定时器**无条件注册**（和剧情那个一样）：
//    总开关只该管"要不要主动生成"，不该管"已经生成、只是没发出去的东西"。
startOutboxTick();

// ── 二级剧情（任务系统）的推进 ─────────────────────────────
//
// 用户要求（2026-09-15）：「每段最长等待时间也就是群友一句话没回时有半小时时间，
//   过了 llm 自动续写……再通过祥子自己的话转述剧情的发展和变化发到群里，
//   群友再发言或自动续写，重复几个阶段直到 llm 认为事件结束。」
//
// ⚠️ 分工：**引擎在 `src/quest.js`（纯状态机）**，这里只做三件外面的事：
//    ① 定时问"等够了没" ② 把生成的话发到群里 ③ 记下 message_id（"回复她"要靠它）
//    群友发言的收集在 `bot.js` 的 `noteQuestReply()`（消息一到就攒起来）。
{
  const ask = async (messages) => {
    let out = '';
    for await (const d of streamChat(messages)) out += d;
    return out;
  };

  /** 把一段剧情发到群里，并记住这条消息的 id */
  const sendQuestLine = async (q, text) => {
    if (!text) return;
    const gid = q.groupId || life.targetGroups()[0];
    if (!gid) {
      log.warn('[剧情] 不知道该发哪个群（没有 1 档群？）');
      return;
    }
    try {
      // ⚠️ 用 `sendChatLike`（**会分条**）而不是 `sendToGroup` ——
      //    用户要求：「剧情在发群里时一样要分条……只要不是那种排行榜之类
      //    完全不是属于人类发的消息，都要分条」。一条 150 字的"祥子的话"
      //    看着就像公告，不像人在群里说话。
      const sent = await bot.sendChatLike(gid, text);
      // ⚠️ **每一条**都要记 id —— 群友可能回复其中任何一条（"回复她"判据要用）
      for (const r of sent) quest.rememberHerMsg(q, r?.message_id);
      // ⚠️ `sendChatLike` 吞掉错误、只回成功的 —— **空数组 = 一条都没发出去**。
      //    别把空数组也打成"已发 0 条"就算了（分不清"没内容"和"发失败"）。
      if (!sent.length) {
        log.warn(`[剧情] 第 ${q.stageIndex} 段 → ❌ 群 ${gid} 一条都没发出去（查协议端）`);
      } else {
        log.info(`[剧情] 第 ${q.stageIndex} 段 → 群 ${gid}（${sent.length} 条）`);
      }
    } catch (e) {
      log.warn(`[剧情] 发送失败：${e.message}`);
    }
  };

  /** 结算：结局 → 好感度（只有参与过的人加） */
  const settleQuest = (q, ending) => {
    // ⚠️ 剧情结局的加减分**记在这个剧情所在的群**（好感度 2026-09-15 晚起按群）
    const r = quest.settle(q, ending, (uid, d, o) => affinity.adjust(uid, d, { ...o, groupId: q.groupId }));
    if (r.cast.length) log.info(`[剧情] ${ending === 'good' ? '好' : '坏'}结局，给 ${r.cast.length} 人各 +${r.delta} 好感度`);
    return r;
  };

  /**
   * 推**一个群**的剧情。
   * ⚠️ 分群之后（2026-09-15 HZY：「每个群各跑一条」）—— 外面要**挨个群**调。
   */
  const questTickOne = async (gid) => {
    const q = quest.current(gid);
    if (!q || q.endedAt) return;

    // 冷场：一个人都没回 → 最多续 coldAutoLimit 次就收（用户拍板）
    const cold = quest.coldStop(Date.now(), gid);
    if (cold) {
      log.info(`[剧情] 冷场收尾（群 ${gid}，没人回应）：${q.premise}`);
      settleQuest(q, cold.ending);
      return;
    }

    if (!quest.due(Date.now(), gid)) return; // 还没等够 30 分钟
    // 掉线时先不推进：发不出去，推进了这一段就白生成了
    // （下一轮 tick 会再看一次；`due()` 不会因为等更久而失效）
    if (!bot.selfId) {
      log.debug('[剧情] 到点了但还没登录 QQ，先不推进');
      return;
    }

    const r = await quest.advance(q, { ask });
    if (!r.ok) {
      log.debug(`[剧情] 群 ${gid} 这次没推进：${r.reason}`);
      return;
    }
    await sendQuestLine(q, r.text);
    if (r.done) settleQuest(q, r.ending);
  };

  const questTick = async () => {
    // ⚠️⚠️ **每个群各推各的**（分群之后最多同时好几条在跑）。
    //    一个群出错不许挡住别的群 —— 所以每个都单独 try。
    for (const gid of quest.runningGroups()) {
      try {
        await questTickOne(gid);
      } catch (e) {
        log.warn(`[剧情] 群 ${gid} 推进出错：${e.message}`);
      }
    }
  };

  // ⚠️⚠️ 这个定时器**无条件注册**（2026-09-15 修）。
  //
  //    原来它被 `if (config.quest?.enable !== false)` 包着 —— 于是总开关一关，
  //    定时器根本不注册，**手动开的那条剧情永远不会推进**（只能干等）。
  //    而总开关的语义是"关掉**自动**开剧情"，不是"关掉整个功能"。
  //    这个 tick 没有剧情时是空转，代价可以忽略。
  {
    const every = DEFAULT_QUEST.checkIntervalMs;
    setInterval(questTick, every).unref();
    // 启动后等 90 秒再看（别刚开机就推进）
    setTimeout(questTick, 90 * 1000).unref();
    // ⚠️ 2026-09-16：参数**完全按群**了，所以这里不再报"全局那份"，
    //    只报检查频率 + 告诉去哪儿改（界面「按群设定」那一页）。
    const on = life.targetGroups().filter((g) => paramsFor('quest', g).enable === true);
    log.info(
      `二级剧情：每 ${Math.round(every / 1000)} 秒检查一次（**参数按群**，去界面「按群设定」改）；` +
        `自动开剧情开着的群：${on.join('、') || '（没有 —— 每个群都能单独开）'}`,
    );
  }

  /**
   * 一级事件的槽位：**按 chance 掷骰决定这一格走二级还是一级**。
   *
   * 用户要求：「二级……生成比例默认占一成并且可编辑」。
   * ⚠️ 一成这个数不是随便定的：一级每天 3-5 条 × 0.1 ≈ 每周 2-3 条，
   *    正好落在他定的"二级一周最多 2-3 个"里。
   *
   * ⚠️⚠️ 2026-09-15 **分群**：**每个 1 档群各掷各的**（HZY 选的是"每个群各跑一条"）。
   *    所以一次 tick 里可能**两个群同时各开一条**剧情，也可能只有一个群中。
   *    中了骰子的群这一格就**不再发日常事件**（那个槽位被剧情占了）。
   *
   * @returns {Promise<boolean>} 这个群这一格是不是走了剧情
   */
  questRollFromLife = async (plan, gid) => {
    const g = String(gid ?? '').trim();
    if (!g) return false;
    // ⚠️ 2026-09-16：**按群读参数**（`paramsFor('quest', 群号)`）——
    //    界面上现在能给单个群设概率/每周上限/开关，读全局那份就等于白设。
    const qp = quest.params(g);
    const chance = Number(qp.chance ?? 0.1);
    if (qp.enable === false || !quest.canStart(Date.now(), { groupId: g }).ok) return false;
    if (!(Math.random() < chance)) return false;
    if (!bot.selfId) return false;
    // ⚠️ `takeNextHint()` 只在**真的要开**的时候取 —— 没中就留着下次用；
    //    ⚠️ 而且**必须带这个群**：那句由头是照这个群的故事线写的（2026-09-15 晚改成按群存）
    const r = await quest
      .begin({ ask, extraHint: quest.takeNextHint(g), groupId: g })
      .catch(() => ({ ok: false }));
    if (!r.ok) return false;
    await sendQuestLine(r.quest, r.text);
    log.info(`[剧情] 群 ${g} 自动开了一条（掷骰命中一成）：${r.quest.premise}`);
    return true;
  };
}

// ── 好友：每天白天按概率主动私聊**一个**（2026-09-15 用户要求）──
//
// 用户原话：「通过之后**每天有几率主动发一次消息**，时间要在**白天**，
//   要注意**一定是好感度达到 90 才能发**，**一定不是所有好友都会发**，
//   要不然就尴尬了。」
//
// ⚠️ 两条"一定"都在 `src/friend.js` 里落地了：
//   · `pickForToday()` 先掷一次"今天要不要发"（默认 0.35）→ 中了才挑**一个**
//   · ⚠️ **没中的日子也要记"今天挑过了"** —— 否则这个 tick 每 10 分钟掷一次骰子，
//     概率就被放大成"迟早会中"，那就变成每天都发了
{
  const every = config.friend?.checkIntervalMs ?? 10 * 60 * 1000;
  const tick = async () => {
    try {
      if (config.friend?.enable === false) return;
      if (!bot.selfId) return; // 没登录就别算
      const pick = friend.pickForToday();
      if (!pick.userId) {
        if (pick.skip && !/今天已经挑过|没中/.test(pick.skip)) log.debug(`[好友] 今天不发：${pick.skip}`);
        return;
      }
      const text = await friend.composeDm(pick.userId);
      if (!text) {
        log.debug('[好友] 这次没写出来，算了');
        return;
      }
      await bot.call('send_private_msg', {
        user_id: String(pick.userId),
        message: [{ type: 'text', data: { text } }],
      });
      friend.markDm(pick.userId);
      log.info(`[好友] 主动私聊了一条 → ${pick.userId}`);
    } catch (e) {
      log.warn(`[好友] 私聊出错：${e.message}`);
    }
  };
  if (config.friend?.enable !== false) {
    setInterval(tick, every).unref();
    setTimeout(tick, 3 * 60 * 1000).unref();
    log.info(
      `好友私聊：每 ${Math.round(every / 60000)} 分钟看一次，` +
        `只在 ${config.friend?.dayFromHour ?? 9}:00-${config.friend?.dayToHour ?? 22}:00 之间发，` +
        `每天 ${Math.round((config.friend?.dailyChance ?? 0.35) * 100)}% 概率挑一个`,
    );
  }
}

// ── 故事线的「按时间 + 重要度」定期压缩（2026-09-15）────────────
//
// ⚠️⚠️ 这一步是**补上的**：`storyline.compress()` 从头就写好了
//    （还有"锁定条目少一条就整次作废"那套保护 + 测试），
//    但**忘了注册定时器** —— 于是它是个死函数，永远不会跑。
//    用户问「现在故事线知识库压缩不了对吗」才发现。
//
// ⚠️ 和 `observe.compress` 一样：这里只负责"定期问一句该压了吗"，
//    真正的判断（够不够 `minIntervalMs`、条数够不够）在 `storyline.compress()` 里。
// ⚠️⚠️ 2026-09-15 **分群**：`compressIfDue()` 会**挨个群**看（每个群有自己的 `lastCompressAt`），
//    所以这里的日志不再报单个群的数字，只报"哪几个群压了"。
if (config.storyline?.enable !== false && config.storyline?.compress?.enable !== false) {
  const every = config.storyline.compress.checkIntervalMs;
  const minGap = config.storyline.compress.minIntervalMs;
  setInterval(() => {
    storyline
      .compressIfDue()
      .then((r) => {
        if (r.ok) {
          for (const one of r.results ?? []) {
            if (!one.ok) continue;
            log.info(
              `[故事线] 群 ${one.groupId} 压缩完成：${one.before} → ${one.after} 字，` +
                `${one.kept} 条（锁定 ${one.locked} 条一条没少）`,
            );
          }
        } else if (!/还不到|条数太少|还在压|还没有任何群/.test(r.message ?? '')) {
          log.debug(`[故事线] 这次没压：${r.message}`);
        }
      })
      .catch((e) => log.debug(`[故事线] 压缩出错：${e.message}`));
  }, every).unref();
  log.info(
    `故事线压缩：每 ${Math.round(every / 3600000)} 小时检查一次（**每个群各算各的**），` +
      `距上次满 ${Math.round(minGap / 3600000)} 小时、且攒够 ${config.storyline.compress.minEntries} 条才压`,
  );
}

// 每分钟打一次运行状态，方便确认还活着
setInterval(() => {
  const h = bot.stats;
  log.debug(`运行中 · 收到 ${h.received} · 回复 ${h.replied} · 失败 ${h.failed}`);
}, 60000).unref();
