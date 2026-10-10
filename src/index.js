import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, validate, ROOT, DEFAULT_LIFE, DEFAULT_QUEST, paramsFor, stateDir, isMainAccount, watchConfigFile } from './config.js';
// ⚠️ 协议端适配层：启动横幅要报它、管理能力也由它决定（换协议端只改 config.yml）
import * as provider from './provider.js';
import { log } from './log.js';
import { Bot } from './bot.js';
import { startWebUI } from './webui.js';
import * as observe from './observe.js';
// ⚠️ 「他的资料」自动更新（2026-10-03 用户要求）：他私聊里聊到生活变化 → 自动改 owner.md
import * as ownerUpdate from './owner-update.js';
import * as life from './life.js';
// ⚠️ 2026-10-05 加：同类机器人主动搭话（群里冷场时 @ 它 / 戳它一下）
import * as peerChat from './peer-chat.js';
import * as storyline from './storyline.js';
import * as quest from './quest.js';
import * as affinity from './affinity.js';
import * as names from './names.js';
import * as friend from './friend.js';
import * as remind from './remind.js';
// ⚠️ 待发箱（2026-09-15 用户要求：没发出去的，通道正常之后自动补发）
import * as outbox from './outbox.js';
import { streamChat } from './llm.js';
import { faceTags, faceFiles } from './faces.js';
import { initCollector } from './collector.js';
import * as machine from './machine.js';
import * as cleanup from './cleanup.js';
import * as providerWatch from './provider-watch.js';
import * as sessions from './sessions.js';
// ⚠️ 2026-10-10 加：「服务器重新开启 → @ 他」那套订阅（触发点在 `sessions.tick()`）✓
import * as serverWatch from './server-watch.js';
import * as qzoneComment from './qzone-comment.js';

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

// ── config.yml 变动监听（2026-10-10 加）─────────────────
// ⚠️⚠️ 用户要求：「**能不能模型界面两个界面是同时保存的**」。
//    多账号**共享同一份** `config.yml`，而 `reloadConfig()` 原来只在"点保存的那个进程"
//    里跑（`webui.js` 的保存路由调的）⇒ 在 A 号界面改了开关，B 号内存里还是旧值
//    （实测：改一次备选模型开关，得在**两个界面各点一次**才全生效）✗
//    ⇒ 挂文件监听：谁写了文件，**每个进程各自重载** ✓ 一次保存、全账号生效 ✓
//    ⚠️ 顺带治好另一个坑：**我直接改 config.yml 也立刻生效**（以前必须重启一次 ——
//      今天为此白重启过两回）✓
//    ⚠️ 日志只能在这里打：`config.js` 不能 import `log`（`log.js` 反过来 import 它，会成环）✓
//    ⚠️ 边界：只有启动时才读的项（协议端 url / 管理界面端口 / 账号文件）仍然要重启 ——
//      `reloadConfig()` 是整段替换、不会去重连，界面保存本来也是这个边界。
watchConfigFile((fresh, err) => {
  if (err) return log.warn(`config.yml 变动后重载失败（继续用旧的）：${err.message}`);
  log.info('config.yml 被改动 → 已重载（多账号共享这一份配置，各自生效）');
});

// ── 单例锁（2026-09-21 加）─────────────────────────────// ⚠️⚠️ 为什么必须有：**重复实例会造出最难查的那类症状** ——
//    两套定时器 ⇒ 主动接话 / 说说 / 剧情**重复发**（AGENTS 里记的
//    「同一个梗连发三遍到 QQ 空间」就是这个）；协议端要是允许多个 WS 客户端，
//    还会**每条消息回两次**（有人克隆仓库后报的「接一句回两句」就是它）。
//    实测我自己也一次撞出 3 个实例（2026-09-21 19:06）。
//    以前唯一的防线是 `webui.js` 那句"管理界面端口被占用" ——
//    但它**只报错、不退出** ⇒ 第二个实例照样跑起来 ⇒ 等于没有防线。
//
// ⚠️ 判据：锁文件里记 PID，用 `process.kill(pid, 0)` 探活
//    （跨平台、不用起子进程）。抛 ESRCH = 那个进程没了；EPERM = 活着但没权限 ⇒ 也算活着。
//    ⚠️ Windows 的 PID 会复用，所以锁里另外记了启动时间 —— 万一真遇到
//       "明明没别的实例却被拒绝启动"，按提示删掉锁文件即可（不丢数据）。
// ⚠️ 测试必须隔离：`QQBOT_LOCK_FILE` 指到别处，否则 `test/behavior.js` 里
//    `spawn(node, [src/index.js])` 会被正在跑的真机器人挡在门外。
const LOCK_FILE = process.env.QQBOT_LOCK_FILE || join(stateDir(), 'bot.lock');

