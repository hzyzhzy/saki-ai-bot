// 量「纯 prefill 时间」—— 不想关思考，但要算出"光是读提示词"要多久
//   手法：关思考 + max_tokens=1 ⇒ 总耗时基本就是 prefill（加一次采样的固定开销）
//   ⚠️ 这只是**测量手段**：生产里思考绝不能关（4B 靠思考链发 tool_calls）
const URL = 'http://127.0.0.1:18085/v1/chat/completions';
const MODEL = 'qwen3.5-4b';

function makePrompt(chars) {
  const base =
    '你是客服小祥，一个在 QQ 群里和群友聊天的 AI。你要用自然、口语化的中文说话。';
  let s = base;
  while (s.length < chars)
    s += '\n[<主人>] 今天服务器又炸了，你看了吗？\n[你] 看了看了，已经在修了，稍等一下。';
  return s.slice(0, chars);
}

async function prefillOnly(sysChars, label) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: makePrompt(sysChars) },
      { role: 'user', content: '在吗' },
    ],
    max_tokens: 1,
    stream: false,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false }, // 只为测 prefill
  };
  const t0 = Date.now();
  let j = null;
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) {
      console.log('  ' + label + ' ❌ HTTP ' + res.status);
      return null;
    }
    j = await res.json();
  } catch (e) {
    console.log('  ' + label + ' ❌ ' + e.message);
    return null;
  }
  const ms = Date.now() - t0;
  const t = j.timings || {};
  const pt = j.usage?.prompt_tokens ?? t.prompt_n ?? '?';
  const promptMs = t.prompt_ms ? Math.round(t.prompt_ms) : null;
  const tokPerSec = t.prompt_per_second ? Math.round(t.prompt_per_second) : null;
  console.log(
    '  ' + label.padEnd(22) +
    ' 总 ' + String(ms).padStart(6) + ' ms' +
    ' | prompt ' + String(pt).padStart(6) + ' tok' +
    ' | llama.cpp 报的 prefill ' + String(promptMs ?? '-').padStart(6) + ' ms' +
    (tokPerSec ? ' (' + tokPerSec + ' tok/s)' : ''),
  );
  return { ms, pt, promptMs };
}

console.log('=== 纯 prefill 实测（关思考 + max_tokens=1，只为分离 prefill）===\n');

const r = {};
r['0'] = await prefillOnly(400, '极短 ~400字');
await new Promise((x) => setTimeout(x, 600));
r['6k'] = await prefillOnly(6000, '中 ~6000字');
await new Promise((x) => setTimeout(x, 600));
r['13k'] = await prefillOnly(13000, '半 ~13000字');
await new Promise((x) => setTimeout(x, 600));
r['27k'] = await prefillOnly(27000, '现在 ~27000字');

console.log('\n=== 换算 ===');
const keys = ['0', '6k', '13k', '27k'];
for (let i = 1; i < keys.length; i++) {
  const a = r[keys[i - 1]];
  const b = r[keys[i]];
  if (!a || !b) continue;
  const dTok = (b.pt === '?' ? 0 : b.pt) - (a.pt === '?' ? 0 : a.pt);
  const dMs = b.ms - a.ms;
  if (dTok > 0) {
    console.log(
      '  ' + keys[i - 1] + '→' + keys[i] +
      '：多 ' + dTok + ' tok，多花 ' + dMs + ' ms ⇒ 约 ' +
      Math.round((dMs / dTok) * 1000) + ' ms / 1000 tok',
    );
  }
}
