/**
 * 协议端自愈的回归（2026-10-06 加，用户要求「加」）。
 *
 * ## 这个套件盯什么
 *   ① 通的时候**不计数**、失败到**阈值才动手**（单次抖动不许碰它）；
 *   ② 动手之后**冷却期内不再动**（协议端起来 + 登录要几十秒，反复打扰它更糟）；
 *   ③ **没有 launcher 时不许假装成功**（`acted=false` + 明确的 reason）；
 *   ④ ★ **源码里不许出现任何 CommandLine 匹配式杀进程** —— 那是这个功能最危险的地方：
 *      "找出哪个进程是协议端"必然要按命令行找，而那条路会打中 DSH 的 runner 自己
 *      （项目里踩过两次，见 AGENTS 的硬规矩）⇒ 这里钉死"只启动、不杀"。
 *
 * ⚠️⚠️ **这个套件绝不真的拉起协议端、也绝不真的杀进程**：
 *   · 探测用 `__setProbe()` 替换成假的；
 *   · 把 `provider.name` 换成 `onebot`（它的 `defaultLauncher` 是空的）⇒ `launcherPath()` 为空
 *     ⇒ `launch()` 在第一行就返回 false，**不会 spawn 任何东西**。
 *   （真去拉起协议端会动到 QQ 登录 —— 那是用户最敏感的东西，测试绝不许碰。）
 *
 * 用法: node test/provider-watch.js
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { config } = await import('../src/config.js');
const pw = await import('../src/provider-watch.js');
const provider = await import('../src/provider.js');

// ⚠️ 先把"自动拉起"变成不可用（onebot 没有 defaultLauncher）⇒ 测试里不可能 spawn
config.provider.name = 'onebot';
config.provider.launcher = '';
config.provider.dir = '';
config.provider.watch = { enable: true, intervalMs: 30000, maxFails: 3, cooldownMs: 300000 };
check(provider.launcherPath() === '', '★ 前置：launcher 已置空（保证这个套件不会真拉起协议端）');

console.log('\n【1】端口从哪来 / 真探一次（只探，不动任何东西）');
{
  const bak = config.onebot?.url;
  config.onebot ??= {};
  config.onebot.url = 'ws://127.0.0.1:12345';
  check(pw.portOf() === 12345, '★ 从 `onebot.url` 里抠出端口', String(pw.portOf()));
  config.onebot.url = 'ws://127.0.0.1:3001';
  check(pw.portOf() === 3001, '换一个也能抠出来');

  // 真探一个**没人听**的端口（死端口，安全）—— 应该 false
  const dead = await pw.probePort(39998, 800);
  check(dead === false, '★ 死端口 → false（探测本身是对的）');
  // 真探一个**自己在听的**端口 —— 应该 true（自己开一个临时 server，不碰任何服务）
  const net = await import('node:net');
  const srv = net.createServer();
  await new Promise((r) => srv.listen(39997, '127.0.0.1', r));
  const alive = await pw.probePort(39997, 800);
  srv.close();
  check(alive === true, '★ 有人在听 → true');
  if (bak !== undefined) config.onebot.url = bak;
}

console.log('\n【2】★ 连续失败到阈值才动手（单次抖动不许碰）');
{
  pw.__reset();
  let probeOk = false;
  pw.__setProbe(async () => probeOk);

  let r = await pw.tick();
  check(r.ok === false && r.acted === false, '第 1 次连不上 → 只记数，不动手', r.reason);
  check(pw.status().fails === 1, '计数 = 1');
  r = await pw.tick();
  check(r.acted === false && pw.status().fails === 2, '第 2 次 → 还是不动手');

  // 第 3 次到阈值：**会尝试动手**，但这个套件里 launcher 是空的 ⇒ acted=false（不许假装成功）
  r = await pw.tick();
  check(r.acted === false, '★ 到阈值了，但没有 launcher → **不许假装成功**（acted=false）', r.reason);
  check(/拉不起来|没配 launcher/.test(r.reason), '★ 而且 reason 说清了原因', r.reason);
  check(pw.status().reviveCount === 0, '记数器没虚报（没真拉起就不算一次）');

  // 通了一次 → 计数清零
  probeOk = true;
  r = await pw.tick();
  check(r.ok === true && pw.status().fails === 0, '★ 又通了 → 失败计数清零');
}

console.log('\n【3】★ 动手之后有冷却');
{
  pw.__reset();
  pw.__setProbe(async () => false);
  await pw.tick();
  await pw.tick();
  await pw.tick(); // 到阈值 → 记下 lastReviveAt（哪怕没 launcher），**同时把计数清零**
  const after = pw.status();
  check(after.lastReviveAt > 0, '到阈值那次记住了时间（冷却从这里算）');
  // ⚠️ 阈值那次会把计数清零（不然日志会打成「第 4/3 次」）⇒
  //    冷却期内要**再攒够 3 次**才会走到"到阈值了、但冷却中"那条分支
  await pw.tick();
  await pw.tick();
  const r = await pw.tick();
  check(r.acted === false, '冷却期内不再动手');
  check(/冷却/.test(r.reason), '★ 理由明确是"冷却中"（不是又从头数一遍）', r.reason);
}

console.log('\n【4】★★ 安全线：只启动、绝不杀进程');
{
  const src = readFileSync(join(ROOT, 'src', 'provider-watch.js'), 'utf8');
  check(!/CommandLine/.test(src), '★★ 源码里**没有** CommandLine 匹配（那会打中 DSH 的 runner 自己）');
  check(!/Stop-Process|taskkill|process\.kill/.test(src), '★★ 没有任何"杀进程"的动作（只启动、不杀）');
  check(/provider\.launcherPath\(\)/.test(src), '★ 拉起走的是 provider 配的 launcher（不自己拼命令）');
  check(/detached: true/.test(src), '★ 拉起时 detached（协议端要活过这条命令）');
  check(/config\.provider\?\.watch/.test(src), '★ 三个参数（间隔/阈值/冷却）都能从配置读');
  // 也在 index.js 里确认真的被启动了（只定义不启动 = 白做）
  const idx = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  check(/providerWatch\.start\(\)/.test(idx), '★★ index.js 里真的启动了它（只定义不启动 = 白做）');
}

pw.stop();
console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
