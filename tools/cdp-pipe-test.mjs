/**
 * CDP over pipe 实验（2026-11-14）
 *
 * 目标：验证 `--remote-debugging-pipe` 能不能在**不碰 QQ 任何文件**的前提下
 *      打开 DevTools 协议。端口方式已经证实被 QQ 忽略，pipe 是最后一个"纯外置"的机会。
 *
 * 原理：
 *   · Electron 的 pipe 模式：子进程从 **fd 3 读** 命令、往 **fd 4 写** 响应
 *   · 消息格式：**JSON + 一个 \0 结尾**（和 Chrome 一样）
 *   · Node 的 spawn 传 `stdio[3]=stdio[4]='pipe'` 就能造出这两根管道（puppeteer 就这么做）
 *
 * 兜底：如果 QQ 因为参数起不来 / 或者 pipe 没回应 ⇒ **用原命令行重启**
 *       （原命令：`"C:\Program Files\Tencent\QQNT\QQ.exe"`，无参数）。
 */
import { spawn, execFileSync } from 'node:child_process';

const EXE = 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';
const CWD = 'C:\\Program Files\\Tencent\\QQNT';
const OLD_PID = 496;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6) + 'ms';

function ps(cmd) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();
  } catch (e) {
    return 'ERR:' + (e.message || e).slice(0, 120);
  }
}

/** QQ 主进程（有窗口的那个）在不在 */
function qqMain() {
  const out = ps(
    "Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }",
  );
  return out
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !x.includes('ERR:'));
}

console.log(ms(), '实验开始');
console.log(ms(), '现存的 QQ 主进程：');
for (const l of qqMain()) console.log('   ', l.slice(0, 130));

// ── ① 关掉 Saki 那个（pid 496）
console.log(ms(), `关闭 pid ${OLD_PID}`);
try {
  execFileSync('taskkill', ['/PID', String(OLD_PID), '/F'], { stdio: 'ignore' });
} catch {}
await sleep(2500);

// ── ② 带 --remote-debugging-pipe 起来
console.log(ms(), '带 --remote-debugging-pipe 启动…');
const child = spawn(EXE, ['--remote-debugging-pipe'], {
  cwd: CWD,
  stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  detached: true,
});
child.unref();

const toChild = child.stdio[3]; // 我们写 → 子进程读
const fromChild = child.stdio[4]; // 子进程写 → 我们读

console.log(ms(), `spawn 完成 pid=${child.pid}  有写管道=${!!toChild}  有读管道=${!!fromChild}`);

let buf = '';
const got = [];
if (fromChild) {
  fromChild.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const msg = buf.slice(0, i);
      buf = buf.slice(i + 1);
      got.push(msg);
      console.log(ms(), '📨 pipe 收到：', msg.slice(0, 300));
    }
  });
  fromChild.on('error', (e) => console.log(ms(), 'pipe 读错误', e.message));
}

// ── ③ 等它起来，然后发一条 CDP 命令
await sleep(4500);
console.log(ms(), '启动后 QQ 主进程：');
const after = qqMain();
for (const l of after) console.log('   ', l.slice(0, 130));
console.log(ms(), `QQ 主进程数 = ${after.length}（原来 4 个：Saki/爱音/谷雨/<主人>大号）`);

const send = (obj) => {
  if (!toChild) return false;
  try {
    toChild.write(JSON.stringify(obj) + '\0');
    return true;
  } catch (e) {
    console.log(ms(), '写 pipe 失败', e.message);
    return false;
  }
};

if (toChild) {
  console.log(ms(), '发送 Browser.getVersion …');
  console.log(ms(), '  write 返回', send({ id: 1, method: 'Browser.getVersion' }));
  await sleep(1500);
  console.log(ms(), '发送 Target.getTargets …');
  console.log(ms(), '  write 返回', send({ id: 2, method: 'Target.getTargets' }));
  await sleep(2000);
}

console.log(ms(), `\n=== 结果 ===`);
console.log(`收到 ${got.length} 条 CDP 响应`);
if (got.length === 0) {
  console.log('❌ pipe 上没有回音 —— QQ 把 remote-debugging 整个禁掉了（端口和 pipe 都屏蔽）');
  console.log('   正在用原命令行重启 QQ，恢复现场…');
  try {
    execFileSync('taskkill', ['/IM', 'QQ.exe', '/F'], { stdio: 'ignore' });
  } catch {}
  await sleep(2500);
  const back = spawn(EXE, [], { cwd: CWD, stdio: 'ignore', detached: true });
  back.unref();
  await sleep(4000);
  console.log('   恢复后 QQ 主进程：');
  for (const l of qqMain()) console.log('     ', l.slice(0, 110));
} else {
  console.log('✅ CDP 通了！可以直接用 DevTools 协议读写消息（不用协议端、不用 UIA）');
  console.log('   ⚠️ 这个 QQ 实例是我们带 pipe 起的，关掉它 pipe 就断');
}
process.exit(0);
