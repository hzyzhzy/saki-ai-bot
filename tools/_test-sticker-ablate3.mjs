/**
 * 表情工具消融 第三轮：**给它一个"必做的自检动作"**，看自发调用率能不能提上来。
 *
 * 现状数据（前两轮）：日常 8 条里 **0~1 条**自发调 `send_sticker`；
 * 被明确要求时 2/3 会调 ⇒ 4B 会"执行"，不会"自己想到"。
 *
 *   H1 在 lite.md 静态段末尾追加一段**动作自检**（不是台词，是判据）
 *   H2 再狠一点：要求她"回完先想一下"，且把 `[表情:x]` 明确写成**没用**
 *
 * ⚠️ 只做诊断，不改文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTools } from '../src/tools-fc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const base = fs.readFileSync(path.join(root, 'personas', 'saki', 'prompt', 'lite.md'), 'utf8');
const tools = buildTools({});

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

const H1 = `

# 🖼️ 回话之前，先过一下这一条
你说完这句话，如果当面说手上会顺手比个动作（无奈、无语、笑、害羞、抱一下……），
那就**别只说着** —— 调 \`send_sticker\`，\`哪个\` 就写那个动作或情绪。
这一步和"要不要说话"一样是每轮都要过的，不是你偶尔想起来才做。`;

const H2 = `

# 🖼️ 回话之前，先过一下这一条
你说完这句话，如果当面说手上会顺手比个动作（无奈、无语、笑、害羞、抱一下……），
那就**别只说着** —— 调 \`send_sticker\`，\`哪个\` 就写那个动作或情绪。
这一步和"要不要说话"一样是每轮都要过的，不是你偶尔想起来才做。
⚠️ 在正文里写 \`[表情:xxx]\` **发不出任何图**，那是废字，别写。`;

async function suite(label, sys) {
  let tool = 0;
  let mark = 0;
  const marks = [];
  for (const text of DAILY) {
    try {
      const r = await fetch('http://127.0.0.1:18085/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.5-4b',
          messages: [
            { role: 'system', content: sys },
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
      const calls = (m.tool_calls ?? []).map((x) => x.function?.name);
      const out = String(m.content ?? '');
      const isTool = calls.includes('send_sticker');
      const isMark = /\[\s*(?:表情\s*[:：]\s*)?[^\]\s]+\s*\]/.test(out);
      if (isTool) tool++;
      if (isMark) mark++;
      marks.push(isTool ? '🔧' : isMark ? '📝' : '·');
    } catch {
      marks.push('✗');
    }
  }
  console.log(`${label.padEnd(14)} 工具 ${tool}/8 | 标记 ${mark}/8 | ${marks.join('')}`);
}

await suite('A 基线', base);
await suite('H1 动作自检', base + H1);
await suite('H2 +废字说明', base + H2);
