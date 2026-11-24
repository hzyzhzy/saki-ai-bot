#!/usr/bin/env node
/**
 * 读 QQ 界面（UIA），**用完自动把窗口藏回去**。
 *
 * ## 为什么要有这个脚本
 *   QQ 是 Electron：只有在带 `--force-renderer-accessibility` 启动时才会建 a11y 树
 *   （实测裸启动只有 10 节点 / 2 条文字，带参数同一窗口 216 节点 / 133 条文字）。
 *   而 QQ 平时**藏在托盘**（起来时 11 个窗口全 visible=false），Chromium 在窗口不可见时
 *   不建树 ⇒ **要读必须先 ShowWindow，读完再藏回去**。
 *   这个脚本把「显示 → 等建树 → 读 → 隐藏」做成一步 ✓
 *
 * ## 用法
 *   node tools/qq-a11y.mjs list --pid 17188        # 这个进程有哪些界面窗口（含隐藏）
 *   node tools/qq-a11y.mjs read --pid 17188        # 自动挑能读最多的那个，读完自动隐藏
 *   node tools/qq-a11y.mjs read --hwnd 21238224
 *   node tools/qq-a11y.mjs read --pid 17188 --grep 1127    # 只看含这个词的节点
 *   node tools/qq-a11y.mjs read --pid 17188 --keep         # 读完不隐藏（调试）
 *
 * ## 输出
 *   一行 JSON：{ ok, hwnd, nodes, restore:{visibleBefore}, ms, items:[...] }
 *   节点：ref / type / name / x / y / w / h / enabled / patterns
 *   ⚠️ `ref` 只在**本次 worker 进程内**有效；要连着点就一次调用里做完。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, 'vendor', 'computer-use', 'backend', 'bridge.js');
if (!existsSync(BRIDGE)) {
  console.log(JSON.stringify({ ok: false, error: 'vendor 不见了：' + BRIDGE }));
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

/** 跑一段 PowerShell，返回 stdout */
function ps(script) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
}

const CS = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class QQWin {',
  '  public delegate bool Proc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(Proc p, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);',
  // ⚠️ 2026-11-14 加：**强制重绘** —— Electron 窗口被 SetWindowPos 挪过之后，
  //    DWM 合成层不更新 ⇒ 屏幕上留下**一块白板**（而 PrintWindow 照样能读到内容，
  //    所以"截图有、屏幕白"）。这几个调用能逼它重新合成 ✓
  '  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h, IntPtr r, IntPtr u, uint f);',
  '  [DllImport("user32.dll")] public static extern bool InvalidateRect(IntPtr h, IntPtr r, bool e);',
  '  [DllImport("user32.dll")] public static extern bool UpdateWindow(IntPtr h);',
  '  [DllImport("dwmapi.dll")] public static extern int DwmFlush();',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  public static List<string> List(uint target) {',
  '    var o = new List<string>();',
  '    EnumWindows((h, l) => {',
  '      uint p; GetWindowThreadProcessId(h, out p);',
  '      if (p == target) {',
  '        var c = new StringBuilder(256); GetClassName(h, c, 256);',
  '        o.Add(h + "|" + IsWindowVisible(h) + "|" + c);',
  '      }',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return o;',
  '  }',
  '}',
  '"@',
].join('\n');

/** 枚举 pid 的所有顶层窗口（**含不可见** —— 这正是不能用 windows 接口的原因） */
function listWindows(pid) {
  const out = ps(`${CS}\n[QQWin]::List(${pid}) | ForEach-Object { Write-Output $_ }`);
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [h, v, ...rest] = l.split('|');
      return { hwnd: Number(h), visible: v === 'True', cls: rest.join('|') };
    })
    .filter((x) => Number.isFinite(x.hwnd) && x.hwnd > 0);
}

/** 显示 / 隐藏一个窗口；返回显示之前的可见状态 */
function setVisible(hwnd, show) {
  const script =
    `${CS}\n` +
    `$h=[IntPtr]${hwnd}; $b=[QQWin]::IsWindowVisible($h); ` +
    (show
      ? `[void][QQWin]::ShowWindow($h,5); ` +
        `[void][QQWin]::SetWindowPos($h,[IntPtr]::Zero,60,60,0,0,0x0001 -bor 0x0040); ` +
        // ⚠️ 挪完必须逼它重绘，否则屏幕上是白板（实测）
        `[void][QQWin]::InvalidateRect($h,[IntPtr]::Zero,$true); ` +
        `[void][QQWin]::RedrawWindow($h,[IntPtr]::Zero,[IntPtr]::Zero,0x0001 -bor 0x0100 -bor 0x0080 -bor 0x0004); ` +
        `[void][QQWin]::UpdateWindow($h); [void][QQWin]::DwmFlush(); `
      : `[void][QQWin]::ShowWindow($h,0); `) +
    `Start-Sleep -Milliseconds 200; Write-Output ("$b")`;
  return ps(script);
}

