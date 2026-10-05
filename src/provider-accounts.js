/**
 * 协议端那边的「多账号」—— 给每个 QQ 号开一个 OneBot WebSocket 端口（2026-10-07 加）。
 *
 * ## 为什么需要
 *
 * 用户要求「从一个应用端控制多个 QQ 号」。一个号一个进程，每个进程都要**连一个
 * OneBot 端点** —— 而协议端（SnowLuma）是**按 QQ 号分文件**存配置的：
 *
 *   `C:\SnowLuma\config\onebot_<QQ>.json`
 *     └─ networks.wsServers[] ← 这个号对外开放的 WebSocket 端口（谁连上就代表这个号）
 *
 * 所以"加一个号"在协议端这边要做的只有两件事：
 *   ① 往那个号的配置文件里加一个 `wsServers` 项（端口 + token）；
 *   ② 重启协议端让它加载。
 * 然后把它写进我们的 `accounts/<QQ>.yml`（`onebot.url` / `accessToken`），
 * 那个号的进程就能连上了。
 *
 * ⚠️ **登录那一步我们做不了**：新号必须在协议端自己的界面里先登上去
 *    （扫码），SnowLuma 才会为它生成配置文件。所以我们只做"配端口 + 重启"，
 *    界面上要如实告诉用户"先去协议端把这个号登进来"。
 *
 * ## ⚠️⚠️ 杀进程的红线（这个模块会重启协议端，务必看清）
 *
 * **绝不按命令行文本匹配找进程** —— DSH 跑命令时外面套的 runner 本身就是
 * `node.exe`，而它的命令行里带着整段脚本原文 ⇒ 过滤条件必然命中它自己，
 * 结果是把正在执行命令的进程杀掉（`exit code 4294967295`，什么都不输出）。
 * 这里一律走**端口归属**：`Get-NetTCPConnection -LocalPort <端口> -State Listen`
 * 拿到的 `OwningProcess` 就是监听那个端口的进程，干净、精确、不碰 CommandLine。
 * 并且杀之前还要核对它的 `Path` 确实在协议端目录下（防误杀别的程序）。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, copyFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';

/** 协议端目录（`provider.dir`，例如 `C:\SnowLuma`） */
function lumaDir() {
  return String(config.provider?.dir ?? '').trim();
}

/** 这个功能目前只对 SnowLuma 实现（别的协议端没有"按号分文件"这套东西） */
export function supported() {
  const name = String(config.provider?.name ?? '').trim().toLowerCase();
  return name === 'snowluma' && !!lumaDir() && existsSync(join(lumaDir(), 'config'));
}

export function unsupportedReason() {
  const name = String(config.provider?.name ?? '').trim().toLowerCase();
  if (name !== 'snowluma') {
    return `当前协议端是「${name || '没配'}」—— 「自动配端口」只对 SnowLuma 做过；` +
      '请去那个协议端自己的界面里给新号开一个 OneBot WebSocket 端口，然后把地址和 token 填进这个号的配置。';
  }
  if (!lumaDir()) return 'config.yml 里没填 provider.dir（协议端目录），找不到它的配置文件';
  return `找不到协议端的配置目录：${join(lumaDir(), 'config')}`;
}

/** 某个号在协议端那边的配置文件 */
export function fileOf(qq) {
  return join(lumaDir(), 'config', `onebot_${String(qq).trim()}.json`);
}

