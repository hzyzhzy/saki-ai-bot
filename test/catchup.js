/**
 * 「掉线补看」的测试（2026-09-15 用户要求）。
 *
 * ## 它解决什么
 *
 * OneBot 的事件**不会补发** —— 机器人不在线的那几秒/几分钟里，群里 @ 它的消息
 * 就直接没了。实测已经因为这件事丢过三次（NapCat 假在线 / 我改代码重启 / WS 抖动）。
 *
 * 用户原话：
 *   「**刚在几个@怎么没回**」→ 查出来是我重启弄丢的
 *   「**加吧，另外只用回 10 分钟内的**」
 *
 * ## 这个套件盯的三道闸（防重复、防刷屏）
 *
 * 1. **只补"必须回"的三类**：@ 她 / 关键词 / 服务器问题（闲聊不补）
 * 2. **只补 10 分钟内的**，而且**只补"我上线之前"的**（上线后的走实时那条路，
 *    所以天然不会跟实时处理重复）；再按 `message_id` 兜一道
 * 3. **一次最多 3 条**、每个进程只补一次
 *
 * ⚠️ 纯离线：假历史 + 把 `handle` 换成记录器（**不调模型、不发消息、不花钱**）
 *
 * 用法: node test/catchup.js
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️ 配置路径必须在 import `src/*` **之前**设好（`config.js` 是加载时读的）
const CFG_REL = 'logs/__test-catchup.yml';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'trigger:',
    '  groupChat: true',
    '  keywords:',
    '    - 整合包',
    '  allowGroups:',
    '    - "200000001"',
    '    - "200000002"',
    '  groupRespondTo:',
    '    "200000001": 1',
    'status:',
    '  enable: true',
    // ⚠️ `shouldQueryStatus` 还要求 host 非空（只 enable 不算），漏了这条测试会误判
    '  host: mc.example.com',
    '  keywords:',
    '    - 在线人数',
    '    - 服务器',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
// 状态文件隔离（别往真实 state/ 里写）
process.env.QQBOT_AFFINITY_FILE = 'logs/__test-catchup-affinity.json';
process.env.QQBOT_NAMES_FILE = 'logs/__test-catchup-names.json';
// ⚠️ 2026-10-17 加：`handled`（"这条我见过了"）也要隔离 ——
//    收消息自检拿它判"协议端推过、我见过没有"，套件里会写它 ⇒ 不隔离就污染真实 state ✗
process.env.QQBOT_HANDLED_FILE = 'logs/__test-catchup-handled.json';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { Bot } = await import('../src/bot.js');
const G1 = '200000001';
const G2 = '200000002';
const BOT = '10000002';
const <主人> = '10000001';
const NOW = Date.now();
const sec = (msAgo) => Math.floor((NOW - msAgo) / 1000); // OneBot 的 time 是**秒**

const txt = (t) => [{ type: 'text', data: { text: t } }];
const at = (t, qq = BOT) => [
  { type: 'at', data: { qq } },
  { type: 'text', data: { text: ` ${t}` } },
];

/** 造一个 bot：`call` 返回假历史（**按群过滤**），`handle` 换成记录器 */
function makeBot(history) {
  const b = new Bot();
  b.selfId = BOT;
  b.listenStartedAt = NOW; // "我刚上线"
  // ⚠️ 一定要**按群过滤** —— 假 `call` 如果每个群都返回同一份历史，
  //    同一条消息会被当成"两个群里各有一条"（我第一版就踩了）
  b.call = async (action, params) =>
    action === 'get_group_msg_history'
      ? history.filter((m) => String(m.group_id ?? G1) === String(params?.group_id))
      : [];
  b.handled = [];
  b.handle = async (ev, meta) => {
    b.handled.push({ text: ev.message?.map((s) => s.data?.text ?? '').join('').trim(), group: ev.group_id, lateMs: meta?.lateMs ?? 0 });
  };
  return b;
}

