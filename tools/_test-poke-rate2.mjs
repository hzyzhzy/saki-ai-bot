/**
 * 回戳消融第二轮：**fake 消息体里带不带动作文案**。
 *
 * 时间线：历史自发回戳 5 次（11-19 ~ 11-22 15:25），那几次的 user 正文都是
 * **裸 `[戳一戳]`**；11-22 为了修「说戳不说捏」把正文改成 `[戳一戳·捏了捏的脸]`，
 * 之后两个月零调用。怀疑：正文里已经写了动作 ⇒ 4B 认为"用话回应就够"，
 * 不再想到去调工具还手（动作信息在 system 的 pokeBlock 里也有了，重复一份）。
 *
 *   E 带动作（现状）`[戳一戳·捏了捏的脸]`
 *   D 裸（以前）    `[戳一戳]`   + pokeBlock 照旧给动作
 *
 * ⚠️ 只做诊断。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTools } from '../src/tools-fc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const lite = fs.readFileSync(path.join(root, 'personas', 'saki', 'prompt', 'lite.md'), 'utf8');
const tools = buildTools({});

function pokeBlock(who, uid, act) {
  return [
    '',
    '# 有人戳了你一下',
    `是**${who}（QQ ${uid}）**戳的 —— 就这一个人，别安到别人头上。`,
    act
      ? `他用的动作是「**${act}**」—— 这是 QQ 戳一戳的自定义文案，原文就这几个字，不是你翻译的。`
      : '他不是打了字，是伸手戳了你一下。',
    '',
    '怎么回：',
    '- **接住那个动作本身**：他捏你脸你就说捏脸的事，拍你你就说拍，别笼统地说"被戳了一下"。',
    '- 一两句就够，十几二十个字。',
    '- 别每次回同一句。',
  ].join('\n');
}

const ACTS = [
  '捏了捏的脸',
  '拍了拍',
  '戳了戳',
  '拍了拍的脑袋，拍出了脑花',
  '捏了捏的，中毒了！！！',
  '戳了戳的脑子，我开启了杀戮',
];

const sys = lite + pokeBlock('Anon', '10000013', '捏了捏的脸');

async function suite(label, mkUser) {
  let hit = 0;
  const marks = [];
  for (const act of ACTS) {
    try {
      const r = await fetch('http://127.0.0.1:18085/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.5-4b',
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: mkUser(act) },
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
      const isPoke = calls.includes('poke_back');
      if (isPoke) hit++;
      marks.push(isPoke ? '🔧' : '·');
    } catch {
      marks.push('✗');
    }
  }
  console.log(`${label.padEnd(26)} poke_back ${hit}/${ACTS.length} | ${marks.join(' ')}`);
}

await suite('E 带动作（现状）', (a) => `【Anon】[戳一戳·${a}]`);
await suite('D 裸 [戳一戳]（以前）', () => `【Anon】[戳一戳]`);
