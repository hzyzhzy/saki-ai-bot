/** 用配置里的 key 各打一次最小请求，看两条模型线路到底能不能用。 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const YAML = require('js-yaml');

const cfg = YAML.load(readFileSync('config.yml', 'utf8'));
const provs = cfg?.llm?.providers || {};

async function tryOne(label, base, model, key) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const ms = Date.now() - t0;
    const txt = await res.text();
    console.log(`${label}: HTTP ${res.status} / ${ms}ms / ${txt.slice(0, 220)}`);
  } catch (e) {
    console.log(`${label}: 失败 ${Date.now() - t0}ms / ${String(e.message || e).slice(0, 160)}`);
  }
}

for (const [k, v] of Object.entries(provs)) {
  console.log(`--- [${k}] ${v?.name || ''} ${v?.baseURL} ${v?.model}`);
  await tryOne(`[${k}]`, String(v?.baseURL || ''), String(v?.model || ''), String(v?.apiKey || ''));
}
