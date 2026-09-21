/**
 * **定时提醒**回归（2026-09-18 用户要求的功能）。
 *
 * 对着用户那四条要求逐条验：
 *   ① 先答应     —— 靠 `bot.js` 注入 `event._remind` 那段（本套件不测文案，测"记下来了"）；
 *   ② 到点 @ 他 + 用她的话 —— `sendReminder()` 的消息段（本套件**验段结构**）；
 *   ③ 另一个人找到了就一起 @ / **找不到不 @**；
 *   ④ 只在原地 —— 群里定的发群、私聊定的发私聊；
 *   ⑤ 另外还验一条用户没提但更要紧的：**重启不能忘**（落盘）。
 *
 * ⚠️ **全离线**：不连真 NapCat、不调真模型 ——
 *    靠 `remind.rewrite: false` 走模板兜底那条路（顺带把"模型挂了也得按时发出去"验了）。
 *
 * 用法: node test/remind.js
 */
process.env.QQBOT_REMIND_FILE ||= 'logs/__test-remind.json';
process.env.QQBOT_NAMES_FILE ||= 'logs/__test-remind-names.json';

const { config } = await import('../src/config.js');
const remind = await import('../src/remind.js');
const names = await import('../src/names.js');
const { Bot } = await import('../src/bot.js');

// 关掉模型改写（离线跑；同时证明"模型不可用也照样发得出去"）
config.remind = { ...(config.remind ?? {}), rewrite: false, enable: true };

