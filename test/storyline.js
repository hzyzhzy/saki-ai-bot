/**
 * 故事线（`src/storyline.js`）回归。
 *
 * ## 这个套件盯的是**唯一一条不许破的铁律**
 *
 * 用户原话：二级事件「**写进故事线之后不能被删除，只能最小限度精简**」。
 *
 * 所以核心不是"能不能压缩"，而是 —— **模型想删，代码必须拦得住**：
 *   · `tier:2` 一律 `locked`，调用方**传 locked:false 也解不开**
 *   · `compress()` 里锁定条目**少一条 → 整次作废、不写盘**
 *   · 锁定条目**只许变短**（模型想写长就按原样留着）
 *   · `pruneTier1()` 裁一级时**永远不碰锁定条目**
 *
 * ⚠️ 纯离线：假模型 + `QQBOT_STORYLINE_FILE` 指到 `logs/`，
 *    **不碰真实 `state/storyline.json`**。
 *
 * 用法: node test/storyline.js
 */
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-storyline.yml';
const STATE_REL = 'logs/__test-storyline-state.json';
const REAL_STATE = join(ROOT, 'state', 'storyline.json');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// ── 假模型：compress 走 collect(streamChat(...)) → **必须回 SSE** ──
// ⚠️ AGENTS 铁律①：先看请求是不是流式，再决定回 SSE 还是整块 JSON。
//    这里 streamChat 一定带 stream:true，所以回 SSE。
let nextReply = '';
const prompts = [];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let j = {};
    try {
      j = JSON.parse(body);
    } catch {}
    const sys = String(j?.messages?.[0]?.content ?? '');
    prompts.push({ sys, user: String(j?.messages?.[1]?.content ?? '') });

    if (j?.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 切成几段吐，模拟真实流式
      const txt = nextReply;
      const mid = Math.floor(txt.length / 2);
      for (const part of [txt.slice(0, mid), txt.slice(mid)]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: nextReply } }] }));
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
    'storyline:',
    '  enable: true',
    '  keepTier1: 20',
    '  compress:',
    '    enable: true',
    '    minIntervalMs: 3600000',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_STORYLINE_FILE = STATE_REL;

const sl = await import('../src/storyline.js');

const reset = () => {
  sl.__clear();
  try {
    rmSync(join(ROOT, STATE_REL), { force: true });
  } catch {}
};

// ─────────────────────────────────────────────────────────────
console.log('\n【1】二级条目一律锁定 —— 调用方解不开');
{
  reset();
  const a = sl.note({ tier: 1, text: '拼好饭被偷了，中午饿了一顿' });
  const b = sl.note({ tier: 2, text: '她为了找初华逃去了小岛，两个人一起离开了丰川宅' });
  check(a.locked === false, '一级：不锁');
  check(b.locked === true, '★ 二级：锁定');
  const c = sl.note({ tier: 2, text: '又一条主线', locked: false });
  check(c.locked === true, '★ 传 `locked:false` 也解不开（locked 由 tier 决定）');
}

console.log('\n【2】落盘 + 重载（掉线/重启不能断剧情）');
{
  const before = sl.status().total;
  sl.reload();
  check(sl.status().total === before, '· reload 后条数不变', `${before} → ${sl.status().total}`);
  check(
    sl.recent(50).some((e) => e.tier === 2 && e.locked),
    '★ 二级条目的 locked 从盘上读回来还是 true（没有被文件手改解锁）',
  );
}

console.log('\n【3】★★ 模型想弄丢锁定条目 → **整次作废、不写盘**');
{
  reset();
  sl.note({ tier: 1, text: '早餐吃了个饭团' });
  const keeper = sl.note({ tier: 2, text: '她在雨里宣布退队，然后在雨里嚎啕大哭' });
  for (let i = 0; i < 10; i++) sl.note({ tier: 1, text: `日常小事第 ${i} 条，无关紧要` });
  const beforeTotal = sl.status().total;
  const beforeTex = sl.recent(50).find((e) => e.id === keeper.id)?.text;

  // 假模型"忘掉"了那条锁定条目
  nextReply = JSON.stringify({ keep: [{ id: 1, text: '吃了个饭团' }], merge: [], drop: [] });
  const r = await sl.compress({ force: true });
  check(r.ok === false, '★ 压缩被拒（ok:false）', JSON.stringify(r));
  check(/锁定/.test(String(r.message)), '★ 理由说的是"弄丢锁定条目"', r.message);
  check(sl.status().total === beforeTotal, '★★ **一条都没删**（整次不写盘）', `${beforeTotal} → ${sl.status().total}`);
  check(
    sl.recent(50).find((e) => e.id === keeper.id)?.text === beforeTex,
    '★★ 那条主线原文一字未动',
  );
}

