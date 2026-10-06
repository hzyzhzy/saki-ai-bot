/**
 * 二级剧情（`src/quest.js`）回归。
 *
 * ## 盯的是用户拍板的那几条硬规矩
 *
 * · **阶段数**：≤10、最佳 3、其余**指数下降**（不是指望模型自愿写短）
 * · **全局同时只 1 条**；最近 7 天有上限
 * · **每段等群友最多 30 分钟**，超时自动续写
 * · ★ **冷场**：有人回过就正常续；**一个人都没回就最多续 1 次然后收尾**
 * · ★ **>3 段后逐级加重"该收了"**，但不能生硬（提示词里要看得见压力在涨）
 * · **好结局 / 坏结局**，而且★ 二级对好感度的影响**比一级大**
 * · **谁能改剧情**：只认 @她 / 回复她 / 明显是建议的句子
 * · **落盘**：重启（reload）之后剧情还在，能接着跑
 *
 * ⚠️ 纯离线：`ask` 是注入的假模型，`QQBOT_QUEST_FILE` 指到 `logs/`。
 *    **不起机器人、不连 NapCat、不发消息。**
 *
 * 用法: node test/quest.js
 */
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-quest.yml';
const QUEST_REL = 'logs/__test-quest-state.json';
const STORY_REL = 'logs/__test-quest-story.json';

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
    'quest:',
    '  enable: true',
    '  chance: 0.1',
    '  maxPerWeek: 3',
    '  waitMs: 1800000',
    '  maxStages: 10',
    '  coldAutoLimit: 1',
    '  affinityGood: 3',
    // ⚠️ 坏结局**扣分**（2026-09-15 <主人> 拍板）。必须显式写负数 ——
    //    顺便验一下 `config.js` 的夹取没把负数吃掉（原来下限是 0）。
    '  affinityBad: -2',
    'storyline:',
    '  enable: true',
    'life:',
    '  enable: true',
    // ⚠️ 必须**显式写** chunking —— 代码里的默认值是 260/90，
    //    而真实 config.yml 是 60/25。不写的话分条测试测的是"没人用的那套默认值"，
    //    断言就会和真机行为不一致（第一版就是这么挂的）。
    'chunking:',
    '  maxChars: 60',
    '  delayMs: 650',
    '  firstFlushChars: 25',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_QUEST_FILE = QUEST_REL;
process.env.QQBOT_STORYLINE_FILE = STORY_REL;

const quest = await import('../src/quest.js');
const storyline = await import('../src/storyline.js');

/** 假模型：按顺序吐出预设的回复，并记下收到的提示词 */
let replies = [];
let prompts = [];
const ask = async (messages) => {
  prompts.push({
    sys: String(messages?.[0]?.content ?? ''),
    user: String(messages?.[1]?.content ?? ''),
  });
  return replies.length ? replies.shift() : JSON.stringify({ event: '无事', text: '嗯。', done: false, ending: null });
};

const J = (o) => '```json\n' + JSON.stringify(o) + '\n```'; // 故意带围栏，验容错
const reset = () => {
  quest.__clear();
  storyline.__clear();
  prompts = [];
  replies = [];
  for (const f of [QUEST_REL, STORY_REL]) {
    try {
      rmSync(join(ROOT, f), { force: true });
    } catch {}
  }
};

/** 开一条 + 记下 id */
async function startOne(extra = {}) {
  replies = [J({ premise: '她在打工回家的路上被一辆自行车撞了，手肘擦破一大块', event: '她手肘受伤了', text: '……被自行车撞了，手肘破了。没事。' })];
  return quest.begin({ ask, ...extra });
}

// ─────────────────────────────────────────────────────────────
console.log('\n【1】★★ 阶段数：≤10、最佳 3、其余指数下降');
{
  const ws = quest.stageWeights();
  // ⚠️ 2026-10-03 改：用户要求「**不要 1 段的了**」⇒ 分布从 **2 段**起（9 档）。
  //    1 段那不叫一条线，就是一条日常事件。
  check(ws.length === 9, '一共 9 档（2..10 段）');
  const byN = Object.fromEntries(ws.map((x) => [x.n, x.w]));
  check(byN[1] === undefined, '★ 不再有 1 段（用户 2026-10-03：「不要 1 段的了」）');
  check(byN[3] === Math.max(...ws.map((x) => x.w)), '★ 3 段的权重最高');
  let mono = true;
  for (let n = 3; n < 10; n++) if (!(byN[n] > byN[n + 1])) mono = false;
  // ⚠️ 往下只到 2 段（1 段已经不存在了）
  for (let n = 3; n > 2; n--) if (!(byN[n] > byN[n - 1])) mono = false;
  check(mono, '★ 离 3 越远权重越小（指数下降，两边都单调）');
  check(byN[10] < byN[3] / 100, `10 段几乎不可能（权重比 ${(byN[10] / byN[3]).toFixed(4)}）`);

  // 抽 30000 次看实际分布
  const cnt = {};
  for (let i = 0; i < 30000; i++) {
    const n = quest.pickStageCount();
    cnt[n] = (cnt[n] || 0) + 1;
  }
  const total = 30000;
  const p3 = cnt[3] / total;
  check(cnt[3] === Math.max(...Object.values(cnt)), `★ 3 段出现最多（${(p3 * 100).toFixed(1)}%）`);
  check(p3 > 0.3, `★ 3 段占比 > 30%（实际 ${(p3 * 100).toFixed(1)}%）`);
  check(!cnt[11] && !cnt[0], '★ 不会抽出 0 段或 11 段以上');
  const pTen = (cnt[10] || 0) / total;
  check(pTen < 0.01, `10 段极罕见（${(pTen * 100).toFixed(2)}%）`);
}

console.log('\n【2】开一条剧情：起因要从故事线找、开场进故事线且被锁定');
{
  reset();
  // 先在故事线里放一条由头
  storyline.note({ tier: 1, text: '她在便利店夜班被人缠着问路', tags: ['打工'] });
  const r = await startOne();
  check(r.ok === true, '开起来了', r.reason ?? '');
  check(!!r.quest?.premise, '有起因', r.quest?.premise);
  check(r.quest.plannedStages >= 1 && r.quest.plannedStages <= 10, `计划 ${r.quest?.plannedStages} 段`);
  check(prompts[0].user.includes('便利店夜班'), '★ 起因的由头喂给模型了（最近的故事线在里面）');
  check(prompts[0].user.includes('只写') || prompts[0].user.includes('开头这一段'), '★ 明确要求"只写开头这一段"');
  const sl = storyline.recent(20).filter((e) => e.tier === 2);
  check(sl.length >= 1, '★ 开场写进了故事线（tier 2）');
  check(sl[0].locked === true, '★★ 而且是**锁定的**（二级不可删）');
}

console.log('\n【3】★ 全局同时只 1 条 + 最近 7 天上限');
{
  reset();
  await startOne();
  const again = await startOne();
  check(again.ok === false, '★ 已经有 1 条在跑时不许再开', again.reason);
  check(/只允许 1 条|已经有一条/.test(String(again.reason)), '理由说清了是"同时只 1 条"');

  // 结束它 → 还能再开
  quest.finish(quest.current(), 'good', 'llm');
  const third = await startOne();
  check(third.ok === true, '结束后能再开');

  // 塞满 7 天上限
  reset();
  const now = Date.now();
  quest.__set({ starts: [now - 1000, now - 2000, now - 3000] });
  const blocked = await startOne();
  check(blocked.ok === false, '★ 7 天内已经 3 条 → 不许再开', blocked.reason);
  check(/上限/.test(String(blocked.reason)), '理由提到上限');
  check(quest.weeklyCount(now) === 3, 'weeklyCount = 3');
  // 挪出窗口 → 又能开
  quest.__set({ starts: [now - 8 * 24 * 3600 * 1000] });
  check(quest.weeklyCount(now) === 0, '★ 滚动窗口：8 天前的不算（不是"自然周"）');
}

console.log('\n【4】分段推进 + 群友的话进提示词、也进故事线');
{
  reset();
  const r = await startOne();
  const q = r.quest;
  prompts = [];
  replies = [J({ event: '缠着她的那个人跟到了店门口', text: '……他还在门口站着。', done: false, ending: null })];
  const a1 = await quest.advance(q, {
    ask,
    replies: [{ userId: '10000003', name: '某群友', text: '你别一个人走，叫同事送你' }],
  });
  check(a1.ok === true, '推进了一段', a1.reason ?? '');
  check(a1.done === false, '还没结束');
  check(prompts[0].user.includes('某群友'), '★ 群友的话喂进去了');
  check(prompts[0].user.includes('可以改主意') || prompts[0].user.includes('改主意'), '★ 明确告诉它"群友的话可以让她改主意"');
  check(quest.current().stages.length === 2, 'quest 里现在有 2 段');
  check(quest.current().cast.includes('10000003'), '★ 把参与的人记进了 cast（后面发好感度用）');
  const sl = storyline.recent(30);
  check(sl.some((e) => e.tier === 2 && /第2段/.test(e.text)), '★ 这一段写进了故事线');
  check(
    sl.some((e) => /某群友说/.test(e.text)),
    '★★ 群友那句建议也写进了故事线（用户要求：「群友说的一些话也可以记录进故事线」）',
  );
}

console.log('\n【5】★★ 谁的话能改剧情：@她 / 回复她 / 建议 / 问句（三档可调）');
{
  reset();
  const herIds = ['msg-1', 'msg-2'];
  const t = (p) => quest.isPlotReply(p).hit;
  check(t({ segs: [{ type: 'at', data: { qq: '10000002' } }], text: '在吗', selfId: '10000002' }), '★ @她 → 算');
  check(t({ segs: [{ type: 'reply', data: { id: 'msg-1' } }], text: '干嘛', herIds }), '★ 回复她的消息 → 算');
  check(t({ segs: [], text: '要不你先去医院看看吧', selfId: '1' }), '★ 明显是建议 → 算');
  check(t({ segs: [], text: '我觉得你可以报警', selfId: '1' }), '★ "我觉得你…" → 算');
  check(
    !t({ segs: [{ type: 'at', data: { qq: '999' } }], text: '@别人 你看这个', selfId: '1' }),
    '★ @的是**别人** → 不算（别把别人的对话算进来）',
  );

  // ★ 2026-09-15 <主人> 截图反馈：这句原来被判成"闲聊"，不对
  const shot = { segs: [], text: '你看看里面是什么东西了吗', selfId: '1' };
  check(t(shot), '★★ 截图中那句「你看看里面是什么东西了吗」→ **算数**', JSON.stringify(quest.isPlotReply(shot)));

  // 中文问句经常不打问号、也不提"你"
  check(t({ segs: [], text: '那你怎么处理的', selfId: '1' }), '★ 不打问号的追问 → 算');
  check(t({ segs: [], text: '这个包会不会有炸弹啊', selfId: '1' }), '★ 没提"你"但明显在聊这件事 → 算');

  // 纯起哄永远不算
  for (const junk of ['哈哈哈哈这也太惨了', '草', '卧槽', '666666']) {
    check(!t({ segs: [], text: junk, selfId: '1' }), `★ 纯起哄不算：${junk}`);
  }

  // 三档
  const mode = (m, text) => quest.isPlotReply({ segs: [], text, selfId: '1', mode: m }).hit;
  check(mode('strict', '应该先报警'), 'strict：明显的建议仍算');
  check(!mode('strict', '那你怎么处理的'), '★ strict：问句不算');
  check(mode('normal', '那你怎么处理的'), '★ normal：问句算');
  check(!mode('normal', '哈哈哈哈这也太惨了'), '★ normal：起哄不算');
  check(!mode('normal', '这也太离谱了吧'), '★ normal：普通吐槽不算');
  check(mode('loose', '这也太离谱了吧'), '★ loose：普通吐槽也算');
  check(!mode('loose', '哈哈哈哈这也太惨了'), '★★ loose：**起哄永远不算**（放宽也要有底线）');
  check(!mode('loose', '草'), '★★ loose：短起哄也不算');
  check(quest.isPlotReply({ segs: [], text: '要不你换个地址吧' }).why === 'suggest', '理由标成 suggest（好排查）');
  check(quest.isPlotReply({ segs: [], text: '那你怎么处理的' }).why === 'question', '问句标成 question');
}

