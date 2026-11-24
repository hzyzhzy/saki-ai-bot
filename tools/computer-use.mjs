#!/usr/bin/env node
/**
 * 「电脑操作」命令行 —— 给这个项目（也给我自己）一双能真正动手的手。
 *
 * ## 为什么是这么个薄壳
 *   `dsh-computer-use`（MIT，LJL454）那套**核心实现是自包含的**：
 *   `backend/bridge.js` 只依赖 node 内建 + 同包的 `internal/*.mjs`，
 *   **只有它的插件入口 `index.js` 才需要 DSH 的 API**（要求 dsh ≥0.2.1-rc.2）。
 *   而本机 DSH 是 0.1.5-rc.2 ⇒ 插件装不上 ✗
 *   ⇒ 所以**不装插件**，只把 `backend/` + `internal/` 拷进 `tools/vendor/`，
 *     用这个 CLI 直接驱动那个 PowerShell worker ✓ 不动 DSH、不改版本、不重启。
 *
 * ## 用法（全部走一次 worker 冷启动，约 1.5 秒）
 *   node tools/computer-use.mjs ping
 *   node tools/computer-use.mjs windows
 *   node tools/computer-use.mjs shot [--out 路径] [--scale 0.5] [--hwnd 123]
 *   node tools/computer-use.mjs tree --hwnd 123 [--depth 4] [--nodes 80]
 *   node tools/computer-use.mjs click --x 100 --y 200      # 或 --ref s06fb1.3
 *   node tools/computer-use.mjs type --text "hello"
 *   node tools/computer-use.mjs key --key Enter [--mods ctrl,shift]
 *   node tools/computer-use.mjs scroll --x 800 --y 500 --dy -300
 *   node tools/computer-use.mjs drag --x1 10 --y1 10 --x2 400 --y2 300
 *   node tools/computer-use.mjs focus --hwnd 123
 *   node tools/computer-use.mjs launch --path notepad.exe
 *   node tools/computer-use.mjs raw --cmd uitree --args '{"hwnd":123,"maxDepth":4}'
 *
 * ## 约定
 *   · 结果一律打印成**一行 JSON**（方便脚本读，也方便我看）
 *   · 截图默认落在 `C:\Temp\computer-use\`，回执里给绝对路径、尺寸、字节数
 *   · 出错就非零退出 + `{ok:false,error}`，不抛栈（除非 --debug）
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, 'vendor', 'computer-use');
const BRIDGE = join(VENDOR, 'backend', 'bridge.js');
const SHOT_DIR = process.env.COMPUTER_USE_OUT || 'C:\\Temp\\computer-use';

const argv = process.argv.slice(2);
const cmd = String(argv[0] || '').trim();
const DEBUG = argv.includes('--debug');

function arg(name, dflt = undefined) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const num = (name, dflt) => {
  const v = arg(name);
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

function out(o) {
  process.stdout.write(JSON.stringify(o) + '\n');
}
function die(msg, extra = {}) {
  out({ ok: false, error: String(msg), ...extra });
  process.exit(1);
}

if (!existsSync(BRIDGE)) {
  die('找不到 vendor：' + BRIDGE + '（tools/vendor/computer-use 是不是被删了？）');
}

const { PowerShellBackend } = await import('file://' + BRIDGE.split('\\').join('/'));

const be = new PowerShellBackend({ timeoutMs: num('timeout', 30000) });
let code = 0;
try {
  await be.start();
  const t0 = Date.now();

  const call = async (c, a = {}) => {
    const r = await be.request(c, a);
    return { r, ms: Date.now() - t0 };
  };

  if (!cmd || cmd === 'help') {
    out({
      ok: true,
      usage: 'ping | windows | shot | tree | click | type | key | scroll | drag | focus | launch | raw',
      note: '所有命令都可以加 --debug 看完整回执',
    });
  } else if (cmd === 'ping') {
    const { r, ms } = await call('ping');
    out({ ok: true, ms, ...r });
  } else if (cmd === 'windows') {
    const { r, ms } = await call('windows', {});
    const rows = (r.windows ?? []).map((w) => ({
      hwnd: w.hwnd,
      title: String(w.title ?? '').slice(0, 80),
      pid: w.pid,
      cls: w.class ?? w.className,
    }));
    out({ ok: true, ms, count: rows.length, windows: rows });
  } else if (cmd === 'shot') {
    mkdirSync(SHOT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const p = resolve(String(arg('out') || join(SHOT_DIR, `shot-${stamp}.png`)));
    const a = { path: p.split('\\').join('/') };
    const scale = num('scale');
    if (scale) a.scale = scale;
    const hwnd = num('hwnd');
    if (hwnd) a.hwnd = hwnd;
    const { r, ms } = await call('screenshot', a);
    out({
      ok: true,
      ms,
      path: p,
      width: r.width,
      height: r.height,
      bytes: existsSync(p) ? statSync(p).size : 0,
      scale: r.effectiveScale ?? r.scale,
    });
  } else if (cmd === 'tree') {
    const hwnd = num('hwnd');
    if (!hwnd) die('tree 需要 --hwnd（先跑 windows 拿）');
    const { r, ms } = await call('uitree', {
      hwnd,
      maxDepth: num('depth', 4),
      maxNodes: num('nodes', 80),
    });
    const nodes = (r.nodes ?? []).map((n) => ({
      ref: n.ref,
      type: String(n.controlType ?? '').replace('ControlType.', ''),
      name: String(n.name ?? '').slice(0, 60),
      x: n.x,
      y: n.y,
      w: n.width,
      h: n.height,
      enabled: n.enabled,
      patterns: n.patterns,
    }));
    out({ ok: true, ms, count: nodes.length, nodes });
  } else if (cmd === 'click') {
    const a = {};
    const ref = arg('ref');
    if (ref) a.ref = ref;
    else {
      a.x = num('x');
      a.y = num('y');
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) die('click 需要 --x/--y，或者 --ref');
    }
    const btn = arg('button');
    if (btn) a.button = btn;
    if (arg('double')) a.clicks = 2;
    const { r, ms } = await call('click', a);
    out({ ok: r.ok !== false, ms, ...r });
  } else if (cmd === 'type') {
    const text = String(arg('text') ?? '');
    if (!text) die('type 需要 --text');
    const { r, ms } = await call('type', { text });
    out({ ok: r.ok !== false, ms, ...r });
  } else if (cmd === 'key') {
    const key = String(arg('key') ?? '');
    if (!key) die('key 需要 --key（比如 Enter / Tab / Escape / F5）');
    const a = { key };
    const mods = arg('mods');
    if (mods) a.modifiers = String(mods).split(',');
    const { r, ms } = await call('key', a);
    out({ ok: r.ok !== false, ms, ...r });
  } else if (cmd === 'scroll') {
    const { r, ms } = await call('scroll', { x: num('x'), y: num('y'), dy: num('dy', -300) });
    out({ ok: r.ok !== false, ms, ...r });
  } else if (cmd === 'drag') {
    const { r, ms } = await call('drag', {
      from: { x: num('x1'), y: num('y1') },
      to: { x: num('x2'), y: num('y2') },
    });
    out({ ok: r.ok !== false, ms, ...r });
  } else if (cmd === 'focus') {
    const hwnd = num('hwnd');
    if (!hwnd) die('focus 需要 --hwnd');
    const { r, ms } = await call('focus', { hwnd });
    out({ ok: r.ok !== false, ms, ...r });
  } else if (cmd === 'launch') {
    const p = String(arg('path') ?? '');
    if (!p) die('launch 需要 --path');
    const { r, ms } = await call('launch', { path: p });
    out({ ok: r.ok !== false, ms, ...r });
  } else if (cmd === 'raw') {
    const c = String(arg('cmd') ?? '');
    if (!c) die('raw 需要 --cmd');
    let a = {};
    const raw = arg('args');
    if (raw && raw !== true) {
      try {
        a = JSON.parse(String(raw));
      } catch (e) {
        die('--args 不是合法 JSON：' + e.message);
      }
    }
    const { r, ms } = await call(c, a);
    out({ ok: r?.ok !== false, ms, result: r });
  } else {
    die('不认识的命令：' + cmd + '（试试 help）');
  }
} catch (e) {
  code = 1;
  out({ ok: false, error: String(e?.message ?? e), ...(DEBUG ? { stack: String(e?.stack ?? '').split('\n').slice(0, 8) } : {}) });
} finally {
  try {
    be.dispose();
  } catch {}
}
process.exit(code);
