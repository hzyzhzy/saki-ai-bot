/** 探测：DeepSeek 的模型支不支持图片输入 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const cfg = yaml.load(readFileSync('config.yml', 'utf8'));
const base = String(cfg.llm.baseURL).replace(/\/+$/, '');
const key = cfg.llm.apiKey;

// 一张最小的 1x1 红点 PNG
const tinyPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

for (const model of ['deepseek-chat', 'deepseek-flash', 'deepseek-v4-pro']) {
  console.log(`\n=== ${model} ===`);
  const body = {
    model,
    max_tokens: 50,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这张图是什么颜色？只回答颜色。' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng}` } },
        ],
      },
    ],
  };
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40000),
    });
    const text = await r.text();
    console.log(`HTTP ${r.status}`);
    if (r.ok) {
      const j = JSON.parse(text);
      console.log('  ✅ 接受了图片输入，回复:', JSON.stringify(j.choices?.[0]?.message?.content));
    } else {
      console.log('  ❌ 拒绝:', text.slice(0, 300));
    }
  } catch (e) {
    console.log('  失败:', e.message);
  }
}
