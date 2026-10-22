#!/usr/bin/env node
/**
 * 人设包**必做项自检**（2026-10-22 加）
 *
 * ## 为什么要有它
 *   用户定的「新建人设必做清单」有五条（见 `personas/README.md`），
 *   但清单只是**文字**，建的时候很容易漏 —— 实测爱音就漏了 `life-events.md`，
 *   她的日常事件哑了好几天才发现 ✗
 *   而 `prompt/bili-comment.md`（B站那边用的那份）漏了**更隐蔽**：
 *   代码会**静默回落到内置的祥子那份** ⇒ B站上说话的变成祥子，没人看得出来 ✗
 *
 * ⇒ 这个脚本把五条变成**能跑的数字**，建完/改完跑一次就知道缺什么。
 *
 * ## 用法
 *   node tools/persona-check.mjs            # 查当前账号的人设
 *   node tools/persona-check.mjs anon       # 查指定人设包
 *
 * 退出码：0 = 全过（可以有 warning）；1 = 有必做项缺失
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd().includes('qq-ai-bot')
  ? process.cwd()
  : 'C:\\Users\\<主人>\\OneDrive - yijia\\文档\\ds1\\qq-ai-bot';
const PERSONAS = join(ROOT, 'personas');

let id = process.argv[2];
if (!id) {
  try {
    const { personaId } = await import('../src/config.js');
    id = personaId();
  } catch {
    id = 'saki';
  }
}

const dir = join(PERSONAS, id);
if (!existsSync(dir)) {
  console.error(`❌ 没有这个人设包：personas/${id}`);
  const all = readdirSync(PERSONAS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name);
  console.error(`   现有的：${all.join(' / ')}`);
  process.exit(1);
}

const fails = [];
const warns = [];
const oks = [];

const read = (p) => {
  try { return readFileSync(join(dir, p), 'utf8'); } catch { return ''; }
};
/** 中文字数（按字符数算，不算空白） */
const chars = (s) => String(s).replace(/\s/g, '').length;

console.log(`\n检查人设包：personas/${id}\n` + '─'.repeat(50));

/* ── ① persona.md ─────────────────────────────── */
const persona = read('persona.md');
if (!persona.trim()) {
  fails.push('① persona.md 不存在或为空（说话方式 / 你是谁 / 性格的根 都在里面）');
} else {
  const n = chars(persona);
  oks.push(`① persona.md ${n.toLocaleString()} 字`);
  // 说话方式那一节在不在
  if (!/说话的方式|怎么说话|说话方式/.test(persona)) {
    warns.push('① persona.md 里没找到「说话的方式」那一节 —— 三五个独有句式/她的词/反面例子都该在这儿');
  }
  if (n > 60000) warns.push(`① persona.md ${n} 字，偏长（它整篇进提示词，每次请求都算钱）`);
}

/* ── ② cast.md ────────────────────────────────── */
const cast = read('cast.md');
if (!cast.trim()) {
  fails.push('② cast.md 不存在或为空（人物关系名册：关系怎么走的 / 两边称呼 / 名场面）');
} else {
  oks.push(`② cast.md ${chars(cast).toLocaleString()} 字`);
}

/* ── ③ life-events.md（分段 + 条数）─────────────── */
const life = read('life-events.md');
if (!life.trim()) {
  fails.push('③ life-events.md 不存在或为空（日常事件库 —— 漏了它，日常事件是哑的）');
} else {
  const lines = life.split(/\r?\n/);
  let seg = null;
  const segs = [];
  for (const ln of lines) {
    const m = ln.match(/^###\s+(.+)$/);
    if (m) { seg = { name: m[1].trim(), n: 0 }; segs.push(seg); continue; }
    if (seg && /^\s*[-*]\s+\S/.test(ln)) seg.n += 1;
  }
  const total = segs.reduce((a, b) => a + b.n, 0);
  oks.push(`③ life-events.md ${segs.length} 段 / 共 ${total} 条事件`);
  const thin = segs.filter((s) => s.n < 12);
  if (!segs.length) fails.push('③ life-events.md 里没有 `### 时段名 07:00-09:00` 这种分段');
  else if (thin.length) {
    fails.push(`③ 这些时段不足 12 条：${thin.map((s) => `${s.name}(${s.n})`).join('、')}`);
  }
  if (total < 90) fails.push(`③ 全篇只有 ${total} 条事件，要求 ≥90 条`);
}

/* ── ④ identity.json ──────────────────────────── */
let identity = null;
try { identity = JSON.parse(read('identity.json')); } catch { /* 下面报 */ }
if (!identity) {
  fails.push('④ identity.json 不存在或不是合法 JSON');
} else {
  const miss = ['name', 'selfName'].filter((k) => !String(identity[k] || '').trim());
  if (miss.length) fails.push(`④ identity.json 缺字段：${miss.join('、')}`);
  else oks.push(`④ identity.json ok（${identity.name} / 自称 ${identity.selfName}）`);
  // ⚠️ 值里出现裸 ASCII 双引号会破坏 JSON（踩过三次）—— 能 parse 就说明没踩
}

/* ── ⑤ prompt/bili-comment.md（B站那边用的）────── */
const bc = read('prompt/bili-comment.md');
if (!bc.trim()) {
  fails.push('⑤ prompt/bili-comment.md 不存在 —— B站评论/主动评论会**回落到内置的祥子那份**'
    + '（等于 B站上说话的不是这个角色）。照 `personas/_template/prompt/bili-comment.md` 填一份');
} else {
  const n = chars(bc);
  oks.push(`⑤ prompt/bili-comment.md ${n} 字`);
  if (n > 1500) warns.push(`⑤ bili-comment.md ${n} 字，超过 1500 —— 它要跟一句 8~30 字的评论一起进提示词，太长会淹掉`);
  // 该有的几块（只查关键词，不查文笔）
  const need = [
    [/你是谁|怎么说话|怎么说/, '「你是谁、怎么说」'],
    [/活人|具体的|细节/, '「活人的地方 / 具体细节」'],
    [/梗/, '「玩梗的规矩」'],
    [/机器人味|别打句号|语气词/, '「机器人味禁令」'],
    [/检验|过一遍/, '「活人感自检」'],
  ];
  const miss = need.filter(([re]) => !re.test(bc)).map(([, name]) => name);
  if (miss.length) warns.push(`⑤ bili-comment.md 里没看到这几块：${miss.join('、')}`);
  // 模板里的占位符没删 = 没填
  if (/〈[^〉]{0,30}〉/.test(bc)) fails.push('⑤ bili-comment.md 里还留着 `〈占位符〉` —— 那份还没真填');
  if (/<!--/.test(bc)) warns.push('⑤ bili-comment.md 里还有 HTML 注释（会被一起注入提示词，填完请删掉）');
}

/* ── 输出 ─────────────────────────────────────── */
for (const s of oks) console.log(`  ✅ ${s}`);
for (const s of warns) console.log(`  ⚠️  ${s}`);
for (const s of fails) console.log(`  ❌ ${s}`);
console.log('─'.repeat(50));
console.log(fails.length
  ? `结果：${fails.length} 项必做没做 ❌（${warns.length} 条提醒）`
  : `结果：必做项全部齐了 ✅${warns.length ? `（${warns.length} 条提醒）` : ''}`);
process.exit(fails.length ? 1 : 0);
