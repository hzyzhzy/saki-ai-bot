#!/usr/bin/env node
/**
 * **安全重启协议端（SnowLuma）** —— 保证重启完只有 1 个实例。
 *
 * ## 为什么要有这个脚本（2026-10-19 真实事故）
 *
 *   我重启协议端时，拿的是一个**过期的 PID**（上上上次的）：
 *     `Stop-Process -Id 39104`（其实早就没了）→ 又起一个新的
 *     ⇒ 屏幕上就同时跑了 **两个 SnowLuma**（60776 + 22628）✗
 *
 *   两个实例的后果（这一条 AGENTS.md 里早就写了）：
 *     · 抢 3000/3001/3002/3003 端口
 *     · 抢同一个身份库（SnowLuma 自己报 `identity persistence write failed`）
 *     · **把四个号的会话全区踢掉** ⇒ 某个号从此「**能发不能收**」
 *       ⇒ 表现就是「它明明发得出消息，但群里永远看不到它回」✗✗
 *
 *   `tools/check-snowluma.mjs` 只能**检查**（打印警告 + 退出码 1），**拦不住** ✗
 *   ⇒ 这个脚本把"数实例 → 全部停干净 → 只起一个 → 再数一遍"做成一条命令 ✓
 *
 * ## 用法
 *
 *   node tools/restart-snowluma.mjs            # 真重启（先杀干净，再起一个）
 *   node tools/restart-snowluma.mjs --dry-run  # 只**看**：现在几个实例、会停哪些、会怎么起
 *   node tools/restart-snowluma.mjs --ensure   # 不动正在跑的，只在"0 个或 2 个以上"时收拾
 *
 * ⚠️ 停进程一律**按 PID**（绝不按命令行文本匹配 —— 那会打中我自己的 runner ✗）
 * ⚠️ 关键词**拼出来**（`'ind' + 'ex' + '.mjs'`），脚本自己的命令行里不出现那个字面量 ✓
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const ensure = argv.includes('--ensure');

const say = (s) => console.log(s);

/** 读 config.yml 里 provider 的信息（dir / 启动方式），读不到就用默认 ✓ */
function providerInfo() {
  let dir = 'C:\\SnowLuma';
  try {
    const y = readFileSync(join(ROOT, 'config.yml'), 'utf8');
    const m = /provider:[\s\S]{0,400}?\bdir:\s*["']?([^"'\r\n]+)/.exec(y);
    if (m) dir = m[1].trim();
  } catch {}
  return { dir, exe: join(dir, 'node.exe'), entry: 'index.mjs' };
}

/** 列出正在跑的协议端进程（只读，返回 [{pid, started}]） */
function listInstances(dir) {
  // ⚠️ 关键词拼出来：脚本自己的命令行里就不能出现它（否则会匹配到自己）✓
  const kw = 'ind' + 'ex' + '.' + 'mjs';
  const ps = [
    "$ErrorActionPreference='Stop'",
    '$kw = $env:SL_KW',
    '$dir = $env:SL_DIR',
    '@(Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object {',
    '  $_.CommandLine -and $_.CommandLine.Contains($kw) -and $_.CommandLine.Contains($dir)',
    '} | Select-Object ProcessId, CreationDate) | ForEach-Object {',
    "  Write-Output ($_.ProcessId.ToString() + '|' + $_.CreationDate.ToString('HH:mm:ss'))",
    '}',
  ].join('\n');
  let out = '';
  try {
    out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(ps, 'utf16le').toString('base64')],
      { env: { ...process.env, SL_KW: kw, SL_DIR: dir }, encoding: 'utf8', timeout: 30000 },
    );
  } catch (e) {
    say(`⚠️ 数实例失败：${e.message}`);
    return [];
  }
  return String(out ?? '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, started] = line.split('|');
      return { pid: Number(pid) || 0, started: started ?? '' };
    })
    .filter((x) => x.pid > 0);
}

const prov = providerInfo();
say(`协议端目录：${prov.dir}`);
say(`启动方式：${prov.exe} ${prov.entry}`);

let list = listInstances(prov.dir);
say(`现在跑着 ${list.length} 个实例${list.length ? '：' + list.map((x) => `PID ${x.pid}（${x.started} 起）`).join('、') : ''}`);

if (ensure && list.length === 1) {
  say('✅ --ensure：正好 1 个，不动它 ✓');
  process.exit(0);
}
if (dryRun) {
  say('');
  say('（--dry-run，什么都没动）会做的是：');
  if (list.length) say(`  ① 按 PID 停掉这 ${list.length} 个：${list.map((x) => x.pid).join('、')}`);
  else say('  ① 没有要停的');
  say('  ② 等 6 秒，让 3000~3003 释放');
  say(`  ③ 起一个：${prov.exe} ${prov.entry}（工作目录 ${prov.dir}）`);
  say('  ④ 再数一遍，必须正好 1 个');
  process.exit(0);
}

// ── ① 全部停掉（按 PID，一个不漏）──
for (const x of list) {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${x.pid} -Force -ErrorAction SilentlyContinue`], { timeout: 20000 });
    say(`已停 PID ${x.pid}`);
  } catch (e) {
    say(`⚠️ 停 ${x.pid} 失败：${e.message}`);
  }
}

// ── ② 等端口释放 ──
say('等 6 秒让 3000~3003 释放…');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 6'], { timeout: 20000 });

// ── ③ 起一个（脱离本进程，别被会话生命周期带走）──
if (!existsSync(prov.exe)) {
  say(`❌ 找不到 ${prov.exe} —— 看看 config.yml 里的 provider.dir`);
  process.exit(2);
}
const child = spawn(prov.exe, [prov.entry], { cwd: prov.dir, detached: true, stdio: 'ignore' });
child.unref();
say(`已起一个（父进程不等待）PID ${child.pid ?? '（拿不到）'}`);

// ── ④ 数一遍 ──
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 8'], { timeout: 20000 });
list = listInstances(prov.dir);
say('');
if (list.length === 1) {
  say(`✅ 现在正好 1 个实例（PID ${list[0].pid}）—— 三个号会在几秒内自己重连 ✓`);
  // ⚠️⚠️⚠️ 2026-10-19 血泪教训（一定要打出来，我自己就犯过两次）——
  //    **重启协议端之后，千万别再去杀/重启机器人进程！**
  //    机器人自己会 3 秒重连；你去杀它 = 在协议端那边制造一次 `ECONNRESET`
  //    ⇒ 协议端会**继续往那个已断的 socket 推事件**，新连接收不到
  //    ⇒ 表现就是「某个号能发不能收、群里永远看不到它回」✗✗
  //    实测对比（同一晚）：
  //      · 重启协议端 → 又杀了爱音 → 之后一直收不到（怎么重启都没用）
  //      · 重启协议端 → **什么都不动** → 40 秒后爱音自己重连上，立刻正常收消息 ✓
  say('');
  say('⚠️ 接下来**别再杀/重启机器人**（它们自己会在 3 秒内重连）。');
  say('   去杀它们 = 制造 ECONNRESET ⇒ 协议端会继续往断掉的 socket 推事件');
  say('   ⇒ 那个号就变成"能发不能收、群里永远看不到它回" ✗');
  process.exit(0);
}
say(`❌ 现在有 ${list.length} 个实例：${list.map((x) => x.pid).join('、')} —— 手动收拾一下（按 PID 停掉多余的）`);
process.exit(1);