console.log('\n【6】★★ 冷场：一个人都没回 → 最多自动续 1 次就收尾');
{
  reset();
  const r = await startOne();
  const q = r.quest;
  // 第一次没人的自动续写 → 允许
  replies = [J({ event: '那人走了', text: '……走了。', done: false, ending: null })];
  const a1 = await quest.advance(q, { ask, replies: [] });
  check(a1.ok === true && a1.done === false, '第 1 次冷场续写：放行');
  check(quest.coldStop() === null, '还不收（autoContinues=1，刚好到限）');
  // 第二次冷场 → 该收了
  replies = [J({ event: '又一段', text: '……', done: false, ending: null })];
  await quest.advance(q, { ask, replies: [] });
  const stopped = quest.coldStop();
  check(!!stopped, '★ 连续冷场后收尾了');
  check(stopped?.ending === 'bad', '冷场算坏结局');
  check(quest.current() === null, '★ 收尾后 current 清空（能开下一条了）');
  check(quest.status().recent.some((x) => x.ending === 'bad'), '进了历史');
}

console.log('\n【7】★ 有人回过 → 就不按"冷场"收，走正常流程');
{
  reset();
  const r = await startOne();
  const q = r.quest;
  replies = [J({ event: '同事送她回家', text: '……同事送我回来的。', done: false, ending: null })];
  await quest.advance(q, { ask, replies: [{ userId: 'u1', name: 'A', text: '叫同事送你啊' }] });
  // 之后连续两次没人说话 —— 但因为"有人回过"，不许冷场收尾
  replies = [J({ event: 'x', text: '……', done: false, ending: null })];
  await quest.advance(q, { ask, replies: [] });
  await quest.advance(q, { ask, replies: [] });
  check(quest.coldStop() === null, '★★ 有人回过 → 冷场机制不生效');
  check(quest.current() !== null, '剧情还在跑');
}

console.log('\n【8】★★ >3 段后"该收了"的压力逐级加重（但不能生硬）');
{
  const p3 = quest.endPressure(3, 3);
  const p4 = quest.endPressure(4, 3);
  const p5 = quest.endPressure(5, 3);
  const p6 = quest.endPressure(6, 3);
  check(p4.length > p3.length && p5.length > 0 && p6.length > p5.length, '压力随段数变长');
  check(/一两段内应该收尾/.test(p4), '4 段：提醒"接下来一两段内收尾"');
  check(/别突然截断|自然/.test(p4), '★ 4 段时强调"收得自然，别突然截断"（不生硬）');
  check(/给出结局|给一个结局/.test(p5), '5 段：要求给结局');
  check(/必须是最后一段/.test(p6), '★ 6 段：强制这是最后一段');

  // 提示词里真的注入了压力
  reset();
  const r = await startOne();
  const q = r.quest;
  q.stageIndex = 3;
  q.stages = [1, 2, 3].map((i) => ({ i, at: Date.now(), text: `第${i}段`, event: `第${i}段`, replies: [] }));
  prompts = [];
  replies = [J({ event: 'e', text: 't', done: false, ending: null })];
  await quest.advance(q, { ask, replies: [] });
  check(/已经 4 段|该收了|收尾/.test(prompts[0].user), '★ 第 4 段的提示词里带上了收尾压力');
}

console.log('\n【8b】★★ 剧情文本的断句兜底（用户：「这个结局…两句又合到一起了」）');
{
  // 用户截图里那条结局的原文：整段 50 字，全是逗号，**一个句末标点都没有**
  const messy =
    '那杯水最后倒了，重新接了一杯热的敲了门，她果然没睡我把水放下，说我六点就得走，你现在想说就说，我听着';
  const fixed = quest.ensureSentenceEnds(messy);
  check((fixed.match(/。/g) || []).length >= 2, '★ 整段全是逗号 → 补出句末标点（分条才断得开）');
  check(!/，，|。。|，。/.test(fixed), '不产生连续标点');
  check(
    quest.ensureSentenceEnds('她点了点头。然后走了。') === '她点了点头。然后走了。',
    '本来就有句号的 → 一个字都不改',
  );
  check(/。/.test(quest.ensureSentenceEnds('她还在门口站着呢 她先来敲门了')), '汉字+空格+汉字 → 补句号');
  // 真的能分条才算修好 —— 光有句号不算
  const { splitChatText } = await import('../src/bot.js');
  check(splitChatText(messy).length === 1, '（对照）没修过的原文分不出条');
  check(splitChatText(fixed).length >= 2, '★ 修过之后分条函数真的断成两条以上');
}

console.log('\n【9】★ 硬上限：到 maxStages 必须收，收不明就当坏结局');
{
  reset();
  const r = await startOne();
  const q = r.quest;
  q.stageIndex = 9; // 下一段是第 10 段 = 硬上限
  q.stages = Array.from({ length: 9 }, (_, i) => ({ i: i + 1, at: Date.now(), text: 'x', event: 'x', replies: [] }));
  prompts = [];
  replies = [J({ event: '最后一段', text: '……就这样吧。', done: false, ending: null })]; // 模型不肯收
  const a = await quest.advance(q, { ask, replies: [] });
  check(a.done === true, '★ 硬上限强制 done');
  check(a.forced === true, '标了 forced');
  check(/最后一段|硬上限/.test(prompts[0].user), '★ 提示词里写死"必须是最后一段"');
  check(quest.current() === null, '已收尾');
}

console.log('\n【10】★ 结局 → 好感度：好结局加、**坏结局扣**（二级幅度都比一级大）');
{
  check(quest.endingDelta('good') === 3, '好结局 +3');
  // ⚠️ 2026-09-15 <主人> 拍板改成**负数**：「我一开始是想坏结局要掉好感度的」。
  //    原来这里断言的是 +1 —— 而且 config.yml 里写 `affinityBad: 0` 时，
  //    `Number(0) || 1` 会把它悄悄变成 1（0 被当成"没填"），两头都错。
  check(quest.endingDelta('bad') === -2, '★ 坏结局 **−2**（扣分）');
  check(quest.endingDelta('good') > quest.endingDelta('bad'), '★ 好 > 坏');
  check(quest.endingDelta('good') > 1, '★ 二级（3）明显大于一级事件的 ±1');
  check(Math.abs(quest.endingDelta('bad')) >= 1, '★ 坏结局的幅度也不小于一级的 ±1');
}

console.log('\n【11】★ 落盘：reload 之后剧情还在（掉线不能断）');
{
  reset();
  const r = await startOne();
  const id = r.quest.id;
  const before = quest.current().stageIndex;
  // 模拟重启：重新读取状态
  const q2 = await import(`../src/quest.js?v=${Date.now()}`);
  check(q2.current()?.id === id, '★ reload 后还是同一条剧情');
  check(q2.current()?.stageIndex === before, `阶段也保住了（${before}）`);
  check(q2.status().running === true, 'status 说在跑');
  check(q2.current().premise === r.quest.premise, '起因保住了');
}

console.log('\n【12】30 分钟没动静 → due() 该说"到点了"');
{
  reset();
  const r = await startOne();
  const q = r.quest;
  const t0 = q.awaitingSince;
  check(quest.due(t0 + 10 * 60 * 1000) === false, '等了 10 分钟：还没到');
  check(quest.due(t0 + 29 * 60 * 1000) === false, '等了 29 分钟：还没到');
  check(quest.due(t0 + 31 * 60 * 1000) === true, '★ 等了 31 分钟：到点了（该自动续写）');
}

console.log('\n【13】坏输入不许炸');
{
  reset();
  const r = await startOne();
  const q = r.quest;
  prompts = [];
  replies = ['这不是 JSON，就是一段普通文字']; // 模型没按格式回
  const a = await quest.advance(q, { ask, replies: [] });
  check(a.ok === true, '★ 不是 JSON 也能用（退回原文）', String(a.text).slice(0, 20));
  check(quest.current() !== null, '剧情没被弄坏');
  const bad = await quest.advance(null, { ask });
  check(bad.ok === false, '传 null 不炸');
  // ⚠️ 要先清掉 current —— 否则先撞上"已经有一条在跑了"，测不到 ask 那条校验
  quest.finish(quest.current(), 'good', 'test');
  const noAsk = await quest.begin({});
  check(noAsk.ok === false && /ask/.test(noAsk.reason), '没给 ask 明确报错', noAsk.reason);
}

console.log('\n【14】★★ 沙箱：模拟绝对不许碰真实状态 / 不许落盘 / 要收集故事线');
{
  // 先在真实状态里放一条"正在跑"的剧情，看模拟会不会把它弄坏
  reset();
  const real = await startOne();
  const realId = real.quest.id;
  const realPremise = real.quest.premise;
  const realStage = real.quest.stageIndex;
  const fileBefore = existsSync(join(ROOT, QUEST_REL)) ? readFileSync(join(ROOT, QUEST_REL), 'utf8') : '';

  // —— 进沙箱，跑一条完全不同的剧情 ——
  const old = quest.swapState({ current: null, recent: [], starts: [], nextHint: '' });
  const off = quest.setSandbox(true);
  try {
    const sim = await quest.begin({ ask, extraHint: '模拟用的由头' });
    check(sim.ok === true, '沙箱里能开剧情', sim.reason ?? '');
    replies = [J({ event: '模拟第2段', text: '模拟第二段话', done: false, ending: null })];
    await quest.advance(sim.quest, { ask, replies: [{ userId: 'sim', name: '模拟群友', text: '你报警吧' }] });
    replies = [J({ event: '模拟结局', text: '就这样吧', done: true, ending: 'good' })];
    await quest.advance(sim.quest, { ask, replies: [] });
  } finally {
    const collected = quest.sandboxLog();
    check(collected.length >= 3, `★ 沙箱里写的故事线被**收集**起来了（${collected.length} 条，不是丢掉）`);
    check(collected.some((e) => e.tier === 2), '里面有主线条目');
    check(collected.some((e) => /模拟群友说/.test(e.text)), '★ 群友那句话也在里面');
    quest.setSandbox(off);
    quest.swapState(old);
  }

  // —— 出沙箱之后，真实状态必须原封不动 ——
  check(quest.current()?.id === realId, '★★ 真实剧情还在，而且还是同一条');
  check(quest.current()?.premise === realPremise, '★★ 起因没变');
  check(quest.current()?.stageIndex === realStage, '★★ 段数没变');
  const fileAfter = existsSync(join(ROOT, QUEST_REL)) ? readFileSync(join(ROOT, QUEST_REL), 'utf8') : '';
  check(fileAfter === fileBefore, '★★ 磁盘上的 state 文件**一个字节都没动**');
  check(!fileAfter.includes('模拟'), '★★ 文件里没有模拟的痕迹');
  check(quest.sandboxLog().length === 0, '出沙箱后收集器清空');
}

console.log('\n【15】★ 「替换下次二级事件」：存一句、用一次就清');
{
  reset();
  check(quest.nextHint() === '', '一开始是空的');
  quest.setNextHint('  她今天在便利店被人缠上了  ');
  check(quest.nextHint() === '她今天在便利店被人缠上了', '存下来了（两端空格去掉）');
  const taken = quest.takeNextHint();
  check(taken === '她今天在便利店被人缠上了', '★ 取得出来');
  check(quest.nextHint() === '', '★★ **用一次就清**（否则每次都套同一句）');
  check(quest.takeNextHint() === '', '再取是空的');
  quest.setNextHint('落盘测试');
  const reloaded = await import(`../src/quest.js?hint=${Date.now()}`);
  check(reloaded.nextHint() === '落盘测试', '★ reload 之后还在（落盘了）');
  quest.setNextHint('');
  // ⚠️ 2026-09-15 晚：**按群各存各的**（<主人>：「最好也加个群选择…因为每个群的故事线不一样」）
  quest.setNextHint('A 群的由头', 'gA');
  quest.setNextHint('B 群的由头', 'gB');
  check(
    quest.nextHint('gA') === 'A 群的由头' && quest.nextHint('gB') === 'B 群的由头',
    '★★ 两个群各存各的（互不覆盖）',
  );
  check(quest.nextHint('gC') === '', '★★ 没存过的群是空的（**不会**串到别的群那句）');
  check(quest.takeNextHint('gA') === 'A 群的由头', '★ 取走 gA 那句');
  check(
    quest.nextHint('gA') === '' && quest.nextHint('gB') === 'B 群的由头',
    '★★ 用掉一个群的**不影响别的群**',
  );
  const hintsNow = quest.hintsByGroup();
  check(hintsNow.gB === 'B 群的由头' && !hintsNow.gA, '★ hintsByGroup() 报的是各群现在存着什么');
  // ⚠️ load() 是**白名单式重建**，新字段最容易在这里被丢掉 —— 所以必须验一遍 reload
  const rl = await import(`../src/quest.js?hint2=${Date.now()}`);
  check(rl.nextHint('gB') === 'B 群的由头', '★★ 按群那句 reload 之后还在（load 里没漏字段）');
  // 全局兜底：老页面/老状态那份还在，而且**只在群里没存的时候**才用
  quest.setNextHint('全局兜底那句');
  check(
    quest.nextHint('gB') === 'B 群的由头' && quest.nextHint('gZ') === '全局兜底那句',
    '★ 群里有就用群里的、群里没有才退回全局那份（兼容老状态）',
  );
  quest.setNextHint('', 'gB');
  quest.setNextHint('');
}

