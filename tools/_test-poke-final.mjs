/**
 * 回戳最终验收：system 用**真实的 `buildLitePrompt()` 输出**（不是手抄的文案）。
 *
 * 跑法：先设 `$env:QQBOT_ACCOUNT=<QQ>`，再 node 这个脚本。
 * 判据：poke_back 调用率 —— 改前基线 0/6（三组实测都 0），目标 ≥4/6。
 */
import { buildLitePrompt } from '../src/prompt-lite.js';
import { buildTools } from '../src/tools-fc.js';

const tools = buildTools({});
const ACTS = [
  '捏了捏的脸',
  '拍了拍',
  '戳了戳',
  '拍了拍的脑袋，拍出了脑花',
  '捏了捏的，中毒了！！！',
  '戳了戳的脑子，我开启了杀戮',
];

let hit = 0;
const marks = [];
const outs = [];
for (const act of ACTS) {
  const sys = buildLitePrompt({ poke: { who: 'Anon', uid: '10000013', pt: act } });
  try {
    const r = await fetch('http://127.0.0.1:18085/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.5-4b',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: `【Anon】[戳一戳·${act}]` },
        ],
        tools,
        tool_choice: 'auto',
        max_tokens: 220,
        stream: false,
        temperature: 0.8,
      }),
      signal: AbortSignal.timeout(180000),
    });
    const j = await r.json();
    const m = j.choices?.[0]?.message ?? {};
    const calls = (m.tool_calls ?? []).map((x) => x.function?.name);
    const ok = calls.includes('poke_back');
    if (ok) hit++;
    marks.push(ok ? '🔧' : '·');
    outs.push(`${ok ? '🔧' : '·'} ${act} → ${String(m.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 34)}`);
  } catch (e) {
    marks.push('✗');
    outs.push(`✗ ${act} → ${e.message}`);
  }
}
console.log(outs.join('\n'));
console.log(`\npoke_back ${hit}/${ACTS.length} | ${marks.join(' ')}`);
