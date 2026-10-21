#!/usr/bin/env node
// AE 按需开关：node tools/ae-run.mjs <脚本.jsx> [--keep-open] [--timeout 秒]
//
// 给 agent 用的「After Effects 一条龙」跑法（2026-10-20 定）：
//   1. AE 没开 ⇒ 自动启动，轮询到「主窗口标题出现」为止（就绪）
//   2. 把 <脚本.jsx> 用 AfterFX.exe -r 发给已就绪的实例
//   3. 轮询 <脚本.jsx>.done（⚠️ jsx 必须在最后一行写这个标记，见下）
//   4. 默认跑完自动退出 AE（省内存）；--keep-open 则留着
//      退出时若被模态对话框挡住（#32770 空标题），自动对它发 WM_CLOSE 放行
//
// ⚠️ jsx 的约定（别漏）：
//   脚本最后要写完成标记，不然这里会等到超时：
//     var d = new File("<脚本自己路径>.done"); d.open("w"); d.writeln("ok"); d.close();
//   （路径要和传入的 jsx 完全一致，加 .done 后缀）
//
// 输出：单行 JSON（result: ok / fail，reason 一句话）—— 给 agent 直接读。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const AE = 'C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\AfterFX.exe';

const args = process.argv.slice(2);
const keepOpen = args.includes('--keep-open');
const timeoutIdx = args.indexOf('--timeout');
const timeoutMs = (timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 600) * 1000;
const jsx = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
if (!jsx) {
  console.log(JSON.stringify({ result: 'fail', reason: '用法: node tools/ae-run.mjs <脚本.jsx> [--keep-open] [--timeout 秒]' }));
  process.exit(1);
}
const jsxPath = resolve(jsx);
const doneFile = jsxPath + '.done';
if (existsSync(doneFile)) {
  // 上一轮的残留标记会假装成功 —— 先清掉
  try { spawnSync('powershell', ['-NoProfile', '-Command', `Remove-Item -LiteralPath '${doneFile.replace(/'/g, "''")}' -Force`]); } catch {}
}

// ── PowerShell 辅助（-EncodedCommand 避开引号地狱，AGENTS 的规矩） ──────────
function ps(script) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', enc], { timeout: 30000, encoding: 'utf8' });
  return String(r.stdout ?? '').trim();
}

// AE 状态：none（不在）/ starting（在但主窗口没出来）/ ready（标题出现）
function aeState() {
  return ps(`
$p = Get-Process -Name AfterFX -ErrorAction SilentlyContinue
if (-not $p) { 'none' }
elseif ([string]::IsNullOrEmpty($p.MainWindowTitle)) { 'starting' }
else { 'ready' }
`);
}

// 关掉 AE 的模态对话框（#32770），**优先点按钮**（继续/确定…），点不到才 WM_CLOSE
// ⚠️ 2026-10-22：崩溃修复框上发 WM_CLOSE 等于「取消」⇒ AE 永远起不来（一直 starting）✗
//    ⇒ 真正的关框逻辑搬到 tools/lib/close-ae-dialogs.ps1（C# 写三层转义太容易出错）
function closeDialogs() {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(dirname(fileURLToPath(import.meta.url)), 'lib', 'close-ae-dialogs.ps1')], { encoding: 'utf8', timeout: 30000 });
    return Number(String(r.stdout ?? '').trim()) || 0;
  } catch { return 0; }
}

// ── ① AE 就绪（没开就启动） ─────────────────────────────────────────────
let st = aeState();
if (st === 'none') {
  spawn(AE, [], { detached: true, stdio: 'ignore' }).unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    await new Promise((r) => setTimeout(r, 3000));
    st = aeState();
    if (st !== 'none') break;
  }
  if (st === 'none') {
    console.log(JSON.stringify({ result: 'fail', reason: 'AE 启动了但进程一直没出现（240 秒）' }));
    process.exit(1);
  }
}
// starting → ready
if (st === 'starting') {
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    await new Promise((r) => setTimeout(r, 3000));
    // ⚠️ 2026-10-22：启动途中可能弹「崩溃修复选项」挡住 ⇒ 进 ready 之前就得点掉它，
    //    以前只在 ready 之后才关，等于没救（一直 starting 直到超时）✗
    try { closeDialogs(); } catch {}
    st = aeState();
    if (st === 'ready') break;
    if (st === 'none') break;
  }
}
if (st !== 'ready') {
  console.log(JSON.stringify({ result: 'fail', reason: `AE 没就绪（状态 ${st}）—— 试试手动打开一次 AE 再跑` }));
  process.exit(1);
}

// 就绪后可能还弹着欢迎/恢复对话框（主窗口有标题但被模态框挡着）—— 先关一轮再发 -r
closeDialogs();

// ── ② 发 -r（就绪后这个调用立即返回；脚本在 AE 里异步跑） ─────────────────
spawnSync(AE, ['-r', jsxPath], { timeout: 60000 });

// ── ③ 等 jsx 写 .done ──────────────────────────────────────────────────
const t1 = Date.now();
let done = false;
while (Date.now() - t1 < timeoutMs) {
  await new Promise((r) => setTimeout(r, 3000));
  if (existsSync(doneFile)) { done = true; break; }
  // AE 中途死了也算失败
  if (aeState() === 'none') break;
}
if (!done) {
  // 卡住的话：多半是弹了对话框 —— 关掉再给一次机会（只救一次）
  const n = closeDialogs();
  const t2 = Date.now();
  while (Date.now() - t2 < 60000 && !existsSync(doneFile)) {
    await new Promise((r) => setTimeout(r, 3000));
  }
  done = existsSync(doneFile);
  if (!done) {
    console.log(JSON.stringify({ result: 'fail', reason: `脚本 ${timeoutMs / 1000} 秒内没写完成标记（关了 ${n} 个对话框也没救回来）` }));
    if (!keepOpen) forceQuit();
    process.exit(1);
  }
}

// ── ④ 跑完默认关掉 AE（用户 2026-10-20 定：按需开，做完关） ──────────────
if (!keepOpen) {
  // 干净退出：清空工程（不保存）再 quit
  const quitJsx = jsxPath + '.quit.jsx';
  writeFileSync(quitJsx, [
    'try { while (app.project.numItems > 0) { app.project.item(1).remove(); } } catch (e1) {}',
    'try { app.quit(); } catch (e2) {}',
  ].join('\n'), 'ascii');
  spawnSync(AE, ['-r', quitJsx], { timeout: 60000 });
  let t3 = Date.now();
  while (Date.now() - t3 < 30000 && aeState() !== 'none') {
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (aeState() !== 'none') {
    // 被对话框挡住 ⇒ 关对话框（quit 会接着执行）
    closeDialogs();
    t3 = Date.now();
    while (Date.now() - t3 < 20000 && aeState() !== 'none') {
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  if (aeState() !== 'none') forceQuit();
}

console.log(JSON.stringify({ result: 'ok', done: doneFile, keptOpen: keepOpen }));
process.exit(0);

function forceQuit() {
  ps(`$p = Get-Process -Name AfterFX -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $p.Id -Force }`);
}
