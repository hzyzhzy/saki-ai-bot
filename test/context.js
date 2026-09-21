/**
 * 群聊上下文缓存测试（离线，不连 NapCat、不调模型）。
 *
 * ⚠️ 为什么要有它（2026-09-13 用户截图）：
 *    群里先说「心上江渡轮站那个入口太像**足球门**了」，
 *    隔了几分钟 <主人> 问「准备改成什么球门」，
 *    机器人答「……**什么球门，你要改哪个**」——**它没看到前面那条**。
 *
 *    根因：`recent.js` 的 `remember()` 存的时候就**按时间裁**
 *    （`context.maxAgeMs` 默认 30 分钟），那条被物理删掉了，后面怎么取都取不到。
 *    用户要求：「看上文不仅要看最近时间的消息，
 *    **只要是多少条范围内都得看进来**」。
 *
 *    而这块**以前完全没有测试** —— 所以这个 bug 一直没人挡。
 *
 * 用法: node test/context.js
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// ⚠️ **不要在这里硬写 `process.env.QQBOT_CONFIG`** ——
//    我第一版写死成 'config.yml'，结果外部想用一份临时配置来对照验证
//    （`QQBOT_CONFIG=config.ctx-old.yml node test/context.js`）**永远不会生效**，
//    于是"旧行为下测试也该红"这件事我验了三轮都是假绿。
//    要让调用方能覆盖：没设才给默认值。
process.env.QQBOT_CONFIG ??= 'config.yml';
// ⚠️⚠️ 2026-09-17 加：`recent.js` 现在会**落盘**（"重启不丢上下文"），
//    所以这个套件**必须**指向独立文件 —— 它用的是真实 `config.yml`（故意的，见上），
//    文件名里没有 test，靠配置名自动隔离**挡不住它**。
//    第一版就是这么污染的：那条"重启恢复"测试直接往真实 `state/recent.json`
//    里塞了一句「我吃四份牛肉丼」（群号还是真实群），机器人下次重启就把它读进上下文了。
//    同样留着让调用方覆盖的口子（`??=`）。
process.env.QQBOT_RECENT_FILE ??= 'logs/__test-context-recent.json';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const recent = await import('../src/recent.js');
const { config } = await import('../src/config.js');

const G = '200000001';
const OTHER = '200000005';
const say = (groupId, name, uid, text, atMe = false) =>
  recent.remember(
    { message_type: 'group', group_id: groupId, user_id: uid, sender: { card: name } },
    { text, isAtMe: atMe },
  );

recent.clearAll();

console.log('\n【1】★ 时间久一点的消息也要看得到（用户截图那个 bug）');
{
  recent.clearAll();
  say(G, 'luomoSan', '10000003', '心上江渡轮站的那个入口太像足球门了');
  say(G, 'luomoSan', '10000003', '（发了一张图）');

  // ⚠️ 把这两条的**时间改成 2 小时前** —— 就是想验"时间不该当窗口"。
  //    直接在 store 里改：没有别的办法模拟 2 小时（总不能真等）。
  //
  //    ⚠️ 为什么是 2 小时而不是 25 分钟：老的时限是 **30 分钟**，
  //    25 分钟**本来就不会被裁** —— 我第一版就是 25 分钟，
  //    结果旧实现下测试也是绿的（等于没测）。必须超过那个时限才算数。
  const OFFSET = 2 * 60 * 60 * 1000;
  const list = recent.__storeForTest().get(G) ?? [];
  for (const m of list) m.time = Date.now() - OFFSET;
  check(list.length === 2, '注入成功（两条消息的时间改成 2 小时前）', `实际 ${list.length} 条`);

  // ⚠️⚠️ **必须再发一条新的** —— `remember()` 是在"记新消息时"才裁剪缓冲区的。
  //    只改时间戳不触发裁剪的话，旧实现也不会删它们（测试同样白写）。
  say(G, '路人', '30009', '（后来有人说了句别的）');

  const txt = recent.contextText(G);
  check(txt.includes('足球门'), '2 小时前说的「足球门」**还在**上下文里（旧实现会被时间裁掉）');
  // ⚠️ 把实际状态也打出来 —— 这一条我调试时被"测试假绿"坑过两次
  //    （一次是偏移只有 25 分钟 < 30 分钟时限、一次是忘了触发裁剪），
  //    带上现场信息，下次一眼就能看出是哪一半错了。
  console.log(
    `     现场：缓冲区时限 ${Math.round((Number(config.context?.bufferMaxAgeMs) || 0) / 3600000)} 小时，` +
      `注入偏移 2 小时，缓冲区里现有 ${(recent.__storeForTest().get(G) ?? []).length} 条`,
  );

  say(G, '<主人>', '10000001', '准备改成什么球门');
  const txt2 = recent.contextText(G, '准备改成什么球门', []);
  check(txt2.includes('足球门'), '问「改成什么球门」时，前面那条**仍然在**');
  check(!txt2.includes('准备改成什么球门'), '当前这句不会重复出现在上下文里');
}

console.log('\n【2】窗口是**按条数**的（maxMessages）');
{
  recent.clearAll();
  const N = Number(config.context?.maxMessages ?? 30);
  for (let i = 1; i <= N + 20; i += 1) say(G, '甲', '30001', `第 ${i} 条`);

  const txt = recent.contextText(G);
  const got = (txt.match(/第 \d+ 条/g) ?? []).length;
  check(got <= N, `给模型的最多 ${N} 条（实际 ${got} 条）`);
  check(txt.includes(`第 ${N + 20} 条`), '最后一条一定在');
  check(!txt.includes('第 1 条'), '最早那些溢出窗口的被丢掉（不然 prompt 会被撑爆）');
  // 窗口内的必须都在，不能少给
  check(txt.includes(`第 ${N + 20 - N + 1} 条`), `窗口边界那条也在（第 ${N + 20 - N + 1} 条）`);
}

console.log('\n【3】自己发的要标出来，且自称是 Saki');
{
  recent.clearAll();
  say(G, '<主人>', '10000001', '你工资多少');
  recent.rememberBot(
    { message_type: 'group', group_id: G, user_id: '10000002', sender: { nickname: 'saki' } },
    '1850，就这点。',
  );
  const txt = recent.contextText(G);
  check(txt.includes('【你自己说的】'), '自己说的那句被标成【你自己说的】');
  check(/Saki/.test(txt), '自己在上下文里的名字用 Saki（不是「小祥/祥子」）', txt.split('\n')[1] ?? '');
  check(!/你（小祥）|你（祥子）/.test(txt), '没用「小祥」「祥子」当自称');
}

console.log('\n【4】不同群互不串台');
{
  recent.clearAll();
  say(G, '甲', '30001', '这是客服群的消息');
  say(OTHER, '乙', '30002', '这是另一个群的消息');
  const a = recent.contextText(G);
  const b = recent.contextText(OTHER);
  check(a.includes('客服群') && !a.includes('另一个群'), '群里只看到本群的消息');
  check(b.includes('另一个群') && !b.includes('客服群'), '另一个群同理');
}

console.log('\n【5】当前这条不重复出现（message_id 优先）');
{
  recent.clearAll();
  recent.remember(
    { message_type: 'group', group_id: G, user_id: '30001', sender: { card: '甲' }, message_id: 555 },
    { text: '在线几个人' },
  );
  const txt = recent.contextText(G, '在线几个人', ['555']);
  check(!txt.includes('在线几个人'), '按 message_id 排掉了当前这条');
}

console.log('\n【6】清空');
{
  say(G, '甲', '30001', '清空前');
  recent.clear(G);
  check(recent.contextText(G) === '', 'clear(群) 之后上下文为空');
  recent.clearAll();
  check(recent.contextText(G) === '' && recent.contextText(OTHER) === '', 'clearAll 之后所有群都空');
}

console.log('\n【7】★ 落盘：重启不丢上下文（2026-09-17 用户要求）');
{
  // 用户原话：「**重启能不能保留上下文**」。
  // 他遇到的场景：群里先聊过「@某某 能介绍一下嘛」，重启之后再问，她答"不知道" ——
  // 因为那条记录**连同被介绍人的名字**一起没了（机器人一天要重启好几次）。
  const fs = await import('node:fs');
  const p = recent.path();
  check(!/[\\/]state[\\/]recent\.json$/.test(p), `用的不是真实 state/recent.json（${p.split(/[\\/]/).pop()}）`);
  check(typeof recent.reload === 'function', '导出了 reload()');

  // 造一条，等节流写盘（3 秒）
  say(G, '甲', '30001', '我吃四份牛肉丼');
  await new Promise((r) => setTimeout(r, 3600));
  check(fs.existsSync(p), '★ 3 秒内落盘了（节流写，不是每条都写）');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  check(!!j.groups?.[G]?.length, '★ 文件里有那个群');
  check(j.groups[G].some((x) => String(x.text).includes('牛肉丼')), '★ 内容也在');

  // 清空内存再 reload —— 模拟一次重启
  recent.clear(G);
  check(!/牛肉丼/.test(recent.contextText(G)), '清空后内存里确实没有了');
  recent.reload();
  check(/牛肉丼/.test(recent.contextText(G)), '★★ reload 之后又回来了（这就是"重启不丢"）');
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
