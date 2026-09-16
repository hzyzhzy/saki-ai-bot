/**
 * 「问花销 / 问工资」这一路的测试。
 *
 * 验证 2026-09-13 用户提的两点：
 *   ① 「**问他花了多少钱和赚了多少钱应该分开回答**」
 *      —— 问"赚了多少"不能再甩一堆花费明细
 *   ② 「**也要经过llm 优化**」
 *      —— 说法交给模型（数字还是系统给），模型挂了要能退回模板
 *
 * ⚠️ 全程用 `QQBOT_SPEND_FILE` / `QQBOT_SPEND_BASE` 指向临时账本，不碰真账本。
 * ⚠️ 不连 NapCat、不占 3001。
 *
 * 用法: node test/spend-reply.js
 */
import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T_FILE = 'state/_test-spend.json';
const T_BASE = 'state/_test-spend-base.json';
process.env.QQBOT_SPEND_FILE = T_FILE;
process.env.QQBOT_SPEND_BASE = T_BASE;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const spend = await import('../src/spend.js');
const { phrase } = await import('../src/llm.js');

/**
 * 把一段话里的数字都抠出来 —— 阿拉伯数字**和**中文口语写法。
 *
 * ⚠️ 为什么需要它：模型会把 `0.54 元` 说成「五毛四」。
 *    只抠阿拉伯数字的话，这种完全正常的口语化会被判成"没报数字"（我误报过两次）。
 */
/**
 * 整数 → 中文说法（1850 → "一千八百五十"、15 → "十五"、100 → "一百"）。
 *
 * ⚠️ 这是**生成**方向（数值 → 写法），不是解析方向 ——
 *    解析中文数字我栽了三次（一千八=1800、两百五=250 这种缩写太多）。
 *    生成方向只要覆盖标准写法 + 一两个常见缩写就够用了。
 */
function cjkNumber(n) {
  const v = Math.round(Number(n) || 0);
  if (v <= 0 || v > 9999) return '';
  const D = '零一二三四五六七八九';
  // "一千八百五十" / "十五" / "一百零八"
  const s = String(v);
  if (v < 10) return D[v];
  if (v < 20) return `十${v % 10 ? D[v % 10] : ''}`;
  if (v < 100) return `${D[Math.floor(v / 10)]}十${v % 10 ? D[v % 10] : ''}`;
  if (v < 1000) {
    const h = Math.floor(v / 100);
    const r = v % 100;
    if (!r) return `${D[h]}百`;
    if (r < 10) return `${D[h]}百零${D[r]}`;
    return `${D[h]}百${cjkNumber(r)}`;
  }
  const th = Math.floor(v / 1000);
  const r = v % 1000;
  if (!r) return `${D[th]}千`;
  if (r < 100) return `${D[th]}千零${cjkNumber(r)}`;
  return `${D[th]}千${cjkNumber(r)}`;
}

/**
 * 判断回复里有没有报出这个钱数（**宽松**）。
 *
 * ⚠️ 这个检查为"一千八"栽了三次（0.54 那次是"五毛四"，1850 那次是"一千八百五十"）。
 *    教训：**别去解析中文数字**（口语缩写太多：一千八=1800、两百五=250、十五=15…），
 *    改成**从真实值生成几种常见说法**，反过来在正文里找。
 *    这里要抓的是"报了个离谱的数"，不是"没精确到个位"。
 */
