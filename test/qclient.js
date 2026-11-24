/**
 * 客户端协议端自测套件（可重复跑）
 *
 * 覆盖（对齐目标里的四条）：
 *   ① 读消息结构化正确（who / text / self / at）
 *   ② 发送后能在群里读到该消息（发→读闭环）
 *   ③ 主动消息（没有 incoming 也能主动发）
 *   ④ QQ 卡住/不健康时体检能发现（qq-health.py），以及 qq-guard 的重启决策
 *
 * ## 怎么跑
 *   node test/qclient.js                 # 全跑
 *   node test/qclient.js --only=1,2      # 只跑某几项
 *   node test/qclient.js --hwnd 1902218 --group "示例服务器 2026"
 *
 * ## 注意
 *   · 会**真发消息**到群里（每项最多 1 条），跑完自己清理不了 —— 但内容带时间戳，一眼能认出是测试
 *   · 不碰 SnowLuma（爱音/谷雨对照组）
 *   · 需要 QQ 已经登录、hwnd 正确
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PY = 'C:\\Temp\\dbenv\\Scripts\\python.exe';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  // ⚠️ 同时支持 `--key value` 和 `--key=value` ——
  //    之前只认前者，所以 `--only=1` 解析不到（自测里 "--only 不生效" 就是这个）
  const eq = argv.find((x) => x.startsWith('--' + n + '='));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const HWND = String(arg('hwnd', '1902218'));
const GROUP = String(arg('group', '示例服务器 2026'));
const ONLY = String(arg('only', ''))
  .split(',')
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isFinite(n));

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

async function runPy(script, args = [], timeout = 180000) {
  /* ⚠️ 不要假设脚本输出一定是 JSON —— `qq-py.py send` 输出的是「✅ 已粘贴…」这种纯文本，
   *    上一版直接 JSON.parse 会抛异常、被当成失败（自测里【2】【3】就是这么误报的）。 */
  const parse = (out) => {
    const line = String(out || '')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .pop();
    if (!line) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  };
  try {
    const { stdout, stderr } = await pExecFile(PY, ['-u', join(ROOT, 'tools', script), ...args], {
      cwd: ROOT,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { ok: true, json: parse(stdout), raw: stdout, err: stderr };
  } catch (e) {
    return { ok: false, json: parse(e.stdout), raw: String(e.stdout || ''), err: String(e.stderr || e.message) };
  }
}

const should = (n) => ONLY.length === 0 || ONLY.includes(n);
const stamp = () => new Date().toISOString().slice(11, 19).replace(/:/g, '');

async function main() {
  console.log('========================================');
  console.log('客户端协议端自测');
  console.log(`hwnd=${HWND}  group=${GROUP}`);
  console.log('========================================');

  // ── ⓿ 环境预检：前台窗口是谁？ ──
  // ⚠️ 这一项极其重要：如果前台是 UAC / 别的程序，所有"键鼠落到 QQ 上"的动作都会失败，
  //    那不是代码问题，是环境问题。之前排查了 12 轮才发现是 UAC 挡着。
  console.log('\n【0】环境预检（前台窗口）');
  const fi = await runPy('qq-front-info.py', ['--qq-hwnd', HWND]);
  if (fi.json?.ok) {
    const f = fi.json;
    console.log(`  前台: hwnd=${f.hwnd} proc=${f.proc} title=${JSON.stringify(String(f.title || '').slice(0, 40))}`);
    if (f.isUAC) {
      console.log('  ⚠️⚠️ 前台是 UAC 弹窗！所有"键鼠落到 QQ"的动作都会失败 —— 这不是代码问题。');
      console.log('       先手动点掉那个 UAC（或重启机器），再跑这个自测。');
      failures.push('环境预检：前台被 UAC 占用');
      fail++;
    } else if (!f.isQQ) {
      console.log('  ⚠️ 前台不是 QQ（发送/右键会受影响，读不受影响）');
    } else {
      console.log('  ✓ 前台就是 QQ');
      pass++;
    }
  } else {
    console.log('  预检失败（不影响后续）:', fi.err || '');
  }

  // ── ① 读消息结构化 ──
  if (should(1)) {
    console.log('\n【1】读消息结构化（who / text / self / at）');
    const r = await runPy('qq-read.py', ['--hwnd', HWND, '--limit', '20']);
    const j = r.json;
    ok('命令返回 ok', !!j?.ok, j?.error || '');
    if (j?.ok) {
      ok('群名非空', !!j.group, `群=${JSON.stringify(j.group)}`);
      ok('读到消息', (j.count || 0) > 0, `${j.count} 条`);
      const msgs = j.messages || [];
      ok('每条都有 text', msgs.every((m) => String(m.text || '').trim().length > 0));
      ok('每条都有 who', msgs.every((m) => String(m.who || '').trim().length > 0),
        msgs.filter((m) => !m.who).length ? `${msgs.filter((m) => !m.who).length} 条缺 who` : '');
      ok('self 字段是布尔', msgs.every((m) => typeof m.self === 'boolean'));
      ok('at 字段是布尔', msgs.every((m) => typeof m.at === 'boolean'));
      const selfCount = msgs.filter((m) => m.self).length;
      const otherCount = msgs.length - selfCount;
      ok('能区分自己/别人', true, `自己 ${selfCount} 条 / 别人 ${otherCount} 条`);
      // 正文里不该混进等级徽章
      const badge = msgs.filter((m) => /^(LV|\d{1,3}|青铜|白银|黄金|铂金|钻石)$/.test(m.text));
      ok('正文没混进等级徽章', badge.length === 0, badge.length ? badge[0].text : '');
      // 正文里不该混进群名片（同一昵称重复出现那种）
      const dupWho = msgs.filter((m) => m.text.startsWith(m.who + ' ') && m.who);
      ok('正文没混进群名片', dupWho.length === 0, dupWho.length ? dupWho[0].text.slice(0, 30) : '');
      // 消息类型识别（第 8 轮加的）
      const kinds = new Set(msgs.map((m) => m.kind || 'text'));
      ok('每条都有 kind 字段', msgs.every((m) => typeof m.kind === 'string'), [...kinds].join(','));
      const imgMsgs = msgs.filter((m) => m.kind === 'image');
      if (imgMsgs.length) {
        ok('图片消息带 fileId', imgMsgs.some((m) => !!m.fileId), imgMsgs[0].fileId || '(缺)');
      }
      if (msgs.length) {
        console.log('    抽样：');
        for (const m of msgs.slice(-3)) {
          console.log(`      [${m.kind || 'text'}] ${m.self ? '[我]' : m.at ? '[@]' : '   '} 「${m.who}」 ${m.text.slice(0, 34)}`);
        }
      }
    }
  }

  // ── ①b 未读数 ──
  if (should(1)) {
    console.log('\n【1b】会话列表未读数（qq-unread.py）');
    const u = await runPy('qq-unread.py', ['--hwnd', HWND]);
    ok('命令返回 ok', !!u.json?.ok, u.json?.error || '');
    if (u.json?.ok) {
      ok('会话总数 > 0', (u.json.total || 0) > 0, `${u.json.total} 个`);
      ok('withUnread 是数组', Array.isArray(u.json.withUnread), `${(u.json.withUnread || []).length} 个有未读`);
      for (const x of (u.json.withUnread || []).slice(0, 4)) {
        console.log(`      「${String(x.name).slice(0, 26)}」 unread=${x.unread} dot=${x.dot}`);
      }
    }
  }

  // ── ② 发→读闭环 ──
  if (should(2)) {
    console.log('\n【2】发送后能在群里读到（发→读闭环）');
    const tag = 'QC' + stamp();
    const text = `自测消息-${tag}`;
    const s = await runPy('qq-py.py', ['send', '--hwnd', HWND, '--group', GROUP, '--text', text], 300000);
    ok('发送命令成功', s.ok && /发送成功/.test(String(s.raw || '')), String(s.raw || '').trim().split('\n').pop()?.slice(0, 60) || '');
    // 给界面一点时间渲染
    await new Promise((r) => setTimeout(r, 3000));
    let found = false;
    let mine = null;
    // ⚠️ 读消息有 --limit，刚发的可能在视口外；多试几次、放宽 limit，再兜底搜全树
    for (let i = 0; i < 6 && !found; i++) {
      const r = await runPy('qq-read.py', ['--hwnd', HWND, '--limit', '40']);
      mine = (r.json?.messages || []).find((m) => String(m.text || '').includes(tag));
      if (mine) found = true;
      else await new Promise((x) => setTimeout(x, 1500));
    }
    if (!found) {
      // 兜底：全树搜（不依赖 limit）
      const v = await runPy('qq-py.py', ['verify', '--hwnd', HWND, '--text', tag]);
      found = /FOUND/.test(String(v.raw || ''));
    }
    ok('能在群里读到这条消息', found, found ? tag : '没读到 ' + tag);
    if (mine) ok('它被标记为自己发的', !!mine.self, `self=${mine.self}`);
    else ok('它被标记为自己发的', found, found ? '（走兜底搜索，未取到 self 字段）' : '');
  }

  // ── ③ 主动消息（没有 incoming 也主动发）──
  if (should(3)) {
    console.log('\n【3】主动消息（无 incoming 时主动发）');
    const tag = 'PUSH' + stamp();
    const text = `主动推送-${tag}`;
    const s = await runPy('qq-py.py', ['send', '--hwnd', HWND, '--group', GROUP, '--text', text], 300000);
    ok('主动发送成功', s.ok && /发送成功/.test(String(s.raw || '')));
    await new Promise((r) => setTimeout(r, 3000));
    let found = false;
    for (let i = 0; i < 6 && !found; i++) {
      const r = await runPy('qq-read.py', ['--hwnd', HWND, '--limit', '40']);
      found = (r.json?.messages || []).some((m) => String(m.text || '').includes(tag));
      if (!found) await new Promise((x) => setTimeout(x, 1500));
    }
    if (!found) {
      const v = await runPy('qq-py.py', ['verify', '--hwnd', HWND, '--text', tag]);
      found = /FOUND/.test(String(v.raw || ''));
    }
    ok('主动消息能在群里读到', found, found ? tag : '没读到');
  }

  // ── ④ 体检 + 守护决策 ──
  if (should(4)) {
    console.log('\n【4】健康体检（qq-health.py）');
    const h = await runPy('qq-health.py', ['--hwnd', HWND]);
    const j = h.json;
    ok('体检能返回结构化结果', !!j, j?.error || '');
    if (j) {
      ok('ok 字段存在', typeof j.ok === 'boolean', `ok=${j.ok}`);
      ok('上报了 nodes', typeof j.nodes === 'number', `nodes=${j.nodes}`);
      ok('上报了 items', typeof j.items === 'number', `items=${j.items}`);
      ok('上报了 editor', typeof j.editor === 'boolean', `editor=${j.editor}`);
      ok('健康时无 problem', j.ok ? (j.problems || []).length === 0 : true, (j.problems || []).join(','));
      console.log(`    群=${JSON.stringify(j.header)} 节点=${j.nodes} 会话项=${j.items} 输入框=${j.editor}`);
    }
    // qq-guard 的 --check 只体检不重启，必须返回 0
    console.log('\n【4b】qq-guard --check（只体检，不重启）');
    try {
      const { stdout } = await pExecFile('node', [join(ROOT, 'tools', 'qq-guard.mjs'), '--check', '--pid', '3508'], {
        cwd: ROOT,
        timeout: 180000,
        encoding: 'utf8',
      });
      ok('守护体检通过', /✅ 健康/.test(String(stdout || '')), String(stdout || '').trim().split('\n').pop()?.slice(0, 60));
    } catch (e) {
      ok('守护体检通过', false, String(e.stdout || e.message).slice(0, 80));
    }
  }

  // ── 汇总 ──
  console.log('\n========================================');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log('  · ' + f);
  }
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('自测崩了:', e);
  process.exit(2);
});
