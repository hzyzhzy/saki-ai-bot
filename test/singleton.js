/**
 * 单例锁：同一个机器人**不许同时跑两个实例**（2026-09-21 加）。
 *
 * ## 为什么要它
 *   重复实例会造成最难查的那类症状：
 *     · 两套定时器 ⇒ 主动接话 / 说说 / 剧情**重复发**（AGENTS 里记的
 *       「同一个梗连发三遍到 QQ 空间」就是这个）；
 *     · 协议端允许多个 WS 客户端时 ⇒ **每条消息回两次**
 *       （有人克隆仓库后报的「接一句回两句」就是它）。
 *   实测我自己也一次撞出 3 个实例（2026-09-21 19:06）。
 *   以前唯一的防线是 `webui.js` 那句「管理界面端口被占用」—— 但它**只报错、不退出**，
 *   第二个实例照样跑起来 ⇒ 等于没有防线。
 *
 * ## 这个套件盯什么
 *   ① 第一个实例能起来，并把锁写上（PID + 启动时间）；
 *   ② 它跑着的时候，第二个实例**拒绝启动**（退出码 1 + 说清是哪个 PID、怎么停）；
 *   ③ 第一个被**强杀**后（模拟任务管理器结束进程 —— 那时 `on('exit')` 不会跑、
 *      锁必然残留），残留的锁**不许挡人**：下一个实例照样能起，并把锁接管过去。
 *
 * ⚠️ 纯离线：OneBot 地址指到死端口、管理界面关掉，**不碰真协议端、不碰真 3099**。
 * 用法: node test/singleton.js
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = 'logs/__singleton-test.yml';
const LOCK = join(ROOT, 'logs', '__singleton.lock');
const DEAD_PORT = 40801; // ⚠️ 别用 39001（那是 e2e 的）—— 各套件端口别撞

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 从 `config.test.yml` 派生：只把 OneBot 地址换到死端口（`webui.enable` 本来就是 false）
writeFileSync(
  join(ROOT, CFG),
  readFileSync(join(ROOT, 'config.test.yml'), 'utf8').replace(
    /url: ws:\/\/127\.0\.0\.1:\d+/,
    `url: ws://127.0.0.1:${DEAD_PORT}`,
  ),
  'utf8',
);
rmSync(LOCK, { force: true });

const procs = [];
/** 【3】起的那个实例 —— 【4】还要用它，所以提到块外面 */
let third = null;
function startBot() {
  const p = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: CFG,
      // ⚠️ 这把锁必须隔离 —— 用它去撞正在跑的真机器人就太荒谬了
      QQBOT_LOCK_FILE: LOCK,
      // ⚠️ state 也要隔离：这几个是启动阶段最容易写盘的
      QQBOT_RECENT_FILE: 'logs/__singleton-recent.json',
      QQBOT_AFFINITY_FILE: 'logs/__singleton-affinity.json',
      QQBOT_NAMES_FILE: 'logs/__singleton-names.json',
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
    // ⚠️ 必须 pipe：下面要断言它输出里那句「已经有本机器人在跑了」
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);
  return p;
}

/** 跑一个 bot 到它自己退出，收集输出 */
function runToExit() {
  const p = startBot();
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  return new Promise((resolve) => p.on('exit', (code) => resolve({ code, out })));
}

/**
 * 等锁文件出现（= 那个实例已经写上了自己的 PID）。
 *
 * ⚠️⚠️ `excludePid` 这个参数是**必须**的：测「残留的锁不挡人」时，
 *    锁文件**本来就在那儿**（残留的），只等"文件存在"会**立刻返回旧内容** ——
 *    那样断言就成了假绿（实测踩过：拿到的还是上一个实例的 PID）。
 *    ⇒ 必须等到锁里的 PID **换成新实例的**才算数。
 */
async function waitLock(timeout = 20000, excludePid = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (existsSync(LOCK)) {
      try {
        const j = JSON.parse(readFileSync(LOCK, 'utf8'));
        if (j?.pid > 0 && Number(j.pid) !== Number(excludePid)) return j;
      } catch {}
    }
    await sleep(200);
  }
  return null;
}

console.log('\n【1】第一个实例能起来，并把锁写上');
let first;
{
  first = startBot();
  const lock = await waitLock();
  check(!!lock, '锁文件出现了', lock ? `pid=${lock.pid}` : '（20 秒内没出现）');
  check(!!lock && lock.pid > 0, '锁里记了 PID', lock ? String(lock.pid) : '');
  check(!!lock?.startedAt, '锁里记了启动时间（PID 万一复用，好排查）', lock?.startedAt ?? '');
}