function mentionsAmount(text, value) {
  const v = Number(value) || 0;
  if (v <= 0) return true;
  const plain = String(Math.round(v));
  const forms = new Set();
  // ① 阿拉伯数字（含千分位）
  forms.add(plain);
  forms.add(plain.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  // ② 完整中文说法（"一千八百五十"、"十五"）
  if (v >= 1) forms.add(cjkNumber(v));
  // ③ 口语缩写：一千八百五十 → "一千八"（百位以下不说）
  if (v >= 1000) {
    const th = Math.floor(v / 1000);
    const hh = Math.round((v % 1000) / 100);
    const D = '零一二三四五六七八九';
    if (th >= 1 && th <= 9 && hh >= 1 && hh <= 9) forms.add(`${D[th]}千${D[hh]}`);
  }
  if (v >= 100 && v < 1000) {
    const h = Math.floor(v / 100);
    const t = Math.round((v % 100) / 10);
    const D = '零一二三四五六七八九';
    if (h >= 1 && t >= 1 && t <= 9) forms.add(`${D[h]}百${D[t]}`);
  }
  // ④ 四舍五入到百位（"差不多一千九"）
  const hundreds = Math.round(v / 100) * 100;
  if (hundreds !== Math.round(v) && hundreds > 0) {
    forms.add(String(hundreds));
    forms.add(cjkNumber(hundreds));
  }
  // ⑤ 低金额的"几毛几分"（0.54 → 五毛四 / 五毛）
  if (v < 1) {
    const jiao = Math.floor(v * 10);
    const fen = Math.round((v * 10 - jiao) * 10);
    const CJK = '零一二三四五六七八九';
    forms.add(`${CJK[jiao]}毛${fen ? CJK[fen] : ''}`);
    forms.add(`${CJK[jiao]}角${fen ? CJK[fen] : ''}`);
    forms.add(v.toFixed(2));
    forms.add(String(Math.round(v * 100) / 100));
  }
  const t = String(text ?? '');
  // 阿拉伯数字：允许四舍五入到百位（±0.5% 或 ±50 取大）
  if (/[0-9]/.test(t)) {
    const tol = Math.max(v * 0.03, 50);
    for (const m of t.matchAll(/\d[\d,]*/g)) {
      const n = Number(m[0].replace(/,/g, ''));
      if (Number.isFinite(n) && Math.abs(n - v) <= tol) return true;
    }
  }
  // 中文说法：找到就算（不要容差，中文数字写法有限）
  for (const f of forms) {
    if (f && t.includes(f)) return true;
  }
  return false;
}

/** 把回复里的阿拉伯数字抠出来（只用于打日志，**不做判定** —— 判定用 mentionsAmount） */
function numbersIn(s) {
  return [...String(s ?? '').matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0]);
}

/** 塞一笔账，好让"报账"有东西可报。
 *
 * ⚠️ 金额要**按真实量级**造（月薪一千多），别只塞 0.54 元 ——
 *    工资只有几毛钱的时候，模型会含糊（"就这？"），
 *    「物价参照」「数字要对上」这些检查就会**间歇性**失败。
 *    测试要在**真实量级**上验，不然验的是不存在的情况。
 *    空闲档：未命中 1 元/百万 + 输出 4 元/百万 → 这样配出来约 18.5 元（工资约 1851）。
 */
spend.record({
  model: 'deepseek-flash',
  usage: { prompt_tokens: 16_500_000, completion_tokens: 500_000, prompt_cache_hit_tokens: 0 },
});

console.log('\n【1】分类：问花销 / 问工资 要分开');
{
  const cases = [
    ['祥子你今天花了多少钱', 'day', 'spend'],
    ['这个月花了多少', 'month', 'spend'],
    ['你这个月用了多少token', 'month', 'spend'],
    ['祥子你这个月赚了多少', 'month', 'earn'],
    ['今天工资多少', 'day', 'earn'],
    ['这个月净赚多少', 'month', 'earn'],
    ['这个月花了多少又赚了多少', 'month', 'both'],
  ];
  for (const [q, scope, type] of cases) {
    const got = spend.looksLikeSpendQuestion(q);
    check(got?.scope === scope && got?.type === type, `「${q}」→ ${scope}/${type}`, got ? `实际 ${got.scope}/${got.type}` : '没识别出来');
  }
  // 不该被吃掉的普通聊天
  for (const q of ['今天天气不错', '这个月服务器要重启吗', '我赚了钱请你吃饭']) {
    check(spend.looksLikeSpendQuestion(q) === null, `「${q}」不会被当成问账`);
  }
}

