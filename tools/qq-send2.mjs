#!/usr/bin/env node
/**
 * ## ⚠️ 分两层，别混（这次踩了很久才分清）
 *
 *   **控件层（优先，不需要前台、不移动鼠标）**
 *     · 切群        → 「会话列表」里那一项的 rect → 点；或 uiact invoke（若该控件有 invoke）
 *     · 点「发送」  → [Button] patterns 含 invoke，`uiact {ref, action:"invoke"}` ✓
 *     ⚠️ 但「发送」在**输入框为空时是 disabled** —— 控件层会明确报 "the matched element is disabled"，
 *        这其实是**最好的探针**：它 disabled 就说明没内容，别硬发。
 *
 *   **键盘层（只有"输入"这一步需要，必须前台 + 真实焦点）**
 *     · 点消息输入框 → **必须发真实鼠标事件**（mouse_event）。
 *       ⚠️ worker 的 click 会在坐标处找控件、然后走 a11y 路径，返回 via:"a11y", events:0 ——
 *          一个真实事件都没发，输入框拿不到焦点，后面 Ctrl+V 就粘到别处去了 ✗
 *     · 粘贴正文     → Ctrl+V（SendInput），需要前台
 *
 *   ⇒ 结论：**除了"把字输进去"这一步，其它一律走控件层。**
 */
