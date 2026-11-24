/**
 * 客户端协议端的**自测套件** —— 把"能自己验的部分"全部自动验一遍。
 *
 * 跑法：
 *   node tools/selftest.mjs              # 全跑
 *   node tools/selftest.mjs --only send  # 只跑某一项
 *
 * ## 为什么这么设计
 * 「收消息」的完整闭环需要**别人真的发一条**，而实测 SnowLuma 上的另一个号
 * 发到群里 → Saki 的官方客户端**要十几分钟才渲染**（送达延迟），没法用来做实时自测。
 * 所以这里拆成两半：
 *   · **能自测的**：读界面、会话列表、发消息并读回、历史接口、去重、群名匹配
 *   · **需要人配合的**：`recv` 那项会打印"请手动发一条"，并给出要盯的日志行
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const pick = (n, d) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? d : v;
};

const only = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 ? argv[i + 1] : '';
})();

const TEST_GROUP = process.argv.includes('--group')
  ? argv[argv.indexOf('--group') + 1]
  : "谷雨、Stby'Crs、Anon、Saki"; // 4 人小群，零打扰

let pass = 0;
let fail = 0;
const rows = [];

function check(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  rows.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`);
}

await acquireLease(600);
const found = await findQQHwnd();
const HWND = String(found.hwnd);
console.log(`QQ hwnd=${HWND} pid=${found.pid} 节点=${found.nodes}\n`);

const want = (n) => !only || only === n;

// ── ① 读当前会话 ──
if (want('read')) {
  console.log('── ① 读取当前会话（--wake 唤醒路径）');
  const out = await runPy('qq-read.py', ['--hwnd', HWND, '--limit', '40', '--wake'], { timeoutMs: 120000 });
  const j = parseLastJson(String(out || ''));
  check('qq-read.py 返回 ok', !!j?.ok, j?.error || '');
  check('读到了群名', !!j?.group, j?.group || '');
  check('结构里有 messages 数组', Array.isArray(j?.messages), `count=${j?.messages?.length ?? '?'}`);
  check('结构里有 tips 数组（灰字/戳）', Array.isArray(j?.tips), `tips=${j?.tips?.length ?? '?'}`);
  const bad = (j?.messages || []).filter((m) => !m.who && !m.self);
  check('没有"无 who 且非 self"的脏条目', bad.length === 0, bad.length ? `${bad.length} 条` : '');
}

// ── ② 会话列表 + 摘要 ──
if (want('sessions')) {
  console.log('\n── ② 会话列表（多会话扫描的基础）');
  const out = await runPy('qq-sessions.py', ['--hwnd', HWND, '--wake'], { timeoutMs: 120000 });
  const j = parseLastJson(String(out || ''));
  check('qq-sessions.py 返回 ok', !!j?.ok, j?.error || '');
  check('会话数 > 0', (j?.total || 0) > 0, `total=${j?.total}`);
  const withSum = (j?.all || []).filter((s) => String(s.summary || '').trim()).length;
  check('至少一半会话读到了摘要', withSum >= Math.ceil((j?.total || 1) / 2), `${withSum}/${j?.total}`);
  const names = (j?.all || []).map((s) => String(s.name || ''));
  check('会话名都不是空串', names.every(Boolean), names.filter((x) => !x).length ? '有空名' : '');
}

// ── ③ 发消息并读回（能自测的那一半） ──
if (want('send')) {
  console.log('\n── ③ 发消息 → 读回来验证');
  const text = `自测${Date.now() % 100000}`;
  const out = await runPy(
    'qq-py.py',
    ['send', '--hwnd', HWND, '--group', TEST_GROUP, '--text', text],
    { timeoutMs: 240000 },
  );
  const s = String(out || '');
  check('发送返回「发送成功」', /发送成功/.test(s), s.trim().split('\n').slice(-1)[0] || '');
  if (/发送成功/.test(s)) {
    await new Promise((r) => setTimeout(r, 1500));
    const rd = await runPy('qq-read.py', ['--hwnd', HWND, '--limit', '20', '--wake'], { timeoutMs: 120000 });
    const rj = parseLastJson(String(rd || ''));
    const hit = (rj?.messages || []).some((m) => String(m.text || '').includes(text));
    check('刚才发的那条能读回来', hit, hit ? '' : '读不到（可能是渲染延迟）');
  }
}

// ── ④ 群历史接口（补看要用） ──
if (want('history')) {
  console.log('\n── ④ get_group_msg_history 有没有真数据');
  // 直接问适配器（它内部调 qq-read.py）
  const res = await new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:6700');
    const timer = setTimeout(() => resolve({ timeout: true }), 120000);
    ws.onopen = () =>
      ws.send(JSON.stringify({ action: 'get_group_msg_history', params: { group_id: 200000007, count: 30 }, echo: '1' }));
    ws.onmessage = (ev) => {
      let t = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      let j = null;
      try {
        j = JSON.parse(t);
      } catch {
        return;
      }
      // ⚠️ 适配器连上之后**先推一堆事件**（`meta_event` lifecycle / message …），
      //    那些不是本次请求的响应。原来这里收到第一个就 resolve ⇒ 拿到的永远是
      //    `lifecycle connect`，于是"历史里有消息"这条**必然失败** ✗
      //    只有带 `echo` 的才是 API 响应。
      if (!j || j.echo === undefined) return;
      clearTimeout(timer);
      resolve(j);
      ws.close();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ error: 'connect' });
    };
  });
  const list = res?.data?.messages;
  check('适配器在 6700 上应答', !res?.timeout && !res?.error, res?.error || '');
  check('历史里有消息（不是永远空数组）', Array.isArray(list) && list.length > 0, `messages=${list?.length ?? 0}`);
  if (Array.isArray(list) && list.length) {
    const one = list[list.length - 1];
    check('历史条目有 message_id', !!one.message_id, String(one.message_id));
    check('历史条目有 time', !!one.time, String(one.time));
  }
}

// ── ⑤ 戳一戳（发） ──
if (want('poke')) {
  console.log('\n── ⑤ 戳一戳（发出去）');
  const out = await runPy(
    'qq-poke.py',
    ['--hwnd', HWND, '--to', 'Anon'],
    { timeoutMs: 180000 },
  );
  const j = parseLastJson(String(out || ''));
  check('qq-poke.py 返回 ok', !!j?.ok, j?.error || '');
  check('菜单里点到了「戳一戳」', Array.isArray(j?.tries) && j.tries.length > 0, JSON.stringify(j?.tries || []));
}

// ── 回归用例：纯逻辑（不碰 QQ 界面，几毫秒跑完） ──
if (want('pure')) {
  console.log('\n── ⑦ 回归用例（纯逻辑）');
  const pure = await import('./lib/qq-pure.mjs');

  // ① 群名漂移：群名里带成员昵称，昵称和顺序都会变
  check(
    '群名漂移：昵称/顺序变了仍认得出是同一个群',
    pure.tokenMatch('Anon、谷雨、Saki', "谷雨、Stby'Crs、Anon、Saki") === true,
    'Anon、谷雨、Saki ↔ 谷雨、Stby\'Crs、Anon、Saki',
  );
  check(
    '群名漂移：不相干的群不能误判成同一个',
    pure.tokenMatch('示例服务器 2026', '[示例服务器外群] 示例群') === false,
    '',
  );
  check('群名漂移：单串名（没有分隔符）不会误判', pure.tokenMatch('湖工电影协会ACG同好群', '示例服务器 2026') === false, '');

  // ② 重复文本 / 消息 id 稳定性
  const idA = pure.msgIdOf('200000007', { who: '<主人>', text: '@Saki' });
  const idB = pure.msgIdOf('200000007', { who: '<主人>', text: '@Saki' });
  check('同一条消息的 id 稳定（滚动出去再滚回来不会重推）', idA === idB, String(idA));
  check(
    '不同内容 → 不同 id（不会被误当同一条）',
    idA !== pure.msgIdOf('1127867862', { who: '<主人>', text: '@Saki 2' }),
    '',
  );
  check(
    '回滚位置变化（y 变负）不影响 id —— 判新旧不靠 y',
    pure.msgIdOf('200000007', { who: '<主人>', text: '@Saki', y: -900 }) === idA,
    '',
  );
  // ⚠️ 这是**已知限制**，不是 bug：客户端拿不到真 message_id，
  //    一字不差的两条只能共用同一个 id ⇒ 第二条会被吞。补看那条路能捞回来。
  check(
    '已知限制：一字不差的两条共用同一个 id（会被吞一条）',
    pure.msgIdOf('200000007', { who: '<主人>', text: '@Saki' }) === idA,
    '这是限制，不是回归',
  );

  // ③ 伪号：原来一律填 0，群里所有人被当成同一个人
  const uH = pure.pseudoUid('<主人>');
  const uA = pure.pseudoUid('Anon');
  check('不同昵称 → 不同伪号（能区分人）', uH !== uA, `${uH} vs ${uA}`);
  check('同一昵称永远同一个伪号', pure.pseudoUid('<主人>') === uH, String(uH));
  check('伪号是 9 位、看起来像 QQ 号', String(uH).length === 9, String(uH));
  check('空昵称给 0（不造出假人）', pure.pseudoUid('') === 0, '');

  // ④ 戳一戳判重 key
  const k1 = pure.tipKey({ who: '<主人>', action: '捏了捏', target: '你', suffix: '的脸' });
  const k2 = pure.tipKey({ who: '<主人>', action: '捏了捏', target: '你', suffix: '的脸' });
  check('同一个戳 → 同一个 key（能判重）', k1 === k2, k1);
  check(
    '不同的戳（换动作）→ 不同 key',
    k1 !== pure.tipKey({ who: '<主人>', action: '拍了拍', target: '你', suffix: '' }),
    '',
  );
}

// ── 运行态健康：锚点 / 当前会话 / 轮询心跳 ──
if (want('health')) {
  console.log('\n── ⑧ 运行态健康（这几个坑都真实踩过）');
  const { readFileSync } = await import('node:fs');

  // ① 锚点文件
  let anchorName = '';
  try {
    anchorName = String(JSON.parse(readFileSync(join(ROOT, 'state', 'qq-anchor.json'), 'utf8'))?.name || '').trim();
  } catch {}
  check('锚点文件存在且非空（重启后不会被"屏幕上是谁"带偏）', !!anchorName, anchorName || '没有 state/qq-anchor.json');

  // ② watch 列表（多窗口模式只在填了的时候启用；QQ 只允许一个独立窗口，默认应为空）
  let watchN = -1;
  try {
    const j = JSON.parse(readFileSync(join(ROOT, 'state', 'qq-watch.json'), 'utf8'));
    const arr = Array.isArray(j) ? j : j?.sessions;
    watchN = Array.isArray(arr) ? arr.length : 0;
  } catch {}
  check('watch 列表是空（走主窗口+摘要扫描；QQ 只允许一个独立窗口）', watchN === 0, `sessions=${watchN}`);

  // ③ 适配器日志：最近有没有轮询心跳 / 有没有"会话是空的"
  let tail = '';
  try {
    const buf = readFileSync(join(ROOT, 'logs', 'qq-onebot.log'));
    tail = buf.slice(Math.max(0, buf.length - 20000)).toString('utf8');
  } catch {}
  check('适配器日志能读到', !!tail, tail ? '' : '没有 logs/qq-onebot.log');
  const gotAnchorLog = /⚓ 轮询锚点会话/.test(tail);
  check('最近日志里出现过锚点行（适配器启动过）', gotAnchorLog, '');
  const emptySession = /当前会话「」/.test(tail.split('\n').slice(-80).join('\n'));
  check('最近 80 行里没有「当前会话「」」（空会话会自动切回锚点）', !emptySession, emptySession ? '出现空会话了' : '');
  const polling = /🔄 轮询在读|📥 收到|👀 屏幕消息/.test(tail);
  check('最近日志里有轮询痕迹（轮询没被饿死）', polling, '');
}

// ── 收消息：真盯日志（要真人发一条） ──
if (want('recv')) {
  console.log('\n── ⑥ 收消息（真盯日志 120 秒）');
  // ⚠️ 自动发：**走爱音自己的 bot 连接**（她的 webui 接口）。
  //    这样发出来的消息是真到得了的 —— 实测 5 秒内适配器就看到了。
  //    （从"第二条 WS 连接"发是不行的，那条路由不通，别再用它当测试源。）
  const ANON_WEBUI = pick('anon-webui', 'http://127.0.0.1:3100');
  const RECV_GID = pick('recv-group', '200000007');
  const RECV_TARGET = pick('recv-target', '10000002'); // @Saki 自己
  // ⚠️⚠️ 内容**完全相同**的连发会被 QQ 去重（实测：20:03、20:05 两条到了，
  //    20:10 再发一模一样的，界面里根本没有那条消息 ⇒ 自测里会误报"没收到"）。
  //    `test-notice` 的正文是固定的，能变的只有 @ 的那个人 ⇒ 轮流 @ 两个目标，
  //    让每条消息的 @ 段不同。
  let sent = null;
  for (const who of [RECV_TARGET, '10000001']) {
    try {
      const r = await fetch(`${ANON_WEBUI}/api/friend/test-notice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: who, groupId: RECV_GID }),
      });
      const j = await r.json();
      if (j?.ok) {
        sent = j;
        break;
      }
      sent = j;
    } catch (e) {
      sent = { ok: false, error: String(e.message || e) };
    }
  }
  check('让爱音把测试消息发出去（走她自己的 WS 连接）', !!sent?.ok, sent?.error || '');
  console.log('   已发出，盯日志 45 秒等适配器推上来…\n');
  const { spawn } = await import('node:child_process');
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'tools', 'watch-inbox.mjs'), '--sec', '45', '--grep', 'Anon'], {
      stdio: 'inherit',
    });
    child.on('exit', (c) => resolve(c));
  });
  check(
    '收到新消息（📥 收到 / 👉 被「」）',
    code === 0,
    code === 0 ? '' : '45 秒内没等到（若连跑两次，可能是 QQ 把相同内容去重了，隔几分钟再试）',
  );
}

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
await cleanup();
process.exit(fail === 0 ? 0 : 1);
