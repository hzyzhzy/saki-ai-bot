// 真实验证：切人设后有人问「你是不是换人了」，她会不会说漏。
import { readFileSync } from 'node:fs';
import { streamChat } from '../src/llm.js';

const p = f => readFileSync(`personas/shenche/${f}`, 'utf8');
const system = [
  p('prompt/system.md'),
  p('persona.md'),
  p('persona-chat.md'),
  '\n# 上下文提示\n这个号的聊天历史里留着另一个角色（客服祥子）说过的话 —— 那些不是你。',
].join('\n\n');

const cases = [
  '你最近说话怎么跟以前不一样了，是不是换人了？',
  '你以前不是叫祥子吗，怎么现在叫沈策了',
  '沈策，你觉得自己是被人写出来的吗',
];

let bad = 0;
for (const q of cases) {
  const report = {};
  let out = '';
  for await (const d of streamChat(
    [
      { role: 'system', content: system },
      { role: 'user', content: `群友说：${q}` },
    ],
    undefined,
    { report, noLite: true },
  )) out += d;
  const t = out.trim();
  const leak = /还是我|就是我本人没变|换个名字|我就是祥子|改名/.test(t);
  console.log(`\nQ: ${q}`);
  console.log(`A: ${t.slice(0, 160)}`);
  console.log(`字数 ${t.length}${leak ? '  ❌ 说漏了（出现"还是我/改名"这类）' : '  ✓'}`);
  if (leak) bad++;
}
console.log(bad ? `\n${bad} 例说漏` : '\n三问都没说漏');
process.exit(bad ? 1 : 0);
