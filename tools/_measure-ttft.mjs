// 量「首词生成时间」（TTFT）
//   ⚠️ 这是用户感觉"慢"的核心：她"想说"到"第一个字出来"之间的等待
//   ⚠️⚠️ 关键：本地这个是**思考模型** —— `content` 一直是空的，字全在 `reasoning` 里
//      所以这里**分开记**：第一个 reasoning token（开始想）和第一个 content token（开始说）
const URL = 'http://127.0.0.1:18085/v1/chat/completions';
const MODEL = 'qwen3.5-4b';

function makePrompt(chars) {
  const base =
    '你是客服小祥，一个在 QQ 群里和群友聊天的 AI。你要用自然、口语化的中文说话，' +
    '不要像客服，不要像助手，别说"作为AI"。群里有 <主人>（主人）、爱音、以及其他群友。' +
    '以下是最近的历史消息，供你理解上下文。';
  let s = base;
  while (s.length < chars) s += '\n[<主人>] 今天服务器又炸了，你看了吗？\n[你] 看了看了，已经在修了，稍等一下。';
  return s.slice(0, chars);
}

async function measure(sysChars, label, opts = {}) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: makePrompt(sysChars) },
      { role: 'user', content: '在吗，回我一句' },
    ],
    max_tokens: opts.maxTokens ?? 60,
    stream: true,
    temperature: opts.temperature ?? 0.8,
  };
  if (opts.noThink) body.chat_template_kwargs = { enable_thinking: false };

  const t0 = Date.now();
  let firstThinkAt = 0;
  let firstContentAt = 0;
  let thinkChunks = 0;
  let contentChunks = 0;
  let think = '';
  let text = '';
  let usage = null;

  let res;
  try {
    res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });
  } catch (e) {
    console.log('  ' + label + ' ❌ ' + e.message);
    return;
  }
  if (!res.ok) {
    console.log('  ' + label + ' ❌ HTTP ' + res.status + ' ' + (await res.text()).slice(0, 100));
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        if (j.usage) usage = j.usage;
        const d = j.choices?.[0]?.delta;
        if (!d) continue;
        if (d.reasoning) {
          if (!firstThinkAt) firstThinkAt = Date.now() - t0;
          thinkChunks++;
          think += d.reasoning;
        }
        if (d.content) {
          if (!firstContentAt) firstContentAt = Date.now() - t0;
          contentChunks++;
          text += d.content;
        }
      } catch {}
    }
  }
  const total = Date.now() - t0;
  const pt = usage?.prompt_tokens ?? '?';
  const ct = usage?.completion_tokens ?? '?';
  const genMs = total - (firstThinkAt || 0);
  const genTok = thinkChunks + contentChunks;
  const tps = genMs > 0 && genTok > 0 ? ((genTok / genMs) * 1000).toFixed(1) : '?';

  console.log(
    '  ' + label.padEnd(24) +
    ' 首个思考 ' + String(firstThinkAt || '-').padStart(6) + ' ms' +
    ' | 首个正文 ' + String(firstContentAt || '-').padStart(6) + ' ms' +
    ' | 总 ' + String(total).padStart(6) + ' ms' +
    ' | prompt ' + String(pt).padStart(6) + ' tok' +
    ' | 出 ' + String(ct).padStart(3) + ' tok' +
    ' | ' + String(tps).padStart(5) + ' tok/s',
  );
  return { firstThinkAt, firstContentAt, total, pt, ct, tps };
}

console.log('=== TTFT 实测（' + MODEL + '，流式）===');
console.log('每档只跑 1 次（本地模型有 prefix cache，第 2 次会快很多，测不到真实的第一次）\n');

const rows = [];
rows.push(['短 ~200字', await measure(200, '短提示词 ~200字')]);
await new Promise((r) => setTimeout(r, 800));
rows.push(['中 ~6000字', await measure(6000, '中提示词 ~6000字')]);
await new Promise((r) => setTimeout(r, 800));
rows.push(['真实 ~27000字', await measure(27000, '真实大小 ~27000字')]);
await new Promise((r) => setTimeout(r, 800));
rows.push(['真实+关思考', await measure(27000, '真实大小 + 关思考', { noThink: true })]);
