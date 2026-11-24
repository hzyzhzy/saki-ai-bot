/**
 * 表情工具「为什么不自发调用」——消融实验。
 *
 * 基线（`_test-sticker-rate.mjs`）：8 条里 **0 条**发起 `send_sticker`，1 条写 `[表情:x]`。
 * 这里一次只改一个变量，看哪个变量能让她真的调工具：
 *
 *   A 基线
 *   B 提示词里删掉那条自相矛盾的「表情标记 `[表情:xxx]` 可以放心用」
 *   C 工具描述第一句带上中文名「发送表情」（提示词说的名字，模型在函数列表里能找到）
 *   D B + C 一起
 *
 * ⚠️ 全部在内存里替换，**不改任何文件**、不发群、不碰 state。
 * 用法：node tools/_test-sticker-ablate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTools } from '../src/tools-fc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const base = fs.readFileSync(path.join(root, 'personas', 'saki', 'prompt', 'lite.md'), 'utf8');

const INPUTS = [
  '今天好累啊，上了一天课',
  '你在干嘛呢',
  '哈哈哈哈哈笑死我了',
  '我明天要去医院复查，有点紧张',
  '呃……好吧',
  '你觉得我这个人怎么样',
  '（连着刷了三条一样的「在吗」）',
  '晚安，早点睡',
];

const MARK = /\[\s*(?:表情\s*[:：]\s*)?[^\]\s]+\s*\]/;

// —— 变体 B：删掉 L1080 那条矛盾（「…和表情标记 `[表情:xxx]`。」）
const sysB = base.replace(/和表情标记 `\[表情:xxx\]`/g, '');
console.log(`B 变体替换命中：${sysB !== base ? '是' : '⚠️ 没命中（提示词改过？）'}`);

/** 变体 C：把工具数组里 send_sticker 的描述前面挂上中文名 */
function toolsWithCnName() {
  const t = structuredClone(buildTools({}));
  const f = t.find((x) => x.function?.name === 'send_sticker');
  if (f) f.function.description = `发送表情（send_sticker）：${f.function.description}`;
  return t;
}

const CASES = [
  { name: 'A 基线', sys: base, tools: buildTools({}) },
  { name: 'B 删矛盾', sys: sysB, tools: buildTools({}) },
  { name: 'C 描述带中文名', sys: base, tools: toolsWithCnName() },
  { name: 'D B+C', sys: sysB, tools: toolsWithCnName() },
];

for (const c of CASES) {
  let tool = 0;
  let mark = 0;
  const detail = [];
  for (const text of INPUTS) {
    try {
      const r = await fetch('http://127.0.0.1:18085/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.5-4b',
          messages: [
            { role: 'system', content: c.sys },
            { role: 'user', content: text },
          ],
          tools: c.tools,
          tool_choice: 'auto',
          max_tokens: 220,
          stream: false,
          temperature: 0.8,
        }),
        signal: AbortSignal.timeout(180000),
      });
      const j = await r.json();
      const msg = j.choices?.[0]?.message ?? {};
      const calls = (msg.tool_calls ?? []).map((x) => x.function?.name);
      const out = String(msg.content ?? '');
      if (calls.includes('send_sticker')) {
        tool++;
        detail.push('🔧');
      } else if (MARK.test(out)) {
        mark++;
        detail.push('📝');
      } else {
        detail.push('·');
      }
    } catch (e) {
      detail.push('✗');
    }
  }
  console.log(`${c.name.padEnd(16)} 工具 ${tool}/${INPUTS.length} | 标记 ${mark}/${INPUTS.length} | ${detail.join('')}`);
}
