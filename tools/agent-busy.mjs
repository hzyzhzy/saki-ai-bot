/**
 * 「现在有没有 agent 活正在跑？」—— **重启之前先跑这一条**。
 *
 * 为什么要它（用户 2026-10-16）：
 *   「**之后千万不要留下被杀掉的 agent 而且还不把它重启，对面问起来一下就露馅了**」
 *
 * 背景：agent 是**机器人进程的子进程**——重启机器人 ⇒ 正在跑的活**一起被带走** ✗
 *   现在虽然加了"重启后自动接着做"（`private-work.js` 的 resume），但**那一轮白跑** ✗
 *   ⇒ 所以**重启之前先看这一眼**：有活在跑就等它做完（或者先问用户）。
 *
 * ⚠️ 它只看**状态文件**（不碰进程命令行 —— 那个坑踩过太多次）：
 *   · `state/accounts/<QQ>/private-work.json` → `uid[*].stage === 'running'`
 *   · `state/accounts/<QQ>/agent-tasks.json`  → `tasks[*].status === 'running'`
 *
 * 用法：
 *   node tools/agent-busy.mjs        # 有人跑着 ⇒ 退出码 1（脚本里好判断）
 *   node tools/agent-busy.mjs -q     # 只输出一行
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as childProcess from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('-q');
const say = (s) => {
  if (!quiet) console.log(s);
};

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * ⚠️⚠️ 2026-10-16 加（用户：「**加检查**」）——
 *    光看状态文件会**误报**：`stage: 'running'` 只说明"这单还没交"，**不说明进程还在** ✗
 *    （实测踩过：活其实早停了，它还报"有 1 个 agent 在跑" ⇒ 我照它判断就会判断错）
 *    ⇒ 这里再数一遍**真实的 agent 进程**（node.exe 且带 `--profile`）✓
 *
 * ⚠️ 只读、只用来"数个数" —— **不杀任何进程**（杀进程那条铁律还在：一律按 PID）✓
 * ⚠️ 关键词**拼出来**（`'--' + 'profile'`）：免得这个脚本自己的命令行里出现那个字面量，
 *    被它自己数进去 ✗（DSH 的 runner 也跑 node，命令行里带着我的整段脚本原文）
 */
function countAgentProcs() {
  try {
    // ⚠️ 必须是 `execSync`（**不能写 `require`** —— 这是 .mjs，ESM 里没有 require ✗
    //    第一版就栽在这儿：抛错被 catch 掉 ⇒ 一直报"查不出来"）
    // ⚠️ 2026-10-16 改：**别用 wmic** —— 实测它看不到 `C:\SnowLuma\node.exe` 那种进程 ✗
    //    （同一时刻 `Get-CimInstance` 能列出来）⇒ 改走 PowerShell + `-EncodedCommand`（避引号地狱）✓
    const { execSync } = childProcess;
    const flag = '--' + 'profile';
    const ps = [
      'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |',
      '  ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }',
    ].join(' ');
    const b64 = Buffer.from(ps, 'utf16le').toString('base64');
    const out = execSync(`powershell -NoProfile -EncodedCommand ${b64}`, {
      encoding: 'utf8',
      timeout: 12000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out)
      .split(/\r?\n/)
      .filter(
        (l) =>
          l.includes(flag) &&
          !l.includes('runner.js') &&
          !l.includes('agent-busy') &&
          !l.includes('check-snowluma'),
      ).length;
  } catch {
    return -1; // 查不了就返回 -1（下面按"说不准"处理 ✓）
  }
}

const agentProcs = countAgentProcs();

const items = [];
const accountsDir = join(ROOT, 'state', 'accounts');
const dirs = [];
if (existsSync(accountsDir)) {
  for (const d of readdirSync(accountsDir, { withFileTypes: true })) {
    if (d.isDirectory()) dirs.push({ qq: d.name, dir: join(accountsDir, d.name) });
  }
}
// ⚠️ 主号的状态直接放在 `state/` 下（不带 QQ 子目录）✓
dirs.push({ qq: '(主号)', dir: join(ROOT, 'state') });

for (const { qq, dir } of dirs) {
  const pw = readJson(join(dir, 'private-work.json'));
  // ⚠️⚠️ 2026-10-16 加：**同一件私聊活会被记两笔账** ——
  //    `private-work.json` 里一份（`stage: running`）、`agent-tasks.json` 里一份（`kind: dm`）⇒
  //    原来会**报成两个活**（实测：我照它判断，以为有两个活在跑，其实真进程只有 1 个）✗
  //    ⇒ 已经报过的私聊 uid 记下来，下面那份**同一件事**就不再重复报 ✓
  const dmAlready = new Set();
  for (const [uid, one] of Object.entries(pw?.uid ?? {})) {
    if (one && one.stage === 'running' && !one.queued) {
      // ⚠️ 2026-10-16：`resumeCount` 只当"一共接过几次"看（**不再当上限** ——
      //    用户拍板：重启/手动打断那些**都不算**，只有"任务超时"才由另一套机制管）✓
      dmAlready.add(String(uid));
      items.push(
        `[私聊工作] ${qq} ← 好友 ${uid}（接着做过 ${Number(one.resumeCount) || 0} 次，产物在 ${one.dir ?? '?'}）`,
      );
    }
  }
  const at = readJson(join(dir, 'agent-tasks.json'));
  for (const t of at?.tasks ?? []) {
    if (t && t.status === 'running') {
      const uid = String(t?.by ?? '');
      const isDm = String(t?.kind ?? '') === 'dm' || !String(t?.gid ?? '');
      if (isDm && dmAlready.has(uid)) continue; // 同一件活的另一条账（上面已经报过 ✓）
      items.push(`[任务] ${qq} ← ${t.byName ?? t.by ?? '?'}｜${String(t.task ?? '').slice(0, 40)}`);
    }
  }
}

if (!items.length) {
  if (agentProcs > 0) {
    say(`⚠️ 状态文件说"没活在跑"，可**真实 agent 进程有 ${agentProcs} 个** —— 说不准，别急着重启 ✗`);
    process.exit(1);
  }
  say('✅ 现在**没有** agent 活在跑 —— 可以重启 ✓');
  process.exit(0);
}
say(`⚠️ 现在有 ${items.length} 个 agent 活在跑 —— **别重启**（重启会把它们一起带走 ✗）`);
for (const s of items) say(`   · ${s}`);
// ⚠️ 2026-10-16：状态文件 + **真实进程数**一起看（只信状态会误报，用户让加这条检查）
if (agentProcs === 0) {
  say('   ⚠️ 但**真实 agent 进程数是 0** ⇒ 上面这些八成是"状态挂着、进程早没了"');
  say('      （重启一下它就会自己接着做；或者等它做完）✓');
} else if (agentProcs > 0) {
  say(`   ✓ 真实 agent 进程 ${agentProcs} 个（确认在跑）`);
} else {
  say('   ⚠️ 真实进程数查不出来（wmic 不可用）⇒ 按"可能在跑"处理 ✓');
}
say('   ⇒ 等它们做完再重启；真要现在重启，先跟用户说一声 ✓');
process.exit(1);