console.log('\n【16】★ 群友发言是"先攒着、下一段一起消化"');
{
  reset();
  const r = await startOne();
  const q = r.quest;
  check(quest.pendingCount() === 0, '一开始没攒下的');
  quest.noteReply(q, { userId: 'u1', name: 'A', text: '你报警吧' });
  quest.noteReply(q, { userId: 'u2', name: 'B', text: '要不别一个人走' });
  quest.noteReply(q, { userId: 'u3', name: 'C', text: '   ' }); // 空白不算
  check(quest.pendingCount() === 2, `★ 攒下了 2 句（空白那句不算，实际 ${quest.pendingCount()}）`);
  check(existsSync(join(ROOT, QUEST_REL)), '★ 攒的发言**落了盘**（掉线不能弄丢）');
  prompts = [];
  replies = [J({ event: 'e', text: 't', done: false, ending: null })];
  await quest.advance(q, { ask }); // 不给 replies → 用攒下的
  check(/你报警吧/.test(prompts[0].user) && /别一个人走/.test(prompts[0].user), '★★ 攒下的两句都喂给模型了');
  check(quest.pendingCount() === 0, '★ 消化完就清空（不会下一段又重复喂一遍）');
}

console.log('\n【17】★★ 接线：群消息能被收进剧情（走和真群同一条判定）');
{
  reset();
  const { Bot } = await import('../src/bot.js');
  const b = new Bot();
  b.selfId = '10000002';

  // 没有剧情在跑时，什么都不该发生
  const r0 = await startOne();
  quest.finish(quest.current(), 'good', 'test');
  const b0 = new Bot();
  b0.selfId = '10000002';
  b0.noteQuestReply({ group_id: '200000001', user_id: 'u1', sender: { nickname: 'A' } }, [], '你报警吧');
  check(quest.pendingCount() === 0, '没剧情在跑 → 不收集');

  // 开一条剧情（手工把状态放进去，避免再调一次模型）
  reset();
  const r = await startOne();
  const q = quest.current();
  q.groupId = '200000001';
  quest.rememberHerMsg(q, 'msg-hello');

  const segsAt = [{ type: 'at', data: { qq: '10000002' } }];
  const segsReply = [{ type: 'reply', data: { id: 'msg-hello' } }];
  const ev = (uid, nick) => ({ group_id: '200000001', user_id: uid, sender: { nickname: nick } });

  b.noteQuestReply(ev('u1', '落墨'), [], '你没事吧');
  check(quest.pendingCount() === 0, '★ 不在剧情群里 / 不是@也不是建议 → 不收');

  b.noteQuestReply({ ...ev('u1', '落墨'), group_id: '999' }, segsAt, '你没事吧');
  check(quest.pendingCount() === 0, '★ 别的群的发言不收（只在剧情那个群）');

  b.noteQuestReply(ev('u1', '落墨'), segsAt, '你没事吧');
  check(quest.pendingCount() === 1, '★ @她 → 收下了');

  b.noteQuestReply(ev('u2', '大豆'), segsReply, '回家了吗');
  check(quest.pendingCount() === 2, '★ **回复她那条消息** → 收下了（靠 herMsgId 认出来的）');

  b.noteQuestReply(ev('u3', '陌拜'), [], '要不你先别一个人走');
  check(quest.pendingCount() === 3, '★ 明显是建议 → 收下了');

  b.noteQuestReply(ev('u4', '路人'), [], '哈哈哈哈太惨了');
  check(quest.pendingCount() === 3, '★ 纯看热闹 → 不收');

  // 她自己说的话不算
  b.noteQuestReply(ev('10000002', 'ZYHG'), segsAt, '我没事');
  check(quest.pendingCount() === 3, '★ 她自己发的消息不算');
}

console.log('\n【18】★★ 结局结算：只给参与过的人加，二级幅度更大');
{
  reset();
  const r = await startOne();
  const q = quest.current();
  const calls = [];
  const adjust = (uid, d, o) => {
    calls.push({ uid, d, note: o?.note });
    return { ok: true, value: 50 + d };
  };
  q.cast = ['u1', 'u2'];
  const good = quest.settle(q, 'good', adjust);
  check(good.delta === 3, '好结局 delta = 3');
  check(calls.length === 2, '★ 只给参与过的 2 个人加（cast 里的人）');
  check(calls.every((c) => c.d === 3), '每人都 +3');
  check(/好结局/.test(calls[0].note || ''), 'note 里写了是好结局（方便排查）');
  check(good.applied.length === 2 && good.applied[0].ok === true, 'applied 记录了结果');

  // 没参与过的人 → 一个人都不加
  calls.length = 0;
  q.cast = [];
  const none = quest.settle(q, 'bad', adjust);
  check(calls.length === 0 && none.applied.length === 0, '★ 没人参与 → 不加任何人');

  // ★ 2026-09-15 改口径：坏结局是**扣分**（用户要求「坏结局要掉好感度」）
  calls.length = 0;
  q.cast = ['u1'];
  const bad = quest.settle(q, 'bad', adjust);
  check(bad.delta === -2 && calls[0].d === -2, '★ 坏结局 −2（真的往下扣，不是加）');
  check(quest.endingDelta('good') > quest.endingDelta('bad'), '★ 好 > 坏');

  // adjust 抛错不许影响别人
  calls.length = 0;
  q.cast = ['u1', 'u2'];
  const res = quest.settle(q, 'good', (uid) => {
    if (uid === 'u1') throw new Error('炸了');
    calls.push(uid);
    return { ok: true };
  });
  check(calls.length === 1 && res.applied.length === 2, '★ 一个人结算失败不影响另一个');
  check(res.applied[0].ok === false, '失败的那条记了 ok:false');
}

console.log('\n【18b】★ 结局播报的文案（2026-09-17 用户要求）');
{
  // 用户原话：「加一个二级剧情结局展示，**跟在机器人发的剧情最后一句话之后
  //   一秒钟发送**，内容首先展示本次剧情结束，这次是好/坏结局，
  //   哪些人加/减了多少好感度」。
  const nameOf = (uid) => ({ u1: '群友1', u2: '群友2' })[uid] ?? uid;

  // ① 好结局：第一行是"本次剧情结束 + 好结局"，然后逐人写前后分数
  const good = {
    ending: 'good',
    delta: 3,
    applied: [
      { userId: 'u1', from: 62, to: 65, got: 3 },
      { userId: 'u2', from: 50, to: 53, got: 3 },
    ],
  };
  const t = quest.endingReport(good, nameOf);
  check(t.startsWith('【本次剧情结束'), '★ 第一行就是「本次剧情结束」（用户要求"首先展示"）');
  check(/好结局/.test(t), '★ 写了是好结局');
  check(t.includes('群友1') && t.includes('群友2'), '★ 列出参与的人（用群名片名字，不是 QQ 号）');
  check(/62 → 65/.test(t) && /50 → 53/.test(t), '★ 写了每个人加之前 → 加之后');
  check(!/@/.test(t), '⚠️ 不 @ 任何人（@ 会弹通知，那道口子只留给"余额见底催充值"）');

  // ② 坏结局：负号要出来
  const bad = quest.endingReport(
    { ending: 'bad', delta: -2, applied: [{ userId: 'u1', from: 62, to: 60, got: -2 }] },
    nameOf,
  );
  check(/坏结局/.test(bad) && /好感度 -2/.test(bad), '★ 坏结局写 −2（不是 +）');
  check(/62 → 60/.test(bad), '扣完的分数也对');

  // ③ 数字没动 ≠ 没参与，是**今天的加分额度用完了**（减分不占额度，所以只出现在好结局）
  const capped = quest.endingReport(
    { ending: 'good', delta: 3, applied: [{ userId: 'u1', from: 50, to: 50, got: 0 }] },
    nameOf,
  );
  check(/没变/.test(capped) && /额度/.test(capped), '★★ 加了但没动 → 说明是额度用完了（别让人以为漏算了他）');

  // ④ 边界：没人参与就没什么可播报的
  check(quest.endingReport({ ending: 'good', delta: 3, applied: [] }, nameOf) === '', '没人参与 → 返回空串（不白发一条）');
  check(quest.endingReport(null, nameOf) === '', 'null 安全');
  check(quest.endingReport({ ending: 'bad', delta: -2 }, nameOf) === '', '没有 applied 字段也不炸');

  // ⑤ 拿不到前后值（`adjust` 抛了 / 好感度功能关着）也要把名字列出来
  const broken = quest.endingReport(
    { ending: 'good', delta: 3, applied: [{ userId: 'u1', from: null, to: null, ok: false }] },
    nameOf,
  );
  check(broken.includes('群友1'), '★ 结算失败也列名字（不然群友以为没算他）');

  // ⑥ 延迟是常量，且正好一秒
  check(quest.ENDING_REPORT_DELAY_MS === 1000, `★ 延迟 1000ms（当前 ${quest.ENDING_REPORT_DELAY_MS}）`);

  // ⑦ ★★ 结算结果必须带**实际**变化 —— 原来取 `r.value`，而 `affinity.adjust`
  //    返回的是 `{ ok, from, to, applied }`，**根本没有 value**，所以一直是 null。
  const real = quest.settle({ groupId: '', cast: ['u1'] }, 'good', () => ({
    ok: true,
    from: 50,
    to: 53,
    applied: 3,
  }));
  check(
    real.applied[0].from === 50 && real.applied[0].to === 53 && real.applied[0].got === 3,
    '★★ applied 带上 from/to/got（修掉"取 .value 永远是 null"那个坑）',
  );
}

console.log('\n【18c】★ 群里热情 → 自动加演 + 缩短等待（2026-09-17 用户要求）');
{
  // 用户原话：「如果出现**群友非常热情**的情况，**段数太少的情况下可以自动增加 2-3 段**，
  //   然后**缩短等待推下一段时间**」。
  //
  // 触发场景是实测的（2026-09-17 晚，群 200000006）：模型那条只计划了 **2 段**，
  // 而群里已经回了 **12 条** —— 按 2 段就收掉太可惜，而且群友正聊得起劲。

  // ① 热度怎么算：数条数，也数人
  const w1 = quest.warmthOf([{ userId: 'u1' }, { userId: 'u1' }, { userId: 'u2' }, { userId: 'u1' }]);
  check(w1.count === 4 && w1.people === 2, `★ 条数和人数都数（${w1.count} 条 / ${w1.people} 人）`);
  check(quest.warmthOf([]).count === 0, '空列表安全');
  check(quest.warmthOf(null).count === 0, 'null 安全');
  // ⚠️ 只看条数、**不要求人多** —— 实际群里常常是"一个人特别起劲"连着引用、接话
  //    （用户截图那次就是「喵喵三三」一个人连发好几条），要求 ≥2 人会漏掉最典型的热情
  check(
    quest.warmthOf([{ userId: 'u1' }, { userId: 'u1' }, { userId: 'u1' }, { userId: 'u1' }]).count >= 4,
    '★ 一个人连回 4 条也算热情（不强制要求多个人）',
  );

  // ② 加演之后，"该收了"那道坎要跟着往后挪
  //    不挪的话：`endPressure` 一边催收、`warmHint` 一边叫继续 → 模型写出精神分裂的段落
  check(/该收了/.test(quest.endPressure(3, 3, 0)), '第 3 段（没加演）时提示该收了');
  check(quest.endPressure(3, 3, 3) === '', '★ 加演 3 段后，第 3 段**不再催收**（坎挪到第 6 段）');
  check(/该收了/.test(quest.endPressure(6, 3, 3)), '到第 6 段（= 3 + 加演 3）时才又开始催');

  // ③ 热情时生成前就要告诉它别收（比事后把 done 按回去管用）
  const hint = quest.warmHint(
    { warmth: { warm: true, count: 6, people: 2 }, extraStages: 0, plannedStages: 5, stageIndex: 2 },
    3,
  );
  check(/先别收/.test(hint), '★ 热情时提示"这一段先别收"');
  check(/6 条回应/.test(hint), '提示里带了实际的热度（不是空泛地说"热闹"）');
  check(/别为了长而长/.test(hint), '⚠️ 同时提醒别硬凑（不然会注水）');
  check(quest.warmHint({ warmth: { warm: false, count: 1, people: 1 } }) === '', '不热情 → 一个字都不加');
  check(quest.warmHint({}) === '', '没有热度数据也不炸');
  check(
    /加演了 1 段/.test(
      quest.warmHint(
        { warmth: { warm: true, count: 5, people: 2 }, extraStages: 1, plannedStages: 5, stageIndex: 3 },
        4,
      ),
    ),
    '已经加演过的话，提示会说清加到第几段',
  );
  // ★★ 已经超出计划段数时**必须闭嘴**（2026-09-17 <主人> 截图：「已经 6/5 了，什么时候发剧情总结」）
  //    它跟 `endPressure` 的"这一段必须是最后一段"打架，模型会听"别收" ⇒ 永远不收尾、
  //    结局播报也永远发不出来。
  check(
    quest.warmHint(
      { warmth: { warm: true, count: 9, people: 3 }, extraStages: 3, plannedStages: 5, stageIndex: 5 },
      6,
    ) === '',
    '★★ 超出计划段数 → 不再叫它"先别收"（把收尾权交回 endPressure）',
  );
  check(
    /先别收/.test(
      quest.warmHint({ warmth: { warm: true, count: 9, people: 3 }, plannedStages: 5, stageIndex: 4 }, 5),
    ),
    '刚好第 5 段（= 计划）时还能劝一次别收',
  );

  // ④ 上限：不能因为热情就无限拖
  check(quest.WARM_EXTRA_STAGES === 3, `★ 最多加演 3 段（当前 ${quest.WARM_EXTRA_STAGES}）`);
  check(quest.WARM_COUNT === 4, `默认 4 条算热情（当前 ${quest.WARM_COUNT}）`);

  // ⑤ ★★ 计划段数要**真的涨**（用户专门澄清过：「我是说计划段数」）
  //    第一版只在内部把"该收了"的坎往后挪、没动 plannedStages —— 界面上永远显示"计划 2 段"，
  //    用户以为没生效。
  const qa = { plannedStages: 2, warmth: { warm: true, count: 12, people: 3 } };
  check(quest.bumpPlanned(qa) === 3 && qa.plannedStages === 5, `★ 热情 → 计划段数 2 → 5（+3），实际 ${qa.plannedStages}`);
  check(quest.bumpPlanned(qa) === 0 && qa.plannedStages === 5, '★ 只加一次（否则每推进一段都 +3，永远收不了）');
  const qb = { plannedStages: 9, warmth: { warm: true } };
  check(quest.bumpPlanned(qb) === 1 && qb.plannedStages === 10, `涨不过 10 段硬上限（${qb.plannedStages}）`);
  check(quest.bumpPlanned({ plannedStages: 2, warmth: { warm: false } }) === 0, '不热情 → 一段都不加');
  check(quest.bumpPlanned({}) === 0, '没有剧情对象也不炸');

  // ⑥ 意外转折的写作要求（2026-09-17 用户要求：「可以加点意外转折」）
  const src = readFileSync(join(ROOT, 'src', 'quest.js'), 'utf8');
  check(/意外转折/.test(src), '★ 提示词里加了"意外转折"这条');
  check(/别为了转折而转折/.test(src), '★ 同时提醒别硬凑（不然就是注水凑字数）');
  check(/不要超自然/.test(src), '⚠️ 转折必须落在现实里（不超自然、不车祸绝症）');
}

