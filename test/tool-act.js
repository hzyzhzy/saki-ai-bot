/**
 * 工具化第三、四批：`记住` / `忘掉` / `提醒` / `引用`
 *
 * ⚠️ 这个套件**只测纯判据**，不去真写知识库、不真定提醒 ——
 *    因为那两样都是"真动数据"，测完留垃圾、还会污染用户的 `knowledge/` 和 `state/remind.json`。
 *    真链路由 `teach.js` / `teach-undo.js` / `remind.js` / `quote.js` 那几套照旧盯着 ✓
 *
 * 盯的三件事（都是"判错就出事"的地方）：
 *   ① `factGrounded()` —— **防她瞎记**：她要记的内容必须在他**自己说过的话**里有据可依；
 *   ② `parseToolWhen()` —— 时间**只认固定格式**（`08:00` / `明天 08:00` / `+30分钟`），
 *      算不出就返回 0（**绝不许替人猜"应该是明天早上"**）；
 *   ③ `pickQuoteTarget()` —— 她指定了"引用谁"就按名字挑，**不再花那次模型调用**。
 */
import assert from 'node:assert';
import { Bot } from '../src/bot.js';
import { parseToolCalls } from '../src/bot.js';
// ⚠️ 2026-10-19：备选模型降档的纯函数（见文件末尾那几条断言）
import { lowTiersOf } from '../src/bot.js';

let pass = 0;
let fail = 0;
const bad = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    bad.push(`${name} —— ${e.message}`);
    console.log(`  ❌ ${name} —— ${e.message}`);
  }
}

const bot = new Bot();

// ── ① 防瞎记：内容必须在他自己说过的话里有据 ──
console.log('\n【1】记住 —— 只记他自己说过的（防瞎记）');

check('原样照抄他说的 ⇒ 算有据', () => {
  assert.equal(
    bot.factGrounded('服务器地址是 mc.example.com', '服务器地址是 mc.example.com 端口也没改'),
    true,
  );
});

check('合理改写（同义但字面接近）⇒ 算有据', () => {
  assert.equal(bot.factGrounded('服务器地址是 mc.example.com', '对了 服务器地址是 mc.example.com'), true);
});

check('他自己说过大半、她补了一点点 ⇒ 算有据', () => {
  assert.equal(
    bot.factGrounded('这个服务器地址是 mc.example.com，端口 25565', '服务器地址是 mc.example.com'),
    true,
  );
});

check('凭空编一整段 ⇒ 判没依据', () => {
  assert.equal(
    bot.factGrounded('服务器已经改成正版验证了，白名单也关了', '服务器地址是 mc.example.com'),
    false,
  );
});

check('短内容走整串包含判据', () => {
  assert.equal(bot.factGrounded('正版', '现在服务器是正版验证'), true);
  assert.equal(bot.factGrounded('盗版', '现在服务器是正版验证'), false);
});

check('空内容 / 空依据 ⇒ 一律没依据', () => {
  assert.equal(bot.factGrounded('', '随便什么'), false);
  assert.equal(bot.factGrounded('随便什么', ''), false);
});

// ── ② 时间只认固定格式，算不出返回 0 ──
console.log('\n【2】提醒 —— 时间只认固定格式，绝不替人猜');

// 用一个固定的"现在"：2026-10-18 02:30（周六）
const NOW = new Date(2026, 9, 18, 2, 30, 0, 0).getTime();
const fmt = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

check('「08:00」今天还没到 ⇒ 就是今天 08:00', () => {
  assert.equal(fmt(bot.parseToolWhen('08:00', NOW)), '2026-10-18 08:00');
});

check('「00:10」今天已经过了 ⇒ 推到明天 00:10', () => {
  assert.equal(fmt(bot.parseToolWhen('00:10', NOW)), '2026-10-19 00:10');
});

check('「明天 08:00」⇒ 明天', () => {
  assert.equal(fmt(bot.parseToolWhen('明天 08:00', NOW)), '2026-10-19 08:00');
});

check('「后天 8点」⇒ 后天（认「点」这个说法）', () => {
  assert.equal(fmt(bot.parseToolWhen('后天 8点', NOW)), '2026-10-20 08:00');
});

check('「2026-10-20 08:00」绝对时间照写', () => {
  assert.equal(fmt(bot.parseToolWhen('2026-10-20 08:00', NOW)), '2026-10-20 08:00');
});

check('「+30分钟」相对时间', () => {
  assert.equal(fmt(bot.parseToolWhen('+30分钟', NOW)), '2026-10-18 03:00');
});

check('「30分钟后」也认', () => {
  assert.equal(fmt(bot.parseToolWhen('30分钟后', NOW)), '2026-10-18 03:00');
});

check('「+2小时」', () => {
  assert.equal(fmt(bot.parseToolWhen('+2小时', NOW)), '2026-10-18 04:30');
});

