// 照原设定的说话方式自测：长度（4~12 字、最多两句）、不收场拖沓、不客服腔。
import { readFileSync } from 'node:fs';
import { streamChat } from '../src/llm.js';

const p = f => readFileSync(`personas/shenche/${f}`, 'utf8');
const system = [p('prompt/system.md'), p('persona.md'), p('persona-chat.md')].join('\n\n');

const cases = [
  '今天群里好冷清啊',
  '帮我查一下服务器现在几个人在线',
  '你怎么老是不说话，是不是不喜欢我们',
  '这周五要不要一起联机',
  '你好可爱啊',
  '刚才那把剑能给我看看吗',
];

let bad = 0;
for (const q of cases) {
  let out = '';
  for await (const d of streamChat(
    [
      { role: 'system', content: system },
      { role: 'user', content: `群友说：${q}` },
    ],
    undefined,
    { report: {}, noLite: true },
  )) out += d;
  const t = out.trim();
  const sentences = t.split(/[。！？…]+/).filter(x => x.trim()).length;
  const flags = [];
  if (t.length > 40) flags.push(`太长(${t.length}字)`);
  if (sentences > 2) flags.push(`句数${sentences}`);
  if (/[啊呢吧嘛哦啦][，。！？]?$/.test(t)) flags.push('语气词');
  if (/[「」（）]/.test(t)) flags.push('引号或括号');
  if (/您好|请问|抱歉|很高兴|感谢您的|稍等|我看看|马上|没问题/.test(t)) flags.push('助手腔');
  // ⚠️ 现代口语标志才是真判据；"有没有古意词"只当提示（"不喜/尽兴/话杂"这类也算古意）
  if (/挺|蛮|超级|真的很|我觉得|我感觉|太.{0,3}了/.test(t)) flags.push('现代口语');
  const classical = /便|亦|未|莫|勿|既|不曾|不必|与我|不成|也好|罢|晓|且|须|方才|不喜|尽兴|罢了|可。|卷宗|粟|盏/.test(t);
  console.log(`\nQ: ${q}`);
  console.log(`A: ${t}`);
  console.log(flags.length ? `❌ ${flags.join('、')}` : `✓（${t.length} 字 / ${sentences} 句）${classical ? ' 有古意词' : ' 无古意词（内容仍可）'}`);
  if (flags.length) bad++;
}
console.log(bad ? `\n${bad} 例不合格` : '\n全部合格');
process.exit(bad ? 1 : 0);
