#!/usr/bin/env node
/**
 * 用纯客户端（UIA 读 + 键鼠）在 QQ 里操作 —— **不走协议端、不注入、不截图 OCR**。
 *
 * ## 分步设计（每步都先"读"再"动"，动完再读回来确认）
 *   locate --pid <PID> --group <群号或群名>   只定位：把群点开，读出最新几条，不发任何东西
 *   send   --pid <PID> --group <...> --text "..."  定位 + 输入框打字 + 回车
 *
 * ## ⚠️ 安全约定
 *   · `send` 之前必须先用 `locate` 看过群名对不对；
 *   · 群里发出去的东西**撤不回**（QQ 虽然 2 分钟内可撤回，但会留提示）；
 *   · 全程窗口只在前台待几秒，动完自动藏回托盘。
 *
 * ## 为什么一次调用里做完
 *   `ref`（UIA 的元素引用）**只在同一个 worker 进程内有效** —— 跨进程就失效，
 *   所以"读树 → 点 → 再读"必须写在一次调用里，不能分成几次命令。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, 'vendor', 'computer-use', 'backend', 'bridge.js');
if (!existsSync(BRIDGE)) {
  console.log(JSON.stringify({ ok: false, error: 'vendor 不见了' }));
  process.exit(1);
}

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

const CS = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class QQS {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
`;
function psShow(hwnd, show) {
  const body = show
    ? `[void][QQS]::ShowWindow($h,5);[void][QQS]::SetWindowPos($h,[IntPtr]::Zero,40,40,0,0,0x0001 -bor 0x0040);[void][QQS]::SetForegroundWindow($h)`
    : `[void][QQS]::ShowWindow($h,0)`;
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', `${CS}\n$h=[IntPtr]${hwnd};${body};'ok'`], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const { PowerShellBackend } = await import('file://' + BRIDGE.split('\\').join('/'));
const be = new PowerShellBackend({ timeoutMs: 120000 });

const out = { ok: false, steps: [] };
const log = (m) => out.steps.push(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function readTree(hwnd, deep = true) {
  const r = await be.request('uitree', {
    hwnd,
    maxDepth: deep ? 24 : 6,
    maxNodes: deep ? 4000 : 300,
    prune: false,
    skipEmpty: false,
    patterns: true,
  });
  return (r.nodes || []).map((n) => ({
    ref: n.ref,
    type: String(n.controlType || '').replace('ControlType.', ''),
    name: String(n.name || ''),
    x: n.x,
    y: n.y,
    w: n.width,
    h: n.height,
    enabled: n.enabled,
    patterns: n.patterns,
  }));
}

try {
  const pid = num('pid', 0);
  const want = String(arg('group') || '').trim();
  const text = String(arg('text') || '');
  if (!pid) throw new Error('要 --pid');
  if (!want) throw new Error('要 --group（群号或群名的一部分）');

  await be.start();
  log('worker 就绪');

  // ① 找窗口（用缓存）
  const cf = join(HERE, '..', 'state', 'qq-a11y.json');
  let hwnd = 0;
  try {
    hwnd = Number(JSON.parse((await import('node:fs')).readFileSync(cf, 'utf8'))[String(pid)]?.hwnd) || 0;
  } catch {}
  if (!hwnd) throw new Error('没有缓存的 hwnd —— 先跑 node tools/qq-a11y.mjs read --pid ' + pid);
  log('用窗口 hwnd=' + hwnd);

  psShow(hwnd, true);
  await sleep(1600);

  // ② 深读（浅读只有 8 个节点，会话列表在更深层）
  let nodes = await readTree(hwnd, true);
  log('深读 ' + nodes.length + ' 节点 / ' + nodes.filter((n) => n.name).length + ' 条文字');
  let hit = nodes.find((n) => n.name && n.name.includes(want));

  // ③ 会话列表里没有 ⇒ 用搜索框搜群号
  if (!hit) {
    const box = nodes.find((n) => n.type === 'Edit' && /搜索/.test(n.name));
    if (!box) throw new Error('找不到搜索框（[Edit] 搜索）');
    log('点搜索框 ref=' + box.ref);
    await be.request('click', { ref: box.ref });
    await sleep(500);
    log('输入 ' + want);
    await be.request('type', { text: want });
    await sleep(1500);
    nodes = await readTree(hwnd, true);
    log('搜完 深读 ' + nodes.length + ' 节点');
    hit = nodes.find((n) => n.ref !== box.ref && n.name && n.name.includes(want));
  }

  if (hit) {
    log('找到「' + hit.name.slice(0, 34) + '」ref=' + hit.ref);
    if (cmd === 'open') {
      log('点进去');
      await be.request('click', { ref: hit.ref });
      await sleep(1500);
      const inGroup = await readTree(hwnd, true);
      log('进群后 深读 ' + inGroup.length + ' 节点');
      out.inGroup = inGroup.filter((n) => n.name).map((n) => ({ ref: n.ref, type: n.type, name: n.name.slice(0, 44) }));
    }
  } else {
    log('搜索之后还是没找到「' + want + '」');
  }

  out.ok = true;
  out.hwnd = hwnd;
  out.found = hit ? { ref: hit.ref, name: hit.name } : null;
  out.tree = nodes.filter((n) => n.name).map((n) => ({ ref: n.ref, type: n.type, name: n.name.slice(0, 44) }));
} catch (e) {
  out.ok = false;
  out.error = String(e?.message ?? e);
  log('ERROR ' + out.error);
} finally {
  try {
    be.dispose();
  } catch {}
}
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(out.ok ? 0 : 1);
