// 固定用真实提示词测 prefill 速度（每次换一句"他刚说的"，避免命中缓存，测的就是冷 prefill）
process.env.QQBOT_ACCOUNT = process.env.QQBOT_ACCOUNT || '10000002';

const { buildLitePrompt } = await import('../src/prompt-lite.js');
const { readFileSync, appendFileSync } = await import('node:fs');

const gp = readFileSync('knowledge/groups/200000001.md', 'utf8')
  .replace(/^>[^\n]*$/gm, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim()
  .slice(0, 3000);

const tag = process.argv[2] || '基线';
const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });

// 每次用不同的尾巴 ⇒ 保证是冷 prefill
const sys = buildLitePrompt({
  at: '<主人>',
  said: `测速标记 ${stamp} ${Math.random().toString(36).slice(2, 8)}`,
  recent: `<主人>：测速 ${stamp}`,
  live: '',
  owner: true,
  groupPeople: gp,
});

const t0 = Date.now();
const r = await fetch('http://127.0.0.1:18085/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'qwen3.5-4b',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: '说一句话' },
    ],
    max_tokens: 12,
    stream: false,
  }),
  signal: AbortSignal.timeout(240000),
});
const j = await r.json();
const t = j.timings ?? {};
const prefillS = (t.prompt_ms ?? 0) / 1000;
const tps = t.prompt_n && t.prompt_ms ? (t.prompt_n / (t.prompt_ms / 1000)).toFixed(0) : '?';
const line = `[${stamp}] ${tag}: prefill ${prefillS.toFixed(2)}s / ${t.prompt_n} token = ${tps} tok/s | 生成 ${(t.predicted_per_second ?? 0).toFixed(1)} tok/s | 总 ${((Date.now() - t0) / 1000).toFixed(2)}s`;
console.log('  ' + line);
try {
  appendFileSync('logs/_perf-compare.txt', line + '\n', 'utf8');
} catch {}
process.exit(0);
