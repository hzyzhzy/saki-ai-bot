// 真实验证：被问到父母/沈家渡这类痛处时，会不会变冲、挂语气词、主动补介绍。
import { readFileSync } from 'node:fs';
import { streamChat } from '../src/llm.js';

const p = f => readFileSync(`personas/shenche/${f}`, 'utf8');
const system = [p('prompt/system.md'), p('persona.md'), p('persona-chat.md')].join('\n\n');

const cases = ['你爸是谁', '沈家渡那年到底出了什么事', '你左肋那道伤是怎么来的'];

let bad = 0;
for (const q of cases) {
  let out = '';
  for await (const d of streamChat(
    [
      { role: 'system', content: system },
      { role: 'user', content: `群友 @你：${q}` },
    ],
    undefined,
    { report: {}, noLite: true },
  )) out += d;
  const t = out.trim();
  const bad1 = /问这个做什么|管得着|关你什么事|你管/.test(t);   // 反问式防御
  const bad2 = /[啊呢吧嘛哦啦][，。！？]?$/.test(t) || /啊，|呢，|吧，/.test(t); // 语气词
  const bad3 = /在.{2,8}摆渡的|是个.{2,8}的人/.test(t);          // 长句介绍
  const bad4 = t.length > 60;                                   // 话太多
  // ⚠️ 「沈渡。摆渡的。」这种三字补充是人设允许的（名字 + 一个事实），不算补介绍
  const flag = [bad1 && '反问防御', bad2 && '语气词', bad3 && '补介绍', bad4 && '太长'].filter(Boolean);
  console.log(`\nQ: ${q}`);
  console.log(`A: ${t}`);
  console.log(`${flag.length ? '❌ ' + flag.join('、') : '✓ 合格'}（${t.length} 字）`);
  if (flag.length) bad++;
}
console.log(bad ? `\n${bad} 例不合格` : '\n全部合格');
process.exit(bad ? 1 : 0);
