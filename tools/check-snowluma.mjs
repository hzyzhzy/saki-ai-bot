/**
 * 「现在有几个 SnowLuma 实例？」—— **起协议端之前先跑这一条**。
 *
 * 为什么要它（用户 2026-10-16）：
 *   「**杀，然后以后要避免启两个 snowluma**」
 *
 * 真事故（有日志证据）：同时跑了两个 SnowLuma 实例 ⇒
 *   · 都在尝试 bind 同一个端口（3000/3001/3002/3003）⇒ 一个必然 `EADDRINUSE` ✗
 *   · 还抢同一个身份库 ⇒ SnowLuma 自己报 `identity persistence write failed: err=Error: database` ✗
 *   · **02:24:05 那一下把四个号的会话全部踢掉** ⇒ 爱音一路重连到 02:32 才挤回来，
 *     掉线期间的群消息只能靠"补看"捞 ✗（用户当时问的就是"爱音怎么没回消息"）
 *
 * ⚠️ 它**只数、只报**，绝不杀任何进程（杀进程一律按 PID、由人确认）✓
 *
 * 用法：
 *   node tools/check-snowluma.mjs        # 2 个以上 ⇒ 退出码 1（脚本里好判断）
 *   node tools/check-snowluma.mjs -q     # 只输出一行
 */
import { execSync } from 'node:child_process';

const quiet = process.argv.includes('-q');
const say = (s) => {
  if (!quiet) console.log(s);
};

// ⚠️ 关键词**拼出来**：免得这个脚本自己的命令行里出现那个字面量，被它自己数进去 ✗
//   （DSH 的 runner 也跑 node，命令行里带着我的整段脚本原文）
const marker = 'index.' + 'mjs';
// ⚠️⚠️ 2026-10-20 加（**真事故**：这个脚本漏报了一个实例，用户报「爱音怎么又不回消息」）：
//    当时实际有 **2 个** SnowLuma（62952 拿 3000/3003/3011、70972 拿 3002），
//    两个抢同一批身份会话 ⇒ 爱音的推送被另一个踢掉 ⇒ **能发不能收** ✗
//    可这个脚本报「正好 1 个」—— 因为 70972 的命令行是**裸的** `node.exe  index.mjs`，
//    没有绝对路径，而老判据只看 CommandLine。
//    ⇒ 现在**三个判据任一命中就算**：
//      ① 命令行里有 `index.mjs`（老判据，保留）；
//      ② **可执行文件路径**在 SnowLuma 目录下（70972 这种裸命令行走这条 ✓）；
//      ③ **端口**：3000~3003 / 3010 / 3011 上监听的是不同 PID（最后兜底，见下）✓
//    ⚠️ 用 `snow` 小写片段，**不写全名** —— 写全名的话这个脚本自己的命令行里就有，
//      会把自己数进去 ✗（这个坑 2026-09-17 踩过一次）
const exeHint = 'snow'; // 拼都不用拼：小写片段不在我自己的命令行里

function snowlumaProcs() {
  try {
    // ⚠️ 别用 wmic：实测它**看不到** `C:\SnowLuma\node.exe` 那个进程 ✗
    //    （同一时刻 `Get-CimInstance` 能列出来 ⇒ wmic 的输出/过滤在这台机器上不可靠）
    //    ⇒ 改用 PowerShell，并且用 **-EncodedCommand**（base64）避开引号地狱 ✓
    const ps = [
      'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |',
      '  ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)|$($_.CommandLine)" }',
    ].join(' ');
    const b64 = Buffer.from(ps, 'utf16le').toString('base64');
    const out = execSync(`powershell -NoProfile -EncodedCommand ${b64}`, {
      encoding: 'utf8',
      timeout: 12000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const hits = [];
    for (const line of String(out).split(/\r?\n/)) {
      const [pid, exe, ...rest] = line.split('|');
      const cmd = rest.join('|').trim();
      const path = String(exe ?? '').trim();
      if (cmd.includes('runner.js') || cmd.includes('check-snowluma') || cmd.includes('agent-busy')) continue;
      // ① 命令行带 index.mjs  ② 可执行文件在 SnowLuma 目录下（裸命令行的实例靠这条）
      const hit = cmd.includes(marker) || path.toLowerCase().includes(exeHint);
      if (!hit) continue;
      hits.push({ pid: String(pid).trim(), cmd: cmd || path });
    }
    return hits;
  } catch {
    return null; // 查不了
  }
}

const list = snowlumaProcs();
if (list === null) {
  say('⚠️ 查不出来（wmic 不可用）⇒ 自己 `tasklist` 看一眼 node.exe 吧 ✓');
  process.exit(0);
}

// ⚠️⚠️ 2026-10-20 加：**端口兜底**（进程判据万一又漏了，这条能兜住）。
//    那次的现场：两个实例把端口分着听（一个拿 3000/3003/3011、一个拿 3002）——
//    只要这几个端口上出现了**不止一个 PID**，就一定是两个实例在抢 ✗
const PORT_SET = [3000, 3001, 3002, 3003, 3010, 3011];
function portOwners() {
  try {
    const ps = [
      'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |',
      `  Where-Object { @(${PORT_SET.join(',')}) -contains $_.LocalPort } |`,
      '  ForEach-Object { "$($_.LocalPort)|$($_.OwningProcess)" }',
    ].join(' ');
    const b64 = Buffer.from(ps, 'utf16le').toString('base64');
    const out = execSync(`powershell -NoProfile -EncodedCommand ${b64}`, {
      encoding: 'utf8',
      timeout: 12000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const byPid = new Map();
    for (const line of String(out).split(/\r?\n/)) {
      const [port, pid] = line.split('|').map((x) => String(x ?? '').trim());
      if (!port || !pid || pid === '0') continue;
      if (!byPid.has(pid)) byPid.set(pid, []);
      byPid.get(pid).push(Number(port));
    }
    return byPid;
  } catch {
    return null;
  }
}

const owners = portOwners();
if (owners && owners.size > 1) {
  say(`⚠️⚠️⛔ 这些端口被 **${owners.size} 个不同进程**分着听 —— 这就是"踢会话"的元凶 ✗`);
  for (const [pid, ports] of owners) {
    const known = list.some((x) => x.pid === pid);
    say(`   · PID ${pid}：${ports.join(' / ')}${known ? '' : '（进程判据没抓到它！）'}`);
  }
  say('   ⇒ 收拾：**只留一个**（多余的按 PID 停掉，绝不用命令行匹配），再让机器人自己重连 ✓');
  process.exit(1);
}
if (list.length === 0) {
  say('❌ 一个 SnowLuma 实例都没有 ⇒ 机器人连不上，去起一个：');
  say('   Start-Process -FilePath "C:\\SnowLuma\\node.exe" -ArgumentList "index.mjs" -WorkingDirectory "C:\\SnowLuma" -WindowStyle Hidden');
  process.exit(0);
}

if (list.length === 1) {
  say(`✅ SnowLuma 实例正好 1 个（PID ${list[0].pid}）—— 别再起第二个 ✓`);
  process.exit(0);
}

say(`⚠️⚠️ 现在有 ${list.length} 个 SnowLuma 实例 —— **这就是"踢掉所有会话"的元凶** ✗`);
for (const x of list) say(`   · PID ${x.pid}`);
say('   它们的后果：抢端口（EADDRINUSE）+ 抢身份库（database 写失败）+ 02:24 那一下把四个号全踢掉 ✗');
say('   ⇒ 收拾：**先只留一个**（把多余的按 PID 停掉），再让机器人自己重连 ✓');
process.exit(1);
