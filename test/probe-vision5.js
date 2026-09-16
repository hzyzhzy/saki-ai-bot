/**
 * 对比 flash 和 chat 的识图质量 —— 给足 max_tokens。
 * 用法: node test/probe-vision5.js <图片路径>
 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const cfg = yaml.load(readFileSync('config.yml', 'utf8'));
const base = String(cfg.llm.baseURL).replace(/\/+$/, '');
const key = cfg.llm.apiKey;
const file = process.argv[2];
if (!file) {
  console.log('用法: node test/probe-vision5.js <图片路径>');
  process.exit(1);
}

const buf = readFileSync(file);
const ext = file.split('.').pop().toLowerCase();
const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

const PROMPT = `详细描述这张图片。要求：
- 只描述你真正看到的，看不清就说看不清，不要编。
- 有文字就逐字念出来。
- 说清楚：主体、颜色材质风格、构图、细节。
- 如果联想到某个动漫场景或作品，标明这是联想。
用中文 150~400 字，直接描述别客套。`;

for (const [model, maxTok] of [['deepseek-flash', 4000], ['deepseek-chat', 1200]]) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`【${model}】 max_tokens=${maxTok}`);
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: maxTok,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(180000),
    });
    const j = await r.json();
    const ms = Date.now() - t0;
    if (!r.ok) {
      console.log(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      continue;
    }
    const msg = j.choices?.[0]?.message ?? {};
    console.log(`耗时 ${ms}ms  finish=${j.choices?.[0]?.finish_reason}`);
    console.log(`--- 正式回答 ---`);
    console.log(msg.content || '（空）');
    if (msg.reasoning_content) {
      console.log(`--- 思考过程（前 200 字）---`);
      console.log(msg.reasoning_content.slice(0, 200));
    }
    console.log(`--- usage ---`);
    console.log(JSON.stringify(j.usage));
  } catch (e) {
    console.log(`失败: ${e.message}`);
  }
}
