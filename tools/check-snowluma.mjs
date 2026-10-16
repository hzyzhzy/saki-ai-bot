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

function snowlumaProcs() {
  try {
    // ⚠️ 别用 wmic：实测它**看不到** `C:\SnowLuma\node.exe` 那个进程 ✗
    //    （同一时刻 `Get-CimInstance` 能列出来 ⇒ wmic 的输出/过滤在这台机器上不可靠）
    //    ⇒ 改用 PowerShell，并且用 **-EncodedCommand**（base64）避开引号地狱 ✓
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
    const hits = [];
    for (const line of String(out).split(/\r?\n/)) {
      const [pid, ...rest] = line.split('|');
      const cmd = rest.join('|').trim();
      if (!cmd.includes(marker)) continue;
      if (cmd.includes('runner.js') || cmd.includes('check-snowluma') || cmd.includes('agent-busy')) continue;
      hits.push({ pid: String(pid).trim(), cmd });
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