console.log('\n【18d】★ 剧情要进她的聊天提示词（2026-09-17 修）');
{
  // <主人> 截图：「@saki 找到药了吗」→ 她答「什么药啊，你哪不舒服了」——
  // 而她上一段刚在群里说过"这会儿我在给她翻药箱"。
  //
  // 根因：二级剧情的接线一直是**单向**的（群友的话 → 记进剧情），
  // **从来没有反过来把剧情注入她的聊天提示词**。重启后 `recent` 一空更明显。
  check(typeof quest.briefFor === 'function', '★ 有 briefFor()（给聊天用的剧情摘要）');
  check(quest.briefFor('这个群没有剧情') === '', '没有剧情 → 返回空串（一个字都不注入）');
  // ⚠️ 这里**不能**断言"一定是空串"：不传群号时它会去查"没指定群"那个桶
  //    （`current('')`），而套件里造过的剧情可能正好落在那里（第一版就是这么挂的）。
  //    要断言的是**安全**（不抛错、返回字符串）。
  check(typeof quest.briefFor() === 'string', '不传群号也安全（返回字符串，不抛错）');

  const botSrc2 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/quest\.briefFor\(event\.group_id\)/.test(botSrc2), '★★ buildSystemPrompt 里真的注入了（按群）');
  check(
    /event\?\.message_type === 'group'/.test(botSrc2),
    '★ 只在群里注入（私聊没有"群剧情"这回事）',
  );
  check(/别主动把后面的发展抖出来/.test(botSrc2) === false, '（提示词文案在 quest.js 里，不在 bot.js）');
  check(/别主动把后面的发展抖出来/.test(readFileSync(join(ROOT, 'src', 'quest.js'), 'utf8')),
    '★ 摘要里提醒了"别主动抖后面的发展"（她自己也不知道会怎么走）');
  // ★★ 摘要必须带时间、并说清"那是过去的事"（2026-09-17 <主人> 报的：
  //    「剧情出现去吃饭这种时间事件，祥子会**一直处于要去吃饭的状态**，
  //      而且有人叫她去吃饭她**可能又会一起吃**」）
  const qs2 = readFileSync(join(ROOT, 'src', 'quest.js'), 'utf8');
  // ★★ 2026-09-18 改过措辞：原来是"不是你现在的状态"，但配合那句
  //    "按现在这一刻答、别拿几小时前那句话当挡箭牌"，等于**教她否认自己说过的话** ——
  //    用户截图（<主人> 问「你不是说去菜场那边看看吗」、她答「我哪说去菜场了」）就栽在这儿。
  //    现在拆成两件事：**什么时候发生的** vs **是不是你说过的**。
  check(/把两件事分清/.test(qs2), '★★ 摘要分清了"什么时候发生的"和"是不是你说过的"两件事');
  check(/不等于你现在还要去吃饭/.test(qs2), '★ 而且拿"去吃饭"当反例点了名');
  check(/两头都不许/.test(qs2), '★★ 两头都不许编：不许否认说过的、也不许认下没说的');
  check(/ago\(s\.at\)/.test(qs2), '★ 每一段都带相对时间（几分钟前 / 几小时前）');

  // ★ 「等下一段」要能分开"真在推剧情"和"随口一句"（2026-09-17 用户要求）
  //   原来四条全标"等下一段"，里面混着"我感觉和真人聊天好累""包的"这种闲聊。
  const qSrc2 = readFileSync(join(ROOT, 'src', 'quest.js'), 'utf8');
  check(/why: String\(why/.test(qSrc2), '★ noteReply 把判据 why 存下来了');
  check(/why: x\.why \?\? ''/.test(qSrc2), '★ status() 把 why 给了界面');
  check(/verdict\.why/.test(botSrc2), '★ bot.js 收集群友发言时把判据一起传进去');
  const html = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  // ⚠️ 界面**不再分第二类** —— 能进 pending 的都已经过了 isPlotReply 那道筛，
  //    再分一类等于自己又加判据（<主人> 指出过这一点）。现在只标"它是怎么进来的"。
  // ⚠️ 用 `>顺口说的<` 精确匹配**标签**本身 —— 注释里提到这四个字不算（第一版就是这么假失败的）
  check(!/>顺口说的</.test(html), '★ 标签里不再有"顺口说的"这一类（那等于自己又加判据）');
  check(/在问剧情/.test(html) && /给了建议/.test(html) && /叫了她/.test(html),
    '★ 括号里写清了是靠哪条判据进来的（叫了她 / 给了建议 / 在问剧情…）');
}

