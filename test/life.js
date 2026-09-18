/**
 * 一级日常事件（`src/life.js`）回归。
 *
 * ## 这个套件盯的四件事（都是用户明确要求的）
 *
 * 1. **时段**：午饭的事只能中午出 —— 别出现凌晨三点的拼好饭
 * 2. **随机 + 冷却**（他特意补的：「也不是纯随机，随机要加冷却时间」）
 *    → 一整天模拟下来，**两两间隔必须 ≥ 冷却**
 * 3. **0-7 点完全不发** + **每天条数上限**
 * 4. **掉线不许补发**：迟到超过容忍度就跳过（免得"午饭被偷"半夜发出来）
 *
 * 外加：事件库解析要皮实（用户会手改那个 md），
 * 以及 `compose()` 必须把**同类往事**喂给模型（群友的话能影响以后）。
 *
 * ⚠️ 纯离线：假模型（`phrase()` 走**非流式** → 回整块 JSON，见 AGENTS 铁律①）、
 *    `QQBOT_LIFE_FILE` 指到 `logs/`、故事线也指到 `logs/`。
 *
 * 用法: node test/life.js
 */
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * ⚠️ knowledge 目录：**跟着 `QQBOT_KNOWLEDGE_DIR` 走**（2026-09-15 隔离）。
 *    跑回归时 `run-all.js` 会给每个套件一份自己的副本 ——
 *    这样测试永远不会碰到真实的 `persona.md` / `learned.md`。
 */
const KNOW = process.env.QQBOT_KNOWLEDGE_DIR
  ? join(ROOT, process.env.QQBOT_KNOWLEDGE_DIR)
  : join(ROOT, 'knowledge');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-life.yml';