console.log('\n【4】★ 锁定条目混进 merge 里 → 也算弄丢，一样作废');
{
  reset();
  const k = sl.note({ tier: 2, text: '主线：她在宅邸外被若麦骂醒' });
  for (let i = 0; i < 10; i++) sl.note({ tier: 1, text: `琐事 ${i}` });
  nextReply = JSON.stringify({
    keep: [],
    merge: [{ ids: [k.id, 2], text: '把主线塞进合并里偷偷抹掉' }],
    drop: [],
  });
  // ⚠️ 合并里含锁定 id 是**允许**的写法（keepIds 检查会放行），
  //    所以真正的拦截点是后面"合并里不许掺锁定条目"那一步 —— 它会把这条 merge 丢掉，
  //    于是锁定条目最终不在结果里 → 兜底校验抓到 → 整次作废。
  const r = await sl.compress({ force: true });
  check(r.ok === false, '★ 仍然被拦住', JSON.stringify(r));
  check(
    sl.recent(50).some((e) => e.id === k.id && e.locked),
    '★★ 那条主线还在',
  );
}

console.log('\n【5】锁定条目**只许变短**（模型想写长就按原样留着）');
{
  reset();
  const k = sl.note({ tier: 2, text: '她冒雨去录音棚宣布退队，训了灯一顿，然后在雨里哭了很久。' });
  for (let i = 0; i < 10; i++) sl.note({ tier: 1, text: `琐事 ${i}` });
  const short = '她冒雨退队，在雨里哭了很久。';
  const longer = `她冒雨去录音棚宣布退队，训了灯一顿，然后在雨里嚎啕大哭，雨水混着眼泪，谁也看不出来。`;
  nextReply = JSON.stringify({
    keep: [{ id: k.id, text: longer }, { id: 2, text: '琐事' }],
    merge: [],
    drop: [],
  });
  const r = await sl.compress({ force: true });
  check(r.ok === true, '这次压缩通过', JSON.stringify(r));
  const got = sl.recent(50).find((e) => e.id === k.id);
  check(got?.text === k.text, '★ 模型写的更长 → 保留原文（没被"扩写"）');
  check(got?.text !== longer, '★ 不是模型那个加长版');

  // 再来一次：这次给个更短的，应该采纳
  reset();
  const k2 = sl.note({ tier: 2, text: '她冒雨去录音棚宣布退队，训了灯一顿，然后在雨里哭了很久。' });
  for (let i = 0; i < 10; i++) sl.note({ tier: 1, text: `琐事 ${i}` });
  nextReply = JSON.stringify({ keep: [{ id: k2.id, text: short }], merge: [], drop: [] });
  const r2 = await sl.compress({ force: true });
  check(r2.ok === true, '压缩通过', JSON.stringify(r2));
  check(
    sl.recent(50).find((e) => e.id === k2.id)?.text === short,
    '★ 更短的版本被采纳（这就是"最小限度精简"）',
  );
}

console.log('\n【6】★ 一级条目可以合并/删除（规矩只管二级）');
{
  reset();
  sl.note({ tier: 2, text: '主线：她接下了所有人的人生' });
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(sl.note({ tier: 1, text: `琐事 ${i}` }).id);
  nextReply = JSON.stringify({
    keep: [{ id: 1, text: '主线：她接下了所有人的人生' }],
    merge: [{ ids: ids.slice(0, 5), text: '那几天就是上课、打工、练琴，没什么特别的' }],
    drop: ids.slice(5),
  });
  const r = await sl.compress({ force: true });
  check(r.ok === true, '压缩通过', JSON.stringify(r));
  check(r.dropped === ids.slice(5).length, `一级删掉 ${r.dropped} 条`);
  check(
    sl.recent(50).some((e) => /没什么特别的/.test(e.text)),
    '一级合并出来的新条目在',
  );
  check(sl.status().locked === 1, '★ 锁定的那条还在', `locked=${sl.status().locked}`);
}