/**
 * 锁**多久没被蹭过**就当作"那个实例已经没了"。
 *
 * ## 为什么光看 PID 不够（2026-09-21 踩了）
 *
 * `process.kill(pid, 0)` 只回答"**这个号码**有进程吗"，不回答"那是不是机器人"。
 * 而 Windows 的 PID 会复用：机器人被强杀（任务管理器 / 断电 —— `on('exit')` 不跑）
 * 之后锁文件残留，**那个 PID 很快会被别的进程用掉** ⇒ 探活成功 ⇒ 新实例被
 * 一句「已经有本机器人在跑了」挡住，**而其实没有**。
 *
 * 实测：`test/punctuation.js` 连续两轮回归都失败，就是它 —— 残留锁里的 PID
 * 被复用，它起的探针机器人每次都进不去（锁文件时间戳停在 20:32，再也没更新过）。
 * ⚠️ 同样的事会发生在**用户身上**：强杀过机器人一次，之后双击启动就没反应，
 *    屏幕上只有一句"已经有本机器人在跑了"，而他看不见任何实例。
 *
 * 解法：运行期间**每 30 秒蹭一次锁文件的 mtime**，判定时要求
 * 「PID 活着 **并且** 锁在 5 分钟内被蹭过」才认定真有实例。
 * 强杀留下的锁，最多 5 分钟后就不再挡人；正常运行的机器人一直在蹭，照挡不误。
 *
 * ⚠️ 阈值（5 分钟 = 10 个心跳）故意放宽：宁可多等一会儿，也别在机器人
 *    正常运行时误判成"它死了"而放进第二个实例 —— 那后果（重复发消息、
 *    两个进程写同一批 state）比"多等 5 分钟"严重得多。
 */
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_BEAT_MS = 30 * 1000;

/**
 * 问操作系统：**这个 PID 现在这个进程**是什么时候启动的（Unix 毫秒）。
 *
 * ⚠️⚠️ 2026-09-23 加（实测踩到：重启时**新实例拒绝启动，机器人起不来**）。
 *    那次：旧机器人的 PID 被**别的进程复用了**，而旧机器人 10 秒前刚打过心跳
 *    ⇒「PID 活着 + 心跳新鲜」两条都成立 ⇒ 判成"还有实例在跑" ✗
 *    根子在于：`process.kill(pid, 0)` 只能说明**那个 PID 有进程**，
 *    说明不了**那是机器人**。
 *    ⇒ 所以拿锁里记的 `startedAtMs` 去核对：**这个 PID 此刻的启动时间**和它差太多，
 *      就说明 PID 被复用了 ⇒ 是残留的锁，照常启动。
 *
 * ⚠️ **只在检出锁冲突时才调**（启动路径上一次），那点开销无所谓。
 * ⚠️ 拿不到就返回 `null` —— 那就退回原来的判据。
 *    **绝不因为"查不到"就把人挡住**：宁可偶尔多起一个（有别的机制兜），
 *    也不能让机器人永远起不来。
 */
function liveProcStartMs(pid) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        // ⚠️ 必须 `.ToUniversalTime()` —— `.StartTime` 是**本地时间**，
        //    直接拿 `.Ticks` 当 UTC 换算会**整整差一个时区**（实测差 8 小时，
        //    于是"和锁里记的对不上"永远成立 ⇒ 会把**真的在跑的实例**误判成残留）。
        `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`,
      ],
      { encoding: 'utf8', timeout: 4000 },
    ).trim();
    const ticks = Number(out);
    if (!Number.isFinite(ticks) || ticks <= 0) return null;
    // .NET ticks 从 1601-01-01 起算（1 tick = 100ns）→ Unix 毫秒
    return ticks / 10000 - 62135596800000;
  } catch {
    return null; // 查不到（没权限 / PS 不可用）—— 交给上层按原判据走
  }
}

function lockHolder() {
  let raw;
  let mtimeMs = 0;
  try {
    raw = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    mtimeMs = statSync(LOCK_FILE).mtimeMs;
  } catch {
    return null; // 没有锁文件 / 内容坏了 ⇒ 当作没人在跑
  }
  const pid = Number(raw?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (e) {
    if (e.code === 'EPERM') alive = true; // 活着，只是没权限给它发信号
  }
  if (!alive) return null; // ESRCH：那个 PID 早没了 ⇒ 是残留的锁

  // ⚠️⚠️ PID 活着 ≠ 那是机器人（2026-09-23 实测）：
  //    重启时新实例拒绝启动，查出来是**旧机器人的 PID 被别的进程复用了**，
  //    而心跳还新鲜（旧机器人 10 秒前刚打过）⇒ 两条判据全成立 ⇒ 误判成"还有实例"。
  //    ⇒ 用锁里记的启动时间核对：对不上就是复用，判为残留。
  //    ⚠️ 老锁没有 `startedAtMs`（这天才加的）⇒ 自动退回原判据，不会因此放行错的。
  const liveMs = liveProcStartMs(pid);
  const lockMs = Number(raw?.startedAtMs);
  if (liveMs !== null && Number.isFinite(lockMs) && lockMs > 0 && Math.abs(liveMs - lockMs) > 60000) {
    log.warn(
      `锁里的 PID ${pid} 现在这个进程的启动时间（${new Date(liveMs).toLocaleString('sv-SE')}）` +
        `和锁里记的（${new Date(lockMs).toLocaleString('sv-SE')}）对不上 —— ` +
        `那是 PID 被复用成了别的进程，不是机器人。这次照常启动。`,
    );
    return null;
  }

  if (mtimeMs && Date.now() - mtimeMs > LOCK_STALE_MS) {
    log.warn(
      `锁文件里的 PID ${pid} 现在**有**进程占着，但锁已经 ` +
        `${Math.round((Date.now() - mtimeMs) / 1000)} 秒没更新过 —— ` +
        `那是 PID 被复用成了别的进程，不是机器人。这次照常启动。`,
    );
    return null;
  }
  return raw;
}

const holder = lockHolder();
if (holder && Number(holder.pid) !== process.pid) {
  log.error('已经有本机器人在跑了 —— 这一次不启动。');
  log.error(`  · 那个实例：PID ${holder.pid}（启动于 ${holder.startedAt ?? '未知'}）`);
  log.error(`  · 锁文件：${LOCK_FILE}`);
  log.error('  重复实例会让主动接话 / 说说 / 剧情重复发，甚至"一条消息回两次"。');
  log.error('  要重启它：先停掉那个进程（或双击「停止机器人.bat」），再启动。');
  log.error(`  确认它早就不在了（任务管理器里强杀过、或者断过电）？删掉锁文件再试：${LOCK_FILE}`);
  log.error('  （不删也行：它超过 5 分钟没有心跳，就自动不再挡人了。）');
  process.exit(1);
}

try {
  writeFileSync(
    LOCK_FILE,
    JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toLocaleString('sv-SE'),
        // ⚠️ 2026-09-23 加：**数值型的启动时间**，给 `lockHolder()` 核对 PID 复用用
        //    （`startedAt` 那串是给人看的，比不了）。
        startedAtMs: Date.now(),
        argv: process.argv.slice(1).join(' '),
      },
      null,
      2,
    ),
  );
} catch (e) {
  // 锁写不成不该拦住启动（比如 state/ 不可写）—— 只能说单例保护这次没生效
  log.warn(`单例锁没写成（不影响运行，但这次没有重复实例保护）：${e.message}`);
}