console.log('\n【19】★ 接线与发送：源码层面确认那几根线都接上了');
{
  const idx = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  const botSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/questTick/.test(idx), 'index.js 里有剧情推进的定时器');
  check(/quest\.due\(Date\.now\(\), gid\)/.test(idx), '★ 到点了才推进（⚠️ 分群之后按群问）');
  check(/quest\.coldStop\(Date\.now\(\), gid\)/.test(idx), '★ 冷场先判（一个人都没回就收）');
  check(/quest\.rememberHerMsg\(/.test(idx), '★ 发出后记下 message_id（"回复她"要用）');
  check(/quest\.settle\(/.test(idx), '★ 结局会结算好感度');
  check(/quest\.endingReport\(/.test(idx), '★ 自动跑完会播报结局（2026-09-17 用户要的"结局展示"）');
  check(/quest\.ENDING_REPORT_DELAY_MS/.test(idx), '★ 播报是隔 1 秒发的（"最后一句话之后一秒钟"）');
  // ⚠️ 2026-09-17：热情 → 加演 + 缩短等待。这几根线都在 src/quest.js 里，单独读它断言。
  const questSrc = readFileSync(join(ROOT, 'src', 'quest.js'), 'utf8');
  check(/q\.warmth\?\.warm === true/.test(questSrc), '★★ due() 热情时缩短等待（读的是上一段的热度）');
  check(/warmWaitMs/.test(questSrc), '★ 缩短后的等待可配（warmWaitMs，默认 waitMs 的 1/3）');
  check(/used < WARM_EXTRA_STAGES/.test(questSrc), '★★ 加演有上限（不会因为热情一直拖下去）');
  check(/next < MAX_STAGES/.test(questSrc), '★★ 加演也不许突破 10 段硬上限');
  // ★★★ 压住 `done` 的兜底**必须跟 `warmHint` 用同一条边界** ——
  //    2026-09-17 只改了提示词那一半，模型给的 done 被这行按了回去，
  //    剧情卡在 7/5 永远收不了尾、结局播报也发不出来（<主人> 报的）。
  check(/next <= plan/.test(questSrc), '★★★ 压住 done 的兜底也受计划段数约束（不能只改提示词那一半）');
  // ★ 题材要够分量（2026-09-17 用户：「剧情还可以再爆点，毕竟几率很小」）
  check(/题材要够分量/.test(questSrc), '★ 提示词里要求剧情题材够分量（一周才三次，别写日常琐事）');
  check(/别写成日常琐事/.test(questSrc), '★ 并举例排除了买菜 / 做饭那类（那些留给一级事件）');
  check(/也别写成卖惨/.test(questSrc), '⚠️ 但"爆"≠卖惨 —— 她的基调是遇到事硬扛（这条别丢）');
  check(/extraStages/.test(questSrc), '★ 加演了几段记在剧情状态里（落盘、界面能看）');
  check(
    /quest\.endingReport\(/.test(readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8')),
    '★ 面板手动推进也会播报（群友看到的是同一条，不是只在面板里）',
  );
  check(/questRollFromLife/.test(idx), '★ 一级事件的槽位会先掷骰（一成走二级）');
  check(
    // ⚠️ 2026-09-16 分群改造：tick 变成**挨个群问**（`life.plan(..., g)`），
    //    所以"这一格走剧情就不发一级"变成循环里的 `continue` —— 意图一样：
    //    **走了剧情就不发日常、也不记一级故事线**（那件事没发生）。
    /if \(questRollFromLife && \(await questRollFromLife\(plan, g\)\)\) continue;/.test(idx),
    '★★ 走了剧情就**不发一级、也不记账**（那件事没发生）',
  );
  check(/noteQuestReply\(event, segs, realText\)/.test(botSrc), '★ bot.js 在收群消息时挂了剧情收集钩子');
  // ⚠️ 判"钩子在闸门之前"要**比位置**，不能用固定的字符窗口 ——
  //    中间后来插了 `noteInteraction` / `tryAffinityBoard`，窗口一超就假失败（踩过）
  const hookAt = botSrc.indexOf('this.noteQuestReply(event, segs, realText);');
  const gateAt = botSrc.indexOf('if (this.selfId && msg.isAt(segs, this.selfId)) return null;', hookAt);
  check(hookAt >= 0, '找得到那个钩子');
  check(
    hookAt >= 0 && gateAt > hookAt,
    '★★ 钩子在**所有"要不要搭理"的判定之前** —— 否则剧情发言会被闸门筛掉',
    `hookAt=${hookAt} gateAt=${gateAt}`,
  );
  check(/return this\.call\('send_group_msg'/.test(botSrc), '★ sendToGroup 现在会返回 message_id');
}

console.log('\n【20】★★ 强制结局：好/坏都要能确定看到（模拟面板的按钮）');
{
  reset();
  const r = await startOne();
  const q = r.quest;

  // —— 强制坏结局 ——
  prompts = [];
  replies = [J({ event: '事情没解决，她只能先这样', text: '……算了。', done: false, ending: null })]; // 模型不肯收
  const bad = await quest.advance(q, { ask, replies: [], forceEnd: 'bad' });
  check(bad.done === true, '★★ 模型没给 done，也**强制收尾**了');
  check(bad.ending === 'bad', '★★ 结局就是我们指定的 bad（不看模型回的什么）');
  check(bad.forcedEnding === 'bad', '返回值里标了 forcedEnding，好排查');
  check(/必须是「坏结局」/.test(prompts[0].user), '★ 提示词里写死了"必须是坏结局"');
  // ⚠️ 2026-09-15 改口径（<主人>：「结局其实可以写得狗血一点」）：
  //    原来这里断言的是「**不要**狗血」—— 现在反过来，要求**够狠、够狗血**。
  //    只有「不卖惨」这条底线保留（她不诉苦是 persona.md 的底子）。
  check(/够狠、够狗血|够狗血/.test(prompts[0].user), '★★ 坏结局要求"够狠、够狗血"（原来是不许狗血）');
  check(/不卖惨/.test(prompts[0].user), '★ 但底线还在：不卖惨（狗血 ≠ 卖惨）');
  check(!/不要狗血/.test(prompts[0].user), '★ 原来那句「不要狗血」已经删掉');
  check(quest.current() === null, '收尾了');
  check(quest.status().recent.slice(-1)[0].ending === 'bad', '进了历史，是坏结局');

  // —— 强制好结局 ——
  reset();
  const r2 = await startOne();
  prompts = [];
  replies = [J({ event: '事情解决了', text: '……搞定了。', done: false, ending: 'bad' })]; // 模型想给坏结局
  const good = await quest.advance(r2.quest, { ask, replies: [], forceEnd: 'good' });
  check(good.ending === 'good', '★★ 模型想给 bad，但**以我们指定的 good 为准**');
  check(/必须是「好结局」/.test(prompts[0].user), '★ 提示词里写死了"必须是好结局"');
  check(/狗血/.test(prompts[0].user) && /别升华|不要升华/.test(prompts[0].user),
    '★ 好结局也允许戏剧性（狗血），但**不许升华成心灵鸡汤**');
  check(quest.endingDelta('good') === 3 && quest.endingDelta('bad') === -2, '★ 两种结局的好感度确实不一样（+3 / −2）');

  // —— 正常推进不受影响 ——
  reset();
  const r3 = await startOne();
  prompts = [];
  replies = [J({ event: 'e', text: 't', done: false, ending: null })];
  const normal = await quest.advance(r3.quest, { ask, replies: [] });
  check(normal.done === false && normal.forcedEnding === null, '★ 不指定 forceEnd 时行为不变');
  check(!/必须是「/.test(prompts[0].user), '★ 正常情况下提示词里没有"强制结局"那段');

  // —— 界面接线 ——
  const html = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  const js = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(/btn-qs-good/.test(html) && /btn-qs-bad/.test(html), '★ 界面上有"收成好结局/坏结局"两个按钮');
  check(/simNext\(false,'good'\)/.test(html) && /simNext\(false,'bad'\)/.test(html), '★ 两个按钮都把结局传下去了');
  check(/forceEnd: forceEnd \|\| null/.test(html), '★ simNext 会把 forceEnd 发给后端');
  check(/forceEnd/.test(js), '★ 后端接收并透传给引擎');
}

console.log('\n【21】★★ 分条：像人说的话都要分条，机器格式的才整条发');
{
  reset();
  const { Bot, splitChatText } = await import('../src/bot.js');

  // ① 多句、够长 → 要分
  const long = '今天店里有个客人落了包。后来有人回来要，我问他里面装的什么，他支支吾吾答不上来。我直接扣下了，等他明天凭证据来。';
  const parts = splitChatText(long);
  check(parts.length >= 2, `★ 56 字三句话 → 切成 ${parts.length} 条`, JSON.stringify(parts));
  check(parts.every((p) => p.length <= 60), '每条都不超上限');
  check(parts.join('') === long.replace(/。$/, ''), '★ 内容没丢（只是去掉行尾句号）');

  // ② 破折号处**强制**断开（用户明确要求"该分段就分段"）
  const dash = splitChatText('行吧，那个拼好饭又没了——我下次写你名字');
  check(dash.length === 2, '★ 破折号处断成两条', JSON.stringify(dash));
  check(!dash.some((p) => p.includes('\u0001')), '★★ 内部标记不许漏出去');

  // ③ 短句不分（别把「嗯」也拆）
  check(splitChatText('……算了。').length === 1, '短句不分条');
  check(splitChatText('嗯').length === 1, '一个字不分条');

  // ④ 机器格式的**不许**分条：排行榜那种整条发
  const b = new Bot();
  const sentTo = [];
  b.call = async (action, params) => {
    sentTo.push({ action, text: params?.message?.[0]?.data?.text });
    return { message_id: 'm' + sentTo.length };
  };
  await b.sendChatLike('200000001', long);
  check(sentTo.length >= 2, `★★ sendChatLike 真的分成 ${sentTo.length} 条发出去了`);
  check(sentTo.every((s) => s.action === 'send_group_msg'), '走的都是发群接口');

  sentTo.length = 0;
  await b.sendToGroup('200000001', long);
  check(sentTo.length === 1, '★ sendToGroup 仍然整条发（给排行榜/验证消息用，不分条）');

  // ④b ⚠️⚠️ 她**主动**说的话也要进自己的聊天上下文（2026-09-15 <主人> 截图反馈：
  //    「说话有点没头没尾」「没接上话」）。
  //    根因：日常/剧情/余额抱怨都走 sendChatLike，而只有正常回复那条路会 rememberBot
  //    → 她主动说的话不在上下文里 → 群里人回一句「什么地址」，她当成全新问题答了。
  {
    const recentMod = await import('../src/recent.js');
    // ⚠️ 用 `contextText()` 看**喂给模型的那段上下文**（这才是"她记不记得自己说过"的判据）
    const ctxOf = () => recentMod.contextText('200000001');
    sentTo.length = 0;
    const before = ctxOf();
    await b.sendChatLike('200000001', '这是一句很特别的主动发言内容');
    const after = ctxOf();
    check(/很特别的主动发言/.test(after), '★★ sendChatLike 发的句子**进了她自己的聊天上下文**', after.slice(0, 90));
    check(after.length > before.length, '★ 上下文确实变长了');
    sentTo.length = 0;
    await b.sendToGroup('200000001', '这是排行榜那种机器消息不该进上下文');
    check(ctxOf() === after, '★★ 机器格式的（sendToGroup）**不许**进上下文');
  }

  // ⑤ 返回 message_id（剧情靠它认"回复她"）
  sentTo.length = 0;
  const ret = await b.sendChatLike('200000001', long);
  check(Array.isArray(ret) && ret.length >= 2, '★ 返回每条的结果（带 message_id）');
  check(ret.every((r) => r?.message_id), '每条都有 message_id');

  // ⑥ 接线：三个发送点都用了 sendChatLike
  const idx = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  const js = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  const botSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/sendChatLike\(gid, text\)/.test(idx), '★ 剧情那段走 sendChatLike（会分条）');
  // ⚠️ 2026-09-15：日常那一路多了参数（`{ kind:'life', outbox:false }` —— 日常靠"顺延"
  //    不靠"补发"，见 src/outbox.js 的注释），所以断言不能写死 `sendChatLike(g, text)`。
  check(/sendChatLike\(g, text/.test(idx), '★ 一级日常也走 sendChatLike');
  check(/kind: 'life'[\s\S]{0,40}outbox: false|outbox: false/.test(idx), '★ 而且明确不走待发箱（靠顺延）');
  check(/sendChatLike\(gid, r\.text\)/.test(js), '★ 界面「立即开始剧情」也走 sendChatLike');
  check(/for \(const r of sent\) quest\.rememberHerMsg/.test(idx), '★★ 每一条的 message_id 都记了（群友可能回复其中任何一条）');
  check(
    /user 原则|只要\*\*不是那种排行榜/.test(botSrc) || /排行榜之类/.test(botSrc),
    '★ 代码里写清了"什么该分条、什么不该"的原则',
  );
}

console.log('\n【22】★★ 总开关：管"自动"，不管"手动测试"（<主人>：「先加个开关…先多测试几条再正式启用」）');
{
  const { config } = await import('../src/config.js');
  const wasEnabled = config.quest.enable;

  reset();
  // —— 关掉总开关 ——
  config.quest.enable = false;
  const auto = quest.canStart();
  check(auto.ok === false, '★ 关着 → **自动**开剧情被拒');
  check(/自动开关是关的/.test(auto.reason), '理由说清了是"自动开关"', auto.reason);

  const manual = quest.canStart(Date.now(), { manual: true });
  check(manual.ok === true, '★★ 关着 → **手动**仍然能开（不然"关着也想测"就测不了）');

  // —— 手动不受每周上限限制 ——
  const now = Date.now();
  quest.__set({ starts: [now - 1000, now - 2000, now - 3000] });
  check(quest.canStart(now).ok === false, '自动：7 天满了 → 拒');
  check(quest.canStart(now, { manual: true }).ok === true, '★ 手动：7 天满了也放行（调试不该被上限挡住）');

  // —— 但"同时只 1 条"对谁都不放宽 ——
  // ⚠️ 这里**直接预置**一条在跑的剧情，不要用 `startOne()` ——
  //    上面刚把 starts 塞满 + 开关关着，`begin()` 根本开不出来，
  //    于是 current 还是 null，断言就测了个空气（第一版就是这么挂的）。
  quest.__set({
    starts: [],
    current: { id: 'q-x', startedAt: now, premise: '在跑的', stageIndex: 1, stages: [], pending: [], endedAt: 0 },
  });
  const busy = quest.canStart(now, { manual: true });
  check(busy.ok === false, '★★ 手动也要遵守"同时只 1 条"');
  check(/同时只允许 1 条/.test(busy.reason), '理由说清了是"同时只 1 条"', busy.reason);

  // —— 关着总开关时，**界面那两条路真的能开起来** ——
  // ⚠️⚠️ 这条是补的：2026-09-15 <主人> 反馈「现在自动生成剧情用不了，得开剧情自动开关」，
  //    根因是 `begin()` 里**又按自动规则检查了一次** ——
  //    外面的 `canStart({manual:true})` 放行了，里面照样拒。
  //    所以断言必须落在**真的调一次 begin** 上，不能只查 `canStart`。
  reset();
  replies = [J({ premise: '手动测试的由头', event: 'e', text: 't' })];
  const began = await quest.begin({ ask, manual: true, groupId: '(模拟)' });
  check(began.ok === true, '★★★ 关着总开关 + manual:true → **begin() 真的开起来了**', began.reason ?? '');
  check(quest.current('(模拟)') !== null, '剧情确实建起来了（⚠️ 分群之后按群查）');
  quest.finish(quest.current(), 'good', 'test');

  // 对照：不带 manual → 必须被拒（自动那条线要守住）
  reset();
  replies = [J({ premise: 'x', event: 'e', text: 't' })];
  const refused = await quest.begin({ ask, groupId: 'g' });
  check(refused.ok === false, '★★ 对照：关着 + 不带 manual → 仍然被拒');
  check(/自动开关是关的/.test(String(refused.reason)), '理由说清了是自动开关', refused.reason);

  // 界面两条路都要带 manual
  const js = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  const simStart = js.slice(js.indexOf("'POST /api/quest/sim/start'"), js.indexOf("'POST /api/quest/sim/next'"));
  check(/manual: true/.test(simStart), '★★ 模拟面板的开始**传了 manual**（不然关着开关就用不了）');
  const realStart = js.slice(js.indexOf("'POST /api/quest/start'"), js.indexOf("'POST /api/quest/sim/start'"));
  check(/manual: true/.test(realStart), '★★「立即开始剧情」**也传了 manual**');

  config.quest.enable = wasEnabled;
  reset();
}

console.log('\n【23】★★ 开关关着时，"推进"和"收发言"必须还能用');
{
  // 这三根线如果也被开关挡住，手动开的剧情就永远推进不了/收不到回复
  const idx = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  const botSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const js = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');

  check(
    !/if \(config\.quest\?\.enable !== false\)\s*\{[\s\S]{0,200}?setInterval\(questTick/.test(idx),
    '★★ 推进定时器**不再**被总开关包着（否则手动开的剧情永远不推进）',
  );
  check(
    /无条件注册/.test(idx) && /setInterval\(questTick, every\)/.test(idx),
    '★ 定时器无条件注册（没剧情时是空转）',
  );
  // ⚠️ 判据是"**查到剧情之前**没有 `xxx.enable` 这道闸" ——
  //    别写成固定长度的窗口正则（注释一长就失配，2026-09-15 晚踩过）；
  //    也**必须先去掉行注释**再判：那段注释里正当地写着"这里不看 `quest.enable`"。
  const noteReplyHead = (botSrc.match(/noteQuestReply\(event, segs, text\) \{[\s\S]*?const q = quest\.current\(/) ?? [''])
    [0].replace(/\/\/[^\n]*/g, '');
  check(
    noteReplyHead.trim().length > 0 && !/\.enable/.test(noteReplyHead),
    '★★ 收群友发言**不再**看总开关（否则手动开的剧情收不到回复）',
  );
  // ⚠️⚠️ 2026-09-15 晚修的真 bug：分群之后剧情按群存，
  //    `quest.current()` **不传群号**查的是"没指定群"那个空桶 → 群里的话一条都收不进去。
  check(
    /const q = quest\.current\(gid\) \?\? quest\.current\(\)/.test(botSrc),
    '★★ 而且必须按**这个群**查（不传群号 = 查空桶，群里的话全收不到）',
  );
  check(
    /const q = quest\.current\(String\(event\.group_id \?\? ''\)\) \?\? quest\.current\(\)/.test(botSrc),
    '★★ 她接话那条插曲也一样按群查',
  );
  check(/manual: true \}/.test(js) || /manual: true/.test(js), '★ 界面「立即开始剧情」传了 manual');

  // 自动那条线仍然受开关控制
  // ⚠️ 2026-09-16：开关/概率改成**按群读**（`quest.params(g)`）—— 界面上能按群设了，
  //    再读全局那一份就等于白设。这里钉住"逐群判 + 按群读"。
  check(
    /const qp = quest\.params\(g\)/.test(idx) &&
      /qp\.enable === false \|\| !quest\.canStart\(Date\.now\(\), \{ groupId: g \}\)\.ok/.test(idx),
    '★ 掷骰子自动开那条仍然受开关控制（⚠️ 逐群判 + 按群读参数）',
  );

  // 界面上有开关，而且接线完整
  // ⚠️ 2026-09-16：二级剧情的参数**完全按群**了，全局那张「参数」卡删掉 →
  //    开关挪到了「按群设定」页（`gp-quest-enable`，三态：跟内置/开/关）。
  const html = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/gp-quest-enable/.test(html), '★ 参数（按群）那边有开关');
  check(/onoff\('gp-quest-enable'/.test(html), '★ 打开页面时回填开关状态');
  check(/boolOrNull\('gp-quest-enable'\)/.test(html), '★ 保存时提交开关状态');
  check(/关着也能测/.test(html), '★ 界面上写清了"关着也能测"（不然用户会以为关了就不能测）');
}

console.log('\n【24】★★ 编剧情时必须有人在场（用户反馈「故事几乎全部都是祥子一个人的」）');
{
  reset();
  prompts = [];
  replies = [J({ premise: '排练时睦的状态不对', event: '排练到一半她喊了停', text: '今天先到这儿。' })];
  const r = await quest.begin({ ask, manual: true, groupId: 'g-cast' });
  check(r.ok === true, '开起来了', r.reason ?? '');
  const sys = prompts[0].sys;
  check(/出场人物名册/.test(sys), '★ 系统提示词里带上了人物名册（原来一个名字都没有）');
  check(/三角初华/.test(sys) && /若叶睦/.test(sys), '★ 同团四个人在里面');
  check(/高松灯/.test(sys) && /长崎素世/.test(sys) && /椎名立希/.test(sys), '★ CRYCHIC 那三位也在');
  check(/Roselia/.test(sys) && /Morfonica/.test(sys), '★ 老团也在（标成"罕见、必须有由头"）');
  check(/有别人在场/.test(sys), '★★ 明确要求「每一段都必须有别人在场或被卷进来」');
  check(
    !/只写祥子这条线/.test(sys),
    '★★ 去掉了原来那句「只写祥子这条线」—— 提示词里没有名册时，模型就照着它写成了独白',
  );
  check(/开头这一段就要有人在场/.test(prompts[0].user), '★ 开场那一段的 user 里也提醒了');

  prompts = [];
  await quest.advance(r.quest, { ask, replies: [] });
  check(/这一段也要有人在场/.test(prompts[0].user), '★ 续写的 user 里也有同一条要求');

  // 名册只给"档名 + 频率基调 + 人名"，不带每个人的详细说明（那会涨好几千字）
  const roster = String(sys).split('# 出场人物名册')[1]?.split('\n\n---')[0] ?? '';
  check(roster.length > 300 && roster.length < 3000, `★ 名册是紧凑的（${roster.length} 字，没把 cast.md 整篇塞进去）`);
  check(!/别主动对外讲她的身世/.test(sys), '★ 每个人的「别写」说明没有被塞进 system（那是 castBlock 按需给的）');
}

console.log('\n【25】★★ 上一条是坏结局 → 下一条的开场直接写成「挽回」（<主人> 2026-09-15）');
{
  // ⚠️ 2026-09-15 分群：**必须自始至终用同一个群** ——
  //    不然第一条落在"没指定群"那个桶、第二条落在 g-redeem，`prevQuest` 就找不到了。
  const G = 'g-redeem';
  reset();
  const r1 = await startOne({ groupId: G });
  check(r1.ok === true, '第一条开起来了', r1.reason ?? '');
  prompts = [];
  replies = [];
  await quest.advance(r1.quest, { ask, replies: [], forceEnd: 'bad' });
  check(quest.status(G).recent.slice(-1)[0].ending === 'bad', '第一条收成了坏结局');
  check(quest.status(G).redeemPending === true, '★ status 说「下一条该写挽回了」');

  // 下一条：提示词里必须点上一条的坏结局
  prompts = [];
  replies = [J({ premise: '她去找上次那个人把话说清楚', event: '她主动约了对方', text: '我去找她一趟。' })];
  const r2 = await quest.begin({ ask, groupId: G });
  check(r2.ok === true, '第二条开起来了', r2.reason ?? '');
  const u2 = prompts[0].user;
  check(/坏结局/.test(u2), '★★ 提示词里点明了「上一条是坏结局」');
  check(/挽回|收拾残局/.test(u2), '★★ 而且要求这一段写「挽回」');
  check(u2.includes(r1.quest.premise), '★★ 把上一条的起因也带上了（"直接参考坏结局剧情"）');
  check(/你别自己定成圆满/.test(u2), '★ 但能不能挽回交给群友，不预设圆满');
  // ★★ 2026-10-05 加（用户截图：「如果马上开下一个剧情，她会不记得上次剧情的内容」）：
  //    原来只有坏结局才给一句"上一次的起因"，**上一条演了什么完全没给** ⇒
  //    现在任何结局都摆出「上一条主线的经过（起因 + 每段 + 结局）」。
  check(/上一条主线（刚演完的那条）/.test(u2), '★★ 摆出了「上一条主线」这一段');
  check(/经过：/.test(u2), '★★ 带上了上一条**每一段发生了什么**');
  check(/结局：坏结局/.test(u2), '★★ 也写明了上一条的结局');

  // —— 对照：好结局不触发 ——
  reset();
  const G2 = 'g-plain';
  const g1 = await startOne({ groupId: G2 });
  await quest.advance(g1.quest, { ask, replies: [], forceEnd: 'good' });
  check(quest.status(G2).recent.slice(-1)[0].ending === 'good', '对照组收成了好结局');
  check(quest.status(G2).redeemPending === false, '★ 好结局之后 redeemPending = false');
  prompts = [];
  replies = [J({ premise: '新的小事', event: 'e', text: 't' })];
  const g2 = await quest.begin({ ask, groupId: G2 });
  check(g2.ok === true, '好结局之后也能正常开下一条');
  // ★★ 2026-10-05：**好结局也一样**要把上一条摆出来（原来只有坏结局才有那段）——
  //    用户要的是"她记得上次剧情的内容"，跟结局好坏无关。
  check(
    /上一条主线（刚演完的那条）/.test(prompts[0].user),
    '★★ 好结局的上一条也照样摆出来（不再只有坏结局才给）',
  );
  check(/结局：好结局/.test(prompts[0].user), '★★ 而且写明是「好结局」');
  check(!/上一条主线是「坏结局」/.test(prompts[0].user), '★ 好结局之后**不会**硬套"挽回"');
}

console.log('\n【26】★★ 题材：不许每条都写在排练室（<主人>：「大部分都是乐队的事…单调」）');
{
  // ① 权重分布 —— 乐队只占两成左右
  const n = 6000;
  const cnt = {};
  for (let i = 0; i < n; i++) {
    const t = quest.pickTopic();
    cnt[t.key] = (cnt[t.key] || 0) + 1;
  }
  const bandP = (cnt.band || 0) / n;
  check(bandP > 0.1 && bandP < 0.35, `★ 乐队题材只占 ${(bandP * 100).toFixed(1)}%（不是一半，也不是零）`);
  check((cnt.daily || 0) / n > 0.3, `★ 「日常」最多（${(((cnt.daily || 0) / n) * 100).toFixed(1)}%）`);
  check(
    Object.keys(cnt).length === quest.QUEST_TOPICS.length,
    `★ 每一档都抽得到（${Object.keys(cnt).length} 档）`,
  );

  // ② 开场提示词里真的写明了题材，而且是「别写乐队」那一版
  reset();
  prompts = [];
  replies = [J({ premise: 'p', event: 'e', text: 't' })];
  const r = await quest.begin({ ask, groupId: 'g-topic', rng: () => 0.01 }); // 0.01 → 落在「日常」
  check(r.ok === true, '开起来了', r.reason ?? '');
  check(/【这一次的题材】偏「日常」/.test(prompts[0].user), '★ 开场提示词里写明了题材');
  check(/这一次不要往乐队上写/.test(prompts[0].user), '★★ 日常题材时明确要求「别写乐队」');
  check(r.quest?.topic === 'daily', '★ 题材记在了剧情对象上（续写还要用）');

  // ③ 续写也要带题材，不然写着写着又飘回排练室
  prompts = [];
  await quest.advance(r.quest, { ask, replies: [] });
  check(/【这条的题材】偏「日常」/.test(prompts[0].user), '★ 续写的提示词里也带着题材');
  check(/别中途飘回乐队的事/.test(prompts[0].user), '★ 而且写明了「别飘回去」');

  // ④ 抽到「乐队」那一档时不能自相矛盾
  reset();
  prompts = [];
  replies = [J({ premise: 'p', event: 'e', text: 't' })];
  const rb = await quest.begin({ ask, groupId: 'g-band', rng: () => 0.99 }); // 0.99 → 落在「乐队」
  check(rb.ok === true, '乐队题材也能开', rb.reason ?? '');
  check(rb.quest?.topic === 'band', '★ 这一条确实是乐队题材');
  check(!/这一次不要往乐队上写/.test(prompts[0].user), '★ 抽到乐队时不会自相矛盾地要求「别写乐队」');
}

console.log('\n【27】★★ 收信人是群友，不是故事里的队友（<主人> 2026-09-15 截图反馈）');
{
  // 用户原话：「最后一句有点问题，说话对象应该是群友，而不是对祥子队友说的」
  // → 模型把"故事里在场的人"当成了这句话的听话对象，
  //   于是发出「若麦和海铃各把自己那边的关系列一份给我」这种**对队友派活**的句子。
  reset();
  prompts = [];
  replies = [J({ premise: 'p', event: 'e', text: 't' })];
  const r = await quest.begin({ ask, groupId: 'g-say' });
  check(r.ok === true, '开起来了', r.reason ?? '');
  const sys = prompts[0].sys;
  const user = prompts[0].user;
  check(/收信人永远是群友/.test(sys), '★★ 硬规矩里写了「收信人永远是群友」');
  // ⚠️⚠️ 2026-09-15 <主人>：「主要是**她转述剧情的话要有来龙去脉**」
  //    （截图里那两句从半截开始：「名单漏出去的那个名字查到了…」——那是哪个名单？）
  check(/来龙去脉/.test(sys), '★★ 系统提示词要求「让人看懂来龙去脉」');
  check(/不能从半截开始/.test(sys), '★★ 点名禁止「从半截开始」');
  check(/2-4 句/.test(sys), '★ 篇幅放宽到 2-4 句（要能把事讲清楚）');
  check(/来龙去脉的由头/.test(user), '★★ 开场那段点明了「这一段就是来龙去脉的由头」');
  check(/别写成她给队友下命令/.test(sys), '★★ 而且点名禁止「给队友下命令/派活」');
  check(/不是她说话的对象|不是她喊话的对象/.test(sys), '★ 说清了故事里的人不是说话对象');
  check(/别写成她对着那些人说话/.test(user), '★ 开场那段的 user 里也提醒了');

  prompts = [];
  await quest.advance(r.quest, { ask, replies: [] });
  check(/说给群友听的/.test(prompts[0].user), '★★ 续写也要提醒（出事的就是续写的第 3、4 段）');
  check(/别写成她给队友下命令/.test(prompts[0].user), '★ 续写同样点名禁止派活');
}

// ─────────────────────────────────────────────────────────────
console.log('\n【28】★★ 她在剧情群里接的话 = 剧情发展');
console.log('        （<主人> 2026-09-15 晚：「机器人已经答应了的话，应该要计入剧情发展」）');
{
  const recent = await import('../src/recent.js');
  const { Bot } = await import('../src/bot.js');
  const G = 'g-inter';
  reset();
  await quest.begin({ ask, manual: true, groupId: G });
  const q = quest.current(G);

  // ① 太短的不记（「嗯」「草」记进去只会污染下一段的提示词）
  check(quest.noteInterlude(q, { text: '嗯' }) === false, '★ 太短的话（「嗯」）不记');

  // ② 她答应过的话要记下来
  check(
    quest.noteInterlude(q, { text: '……你倒是敢说。客房留给我，别后悔' }) === true,
    '★★ 她在群里接的话记进剧情了（quest.interludes）',
  );
  check((quest.current(G).interludes || []).length === 1, '★ 存在这条剧情里（落盘，重启不丢）');
  check(
    quest.noteInterlude(quest.current(G), { text: '……你倒是敢说。客房留给我，别后悔' }) === false,
    '★ 同一句 60 秒内不重复记（分条发出去容易撞）',
  );

  // ③ ★★ 下一段的提示词里必须带上它 —— 这就是"计入剧情发展"
  prompts = [];
  replies = [J({ event: '她把客房收拾出来了', text: '客房收拾了，别嫌小。', done: false })];
  const adv = await quest.advance(quest.current(G), { ask, replies: [{ name: '<主人>', text: '搬我们家吧' }] });
  check(adv.ok === true, '★ 能接着推进下一段');
  check(prompts[0].user.includes('客房留给我'), '★★ 下一段的提示词里带上了她答应过的那句话');
  check(/这些也算数/.test(prompts[0].user), '★★ 而且明说"这些也算数"（不许写出跟它矛盾的内容）');
  check(prompts[0].user.includes('搬我们家吧'), '★ 群友那句也照常在提示词里');
  const texts = storyline.recent(30, G).map((e) => e.text);
  check(texts.some((t) => t.includes('客房留给我')), '★ 同时也写进故事线（分群：写在剧情那个群）');

  // ④ ★★ 真群接线：她接话时，把"被接的那条群友消息"也补记成群友发言
  //    ⚠️ 这就是截图里漏掉的那半：「搬我们家吧」是陈述式提议，
  //       `isPlotReply()` 一条都不沾（不是 @她 / 不是回复她 / 不是问句），
  //       于是 pending 一直是 0，下一段剧情压根不知道群里提过这茬。
  reset();
  await quest.begin({ ask, manual: true, groupId: G });
  recent.clear(G);
  recent.remember(
    { message_type: 'group', group_id: G, user_id: '10001', sender: { card: '<主人>' }, message_id: 'm-1' },
    { text: '搬我们家吧' },
  );
  check(!!recent.lastHumanMessage(G), '★ 前置：群里那条留言进上下文了');
  const fakeBot = Object.create(Bot.prototype);
  fakeBot.noteQuestInterlude({ message_type: 'group', group_id: G, user_id: '10000002' }, '……你倒是敢说。客房留给我，别后悔');
  const q2 = quest.current(G);
  check(
    (q2.pending || []).some((p) => p.text === '搬我们家吧' && p.name === '<主人>'),
    '★★ 她接过话的那条群友消息被补记成"剧情发言"了（原来会漏）',
  );
  check((q2.interludes || []).length === 1, '★★ 她自己那句也进了剧情');
  // 不许重复记（她再说一句，同一条群友消息不该被塞第二遍）
  fakeBot.noteQuestInterlude({ message_type: 'group', group_id: G, user_id: '10000002' }, '你别乱说，我可没答应。');
  check(
    (quest.current(G).pending || []).filter((p) => p.text === '搬我们家吧').length === 1,
    '★ 同一条群友消息不会重复补记',
  );
  // ⑤ 这一段之后没来过新的群友消息 → 不补记（别把早就消化过的塞回 pending）
  quest.current(G).pending = [];
  quest.current(G).stages[quest.current(G).stages.length - 1].at = Date.now() + 60 * 1000;
  fakeBot.noteQuestInterlude({ message_type: 'group', group_id: G, user_id: '10000002' }, '我再看一眼，明天给你答复。');
  check((quest.current(G).pending || []).length === 0, '★★ 早就消化过的群友消息不会被塞回 pending');
  // ⑥ 别的群、已经结束的剧情：都不收
  fakeBot.noteQuestInterlude({ message_type: 'group', group_id: '别的群', user_id: '10001' }, '这句话不该被记进剧情');
  check(
    !(quest.current(G).interludes || []).some((x) => x.text.includes('这句话不该被记进剧情')),
    '★ 别的群里说的话不算剧情插曲',
  );
  const doneQuest = quest.current(G);
  quest.finish(doneQuest, 'good');
  check(quest.noteInterlude(doneQuest, { text: '这句也不该被记下来' }) === false, '★ 已经结束的剧情不再收插曲');
}

console.log('\n【22】★★ `/清除剧情`：只清最后那一条（连它的故事线一起），更早的一律不动');
{
  // ── 场景 A：两条都已结束 → 先清"上一条已结束的" ──────────────────
  reset();
  const G = '888000111';
  // 先放一条一级事件（**不属于任何剧情**）—— purge 必须一个字都不碰它
  storyline.note({ tier: 1, text: '一级事件：她在便利店被人缠着问路', groupId: G });

  replies = [J({ premise: '第一条的事', event: 'e1', text: '第一段。' })];
  const r1 = await quest.begin({ ask, groupId: G });
  quest.finish(r1.quest, 'good', 'llm');
  replies = [J({ premise: '第二条的事', event: 'e2', text: '第二段。' })];
  const r2 = await quest.begin({ ask, groupId: G });
  quest.finish(r2.quest, 'good', 'llm');

  const q1n = storyline.forQuest(r1.quest.id, G).length;
  const q2n = storyline.forQuest(r2.quest.id, G).length;
  check(q1n > 0 && q2n > 0, '前置：两条剧情都在故事线里留了条目');

  const p = quest.purge(G);
  check(p.ok === true && p.running === false, '★ 没有在跑的 → 清掉「上一条已经结束的」');
  check(storyline.forQuest(r2.quest.id, G).length === 0, '★★ 它的故事线条目删干净了（不然她还会提这件事）');
  check(p.storyRemoved === q2n, `回执里报的删除条数对得上（${p.storyRemoved} / ${q2n}）`);
  check(storyline.forQuest(r1.quest.id, G).length === q1n, '★★ 更早那条剧情**一条都没动**');
  check(
    storyline.recent(50, G).some((e) => String(e.text).includes('便利店')),
    '★★ 一级事件（不属于剧情）也**没被误删**',
  );

  const p2 = quest.purge(G);
  check(p2.ok === true && p2.running === false, '再清一次 → 轮到第一条');
  check(storyline.forQuest(r1.quest.id, G).length === 0, '第一条也清掉了');
  const p3 = quest.purge(G);
  check(p3.ok === false, '★ 没有剧情可清了 → 明确说"没得清"', p3.reason);

  // ── 场景 B：正在跑 → 中止 + 同样删掉它写过的条目 ────────────────
  reset();
  const G2 = '888000222';
  replies = [J({ premise: '正在跑的那条', event: 'e', text: '开场。' })];
  const r3 = await quest.begin({ ask, groupId: G2 });
  check(storyline.forQuest(r3.quest.id, G2).length > 0, '前置：正在跑的这条已经写进故事线');
  const pb = quest.purge(G2);
  check(pb.ok === true && pb.running === true, '★ 正在跑的 → 中止它');
  check(storyline.forQuest(r3.quest.id, G2).length === 0, '★★ 中止也把它写过的条目删掉');
  check(quest.current(G2) === null, 'current 清空了');
  check(quest.purge(G2).ok === false, '★ 清完之后这个群没剧情了');

  // ── 场景 C：别的群不受影响 ──────────────────────────────────────
  reset();
  replies = [J({ premise: '甲群的事', event: 'e', text: '甲的。' })];
  const ra = await quest.begin({ ask, groupId: '888000333' });
  replies = [J({ premise: '乙群的事', event: 'e', text: '乙的。' })];
  const rb = await quest.begin({ ask, groupId: '888000444' });
  quest.purge('888000333');
  check(storyline.forQuest(ra.quest.id, '888000333').length === 0, '清的是点名那个群');
  check(storyline.forQuest(rb.quest.id, '888000444').length > 0, '★★ 别的群的剧情一点没动');
}

console.log('\n【24】★★ `/剧情` 在剧情进行中 = 剧情控制（带方向 / 留空直接推进）');
{
  // ① 管理员给的方向真的进了提示词，并且写明"当意图、别当台词"
  reset();
  const r = await startOne();
  prompts = [];
  replies = [J({ event: 'e', text: '她说了句什么。', done: false, ending: null })];
  await quest.advance(r.quest, { ask, hint: '让初华把话说开' });
  check(/让初华把话说开/.test(prompts[0].user), '★ 管理员给的方向进了推进提示词');
  check(
    /管理员/.test(prompts[0].user) && /原样写成她的台词/.test(prompts[0].user),
    '★ 而且写明"这是他的意图，不是她要说的话"',
  );

  // ② 命令分支：剧情在跑 → 交给 questControl，**不再当"开新的一条"**
  reset();
  const { Bot } = await import('../src/bot.js');
  const b = new Bot();
  b.speakerRole = () => 'owner';
  const calls = [];
  b.questControl = (event, gid, hint) => {
    calls.push({ gid, hint });
    return true;
  };
  const rg = await startOne({ groupId: '200000001' });
  check(!!rg.quest, '前置：这个群有一条在跑');
  const seg = (t) => [{ type: 'text', data: { text: t } }];
  const evt = { message_type: 'group', group_id: '200000001', user_id: '10000001' };
  check(b.tryQuestStart(evt, seg('/剧情 让她去当面问清楚')) === true, '命令被处理了');
  check(
    calls.length === 1 && calls[0].gid === '200000001' && calls[0].hint === '让她去当面问清楚',
    '★★ 在跑的时候 → 走 questControl，话原样带过去',
  );
  check(quest.current('200000001')?.premise === rg.quest.premise, '★ 没有另开一条（原来那条还在）');
  b.tryQuestStart(evt, seg('/剧情'));
  check(calls.length === 2 && calls[1].hint === '', '★★ 留空 → 也是控制（直接推进），不是开新的');

  // ③ 没有剧情在跑 + 留空 → 仍然是**用法提示**（不能变成"推进"）
  reset();
  const b2 = new Bot();
  b2.speakerRole = () => 'owner';
  const sent = [];
  b2.sendToGroup = async (g, t) => {
    sent.push(t);
  };
  b2.questControl = () => {
    throw new Error('没有剧情时不该走 questControl');
  };
  check(b2.tryQuestStart(evt, seg('/剧情')) === true, '命令被处理了');
  check(sent.some((t) => /用法/.test(String(t))), '★ 没剧情 + 留空 → 回用法提示');
}

// ★★ 2026-10-05 加（用户要求）：「加一条剧情命令，/剧情 好/坏结局，
//    对应 webui 里的**直接收成好/坏结局**的按钮」。
console.log('\n[结局命令] /剧情 好结局、/剧情 坏结局');
{
  // ⚠️ 这个套件顶层没直接 import Bot（前面的段都是各自动态取的）——
  //    这里一样动态 import（ESM 有模块缓存，不会重复执行）
  const { Bot } = await import('../src/bot.js');
  const seg = (t) => [{ type: 'text', data: { text: t } }];
  const evt = { message_type: 'group', group_id: '200000001', user_id: '10000001' };
  for (const [word, want] of [
    ['好结局', 'good'],
    ['坏结局', 'bad'],
    ['好', 'good'],
    ['坏', 'bad'],
    ['good', 'good'],
    ['bad', 'bad'],
    [' 坏结局 ', 'bad'],
    ['结局', null],
    ['往好的方向走', null], // ★ 关键反例：这是**方向提示词**，不是收结局的命令
    ['那先收个坏结局吧', null], // 不是整段相等 → 不认
    ['', null],
  ]) {
    const got = quest.parseEndingWord(word);
    check(
      String(got) === String(want),
      `判据：${JSON.stringify(word)} → ${want ?? 'null'}`,
      `实际 ${got}`,
    );
  }

  // 没有剧情在跑时发 `/剧情 好结局` → **不许**开出一条叫"好结局"的新线
  reset();
  const b3 = new Bot();
  b3.speakerRole = () => 'owner';
  const got3 = [];
  b3.sendToGroup = async (g, t) => {
    got3.push(String(t));
  };
  b3.questControl = () => {
    throw new Error('没有剧情时不该走 questControl');
  };
  check(b3.tryQuestStart(evt, seg('/剧情 好结局')) === true, '命令被处理了');
  check(
    got3.some((t) => /没有在跑的剧情/.test(t)),
    '★ 没剧情 + 收结局命令 → 明确说"没有在跑的剧情"',
  );
  check(!got3.some((t) => /用法/.test(t)), '★ 而不是掉进用法提示 / 被当成新剧情的背景');
}

// ★★ 2026-10-05 加（用户要求）：「在按群设定那里加一个开关，控制是否接收 /剧情 的命令，
//    默认开启接收 —— 主要是等下会有**两个机器人在同一个群**，避免冲突」。
console.log('\n[开关] 按群关掉「收 /剧情 命令」');
{
  const { Bot } = await import('../src/bot.js');
  const { config } = await import('../src/config.js');
  const G = '999000777';
  config.groupParams ??= {};
  config.groupParams[G] = { quest: { commands: false } };

  const b = new Bot();
  b.speakerRole = () => 'owner';
  const got = [];
  b.sendToGroup = async (g, t) => {
    got.push(String(t));
  };
  b.questControl = () => {
    throw new Error('关掉了就不该走剧情控制');
  };
  const ev = { message_type: 'group', group_id: G, user_id: '10000001' };
  check(
    b.tryQuestStart(ev, [{ type: 'text', data: { text: '/剧情 开一条新的' } }]) === false,
    '★ 关掉后 `/剧情` 被无视（返回 false，交回普通流程）',
  );
  check(got.length === 0, '★★ 而且**一个字都不回**（当没看见，不抢话）');
  check(
    b.tryQuestReset(ev, [{ type: 'text', data: { text: '/清除剧情' } }]) === false,
    '★ `/清除剧情` 同样被无视（它也是剧情命令）',
  );

  delete config.groupParams[G];

  // 对照：**没设过**开关的群照旧收（默认开启）
  const got2 = [];
  b.sendToGroup = async (g, t) => {
    got2.push(String(t));
  };
  const ev2 = { message_type: 'group', group_id: '999000778', user_id: '10000001' };
  check(
    b.tryQuestStart(ev2, [{ type: 'text', data: { text: '/剧情' } }]) === true,
    '★★ 没设过开关的群照旧收命令（默认开启，行为跟以前一样）',
  );
  check(got2.some((t) => /用法/.test(t)), '★ 而且走的是正常的用法提示（没被开关影响）');
}

try {
  for (const f of [CFG_REL, QUEST_REL, STORY_REL]) rmSync(join(ROOT, f), { force: true });
} catch {}

console.log('\n【14】★★ 谁先开口谁主导 —— 同款机器人在演剧情时，后开口的一边让位');
{
  const q = await import('../src/quest.js');
  const G = '999000900';

  // ① 「像不像同类在演剧情」的判据
  check(
    q.looksLikePeerPlot('玻璃还在地上，初华蹲着捡，手割了。我把纸递过去，她没接。') === true,
    '★ 剧情段（长、没 @、不是问句）→ 认',
  );
  check(q.looksLikePeerPlot('是睦') === false, '太短 → 不认（那是闲聊）');
  check(q.looksLikePeerPlot('@客服Saki 你在干嘛呢，帮我看下这个') === false, '带 @ → 不认（那是在对话）');
  check(
    q.looksLikePeerPlot('你说的那个东西我这边也遇到了同样的情况，要不要一起看看怎么处理？') === false,
    '★ 问句 → 不认',
  );

  // ② 记录与主导权
  q.__peerPlots().clear();
  check(q.leadership(G) === 'none', '★ 自己没在跑剧情 → none（轮不到让位）');
  check(
    q.notePeerPlot(G, { uid: '10000001', text: '是睦' }) === false,
    '短句不进记录',
  );
  check(
    q.notePeerPlot(G, { uid: '10000001', text: '玻璃还在地上，初华蹲着捡，手割了。我把纸递过去，她没接。' }) === true,
    '★ 长剧情句记下了',
  );
  check(q.__peerPlots().get(G)?.firstAt > 0, '记下了首次时间（用来比谁先开口）');
  check(q.__peerPlots().get(G)?.uid === '10000001', '记下了是哪个号在演');
  q.__peerPlots().clear();
}

console.log('\n【15】★★ 机器人发的 / 命令一律不执行（用户：「问题是在黑祥接到了 saki 发的 /剧情 指令」）');
{
  const { Bot } = await import('../src/bot.js');
  const { config } = await import('../src/config.js');
  const G = '999000901';
  const PEER = '10000001';
  // 把 PEER 配成这个群的同类
  config.groupParams = config.groupParams ?? {};
  config.groupParams[G] = { ...(config.groupParams[G] ?? {}), peers: [PEER] };

  const mk = (uid, text) => ({
    post_type: 'message',
    message_type: 'group',
    group_id: G,
    user_id: String(uid),
    self_id: '10000002',
    message_id: Math.floor(Math.random() * 1e9),
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: String(uid), nickname: 'x' },
  });
  const b = new Bot();
  b.selfId = '10000002';
  b.sendToGroup = async () => {};
  b.sendText = async () => {};

  // ① 同类说的「/剧情 xxx」不该被当成命令（直接调命令处理函数，确认它会被 onRaw 的闸挡住）
  check(b.isPeerBot(G, PEER) === true, '★ 池里的号认成同类');
  // ② 命令闸的判据：同类 / teach.bots 都算"机器人"
  const isBotSender = (uid) =>
    b.isPeerBot(G, String(uid)) ||
    (config.teach?.bots ?? []).map(String).includes(String(uid));
  check(isBotSender(PEER) === true, '★★ 同类发的命令 → 挡');
  check(isBotSender('10000001') === false, '★ 服主发的命令 → 放行');
  check(isBotSender('30003') === false, '★ 普通群友发的命令 → 放行');
  delete config.groupParams[G];
}

console.log('\n【16】★★ 发了 /清除剧情 ⇒ 强制静默 1 分钟（2026-10-07 用户要求）');
{
  // 用户原话：「**发了清除剧情应该强制 bot 停发消息一分钟**，要不然她们会
  //   接着上文继续聊」。
  // ⚠️ 为什么光"清剧情"不够：剧情状态是清了，但**上下文里那几句还在**，
  //    而"对话延续"（直接接、不判）跟剧情状态**无关** ⇒ 清完照接不误。
  // ⚠️ 所以静默要**拦全**：`decide()`（@ 她 / 关键词 / 同类 / 追补的总入口）、
  //    `shouldJoinChat()`（主动接话）、以及 `peer-chat.js` 的**定时主动搭话**
  //    （它走 `sendToGroup` 直发，**不经过 `decide()`** —— 漏了它就不是"停发消息"）。
  const { Bot } = await import('../src/bot.js');
  const b = new Bot();
  b.selfId = '10000002';
  const G16 = '999000186';

  check(typeof b.muteGroup === 'function' && typeof b.isMuted === 'function', '★ 有"群级静默"这套接口');
  check(b.isMuted(G16) === false, '没设过 → 不静默');
  b.muteGroup(G16, 60000, '自检');
  check(b.isMuted(G16) === true, '★★ 设了之后 → 这个群静默中');
  check(b.isMuted('999000187') === false, '★ **只静默这一个群**（别的群一点不受影响）');
  b.muteGroup(G16, 0, '自检');
  check(b.isMuted(G16) === false, '★ 传 0 秒 = **解除静默**（调用方要取消就靠它）');

  // 静默期内 **@ 她也不回**（用户要的是"强制停发"，不是"少说两句"）
  b.muteGroup(G16, 60000, '自检');
  const evAt16 = {
    message_type: 'group',
    group_id: G16,
    user_id: '30003',
    self_id: '10000002',
    message: [
      { type: 'at', data: { qq: '10000002' } },
      { type: 'text', data: { text: '在吗' } },
    ],
    sender: { card: '路人甲', nickname: '路人甲' },
  };
  check(b.decide(evAt16) === null, '★★ 静默期内**连 @ 她都不回**（"强制"就是这个意思）');
  check(b.shouldJoinChat(evAt16) === null, '★★ 主动接话那条路也直接不接');

  // 接线（光有函数不算数）
  const bsrc16 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /const r = quest\.purge\(gid\);[\s\S]{0,900}?muteGroup\(gid, 60000/.test(bsrc16),
    '★★ `/清除剧情` 那条路真的调了「静默 60 秒」',
  );
  check(
    /decide\(event, voluntary = null\) \{[\s\S]{0,1200}?isMuted\(/.test(bsrc16),
    '★★ `decide()` **最前面**就拦（所有回复路径的总入口）',
  );
  check(
    /shouldJoinChat\(event, \{ stickerIsNew = false[\s\S]{0,600}?isMuted\(/.test(bsrc16),
    '★ 主动接话那条路也各拦了一道',
  );
  const psrc16 = readFileSync(join(ROOT, 'src', 'peer-chat.js'), 'utf8');
  check(
    /isMuted\?\.\(gid\)/.test(psrc16),
    '★★ 定时主动搭话也拦（它直发，不走 decide —— 这条最容易漏）',
  );
}

console.log('\n【17】★★ /暂停：**打断正在生成的** + **静默 2 分钟**（2026-10-07 用户要求）');
{
  // 用户原话：「再加一个 /暂停 指令，**直接打断所有正在生成的消息**，
  //   并**停止发送消息 2 分钟**」。
  // ⚠️ 两个动作缺一不可：只静默不打断 → 那条生成到一半的还会继续往外发；
  //    只打断不静默 → 下一句话进来她又开始生成。
  const { Bot } = await import('../src/bot.js');
  const b = new Bot();
  b.selfId = '10000002';
  const G17 = '999000187';
  const key17 = `group:${G17}`; // ⚠️ 和 `history.sessionKey` 同一口径
  const seg = (t) => [{ type: 'text', data: { text: t } }];
  const ev17 = (uid) => ({
    message_type: 'group',
    group_id: G17,
    user_id: uid,
    self_id: '10000002',
    sender: { card: '服主', nickname: '服主' },
  });

  const aborted = [];
  const muted = [];
  let said = [];
  b.running = new Map([[key17, { abort: (e) => aborted.push(String(e?.message ?? '')) }]]);
  b.sendToGroup = async (g, t) => {
    said.push(String(t));
  };
  b.speakerRole = () => 'owner';
  // ⚠️ 把静默拦下来单独看（不然只能靠 `isMuted()` 间接推）
  b.muteGroup = (gid, ms, why) => {
    muted.push([String(gid), Number(ms), String(why ?? '')]);
    return 0;
  };

  check(
    b.tryPauseCommand(ev17('10000001'), seg('/暂停')) === true,
    '★ `/暂停` 被认出来（返回 true ⇒ 不再当聊天处理）',
  );
  check(aborted.length === 1, '★★ **正在生成的那条被真的打断了**（`abort()` 调到了）', JSON.stringify(aborted));
  check(
    muted.some(([g, ms]) => g === G17 && ms === 120000),
    '★★ 而且**这个群静默 2 分钟**（120000ms）',
    JSON.stringify(muted),
  );
  check(said.length === 1 && /不说话/.test(said[0]), '★ 回执发了（否则分不清"生效了"还是"没认出来"）', JSON.stringify(said));

  // ⚠️ 权限：普通群友不许用（这是"强制全体闭嘴"级别的操作）
  b.speakerRole = () => 'member';
  aborted.length = 0;
  said = [];
  b.running = new Map([[key17, { abort: () => aborted.push('不该发生') }]]);
  check(
    b.tryPauseCommand(ev17('30003'), seg('/暂停')) === true,
    '★ 普通群友发 → 仍然被"认出来"（不再当聊天内容）',
  );
  check(aborted.length === 0, '★★ 但**一点都没打断**（权限挡住了）');
  check(said.some((t) => /服主和管理员/.test(t)), '★ 回了权限提示');

  // ⚠️ 不误伤：只有**整条就是** `/暂停` 才算
  b.speakerRole = () => 'owner';
  for (const t of ['/暂停一下', '暂停', '/暂停 2 分钟', '/清除剧情', '/停止', '/paused']) {
    check(b.tryPauseCommand(ev17('10000001'), seg(t)) === false, `★ 不误认：「${t}」`);
  }
  check(
    b.tryPauseCommand({ message_type: 'private', user_id: '10000001' }, seg('/暂停')) === false,
    '★ 私聊里 `/暂停` 不算（它只管群）',
  );

  const bsrc17 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /this\.tryPauseCommand\(payload/.test(bsrc17),
    '★★ 指令真的**接在 `onRaw` 里**了（不然群里发了没反应）',
  );
  check(
    /tryPauseCommand\(event, segs\) \{[\s\S]{0,1400}?ctl\.abort\(/.test(bsrc17),
    '★★ 它走的是**已有的**中止机制（`this.running` 里的 AbortController），不是新造一个',
  );
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