console.log('\n【7】★ 裁一级时永远不碰二级');
{
  reset();
  for (let i = 0; i < 5; i++) sl.note({ tier: 2, text: `主线第 ${i} 段：很重要的剧情` });
  for (let i = 0; i < 60; i++) sl.note({ tier: 1, text: `日常 ${i}` });
  const st = sl.status();
  check(st.locked === 5, '★ 5 条主线一条没少', `locked=${st.locked}`);
  check(st.total <= 5 + st.keepTier1 + 1, `一级被裁到上限内（总 ${st.total}）`);
  check(st.lastPruned > 0, `确实裁了一级的（${st.lastPruned} 条）`);
}

console.log('\n【8】提示词 / 落盘位置 / 边界');
{
  reset();
  sl.note({ tier: 1, text: '中午的拼好饭被偷了' });
  const block = sl.promptBlock(10);
  check(/拼好饭被偷/.test(block), 'promptBlock 带上了内容');
  check(sl.promptBlock(10) !== '', '非空');
  check(sl.note({ tier: 1, text: '   ' }) === null, '空白文本被拒');
  check(sl.note({}) === null, '空对象被拒');
  check(sl.forQuest('') .length === 0, 'forQuest("") 返回空数组不炸');

  check(
    join(ROOT, STATE_REL) !== REAL_STATE && !String(REAL_STATE).includes('__test'),
    '用的是测试状态文件，不是真实的',
  );
  check(existsSync(join(ROOT, STATE_REL)), '测试状态确实写盘了（说明落盘路径通了）');
}

console.log('\n【9】★ compress 提示词里必须写死"锁定条目不许删"');
{
  check(/不许删|一条都不许删/.test(sl.COMPRESS_PROMPT), '提示词里有这条铁律');
  check(/keep.*必须包含每一个锁定条目/s.test(sl.COMPRESS_PROMPT), '提示词要求 keep 里含全部锁定 id');
  check(Array.isArray(prompts) && prompts.length > 0, `确实调过模型（${prompts.length} 次）`);
  check(
    prompts.some((p) => /锁定/.test(p.user)),
    '★ 喂给模型的故事线里标了哪些是锁定的',
  );
}

console.log('\n【10】★ 压缩成"轻小说章节"：**一章 = 一件事**，日期由代码加（模型编的不算）');
{
  reset();
  const k = sl.note({ tier: 2, text: '主线：她在雨里宣布退队' });
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(sl.note({ tier: 1, text: `琐事 ${i}` }).id);
  const ats = sl.recent(50).filter((e) => !e.locked).map((e) => e.at);
  nextReply = JSON.stringify({
    keep: [{ id: k.id, text: k.text }],
    chapters: [
      { ids: ids.slice(0, 4), title: '拼好饭被偷了', text: '中午的饭被人拎走了，她饿了一下午。' },
      // ⚠️ 想把锁定条目偷偷并进章节 → 整章必须被丢（不许绕过铁律）
      { ids: [k.id, ids[4]], title: '偷塞主线', text: '想把她那条主线吞掉' },
    ],
    drop: ids.slice(8),
  });
  const r = await sl.compress({ force: true });
  check(r.ok === true, '压缩通过', JSON.stringify(r));
  check(r.chapters === 1, '★ 只成了 1 章（掺了锁定 id 的那章被丢掉）', `chapters=${r.chapters}`);

  const today = `${new Date().getMonth() + 1}月${new Date().getDate()}日`;
  const ch = sl.recent(50).find((e) => /拼好饭被偷了/.test(e.text));
  check(!!ch, '★ 章节写进了故事线');
  check(
    String(ch?.text) === `【${today} · 拼好饭被偷了】中午的饭被人拎走了，她饿了一下午。`,
    '★★ 标题 = 【真实日期 · 标题】（日期是代码按条目时间拼的，不是模型写的）',
    String(ch?.text),
  );
  check(ch?.tier === 1 && ch?.locked === false, '章节是普通条目（不是锁定的）');
  check(
    Number(ch?.at) === Math.min(...ats.slice(0, 4)),
    '★ 章节的时间 = 它覆盖的最早那条的时间（谁也没编）',
  );
  check(!sl.recent(50).some((e) => /琐事 0/.test(e.text)), '被并进章节的 4 条不再单条出现');
  check(!sl.recent(50).some((e) => /琐事 8/.test(e.text)), 'drop 点名的被删了');
  check(
    sl.recent(50).some((e) => /琐事 4/.test(e.text)),
    '★★ 模型**没提到**的普通条目按原文留着（漏一条 ≠ 抹掉一条）',
  );
  check(
    sl.recent(50).some((e) => e.id === k.id && e.locked && /退队/.test(e.text)),
    '★★ 锁定条目还在原地（没被吸进章节、也没被改写）',
  );
  check(!/想把她那条主线吞掉/.test(JSON.stringify(sl.recent(50))), '那章"偷塞主线"一个字都没落下');
}

