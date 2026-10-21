/**
 * 让**模型**挑群聊记录（不是关键词快判）
 *
 * 用户 2026-10-21：「聊天记录现在有点不对题目了，要重新选一下」
 * ⇒ 视频是「自我介绍」，所以画面里的群聊应该撑得起那 8 句台词说的东西：
 *   在 MC 服务器群里待着 / 帮人查东西写东西 / 群里什么人都有 / 声音像不像 /
 *   大肥鱼是 DeepSeek Harness / 群里的日常
 *
 * 为什么交给模型：判断"这段聊天跟那句话对不对得上"是**理解人话**，
 * 关键词快判换个说法就漏（AGENTS 铁律）✗
 *
 * 用法：
 *   node tools/pick-chat.mjs                                  # 默认 200000001 群、挑 ~140 条
 *   node tools/pick-chat.mjs --group 200000001 --want 140
 *   node tools/pick-chat.mjs --lines logs/bili/intro_lines.json
 * 输出：logs/bili/chat_picked.json（{ keep: [下标...] }，下标对应 filterMessages 的结果）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { filterMessages, cleanText, keyOf } from './lib/chat-filter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const say = (s) => console.log(`[chat] ${s}`);

const GROUP = arg('group', '200000001');
// ⚠️ 别贪多：38 秒的视频里塞 140 条 ⇒ 每 0.27 秒蹦一条，比真人群快得多，看着假 ✗
//    模型挑出多少就用多少（实测 80~90 条 ⇒ 0.45 秒一条，接近真人节奏）
const WANT = Number(arg('want', '90'));
const MIN_KEEP = Number(arg('min', '60'));
const LINES = resolve(arg('lines', join(ROOT, 'logs', 'bili', 'intro_lines.json')));
const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', 'chat_picked.json')));

const cfg = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) || {};
const llm = cfg.llm || {};
if (!llm.apiKey || !llm.baseURL) { say('❌ config.yml 里没有 llm.apiKey / llm.baseURL'); process.exit(2); }

const rj = JSON.parse(readFileSync(join(ROOT, 'state', 'recent.json'), 'utf8'));
const all = (rj.groups || {})[GROUP] || [];
if (!all.length) { say(`❌ 群 ${GROUP} 没有记录`); process.exit(2); }

const cand = filterMessages(all);
say(`候选 ${cand.length} 条（原 ${all.length} 条，已剔除政治/辱骂/外链/纯图片）`);

const lines = JSON.parse(readFileSync(LINES, 'utf8'))
  .map((x) => (typeof x === 'string' ? x : String(x.text || '').trim()));

const listing = cand
  .map((m, i) => `${i}\t${m.self ? '[她自己]' : ''}${cleanText(m).slice(0, 60)}`)
  .join('\n');

const sys = `你在帮一条 B 站短视频挑"背景里滚动的群聊记录"。
这条视频是一个 AI 角色在自我介绍，说的内容就是下面这些台词。
画面里滚动的群聊要和台词**对得上**：观众一边听她说"我在一个 MC 服务器群里待着、
平时帮人查东西写东西"，一边看到的群聊就该是那类内容。

挑选标准：
0. **最重要：优先「和她有关」的** —— 标了 [她自己] 的是她本人发的，一定要优先收；
   别人**提到 Saki / 小祥 / bot / 客服 / live2d / 视频**的也要收；
   实在不够再补和她说话前后衔接的几句。观众看背景聊天时，应该感觉**群里在聊她**，而不是随便一堆技术讨论 ✗
1. **贴合台词主题**：MC/服务器/游戏/插件/模组、找人帮忙办事、写东西、
   群里闲聊斗嘴、声音/AI/模型相关、日常杂事 —— 这些优先
2. 剔除**没有信息量的碎话**：单个表情符号、纯标点、「啊」「嗯」「哦」这种、
   重复刷屏、纯复读别人的话
3. 剔除**看不懂在说什么**的（上下文全靠猜的）
4. 剔除**吵架骂人**的、涉及真人隐私的
5. 保持原顺序（不要打乱时间线）
6. 只要最多 ${WANT} 条，宁少勿凑数

只输出 JSON，不要解释：
{"keep":[按原顺序的编号...],"reason":"一句话说明你怎么挑的"}`;

const userPrompt = `【台词】
${lines.map((t, i) => `L${i} ${t}`).join('\n')}

【候选群聊】（编号\t内容）
${listing}`;

say('正在让模型挑…');
let keep = null;
try {
  const res = await fetch(`${String(llm.baseURL).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: userPrompt }],
      temperature: 0.3,
      max_tokens: 4000,
      thinking: { type: 'disabled' }, // 思考型模型会把 max_tokens 吃光（2026-10-20 踩过）
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${bodyText.slice(0, 300)}`);
  const j = JSON.parse(bodyText);
  const raw = j?.choices?.[0]?.message?.content ?? '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型没给 JSON：' + raw.slice(0, 200));
  const parsed = JSON.parse(m[0]);
  keep = (parsed.keep || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < cand.length);
  say(`模型理由：${parsed.reason || '（没给）'}`);
} catch (e) {
  say('❌ 模型挑选失败：' + e.message);
  process.exit(3);
}

// 去重 + 保序
const seen = new Set();
keep = keep.filter((n) => (seen.has(n) ? false : seen.add(n)));
if (!keep.length) { say('❌ 模型没挑出任何消息'); process.exit(3); }

// 太少才按原顺序补齐（补的是候选里没被挑中的，仍然保持时间线）
if (keep.length < MIN_KEEP) {
  say(`⚠️ 只挑了 ${keep.length} 条，从候选里按顺序补齐到 ${MIN_KEEP}`);
  const set = new Set(keep);
  for (let i = 0; i < cand.length && keep.length < MIN_KEEP; i++) if (!set.has(i)) { keep.push(i); set.add(i); }
  keep.sort((a, b) => a - b);
}

// ⚠️ 存**指纹**不存下标：候选窗口会随群消息滑动，下标会错位（2026-10-21 真事故）
writeFileSync(OUT, JSON.stringify({
  group: GROUP, at: new Date().toISOString(),
  draftedBy: 'tools/pick-chat.mjs（草稿，agent 必须自己复核/改写）',
  candidateCount: cand.length, count: keep.length,
  keys: keep.map((i) => keyOf(cand[i])),
}, null, 2), 'utf8');
say(`✅ ${OUT}`);
say(`   挑中 ${keep.length}/${cand.length} 条`);
say('   前 12 条：' + keep.slice(0, 12).map((i) => `#${i} ${cleanText(cand[i]).slice(0, 18)}`).join(' | '));
