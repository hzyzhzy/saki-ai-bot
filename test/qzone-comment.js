/**
 * 空间评论回复（`src/qzone-comment.js`）—— 2026-09-28 加。
 *
 * ## 这个套件盯什么
 *
 * 用户要求：「回复自己发的说说下面的评论」，规矩是
 * **只回最近 3 天 / 每条评论只回一次 / 每天最多 5 条**。
 *
 * ⚠️ 这条路**自己拼 HTTP 调空间接口**（协议端没有这个能力），所以最怕两件事：
 *    ① **发错地方/发重复** —— 参数写错就会发到别的说说、或者同一条评论被回很多遍；
 *    ② **不该调模型的时候调了** —— 白花钱，还可能生成出奇怪的话发到空间里。
 *
 * 所以这里**把 `fetch` 全拦掉**（绝不真的碰空间接口），并且**故意让 deepseek 的请求报错** ——
 * 那样"本不该生成回复的场景却去调了模型"会**立刻显红**，而不是悄悄花钱。
 *
 * ⚠️ 会真的"发出去"的那条路（生成回复 + POST）已经手工端到端验证过，
 *    这里不重复（那个必须花钱，不适合放进回归）。
 *
 * ## 用法
 *   node test/qzone-comment.js
 */
// ⚠️ 隔离状态文件必须在 import 业务模块**之前**设好（模块加载时就定路径）
process.env.QQBOT_QZONE_COMMENT_FILE = 'logs/__test-qzone-comment.json';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const qc = await import('../src/qzone-comment.js');
const { config } = await import('../src/config.js');
const { rmSync } = await import('node:fs');
const { join } = await import('node:path');
const { ROOT } = await import('../src/config.js');

// ── 把网络全拦掉 ────────────────────────────────────────
const seen = [];
const origFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  // ⚠️ 本套件**不该**去调模型：真调了就报错，让它显红
  if (!u.includes('qzone.qq.com')) {
    throw new Error(`本套件不该请求这个地址：${u.slice(0, 60)}`);
  }
  const kind = u.includes('msglist') ? 'msglist' : u.includes('re_feeds') ? 're_feeds' : u.slice(0, 60);
  seen.push({ kind, method: opts?.method ?? 'GET', body: String(opts?.body ?? '') });
  if (kind === 'msglist') {
    return { status: 200, text: async () => mockMsgList() };
  }
  return { status: 200, text: async () => '_Callback({"code":0,"subcode":0})' };
};

const now = Math.floor(Date.now() / 1000);
/** 每个 case 前改这个，决定"服务端"返回什么 */
let mockMsgList = () => '_Callback({"code":0,"msglist":[]})';
const msgs = (list) => () =>
  '_Callback(' + JSON.stringify({ code: 0, msglist: list }) + ')';

const call = async (a) =>
  a === 'get_cookies' ? { data: { cookies: 'p_skey=deadbeef; uin=o10000002' } } : {};

console.log('[1] jsonp 剥壳');
check(qc.unwrapJsonp('{"code":0}')?.code === 0, '纯 JSON 能解析');
check(qc.unwrapJsonp('_Callback({"code":0})')?.code === 0, 'jsonp 能剥壳');
check(qc.unwrapJsonp('_Callback({"code":0});')?.code === 0, 'jsonp 带分号也能剥');
check(qc.unwrapJsonp('这不是 JSON') === null, '垃圾返回 null（不抛）');

console.log('\n[2] 拉说说：解析出评论');
mockMsgList = () =>
  '_Callback(' +
  JSON.stringify({
    code: 0,
    msglist: [
      {
        tid: 'T1',
        content: '被夸了三遍可爱。烦不烦',
        created_time: now - 3600,
        cmtnum: 1,
        commentlist: [
          { uin: '10000004', name: '是bro的大豆', content: '那你还挺得意', create_time: now - 600 },
          { uin: '1', name: '空内容', content: '   ', create_time: now - 600 },
        ],
      },
    ],
  }) +
  ')';
{
  const list = await qc.fetchMsgList({ cookies: 'p_skey=x', uin: '10000002' });
  check(list.length === 1, '解析出 1 条说说');
  check(list[0].tid === 'T1', 'tid 取到了');
  check(list[0].at === (now - 3600) * 1000, '时间换算成毫秒');
  check(list[0].comments.length === 1, '空白评论被过滤掉（1 条有效）');
  check(list[0].comments[0].uin === '10000004', '评论者 uin 取到了');
  check(list[0].comments[0].content === '那你还挺得意', '评论内容取到了');
}

console.log('\n[3] 拉说说：出错要抛（不能静默当成"没评论"）');
mockMsgList = () => '_Callback({"code":-2,"subcode":-2,"message":"系统繁忙"})';
{
  let err = '';
  try {
    await qc.fetchMsgList({ cookies: 'p_skey=x', uin: '1' });
  } catch (e) {
    err = e.message;
  }
  check(/code=-2/.test(err), 'code!=0 抛错并带上码', err.slice(0, 40));
}

console.log('\n[4] 发评论：参数格式（写错就发到别处/发不出去）');
seen.length = 0;
try {
  await qc.postComment({
    cookies: 'p_skey=x',
    selfUin: '10000002',
    hostUin: '10000002',
    tid: 'T1',
    content: '得意什么',
  });
  check(true, 'postComment 走通了（假响应 code=0）');
} catch (e) {
  check(false, 'postComment 不该抛', e.message);
}
{
  const p = seen.find((s) => s.kind === 're_feeds');
  check(!!p, '确实发出了 re_feeds 请求');
  check(p?.method === 'POST', '用的是 POST');
  const body = new URLSearchParams(p?.body ?? '');
  // ⚠️⚠️ 这条最关键：topicId 必须是 `${hostUin}_${tid}__1`
  check(
    body.get('topicId') === '10000002_T1__1',
    'topicId 格式正确（hostUin_tid__1）',
    body.get('topicId') ?? '(空)',
  );
  check(body.get('content') === '得意什么', 'content 带上了');
  check(body.get('hostUin') === '10000002', 'hostUin 带上了');
  check(body.get('uin') === '10000002', 'uin 带上了');
}
{
  let err = '';
  try {
    await qc.postComment({ cookies: 'p_skey=x', selfUin: '1', hostUin: '1', tid: 'T', content: '  ' });
  } catch (e) {
    err = e.message;
  }
  check(/不能为空/.test(err), '空内容拒绝发送');
}

