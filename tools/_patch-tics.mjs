import { readFileSync, writeFileSync } from 'node:fs';

const p = 'src/bot.js';
let t = readFileSync(p, 'utf8');

const anchor = '      parts.push(\r\n        [\r\n          "\\n# 【说话方式：语气词一个都不许省】",';
if (!t.includes(anchor)) throw new Error('找不到锚点');

const replacement = [
  '      /* ⚠️⚠️ 2026-11-27：**这段按人设决定注入哪一种**。',
  '       *    默认（活泼人设）照旧 —— 语气词是她们的活人味。',
  '       *    但人设明确声明「不用语气词」时（`identity.style.noVerbalTics`，比如古风寡言的沈策），',
  '       *    换成反向说明；否则"语气词一个都不许省"会把这个人的语体顶掉',
  '       *    （实测原话：「问吧，我听着呀」「没干什么，躺着呢」—— 人设白写 ✗） */',
  '      const _noTics = (() => {',
  '        try {',
  '          return persona.style?.()?.noVerbalTics === true;',
  '        } catch {',
  '          return false;',
  '        }',
  '      })();',
  '      parts.push(',
  "        _noTics",
  '          ? [',
  "              '\\n# 【说话方式：按人设来，**不加语气词**】',",
  "              '',",
  "              '⚠️ 这个人设说话**不挂语气词**（呀 / 嘛 / 啦 / 呗 / 哦 / 诶 / 捏 一个都不加），',",
  "              '也**不用网络口语**（牙白 / 绝了 / 破防 / 好家伙 / 绷不住）。',",
  "              '短、干净、带点古意 —— 句子具体长什么样，看下面的人设正文，**以人设为准**。',",
  "              '- 🚫 别为了「显得像活人」去加语气词：这个人设的活人味在**语气硬、话短、判断准**上。',",
  "              '- 🚫 也别写句尾那个「（」梗。',",
  "            ].join('\\n')",
  "          : [",
  '          "\\n# 【说话方式：语气词一个都不许省】",',
].join('\r\n');

t = t.replace(anchor, replacement);

// 原来的 `].join("\n"),` 收尾要跟着变（只改紧跟这段的那个）
const tailAnchor = '          🚫 别写身体动作（那是舞台指示，不是二次元）；也别写成对括号包旁白，也别写 `*笑*`。\r\n        ].join("\\n"),\r\n      );';
const tailNew = '          🚫 别写身体动作（那是舞台指示，不是二次元）；也别写成对括号包旁白，也别写 `*笑*`。\r\n          ].join("\\n"),\r\n      );';
if (!t.includes(tailAnchor)) throw new Error('找不到收尾锚点');
t = t.replace(tailAnchor, tailNew);

writeFileSync(p, t, 'utf8');
console.log('已按人设分流语气词那段');
