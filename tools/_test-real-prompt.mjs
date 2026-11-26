// 临时实测：用**真实 system 提示词**（47,864 字）看 4B 会不会调工具（跑完删）
import { readFileSync } from 'node:fs';
import { buildTools } from '../src/tools-fc.js';

const sys = readFileSync('logs/_prompt-group200000007.last.txt', 'utf8');
const tools = buildTools({});
console.log(`system ${sys.length} 字 | 工具 ${tools.length} 个\n`);

const cases = [
  '只发一个表情包，不打字',
  '能不能闭嘴',
];

for (const text of cases) {
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:18085/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3.5-4b',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `<主人>：${text}` },
      ],
      tools,
      max_tokens: 1024,
      stream: false,
    }),
    signal: AbortSignal.timeout(300000),
  });
  const j = await r.json();
  const m = j.choices?.[0]?.message ?? {};
  const tc = m.tool_calls ?? null;
  const think = String(m.reasoning_content ?? '');
  const u = j.usage ?? {};
  console.log(`=== <主人>：${text}`);
  console.log(`  耗时 ${Date.now() - t0}ms | prompt ${u.prompt_tokens} (缓存 ${u.prompt_tokens_details?.cached_tokens ?? 0})`);
  console.log(`  tool_calls: ${tc ? JSON.stringify(tc.map((c) => ({ n: c.function?.name, a: c.function?.arguments }))) : '❌ 没有'}`);
  console.log(`  思考 ${think.length} 字 / ${u.completion_tokens} tokens`);
  if (!tc) console.log(`  正文: ${JSON.stringify(String(m.content ?? '').slice(0, 100))}`);
  console.log('');
}
