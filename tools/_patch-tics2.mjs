// 把「语气词一个都不许省」那段改成按人设分流：
//   identity.style.noVerbalTics === true（古风寡言的人设）⇒ 换成"按人设来，不加语气词"
//   其余人设 ⇒ 原文原样保留（一个字都不改）
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'src/bot.js';
const t0 = readFileSync(p, 'utf8');

const startKey = '要模仿戳一戳对语气词的规定';
const endKey = '也别写成对括号包旁白';

const si = t0.indexOf(startKey);
const ei = t0.indexOf(endKey);
if (si < 0 || ei < 0) throw new Error('锚点找不到');

// 整段：从那条注释所在行的开头，到 ].join("\n"),\r\n      );
const lineStart = t0.lastIndexOf('\n', si) + 1;
const tail = '        ].join("\\n"),\r\n      );';
const tailAt = t0.indexOf(tail, ei);
if (tailAt < 0) throw new Error('收尾找不到');
const segEnd = tailAt + tail.length;

const original = t0.slice(lineStart, segEnd);

const noTicsBranch = [
  '      /* ⚠️⚠️ 2026-11-27：**这段按人设分流**。',
  '       *    默认（活泼人设）照旧 —— 语气词是她们的活人味；',
  '       *    但人设声明了 `identity.style.noVerbalTics`（古风寡言那种）时换成反向说明，',
  '       *    否则"语气词一个都不许省"会把这个人的语体顶掉，人设等于白写',
  '       *    （实测原话：「问吧，我听着呀」「没干什么，躺着呢」）。 */',
  '      const _noTics = (() => {',
  '        try {',
  '          return persona.style?.()?.noVerbalTics === true;',
  '        } catch {',
  '          return false;',
  '        }',
  '      })();',
  '      if (_noTics) {',
  '        parts.push(',
  "          [",
  "            '\\n# 【说话方式：按人设来，**不加语气词**】',",
  "            '',",
  "            '⚠️ 这个人设说话**不挂语气词**（呀 / 嘛 / 啦 / 呗 / 哦 / 诶 / 捏 一个都不加），',",
  "            '也**不用网络口语**（牙白 / 绝了 / 破防 / 好家伙 / 绷不住），不写句尾那个「（」梗。',",
  "            '短、干净、带点古意 —— 句子具体长什么样**看下面的人设正文，以人设为准**。',",
  "            '- 🚫 别为了「显得像活人」去加语气词：这个人设的活人味在**语气硬、话短、判断准**上。',",
  "          ].join('\\n'),",
  '        );',
  '      } else {',
  original,
  '      }',
].join('\r\n');

let t = t0.slice(0, lineStart) + noTicsBranch + t0.slice(segEnd);

writeFileSync(p, t, 'utf8');
console.log('已改：语气词段按人设分流（长度', t.length, '）');