/**
 * 心跳：运行期间每 30 秒把锁文件的 mtime 蹭一下（**只动时间，不动内容**）。
 *
 * ⚠️ 这是 `lockHolder()` 里那套"陈旧判定"的另一半 —— 没有它，
 *    那个 5 分钟阈值会把**正在正常运行的**机器人也判成死的。
 * ⚠️ 必须在写锁**之后**起：第一次蹭之前，mtime 本来就是刚写锁的时间。
 * ⚠️ `unref()`：别让这个计时器把进程吊住不退（退出照旧走 `releaseLock`）。
 * ⚠️ 蹭失败**不报警**（比如锁被人删了）：这只影响"重复实例保护"的强度，
 *    每次刷一行警告反而会盖掉真正重要的日志。
 */
const lockBeat = setInterval(() => {
  try {
    const cur = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (Number(cur?.pid) !== process.pid) return; // 锁已经是别人的了，别去蹭
    const now = new Date();
    utimesSync(LOCK_FILE, now, now);
  } catch {}
}, LOCK_BEAT_MS);
if (typeof lockBeat.unref === 'function') lockBeat.unref();

/** 只删**自己的**那把锁 —— 别把后来者的锁删了 */
function releaseLock() {
  try {
    const cur = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (Number(cur?.pid) === process.pid) rmSync(LOCK_FILE, { force: true });
  } catch {}
}
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    releaseLock();
    process.exit(0);
  });
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
/**
 * ⚠️ 2026-10-07 加：**连接心跳**（用户报「经常漏消息，@ 了也不回」）。
 *
 * ## 现场（有证据）
 *   爱音的 ws 连接**半死**：SnowLuma 日志里最近十几条群事件**一条都没推给它**
 *   （主号照收），而它自己的日志**停在 05:23 的「连接成功」** —— 之后 9 个多小时
 *   **既没有断连、也没有重连**。TCP 半开：对面早断了，这边以为还连着 ⇒
 *   永远不重连、永远收不到任何消息 ✗（最迷惑人的是**什么都不报**）
 *   ⚠️ 触发条件很常见：**协议端重启**（今晚为了配多号端口就重启了好几次）——
 *      那种断法有时**不触发前端的 close 事件**。
 *
 * ## 为什么用心跳，而不是「多久没收到群消息就重连」
 *   群里**半夜本来就可能几小时没人说话** ⇒ 那个判据会**误重连**
 *   （半夜自己反复掉线重连，比原问题还糟）。
 *   心跳**不管群里有没有人都准**。
 *
 * ## 参数（别调太急）
 *   · 每 30 秒问一次；
 *   · 单次 8 秒没回应算一次失败；
 *   · **连续 2 次**才动手（最坏 ~76 秒发现，够快，也不神经质）。
 *
 * ⚠️ 探活用 `get_login_info` 而**不是** `get_status`：前者是所有 OneBot 实现都有的
 *    基础 action，也在这套代码里被用过（webui 那边）；`get_status` 万一某家协议端
 *    没实现，心跳会把**好连接误判成死的** ⇒ 变成反复重连（那就比原问题还糟）。
 */
const HB_MS = 30000;
const HB_TIMEOUT_MS = 8000;
const HB_MAX_FAIL = 2;

