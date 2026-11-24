/**
 * 从 QQ 界面读结构化消息 —— 替代协议端的 receive 那一半。
 *
 * ## 靠什么认（2026-11-14 实测 QQ NT 9.9.33，窗口 820x700、150% DPI、放在屏幕外）
 *
 * 整个窗口的 UIA 树按 **x 坐标天然分区**（实测值，随窗口移动会整体平移，所以用**相对窗口**算）：
 *
 *   侧栏       x = 窗口左 + 6
 *   会话列表   x = 窗口左 + 84  ~ +405    （宽 321）
 *   消息区     x = 窗口左 + 405 ~ +1074   （宽 669）
 *   成员栏     x = 窗口左 + 1077 起
 *
 * 消息区里一条消息的固定形态：
 *
 *   y=354  x=+471 235x24  昵称            ← 昵称的 x 恒定（头像右边）
 *   y=355  x=+401  17x21  "LV"            ← 徽章，剔掉
 *   y=355  x=+429  31x21  "小豆"          ← 群名片后缀，并进昵称
 *   y=396  x=+410 399x29  正文            ← 正文的 x 恒定（比昵称靠左 61px）
 *
 * ⇒ 所以解析是三步：
 *   ① 只取 x 落在「消息区」里的节点（把会话列表 / 成员栏整片排掉）
 *   ② 按 y 聚块：同一个 y 带（±70）算同一条消息（昵称行 + 正文行差 42）
 *   ③ 块内按 x 分：x 靠右的是昵称，x 靠左且高度 ≥25 的是正文
 *
 * ## 用法
 *   node tools/qq-inbox.mjs --pid 33932                    # 读当前会话
 *   node tools/qq-inbox.mjs --pid 33932 --hwnd 17437954    # 直接给窗口
 *   node tools/qq-inbox.mjs --pid 33932 --json             # 完整 JSON
 *
 * ## 输出
 *   { ok, group, count, messages: [{who, text, at, atMe}], fresh: [...] }
 *   `fresh` = 跟上次快照比新出现的（轮询用这个判断"有新消息"）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const STATE = join(ROOT, 'state', 'qq-inbox.json');
const A11Y_CACHE = join(ROOT, 'state', 'qq-a11y.json');

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
if (!pid) {
  console.log(JSON.stringify({ ok: false, error: '要 --pid' }));
  process.exit(1);
}

/* ── 窗口显示（屏幕外）+ 强制重绘，之后自动藏回托盘 ── */
const DW_CS = `
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


/**
 * 窗口显示/隐藏，**统一走 tools/qq-topmost.ps1**（那个是实测可用的）。
 * ⚠️ 别在这儿自己拼 PowerShell：inbox 里的 P/Invoke 类名和 CS 常量曾经对不上，
 *    报 `Unable to find type [DWq]`，结果读树拿回 0 条消息 ✗
 */
function qqWin(hwnd, mode) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'qq-topmost.ps1'), '-Hwnd', String(hwnd), '-Mode', mode], {
      encoding: 'utf8', timeout: 25000, windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}
function psShow(hwnd, show = true) {
  const r = qqWin(hwnd, show ? 'top' : 'hide');
  return r;
}
const out = { ok: false, messages: [], fresh: [] };
const be = new (await import('file://' + BRIDGE.split('\\').join('/'))).PowerShellBackend({ timeoutMs: 90000 });
let hwnd = 0;

try {
  /* ① 找窗口 */
  hwnd = num('hwnd', 0);
  if (!hwnd) {
    try {
      hwnd = Number(JSON.parse(readFileSync(A11Y_CACHE, 'utf8'))[String(pid)]?.hwnd) || 0;
    } catch {}
  }
  if (!hwnd) throw new Error('没有 hwnd —— 给 --hwnd，或先跑 tools/qq-a11y.mjs read --pid ' + pid);

  await be.start();
  psShow(hwnd, true);
  await sleep(2200); // 建 a11y 树约 1.5s

  const tree = await uiaRetry(() => be.request('uitree', {
    hwnd,
    maxDepth: 20,
    maxNodes: 3000,
    prune: false,
    skipEmpty: false,
    patterns: true,
  }), { label: 'uitree' });
  const raw = tree.nodes || [];

  /* ② 求窗口几何（用最外层 Window 节点） */
  const win = raw.find((n) => /Window/.test(String(n.controlType || ''))) || raw[0] || {};
  const wx = Number(win.x) || 0;
  const wy = Number(win.y) || 0;

  /* ③ 找出三个关键容器，作为分区依据 */
  const paneOf = (kw) => raw.find((n) => /Pane/.test(String(n.controlType || '')) && new RegExp(kw).test(String(n.name || '')));
  const sess = paneOf('会话列表');
  const msgs = paneOf('消息列表');
  const members = paneOf('群成员列表');

  // 消息区 x 范围：以「消息列表」容器为准；没有就按窗口比例兜底
  const mx0 = msgs ? Number(msgs.x) : wx + 405;
  const mx1 = msgs ? Number(msgs.x) + Number(msgs.width) : wx + 1074;
  const my0 = msgs ? Number(msgs.y) : wy + 138;
  const my1 = msgs ? Number(msgs.y) + Number(msgs.height) : wy + 824;

  out.geometry = {
    window: { x: wx, y: wy },
    session: sess ? { x: sess.x, y: sess.y, w: sess.width, h: sess.height } : null,
    messages: { x: mx0, y: my0, w: mx1 - mx0, h: my1 - my0 },
    members: members ? { x: members.x, y: members.y } : null,
  };

  /* ④ 现会话的群名：示例群、y 在消息区下沿附近） */
  const titleNode = raw
    .filter((n) => /Group|Button|Text/.test(String(n.controlType || '')))
    .filter((n) => {
      const x = Number(n.x), y = Number(n.y), w = Number(n.width);
      return x <= mx0 + 6 && x + w >= mx1 - 40 && y > my1 - 20 && y < my1 + 200 && String(n.name || '').trim();
    })
    .sort((a, b) => Number(a.y) - Number(b.y))[0];
  out.group = titleNode ? String(titleNode.name).trim() : '';

  /* ⑤ 只留消息区里的文字节点 */
  const inMsg = raw
    .map((n) => ({
      type: String(n.controlType || '').replace('ControlType.', ''),
      name: String(n.name || '').trim(),
      x: Number(n.x) || 0,
      y: Number(n.y) || 0,
      w: Number(n.width) || 0,
      h: Number(n.height) || 0,
      ref: n.ref,
    }))
    .filter((n) => n.name && /Text|Group/.test(n.type))
    .filter((n) => n.x >= mx0 - 4 && n.x <= mx1 && n.y >= my0 - 4 && n.y <= my1 + 4);

  /* ⑥ 剔掉装饰：等级徽章 LV / 纯数字 / 纯表情名 / 时间 */
  const isBadge = (n) => n.w <= 40 && /^(LV|\d{1,3}|[A-Za-z]{1,3}\d{0,3})$/.test(n.name);
  const isTime = (n) => /^(\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日天]|\d{1,2}月\d{1,2}日|^\d{4}\/)/.test(n.name);
  const clean = inMsg.filter((n) => !isBadge(n) && !isTime(n));

  /* ⑦ 按**消息块**切分（2026-11-14 实测的结构，最可靠）
   *
   *   [Group]  x=消息区左  w≈消息区宽  h 90~260   ← **一条消息一个块**
   *     ├ [Group]  48x49  name=<发送者>          ← 头像：name 就是发送者，直接拿来当 who ✓
   *     ├ [Text]   ~235x24  昵称                 ← 和头像 name 重复，忽略
   *     ├ [Text]   17x21 "LV" / 10x21 "2" / 31x21 "小豆"  ← 徽章与群名片，剔掉
   *     └ [Group]  ~429x58  →  [Text] ~399x29    ← 正文（可能多段）
   *
   * 所以：**先认出消息块，块内找头像拿 who，其余 Text 拼正文**。
   * 系统提示（拍了拍/加入群聊）也是同样形状的块，只是没有头像 ⇒ who 留空。
   */
  const msgW = mx1 - mx0;
  const blocks = raw
    .map((n) => ({
      t: String(n.controlType || "").replace("ControlType.", ""),
      name: String(n.name || "").trim(),
      x: Number(n.x) || 0,
      y: Number(n.y) || 0,
      w: Number(n.width) || 0,
      h: Number(n.height) || 0,
    }))
    // 消息块 = Group，左边缘贴着消息区，宽度≈整个消息区，高度够放一条消息
    .filter((n) => n.t === "Group" && Math.abs(n.x - mx0) <= 3 && n.w >= msgW - 6 && n.h >= 60)
    .sort((a, b) => a.y - b.y);

  // 同一 y 上去重（外层 669x121 和内层 669x109 会同时命中，留下高的那个）
  const merged = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(b.y - last.y) <= 3) {
      if (b.h > last.h) merged[merged.length - 1] = b;
      continue;
    }
    merged.push(b);
  }

  const isBadgeText = (n) => n.w <= 40 && /^(LV|\d{1,3}|[A-Za-z]{1,4}\d{0,4})$/.test(n.name);
  const isTimeText = (n) => /^(\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日天]|\d{1,2}月\d{1,2}日|\d{4}\/\d{1,2}\/)/.test(n.name);

  const messages = [];
  for (let i = 0; i < merged.length; i++) {
    const blk = merged[i];
    const nextY = i + 1 < merged.length ? merged[i + 1].y : Infinity;
    // 块内所有节点（y 从 blk.y 到下一个块）
    const inside = raw
      .map((n) => ({
        t: String(n.controlType || "").replace("ControlType.", ""),
        name: String(n.name || "").trim(),
        x: Number(n.x) || 0,
        y: Number(n.y) || 0,
        w: Number(n.width) || 0,
        h: Number(n.height) || 0,
      }))
      // ⚠️ 必须同时卡 x：只按 y 取会把同高度的**会话列表项**也卷进来（实测串了好几个群）
      .filter((n) => n.name && n.x >= mx0 - 3 && n.x <= mx1 && n.y >= blk.y - 2 && n.y < nextY - 2);

    // who：块内第一个 48x49 左右的 Group（头像），它的 name 就是发送者
    const avatar = inside.find((n) => n.t === "Group" && n.w >= 40 && n.w <= 60 && n.h >= 40 && n.h <= 60);
    let who = avatar ? avatar.name : "";

    // 正文：块内 Text，剔掉徽章/时间/昵称（昵称与头像 name 相同或在其右侧同高）
    const texts = inside
      .filter((n) => n.t === "Text" || n.t === "Hyperlink")
      .filter((n) => !isBadgeText(n) && !isTimeText(n))
      // ⚠️ 群名片（"小豆"那种）与昵称同一行、且很短 —— 也要剔掉，否则会被拼进正文
      .filter((n) => !(avatar && Math.abs(n.y - avatar.y) <= 8 && n.w <= 70 && n.x < avatar.x + 260))
      .filter((n) => !(avatar && Math.abs(n.y - avatar.y) <= 6 && n.name === who))
      .sort((a, b) => a.y - b.y || a.x - b.x);

    const text = texts.map((n) => n.name).join(" ").trim();
    if (!text) continue;
    if (/^(发送|群公告|群聊成员|搜索群成员|聊天记录|表情|图片|文件)$/.test(text)) continue;
    messages.push({
      who,
      text,
      atMe: /@\s*(?:Saki|saki|祥子|小祥)/i.test(text),
      y: blk.y,
    });
  }

  out.debug = { blocks: merged.length, rawNodes: raw.length };
  out.ok = true;
  out.count = messages.length;
  out.messages = messages;

  /* ⑨ 与上次快照比对，得出"新的" */
  let prev = { snapshots: {} };
  try {
    if (existsSync(STATE)) prev = JSON.parse(readFileSync(STATE, 'utf8')) || prev;
  } catch {}
  if (!prev.snapshots) prev.snapshots = {};
  const key = String(hwnd);
  const prevSet = new Set((prev.snapshots[key] || []).map((m) => m.who + '|' + m.text));
  out.fresh = messages.filter((m) => !prevSet.has(m.who + '|' + m.text));
  out.freshCount = out.fresh.length;

  prev.snapshots[key] = messages.slice(-80).map((m) => ({ who: m.who, text: m.text }));
  prev.updatedAt = Date.now();
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, JSON.stringify(prev, null, 1), 'utf8');
  } catch {}
} catch (e) {
  out.ok = false;
  out.error = String(e?.message ?? e);
} finally {
  try {
    be.dispose();
  } catch {}
  if (hwnd) psShow(hwnd, false); // 用完自动藏回托盘
}
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(out.ok ? 0 : 1);