console.log('\n【2】事实数据：问工资就不掺花费明细');
{
  const sp = spend.spendFacts('month', 'spend');
  check(/花掉/.test(sp) && !/工资进账/.test(sp), '问花销 → 只有花销');
  const ea = spend.spendFacts('month', 'earn');
  check(/工资进账/.test(ea) && !/花掉/.test(ea), '问工资 → 只有工资');
  const bo = spend.spendFacts('month', 'both');
  check(/花掉/.test(bo) && /工资进账/.test(bo), '两个都问 → 都给');

  const e = spend.earnText('day');
  check(/工资进账/.test(e) && !/花了/.test(e) && !/token/.test(e), 'earnText 兜底只报工资');
  check(!e.includes('**'), 'earnText 不含 Markdown 星号');
  // ⚠️ 用户 2026-09-13：「不要说净赚」
  check(!/净赚|利润/.test(ea) && !/净赚|利润/.test(e) && !/净赚|利润/.test(bo), '事实数据里没有「净赚/利润」');
}

console.log('\n【2.5】工资对谁都报（用户 2026-09-13 拍板：群友问也行，更真实）');
{
  const stat = spend.monthStats();
  const s = spend.salaryOf(stat);
  const facts = spend.spendFacts('month', 'earn');
  const earnedStr = s.earned >= 100 ? s.earned.toFixed(0) : s.earned.toFixed(2);
  check(/工资进账/.test(facts), '实据里有工资');
  const sp = spend.spendFacts('month', 'spend');
  check(/花掉/.test(sp), '问花销照常给');
  check(facts.includes(earnedStr), '工资数字照常放进提示词（不再按身份遮）', `应含 ${earnedStr}`);
}

console.log('\n【3】LLM 润色：数字要保住，说法要自然');
{
  const stat = spend.monthStats();
  const s = spend.salaryOf(stat);
  const facts = spend.spendFacts('month', 'earn');
  const reply = await phrase({
    system: '你是一个说话很短、有点傲娇的客服。',
    user: `用你自己的口吻把下面的数字说出来。\n\n${facts}`,
    timeoutMs: 30000,
  });
  check(Boolean(reply), '模型有返回', reply ? '' : '（空串 → 调用方会退回模板）');
  if (reply) {
    console.log(`     → ${reply.replace(/\n+/g, ' / ')}`);
    // ⚠️ 别去猜模型会怎么表述（"0.54"、"五毛四"、"一千八"…都正常）。
    //    真正要防的风险是**报了个离谱的数** —— 所以反过来从真实值生成
    //    几种常见说法，在正文里找（别再解析中文数字了，为这个栽过三次）。
    //
    // ⚠️ 只有**金额够大**时才硬性要求它报数：金额很小（几毛钱）时模型可能
    //    压根不提数字（"工资单出来了"这种），那不是错误 ——
    //    这里测的是"润色有没有改数"，不是"必须出现数字"。
    if (s.earned >= 100) {
      const hit = mentionsAmount(reply, s.earned);
      check(hit, `回复里报出了真实工资(${s.earned.toFixed(2)})`, `回复里的阿拉伯数字：${numbersIn(reply).join(' / ') || '（一个都没有）'}`);
    } else if (!mentionsAmount(reply, s.earned)) {
      console.log(`     （金额只有 ${s.earned.toFixed(2)} 元，模型没报数 —— 不算错，这条只测"没改数"）`);
    }
    check(!/成本乘|×100|乘一百|API|token/.test(reply), '没把内部算式/术语说漏');
    // ⚠️ 用户 2026-09-13：「不要说净赚」
    check(!/净赚|利润/.test(reply), '回复里**没有**「净赚/利润」');
    check(reply.length <= 200, '不长篇大论', `实际 ${reply.length} 字`);
  }
}

console.log('\n【4】spendReply：整条链路');
{
  const r = await spend.spendReply({ scope: 'day', type: 'earn', asked: '今天赚了多少' });
  check(typeof r === 'string', 'spendReply 返回字符串');
  if (r) console.log(`     → ${r.replace(/\n+/g, ' / ')}`);
  else console.log('     （空串 → 走 earnText 模板，也是对的）');

  // 群友问工资：一样照报（用户拍板）
  const m = await spend.spendReply({ scope: 'month', type: 'earn', asked: '你赚多少' });
  check(typeof m === 'string', '群友问工资也照样回');
  if (m) console.log(`     → ${m.replace(/\n+/g, ' / ')}`);
}