/** 协议端里**已经配过**的号（按配置文件列） */
export function knownAccounts() {
  try {
    return readdirSync(join(lumaDir(), 'config'))
      .map((n) => (/^onebot_(\d{5,12})\.json$/.exec(n) ?? [])[1])
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readJson(qq) {
  try {
    return JSON.parse(readFileSync(fileOf(qq), 'utf8'));
  } catch {
    return null;
  }
}

/** 某个号在协议端配的 ws 端口（没配 → 0） */
export function wsPortOf(qq) {
  const j = readJson(qq);
  const list = j?.networks?.wsServers ?? [];
  for (const s of list) {
    const p = Number(s?.port);
    if (Number.isInteger(p) && p > 0) return p;
  }
  return 0;
}

/**
 * 所有号已经占用的 ws 端口（挑新端口时要避开）。
 * @param {string} [exceptQq] 排除这个号自己（用来判断"这个端口是不是被**别人**占了"）
 */
export function wsPorts(exceptQq = '') {
  const out = new Set();
  for (const qq of knownAccounts()) {
    if (exceptQq && String(qq) === String(exceptQq)) continue;
    const j = readJson(qq);
    for (const s of j?.networks?.wsServers ?? []) {
      const p = Number(s?.port);
      if (Number.isInteger(p) && p > 0) out.add(p);
    }
  }
  // 主号现在连着的那个端口当然也算占用（它可能还没来得及写进配置文件）
  const cur = String(config.onebot?.url ?? '').match(/:(\d+)/);
  if (cur) out.add(Number(cur[1]));
  return [...out].sort((a, b) => a - b);
}

/**
 * 给一个号挑一个没被占用的 ws 端口。
 * ⚠️ 从 3002 起（3001 是老号在用的，别动它）。
 */
export function nextPort() {
  const used = new Set(wsPorts());
  for (let p = 3002; p < 3202; p++) if (!used.has(p)) return p;
  return 0;
}

/**
 * 给某个号**配好** OneBot ws 端口，并把它写进我们的账号文件。
 *
 * @returns {{ok:boolean, port?:number, token?:string, created?:boolean, reason?:string}}
 */
export function ensure(qq, opt = {}) {
  if (!supported()) return { ok: false, reason: unsupportedReason() };
  const id = String(qq).trim();
  const f = fileOf(id);
  if (!existsSync(f)) {
    return {
      ok: false,
      reason:
        `协议端里还没有号 ${id} 的配置文件 —— 先在协议端自己的界面（${config.provider?.manageUrl || '它的管理页'}）` +
        '把这个 QQ 号登进去（要扫码），登好之后再回来点一次。',
    };
  }
  const j = readJson(id);
  if (!j) return { ok: false, reason: `协议端的配置文件读不了（格式坏了？）：${f}` };

  // ⚠️ 这个 token 只在**新建**那条 wsServer 时才需要现生成（见下面 ③）。
  //    已经配过就沿用原 token —— 每次重新生成会让已经写进账号文件的
  //    accessToken 立刻失效（表现是"重新配一次端口，机器人就连不上了"）。
  let token = String(opt.token ?? '').trim();

  j.networks = j.networks ?? {};
  j.networks.wsServers = Array.isArray(j.networks.wsServers) ? j.networks.wsServers : [];

  // ① ⚠️⚠️ 先清掉"**端口已经被别的号占了**"的那些项（2026-10-07 实测踩到）：
  //    协议端给新账号的默认 wsServer 就是 **3001** —— 于是新号的配置里也有一个 3001，
  //    和主号撞车。当前恰好是主号先抢到（加载顺序），但**顺序一变就会反过来**：
  //    新号占了 3001、主号反而连不上。这种"看运气"的状态必须清掉。
  const wantPort = Number(opt.port) || 0;
  const usedByOthers = new Set(wsPorts(id));
  const removedPorts = [];
  const kept = [];
  for (const x of j.networks.wsServers) {
    const p = Number(x?.port);
    if (Number.isInteger(p) && p > 0 && p !== wantPort && usedByOthers.has(p)) {
      removedPorts.push(p);
      continue;
    }
    kept.push(x);
  }
  j.networks.wsServers = kept;

  // ② 端口怎么定：**显式给的 > 这个号已经配过的（复用！）> 挑一个没被占的**。
  //    ⚠️ 中间那条不能少 —— 2026-10-07 踩到过：不判断"已经配过"的话，
  //      每调一次就再加一个端口（配置里堆成 3002/3003/3004…），
  //      而账号文件只指向最后一个，协议端却要同时监听全部（越配越乱）。
  const already = kept
    .map((x) => Number(x?.port))
    .filter((p) => Number.isInteger(p) && p > 0);
  const port = wantPort || already[0] || nextPort();
  if (!port) return { ok: false, reason: '没有可用的端口了（3002~3201 都占了）' };

  // ③ 保证目标端口那一条存在；已经有的**沿用它的 token**（见上面对 token 的说明）
  let hit = j.networks.wsServers.find((x) => Number(x?.port) === port);
  const created = !hit;
  if (!hit) {
    if (!token) token = randomBytes(18).toString('base64url');
    hit = {
      name: 'ws-default',
      accessToken: token,
      messageFormat: 'array',
      reportSelfMessage: false,
      host: '127.0.0.1',
      port,
      path: '/',
      role: 'Universal',
    };
    j.networks.wsServers.push(hit);
  } else if (token) {
    hit.accessToken = token;
  }

  // ⚠️ 写之前先备份（协议端的配置文件里也有 token，改坏了很难重建）
  try {
    copyFileSync(f, `${f}.bak-多号-${Date.now()}`);
  } catch {
    /* 备份失败不拦着写，但要留痕 */
    log.warn(`协议端配置备份失败（继续写）：${f}`);
  }
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
  renameSync(tmp, f);

  return { ok: true, port, token: hit.accessToken, created, removedPorts };
}

/**
 * 谁在监听这些端口 —— **用 `netstat -ano` 解析**，不走 PowerShell。
 *
 * ⚠️⚠️ 2026-10-07 改（实测踩到）：原来这里用 `Get-NetTCPConnection`，
 *    而在**自动化调用**下它返回空 ⇒ `ownerPid()` 得 0 ⇒ `restart()` 以为
 *    "协议端没在跑"，于是**又起了一个** —— 变成两个 SnowLuma 抢同一个端口，
 *    老的还占着 3001、新配置（新号的端口）因此**永远不生效**。
 *    `netstat` 是纯文本、不依赖 PowerShell 的会话状态，实测稳定。
 */
function listeners() {
  const map = new Map();
  try {
    const out = execFileSync('netstat', ['-ano'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    for (const line of out.split(/\r?\n/)) {
      // 形如： `  TCP    127.0.0.1:3001    0.0.0.0:0    LISTENING    5984`
      const m = /^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
      if (m) map.set(Number(m[1]), Number(m[2]));
    }
  } catch (e) {
    log.warn(`跑 netstat 失败（查不到端口占用者）：${e.message}`);
  }
  return map;
}

/** 监听某个端口的进程 PID（**端口归属**，绝不碰 CommandLine） */
function ownerPid(port) {
  return listeners().get(Number(port)) ?? 0;
}

/**
 * 给测试/排障看：某个端口现在归哪个 PID。
 * ⚠️ 这个查询在 2026-10-07 出过一次真故障（返回 0 ⇒ `restart()` 重复起了一个
 *    协议端），所以专门留个口子让套件能直接验它，别只靠"重启一次看看"。
 */
export function __ownerPid(port) {
  return ownerPid(port);
}

/** 那个端口**连得上**吗（异步；用来给"查不到占用者"上保险） */function portAlive(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port: Number(port) });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch {}
      resolve(v);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
  });
}

