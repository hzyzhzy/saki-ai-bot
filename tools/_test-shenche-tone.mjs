// 语体自测：半文半白（有文言痕迹）且不夹现代口语词，同时仍守 4~12 字、最多两句。
import { readFileSync } from 'node:fs';
import { streamChat } from '../src/llm.js';

const p = f => readFileSync(`personas/shenche/${f}`, 'utf8');
const system = [p('prompt/system.md'), p('persona.md'), p('persona-chat.md')].join('\n\n');
const CLASSICAL = /便|亦|未|莫|勿|既|何|不曾|不必|与我|此路|岂|焉/;
const MODERN = /挺|蛮|确实|真的假的|好家伙|行吧|啊[，。！？]|呢[，。！？]|吧[，。！？]|嘛|啦|我觉得|我感觉|说实话/;

const cases = [
  '今天群里有新人来了',
  '你这人怎么这么冷淡',
  '有人欺负我，你帮我出个头',
  '晚上一起吃点什么',
  '你要是累了就早点睡',
  '沈策你在吗',
];

let bad = 0;
for (const q of cases) {
  let out = '';
  for await (const d of streamChat(
    [{ role: 'system', content: system }, { role: 'user', content: `群友说：${q}` }],
    undefined,
    { report: {}, noLite: true },
  )) out += d;
  const t = out.trim();
  const sentences = t.split(/[。！？…]+/).filter(x => x.trim()).length;
  const flags = [];
  if (t.length > 40) flags.push(`太长${t.length}字`);
  if (sentences > 2) flags.push(`${sentences}句`);
  if (!CLASSICAL.test(t)) flags.push('没有文言味');
  if (MODERN.test(t)) flags.push('现代口语词');
  console.log(`\nQ: ${q}`);
  console.log(`A: ${t}`);
  console.log(flags.length ? `❌ ${flags.join('、')}` : `✓（${t.length} 字 / ${sentences} 句，有文言味）`);
  if (flags.length) bad++;
}
console.log(bad ? `\n${bad} 例不合格` : '\n全部合格');
process.exit(bad ? 1 : 0);
