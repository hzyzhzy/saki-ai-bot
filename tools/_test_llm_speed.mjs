/** 测中转站生成一段**真实长度**内容要多久 —— 判断"超时"到底是配置太短还是线路慢。 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const YAML = require('js-yaml');

const cfg = YAML.load(readFileSync('config.yml', 'utf8'));
const v = (cfg?.llm?.providers || {})['0'] || {};
const base = String(v.baseURL || '');
const key = String(v.apiKey || '');
const model = String(v.model || '');

async function gen(maxTokens, label) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '用中文写 120 个字描述今天天气。' }],
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(180000),
    });
    const ms = Date.now() - t0;
    const j = await res.json().catch(() => ({}));
    const content = j?.choices?.[0]?.message?.content ?? '';
    const usage = j?.usage ?? {};
    console.log(`${label}: HTTP ${res.status} / ${(ms / 1000).toFixed(1)}s / 内容 ${String(content).length} 字 / usage=${JSON.stringify(usage)}`);
    if (res.status !== 200) console.log('   body:', JSON.stringify(j).slice(0, 200));
  } catch (e) {
    console.log(`${label}: 失败 ${((Date.now() - t0) / 1000).toFixed(1)}s / ${String(e.message || e).slice(0, 120)}`);
  }
}

console.log('线路:', base, model);
await gen(200, '200 token');
await gen(800, '800 token');