console.log('\n【11】★ 提示词：章节体的规矩都写死了');
{
  check(/一章 = 一件事/.test(sl.COMPRESS_PROMPT), '「一章 = 一件事」写进了提示词');
  check(
    /可以补/.test(sl.COMPRESS_PROMPT),
    '★ 允许为观感补"合理的连接"（2026-09-17 用户放宽：缺东西影响观感就可以补）',
  );
  check(
    /一个字都不许补/.test(sl.COMPRESS_PROMPT),
    '★★ 但**锁定条目一个字都不许补**（主线只许变短 —— 补料会污染骨架）',
  );
  check(
    /不许凭空加/.test(sl.COMPRESS_PROMPT),
    '★ 补的边界写死了：不许改已成事实、不许加新事件 / 新人物 / 新结局',
  );
  check(
    /正文里不要写日期/.test(sl.COMPRESS_PROMPT),
    '★★ 禁止模型自己写日期（日期由代码加 —— 这就是"日期不许编"的落地）',
  );
  check(/chapters/.test(sl.COMPRESS_PROMPT), '输出格式里给了 chapters');
  check(
    /时间=/.test(prompts.at(-1)?.user ?? ''),
    '★ 喂给模型的条目**带上了时间**（不然它认不出同一件事、也写不出章节）',
  );
  check(
    /日式轻小说/.test(sl.COMPRESS_PROMPT),
    '★ 要求日式轻小说的文风（用户：「不要压得像小学生作文」）',
  );
  check(/不要只罗列群友的发言/.test(sl.COMPRESS_PROMPT), '★ 不许「某某连发几条」式报菜名');
  check(
    /能让她的回答更准 \/ 更像吗/.test(sl.COMPRESS_PROMPT),
    '★★ 给了"该删还是该留"的判据（用户原话：能让她的回答更准 / 更像吗）',
  );
  check(
    /不许自己编新台词/.test(sl.COMPRESS_PROMPT),
    '对话只许写原有的（编出来的台词会被当成她真说过）',
  );
}

console.log('\n【12】★★ JSON 容错：裸换行 / 围栏 / 客套话，都要能解析');
{
  // ① 字符串里**裸换行** —— 模型写长正文时最爱犯的错（JSON 不允许）
  const rawNl =
    '{\n' +
    '  "keep": [],\n' +
    '  "chapters": [\n' +
    '    { "ids": [1, 2], "title": "标题", "text": "第一行\n第二行\n第三行" }\n' +
    '  ],\n' +
    '  "drop": []\n' +
    '}';
  let stdOk = true;
  try {
    JSON.parse(rawNl);
  } catch {
    stdOk = false;
  }
  check(stdOk === false, '（前置）这份用标准 JSON.parse 是**解不开**的');
  const a = sl.parseJson(rawNl);
  check(!!a, '★ 裸换行的 JSON 被救回来了');
  const esc = String(a?.chapters?.[0]?.text ?? '');
  check(/第二行/.test(esc), '★ 三行正文一个字没丢');
  check(esc.split('\n').length === 3, '★ 换行还在（被转义保留，不是被吃掉）', JSON.stringify(esc));

  // ② 围栏 + 前后客套话（模型的老毛病）
  const wrapped =
    '好的，我整理好了：\n```json\n{ "keep": [{ "id": 3, "text": "x" }], "chapters": [], "drop": [] }\n```\n希望有帮助！';
  check(sl.parseJson(wrapped)?.keep?.[0]?.id === 3, '★ 围栏 + 前后客套话也抠得出来');

  // ③ 真坏了就返回 null（不许返回半个对象骗人）
  check(sl.parseJson('这根本不是 JSON') === null, '★ 完全不是 JSON → null（不抛异常）');
  check(sl.parseJson('') === null, '★ 空串 → null');
  check(sl.parseJson('{"keep": [}') === null, '★ 坏掉的 JSON → null');
}

