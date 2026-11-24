#!/usr/bin/env node
/**
 * 走「前台执行器」在 QQ 里操作 —— 需要时拉起、干完自退。
 *
 * ## 为什么分两个进程
 *   · **读树**（UIA）不需要前台 ⇒ 我在这个 node 进程里做就行；
 *   · **点/打字**（SendInput）只进前台窗口，而 Windows 只让**前台进程**抢前台
 *     ⇒ 必须交给 `执行电脑操作.bat`（explorer 起的，在用户桌面会话里、是前台）。
 *
 * ## 用法
 *   node tools/qq-client.mjs raw --hwnd 21238224 --ops '[{"type":"click","x":325,"y":491}]'
 *   node tools/qq-client.mjs click --hwnd 21238224 --x 325 --y 491
 *   node tools/qq-client.mjs send  --pid 17188 --group "示例服务器 2026" --text "要发的话"
 *   node tools/qq-client.mjs open  --pid 17188 --group "示例服务器 2026"
 *
 * ## 流程（send / open）
 *   1. 读树（本进程，只读）→ 找到群在会话列表里的 rect → 算出点击坐标
 *   2. 写 C:\Temp\cu-host\task.json
 *   3. `explorer.exe 执行电脑操作.bat` 拉起来
 *   4. 轮询 C:\Temp\cu-host\result.json，拿到结果就返回（执行器自己会退出）
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BRIDGE = join(HERE, 'vendor', 'computer-use', 'backend', 'bridge.js');
const HOST_DIR = 'C:\\Temp\\cu-host';
const TASK = join(HOST_DIR, 'task.json');
const RESULT = join(HOST_DIR, 'result.json');
const BAT = join(ROOT, '执行电脑操作.bat');
const CU_HOST = join(HERE, 'cu-host.ps1');

const argv = process.argv.slice(2);
const cmd = String(argv[0] || '');
function arg(n, d) {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const num = (n, d) => {
  const x = Number(arg(n));
  return Number.isFinite(x) ? x : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { ok: false, steps: [] };
const log = (m) => out.steps.push(`${new Date().toTimeString().slice(0, 8)} ${m}`);

/** 把任务交给前台执行器并等结果 */
async function runHost(task, timeoutMs = 45000) {
  mkdirSync(HOST_DIR, { recursive: true });
  try {
    if (existsSync(RESULT)) unlinkSync(RESULT);
  } catch {}
  writeFileSync(TASK, JSON.stringify(task, null, 1), 'utf8');
  log('任务已写，拉起执行器');
  // ⚠️ explorer 起的进程在用户会话、是前台，不在本会话的 Job 里
  // ⚠️⚠️ 2026-11-14 实测结论：**不需要 explorer 中转**。
  //    `cu-host.ps1` 自己用 AttachThreadInput 就能抢到前台
  //    （手动跑实测 `force-foreground=ok`），而 `explorer → bat → powershell` 这条链
  //    因为 bat 路径带中文会失败/超时 ⇒ **直接调 powershell** ✓
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CU_HOST, '-Task', TASK, '-Out', RESULT], {
    stdio: 'ignore',
    timeout: timeoutMs,
  });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(400);
    if (existsSync(RESULT)) {
      try {
        const j = JSON.parse(readFileSync(RESULT, 'utf8'));
        log(`执行器返回 ok=${j.ok}`);
        return j;
      } catch {
        /* 还在写 */
      }
    }
  }
  return { ok: false, error: '执行器超时（没等到 result.json）' };
}

