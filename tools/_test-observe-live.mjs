// 真实提示词自测：把 observe 的 PROMPT 原样走一遍真实模型（和线上同一条 collect 路径），
// 确认 ① 旧评价会被参考（<主人> 不会被写成新群友）② 过期评价会被改掉。
import { readFileSync } from 'node:fs';
import { streamChat } from '../src/llm.js';

const src = readFileSync('src/observe.js', 'utf8');
const m = /const PROMPT = `([\s\S]*?)`;/.exec(src);
if (!m) throw new Error('取不到 PROMPT');
const PROMPT = m[1];

const cases = [
  {
    name: '旧记忆里已经有 <主人>',
    existing: '### 群友\n- <主人>：群主、服务器服主，爱指定模型让机器人做动画\n\n### 大事\n（空）',
    batch: '<主人>：用GPT6.2帮我做一个mygo代码动画\n<主人>：再做一遍，这次真的用6.1Astra做',
    want: /<主人>/,
    forbid: /新冒泡|新成员|初次出现|新来的/,
  },
  {
    name: '旧评价过期（写成了新人）',
    existing: '### 群友\n- <主人>：新人，刚加进群，还在观望\n\n### 大事\n（空）',
    batch: '<主人>：把服务器重启一下\n<主人>：上次那版的动画再改改，用 6.2 那版',
    want: /<主人>/,
    forbid: /新人|刚加进群|还在观望/,
  },
];

let bad = 0;
for (const c of cases) {
  const user = [
    `# 已经记下的（这些人你早就认识，不是新面孔）\n${c.existing}\n`,
    '# 早就认识的人（不是你这次才见到的，别写成「新冒泡的群友」「新成员」）\n- <主人>（QQ 10000001）：把机器人叫起来的人、服务器服主\n',
    `# 这批群聊记录（2 条）\n${c.batch}`,
  ].join('\n');
  const report = {};
  let text = '';
  for await (const d of streamChat(
    [
      { role: 'system', content: PROMPT },
      { role: 'user', content: user },
    ],
    undefined,
    { report, noLite: true },
  )) text += d;
  const okWant = c.want.test(text);
  const okForbid = !c.forbid.test(text);
  console.log(`\n=== ${c.name} ===`);
  console.log(text.trim().slice(0, 300));
  console.log(`用量 pt=${report.usage?.prompt_tokens} ct=${report.usage?.completion_tokens} 花费=${report.cost ?? '?'}`);
  if (!okWant || !okForbid) {
    bad++;
    console.log(`❌ want=${okWant} forbid=${okForbid}`);
  } else console.log('✅ 达标');
}
console.log(bad ? `\n${bad} 个用例不达标` : '\n全部通过');
process.exit(bad ? 1 : 0);
