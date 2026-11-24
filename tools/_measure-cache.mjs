// 验证 prefix cache 命中情况
//   同一份长提示词连发两次：第 2 次如果 prefill 接近 0 ⇒ 缓存命中 ✓
//   然后模拟"真实多轮"：前 90% 相同、只在末尾 append ⇒ 看还能不能命中
const URL = 'http://127.0.0.1:18085/v1/chat/completions';
const MODEL = 'qwen3.5-4b';

function makeLong(chars, tail = '') {
  const base = '你是客服小祥，一个在 QQ 群里和群友聊天的 AI。';
  let s = base;
  while (s.length < chars)
    s += '\n[<主人>] 今天服务器又炸了，你看了吗？\n[你] 看了看了，已经在修了，稍等一下。';
  return s.slice(0, chars) + tail;
}

async function call(sysText, userText, label) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: sysText },
      { role: 'user', content: userText },
    ],
    max_tokens: 1,
    stream: false,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
  };
  const t0 = Date.now();
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  const j = await res.json();
  const ms = Date.now() - t0;
  const t = j.timings || {};
  console.log(
    '  ' + label.padEnd(30) +
    ' 总 ' + String(ms).padStart(6) + ' ms' +
    ' | prompt ' + String(j.usage?.prompt_tokens ?? '?').padStart(6) + ' tok' +
    ' | prefill ' + String(t.prompt_ms ? Math.round(t.prompt_ms) : '-').padStart(6) + ' ms',
  );
  return { ms, prefill: t.prompt_ms ? Math.round(t.prompt_ms) : 0 };
}

const SYS = makeLong(27000);
console.log('=== ① 同一提示词连发 3 次（看 prefix cache）===\n');
await call(SYS, '在吗', '第 1 次（冷）');
await new Promise((r) => setTimeout(r, 500));
await call(SYS, '在吗', '第 2 次（应命中缓存）');
await new Promise((r) => setTimeout(r, 500));
await call(SYS, '在吗', '第 3 次');

console.log('\n=== ② 末尾 append（模拟真实多轮，前缀不变）===\n');
const SYS2 = SYS + '\n[<主人>] 那大概多久能修好？';
await new Promise((r) => setTimeout(r, 500));
await call(SYS2, '在吗', '前缀相同 + 末尾加一句');
await new Promise((r) => setTimeout(r, 500));
await call(SYS2, '在吗', '同上，再来一次');

console.log('\n=== ③ 中间插一句（破坏前缀，模拟"前缀每轮都变"）===\n');
const SYS3 = SYS.replace('你是客服小祥', '[新消息] 有人在吗\n你是客服小祥');
await new Promise((r) => setTimeout(r, 500));
await call(SYS3, '在吗', '开头插了一句');