function connectForward() {
  const url = config.onebot.url;
  // ⚠️ 2026-09-21：别再写死 NapCat —— 协议端换成 SnowLuma 之后这句是误导的
  //    （和看门狗那句"已连接到 NapCat"同一类毛病，那次害得看门狗一直误报）
  // ⚠️⚠️ 注意是 `provider.name()` —— `provider.js` 导出的是**函数**，不是属性。
  //    写成 `provider.name` 会打出 `function name() {`（2026-09-21 我这么踩了一次，
  //    幸好日志里一眼就看出来了）。
  log.info(`正在连接协议端（${provider.name()}）：${url}`);

  const headers = {};
  const token = config.onebot.accessToken?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  const ws = new WebSocket(url, { headers });

  ws.on('open', () => {
    log.info('连接成功');
    bot.attach(ws);
    startHeartbeat();
    // ⚠️ 重连 = 可能"刚掉线恢复" → 立刻查一次月末工资单要不要补发
    //    （用户要求：「如果因为 QQ 掉线正好没发送，当恢复上线之后马上补发」）
    setTimeout(() => {
      bot.checkMonthlyReport?.().catch((e) => log.debug(`月结补发检查失败：${e.message}`));
    }, 5000);
  });

  // ── 心跳（见上面常量那段注释）────────────────────────────
  let hbTimer = null;
  let hbFails = 0;
  let hbBusy = false;

  function startHeartbeat() {
    stopHeartbeat();
    hbFails = 0;
    hbTimer = setInterval(async () => {
      if (hbBusy || ws.readyState !== WebSocket.OPEN) return;
      hbBusy = true;
      try {
        const r = await Promise.race([
          bot.call('get_login_info'),
          new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), HB_TIMEOUT_MS)),
        ]);
        if (r === undefined || r === null) throw new Error('没有回应');
        hbFails = 0;
      } catch (e) {
        hbFails += 1;
        log.warn(`[心跳] 协议端没回应（${hbFails}/${HB_MAX_FAIL}）：${e.message}`);
        if (hbFails >= HB_MAX_FAIL) {
          hbFails = 0;
          log.error('[心跳] 连续没回应 —— 判定这条连接已经死了（TCP 半开那种），主动断开重连');
          // ⚠️ 用 `terminate()` 而不是 `close()`：半开状态下 `close()` 的挥手
          //    可能永远等不到对面回应 ⇒ 只能强拆。它**会**触发下面的 `close` 事件，
          //    于是照常走"3 秒后重连"那条路。
          try {
            ws.terminate();
          } catch {}
        }
      } finally {
        hbBusy = false;
      }
    }, HB_MS);
    hbTimer.unref?.();
  }

  function stopHeartbeat() {
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = null;
    hbBusy = false;
  }

  ws.on('error', (err) => {
    log.warn(`连接失败: ${err.message}`);
  });

  ws.on('close', (code) => {
    stopHeartbeat();
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
// ⚠️ 协议端（2026-09-17 加）：**收发跟它无关**，但它决定"出码/重启"这些管理能力有没有
log.info(` 协议端   : ${provider.info().label}（管理能力：${Object.entries(provider.info().caps).filter(([, v]) => v).map(([k]) => k).join('/') || '仅收发'}）`);
// ⚠️ 2026-09-20 加：**接入点被外部覆盖**时明确打出来。
//    支持命令行参数（`--onebot-url` / `--onebot-token` / `--bot-qq`）和环境变量
//    （`QQBOT_ONEBOT_URL` / `QQBOT_ONEBOT_TOKEN` / `QQBOT_BOT_QQ`），
//    优先级：**参数 > 环境变量 > config.yml**。
//    ⚠️ 没有这一行，"我在 config.yml 里明明改了、怎么不生效"这种问题得查半天。
if (Array.isArray(config.__overridden) && config.__overridden.length) {
  log.info(` 外部覆盖 : ${config.__overridden.join('，')}（来自命令行参数 / 环境变量，**优先于 config.yml**）`);
}
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
// ⚠️ 2026-10-05 加：同类机器人搭话的定时器（群里冷场时才动，见 src/peer-chat.js）
try {
  peerChat.start(bot);
} catch (e) {
  console.error(`[同类] 启动失败（不影响其它功能）：${e.message}`);
}

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

// ⚠️⚠️ 2026-10-10 加（用户要求：「**如果有人 @bot 让她在服务器重新开启的时候提醒一下、
//    @他，可以做到吗**」）：
//    **触发点**在 `sessions.tick()` 那条「服务器恢复了」的分支里 ——
//    那是唯一做了「**连续 3 次查不到才算真关过**」确认的地方 ✓
//    这里只负责：**取走订阅 + 逐条 @ 出去**（`server-watch.js` 只管存，
//    发消息是 bot 的事 —— 所以接线挂在这儿，不挂在 sessions 里）✓
sessions.setOnServerBack(async (players) => {
  const pending = serverWatch.takeAll();
  for (const s of pending) {
    try {
      await bot.sendToGroup(s.gid, serverWatch.textFor(s, players), {
        at: s.uid,
        atName: s.name,
      });
      log.info(`[开服提醒] 已 @ ${s.uid}（群 ${s.gid}）：${serverWatch.textFor(s, players)}`);
    } catch (e) {
      log.warn(`[开服提醒] 给 ${s.uid}（群 ${s.gid}）发失败：${e.message}`);
    }
  }
});

// 网络可达性探测（2026-09-12 加，用户要求）// 群里老有人问「你能上油管吗 / 能不能翻墙」—— 这个后台每 5 分钟探一次，
// 结果会拼进「电脑状态」那段提示词，让她能如实回答而不是含糊其辞。
try {
  machine.startNetworkProbe();
  log.info('网络可达性探测已启动（每 5 分钟一次，国内 + 海外两组）');
} catch (e) {
  log.debug(`网络探测启动失败（不影响其他功能）：${e.message}`);
}

// ⚠️⚠️ 2026-10-03 加：**电脑状态也改成后台采集**（原来在拼提示词时同步跑 3 条 PowerShell
//    ⇒ 分段计时实测「第8段前=3679ms」，也就是**每条消息白等 3~4 秒**）。
//    这里先采一次，之后每 30 秒刷一次；拼提示词时只读缓存。
try {
  machine.startMachineProbe();
  log.info('电脑状态采集已启动（后台，每 30 秒一次；拼提示词只读缓存）');
} catch (e) {
  log.debug(`电脑状态采集启动失败（不影响其他功能）：${e.message}`);
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

// ── 协议端自愈（2026-10-06 用户要求）──
// 实测：SnowLuma 跑约 2 小时后短暂抖过 1 分钟（3001 没人听、进程却还在），
// 那段时间机器人只能 ECONNREFUSED 反复重连 —— 用户看到的就是"她不回话"。
// ⚠️ 只探端口 + 只启动，**绝不杀任何进程**（要"找出哪个是协议端"就得按命令行匹配，
//    而那条路会打中 DSH 的 runner 自己 —— 项目里踩过两次）⇒ 完整说明见 `src/provider-watch.js` 顶部。
try {
  providerWatch.start();
} catch (e) {
  log.debug(`协议端自愈启动失败（不影响其他功能）：${e.message}`);
}

// ── 自动清理临时产物（2026-10-06 用户要求）──
// 用户原话：「机器人自己 QQ 的聊天文件缓存占多少？我觉得可以加个自动清理的功能了，
//   因为对机器人没用」。
// ⚠️ 只删**临时产物**（群友发来的文件缓存 / 测试临时目录 / 按天日志 / 待审表情）——
//    白名单（`*.md` / `*.json` / `*.bak-*` / `*备份*`）**永不碰**，见 `src/cleanup.js`。
// ⚠️ 启动时**先清一次**（顺手把前几天攒的收掉），但**延后 20 秒** ——
//    别跟"连协议端 / 恢复群上下文"那几件正事抢启动时间。
if (config.cleanup?.enable !== false) {
  const every = config.cleanup?.intervalMs ?? 6 * 3600 * 1000;
  const tick = (why) => {
    try {
      const r = cleanup.run();
      if (r.deleted?.length) {
        log.info(
          `[清理] ${why}：清了 ${r.deleted.length} 项，省 ${(r.freedBytes / 1048576).toFixed(1)} MB`,
        );
      }
    } catch (e) {
      log.debug(`[清理] ${why}出错：${e.message}`);
    }
  };
  setTimeout(() => tick('启动清理'), 20000).unref();
  setInterval(() => tick('定期清理'), every).unref();
  log.info(
    `自动清理：启动后 20 秒清一次，之后每 ${Math.round(every / 3600000)} 小时一次` +
      `（保留：文件缓存 ${config.cleanup.uploadedDays} 天 / 临时目录 ${config.cleanup.tmpDays} 天 /` +
      ` 日志 ${config.cleanup.logDays} 天 / 待审表情 ${config.cleanup.pendingDays} 天）`,
  );
}

// ── 「他的资料」自动更新（2026-10-03 用户要求）──
// 用户原话：「我和她聊到**我的生活有什么变化**时，**我的资料库里面的对应的信息应该要自动更新**，
//   比如**毕业了**」+「**不用分区，直接修改**」「我可以去检查来修正错误」「**完全后台**」。
// ⚠️ 这里只管"定期问一句该不该核对"，判断和写入都在 `ownerUpdate.maybeUpdate()` 里。
//    频率很低（默认 5 分钟问一次，攒够 6 条他私聊的话才真跑）—— 所以这个定时器很轻。
if (config.ownerUpdate?.enable !== false) {
  const every = config.ownerUpdate?.checkIntervalMs ?? 300000;
  setInterval(() => {
    ownerUpdate
      .maybeUpdate()
      .then((r) => {
        if (r.ok && r.changed) log.info(`[资料] 这次自动改了 ${r.changed} 处`);
      })
      .catch((e) => log.debug(`[资料] 检查出错：${e.message}`));
  }, every).unref();
  log.info(
    `他的资料自动更新：每 ${Math.round(every / 60000)} 分钟问一次，` +
      `他私聊攒够 ${config.ownerUpdate.minMessages} 条就核对一遍 owner.md（改前自动备份）`,
  );
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

        // ⚠️⚠️ 2026-09-18 修（用户截图：「**二级剧情进行时，一级事件不应该插进来**」）：
        //    下面那次掷骰只管"**这一格**要不要开新剧情"，它**不知道这个群已经有一条在跑** ——
        //    于是剧情演到第 2、3 段时，后面那些格子照样掷骰、照样发日常，
        //    结果就是「她刚说完换班的事，紧跟着又冒出一句放学去打工」。
        //    所以先加一道：**这个群有在跑的剧情 → 整格让给它**（不消费槽位、不记账、不写故事线）。
        //    ⚠️ 用 `quest.current(g)`：同步、无副作用、不额外调模型。
        if (quest.current(g)) {
          log.debug(`[日常] 群 ${g} 有正在跑的剧情 → 这一格不插日常`);
          continue;
        }

        // ★ 先掷骰：这个群这一格是一级还是二级？
        //   ⚠️ 每个 1 档群**各掷各的**（<主人> 选的是"每个群各跑一条"）。
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
  /**
   * 定时自动推进（30 分钟那条路）用的 `ask`。
   *
   * ⚠️⚠️⚠️ 2026-10-07 修（用户：「**查一下为什么现在剧情永远不会跟着那扇门写的走**」）：
   *   这里原来是**最裸的 `streamChat(messages)`** —— 既没关思考链、也没抬 max_tokens，
   *   于是它跟另外两条路（`bot.js` 的 `questAsk()` / `webui.js` 的 `llmAsk`）**不一致**，
   *   而那两处的注释里明明写着「参数必须对齐：16000 tokens / 150 秒 / 关思考」✗
   *
   *   实测后果（`logs/bot-2026-10-07.log` 里两行连着出现）：
   *     `[06:24:23] WRN LLM 输出被 max_tokens(8000) 截断了（其中思考链吃了 8000 token）`
   *     `[06:24:23] INF [剧情] 群 200000001 到点了但这次没推进：模型没给出内容，保持原状`
   *   ⇒ 起因里的硬条件要求越硬（"必须做到 X 才能出去"），模型**思考得越久**
   *     ⇒ 8000 token 全被思考链吃光、**正文一个字都没产出**
   *     ⇒ `advance()` 只能"保持原状" ⇒ **卡在同一段**，每 30 分钟原样重演一次
   *     ⇒ 用户看到的就是「**剧情永远不往那件事上走**」——
   *        其实不是绕开，是**整条线在那一段上停摆了**。
   *
   * ⚠️ 别再退回裸调用：`config.llm.thinkingBudget`（默认 3000）**管不住思考链** ——
   *   它实测能烧满整个 max_tokens（见 `llm.js` 里那条注释）。要省就只能显式关掉。
   */
  const ask = async (messages) => {
    let out = '';
    for await (const d of streamChat(messages, undefined, {
      maxTokens: 16000,
      timeoutMs: 150000,
      thinking: { type: 'disabled' },
    })) {
      out += d;
    }
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

  /**
   * 结局播报（2026-09-17 用户要求）。
   *
   * 用户原话：「加一个二级剧情结局展示，**跟在机器人发的剧情最后一句话之后
   *   一秒钟发送**，内容首先展示本次剧情结束，这次是好/坏结局，
   *   哪些人加/减了多少好感度」。
   *
   * ⚠️ 用 `sendToGroup`（**不进聊天上下文**）—— 跟 `/好感度` 排行榜一个路子。
   *    进上下文的话，她下次说话会把这一整块当成群里聊过的内容。
   * ⚠️ 也**不 @ 任何人**：@ 会弹通知，那道口子只留给"余额见底催充值"。
   */
  const reportEnding = (q, r) => {
    const text = quest.endingReport(r, (uid) => names.label(uid, q.groupId));
    if (!text) return; // 一个人都没参与 → 没什么可播报的
    const gid = q.groupId || life.targetGroups()[0];
    if (!gid) return;
    setTimeout(() => {
      bot
        .sendToGroup(gid, text)
        .catch((e) => log.warn(`[剧情] 结局播报发送失败：${e.message}`));
      log.info(
        `[剧情] 结局播报 → 群 ${gid}（${r.ending === 'good' ? '好' : '坏'}结局，${r.applied.length} 人）`,
      );
    }, quest.ENDING_REPORT_DELAY_MS).unref?.();
  };

  /** 结算：结局 → 好感度（只有参与过的人加），随后播报结局 */
  const settleQuest = (q, ending) => {
    // ⚠️ 剧情结局的加减分**记在这个剧情所在的群**（好感度 2026-09-15 晚起按群）
    const r = quest.settle(q, ending, (uid, d, o) => affinity.adjust(uid, d, { ...o, groupId: q.groupId }));
    if (r.cast.length) log.info(`[剧情] ${ending === 'good' ? '好' : '坏'}结局，给 ${r.cast.length} 人各 +${r.delta} 好感度`);
    reportEnding(q, r);
    return r;
  };

  /**
   * 推**一个群**的剧情。
   * ⚠️ 分群之后（2026-09-15 <主人>：「每个群各跑一条」）—— 外面要**挨个群**调。
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

    // ⚠️⚠️⚠️ 2026-10-07 加（用户：「**为什么现在一直在无意义聊天而且还一直没有自动结束**」）：
    //    **绝对时长上限** —— 从头算起，跟"有没有人说话"完全无关。
    //
    //    原来只有下面那条 `due()`（"隔一会儿推进一段"），而它会被互动不断刷新
    //    ⇒ **永远不到点**；而收尾的三条路（模型给 done / 冷场 / `MAX_STAGES` 硬上限）
    //    **都得靠"推进"才走得到** ⇒ 那条线可以无限往下滚 ✗
    //    （实测：那条 07:22 开的剧情，两个号一路滚到用户下午回到电脑前。）
    //
    //    ⇒ 到点就**强制收个结局**，保证一定结束。
    if (quest.overdue(Date.now(), gid)) {
      log.info(
        `[剧情] 群 ${gid} 这条线已经超过时长上限 → **强制收尾**（${String(q.premise ?? '').slice(0, 30)}…）`,
      );
      const r0 = await quest.advance(q, { ask, forceEnd: 'bad' });
      if (r0?.ok) {
        await sendQuestLine(q, r0.text);
        settleQuest(q, r0.ending ?? 'bad');
      } else {
        // ⚠️ 模型没给出内容也不能就这么卡着 —— 直接按坏结局收掉
        log.warn(`[剧情] 群 ${gid} 强制收尾没写成（${r0?.reason}）→ 直接结算`);
        settleQuest(q, 'bad');
      }
      return;
    }

    if (!quest.due(Date.now(), gid)) return; // 还没等够（默认 30 分钟 / warm 时 10 分钟）    // 掉线时先不推进：发不出去，推进了这一段就白生成了
    // （下一轮 tick 会再看一次；`due()` 不会因为等更久而失效）
    if (!bot.selfId) {
      // ⚠️ 2026-09-18 从 debug 提到 **info**（用户报「正在跑的剧情卡住不动」）：
      //    `logLevel` 是 info，**debug 根本不写盘**，所以"剧情为什么没推进"查不到 ——
      //    那天翻日志只看到"每 60 秒检查一次"，别的什么都没有，只能靠猜。
      log.info(`[剧情] 群 ${gid} 到点了，但还没登录 QQ → 先不推进`);
      return;
    }

    const r = await quest.advance(q, { ask });
    if (!r.ok) {
      // ⚠️ 同上：这条也提到 info —— 它是"剧情卡住"最可能的原因，必须看得见。
      log.info(`[剧情] 群 ${gid} 到点了但这次没推进：${r.reason}`);
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
   * ⚠️⚠️ 2026-09-15 **分群**：**每个 1 档群各掷各的**（<主人> 选的是"每个群各跑一条"）。
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
      // ⚠️⚠️ 2026-09-18（用户报「好感度到 90 了，发了好友邀请但没自动通过」）：
      //    顺手扫一遍**可疑好友申请** —— QQ 会把一部分好友申请判成"可疑"，
      //    那类**不走标准的 `friend_add` 通知**（NapCat 日志里因此一条都没有，
      //    而 `friend.json` 的 friends 也是空的），得主动去那个队列里拿。
      //    只通过**好感度已经到线**的人，没到线的原样留着（那个队列里也有广告）。
      try {
        const r = await friend.sweepDoubtRequests((action, params) => bot.call(action, params));
        if (r?.approved) log.info(`[好友] 可疑申请扫了 ${r.total} 条 → 通过 ${r.approved} 条`);
      } catch (e) {
        log.debug(`[好友] 扫可疑申请出错：${e.message}`);
      }
      // ⚠️ 2026-10-07 加（用户要求：「主动私聊改了就行了」）：
      //    主动私聊面对的是**同一批人**（主人、好感度到线的好友）——
      //    两个号各自跑 ⇒ **同一个人会被两个号各私聊一次** ✗
      //    ⇒ 只有**主号**主动私聊。
      //    ⚠️ 上面那个"扫可疑好友申请"两个号都留着 —— 各自的号加各自的好友，
      //      那是应该的（不该收成主号）。
      //    ⚠️ `isMainAccount()` 在单号 / 还没拆分时恒为 true ⇒ 老行为一个字不变。
      if (!isMainAccount()) {
        log.debug('[好友] 不是主号 → 主动私聊交给主号，这次跳过');
        return;
      }
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

// ⏰ **定时提醒**（2026-09-18 用户要求）—— 每分钟看一次有没有到点的。
// ⚠️ 到点就发，**不判断"晚了多久"**：如果他定的时候机器人正好掉线，
//    登录后时间已经过了 —— 这时候**照样要发**（他等的是这个提醒，
//    晚几分钟发出来远比不发有用；`sendChatLike` 那边"补看"逻辑也是这个取向）。
if (config.remind?.enable !== false) {
  const every = Math.max(15000, Number(config.remind?.checkIntervalMs) || 60000);
  // ⚠️⚠️ 发不出去就一直重试，**只给 2 小时**（`giveUpMs`）。
  //    原来写的是"连续 5 次就放弃" —— 那只有 **5 分钟**：这个号本来就每几小时掉一次线，
  //    而提醒多半定在他睡觉/不在的时段（凌晨）→ 掉线 5 分钟，这条提醒就**悄悄没了** ✗。
  //    提醒这件事的价值全在"到点说出来"，所以宁可多试（每分钟一次，最多 120 次）。
  const giveUpMs = Math.max(60000, Number(config.remind?.giveUpMs) || 2 * 3600 * 1000);
  // ⚠️⚠️⚠️ 2026-10-08 加（用户看着那 12 条 9 月的提醒问：
  //    「**真人的都是已经过去的事情，为什么不会自动删除**」）：
  //    **到点太久还发不出去的，直接丢掉，不再重试。**
  //
  //    原来只有下面那个 `fails`（内存 Map）+ `giveUpMs`（2 小时）——
  //    而**内存态一重启就归零**，机器人本来就每天重启几次
  //    （2026-10-07 那晚我自己就重启了十几次）⇒ 那 2 小时**永远等不到**
  //    ⇒ 发不出去的提醒**永远挂着** ✗✗（9 月定的躺到 10 月都没清）
  //    ⇒ 换一条**跟重启无关**的判据：**看提醒自己到点多久了**（见 `remind.stale()`）✓
  const staleMs = Math.max(60000, Number(config.remind?.staleMs) || 24 * 3600 * 1000);
  const sweepStale = () => {
    for (const it of remind.stale(Date.now() - staleMs)) {
      remind.markSent(it.id);
      log.warn(
        `[提醒] 到点已经超过 ${Math.round(staleMs / 3600000)} 小时还没发出去 → 丢掉（不再重试）：` +
          `${String(it.what).slice(0, 40)}`,
      );
    }
  };
  const fails = new Map(); // id → {n, since}
  const tick = async () => {
    // ⚠️ 先清理过期的（跟重启无关的那道），再处理到点的 ✓
    try {
      sweepStale();
    } catch (e) {
      log.warn(`[提醒] 清理过期失败：${e.message}`);
    }
    for (const it of remind.due()) {
      const f = fails.get(it.id) ?? { n: 0, since: Date.now() };
      try {
        await bot.sendReminder(it);
        remind.markSent(it.id);
        fails.delete(it.id);
        log.info(`[提醒] 到点已发出：${it.what.slice(0, 40)}（${it.groupId ? `群 ${it.groupId}` : '私聊'}）`);
      } catch (e) {
        f.n++;
        const waited = Date.now() - f.since;
        if (waited > giveUpMs) {
          remind.markSent(it.id);
          fails.delete(it.id);
          log.warn(
            `[提醒] 试了 ${f.n} 次（${Math.round(waited / 60000)} 分钟）都发不出去，只能放弃：${it.what.slice(0, 40)}`,
          );
        } else {
          fails.set(it.id, f);
          // ⚠️ 降噪：只在第 1 次、以后每 10 次打一条（不然每分钟一条会把日志刷满）
          if (f.n === 1 || f.n % 10 === 0) {
            log.warn(
              `[提醒] 暂时发不出去（第 ${f.n} 次，会一直试到 ${Math.round(giveUpMs / 60000)} 分钟）：${e.message}`,
            );
          }
        }
      }
    }
  };
  setInterval(tick, every).unref();
  setTimeout(tick, 20 * 1000).unref();
  const rst = remind.status();
  log.info(
    `定时提醒：每 ${Math.round(every / 1000)} 秒查一次` +
      `${rst.pending ? `，重启前挂着的还有 ${rst.pending} 条（不会丢）` : ''}`,
  );
}

// 💬 **空间评论回复**（2026-09-28 加，用户要求：「回复自己发的说说下面的评论」）。
//
// ⚠️ 这条路**自己拼 HTTP 调空间接口**（协议端没有这个能力 —— SnowLuma 的
//    `get_qzone_msg_list` 只给评论**数量**、也没有发评论的 action）。
//    风险和"发说说"完全一样（风控 / 接口未公开 / 长期维护），
//    说明和两个接口的实测结论都在 `src/qzone-comment.js` 顶部。
//    出问题就把 `qzone.comment.enable` 设成 false —— **不影响发说说**。
if (config.qzone?.comment?.enable !== false) {
  const qc = config.qzone?.comment ?? {};
  const every = Math.max(60000, Number(qc.intervalMs) || 10 * 60 * 1000);
  let busy = false; // 上一轮还没跑完就跳过（别把请求叠起来）
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await qzoneComment.checkOnce({
        call: (a, p) => bot.call(a, p),
        // ⚠️ 那份"按名字"的机器人名单只有 bot 实例有（见 src/qzone-comment.js 的 isKnownBot）。
        //    不传的话，她会去回 `Alone゜独白ぴ` 那种机器人的评论。
        isBot: (uin, name) => Boolean(name && bot.ignoreBots?.has(name)),
      });
      if (r.replied) log.info(`[空间评论] 这一轮回了 ${r.replied} 条`);
      else if (r.skipped && !/没有要回的/.test(r.skipped)) {
        log.debug(`[空间评论] 这轮没回：${r.skipped}`);
      }
    } catch (e) {
      // ⚠️ 出错只记日志 —— 这条路**绝不能影响主流程**（收发消息才是主业）
      log.warn(`[空间评论] 检查出错：${e.message}`);
    } finally {
      busy = false;
    }
  };
  setInterval(tick, every).unref();
  setTimeout(tick, 90 * 1000).unref(); // 开机先等 90 秒，别刚连上就去调空间接口
  log.info(
    `空间评论：每 ${Math.round(every / 60000)} 分钟看一次` +
      `（只回最近 ${qc.days ?? 3} 天、每条评论只回一次、每天最多 ${qc.maxPerDay ?? 5} 条）`,
  );
}

// 每分钟打一次运行状态，方便确认还活着
setInterval(() => {
  const h = bot.stats;
  log.debug(`运行中 · 收到 ${h.received} · 回复 ${h.replied} · 失败 ${h.failed}`);
}, 60000).unref();