// ─────────────────────────────────────────────────────────────
console.log('\n【★】★★ 分群：A 群的条目绝不许串到 B 群（<主人>：「知识库调用时一定要分清」）');
{
  const A = '200000001';
  const B = '200000002';
  sl.__clear();

  sl.note({ groupId: A, tier: 1, text: 'A 群的日常：拼好饭被偷了', tags: ['外卖'] });
  sl.note({ groupId: B, tier: 1, text: 'B 群的日常：末班车没赶上', tags: ['通勤'] });
  sl.note({ groupId: A, tier: 2, text: 'A 群的主线：她接下了所有人的人生' });

  // ① 读：各读各的
  check(sl.recent(50, A).length === 2 && sl.recent(50, B).length === 1, '★ 两个群各读各的');
  check(
    !sl.recent(50, A).some((e) => /末班车/.test(e.text)),
    '★★ A 群读不到 B 群的条目',
  );
  check(
    !sl.recent(50, B).some((e) => /拼好饭/.test(e.text)),
    '★★ B 群读不到 A 群的条目',
  );
  check(/拼好饭/.test(sl.promptBlock(10, A)) && !/末班车/.test(sl.promptBlock(10, A)), '★★ 喂给模型的块也不串');
  check(!/拼好饭/.test(sl.promptBlock(10, B)), '★★ B 群的块里没有 A 群的事');
  check(sl.promptBlock(10, '999999') === '', '★ 没故事的群给空串（不炸）');

  // ② 编号是**各群各算的**（每桶自己的 nextId）——同一群内部唯一就行
  const aIds = sl.recent(50, A).map((e) => e.id);
  const bIds = sl.recent(50, B).map((e) => e.id);
  check(new Set(aIds).size === aIds.length, `★ A 群内部 id 唯一（${aIds}）`);
  check(new Set(bIds).size === bIds.length, `★ B 群内部 id 唯一（${bIds}）`);
  check(
    sl.forQuest('', A).length === 0 && sl.forQuest('不存在的剧情').length === 0,
    '★ forQuest 查不到就返回空数组（不炸）',
  );

  // ③ 锁定铁律**每个群各自成立**
  check(sl.status(A).locked === 1 && sl.status(B).locked === 0, '★ 锁定条数按群各算');
  const ka = sl.recent(50, A).find((e) => e.locked);
  // 让 A 群可以压（凑够条数）
  for (let i = 0; i < 10; i++) sl.note({ groupId: A, tier: 1, text: `A 群琐事 ${i}` });
  for (let i = 0; i < 10; i++) sl.note({ groupId: B, tier: 1, text: `B 群琐事 ${i}` });

  // ④ 压缩只动自己那个群
  const bBefore = sl.recent(50, B).map((e) => `${e.id}:${e.text}`).join('|');
  const rb = await sl.compress({ groupId: B, force: true });
  check(rb.ok === true, 'B 群能压', rb.message ?? '');
  check(
    sl.recent(50, A).map((e) => e.id).includes(ka.id),
    '★★ 压 B 群时 **A 群的锁定条目一条没动**',
  );
  check(
    sl.recent(50, A).some((e) => /A 群琐事 0/.test(e.text)),
    '★★ 压 B 群**完全没碰 A 群的条目**',
  );
  check(!sl.recent(50, B).some((e) => /A 群/.test(e.text)), '★ B 群压完还是只有 B 群的东西（没有 A 群的）');
  check(bBefore.length > 0, '（B 群压前有内容）');

  // ⑤ 汇总视图
  const all = sl.status();
  check(all.byGroup.length === 2, `★ status() 汇总列出两个群（${all.byGroup.length}）`);
  check(
    all.byGroup.find((g) => g.groupId === A)?.locked === 1,
    '★ 汇总里 A 群的锁定数也对',
  );
  check(sl.groups().includes(A) && sl.groups().includes(B), '★ groups() 认得这两个群');
}

try {
  server.close();
  rmSync(join(ROOT, CFG_REL), { force: true });
  rmSync(join(ROOT, STATE_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
