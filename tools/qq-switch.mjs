#!/usr/bin/env node
/**
 * 把 QQ 切到某个会话（群 / 私聊），**不发任何消息**。
 *
 * ## 为什么单独做
 *   客户端方案有个硬限制：**只能读"当前打开的那个会话"**。
 *   要收多个群的消息，就得会切群 —— 所以这个能力被单独抽出来给轮询用。
 *
 * ## 用什么点（踩过的坑）
 *   · `uiact {ref, action:'invoke'}`：**不可靠** —— QQ 自绘界面持续重绘，
 *     ref 一出读树就 `ELEMENT_UNAVAILABLE`（实测一次成功、下一次就失败）✗
 *   · `click --ref`：worker 的 a11y 坐标换算有 bug，返回 (0,0) ✗
 *   · **坐标点击**（自己按 rect 算中心点）：✅ 实测稳定，且 `via:"a11y"` 不需要前台
 *
 * ## 用法
 *   node tools/qq-switch.mjs --pid 33932 --group "示例服务器 2026"
 *   node tools/qq-switch.mjs --pid 33932 --group "..." --keep    # 切完不藏窗口
 *
 * ## 输出
 *   { ok, before, after, group, clicked:{x,y}, switched:boolean, steps:[...] }
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** UIA 操作统一重试：这些错误都是"等一下就好"的 */
async function uiaRetry(fn, { tries = 4, label = 'uitree' } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      const retriable = /0x80040201|unable to invoke any of the subscribers|ELEMENT_UNAVAILABLE|no longer in hwnd|timed out|COM|UIA/i.test(msg);
      if (!retriable || i === tries - 1) throw e;
      // 递增等待：600 / 1200 / 2400ms
      const wait = 600 * Math.pow(2, i);
      process.stderr.write(`[retry] ${label} 第 ${i + 1} 次失败（${msg.slice(0, 60)}），${wait}ms 后重试\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

const ROOT = join(HERE, '..');
const BRIDGE = join(HERE, 'vendor', 'computer-use', 'backend', 'bridge.js');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const num = (n, d) => {
  const x = Number(arg(n));
  return Number.isFinite(x) ? x : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pid = num('pid', 0);
const group = String(arg('group', ''));
const keep = argv.includes('--keep');
if (!pid || !group) {
  console.log(JSON.stringify({ ok: false, error: '要 --pid --group' }));
  process.exit(1);
}

const CS = `
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class SWs{
 [DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);
 [DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool repaint);
 [DllImport("user32.dll")]public static extern bool InvalidateRect(IntPtr h,IntPtr r,bool e);
 [DllImport("user32.dll")]public static extern bool RedrawWindow(IntPtr h,IntPtr r,IntPtr u,uint f);
 [DllImport("user32.dll")]public static extern bool UpdateWindow(IntPtr h);
 [DllImport("dwmapi.dll")]public static extern int DwmFlush();
}
'@
`;
function ps(s, t = 20000) {
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-Command', s], {
      encoding: 'utf8', timeout: t, windowsHide: true,
    }).trim();
    // ⚠️ PowerShell 会往 stdout 里混多行（New-Object 的返回值等）——只取最后一行，
    //    否则这些字会一起进 out.steps，把整个 JSON 弄坏
    const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : '';
  } catch {
    return '';
  }
}
const show = (h) => {
  // ⚠️⚠️ 实测：QQ 被 ShowWindow 之后会**恢复它自己记住的位置**，覆盖刚设的 →
  //    所以必须：显示 → 等它恢复完 → 强制移动 → **回读校验** → 不对再来一轮。
  //    另外窗口 820 宽，物理屏 2560 ⇒ 左边缘必须 ≤1739，否则会话项坐标越界、点不了。
  const setPos = (x, y) =>
    ps(
      `${CS}\n$h=[IntPtr]${h};` +
        `[void][SWs]::MoveWindow($h,${x},${y},820,700,$true);` +
        `[void][SWs]::InvalidateRect($h,[IntPtr]::Zero,$true);` +
        `[void][SWs]::RedrawWindow($h,[IntPtr]::Zero,[IntPtr]::Zero,0x0001 -bor 0x0100 -bor 0x0080 -bor 0x0004);` +
        `[void][SWs]::UpdateWindow($h);[void][SWs]::DwmFlush();` +
        `$r=New-Object SWs+RECT;[void][SWs]::GetWindowRect($h,[ref]$r);` +
        `Write-Output ("$($r.L),$($r.T),$($r.R-$r.L),$($r.B-$r.T)")`,
    );
  const readPos = () =>
    ps(
      `${CS}\n$h=[IntPtr]${h};$r=New-Object SWs+RECT;[void][SWs]::GetWindowRect($h,[ref]$r);` +
        `Write-Output ("$($r.L),$($r.T),$($r.R-$r.L),$($r.B-$r.T)")`,
    );
  return (async () => {
    ps(`${CS}\n[void][SWs]::ShowWindow([IntPtr]${h},5);'ok'`);
    await sleep(900); // 等 QQ 恢复它自己记的位置
    let pos = setPos(80, 80);
    await sleep(350);
    let left = Number(String(pos).split(",")[0]);
    if (!Number.isFinite(left) || left > 1700) {
      pos = setPos(80, 80); // 再来一次（QQ 有时纠正两轮）
      await sleep(350);
      left = Number(String(pos).split(",")[0]);
    }
    if (!Number.isFinite(left) || left > 1700) {
      // 兜底：分两步移动（先只动位置不动尺寸）
      pos = ps(
        `${CS}\n$h=[IntPtr]${h};[void][SWs]::SetWindowPos($h,[IntPtr]::Zero,80,80,0,0,0x0001 -bor 0x0004 -bor 0x0040);` +
          `Start-Sleep -Milliseconds 200;[void][SWs]::MoveWindow($h,80,80,820,700,$true);` +
          `Start-Sleep -Milliseconds 300;$r=New-Object SWs+RECT;[void][SWs]::GetWindowRect($h,[ref]$r);` +
          `Write-Output ("$($r.L),$($r.T),$($r.R-$r.L),$($r.B-$r.T)")`,
      );
      await sleep(350);
    }
    return pos || readPos();
  })();
};
const hide = (h) => ps(`${CS}\n[void][SWs]::ShowWindow([IntPtr]${h},0);'ok'`);

const out = { ok: false, steps: [] };
const step = (m) => out.steps.push(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const be = new (await import('file://' + BRIDGE.split('\\').join('/'))).PowerShellBackend({ timeoutMs: 60000 });
let hwnd = num('hwnd', 0);
try {
  if (!hwnd) {
    try {
      hwnd = Number(JSON.parse(readFileSync(join(ROOT, 'state', 'qq-a11y.json'), 'utf8'))[String(pid)]?.hwnd) || 0;
    } catch {}
  }
  if (!hwnd) throw new Error('没有 hwnd（先跑 tools/qq-a11y.mjs read --pid ' + pid + '）');

  await be.start();
  show(hwnd);
  await sleep(1800);

  const read = async () => {
    const r = await uiaRetry(() => be.request('uitree', {
      hwnd, maxDepth: 30, maxNodes: 8000, prune: false, skipEmpty: false, patterns: true,
    }), { label: 'uitree' });
    return (r.nodes || []).map((n) => ({
      ref: n.ref,
      t: String(n.controlType || '').replace('ControlType.', ''),
      name: String(n.name || '').trim(),
      x: Number(n.x) || 0, y: Number(n.y) || 0,
      w: Number(n.width) || 0, h: Number(n.height) || 0,
    }));
  };

  const titleOf = (nodes) => {
    const t = nodes
      .filter((n) => /Group|Text|Button/.test(n.t) && n.y < 300 && n.y > 60 && n.name)
      .find((n) => n.x < 3200 && n.x + n.w > 3400);
    return t ? t.name : '';
  };

  let nodes = await read();
  out.before = titleOf(nodes);
  step('当前会话: 「' + out.before + '」');

  if (out.before.includes(group)) {
    out.ok = true;
    out.switched = false;
    out.group = group;
    step('已经在目标群里，不用切');
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  }

  // 会话列表项：**必须落在「会话列表」Pane 的矩形里**
  // ⚠️ 之前用绝对 x<3050 判断 —— 窗口位置一变（1800→1700）就错抓到消息区里的同名节点 ✗
  const sess = nodes.find((n) => n.t === 'Pane' && /会话列表/.test(n.name));
  if (!sess) throw new Error('找不到「会话列表」容器')
  step('会话列表矩形: ' + sess.x + ',' + sess.y + ' ' + sess.w + 'x' + sess.h);
  const inSess = (n) => n.x >= sess.x - 2 && n.x <= sess.x + sess.w + 2 && n.y >= sess.y - 2 && n.y <= sess.y + sess.h + 2;
  const item = nodes.find((n) => n.name.includes(group) && inSess(n));
  if (!item) throw new Error('会话列表里没看到「' + group + '」');
  const cx = Math.round(item.x + item.w / 2);
  const cy = Math.round(item.y + item.h / 2);
  out.clicked = { x: cx, y: cy };
  step('点会话项「' + item.name.slice(0, 24) + '」(' + cx + ',' + cy + ')');

  // ⚠️ 必须发**真实鼠标事件**：worker 的 click 在坐标处找到控件就走 a11y，
  //    返回 via:"a11y", events:0 —— QQ 根本不响应（实测切群一直失败就是这个）✗
  let clickRaw = '';
  try {
    clickRaw = execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'qq-click.ps1'), '-X', String(cx), '-Y', String(cy)],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    ).trim();
  } catch {}
  step('真实鼠标点击 → ' + clickRaw);
  await sleep(2000);

  nodes = await read();
  out.after = titleOf(nodes);
  out.switched = out.after.includes(group);
  out.ok = out.switched;
  out.group = group;
  step('切换后: 「' + out.after + '」' + (out.switched ? ' ✅' : ' ❌'));
  if (!out.switched) out.error = '点击了但标题没变';
} catch (e) {
  out.ok = false;
  out.error = String(e?.message ?? e);
  step('ERROR ' + out.error);
} finally {
  try { be.dispose(); } catch {}
  if (hwnd && !keep) hide(hwnd);
}
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(out.ok ? 0 : 1);