const LIFE_REL = 'logs/__test-life-state.json';
const STORY_REL = 'logs/__test-life-storyline.json';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// ── 假模型：`phrase()` 是**非流式** → 必须回整块 JSON（AGENTS 铁律①）──
let nextReply = '行吧，那个拼好饭又没了，我下次写你名字。';
const seen = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let j = {};
    try {
      j = JSON.parse(body);
    } catch {}
    seen.push({ stream: !!j.stream, sys: String(j?.messages?.[0]?.content ?? ''), user: String(j?.messages?.[1]?.content ?? '') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: nextReply } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    `  baseURL: http://127.0.0.1:${PORT}/v1`,
    '  apiKey: "sk-test"',
    '  model: t',
    'trigger:',
    '  allowGroups:',
    '    - "200000001"',
    '    - "200000002"',
    '  groupRespondTo:',
    '    "200000001": 1',
    '    "200000002": 1',
    '    "200000003": 3',
    'life:',
    '  enable: true',
    '  minPerDay: 3',
    '  maxPerDay: 5',
    '  startHour: 7',
    '  endHour: 24',
    '  cooldownMs: 5400000',
    '  lateToleranceMs: 1800000',
    'storyline:',
    '  enable: true',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_LIFE_FILE = LIFE_REL;
process.env.QQBOT_STORYLINE_FILE = STORY_REL;

const life = await import('../src/life.js');
const storyline = await import('../src/storyline.js');
const { config } = await import('../src/config.js');

/** 固定序列的假随机（可复现） */
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}
/** 把某个时刻的 Date 造出来（当天几点几分） */
function at(h, m = 0, dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
const reset = () => {
  life.__clear();
  storyline.__clear();
  for (const f of [LIFE_REL, STORY_REL]) {
    try {
      rmSync(join(ROOT, f), { force: true });
    } catch {}
  }
};

/**
 * ⚠️ 预置状态必须先"把今天滚出来"再改。
 *
 * 踩过：`plan()` 发现 `st.day !== 今天` 时会 `rollDay()` ——
 * **把 target / fired / nextAt 全部重置**。所以直接 `__setState({target:3})`
 * 会在下一次 `plan()` 里被冲掉，测试就变成"测了个假的"（我第一版就是这样，
 * target=3 却发出 5 条）。
 */
function arm(now, patch = {}) {
  life.plan(now, seqRng([0.5])); // 先滚出"今天"
  life.__setState({ nextAt: 0, ...patch });
}

// ─────────────────────────────────────────────────────────────
console.log('\n【1】事件库解析：皮实、能吃手改的 md');
{
  const md = readFileSync(join(KNOW, 'life-events.md'), 'utf8');
  const slots = life.parse(md);
  check(slots.length >= 5, `解析出 ${slots.length} 个时段`);
  check(life.templateCount() >= 30, `共 ${life.templateCount()} 条事件`);
  const noon = slots.find((s) => s.name === '中午');
  check(!!noon, '有「中午」时段');
  check(noon.startMin === 12 * 60 && noon.endMin === 13 * 60 + 30, '中午 = 12:00-13:30');
  check(
    noon.templates.some((t) => t.tags.includes('外卖')),
    '★ 标签能解析出来（`#外卖`）',
  );
  check(
    noon.templates.every((t) => t.w >= 1 && t.w <= 5),
    '权重都在 1-5',
  );
  // 坏行不许炸
  const junk = life.parse('### 中午 12:00-13:00\n- 不是合法行\n- xx | \n-\n### 坏的 99\n');
  check(Array.isArray(junk), '乱七八糟的输入不炸');
}

console.log('\n【2】时段：午饭的事只在中午出（不许凌晨三点的拼好饭）');
{
  reset();
  const noonEv = { slot: '中午', template: { text: '拼好饭被偷了', tags: ['外卖'], w: 4 } };
  const s = life.slotAt(at(12, 30));
  check(s?.name === '中午', '12:30 → 中午', s?.name);
  check(life.slotAt(at(3, 0)) === null, '★ 03:00 → 没有时段（也就抽不到午饭）');
  check(life.slotAt(at(8, 0))?.name === '早上', '08:00 → 早上');
  check(life.slotAt(at(23, 30))?.name === '深夜', '23:30 → 深夜');

  // 中午强制发 60 次，全部必须来自中午时段
  // ⚠️ 每次都要把 nextAt 按回"现在" —— 否则第一次之后全是"还没到点"，
  //    循环里一条都没真的抽，断言就成了**假绿**（第一版就是这个错）。
  let fired = 0;
  let allNoon = true;
  for (let i = 0; i < 60; i++) {
    arm(at(12, 30), { nextAt: at(12, 30) });
    const p = life.plan(at(12, 30), Math.random);
    if (!p.fire) continue;
    fired++;
    if (p.slot !== '中午') allNoon = false;
  }
  check(fired === 60, `★ 中午强制抽了 60 次，每次都出（实际 ${fired}）`);
  check(allNoon, '★ 60 次全是中午的事件');
  void noonEv;
}

console.log('\n【3】★ 0-7 点完全不发');
{
  reset();
  let fired = 0;
  for (const h of [0, 2, 3, 5, 6]) {
    life.__setState({ day: '', target: 0, fired: 0, nextAt: 0 });
    const p = life.plan(at(h, 30), seqRng([0.5, 0.5]));
    if (p.fire) fired++;
  }
  check(fired === 0, '★ 00:00-06:59 一次都没发');
  const p = life.plan(at(3, 0), seqRng([0.5]));
  check(/允许时段/.test(p.reason), `理由说得清楚：${p.reason}`);
}

console.log('\n【4】★★ 随机 + 冷却：模拟一整天，两两间隔必须 ≥ 冷却');
{
  reset();
  const COOLDOWN = 90 * 60 * 1000;
  const fires = [];
  let guard = 0;
  // 从 07:00 开始，每 5 分钟问一次，模拟真实的定时器
  for (let t = at(7, 0); t < at(23, 59) && guard < 400; t += 5 * 60 * 1000, guard++) {
    const p = life.plan(t, Math.random);
    if (!p.fire) continue;
    fires.push(t);
    life.commit(p, `第 ${fires.length} 条`, t);
  }
  check(fires.length >= 3 && fires.length <= 5, `一天发了 ${fires.length} 条（上限 3-5）`);
  let minGap = Infinity;
  for (let i = 1; i < fires.length; i++) minGap = Math.min(minGap, fires[i] - fires[i - 1]);
  check(
    minGap >= COOLDOWN,
    `★★ 最小间隔 ${Math.round(minGap / 60000)} 分钟 ≥ 冷却 90 分钟`,
  );
  check(
    fires.every((t) => new Date(t).getHours() >= 7),
    '★ 全都在 7 点之后',
  );
  // 反复模拟多天，每次条数都要在上限内、间隔都要够
  let okDays = 0;
  for (let day = 0; day < 12; day++) {
    reset();
    const f = [];
    for (let t = at(7, 0, day); t < at(23, 59, day); t += 5 * 60 * 1000) {
      const p = life.plan(t, Math.random);
      if (!p.fire) continue;
      f.push(t);
      life.commit(p, 'x', t);
    }
    const gapOk = f.every((t, i) => i === 0 || t - f[i - 1] >= COOLDOWN);
    if (f.length >= 3 && f.length <= 5 && gapOk) okDays++;
  }
  check(okDays === 12, `★ 连跑 12 天，12 天都满足「3-5 条 + 间隔够」（实际 ${okDays}）`);
}

console.log('\n【5】★ 每天条数上限：发够了就停');
{
  reset();
  arm(at(7, 0), { target: 3, fired: 0, nextAt: 0 });
  let n = 0;
  for (let t = at(7, 0); t < at(23, 59); t += 5 * 60 * 1000) {
    const p = life.plan(t, Math.random);
    if (!p.fire) continue;
    n++;
    life.commit(p, 'x', t);
  }
  check(n === 3, `★ target=3 → 正好发 3 条（实际 ${n}）`);
  const p = life.plan(at(22, 0), Math.random);
  check(p.fire === false && /发完/.test(p.reason), `发完之后的理由：${p.reason}`);
}

console.log('\n【6】★ 掉线不补发：迟到超时就跳过');
{
  reset();
  // 预定 12:00，现在 13:00 —— 迟到 60 分钟 > 容忍 30 分钟 → 跳过
  arm(at(13, 0), { target: 4, fired: 0, lastFireAt: 0, nextAt: at(12, 0) });
  const p = life.plan(at(13, 0), seqRng([0.5, 0.5]));
  check(p.fire === false, '★ 迟到 1 小时 → 不 fire');
  check(/跳过/.test(p.reason), `理由是跳过：${p.reason}`);

  // 迟到 10 分钟 → 照发
  reset();
  arm(at(12, 10), { target: 4, fired: 0, lastFireAt: 0, nextAt: at(12, 0) });
  const p2 = life.plan(at(12, 10), seqRng([0.3]));
  check(p2.fire === true, '★ 迟到 10 分钟 → 照发（还没超容忍）', p2.reason);
}

console.log('\n【7】发消息的目标群：只发 1 档 + 在白名单里');
{
  const g = life.targetGroups();
  check(g.includes('200000001'), '主群在内');
  check(g.includes('200000002'), '200000002（1 档）在内');
  check(!g.includes('200000003'), '3 档的群不在内（它只认 @）');
  check(g.length === 2, `一共 ${g.length} 个群`, JSON.stringify(g));
}

console.log('\n【8】★ compose：把同类往事喂给模型（群友的话能影响以后）');
{
  reset();
  // 先让"群友教她改地址"进故事线 —— 带同一个 #外卖 标签
  storyline.note({ tier: 1, text: '群友说下次外卖改个地址', tags: ['外卖', '建议'] });
  arm(at(12, 30), { target: 4, fired: 0, lastFireAt: 0, nextAt: at(12, 30) });
  const p = life.plan(at(12, 30), seqRng([0.1]));
  check(p.fire === true, '中午能出事件', p.reason);
  const text = await life.compose(p);
  check(typeof text === 'string' && text.length > 0, '拿到了润色结果', text);
  const call = seen[seen.length - 1];
  check(call.stream === false, '★ `phrase()` 是非流式的（假模型答对了格式）');
  check(/外卖/.test(call.user), '★ 喂进去的 user 里带了同类往事');
  check(/有关联的往事/.test(call.user), '★ 明确标了"你记得，要前后呼应"');
  check(/改个地址/.test(call.user), '★ 具体内容也在（能写出"改了地址又被偷"）');
  check(/不诉苦|第一人称/.test(call.sys), '系统提示词里有人设约束');
  check(/破折号/.test(call.sys), '★ 提示词里写了"不许破折号"');
}

console.log('\n【9】commit：落盘 + 写故事线 + 排下一次');
{
  reset();
  arm(at(12, 30), { target: 4, fired: 0, lastFireAt: 0, nextAt: at(12, 30) });
  const evId = life.templateCount();
  const p = life.plan(at(12, 30), seqRng([0.1]));
  life.commit(p, '行吧，又没了', at(12, 30));
  const st = life.todayPlan();
  check(st.fired === 1, '已发数 +1');
  check(st.recent.length === 1 && /又没了/.test(st.recent[0].text), 'recent 里有刚才那条');
  // ⚠️ 2026-09-15 分群：故事线是**按群**记的，所以读的时候要指定群
  //    （`commit()` 会写进 `targetGroups()` 里的每一个群）
  const sl = storyline.recent(10, '200000001');
  check(
    sl.some((e) => (e.tags ?? []).includes('外卖')),
    '★ 这件事写进了故事线，还带着 #外卖 标签（下次能关联）',
  );
  check(
    storyline.recent(10, '200000002').length > 0,
    '★ 另一个 1 档群也各记了一份（"同一件事发到所有群、各记各的故事线"）',
  );
  // 落盘
  life.reload();
  check(life.todayPlan().fired === 1, '· reload 后计数还在（落盘了）');
  void evId;
}

console.log('\n【10】边界：库空了不许炸');
{
  reset();
  arm(at(12, 0), { target: 5, fired: 0, lastFireAt: 0, nextAt: at(12, 0) });
  const p = life.plan(at(12, 0), Math.random);
  check(p.fire === true, '正常能抽');
  // 时间落在没有时段的分钟上
  const weird = life.plan(at(6, 30), Math.random);
  check(weird.fire === false, '6:30 不发');
  check(typeof life.status().cooldownMs === 'number', 'status() 能取到冷却值');
}

console.log('\n【11】★★ 事件里点名了谁，就把那个人补进提示词（用户反馈「故事几乎全部都是祥子一个人的」）');
{
  reset();
  const text = await life.compose({
    template: { text: '排练里睦的状态不对，她中途喊了停', tags: [] },
    slot: '傍晚',
  });
  check(typeof text === 'string' && text.length > 0, '拿到了润色结果', text);
  const call = seen[seen.length - 1];
  check(/这件事里出场的人/.test(call.user), '★ 明确标了「这件事里出场的人」');
  check(/若叶睦/.test(call.user), '★ 事件里写的是「睦」，也能认出是若叶睦（cast.md 的别名生效）');
  check(/Ave Mujica/.test(call.user), '★ 那一档的基调也进去了（"四个人都说开了"）');
  check(/别写得像陌生人/.test(call.user), '★ 提示了"是你认识的人，别写得像陌生人"');
  check(/别人当然可以出现/.test(call.sys), '★★ 系统提示词不再逼着模型写独角戏');
  // ⚠️⚠️ 2026-09-15 HZY 截图反馈：「这个很明显，群友看不懂在说什么」
  //    （那条是「房租的那条消息，回了个知道了，然后就把手机扣桌上了」——
  //      "那条消息"是哪个？群里没人知道。就是把事件摘要当话说了。）
  check(/群里的人不知道这件事/.test(call.sys), '★★ 提示词写明了「群里的人不知道这件事」');
  check(/不能只提"那条消息"/.test(call.sys), '★★ 点名禁止"只提那条消息/那个东西"');
  check(/别写成"事件摘要"或旁白/.test(call.sys), '★★ 也禁止把设定复述成摘要');
  check(/谁 \+ 干了什么 \+ 结果/.test(call.sys), '★ 给了可执行的骨架：谁 + 干了什么 + 结果');
  check(/别在对白里再套引号/.test(call.sys), '★ 禁止对白里套引号');
  check(/先让人看懂/.test(call.sys), '★ 长度那条改为"先让人看懂"（不再一味压字数）');
  // ⚠️ 2026-09-15 HZY 截图反馈：「说话对象应该是群友，而不是对祥子队友说的」
  //    一级事件也有这个风险（事件里有人在场 ≠ 她在跟那个人说话）
  check(/听你说话的人是群友/.test(call.sys), '★★ 系统提示词写明了「听你说话的人是群友」');
  check(/别写成你在对她们说话/.test(call.sys), '★ 而且禁止写成对着出场的人说话');

  // 对照：没点名任何人的事件，不该硬塞人物设定
  await life.compose({ template: { text: '练琴练到手指发麻', tags: [] }, slot: '晚上' });
  const call2 = seen[seen.length - 1];
  check(!/出场的人/.test(call2.user), '★ 独角戏的事件不带人物设定（提示词没白涨）');

  // 老团那一档：罕见，但要有由头
  await life.compose({ template: { text: '同台的是 Roselia，她在侧台把整首听完了', tags: [] }, slot: '傍晚' });
  const call3 = seen[seen.length - 1];
  check(/凑友希那/.test(call3.user), '★ 老团整档都给了（名单在里面，不会把名字写错）');
  check(/罕见的背景档/.test(call3.user), '★ 而且标了"罕见"（不会被写成天天混在一起）');
}

console.log('\n【12】★★ 预览一条：会润色，但**不发、不记账、不排程**（HZY 要求加的按钮）');
{
  reset();
  arm(at(12, 30), { target: 4, fired: 0, lastFireAt: 0, nextAt: at(12, 30) });
  const firedBefore = life.todayPlan().fired;
  const nextBefore = life.todayPlan().nextAt;

  const p = await life.preview(at(12, 30));
  check(p.ok === true, '预览成功', p.reason ?? '');
  check(p.slot === '中午', `用的是当前时段（${p.slot}）`);
  check(typeof p.event === 'string' && p.event.length > 0, '给了抽到的事件原文', p.event);
  check(typeof p.text === 'string' && p.text.length > 0, '也给了润色后的话', p.text);
  check(life.todayPlan().fired === firedBefore, '★★ 预览**不记账**（今天已发数没变）');
  check(life.todayPlan().nextAt === nextBefore, '★★ 预览**不动排程**（下次时间没变）');
  check(storyline.recent(10, '200000001').length === 0, '★★ 预览**不写故事线**');

  // 0-7 点没有时段 → 明确拒绝（不炸）
  const night = await life.preview(at(3, 0));
  check(night.ok === false && /没有对应时段/.test(night.reason || ''), `凌晨预览被拒：${night.reason}`);

  // 对照：真发一条**会**记账
  const plan2 = life.plan(at(12, 30), seqRng([0.1]));
  life.commit(plan2, '真发的', at(12, 30));
  check(life.todayPlan().fired === firedBefore + 1, '★ 对照：`commit()` 才会 +1（预览和它是两回事）');
}

console.log('\n【13】★ 改了「每日条数」要**当天就生效**（2026-09-16 用户报的）');
{
  // 用户原话：「为什么我改成日常事件每日3条，现在还是6条」
  // 根因：当天的目标条数是**当天定下并落盘的**，改配置要等第二天 —— 那不像"改了就该生效"。
  const keepLo = config.life.minPerDay;
  const keepHi = config.life.maxPerDay;

  // 造一个"今天的目标是 6"的状态（模拟改配置之前定的）
  config.life.minPerDay = 3;
  config.life.maxPerDay = 6;
  arm(at(12, 30), { target: 6, fired: 1, lastFireAt: at(10, 0), nextAt: 0 });
  check(life.todayPlan().target === 6, '先把今天的目标造成 6');

  // 现在把配置改成"每天 3 条"
  config.life.minPerDay = 3;
  config.life.maxPerDay = 3;
  const changed = life.syncTarget();
  check(changed === true, '★ `syncTarget()` 报告改过了');
  check(life.todayPlan().target === 3, '★★ 今天的目标**立刻**压到 3（不再是 6）', String(life.todayPlan().target));

  // 走一遍真正的检查入口也应该自动对齐（不只是手动调 syncTarget）
  arm(at(12, 30), { target: 6, fired: 1, lastFireAt: at(10, 0), nextAt: 0 });
  life.plan(at(12, 30), seqRng([0.5]));
  check(life.todayPlan().target === 3, '★★ 定时检查（`plan()`）自己也会对齐，不用等跨天');

  // 已经发够了 → 今天就不再发
  arm(at(12, 30), { target: 6, fired: 5, lastFireAt: at(11, 0), nextAt: 0 });
  const p = life.plan(at(12, 30), seqRng([0.5]));
  check(life.todayPlan().target === 3, '先把目标压到 3');
  check(p.fire === false && /发完/.test(p.reason), '★★ 已经发了 5 条（超过新的 3）→ 今天不再发', p.reason);

  // 调大**不追**：不因为改配置打乱今天的节奏
  arm(at(12, 30), { target: 3, fired: 0, lastFireAt: 0, nextAt: 0 });
  config.life.minPerDay = 3;
  config.life.maxPerDay = 8;
  life.syncTarget();
  check(life.todayPlan().target === 3, '★ 调大上限 → 今天仍是 3（明天才按新的随机）');
  // 但下界提上去了就跟着提
  config.life.minPerDay = 5;
  config.life.maxPerDay = 8;
  life.syncTarget();
  check(life.todayPlan().target === 5, '★ 下界提到 5 → 今天的 3 也提到 5（不能比下界还少）');

  // 明天按新配置重滚（跨天）
  const tomorrow = life.plan(at(12, 30, 1), seqRng([0.99]));
  check(
    life.todayPlan().target >= 5 && life.todayPlan().target <= 8,
    '★ 跨天重滚 → 用新配置的 5~8',
    String(life.todayPlan().target),
  );
  void tomorrow;

  config.life.minPerDay = keepLo;
  config.life.maxPerDay = keepHi;
}

console.log('\n【★】2026-09-18：剧情在跑时不许插日常 + 别自己加场景细节');
{
  const srcIndex = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  const srcLife = readFileSync(join(ROOT, 'src', 'life.js'), 'utf8');
  // ★ 用户截图：「二级剧情进行时，一级事件不应该插进来」
  check(
    /if \(quest\.current\(g\)\) \{[\s\S]{0,120}?continue;/.test(srcIndex),
    '★★ 这个群有在跑的剧情 → **整格不发日常**',
  );
  check(
    /quest\.current\(g\)[\s\S]{0,600}?questRollFromLife/.test(srcIndex),
    '★ 这道闸排在"掷骰开新剧情"**之前**（先看有没有在跑的，再决定开不开新的）',
  );
  // ★ 用户截图：「为什么感觉这个事件有点怪」（围裙 / 粉笔灰）
  check(
    /别自己往上加职业 \/ 场景的细节/.test(srcLife),
    '★★ 提示词钉了"别自己加职业/场景细节"（围裙、粉笔灰那种）',
  );
  check(/不是后厨、食堂那类地方/.test(srcLife), '★ 并点明她的打工地点是**客服室**');
}

try {
  server.close();
  for (const f of [CFG_REL, LIFE_REL, STORY_REL]) rmSync(join(ROOT, f), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
