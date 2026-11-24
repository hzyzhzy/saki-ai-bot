/**
 * 表情工具消融 第二轮：隔离「工具太多稀释」和「需求是否明确」。
 *
 *   E 只给 4 个工具（send_sticker + 查服务器 + 搜索 + 记住），日常 8 条
 *   F 全 24 个工具，但**明确要求她发表情** 3 条（证"会不会调"）
 *   G 只给 4 个工具 + 明确要求 3 条（证"工具少时更准"）
 *
 * ⚠️ 只做诊断，不改任何文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTools } from '../src/tools-fc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const system = fs.readFileSync(path.join(root, 'personas', 'saki', 'prompt', 'lite.md'), 'utf8');
const all = buildTools({});

const KEEP = ['send_sticker', 'query_server', 'web_search', 'remember'];
const few = all.filter((t) => KEEP.includes(t.function?.name));

const DAILY = [
  '今天好累啊，上了一天课',
  '你在干嘛呢',
  '哈哈哈哈哈笑死我了',
  '我明天要去医院复查，有点紧张',
  '呃……好吧',
  '你觉得我这个人怎么样',
  '（连着刷了三条一样的「在吗」）',
  '晚安，早点睡',
];
const ASK = ['给我发个表情', '发张图，我看看你有多无语', '你发表情包给我看嘛'];

async function run(tools, text) {
  const r = await fetch('http://127.0.0.1:18085/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3.5-4b',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
      tools,
      tool_choice: 'auto',
      max_tokens: 220,
      stream: false,
      temperature: 0.8,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const j = await r.json();
  const m = j.choices?.[0]?.message ?? {};
  return {
    calls: (m.tool_calls ?? []).map((x) => x.function?.name),
    out: String(m.content ?? '').trim().slice(0, 60),
  };
}

async function suite(label, tools, inputs) {
  let hit = 0;
  const marks = [];
  for (const text of inputs) {
    try {
      const { calls } = await run(tools, text);
      const ok = calls.includes('send_sticker');
      if (ok) hit++;
      marks.push(ok ? '🔧' : '·');
    } catch {
      marks.push('✗');
    }
  }
  console.log(`${label.padEnd(22)} 调工具 ${hit}/${inputs.length} | ${marks.join('')}`);
}

console.log(`全量工具 ${all.length} 个 / 精简 ${few.length} 个（${few.map((t) => t.function.name).join(',')}）\n`);
await suite('E 4 工具·日常', few, DAILY);
await suite('F 24 工具·明确要求', all, ASK);
await suite('G 4 工具·明确要求', few, ASK);