try {
  if (cmd === 'raw' || cmd === 'click') {
    const hwnd = num('hwnd', 0);
    if (!hwnd) throw new Error('要 --hwnd');
    let ops;
    if (cmd === 'click') {
      const x = num('x');
      const y = num('y');
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('要 --x --y');
      ops = [{ type: 'click', x, y }];
    } else {
      const raw = arg('ops');
      if (!raw || raw === true) throw new Error('要 --ops \'[{"type":"click","x":1,"y":2}]\'');
      ops = JSON.parse(String(raw));
    }
    const r = await runHost({ hwnd, ops, show: true, hideAfter: arg('keep') ? false : true });
    out.ok = !!r.ok;
    out.host = r;
    if (!r.ok) out.error = r.error;
  } else if (cmd === 'open' || cmd === 'send') {
    const pid = num('pid', 0);
    const want = String(arg('group') || '').trim();
    const text = String(arg('text') || '');
    if (!pid) throw new Error('要 --pid');
    if (!want) throw new Error('要 --group');

    // ① 读树（只读，本进程）
    const { PowerShellBackend } = await import('file://' + BRIDGE.split('\\').join('/'));
    const be = new PowerShellBackend({ timeoutMs: 90000 });
    let hwnd = 0;
    let nodes = [];
    try {
      await be.start();
      // ⚠️ 允许 --hwnd 直连（协议端轮询时窗口句柄是已知的）
      const forcedHwnd = Number(arg('hwnd')) || 0;
      if (forcedHwnd) hwnd = forcedHwnd;
      const cf = join(ROOT, 'state', 'qq-a11y.json');
      try {
        hwnd = Number(JSON.parse(readFileSync(cf, 'utf8'))[String(pid)]?.hwnd) || 0;
      } catch {}
      if (!hwnd) throw new Error('没有缓存的 hwnd —— 先跑 node tools/qq-a11y.mjs read --pid ' + pid);
      // ⚠️ 读之前要先让窗口"可见"（Chromium 不可见就不建 a11y 树）。
      //    这一步也交给执行器 —— 它能抢前台，而且干完可以留在前台（hideAfter:false）。
      const shown = await runHost({ hwnd, ops: [], show: true, hideAfter: false }, 20000);
      log(`执行器显示窗口 ok=${shown.ok}`);
      await sleep(1600);
      const r = await be.request('uitree', { hwnd, maxDepth: 20, maxNodes: 3000, prune: false, skipEmpty: false, patterns: true });
      nodes = (r.nodes || []).map((n) => ({
        ref: n.ref,
        type: String(n.controlType || '').replace('ControlType.', ''),
        name: String(n.name || ''),
        x: n.x, y: n.y, w: n.width, h: n.height,
      }));
      log(`读树 ${nodes.length} 节点`);
    } finally {
      try { be.dispose(); } catch {}
    }

    const hit = nodes.find((n) => n.name.includes(want));
    if (!hit) throw new Error(`会话列表里没看到「${want}」—— 可能没滚到，或者群名不对`);
    const cx = Math.round(hit.x + hit.w / 2);
    const cy = Math.round(hit.y + hit.h / 2);
    log(`目标是「${hit.name.slice(0, 30)}」rect=${hit.x},${hit.y} → 点 ${cx},${cy}`);

    const ops = [
      { type: 'click', x: cx, y: cy },
      { type: 'sleep', ms: 1500 },
    ];
    if (cmd === 'send' && text) {
      // 输入框大概在窗口下方中间：点一下再粘贴
      const win = nodes.find((n) => n.type === 'Window');
      const wx = win ? win.x : 49;
      const wy = win ? win.y : 85;
      const ww = win ? win.w : 945;
      const wh = win ? win.h : 753;
      const tx = Math.round(wx + ww * 0.62);
      const ty = Math.round(wy + wh * 0.92);
      ops.push({ type: 'click', x: tx, y: ty }, { type: 'sleep', ms: 400 });
      ops.push({ type: 'paste', text });
      ops.push({ type: 'sleep', ms: 600 });
      ops.push({ type: 'key', keys: 'enter' });
      log(`输入框估算 ${tx},${ty}；粘贴 ${text.length} 字 + 回车`);
    }

    const r = await runHost({ hwnd, ops, show: true, hideAfter: arg('keep') ? false : true });
    out.ok = !!r.ok;
    out.target = { name: hit.name, rect: { x: hit.x, y: hit.y }, click: { x: cx, y: cy } };
    out.host = r;
    if (!r.ok) out.error = r.error;
  } else {
    out.error = '用法：raw / click / open / send';
  }
} catch (e) {
  out.ok = false;
  out.error = String(e?.message ?? e);
  log('ERROR ' + out.error);
}
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(out.ok ? 0 : 1);
