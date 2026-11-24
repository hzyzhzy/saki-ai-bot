/**
 * 回戳（`poke_back`）为什么不自发调用了。
 *
 * 时间线：历史 5 次成功调用集中在 11-19 ~ 11-22 15:25，之后再没调过；
 * 而 `prompt-lite.js` 的 `pokeBlock()` 是 **11-22 加的**，内容只教"用话接住"，
 * 还挂在提示词**最末尾**（权重最高）—— 怀疑它把静态区那条「想真还手就调戳回去」盖掉了。
 *
 *   A 现状（pokeBlock 原样，只说用话接住）
 *   B pokeBlock 末尾补一句"想还手就调 poke_back"
 *   C 明确要求（证"会调"，排除工具坏掉）
 *
 * ⚠️ 只做诊断，不改文件、不发群。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTools } from '../src/tools-fc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const lite = fs.readFileSync(path.join(root, 'personas', 'saki', 'prompt', 'lite.md'), 'utf8');
const tools = buildTools({});

/** 真实 `pokeBlock()` 的文案（从源码抄的，改那边记得同步） */
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

const EXTRA = `
- **想真还手就调 \`poke_back\`** —— 那是让系统真的把这一下还回去，不是你在嘴上说还手。`;

const ACTS = [
  ['捏了捏的脸', '捏了捏的脸'],
  ['拍了拍', '拍了拍'],
  ['戳了戳', '戳了戳'],
  ['拍了拍的脑袋，拍出了脑花', '拍了拍的脑袋，拍出了脑花'],
  ['捏了捏的，中毒了！！！', '捏了捏的，中毒了！！！'],
  ['戳了戳的脑子，我开启了杀戮', '戳了戳的脑子，我开启了杀戮'],
];

async function suite(label, sys, userPrefix = '') {
  let hit = 0;
  const marks = [];
  for (const [act] of ACTS) {
    const user = userPrefix || `【Anon】[戳一戳·${act}]`;
    try {
      const r = await fetch('http://127.0.0.1:18085/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.5-4b',
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user },
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
      marks.push(isPoke ? '🔧' : calls.length ? `(${calls[0]})` : '·');
    } catch {
      marks.push('✗');
    }
  }
  console.log(`${label.padEnd(22)} poke_back ${hit}/${ACTS.length} | ${marks.join(' ')}`);
}

const a = lite + pokeBlock('Anon', '10000013', '捏了捏的脸');
await suite('A 现状', a);
await suite('B +还手一句', a + EXTRA);
await suite('C 明确要求', a, `【Anon】[戳一戳·捏了捏的脸] 你也戳我一下`);