/** 那个 PID 的可执行文件路径（用来核对"它真的是协议端"，防误杀） */
function procPath(pid) {
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).Path`],
      { encoding: 'utf8', timeout: 10000 },
    ).trim();
  } catch {
    return '';
  }
}

/**
 * 重启协议端，让新配的端口生效。
 *
 * ⚠️⚠️ 这会让**所有号**短暂掉线（我们的机器人会自动重连，通常几十秒）。
 *    所以界面上是"用户点了确认"才调到这里，而且返回值里如实说明发生了什么。
 *
 * ⚠️ 杀进程只按**端口归属**拿 PID，并且核对可执行文件在协议端目录下 ——
 *    两条都过了才杀（AGENTS 里那条"绝不按命令行匹配"是硬规矩）。
 */
export async function restart(timeoutMs = 70000) {
  if (!supported()) return { ok: false, reason: unsupportedReason() };
  const dir = lumaDir();
  const m = String(config.onebot?.url ?? '').match(/:(\d+)/);
  const port = m ? Number(m[1]) : 3001;
  const pid = ownerPid(port);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let killed = 0;

  // ⚠️⚠️ **保险丝**（2026-10-07 实测踩到，必须有）：
  //    端口**连得上**、却查不到是哪个进程 ⇒ 我们不知道那是谁，
  //    这时候**绝不能盲目再起一个** —— 后果是两个协议端抢同一个端口，
  //    新配置（新号的端口）永远不生效，表现是"重启之后反而更乱"。
  //    宁可如实报错让用户手动重启，也不要"以为重启过了"。
  if (!pid && (await portAlive(port))) {
    return {
      ok: false,
      reason: `端口 ${port} 连得上，但查不到占用它的进程 —— 不敢乱起第二个，请在协议端自己的界面里重启它`,
    };
  }

  if (pid) {
    const exe = procPath(pid);
    if (exe && !exe.toLowerCase().startsWith(dir.toLowerCase())) {
      return { ok: false, reason: `端口 ${port} 被别的程序占着（${exe}），不敢动它` };
    }
    try {
      process.kill(pid);
      killed = pid;
    } catch (e) {
      return { ok: false, reason: `停不掉协议端进程（PID ${pid}）：${e.message}` };
    }
  }
  // 等端口放开
  for (let i = 0; i < 20 && ownerPid(port); i++) await sleep(500);

  // 重新拉起（⚠️ 这条是 AGENTS 里验证过的起法：隐藏窗口，在自己目录里跑）
  const nodeExe = process.execPath;
  const localNode = join(dir, 'node.exe');
  const exe = existsSync(localNode) ? localNode : nodeExe;
  spawn(exe, ['index.mjs'], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true }).unref();

  // 等它重新监听
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1000);
    if (ownerPid(port)) {
      return { ok: true, killed, port, waitedMs: Date.now() - t0, restarted: true };
    }
  }
  return {
    ok: false,
    killed,
    port,
    reason: `重启之后等了 ${Math.round(timeoutMs / 1000)} 秒，${port} 还是没人监听 —— 去协议端自己的界面看看`,
  };
}
