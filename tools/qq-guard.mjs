/**
 * QQ 客户端守护：体检 → 不健康就自动重启 → 重启后自动打开会话。
 *
 * ## 为什么需要
 *   今天一晚上"QQ 卡住"出现了很多次，每次都要人手动重启。判据是可测的：
 *   UIA 节点数、会话项数、输入框在不在。
 *
 * ## 用法
 *   node tools/qq-guard.mjs --pid 14492            # 体检一次，不健康就重启
 *   node tools/qq-guard.mjs --pid 14492 --check    # 只体检，不重启
 *   node tools/qq-guard.mjs --pid 14492 --watch    # 常驻，每 60 秒体检一次
 *
 * ## 重启做什么（顺序固定，都是踩出来的）
 *   ① 按 PID 杀**整个进程树**（只杀主进程会留 renderer 复用坏状态）
 *   ② 用 explorer 起 .bat（不在我的 job 里，也在用户桌面会话）
 *   ③ 等 25 秒让它自动登录
 *   ④ 体检；不健康就再等 20 秒重试一次
 *   ⑤ 自动打开一个会话（没会话的话）
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PY = 'C:\\Temp\\dbenv\\Scripts\\python.exe';
const HEALTH = join(HERE, 'qq-health.py');
const BAT = join(ROOT, '_qq-saki-nohide.bat');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PID = Number(arg('pid', 0));
const CHECK_ONLY = argv.includes('--check');
const WATCH = argv.includes('--watch');
const OPEN_GROUP = String(arg('open-group', '示例服务器 2026'));

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

/** 体检（调 Python），返回解析后的对象 */
function health(hwnd, openGroup) {
  const args = [HEALTH, '--hwnd', String(hwnd)];
  if (openGroup) args.push('--open-group', openGroup);
  try {
    const out = execFileSync(PY, ['-u', ...args], { encoding: 'utf8', timeout: 90000, cwd: ROOT });
    const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
    return JSON.parse(line);
  } catch (e) {
    // health 返回 2 表示不健康，stdout 里仍有 JSON
    const s = String(e.stdout || '');
    const line = s.trim().split(/\r?\n/).filter(Boolean).pop();
    if (line) {
      try {
        return JSON.parse(line);
      } catch {}
    }
    return { ok: false, problems: ['health_call_failed:' + String(e.message).slice(0, 50)] };
  }
}

/** 找这个 QQ pid 的主窗口 hwnd（优先 visible 的 Chrome_WidgetWin_1） */
function findHwnd(pid) {
  try {
    const out = execFileSync('node', [join(HERE, 'qq-a11y.mjs'), 'list', '--pid', String(pid)], {
      encoding: 'utf8',
      timeout: 60000,
      cwd: ROOT,
    });
    const j = JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop());
    const wins = (j.windows || []).filter((w) => /Chrome_WidgetWin_1/.test(w.cls || ''));
    const vis = wins.find((w) => w.visible);
    return (vis || wins[0] || {}).hwnd || 0;
  } catch {
    return 0;
  }
}

/** 杀整个进程树（只杀主进程会留 renderer） */
function killTree(pid) {
  const seen = new Set();
  const collect = (pp) => {
    if (seen.has(pp)) return;
    seen.add(pp);
    try {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pp}" -ErrorAction SilentlyContinue).ProcessId`],
        { encoding: 'utf8', timeout: 20000 },
      );
      for (const line of out.split(/\r?\n/)) {
        const n = Number(line.trim());
        if (Number.isFinite(n) && n > 0) collect(n);
      }
    } catch {}
  };
  collect(pid);
  const all = [...seen].sort((a, b) => b - a); // 先杀子进程
  for (const p of all) {
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${p} -Force -ErrorAction SilentlyContinue`], { timeout: 15000 });
    } catch {}
  }
  return all.length;
}

function findMainPid() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId`],
      { encoding: 'utf8', timeout: 20000 },
    );
    const pids = out.split(/\r?\n/).map((x) => Number(x.trim())).filter((n) => n > 0);
    return pids;
  } catch {
    return [];
  }
}

async function restart(pids) {
  log('重启：杀进程树', pids.join(','));
  let total = 0;
  for (const p of pids) total += killTree(p);
  log('  杀了', total, '个进程');
  await sleep(6000);
  const left = findMainPid();
  if (left.length) {
    log('  ⚠️ 还剩', left.length, '个主进程（可能有保护），再试一次');
    for (const p of left) killTree(p);
    await sleep(5000);
  }
  log('启动 QQ…');
  try {
    execFileSync('explorer.exe', [BAT], { timeout: 15000 });
  } catch {}
  await sleep(25000);
  const now = findMainPid();
  log('  起来的主进程:', now.join(',') || '(无)');
  return now;
}

async function once() {
  let pids = PID ? [PID] : findMainPid();
  if (!pids.length) {
    log('没有 QQ 主进程 → 直接启动');
    if (CHECK_ONLY) return false;
    try {
      execFileSync('explorer.exe', [BAT], { timeout: 15000 });
    } catch {}
    await sleep(25000);
    pids = findMainPid();
    if (!pids.length) {
      log('❌ 启动失败');
      return false;
    }
  }

  let hwnd = findHwnd(pids[0]);
  let h = health(hwnd, OPEN_GROUP);
  log(`体检: ok=${h.ok} nodes=${h.nodes} items=${h.items} editor=${h.editor} header=${JSON.stringify(h.header)}`);
  if (h.problems && h.problems.length) log('  问题:', h.problems.join(', '));

  // "没打开会话"可以自动修（不是重启级问题）
  if (!h.ok && h.problems && h.problems.every((p) => p === 'no_open_session')) {
    log('只有"没打开会话"→ 尝试自动打开', OPEN_GROUP);
    h = health(hwnd, OPEN_GROUP);
    log(`  再体检: ok=${h.ok} editor=${h.editor} header=${JSON.stringify(h.header)}`);
  }

  if (h.ok) {
    log('✅ 健康');
    return true;
  }
  if (CHECK_ONLY) {
    log('❌ 不健康（--check 不重启）');
    return false;
  }

  // 真不健康 → 重启
  const now = await restart(pids);
  if (!now.length) {
    log('❌ 重启后仍无进程');
    return false;
  }
  hwnd = findHwnd(now[0]);
  log('重启后 hwnd=', hwnd);
  // 等登录 + 再体检一次
  for (let i = 0; i < 3; i++) {
    await sleep(20000);
    h = health(hwnd, OPEN_GROUP);
    log(`  第${i + 1}次复查: ok=${h.ok} nodes=${h.nodes} items=${h.items} editor=${h.editor}`);
    if (h.ok) {
      log('✅ 重启后恢复健康');
      return true;
    }
  }
  log('❌ 重启后仍不健康:', (h.problems || []).join(', '));
  return false;
}

if (WATCH) {
  log('常驻守护启动，每 60 秒体检一次（Ctrl+C 退出）');
  for (;;) {
    try {
      await once();
    } catch (e) {
      log('守护异常:', String(e.message).slice(0, 120));
    }
    await sleep(60000);
  }
} else {
  const ok = await once();
  process.exit(ok ? 0 : 1);
}