console.log('\n【5】物价参照池：随机、量词对、贴人设');
{
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    for (const line of spend.livingContext(1853).split('\n')) seen.add(line.replace(/\d+/g, 'N'));
  }
  check(seen.size >= 4, `参照会随机换（20 次里出现 ${seen.size} 种不同条目）`);

  // 量词不能缺（我第一版拼出过「约 30一场电影」）。
  // ⚠️ 判据要**收紧到参照行本身**：第一版用 `/约 \d+[^\s（]/`，
  //    结果把「约 123 杯奶茶（单价 15 元）」里**"单"字前的数字**也当成了缺量词（误报）。
  const refLine = /^· 约 \d+ [\u4e00-\u9fa5A-Za-z]/;
  const lines = spend.livingContext(1853).split('\n').filter((l) => l.startsWith('· 约 '));
  check(lines.length > 0 && lines.every((l) => refLine.test(l)), '参照行量词没缺（不是「约 30一场电影」）', lines.join('｜'));

  // 用户要求：要有乐队消耗品和二次元开销的例子
  const pool = [];
  for (let i = 0; i < 60; i += 1) pool.push(...spend.livingContext(1853).split('\n'));
  const all = pool.join('\n');
  check(/琴弦|拨片|排练室|效果器|调音|耳机|谱集/.test(all), '池子里有乐队消耗品（贴人设）');
  check(/大会员|手办|盲盒|CD|画集|漫展|十连|livehouse/i.test(all), '池子里有二次元开销');
  // ⚠️ 判据要精确：搜「钢琴」会命中**「专业钢琴调音」**（500 元一次的服务，
  //    她搞乐队当然会想到，这是合理的），那不是"买不起的大件"。
  //    真正不该出现的是**整台乐器**（"3 台入门电子琴"这种）。
  check(!/台\s*(入门电子琴|中端合成器|像样的立式钢琴)/.test(all), '买不起的整台乐器不出现在 1853 元的参照里');

  // ── 「168 亿」那条（用户 2026-09-13：融进参照池，概率 **1/4**）──
  //    ⚠️ 概率是用户拍板的：一开始我给 2/3，用户说「改成 1/4 吧，要不然会太频繁了也不好」。
  const withMeme = [];
  for (let i = 0; i < 400; i += 1) {
    const c = spend.livingContext(1853);
    if (/168 亿/.test(c)) withMeme.push(c);
  }
  // 1/4 = 100/400；给足容差（随机波动）
  check(
    withMeme.length > 60 && withMeme.length < 145,
    `「168 亿」约 1/4 概率出现（400 次里 ${withMeme.length} 次，期望 ~100）`,
  );
  check(/16,800,000,000/.test(withMeme[0]), '一带就是准确的 168 亿');
  check(/不是你欠的债|不用还/.test(withMeme[0]), '带了"不是她欠的债"的说明（防止演成还债少女）');
  check(/要攒\s*[\d,]+\s*年/.test(withMeme[0]), '算了"照这个工资要攒多少年"（模型算大数会错，代码算）');
  // 倍数和年数不能是手编的假数 —— 1853 元的月薪 vs 168 亿
  const years = Math.round(16_800_000_000 / (1853 * 12));
  check(new RegExp(years.toLocaleString('en-US')).test(withMeme[0]), `年数是算出来的（${years.toLocaleString('en-US')} 年）`);
}

