/**
 * 验证「发图是默认动作」这条新规则**有没有用**。
 *
 * 做法：拿 21:22 那份**真实快照**（152764 字，当时不会自发调），
 * 再把新加的那一节拼到末尾，同一句话各跑 3 次，比"调不调"。
 *
 * ⚠️ 只有这一处差异，模型/工具/温度全一样。
 */
import fs from 'node:fs';
import { buildTools } from '../src/tools-fc.js';
import { config } from '../src/config.js';

const p = config.provider?.llm ?? config.llm ?? {};
const base = (p.baseURL ?? 'https://api.deepseek.com/v1').replace(/\/$/, '');
const key = p.apiKey ?? '';
const model = p.model ?? 'deepseek-flash';
const tools = buildTools({});

const snap = fs.readFileSync(new URL('../logs/_prompt-group200000007.last.txt', import.meta.url), 'utf8');
// 把 persona.md 里新加的那一节抠出来
const persona = fs.readFileSync(new URL('../personas/saki/persona.md', import.meta.url), 'utf8');
const a = persona.indexOf('## 🖼️ 表情（默认带一个');
const b = persona.indexOf('## ✍️ 打字的手癖');
const addon = a >= 0 && b > a ? persona.slice(a, b) : '(没抠到，检查 persona.md)';
console.log(`快照 ${snap.length} 字 + 新增 ${addon.length} 字\n`);

const TEXT = '哈哈哈哈哈笑死我了';

async function run(sys) {
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: TEXT },
      ],
      tools,
      tool_choice: 'auto',
      max_tokens: 300,
      stream: false,
    }),
    signal: AbortSignal.timeout(150000),
  });
  const j = await r.json();
  if (j.error) return { err: JSON.stringify(j.error).slice(0, 120) };
  const m = j.choices?.[0]?.message ?? {};
  return {
    calls: (m.tool_calls ?? []).map((c) => c.function?.name),
    content: String(m.content ?? '').slice(0, 34),
  };
}

/* ⚠️ 第二种放法：**放到最开头的身份描述里**（用户：「要在开头的人设描述加，
 *   比如你是一个喜欢发表情的人…发表情需要调用工具发」）——
 *   开头是"我是谁"，跟中段的"规则"权重完全不同，得单独测。 */
const HEAD =
  '你是个很爱发表情的人：情绪一上来就想甩张图，表情常常比文字先到。' +
  '发表情不是写字，是**调 `send_sticker` 工具**把它发出去（`哪个` 填你想表达的情绪，比如"笑到不行"）。\n\n';

for (const [label, sys] of [
  ['旧快照（对照）', snap],
  ['开头插身份句', HEAD + snap],
  ['末尾插规则节', snap + '\n\n' + addon],
]) {
  const marks = [];
  for (let i = 0; i < 3; i++) {
    const r = await run(sys);
    if (r.err) {
      marks.push('✗');
      console.log(`  ${label} 第${i + 1}次 出错：${r.err}`);
      continue;
    }
    marks.push(r.calls.includes('send_sticker') ? '🔧' : '·');
  }
  console.log(`${label.padEnd(18)} ${marks.join(' ')}  （🔧=调了表情工具）`);
}
