/**
 * 表情消融 第四轮：**把标记路重新打开**（因为 4B 不会自发调工具，实测 1/48）。
 *
 * 已知：真实提示词里有表情段、工具也给了，但 8 条日常里 0 条调工具、0~2 条写标记
 *       ⇒ 提示词里那句「🚫 别在正文里写 [表情:xxx]」把它唯一会做的动作禁掉了。
 *
 *   I1 允许写标记 + 给出可用的 tag 清单（60 个库里挑 24 个高频情绪）
 *   I2 I1 但把"调工具"也留着当备选（现在真实的写法）
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

const TAGS =
  '大笑 无语 害羞 得意 生气 哭哭 抱抱 无奈 紧张 嘟嘴 托腮 震惊 冷眼 狂笑 扶额 憋笑 摸头 吃瓜 欢呼 比耶 挥手 送花 思考 疑惑';

const I1 = `

# 🖼️ 表情怎么发
想放个表情的时候，就在正文里写一个标记，格式是 \`[表情:表情名]\` —— 代码会把它换成真图发出去。
表情名只从这几个里挑（写别的发不出来）：${TAGS}
· 一次最多一个，写在句尾或者单独发一条都行。`;

const I2 = `${I1}
· 也可以调 \`send_sticker\` 工具发，两种都行。`;

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

const MARK = /\[\s*表情\s*[:：]\s*([^\]\s]+)\s*\]/;

async function suite(label, sys) {
  let tool = 0;
  let mark = 0;
  let valid = 0;
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
          max_tokens: 260,
          stream: false,
          temperature: 0.8,
        }),
        signal: AbortSignal.timeout(180000),
      });
      const j = await r.json();
      const m = j.choices?.[0]?.message ?? {};
      const calls = (m.tool_calls ?? []).map((x) => x.function?.name);
      const out = String(m.content ?? '');
      const mm = MARK.exec(out);
      const isTool = calls.includes('send_sticker');
      if (isTool) tool++;
      if (mm) {
        mark++;
        // 能不能真发出去？用真实的 pickMarkers 判
        const { pickMarkers } = await import('../src/faces.js');
        if (pickMarkers(out).length) valid++;
        marks.push(`📝${mm[1]}`);
      } else {
        marks.push(isTool ? '🔧' : '·');
      }
    } catch (e) {
      marks.push('✗');
    }
  }
  console.log(`${label.padEnd(20)} 工具 ${tool}/8 | 标记 ${mark}/8（其中能发出去 ${valid}）`);
  console.log(`   ${marks.join(' ')}`);
}

await suite('A 基线', base);
await suite('I1 允许写标记+清单', base + I1);
await suite('I2 标记+工具都留', base + I2);