check('⚠️ 说"晚点/有空"这种算不出 ⇒ 必须返回 0（不许猜）', () => {
  assert.equal(bot.parseToolWhen('晚点', NOW), 0);
  assert.equal(bot.parseToolWhen('有空的时候', NOW), 0);
  assert.equal(bot.parseToolWhen('', NOW), 0);
});

check('⚠️ 已经过去很久的绝对时间 ⇒ 也返回 0（别定一条发不出来的）', () => {
  assert.equal(bot.parseToolWhen('2020-01-01 00:00', NOW), 0);
});

// ── ③ 白名单认得这四个新工具 ──
console.log('\n【3】暗号解析 —— 四个新工具都在白名单里');

check('记住 / 忘掉 / 提醒 / 引用 都解析得出来', () => {
  const r = parseToolCalls(
    '[工具:记住 {"主题":"服务器","内容":"地址是 mc.example.com"}]\n' +
      '[工具:忘掉]\n' +
      '[工具:提醒 {"何时":"明天 08:00","说什么":"交作业"}]\n' +
      '[工具:引用 {"引用谁":"张三"}]',
  );
  assert.deepEqual(
    r.map((x) => x.name),
    ['记住', '忘掉', '提醒', '引用'],
  );
  assert.equal(r[0].args.主题, '服务器');
  assert.equal(r[2].args.何时, '明天 08:00');
  assert.equal(r[3].args.引用谁, '张三');
});

check('参数写成坏的 JSON ⇒ 不崩，args 空对象', () => {
  const r = parseToolCalls('[工具:记住 {主题:服务器}]');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].args, {});
});

check('不在白名单的名字照旧不认', () => {
  assert.equal(parseToolCalls('[工具:发说说 {"内容":"x"}]').length, 0);
});

// ── ④ 引用：她点名了谁，就按名字挑，不再花模型调用 ──
console.log('\n【4】引用 —— 她说引谁就引谁（省掉那次模型判定）');

const cands = [
  { messageId: 'm1', name: '张三', userId: '101', text: '服务器你怎么配的' },
  { messageId: 'm2', name: '李四', userId: '102', text: '我也想知道' },
  { messageId: 'm3', name: '张三', userId: '101', text: '喂喂' },
];

check('点名「李四」⇒ 引李四那条', () => {
  assert.equal(bot.pickQuoteByWant(cands, '李四', 'm9'), 'm2');
});

check('点名「张三」⇒ 引他**最近**那条（一串里挑串尾，答的是最新一句）', () => {
  assert.equal(bot.pickQuoteByWant(cands, '张三', 'm9'), 'm3');
});

check('点名的名字不在候选里 ⇒ 退回当前这条', () => {
  assert.equal(bot.pickQuoteByWant(cands, '王五', 'm9'), 'm9');
});

check('直接给 QQ 号也行', () => {
  assert.equal(bot.pickQuoteByWant(cands, '101', 'm9'), 'm3');
});

check('她没说引谁 ⇒ 不走这条（返回空串，让原来的判定接手）', () => {
  assert.equal(bot.pickQuoteByWant(cands, '', 'm9'), '');
});

// ⚠️ 2026-10-19 加（用户：「**失败之后先自动改成同类的低等级模型吧，比如 2.5flash，
//    再用主模型**」）——
//    `lowTiersOf()` 是"备选模型挂了先降档"的依据。
//    ⚠️ 实测（拿真 key 打 Gemini）：`3.5-flash` 200、`3.5-flash-lite` 200、
//       `2.5-flash` / `2.5-flash-lite` 都是 404「no longer available to new users」✗
//       ⇒ 候选**必须 lite 打头**，跨代那个只是兜底（别的服务商可能有效）
check('降档候选：同代 lite 排第一（实测那个才真能用）', () => {
  const l = lowTiersOf('models/gemini-3.5-flash');
  assert.equal(l[0], 'models/gemini-3.5-flash-lite');
  assert.ok(l.includes('models/gemini-2.5-flash'), '跨代那档也要留着当兜底');
});
check('降档候选：不带 models/ 前缀也一样', () => {
  assert.equal(lowTiersOf('gemini-3.5-flash')[0], 'gemini-3.5-flash-lite');
});
check('降档候选：本来就是 lite ⇒ 只往低代降', () => {
  const l = lowTiersOf('models/gemini-3.5-flash-lite');
  assert.ok(l.includes('models/gemini-2.5-flash-lite'));
  assert.ok(!l.includes('models/gemini-3.5-flash-lite-lite'), '不许加两层 lite');
});
check('降档候选：推不出来（没有版本号 / 名字不认识）⇒ 空数组，别瞎猜', () => {
  assert.deepEqual(lowTiersOf('deepseek-flash'), []);
  assert.deepEqual(lowTiersOf(''), []);
});

console.log('');
if (fail) {
  console.log(`❌ tool-act 套件：${fail} 项失败`);
  for (const b of bad) console.log(`   · ${b}`);
  console.log(`结果: ${fail} 项失败`);
  process.exitCode = 1;
} else {
  console.log('结果: 全部通过 ✅');
}
