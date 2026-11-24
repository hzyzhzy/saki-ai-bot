/**
 * Anode 调用封装 —— 让 OneBot 适配器通过 `anode exec` 在 seat（独立 Session 2）里跑脚本。
 *
 * ## 为什么走这条路
 *   QQ 跑在 Anode 的 seat（Session 2）里，那个 Session 天然是它的前台。
 *   ⇒ 之前卡了一整天的"抢前台 / 前台锁 / UAC 挡着"**全都不存在**：
 *     · 实测在 seat 里读消息：799 节点、结构化正确
 *     · 实测在 seat 里切群：`Invoke` 直接生效
 *     · 实测在 seat 里发送：**3.4 秒，一次成功**
 *     而**用户的桌面完全不受影响**。
 *
 * ## 三个必须知道的坑（都踩过）
 *   1. 所有 seat 命令都要 `--agent ID` + `--lease TOKEN`；token 只在 `lease acquire` 时给一次
 *   2. `--ttl` 上限 **600**（10 分钟）⇒ 必须**定时续租**，否则操作中途失效
 *   3. `--wait` 上限 **10000**（10 秒）⇒ 长任务要改用 `--timeout` + `job` 轮询
 *   4. PowerShell 里 `ps` 会被当成 `Get-Process` 别名 ⇒ 传参时要加引号（Node 里没这问题）
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

export const ANODE = join(process.env.LOCALAPPDATA || '', 'Programs', 'Anode', 'anode.exe');
export const AGENT = process.env.ANODE_AGENT_ID || 'dsh';
export const PYTHON = 'C:\\Temp\\dbenv\\Scripts\\python.exe';

let leaseToken = null;
let leaseAt = 0;
let renewTimer = null;

/** 拿 lease（已有就复用） */
export async function acquireLease(ttl = 600) {
  const t = Math.min(600, Math.max(60, ttl));
  const { stdout } = await pExecFile(ANODE, ['--agent', AGENT, 'lease', 'acquire', '--ttl', String(t)], {
    timeout: 60000,
    encoding: 'utf8',
  }).catch(() => ({ stdout: '' }));
  const m = /"leaseToken":\s*"([^"]+)"/.exec(String(stdout || ''));
  if (m) {
    leaseToken = m[1];
    leaseAt = Date.now();
    startRenew();
    return leaseToken;
  }
  // acquire 没给 token（说明已经持有）⇒ 用 status 看，但那不返回 token
  // ⚠️ 这种情况只能等它过期，或者由外部重启。先返回旧 token。
  return leaseToken;
}

/** 每 4 分钟续租一次（ttl 600，留足余量） */
function startRenew() {
  if (renewTimer) return;
  renewTimer = setInterval(async () => {
    if (!leaseToken) return;
    try {
      await pExecFile(
        ANODE,
        ['--agent', AGENT, '--lease', leaseToken, 'lease', 'renew', '--ttl', '600'],
        { timeout: 30000, encoding: 'utf8' },
      );
      leaseAt = Date.now();
    } catch (e) {
      // 续租失败 ⇒ 重新 acquire
      leaseToken = null;
      await acquireLease().catch(() => {});
    }
  }, 4 * 60 * 1000);
  renewTimer.unref?.();
}

export function currentLease() {
  return leaseToken;
}

/** 调用一个 seat 命令（windows / ps / shot …） */
export async function seatCmd(args, timeout = 60000) {
  if (!leaseToken) await acquireLease();
  const full = ['--agent', AGENT];
  if (leaseToken) full.push('--lease', leaseToken);
  full.push(...args);
  const { stdout } = await pExecFile(ANODE, full, { timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return String(stdout || '');
}

/**
 * 在 seat 里跑一个命令，等它结束并返回 stdout。
 * ⚠️ `--wait` 上限 10 秒，所以：先 wait 10s，没完就轮询 job。
 */
export async function seatExec(program, args = [], { cwd = ROOT, timeoutMs = 120000, waitMs = 10000, env = {} } = {}) {
  if (!leaseToken) await acquireLease();
  const wa = Math.min(10000, Math.max(500, waitMs));
  const full = ['--agent', AGENT];
  if (leaseToken) full.push('--lease', leaseToken);
  full.push(
    'exec',
    '--wait', String(wa),
    '--timeout', String(timeoutMs),
    '--cwd', cwd,
  );
  for (const [k, v] of Object.entries(env)) full.push('--env', `${k}=${v}`);
  full.push('--', program, ...args);

  let stdout;
  try {
    ({ stdout } = await pExecFile(ANODE, full, {
      timeout: timeoutMs + 30000,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (e) {
    stdout = String(e.stdout || '');
    if (!stdout) throw e;
  }
  const out = String(stdout || '');

  // 如果返回的是 jobId 说明还没跑完 ⇒ 轮询
  const jm = /^(j_[0-9a-f]+):/.exec(out.trim());
  if (jm && !/completed|failed/.test(out)) {
    const jobId = jm[1];
    const deadline = Date.now() + timeoutMs;
    let buf = out;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800));
      const r2 = await seatCmd(['job', jobId, '--json'], 60000).catch(() => '');
      buf += r2;
      if (/completed|failed|cancelled/.test(r2)) break;
    }
    return buf;
  }
  return out;
}

/** 从 seat exec 的 stdout 里抠最后一行 JSON */
export function parseLastJson(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('{') && !l.startsWith('[')) continue;
    try {
      return JSON.parse(l);
    } catch {}
  }
  return null;
}

/** 跑我们的 Python 工具（在 seat 里） */
export async function runPy(script, args = [], opts = {}) {
  return seatExec(PYTHON, ['-u', join('tools', script), ...args], opts);
}

/**
 * 在 seat 里自动探测 QQ 主窗口 hwnd。
 *
 * ⚠️ **必须自动探测**：seat 里的 QQ 每次重启 hwnd 都会变（实测 1902218 → 132512 → …），
 *    写死一个值的话重启一次就得改代码。
 * 判据（见 tools/qq-find-hwnd.py）：class=Chrome_WidgetWin_1 + 进程是 QQ.exe + 可见，
 * 然后**按 UIA 节点数排序**（有 `recent-contact-item` 的记正数、优先），
 * 因为 QQ 会同时开好几个同 class 的窗口（弹窗/隐藏窗），节点数最能区分。
 */
export async function findQQHwnd({ timeoutMs = 90000 } = {}) {
  const out = await runPy('qq-find-hwnd.py', [], { timeoutMs });
  const j = parseLastJson(out);
  if (!j?.ok) throw new Error('探测 QQ hwnd 失败：' + (j?.error || out.slice(-200)));
  return j;
}

export async function cleanup() {
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = null;
}