console.log('\n【1】★ 该补的：上线前 10 分钟内 @ 她的');
{
  const b = makeBot([
    { message_id: 1, time: sec(2 * 60 * 1000), user_id: <主人>, sender: { user_id: <主人> }, message: at('我可以蹭一下你吗') },
    { message_id: 2, time: sec(5 * 60 * 1000), user_id: <主人>, sender: { user_id: <主人> }, message: at('求互相包容') },
  ]);
  const n = await b.catchUpMissed();
  check(n === 2, `补回 2 条（实际 ${n}）`);
  check(b.handled.length === 2, '两条都交给了正常处理流程');
  check(b.handled[0].lateMs >= 60 * 1000, '★ 带上了"迟到"标记（提示词里会说清是几分钟前发的）', `lateMs=${Math.round(b.handled[0].lateMs / 1000)}s`);
  check(b.handled.every((h) => h.group === G1), '群号对');
}

console.log('\n【2】★★ 不该补的四种（这是防重复/防刷屏的关键）');
{
  const b = makeBot([
    // ① 上线**之后**的（实时那条路已经处理过 → 再补就是答两遍）
    { message_id: 11, time: sec(-5000), user_id: <主人>, sender: {}, message: at('上线之后的') },
    // ② 超过 10 分钟的（用户指定）
    { message_id: 12, time: sec(15 * 60 * 1000), user_id: <主人>, sender: {}, message: at('十五分钟前的') },
    // ③ 纯闲聊（没 @、没关键词、不是服务器问题）
    { message_id: 13, time: sec(3 * 60 * 1000), user_id: <主人>, sender: {}, message: txt('今天天气不错') },
    // ④ 她自己发的
    { message_id: 14, time: sec(3 * 60 * 1000), user_id: BOT, sender: {}, message: txt('@我自己说的') },
  ]);
  const n = await b.catchUpMissed();
  check(n === 0, `一条都不补（实际 ${n}）`, '');
  check(b.handled.length === 0, '  ↳ 没有把上面任何一条交给处理流程');
}

console.log('\n【3】关键词 / 服务器问题也要补（那两类同样"必须回"）');
{
  const b = makeBot([
    { message_id: 21, time: sec(60 * 1000), user_id: <主人>, sender: {}, message: txt('那个整合包在哪下') },
    { message_id: 22, time: sec(90 * 1000), user_id: <主人>, sender: {}, message: txt('服务器现在在线人数多少') },
  ]);
  const n = await b.catchUpMissed();
  check(n === 2, `关键词 + 服务器问题 → 都补（实际 ${n}）`);
}

console.log('\n【4】★ 去重：已经见过的 message_id 不再补');
{
  const b = makeBot([
    { message_id: 31, time: sec(60 * 1000), user_id: <主人>, sender: {}, message: at('同一条') },
  ]);
  const recent = await import('../src/recent.js');
  recent.clear(G1);
  recent.remember({ message_type: 'group', group_id: G1, user_id: <主人>, message_id: 31, message: at('同一条') }, { text: '同一条' });
  const n = await b.catchUpMissed();
  check(n === 0, `recent 里已经有 31 号 → 不补（实际 ${n}）`);
}

console.log('\n【5】一次最多补 3 条、且一个进程只补一次');
{
  const many = Array.from({ length: 6 }, (_, i) => ({
    message_id: 100 + i,
    time: sec((i + 1) * 30 * 1000),
    user_id: <主人>,
    sender: {},
    message: at(`第 ${i + 1} 条`),
  }));
  const b = makeBot(many);
  const n = await b.catchUpMissed();
  check(n === 3, `★ 6 条里只补 3 条（实际 ${n}）—— 免得一开机往群里刷一串迟到的回复`);
  const again = await b.catchUpMissed();
  check(again === 0, '★ 同一个进程再调一次 → 不重复补');
}

console.log('\n【6】多个群都补（每个群各拉一次历史）');
{
  const b = makeBot([
    { message_id: 41, time: sec(60 * 1000), user_id: <主人>, sender: {}, group_id: G1, message: at('群里问的') },
    { message_id: 42, time: sec(70 * 1000), user_id: <主人>, sender: {}, group_id: G2, message: at('另一个群问的') },
  ]);
  const n = await b.catchUpMissed();
  check(n >= 1, `至少补回 1 条（实际 ${n}）`);
}