remind.__clear();
names.__clear();

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}`);
  }
};

// 一个"假机器人"：只借 `Bot.prototype` 上那几个纯方法（拆段、打码、口癖），
// 网络那一层用假的 `call` 接住 —— 所以不需要 NapCat。
const sent = [];
const fake = Object.create(Bot.prototype);
fake.call = async (action, params) => {
  sent.push({ action, params });
  return { message_id: `m${sent.length}` };
};
fake._markSpoke = () => {};

const MIN = 60 * 1000;

// ── ① 记录：正常一条 ───────────────────────────────────────────────
console.log('\n【记录・落盘】');
{
  const at = Date.now() + 30 * MIN;
  const r = remind.add({
    at,
    what: '交作业',
    by: '30003',
    byName: '<主人>',
    targets: [{ uid: '30004', name: '喵喵三三' }],
    groupId: '20002',
  });
  ok(r.ok, '「明天八点提醒我交作业」记下来了');
  ok(remind.pending().length === 1, '待发列表里有 1 条');
  ok(remind.due().length === 0, '还没到点 → 不该发');
  ok(String(remind.path()).includes('logs'), `状态落在隔离路径里：${remind.path()}`);
}

// ── ② 各种"不该记"的 ──────────────────────────────────────────────
console.log('\n【拦掉不该记的】');
{
  ok(remind.add({ at: Date.now() - MIN, what: '过去的事', by: '1' }).ok === false, '过去的时间 → 拒绝');
  ok(remind.add({ at: Date.now() + MIN, what: '', by: '1' }).ok === false, '没事可提醒 → 拒绝');
  ok(
    remind.add({ at: Date.now() + 30 * 24 * 3600 * 1000, what: '一个月后', by: '1' }).ok === false,
    '太远（>7 天）→ 拒绝',
  );
}

// ── ③ 重启不能忘：重新载入后还在 ──────────────────────────────────
console.log('\n【重启不丢】');
{
  const before = remind.pending().length;
  remind.reload();
  ok(remind.pending().length === before && before === 1, `重新载入（模拟重启）后仍有 ${before} 条`);
}

// ── ④ 到点发送：群 + @ 到位 ───────────────────────────────────────
console.log('\n【到点发送・群里】');
{
  sent.length = 0;
  const item = {
    id: 1,
    what: '交作业',
    by: '30003',
    byName: '<主人>',
    targets: [{ uid: '30004', name: '喵喵三三' }],
    groupId: '20002',
  };
  await fake.sendReminder(item);
  const one = sent[0];
  ok(one?.action === 'send_group_msg', '走的是群消息');
  ok(String(one?.params?.group_id) === '20002', '发到了**他发消息的那个群**');
  const ats = (one?.params?.message ?? []).filter((s) => s.type === 'at').map((s) => String(s.data.qq));
  ok(ats.length === 2, `@ 了两段（他 + 另外那个人），实际 ${ats.length} 段`);
  ok(ats.includes('30003'), '@ 到提要求的人');
  ok(ats.includes('30004'), '@ 到"另外那个人"');
  const txt = (one?.params?.message ?? [])
    .filter((s) => s.type === 'text')
    .map((s) => s.data.text)
    .join('');
  ok(txt.includes('交作业'), '提醒里说到了那件事（模型不可用时退回模板也没漏）');
  ok(!/@\d{5,}/.test(txt), '@ 是**独立消息段**，不是塞在文本里的 @数字');
}

// ── ⑤ 没找到的人：不 @ 他 ─────────────────────────────────────────
console.log('\n【找不到的人不 @】');
{
  sent.length = 0;
  await fake.sendReminder({
    id: 2,
    what: '开会',
    by: '30003',
    byName: '<主人>',
    targets: [{ uid: '', name: '查无此人' }],
    groupId: '20002',
  });
  const ats = (sent[0]?.params?.message ?? []).filter((s) => s.type === 'at');
  ok(ats.length === 1 && String(ats[0].data.qq) === '30003', '只 @ 了提要求的人（没找到的那个绝不乱 @）');
}

// ── ⑥ 只在原地：私聊 ──────────────────────────────────────────────
console.log('\n【只在原地・私聊】');
{
  sent.length = 0;
  await fake.sendReminder({ id: 3, what: '吃药', by: '30003', byName: '<主人>', targets: [], groupId: '' });
  ok(sent[0]?.action === 'send_private_msg', '私聊定的 → 发私聊（不回群里说）');
  ok(String(sent[0]?.params?.user_id) === '30003', '发给提要求的那个人');
  ok(!(sent[0]?.params?.message ?? []).some((s) => s.type === 'at'), '私聊里不带 @ 段');
}

// ── ⑦ 到点 → 发一次就销账 ─────────────────────────────────────────
console.log('\n【发完销账】');
{
  remind.__clear();
  remind.add({ at: Date.now() + 40, what: '马上就到点', by: '30003', byName: '<主人>', groupId: '20002' });
  await new Promise((r) => setTimeout(r, 60));
  const due = remind.due();
  ok(due.length === 1, '到点后被 `due()` 捞出来');
  remind.markSent(due[0].id);
  ok(remind.due().length === 0, '标记后不再重复发');
  remind.reload();
  ok(remind.pending().length === 0, '"发过了"这个事实也落了盘（重启不会补发一遍）');
}

// ── ⑧ 名字反查（"另外一个人是谁"全靠它）────────────────────────────
console.log('\n【名字 → QQ 号】');
{
  names.noteFromList('20002', [
    { user_id: '30004', card: '喵喵三三', nickname: 'miao' },
    { user_id: '30005', card: '老王', nickname: 'Wang' },
  ]);
  ok(names.findByName('喵喵三三', '20002') === '30004', '本群群名片精确命中');
  ok(names.findByName(' 老王 ', '20002') === '30005', '首尾空格不影响');
  ok(names.findByName('@喵喵三三', '20002') === '30004', '带 @ 前缀也能认');
  ok(names.findByName('miao', '20002') === '30004', '退回全局昵称也能认');
  ok(names.findByName('查无此人', '20002') === '', '**查不到就返回空**（上层据此说"没找到"）');
}

// ── ⑨ 时间歧义：8点到底几点（用户补充要求）──────────────────────
console.log('\n【时间歧义】');
{
  const N = new Date(2026, 8, 18, 23, 31, 0, 0).getTime(); // 9/18 23:31
  const noon = new Date(2026, 8, 18, 15, 0, 0, 0).getTime(); // 9/18 15:00
  const early = new Date(2026, 8, 18, 7, 0, 0, 0).getTime(); // 9/18 07:00
  const fmt = (t) => {
    if (!t) return '—';
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes(),
    ).padStart(2, '0')}`;
  };
  const w = (spec, now = N) => fmt(remind.resolveWhen(spec, now));

  ok(w({ hour: 8, period: '', day: '' }) === '9/19 08:00', '深夜只说「8点」→ 明天早上8:00（今晚20点已过）');
  ok(w({ hour: 8, period: '', day: '' }, noon) === '9/18 20:00', '下午只说「8点」→ 今天晚上20:00');
  ok(w({ hour: 8, period: '', day: '' }, early) === '9/18 20:00', '早上只说「8点」→ 还是今晚20:00（默认晚上口径）');
  ok(w({ hour: 8, period: 'am', day: '' }, N) === '9/19 08:00', '「早上8点」深夜说 → 明早8:00');
  ok(w({ hour: 8, period: 'am', day: '' }, early) === '9/18 08:00', '「早上8点」早上说 → 今天8:00');
  ok(w({ hour: 8, period: 'pm', day: '' }, N) === '9/19 20:00', '「晚上8点」过了 → 明晚20:00');
  ok(w({ hour: 8, period: 'am', day: 'tomorrow' }) === '9/19 08:00', '「明天早上8点」→ 明天08:00');
  ok(w({ hour: 8, period: 'pm', day: 'tomorrow' }) === '9/19 20:00', '「明天晚上8点」→ 明天20:00');
  ok(w({ hour: 22, minute: 40, day: '' }, N) === '9/19 22:40', '「22:40」已过 → 明天22:40');
  ok(w({ hour: 22, minute: 40, day: '' }, noon) === '9/18 22:40', '「22:40」没过 → 今天22:40');
  ok(w({ hour: 9, period: 'am', day: '2026-09-21' }) === '9/21 09:00', '「下周一上午9点」→ 按算好的日期');
  ok(
    w({ hour: 8, period: 'am', day: 'today' }) === '9/18 08:00',
    '明说了「今天8点」→ 就按今天（已过就该被拒，不许偷偷顺延）',
  );
  ok(remind.resolveWhen({}, N) === 0, '只说「晚点」→ 算不出来（上层会问她一句几点）');
}

