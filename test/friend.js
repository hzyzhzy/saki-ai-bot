/**
 * 好友系统（`src/friend.js` + `affinity.recentTop`）回归。
 *
 * ## 盯的是 <主人> 拍板的三条硬规矩
 *
 * 1. **到 90 才发**，而且**只发一次**（不是每次加分都发）
 * 2. **不是所有好友都会收到私聊** —— 每天掷一次骰子，中了才挑**一个**
 * 3. **只在白天发**（深夜绝不发）
 *
 * 外加一条"协议层的事实"：
 * ⚠️ NapCat **没有**"发起加好友申请"这个能力（查证过全部 action），
 *    所以到线时是**在群里 @ 他**、报验证消息，让他来加，机器人再自动通过。
 *    而且那条消息**故意是机器化的**、**不进聊天上文**（用户原话）。
 *
 * ⚠️ 纯离线：不调模型（`composeDm` 那段不测）、不连 NapCat、不改真实 state。
 *
 * 用法: node test/friend.js
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-friend.yml';
const AFF_REL = 'logs/__test-friend-aff.json';
const FR_REL = 'logs/__test-friend-state.json';
const STORY_REL = 'logs/__test-friend-story.json';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    'affinity:',
    '  enable: true',
    '  friendThreshold: 90',
    'friend:',
    '  enable: true',
    '  dailyChance: 0.35',
    '  dayFromHour: 9',
    '  dayToHour: 22',
    '  minGapMs: 72000000',
    'storyline:',
    '  enable: true',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_AFFINITY_FILE = AFF_REL;
process.env.QQBOT_FRIEND_FILE = FR_REL;
process.env.QQBOT_STORYLINE_FILE = STORY_REL;

const aff = await import('../src/affinity.js');
const friend = await import('../src/friend.js');
const { config } = await import('../src/config.js');

const reset = () => {
  aff.__clear();
  friend.__clear();
  for (const f of [AFF_REL, FR_REL, STORY_REL]) {
    try {
      rmSync(join(ROOT, f), { force: true });
    } catch {}
  }
};

/** 某个时刻（今天几点） */
const at = (h, m = 0, dayOffset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
/** 固定序列假随机 */
const seq = (v) => {
  let i = 0;
  return () => v[i++ % v.length];
};

// ─────────────────────────────────────────────────────────────
console.log('\n【1】★ 排行榜口径：**最近有变化的 10 个**，再按分数从高到低');
{
  reset();
  // 造 12 个人，变化时间从早到晚
  for (let i = 1; i <= 12; i++) {
    aff.adjust(`u${i}`, 1, { force: true });
    // 让分数错开（u1 最低、u12 最高）
    aff.adjust(`u${i}`, i - 1, { force: true });
  }
  const top = aff.top(10);
  check(top.length === 10, `只取 10 个（实际 ${top.length}）`);
  check(
    top.every((x, i) => i === 0 || top[i - 1].score >= x.score),
    '★ 按分数从高到低排好了',
    top.map((x) => x.score).join(','),
  );
  // ⚠️ 2026-09-18 口径改成**纯按分数**了（用户：「只按从高到低排序，排前 10 个」）：
  //    u1..u12 的分数是 0..11 → 取前 10 名 = u12(11) … u3(2)，
  //    分数最低的 u1(0)、u2(1) 被挤出去。
  const ids = top.map((x) => x.userId);
  check(!ids.includes('u1') && !ids.includes('u2'), '★★ 分数最低的两个被挤出去（榜是**高分榜**）');
  check(ids[0] === 'u12', '★★ 第一名就是分数最高的（不再看谁最近变过）');
  check(ids.includes('u12'), '分数最高的在里面');

  // ★ 2026-09-18 新加的「全部榜」：12 个人**一个都不落**（top 只取 10 个）
  const every = aff.all();
  check(every.length === 12, `★ all() 返回全部有变化的 12 个人（实际 ${every.length}）`);
  check(
    every[0].userId === 'u12' && every[every.length - 1].userId === 'u1',
    '★ 全部榜也是分数从高到低',
    `${every[0].userId}…${every[every.length - 1].userId}`,
  );

  // 全空时不炸
  aff.__clear();
  check(Array.isArray(aff.top(10)) && aff.top(10).length === 0, '没人时不炸，返回空数组');
  check(Array.isArray(aff.all()) && aff.all().length === 0, '★ 全部榜空的时候也是空数组');
}

console.log('\n【2】★★ 到线判定：只有**刚越过**才算，不是 >= 就一直算');
{
  reset();
  aff.adjust('a', 100, { force: true }); // 直接顶到 100
  check(aff.atOrAbove(90).some((x) => x.userId === 'a'), 'atOrAbove 能列出到线的人');

  aff.__clear();
  const r1 = aff.adjust('b', 3, { force: true }); // 50 → 53
  check(r1.crossed === false, '没到线 → crossed=false');

  // ⚠️ 注意上限是 100 —— `+89` 会被夹住（我第一版就是这么把测试算错的）
  aff.adjust('c', -50, { force: true }); // 50 → 0
  check(aff.get('c') === 0, '摆到 0');
  aff.adjust('c', 88, { force: true }); // 0 → 88
  check(aff.get('c') === 88, '摆到 88');
  const cross = aff.adjust('c', 3, { force: true }); // 88 → 91，越过 90
  check(cross.from === 88 && cross.to === 91, `88 → 91`, `${cross.from}→${cross.to}`);
  check(cross.crossed === true, '★★ 刚越过 90 → crossed=true');
  const again = aff.adjust('c', 3, { force: true });
  check(again.crossed === false, '★★ 已经在线上再加 → **crossed=false**（不会重复通知）');

  // ⚠️ 2026-09-20：好感度**上限改无限**了（用户要求「把好感度上限修改为无限」），
  //    所以这里不再"封顶在 100"了。
  //    ⚠️ 但这段的**本意没变**：越过 90 线之后再涨，都不该再算一次"越过"。
  for (let i = 0; i < 5; i++) aff.adjust('c', 3, { force: true });
  check(aff.get('c') === 109, `不封顶了（94 + 5×3 = 109，实际 ${aff.get('c')}）`);
  check(aff.adjust('c', 3, { force: true }).crossed === false, '★ 越过线之后再涨也不算"越过"');
}

console.log('\n【3】★★ 到线通知：模板是机器化的、只发一次');
{
  reset();
  const t = friend.noticeText('u1');
  check(/好感度到达90/.test(t), '★ 模板里有用户指定的那句话', t);
  check(/达到加好友的标准/.test(t), '还有"达到加好友的标准"');
  check(!/^@\{at\}/.test(t), '`{at}` 占位符被清掉了（@ 走独立消息段，不塞文本里）');

  check(friend.shouldNotice('u1') === true, '还没通知过');
  // ⚠️ 2026-09-15 晚：第二个参数变成**群号**了（好感度分群之后，通知也按群记）
  friend.markNoticed('u1', '200000001', Date.now());
  check(friend.shouldNotice('u1', '200000001') === false, '★★ 那个群通知过之后就不再发了');
  check(
    friend.shouldNotice('u1', '200000006') === true,
    '★★ **别的群还没通知过**（在 A 群通知过不代表 B 群也沉默 —— 余额提醒踩过同一个坑）',
  );
  check(friend.noticedList().length === 1, '记在名单里了');

  // 落盘
  const reloaded = await import(`../src/friend.js?n=${Date.now()}`);
  check(reloaded.shouldNotice('u1', '200000001') === false, '★ reload 之后仍然记得（落盘了）');
}

console.log('\n【4】★★ "不是所有好友都会发"：每天掷一次骰子，中了才挑一个');
{
  reset();
  // 造 5 个好友
  for (const u of ['f1', 'f2', 'f3', 'f4', 'f5']) friend.markFriend(u, Date.now());
  check(friend.status().friends === 5, '5 个好友');

  // 骰子没中 → 不发，而且**记下"今天挑过了"**
  const miss = friend.pickForToday(at(14), seq([0.99]));
  check(!miss.userId && /没中/.test(miss.skip), '★ 掷骰子没中 → 今天不发', miss.skip);
  check(friend.__state().lastPickDate !== '', '★★ 没中的日子**也要记"挑过了"**（否则每 10 分钟掷一次 = 迟早会中）');
  const second = friend.pickForToday(at(15), seq([0.01]));
  check(!second.userId && /已经挑过/.test(second.skip), '★ 同一天再问 → 直接说"今天已经挑过了"', second.skip);

  // 换一天 + 骰子中了 → 挑一个（而且只挑一个）
  const hit = friend.pickForToday(at(14, 0, 1), seq([0.01]));
  check(!!hit.userId, '★ 中了 → 挑出一个人', JSON.stringify(hit));
  check(['f1', 'f2', 'f3', 'f4', 'f5'].includes(hit.userId), '挑的是好友里的一个');
}

console.log('\n【5】★★ 只在白天发');
{
  reset();
  friend.markFriend('f1', Date.now());
  check(friend.inDayWindow(at(14)) === true, '14:00 在白天窗口里');
  check(friend.inDayWindow(at(3)) === false, '★ 03:00 不在（深夜绝不发）');
  check(friend.inDayWindow(at(23)) === false, '★ 23:00 不在');
  const night = friend.pickForToday(at(3), seq([0.01]));
  check(!night.userId && /白天/.test(night.skip), '★ 深夜要发 → 被拦住', night.skip);
}

console.log('\n【6】★ 距上次私聊太近 → 今天不发（别连着骚扰同一个人）');
{
  reset();
  friend.markFriend('f1', Date.now());
  friend.__set({ lastDmAt: at(14), lastPickDate: '' });
  const r = friend.pickForToday(at(20), seq([0.01]));
  check(!r.userId && /太近/.test(r.skip), '★ 6 小时内 → 不发', r.skip);
  // 隔够 20 小时 → 可以
  const r2 = friend.pickForToday(at(14, 0, 1), seq([0.01]));
  check(!!r2.userId, '★ 隔够了 → 可以发');
}

console.log('\n【7】★ 挑人偏好：好感度高的优先，同分则最久没联系的优先');
{
  reset();
  aff.adjust('low', 10, { force: true });
  aff.adjust('high', 40, { force: true });
  friend.markFriend('low', Date.now());
  friend.markFriend('high', Date.now());
  const r = friend.pickForToday(at(14), seq([0.01]));
  check(r.userId === 'high', '★ 挑了好感度高的那个', JSON.stringify(r));
}

console.log('\n【8】★★ 接线：三根线都接上了');
{
  const botSrc = (await import('node:fs')).readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const idx = (await import('node:fs')).readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  const html = (await import('node:fs')).readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');

  // ① `/好感度` 排行榜
  check(/tryAffinityBoard\(event, segs\)/.test(botSrc), '★ 群消息里挂了 `/好感度` 的处理');
  check(
      /payload\.message_type === 'group' &&\s*this\.tryAffinityBoard\(payload,/.test(botSrc),
      '★ 处理完就不走后面的流程（`/好感度` 不进聊天上文、也不分条）',
    );
  check(
    /好感度排行榜/.test(botSrc) && /sendToGroup\(event\.group_id/.test(botSrc),
    '★★ 排行榜走 `sendToGroup`（**不是** `sendChatLike` 的分条 —— 那会把每条都算成"她说过的话"）',
  );
  check(/boardSize/.test(botSrc) && /affinity\.top\(/.test(botSrc), '★ 榜用 `affinity.top`（按分数取前 N）');
  // ★ 2026-09-18 用户新加的两个东西：纯按分数排 + `/全部好感度`
  check(
    /全\s*部\s*好\s*感\s*度/.test(botSrc) && /affinity\.all\(/.test(botSrc),
    '★★ 有 `/全部好感度` 命令（`affinity.all()` —— 所有有变化过的人）',
  );
  check(
    /const chunks = \[\]/.test(botSrc) && /chunks\.length > 1/.test(botSrc),
    '★★ 全部榜人多时会**自己分条**（不然一条消息塞不下几十人）',
  );

  // ② 回应 → 好感度
  check(/this\.noteInteraction\(event, segs, realText\);/.test(botSrc), '★ 回应她 → 加分 的钩子挂着');
  check(/_markSpoke\(/.test(botSrc), '★ 记"她刚说过话"（加分只在那个窗口内）');
  check(/sendFriendNotice\(event\.group_id, event\.user_id\)/.test(botSrc), '★ 越过阈值就去发通知');

  // ③ 好友申请自动通过
  check(/notice_type === 'friend_add'/.test(botSrc), '★ 挂了 `friend_add` 的处理');
  check(/set_friend_add_request/.test(botSrc), '★ 用 `set_friend_add_request` 通过（并带上 flag）');

  // ④ 每日私聊
  check(/friend\.pickForToday\(\)/.test(idx), '★ index.js 里有每日挑人的定时器');
  check(/send_private_msg/.test(idx), '★ 用私聊接口发');
  check(/friend\.markDm\(pick\.userId\)/.test(idx), '★ 发完记账（落盘）');

  // ⑤ 排行榜**不进聊天上文**
  //    ⚠️ 两个坑都要避开（第一版两个都踩了）：
  //       ① 切片要**从注释之前**开始 —— 那个方法的说明写在定义**上面**
  //       ② 断言前必须**剔掉注释行** —— 注释里就写着"不调 history.remember"，
  //          不剔的话断言会被自己的注释绊倒
  const at = botSrc.indexOf('tryAffinityBoard(event, segs) {');
  check(at >= 0, '找得到那个方法');
  const boardRaw = at >= 0 ? botSrc.slice(Math.max(0, at - 1400), at + 1600) : '';
  const boardCode = boardRaw
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  check(
    !/history\.remember|recent\.rememberBot/.test(boardCode),
    '★★ 排行榜那段（只看代码行）**没有**调 remember/rememberBot',
  );
  // ⚠️ 这条查的是**注释**（"写清了没有"是文档要求，不是行为断言）
  check(/机器格式|不分条/.test(boardRaw), '★ 注释里写清了"排行榜是机器格式的、不分条"');

  // ⑥ WebUI：参数都在界面上能改（用户要求"所有关键参数都要放到 webui"）
  const js2 = (await import('node:fs')).readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(/id="a-threshold"/.test(html), '★ 加好友门槛在界面上');
  check(/id="f-chance"/.test(html), '★ 每天私聊概率在界面上');
  check(/id="f-from"/.test(html) && /id="f-to"/.test(html), '★ 白天时段在界面上');
  check(/id="f-notice"/.test(html), '★ 通知模板在界面上能改');
  check(/id="f-enable"/.test(html), '★ 好友功能有开关');
  check(/\/api\/friend\/state/.test(js2), '★ 有给界面看的状态接口');
  check(/\/api\/friend\/test-notice/.test(js2), '★ 到线通知有手动测试接口（不然那条线要攒好几天才能验）');
  check(/\/api\/friend\/preview-dm/.test(js2) && /\/api\/friend\/send-dm/.test(js2), '★ 私聊有预览 + 真发两个接口');
  check(/affinity: \{ \.\.\.config\.affinity \}/.test(js2) && /friend: \{ \.\.\.config\.friend \}/.test(js2), '★ 两段配置都暴露给界面了');
  check(/测试\*\*不记账\*\*|测试不记账/.test(js2), '★ 测试通知不记账（不然测一次，真到 90 就不发了）');
}

console.log('\n【9】★★ 群友回应她 → 好感度 +1，而且**建议要写进故事线**（<主人> 举的那个例子）');
{
  reset();
  const sl = await import('../src/storyline.js');
  const { Bot } = await import('../src/bot.js');

  // 她刚发过一条一级事件（带 #外卖 标签 —— `life.commit` 写的就是这种）
  sl.note({ tier: 1, imp: 4, text: '拼好饭放在门口被人拿走了', tags: ['外卖', '吃饭'], groupId: '200000001' });

  const b = new Bot();
  b.selfId = '10000002';
  b._markSpoke('200000001', 'msg-1'); // 她刚说过话

  const mk = (t, uid = '10000003', nick = '某群友') => ({
    message_type: 'group',
    group_id: '200000001',
    user_id: uid,
    self_id: '10000002',
    sender: { nickname: nick, card: '' },
    message: [{ type: 'text', data: { text: t } }],
  });

  // ★ 用户原话里的例子：「群友告诉她下次外卖改个地址」
  const e1 = mk('你下次外卖改个地址吧');
  const G = '200000001'; // ⚠️ 好感度按群了（2026-09-15 晚），这些事件都在这个群
  const before = aff.get('10000003', G);
  b.noteInteraction(e1, e1.message, '你下次外卖改个地址吧');
  check(aff.get('10000003', G) === before + 1, '★ 回应的那一下 +1 好感度', `${before} → ${aff.get('10000003', G)}`);

  const sug = sl.recent(10, '200000001').find((e) => /改个地址/.test(e.text));
  check(!!sug, '★★ 建议**写进了故事线**');
  check(!!sug?.tags?.includes('外卖'), '★★★ 而且**带着 #外卖 标签** —— 下次抽到外卖事件时能按标签关联回来', JSON.stringify(sug?.tags));
  check(!!sug?.tags?.includes('建议'), '还带了 #建议 标签（好排查）');

  // ⚠️ 关键：不带 @、也不是回复，只是一句建议 —— 这条以前被挡在外面
  check(
    !e1.message.some((s) => s.type === 'at' || s.type === 'reply'),
    '（确认这条消息既没 @她、也不是回复她 —— 就是群里随口一句建议）',
  );

  // 纯看热闹 → 不加分、也不进故事线
  const e2 = mk('哈哈哈哈这也太惨了', '999', '路人');
  b.noteInteraction(e2, e2.message, '哈哈哈哈这也太惨了');
  check(aff.get('999', G) === 50, '★ 纯看热闹 → 不加好感度');
  check(!sl.recent(10, '200000001').some((e) => /哈哈哈哈/.test(e.text)), '★ 纯看热闹 → 不进故事线（别把故事线灌水）');

  // 她最近没说过话 → 不算"回应"
  const b2 = new Bot();
  b2.selfId = '10000002';
  const e3 = mk('你下次外卖改个地址吧', '888', '新来的');
  b2.noteInteraction(e3, e3.message, '你下次外卖改个地址吧');
  check(aff.get('888') === 50, '★★ 她最近没说过话 → **不算回应**（否则群里任何一句 @她都在加分，几天就刷满 90）');

  // @她 / 回她 也照样加
  reset();
  const b3 = new Bot();
  b3.selfId = '10000002';
  b3._markSpoke('200000001', 'msg-9');
  b3.noteInteraction(
    mk('在吗'),
    [{ type: 'at', data: { qq: '10000002' } }],
    '在吗',
  );
  check(aff.get('10000003', G) === 51, '★ @她 → 也 +1');
  b3.noteInteraction(mk('后来呢'), [{ type: 'reply', data: { id: 'msg-9' } }], '后来呢');
  check(aff.get('10000003', G) === 52, '★ 回她那条消息 → 也 +1');

  // 接线：真的挂了钩子
  const botSrc = (await import('node:fs')).readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/this\.noteInteraction\(event, segs, realText\);/.test(botSrc), '★ 钩子挂在群消息路径上');
  check(
    /mode: 'strict'/.test(botSrc.slice(botSrc.indexOf('noteInteraction(event, segs, text)'), botSrc.indexOf('noteInteraction(event, segs, text)') + 3000)),
    '★★ 用的是 `strict` 档（只认 @她/回她/建议；问句和闲聊不给分）',
  );
}

console.log('\n【10】★★ `/好感度` 命令真的能出榜（不只是"接线在"）');
{
  reset();
  const { Bot } = await import('../src/bot.js');
  for (let i = 1; i <= 12; i++) {
    // ⚠️ 好感度**按群**了（2026-09-15 晚）：下面那个 `/好感度` 是在群 200000001 里发的，
    //    所以数据也必须造在那个群里 —— 不然榜单（按群查）是空的（踩过这次）。
    aff.adjust(`u${i}`, 1, { force: true, groupId: '200000001' });
    aff.adjust(`u${i}`, i - 1, { force: true, groupId: '200000001' });
  }
  const b = new Bot();
  b.selfId = '10000002';
  const sent = [];
  b.call = async (action, params) => {
    sent.push({ action, text: params?.message?.[0]?.data?.text });
    return { message_id: 'm' + sent.length };
  };

  const ev = (text) => ({
    message_type: 'group',
    group_id: '200000001',
    user_id: 'u1',
    self_id: '10000002',
    sender: { nickname: 'A' },
    message: [{ type: 'text', data: { text } }],
  });

  // 半角和全角都要认
  check(b.tryAffinityBoard(ev('/好感度'), ev('/好感度').message) === true, '★ 半角 `/好感度` → 处理了');
  await new Promise((r) => setTimeout(r, 60));
  check(sent.length === 1, '★ 发出去了一条');
  const out = sent[0]?.text ?? '';
  check(/好感度排行榜/.test(out), '★ 是排行榜的内容', JSON.stringify(out.slice(0, 30)));
  check(out.includes('u12'), '榜里有最近变化的人');
  check(out.split('\n').length <= 12, `最多 10 个人 + 标题（实际 ${out.split('\n').length - 1} 个人）`);

  check(b.tryAffinityBoard(ev('／好感度'), ev('／好感度').message) === true, '★ 全角 `/好感度` 也认');

  // 不是这个命令 → 不管
  sent.length = 0;
  check(b.tryAffinityBoard(ev('/list'), ev('/list').message) === false, '★★ `/list`（别的机器人的指令）→ **不归它管**');
  check(b.tryAffinityBoard(ev('好感度'), ev('好感度').message) === false, '★ 不带斜杠的"好感度" → 不处理');
  check(sent.length === 0, '这两种都没发东西');
}

try {
  for (const f of [CFG_REL, AFF_REL, FR_REL, STORY_REL]) rmSync(join(ROOT, f), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
