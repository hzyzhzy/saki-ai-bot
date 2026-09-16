/** 探测 DeepSeek 官方 API 自带的联网/搜索能力 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const cfg = yaml.load(readFileSync('config.yml', 'utf8'));
const base = String(cfg.llm.baseURL).replace(/\/+$/, '');
const key = cfg.llm.apiKey;

const test = async (label, body) => {
  console.log(`\n=== ${label} ===`);
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const t = await r.text();
    console.log(`HTTP ${r.status}`);
    if (r.ok) {
      const j = JSON.parse(t);
      console.log('回复:', JSON.stringify((j.choices?.[0]?.message?.content ?? '').slice(0, 300)));
    } else {
      console.log(t.slice(0, 400));
    }
  } catch (e) {
    console.log('失败:', e.message);
  }
};

// ① 带 tools 里塞一个 web_search（看认不认这个工具名）
await test('tools: [{type:"web_search"}]（内建搜索？）', {
  model: 'deepseek-chat',
  max_tokens: 300,
  messages: [{ role: 'user', content: '今天有什么新闻？' }],
  tools: [{ type: 'web_search' }],
});

// ② 普通 function calling 形式的搜索工具（模型会不会去调）
await test('function calling 形式的 search 工具', {
  model: 'deepseek-chat',
  max_tokens: 300,
  messages: [{ role: 'user', content: '帮我搜一下梦限大是什么' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '搜索互联网',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    },
  ],
});

// ③ 直接问它知不知道，看知识截止
await test('直接问知识截止时间', {
  model: 'deepseek-chat',
  max_tokens: 300,
  messages: [{ role: 'user', content: '你的知识截止到什么时候？知道 MyGO 之后的新乐队吗？' }],
});