console.log('\n【2】★ 它跑着的时候，第二个实例必须拒绝启动');
{
  const r = await runToExit();
  check(r.code === 1, '★ 第二个实例退出码 = 1（拒绝启动）', `实际 ${r.code}`);
  check(/已经有本机器人在跑了/.test(r.out), '★ 并且明确说了「已经有本机器人在跑了」');
  check(/停止机器人\.bat/.test(r.out), '　还告诉用户怎么把它停掉');
  check(/singleton\.lock|bot\.lock/.test(r.out), '　并把锁文件路径指出来（误报时好手动删）');
}

console.log('\n【3】★ 第一个被强杀后，残留的锁**不挡人**');
{
  // ⚠️ 用 SIGKILL：最贴近"任务管理器里结束进程"的真实情况 ——
  //    那时 `process.on('exit')` 不会跑，**锁文件必然残留**。
  first.kill('SIGKILL');
  await sleep(1500);
  check(existsSync(LOCK), '锁文件确实残留着（强杀不触发清理，这是正常现象）');

  third = startBot();
  // ⚠️ 排除被强杀那个 PID —— 否则读到的会是**残留的旧锁**，这条断言就白测了
  const lock2 = await waitLock(20000, first.pid);
  check(
    !!lock2 && Number(lock2.pid) !== Number(first.pid),
    '★ 残留的锁没挡住新实例（PID 探活认出那是死进程）→ 锁被**新实例**接管',
    lock2 ? `旧 pid=${first.pid} → 新 pid=${lock2.pid}` : '（没起来）',
  );
  await sleep(1500);
  check(third.exitCode === null, '　新实例还活着（不是启动即退出）', `exitCode=${third.exitCode}`);
}

console.log('\n【4】★ PID 被复用（那个号码有进程，但不是机器人）+ 锁陈旧 → 必须放行');
{
  // ⚠️ 这是 2026-09-21 真踩的那个：`process.kill(pid, 0)` 只回答"这个**号码**有进程吗"，
  //    不回答"那是不是机器人"。机器人被强杀（任务管理器 / 断电，`on('exit')` 不跑）
  //    → 锁残留 → 那个 PID 很快被**别的进程**用掉 → 探活成功 → **新实例起不来**，
  //    而屏幕上只有一句"已经有本机器人在跑了"（用户看不见任何实例）。
  //    实测症状：`test/punctuation.js` 连续两轮回归失败，锁文件时间戳停在两小时前。
  if (third && third.exitCode === null) {
    third.kill('SIGKILL'); // 先收掉【3】那个，免得两个实例抢同一批 state 文件
    await sleep(1500);
  }
  // 伪造一把"看着像有实例"的锁：PID 用**本测试进程自己**（保证探活一定成功），
  // 再把 mtime 拨到 10 分钟前 —— 正是"强杀过 + 号码被别人用掉"的样子。
  writeFileSync(
    LOCK,
    JSON.stringify({ pid: process.pid, startedAt: '（假装很久以前）', argv: 'x' }),
    'utf8',
  );
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(LOCK, old, old);

  const fourth = startBot();
  const lock4 = await waitLock(20000, process.pid);
  check(
    !!lock4 && Number(lock4.pid) !== Number(process.pid),
    '★ 陈旧锁 + 活着的 PID 被识破（不再只看 PID 探活）→ 新实例起得来',
    lock4 ? `假 pid=${process.pid} → 新 pid=${lock4.pid}` : '（没起来）',
  );
  await sleep(1500);
  check(fourth.exitCode === null, '　新实例还活着（不是启动即退出）', `exitCode=${fourth.exitCode}`);
}

// ── 收尾：杀掉所有探针 + 删临时文件 ──
for (const p of procs) {
  try {
    p.kill('SIGKILL');
  } catch {}
}
for (const f of [CFG, 'logs/__singleton.lock', 'logs/__singleton-recent.json', 'logs/__singleton-affinity.json', 'logs/__singleton-names.json']) {
  try {
    rmSync(join(ROOT, f), { force: true });
  } catch {}
}

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（重复实例起不来了；残留的锁、以及 PID 被复用的陈旧锁，都不挡人）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