// ── ⑩ 补充式追加 / 修改 / 取消（用户要求）─────────────────────────
console.log('\n【补充式修改】');
{
  remind.__clear();
  const made = remind.add({
    at: Date.now() + 30 * MIN,
    what: '起床',
    by: '30003',
    byName: '<主人>',
    targets: [],
    groupId: '20002',
  });
  const id = made.item.id;
  ok(remind.latest({ by: '30003', groupId: '20002' })?.id === id, '能找到他最近定下的那条');
  ok(remind.latest({ by: '30003', groupId: '99999' }) === null, '别的会话里找不到（只能在原地改）');

  const t2 = Date.now() + 60 * MIN;
  const u = remind.amend(id, { at: t2, targets: [{ uid: '30004', name: 'MEI' }] });
  ok(u.ok && u.item.at === t2, '「顺便改成五点」→ 时间改了');
  ok(u.item.targets.length === 1 && u.item.targets[0].uid === '30004', '「也提醒一下MEI」→ 人加上了');
  ok(u.item.what === '起床', '他没说改内容 → 事情不动');

  remind.amend(id, { targets: [{ uid: '30004', name: 'MEI' }] });
  ok(remind.latest({ by: '30003', groupId: '20002' }).targets.length === 1, '同一个人说两遍不会 @ 两次');
  ok(remind.amend(id, { at: Date.now() - MIN }).ok === false, '改成已经过去的时间 → 拒绝');
  ok(remind.cancel(id) === true && remind.pending().length === 0, '「不用提醒了」→ 真的删掉');
}

// ── ⑪ 进聊天上下文（用户反馈：「提醒不会进聊天上下文」）────────────
console.log('\n【进上下文】');
{
  remind.__clear();
  remind.add({
    at: Date.now() + 3 * 3600 * 1000,
    what: '起床',
    by: '30003',
    byName: '<主人>',
    targets: [{ uid: '30004', name: 'MEI' }],
    groupId: '20002',
  });
  const h = remind.hint('20002');
  ok(h.includes('起床'), '这个群挂着的提醒会进提示词');
  ok(h.includes('MEI'), '连"还要一并提醒谁"一起说清楚');
  ok(remind.hint('88888') === '', '别的群里**不提** A 群定的提醒');
  ok(remind.hint('') === '', '私聊会话也不串味');
  remind.add({ at: Date.now() + 60 * 1000, what: '交作业', by: '30003', groupId: '20002' });
  ok(remind.hint('20002').indexOf('交作业') > 0, '同一会话里多条都在');
  remind.__clear();
  ok(remind.hint('20002') === '', '一条都没有时**不注入**（别给提示词塞空段）');
}

// ── ⑫ 上限：挂太多就拒绝 ──────────────────────────────────────────
console.log('\n【上限】');
{
  remind.__clear();
  config.remind = { ...config.remind, maxItems: 2 };
  const a = remind.add({ at: Date.now() + MIN, what: 'A', by: '1' });
  const b = remind.add({ at: Date.now() + MIN, what: 'B', by: '1' });
  const c = remind.add({ at: Date.now() + MIN, what: 'C', by: '1' });
  ok(a.ok && b.ok && !c.ok, '超过 maxItems 的那条被拒绝（防被刷爆）');
  config.remind = { ...config.remind, maxItems: 50 };
  remind.__clear();
}

names.flush();

console.log(`\n结果: ${fail ? `${fail} 项失败 ❌` : '全部通过 ✅'}（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