console.log('\n[5] checkOnce：各种"不该回"的场景（一律不该调模型）');
qc.__reset();
// 5.1 功能关掉
config.qzone = { ...(config.qzone ?? {}), comment: { enable: false } };
{
  const r = await qc.checkOnce({ call });
  check(r.skipped === '功能关了', '关掉后整轮不做', r.skipped);
}
config.qzone = { ...(config.qzone ?? {}), comment: { enable: true } };
// 5.2 没评论
qc.__reset();
mockMsgList = msgs([]);
check((await qc.checkOnce({ call })).skipped === '没有要回的', '没有说说 → 没有要回的');
// 5.3 只有自己的评论
qc.__reset();
mockMsgList = msgs([
  {
    tid: 'T1',
    content: 'x',
    created_time: now - 100,
    commentlist: [{ uin: '10000002', name: 'Saki', content: '自评', create_time: now - 50 }],
  },
]);
check((await qc.checkOnce({ call })).skipped === '没有要回的', '自己的评论不回');
// 5.4 只有机器人的评论
qc.__reset();
config.teach = { ...(config.teach ?? {}), bots: ['10000009'] };
mockMsgList = msgs([
  {
    tid: 'T1',
    content: 'x',
    created_time: now - 100,
    commentlist: [{ uin: '10000009', name: '别的机器人', content: '喵', create_time: now - 50 }],
  },
]);
check((await qc.checkOnce({ call })).skipped === '没有要回的', '已知机器人的评论不回');
// 5.4b ⚠️ 还有一份**按名字**的机器人名单（`state/ignore-bots.json` → `bot.ignoreBots`）——
//      它才是 `Alone゜独白ぴ（helps菜单）` 的**真实来源**（`config.teach.bots` 里没有它，
//      实测只有 Q群管家 和 小豆）。只查 config 的话，重启后她会去回那个机器人 ✗。
//      所以这条必须单独钉住：靠调用方传进来的 `isBot` 回调判断。
qc.__reset();
mockMsgList = msgs([
  {
    tid: 'T1',
    content: 'x',
    created_time: now - 100,
    commentlist: [
      { uin: '10000009', name: 'Alone゜独白ぴ（helps菜单）', content: '喵', create_time: now - 50 },
    ],
  },
]);
{
  const r = await qc.checkOnce({ call, isBot: (u, n) => n === 'Alone゜独白ぴ（helps菜单）' });
  check(r.skipped === '没有要回的', '按名字那份名单也生效（isBot 回调）', r.skipped);
}
// 5.4c isBot 回调抛异常时不能整轮卡死
qc.__reset();
{
  const r = await qc.checkOnce({
    call,
    isBot: () => {
      throw new Error('名单读不到');
    },
  });
  // ⚠️ 这条的 `isBot` 抛异常 ⇒ 那份名单没生效（当作"不是机器人"）⇒ 会走到"生成回复"，
  //    而本套件把模型请求也拦掉了 ⇒ 生成失败 ⇒ **降级成不回**（不崩、更不乱发）。
  check(r.replied === 0, 'isBot 抛异常不致命（当不成机器人，但生成失败就降级成不回）', `replied=${r.replied}`);
}
// 5.5 说说太旧（超过 3 天）
qc.__reset();
mockMsgList = msgs([
  {
    tid: 'T1',
    content: 'x',
    created_time: now - 5 * 24 * 3600,
    commentlist: [{ uin: '10000004', name: '大豆', content: 'hh', create_time: now - 5 * 24 * 3600 }],
  },
]);
check((await qc.checkOnce({ call })).skipped === '没有要回的', '超过 3 天的说说不回');
// 5.6 日上限
qc.__reset();
qc.__setTodayCount(5);
mockMsgList = msgs([
  {
    tid: 'T1',
    content: 'x',
    created_time: now - 100,
    commentlist: [{ uin: '10000004', name: '大豆', content: 'hh', create_time: now - 50 }],
  },
]);
{
  const r = await qc.checkOnce({ call });
  check(/上限/.test(r.skipped), '到日上限就不再回', r.skipped);
}
// 5.7 拿不到 cookie
qc.__reset();
{
  const r = await qc.checkOnce({ call: async () => ({ data: {} }) });
  check(/get_cookies/.test(r.skipped), '拿不到 cookie 就整轮不做', r.skipped);
}
// 5.8 没有 call
qc.__reset();
check((await qc.checkOnce({})).skipped === '没有 call', '没给 call 直接跳过');

console.log('\n[6] status');
{
  qc.__reset();
  const s = qc.status();
  check(s.days === 3, '默认只回 3 天', String(s.days));
  check(s.maxPerDay === 5, '默认每天 5 条', String(s.maxPerDay));
  check(s.todayCount === 0, '计数从 0 开始');
  check(typeof s.repliedTotal === 'number', '有已回总数');
}

// 收尾：恢复 fetch + 删掉隔离状态文件
global.fetch = origFetch;
try {
  rmSync(join(ROOT, 'logs', '__test-qzone-comment.json'), { force: true });
} catch {
  /* 删不掉就算了 */
}

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
