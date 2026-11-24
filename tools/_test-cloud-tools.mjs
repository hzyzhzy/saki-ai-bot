/**
 * 直接打**真实云端模型**，验证工具链路通不通（不发群、不碰 state）。
 *
 * 背景：现在主模型是官方 deepseek-flash，但工具从没被自发调用过。
 * 要分清是「模型不想调」还是「链路里工具没送到 / 上游不认」。
 *
 * 用 `config.yml` 的真实 baseURL/apiKey/model，带真实 `buildTools()`。
 */
import fs from 'node:fs';
import { buildTools } from '../src/tools-fc.js';
import { config } from '../src/config.js';

const provider = config.provider?.llm ?? config.llm ?? {};
const base = provider.baseURL ?? 'https://api.deepseek.com/v1';
const key = provider.apiKey ?? '';
const model = provider.model ?? 'deepseek-flash';
const tools = buildTools({});

console.log(`baseURL=${base}  model=${model}  tools=${tools.length}`);

const cases = [
  ['明确要求发图', '给我发个表情'],
  ['日常闲聊（看它会不会自发发图）', '哈哈哈哈哈笑死我了'],
];

/* ⚠️⚠️ 对照实验（2026-11-24）：**同样的模型、同样的工具，只换 system**。
 *   真实群里那条 15 万字的提示词原样喂进去，看还调不调 `send_sticker`。
 *   这能分清「模型不会调」和「被那条长提示词压住了」。 */
{
  const real = fs.readFileSync(new URL('../logs/_prompt-group200000007.last.txt', import.meta.url), 'utf8');
  console.log(`\n—— 对照：真实提示词 ${real.length} 字 ——`);
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: real },
          { role: 'user', content: '哈哈哈哈哈笑死我了' },
        ],
        tools,
        tool_choice: 'auto',
        max_tokens: 300,
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });
    const j = await r.json();
    if (j.error) {
      console.log(`❌ 真实提示词: HTTP ${r.status} ${JSON.stringify(j.error).slice(0, 200)}`);
    } else {
      const m = j.choices?.[0]?.message ?? {};
      const calls = (m.tool_calls ?? []).map((c) => `${c.function?.name}(${String(c.function?.arguments ?? '').slice(0, 40)})`);
      const u = j.usage ?? {};
      console.log(
        `${calls.length ? '🔧' : '·'} 真实提示词: 工具=${calls.length ? calls.join(' | ') : '无'}` +
          `｜正文=${JSON.stringify(String(m.content ?? '').slice(0, 40))}｜` +
          `in=${u.prompt_tokens ?? '?'} cached=${u.prompt_cache_hit_tokens ?? '?'}`,
      );
    }
  } catch (e) {
    console.log(`❌ 真实提示词: ${e.message}`);
  }
}

for (const [label, text] of cases) {
  const body = {
    model,
    messages: [
      { role: 'system', content: '你在一个 QQ 群里跟人闲聊。想发表情就调 send_sticker，哪个 填你想表达的情绪。' },
      { role: 'user', content: text },
    ],
    tools,
    tool_choice: 'auto',
    max_tokens: 300,
    stream: false,
  };
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    const j = await r.json();
    if (j.error) {
      console.log(`❌ ${label}: HTTP ${r.status} ${JSON.stringify(j.error).slice(0, 160)}`);
      continue;
    }
    const m = j.choices?.[0]?.message ?? {};
    const calls = (m.tool_calls ?? []).map((c) => `${c.function?.name}(${String(c.function?.arguments ?? '').slice(0, 40)})`);
    console.log(
      `${calls.length ? '🔧' : '·'} ${label}: 工具调用=${calls.length ? calls.join(' | ') : '无'}｜正文=${JSON.stringify(String(m.content ?? '').slice(0, 50))}`,
    );
  } catch (e) {
    console.log(`❌ ${label}: ${e.message}`);
  }
}