/**
 * 用客户端在 QQ 里发一条消息 —— **一次进程内做完**（读树 → 点群 → 点输入框 → 粘贴 → 回车）。
 *
 * ## 为什么不复用 cu-host.ps1
 *   实测它在这条链路上会「执行器超时（没等到 result.json）」——
 *   它内部是"写任务文件 → 另起一个 PowerShell → 等结果文件"，多一层进程 + 多一次权限切换，
 *   在这里反而更脆。整条链放进一个 Node 进程里反而稳（ref 也不用跨进程传）。
 *
 * ## 用法
 *   node tools/qq-send2.mjs --pid 31288 --group "示例服务器 2026" --text "@Saki 在吗"
 *   node tools/qq-send2.mjs --pid 31288 --group "示例服务器 2026" --text "..." --keep
 *
 * ## 关键约束（都是实测踩出来的）
 *   · `uiact {ref, action:'invoke'}` 切群**不需要前台、不移动光标** ✓ 优先用它
 *   · `click --ref` 会返回 (0,0)（worker 的 a11y 坐标换算有 bug）⇒ 别用
 *   · 消息输入框是 contenteditable，UIA 树里只有 `[Edit] 搜索` ⇒ 只能"点输入框 + 键盘"
 *   · 键盘（paste）**必须前台** ⇒ 临时把窗口提到前台，发完立刻藏回托盘
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
const text = String(arg('text', ''));
const keep = argv.includes('--keep');
if (!pid || !group || !text) {
  console.log(JSON.stringify({ ok: false, error: '要 --pid --group --text' }));
  process.exit(1);
}

/* ── 窗口显示 / 前台 / 隐藏 ── */
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
function ps(script, timeout = 25000) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
    }).trim();
  } catch (e) {
    return '';
  }
}
const showAndFront = (h) => {
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
function hide(hwnd) {
  return ps(`${CS}\n[void][SWx]::ShowWindow([IntPtr]${hwnd},0);'ok'`);
}

const out = { ok: false, steps: [] };
const step = (m) => out.steps.push(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const be = new (await import('file://' + BRIDGE.split('\\').join('/'))).PowerShellBackend({ timeoutMs: 90000 });
let hwnd = num('hwnd', 0);
try {
  if (!hwnd) {
    try {
      hwnd = Number(JSON.parse(readFileSync(join(ROOT, 'state', 'qq-a11y.json'), 'utf8'))[String(pid)]?.hwnd) || 0;
    } catch {}
  }
  if (!hwnd) throw new Error('没有 hwnd（先跑 tools/qq-a11y.mjs read --pid ' + pid + '）');
  step('窗口 hwnd=' + hwnd);

  await be.start();
  const fg = await showAndFront(hwnd);
  step('显示+抢前台，前台=' + fg + '（目标 ' + hwnd + '）');
  await sleep(2200);

  const readTree = async (deep) => {
    const r = await uiaRetry(() => be.request('uitree', {
      hwnd, maxDepth: deep ? 30 : 8, maxNodes: deep ? 8000 : 400,
      prune: false, skipEmpty: false, patterns: true,
    }), { label: 'uitree' });
    return (r.nodes || []).map((n) => ({
      ref: n.ref,
      type: String(n.controlType || '').replace('ControlType.', ''),
      name: String(n.name || '').trim(),
      x: Number(n.x) || 0, y: Number(n.y) || 0,
      w: Number(n.width) || 0, h: Number(n.height) || 0,
      patterns: n.patterns || [],
    }));
  };

  /* ① 找会话项并切过去 */
  let nodes = await readTree(true);
  step('读树 ' + nodes.length + ' 节点');
  const item = nodes.find((n) => n.name && n.name.includes(group) && n.y > 200 && n.y < 1200 && n.x < 3050);
  if (!item) throw new Error('会话列表里没看到「' + group + '」');
  step('会话项「' + item.name.slice(0, 24) + '」ref=' + item.ref + ' patterns=' + JSON.stringify(item.patterns));

  // 优先 a11y invoke（不需要前台、无光标移动）；不行再退回坐标点
  let switched = false;
  if ((item.patterns || []).some((p) => /invoke/i.test(p))) {
    const r = await uiaRetry(() => be.request('uiact', { ref: item.ref, action: 'invoke' }), { label: 'uiact' }).catch((e) => ({ err: e.message }));
    step('uiact invoke → ' + JSON.stringify(r).slice(0, 120));
    switched = !r?.err;
  }
  if (!switched) {
    const cx = Math.round(item.x + item.w / 2);
    const cy = Math.round(item.y + item.h / 2);
    const r = await be.request('click', { x: cx, y: cy }).catch((e) => ({ err: e.message }));
    step('坐标点击 (' + cx + ',' + cy + ') → ' + JSON.stringify(r).slice(0, 90));
  }
  await sleep(1800);

  /* ② 确认切过来了（标题里应出现群名） */
  nodes = await readTree(true);
  const titleOk = nodes.some((n) => n.name.includes(group) && n.y < 300);
  step('切换确认：' + (titleOk ? '✅ 已进入 ' + group : '⚠️ 标题里没看到群名'));

  /* ③ 找输入框位置：**按本窗口自己的矩形算**
   *
   * ⚠️ 踩过的坑：原来拿「消息列表」Pane 的下沿 + 70 当输入框 y ——
   *    那个 pane 的坐标是**另一个窗口尺寸**下的（窗口一换，y 直接飞出窗口），
   *    结果 paste 打在窗口外面，回车也没提交，消息根本没发出去 ✗
   *    ⇒ 改成：窗口左 + 55% 宽、窗口上 + 88% 高（QQ 输入框固定在底部那片）。
   */
  // ⚠️ 不能用 UIA 的 Window 节点（它是 1350x1140，含窗口阴影，比真实窗口大）
  //    ⇒ 用前面 show() 回读的 GetWindowRect 结果 "L,T,W,H"
  // ⚠️ 实测：QQ **拒绝改变窗口尺寸**（MoveWindow 只改了位置，尺寸还是 1230x1050），
  //    所以这里用 GetWindowRect 拿真值，拿不到就按 1230x1050 兜底。
  const rectRaw = ps(
    `${CS}\n$h=[IntPtr]${hwnd};$r=New-Object SWs+RECT;[void][SWs]::GetWindowRect($h,[ref]$r);` +
      `Write-Output ("$($r.L),$($r.T),$($r.R-$r.L),$($r.B-$r.T)")`,
  );
  const rp = String(rectRaw || "").split(",").map(Number);
  const winRect = {
    x: Number.isFinite(rp[0]) ? rp[0] : 120,
    y: Number.isFinite(rp[1]) ? rp[1] : 120,
    w: Number.isFinite(rp[2]) && rp[2] > 200 ? rp[2] : 1230,
    h: Number.isFinite(rp[3]) && rp[3] > 200 ? rp[3] : 1050,
  };
  // 输入区：截图实测在窗口纵向 800/1050 ≈ 0.86 那一带，横向取 0.5
  const ix = Math.round(winRect.x + winRect.w * 0.5);
  const iy = Math.round(winRect.y + winRect.h * 0.86);
  // 「发送」按钮：截图实测 (1128,1003) / 1230x1050 ⇒ 0.917 / 0.955
  const sx = Math.round(winRect.x + winRect.w * 0.917);
  const sy = Math.round(winRect.y + winRect.h * 0.955);  step("窗口真实矩形 " + JSON.stringify(winRect));
  step("输入框估算 (" + ix + "," + iy + ")");
  /* ④ 点输入框 → 粘贴 → 回车（必须前台，已抢到） */
  // ⚠️ 必须用**真实鼠标事件**点输入框：worker 的 click 会走 a11y（events:0），焦点进不去
  const cRaw = (() => {
    try {
      return execFileSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'qq-click.ps1'), '-X', String(ix), '-Y', String(iy)],
        { encoding: 'utf8', timeout: 20000, windowsHide: true },
      ).trim();
    } catch {
      return '';
    }
  })();
  step('真实鼠标点输入框 (' + ix + ',' + iy + ') → ' + cRaw + '  [hwnd|pid|foreground]');
  await sleep(500);

  /* ③.5 抢前台：调起键盘事件**必须**本窗口在前台（实测被 DSH 抢走过一次，回车打到了别的窗口）*/
  const grabFront = () => {
    // ⚠️ 走独立 .ps1：`powershell -Command "...here-string..."` 会静默编译失败（错误被吞），
    //    实测返回空串，害得回车打到了 DSH 窗口上 ✗
    try {
      // ⚠️ 先确保窗口"可见"：worker 的 paste/key 会检查 IsWindowVisible，
      //    隐藏状态直接拒（报 "would go nowhere ... not a visible window"）✗
      ps(`${CS}\n[void][SWs]::ShowWindow([IntPtr]${hwnd},8);'ok'`); // SW_SHOWNA
      const r = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'qq-front.ps1'), '-Hwnd', String(hwnd)], {
        encoding: "utf8", timeout: 20000, windowsHide: true,
      }).trim();
      const lines = r.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      return lines.length ? lines[lines.length - 1] : '';
    } catch {
      return '';
    }
  };
  let fgNow = grabFront();
  step("抢前台 → " + fgNow + "（要 " + hwnd + "）");
  if (Number(fgNow) !== hwnd) {
    await sleep(300);
    fgNow = grabFront();
    step("再抢一次 → " + fgNow);
  }

  const p = await be.request('paste', { text }).catch((e) => ({ err: e.message }));
  step('paste ' + text.length + ' 字 → ' + JSON.stringify(p).slice(0, 80));
  await sleep(700);

  // ⚠️ 回车之前再抢一次 —— paste 之间可能又被别人抢走
  const fg2 = grabFront();
  step("回车前前台=" + fg2);
  /* ④.5 提交：**优先用控件层 invoke**（「发送」是 Button，有 invoke 模式）
   *
   * ⚠️ 实测：坐标点/回车都试过，消息都没发出去；而 QQ 的「发送」是个真 Button，
   *    能 invoke 就直接走控件层 —— 不依赖坐标、不依赖前台、不会被窗口尺寸变化搞错 ✓
   */
  const afterPaste = await readTree(true);
  const sendBtn = afterPaste.find((n) => n.type === "Button" && /^发送$/.test(n.name));
  if (sendBtn) {
    const pats = sendBtn.patterns || [];
    step("找到「发送」按钮 ref=" + sendBtn.ref + " patterns=" + JSON.stringify(pats));
    if (pats.some((p) => /invoke/i.test(p))) {
      const r = await be.request("uiact", { ref: sendBtn.ref, action: "invoke" }).catch((e) => ({ err: e.message }));
      step("uiact invoke 发送 → " + JSON.stringify(r).slice(0, 110));
    } else {
      const r = await be.request("click", { x: Math.round(sendBtn.x + sendBtn.w / 2), y: Math.round(sendBtn.y + sendBtn.h / 2) }).catch((e) => ({ err: e.message }));
      step("按控件 rect 点发送 → " + JSON.stringify(r).slice(0, 90));
    }
    await sleep(900);
  } else {
    step("没找到「发送」按钮，退回坐标 + 回车");
    await be.request("click", { x: sx, y: sy }).catch(() => {});
    await sleep(700);
    await be.request("key", { keys: "enter" }).catch(() => {});
  }  await sleep(1200);

  /* ⑤ 验证：读一次看消息里有没有这句 */
  nodes = await readTree(true);
  const sent = nodes.some((n) => n.name.includes(text.slice(0, 10)));
  out.verified = sent;
  step('发后读树确认：' + (sent ? '✅ 消息已在界面里' : '⚠️ 没在界面里找到这句'));

  out.ok = true;
  out.hwnd = hwnd;
  out.group = group;
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
