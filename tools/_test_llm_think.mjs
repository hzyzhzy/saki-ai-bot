/** 测：加大 max_tokens / 关掉思考，正文到底能不能出来。 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const YAML = require('js-yaml');

const cfg = YAML.load(readFileSync('config.yml', 'utf8'));
const v = (cfg?.llm?.providers || {})['0'] || {};
const base = String(v.baseURL || '');
const key = String(v.apiKey || '');
const model = String(v.model || '');

async function gen(label, extra) {
  const t0 = Date.now();
  const body = {
    model,
    messages: [{ role: 'user', content: '用中文写 60 个字描述今天的天气。' }],
    max_tokens: 2000,
    stream: false,
    ...extra,
  };
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    const ms = Date.now() - t0;
    const j = await res.json().catch(() => ({}));
    const msg = j?.choices?.[0]?.message ?? {};
    const u = j?.usage ?? {};
    console.log(
      `${label}: HTTP ${res.status} / ${(ms / 1000).toFixed(1)}s / 正文 ${String(msg.content ?? '').length} 字 / ` +
        `思考 ${u?.completion_tokens_details?.reasoning_tokens ?? 0} tok / 完成 ${u?.completion_tokens ?? 0} tok`,
    );
    if (msg.content) console.log('   正文:', String(msg.content).slice(0, 80));
  } catch (e) {
    console.log(`${label}: 失败 ${((Date.now() - t0) / 1000).toFixed(1)}s / ${String(e.message || e).slice(0, 100)}`);
  }
}

console.log('线路:', model);
await gen('A. max_tokens=2000 默认', {});
await gen('B. + reasoning_effort=low', { reasoning_effort: 'low' });
await gen('C. + thinking disabled', { thinking: { type: 'disabled' } });
await gen('D. + enable_thinking=false', { enable_thinking: false });