/**
 * ⚠️ 2026-11-14 加：记住「哪个 hwnd 是真的主界面」。
 *    一个 QQ 进程有 5 个 Chrome_WidgetWin_1，只有 1 个能读（216 节点），
 *    其余是 11 / 34 节点。原来每次都挨个试 ⇒ 19 秒 ✗
 *    记住之后直接命中，2~3 秒 ✓
 */
const CACHE_FILE = join(HERE, '..', 'state', 'qq-a11y.json');
function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}
function saveCache(o) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(o, null, 1), 'utf8');
  } catch {}
}

const be = (await import('file://' + BRIDGE.split('\\').join('/'))).PowerShellBackend
  ? new (await import('file://' + BRIDGE.split('\\').join('/'))).PowerShellBackend({ timeoutMs: 90000 })
  : null;

let out = { ok: false };
try {
  await be.start();

  if (cmd === 'list') {
    const pid = num('pid', 0);
    if (!pid) throw new Error('list 需要 --pid');
    const ws = listWindows(pid).map((x) => ({ hwnd: x.hwnd, visible: x.visible, cls: x.cls }));
    out = { ok: true, pid, count: ws.length, windows: ws };
  } else if (cmd === 'read') {
    const t0 = Date.now();
    let hwnd = num('hwnd', 0);
    const pid = num('pid', 0);
    const grep = String(arg('grep') || '');

    if (!hwnd) {
      if (!pid) throw new Error('要给 --hwnd 或 --pid');
      const _c = loadCache();
      const _h = Number(_c[String(pid)]?.hwnd) || 0;
      if (_h) {
        setVisible(_h, true);
        await new Promise((r) => setTimeout(r, 1500));
        const _t = await be
          .request('uitree', { hwnd: _h, maxDepth: 3, maxNodes: 200, prune: false, skipEmpty: false, patterns: false })
          .catch(() => ({}));
        if ((_t.nodes || []).length > 50) hwnd = _h;
        else setVisible(_h, false);
      }
    }
    if (!hwnd) {
      if (!pid) throw new Error('要给 --hwnd 或 --pid');
      const cands = listWindows(pid).filter((x) => /Chrome_WidgetWin_1/.test(x.cls));
      if (!cands.length) {
        throw new Error(`pid ${pid} 没有 Chrome_WidgetWin_1 窗口 —— 多半是启动时没带 --force-renderer-accessibility`);
      }
      let best = { hwnd: 0, n: -1 };
      for (const c of cands) {
        setVisible(c.hwnd, true);
        await new Promise((r) => setTimeout(r, 1800)); // 建 a11y 树要 1.5 秒，600ms 不够
        const t = await be
          // ⚠️ 2026-11-14 修：这里原来用**浅读**（maxDepth:3, maxNodes:200），
          //    结果真界面的浅读也只有 36 个节点 —— 拿它当"空壳"判据是错的 ✗
          //    真界面深读有 400+，空壳深读还是几十个。
          .request('uitree', { hwnd: c.hwnd, maxDepth: 14, maxNodes: 900, prune: false, skipEmpty: false, patterns: false })
          .catch(() => ({}));
        const cnt = (t.nodes || []).length;
        // 深读 >100 才算真界面（真界面 400+，空壳 <50）
        if (cnt > best.n && cnt > 100) best = { hwnd: c.hwnd, n: cnt };
        if (!arg('keep')) setVisible(c.hwnd, false);
      }
      if (!best.hwnd) {
        throw new Error('所有候选窗口都读不到 50 个节点 —— QQ 可能没带 --force-renderer-accessibility 启动');
      }
      hwnd = best.hwnd;
    }

    const before = setVisible(hwnd, true);
    await new Promise((r) => setTimeout(r, 1800)); // 建树约 1.5 秒
    const r = await be.request('uitree', {
      hwnd,
      maxDepth: num('depth', 20),
      maxNodes: num('nodes', 3000),
      prune: false,
      skipEmpty: false,
      patterns: true,
    });
    let items = (r.nodes || []).map((n) => ({
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
    if (grep) items = items.filter((n) => n.name.includes(grep));
    if (!arg('keep')) setVisible(hwnd, false); // 用完自动藏回去
    if (pid && items.length > 50) {
      const _c2 = loadCache();
      _c2[String(pid)] = { hwnd, nodes: items.length, at: Date.now() };
      saveCache(_c2);
    }
    out = { ok: true, hwnd, nodes: items.length, restore: { visibleBefore: before }, ms: Date.now() - t0, items };
  } else {
    out = { ok: false, error: '用法：list --pid <PID> | read --pid <PID> [--grep 词] [--keep] | read --hwnd <HWND>' };
  }
} catch (e) {
  out = { ok: false, error: String(e?.message ?? e) };
} finally {
  try {
    be?.dispose();
  } catch {}
}
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(out.ok ? 0 : 1);