console.log('\n【7】协议端不支持这个接口 → 不能崩');
{
  const b = new Bot();
  b.selfId = BOT;
  b.listenStartedAt = NOW;
  b.call = async () => {
    throw new Error('不支持的接口');
  };
  let threw = false;
  let n = -1;
  try {
    n = await b.catchUpMissed();
  } catch {
    threw = true;
  }
  check(!threw && n === 0, '拉历史失败 → 安静跳过，不抛错（不影响收消息）');
}

console.log(
  '\n【8】★★★ 收消息自检：挑出"协议端推过、我压根没见过"的必须回消息（2026-10-17 用户报的爱音）',
);
{
  // 用户原话：「**看752群爱音又没回消息**」——
  //   真因：那条连接**能发心跳、收不到群事件**（协议端日志里 @ 它的消息只推给了别的号），
  //   而心跳只证明"我发的请求它有回应" ⇒ **照不出来** ✗
  //   ⇒ 加这道自检：拉群历史，里面有"必须回"的消息、而 `handled` 里压根没有
  //     （正常收到的消息**一定**会被记进去）⇒ 判"漏推" ⇒ 强制重连 + 补看 ✓
  const b = new Bot();
  b.selfId = BOT;
  const sec2 = (msAgo) => Math.floor((NOW - msAgo) / 1000);
  const hist = [
    { message_id: 9001, time: sec2(60 * 1000), user_id: <主人>, sender: {}, message: at('这条我压根没见过') },
    { message_id: 9002, time: sec2(2 * 60 * 1000), user_id: <主人>, sender: {}, message: txt('今天天气不错') },
    { message_id: 9003, time: sec2(3 * 60 * 1000), user_id: BOT, sender: {}, message: at('我自己发的') },
    { message_id: 9004, time: sec2(30 * 60 * 1000), user_id: <主人>, sender: {}, message: at('半小时前的') },
    { message_id: 9005, time: sec2(90 * 1000), user_id: <主人>, sender: {}, message: txt('那个整合包在哪下') },
    { message_id: 9006, time: sec2(80 * 1000), user_id: <主人>, sender: {}, message: txt('服务器现在在线人数多少') },
  ];
  const got = b.missedRequiredIds(hist, { now: NOW });
  check(got.includes('9001'), '★★★ @ 她的、我没见过的 ⇒ 判成"漏推" ✓', got.join('、') || '（一个都没挑出来）');
  check(got.includes('9005') && got.includes('9006'), '★★ 关键词 / 服务器问题也算（跟补看同一套口径 ✓）');
  check(
    !got.includes('9002') && !got.includes('9003') && !got.includes('9004'),
    '★★ 闲聊 / 自己发的 / 超窗口的都不算 ✓',
  );
  // ⚠️ 见过的（handled 里有）⇒ 说明这条路通着 ⇒ 不能判漏（不然会反复重连 ✗）
  const handledMod = await import('../src/handled.js');
  handledMod.note('9001');
  check(!b.missedRequiredIds(hist, { now: NOW }).includes('9001'), '★★★ 已经见过的 ⇒ 不判漏（路是通的 ✓）');
  check(b.missedRequiredIds([], { now: NOW }).length === 0, '★★ 空历史 ⇒ 不判漏（半夜没人说话也不误伤 ✓）');
  check(b.missedRequiredIds(null, { now: NOW }).length === 0, '★ 坏值 ⇒ 不炸 ✓');

  // 接线：index.js 里那两道定时器 + 强制重连 + 让补看能再跑
  const idx = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  check(/startRecvCheck\(\)/.test(idx) && /stopRecvCheck\(\)/.test(idx), '★★ 自检定时器连上时挂、断开时清 ✓');
  check(
    /bot\.missedRequiredIds\(list/.test(idx) && /ws\.terminate\(\)/.test(idx),
    '★★★ 判定半死后**强制重连**（用 terminate —— 半开时 close 等不到对面 ✓）',
  );
  check(/bot\.catchUpDone = false/.test(idx), '★★ 顺手清掉"只补一次"的标记 ⇒ 重连后补看能把它们捞回来 ✓');
}

try {
  rmSync(join(ROOT, CFG_REL), { force: true });
  rmSync(join(ROOT, 'logs/__test-catchup-affinity.json'), { force: true });
  rmSync(join(ROOT, 'logs/__test-catchup-names.json'), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