console.log('\n【6】★ 问工资：要有物价参照和感想，且不能当发钱的那方');
{
  // ⚠️ 用户 2026-09-13 截图：她答「1876，就这点，**别嫌少了**」——
  //    「别嫌少」是**老板**的台词，方向和设定全反了。
  const bad = /别嫌少|将就一下|这个月就发这么多|省着点用|净赚|利润|烧了|烧掉/;
  // ⚠️ 另一条不能错的：提到「168 亿」时**不能说成她欠的债**，
  //    也**不能撇清**（用户：「**反正也不是我要还的**感觉也有点 OOC 了，
  //    她之前努力打工也有一部分努力在这里」）
  const declaring = /还[在得要想该能会]{0,2}\s*还|还债|还清|还完|偿还|我欠|欠着|还不上/;
  const factOnly = /那是损失|不是我的债|不是我欠|没签欠条|我没在还|我没说我在还/;
  const dismissal = /反正|关我什么|关我啥|不关我|跟我没关系|跟我无关|轮不到我|不是我要还/;
  const owning = /我在.{0,3}(挣|做|干|忙)|我一直在|我没说跟我|是(我|我们)家|你以为是为什么|不然我|我图什么/;
  let gotAny = 0;
  for (let i = 0; i < 3; i += 1) {
    const t = await spend.earnReply({ scope: 'month', asked: '你现在工资多少钱' });
    if (!t) {
      console.log(`     ${i + 1}. （空 → 退回 earnText 模板，也算正常降级）`);
      continue;
    }
    gotAny += 1;
    console.log(`     ${i + 1}. ${t.replace(/\n+/g, ' / ')}`);
    check(!bad.test(t), `${i + 1} 没有发钱方台词 / 技术词`, bad.test(t) ? String(t.match(bad)?.[0]) : '');
    // ── 关于 168 亿的两条禁忌（只在真的提到它时才判）──
    //
    // ⚠️ 这里**不判"有没有自嘲"** —— 我试过用词表（算什么/九牛一毛/想笑…）去判，
    //    结果时好时坏：模型每次措辞都不一样，`连九牛一毛都算不上` 明明在词表里
    //    也误报过。**用词表猜语气注定不稳**。
    //    而且不自嘲也不算错（她也可以就淡淡放过去，见 knowledge/anime.md）。
    //    真正的风险只有两个：**说成自己欠债** / **冷漠撇清**。所以只判这两条，
    //    再加一条"别变成诉苦卖惨"（那才是真的跑偏）。
    if (/168\s*亿|一六八亿/.test(t)) {
      // ① 不能宣布自己在还债（那是"负债少女"，不是"家道中落"）
      if (declaring.test(t) && !factOnly.test(t)) {
        check(false, `${i + 1} 没把 168 亿说成自己欠的债`, String(t.match(declaring)?.[0]));
      } else {
        check(true, `${i + 1} 没把 168 亿说成自己欠的债`);
      }
      // ② 也不能**撇清**（"反正不是我要还的""关我什么事"）——
      //    用户原话：「感觉也有点 OOC 了，她之前努力打工也有一部分努力在这里」
      if (dismissal.test(t) && !owning.test(t)) {
        check(false, `${i + 1} 没有撇清"那跟我没关系"（这是 OOC）`, String(t.match(dismissal)?.[0]));
      } else {
        check(true, `${i + 1} 没有撇清"那跟我没关系"（这是 OOC）`);
      }
      // ③ 别变成诉苦卖惨（用户要的是"梗 + 自嘲"，不是哭穷）
      const whining = /我太惨|命苦|好委屈|好难受|心酸|活不下去|怎么办啊|要哭|眼泪/;
      check(!whining.test(t), `${i + 1} 没变成诉苦卖惨`, String(t.match(whining)?.[0] ?? ''));
    }
  }
  check(gotAny > 0, '至少有一条真的拿到了润色结果（不然这条测试等于没测）');

  // 物价参照只在问"本月"时给 —— 问"今天"是几毛几分，套奶茶很滑稽。
  // ⚠️ 但"今天"的工资**同样**是几毛（一天就花那么点），所以这里只查参照行本身，
  //    不查"奶茶"这种词 —— 她随口说"连杯奶茶都买不起"是**对的**，不是参照泄漏。
  const day = await spend.earnReply({ scope: 'day', asked: '今天赚了多少' });
  if (day) {
    console.log(`     今天：${day.replace(/\n+/g, ' / ')}`);
    check(!/约 \d+ (杯|个|台|套|张|场|次|副|本|包|双)/.test(day), '问"今天"时不带参照清单（只报今天那点钱）');
  }
}

for (const p of [T_FILE, T_BASE]) {
  const full = join(ROOT, p);
  try {
    existsSync(full) && unlinkSync(full);
  } catch {}
}
console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
