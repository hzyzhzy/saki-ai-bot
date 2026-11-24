/**
 * 回戳消融第三轮：**把"还手"写成默认动作**，而不是"想还手才调"。
 *
 * 前两轮结论：A 现状 0/6、B「想真还手就调」0/6、C 明确要求 5/6
 * ⇒ 4B 能执行、不会自己想到。4B 对**否定式/条件式**（"想…就…"）响应差，
 *    对**默认动作**（"先做 X 再说 Y"）响应好得多。
 *
 *   G「还手是默认的：被戳了先调 poke_back 再说话」
 *   H G + 明确"只有懒得理他才不动手"
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

function pokeBlock(act = '捏了捏的脸') {
  return [
    '',
    '# 有人戳了你一下',
    `是**Anon（QQ 10000013）**戳的 —— 就这一个人，别安到别人头上。`,
    `他用的动作是「**${act}**」—— 这是 QQ 戳一戳的自定义文案，原文就这几个字，不是你翻译的。`,
    '',
    '怎么回：',
    '- **接住那个动作本身**：他捏你脸你就说捏脸的事，拍你你就说拍，别笼统地说"被戳了一下"。',
    '- 一两句就够，十几二十个字。',
    '- 别每次回同一句。',
  ].join('\n');
}

const G = `
- **还手是默认的**：被戳了就先调 \`poke_back\` 把那一下还回去，再回你的话。`;
const H = `
- **还手是默认的**：被戳了就先调 \`poke_back\` 把那一下还回去，再回你的话。
  只有你确实懒得理他，才只回一句、不动手。`;

const ACTS = [
  '捏了捏的脸',
  '拍了拍',
  '戳了戳',
  '拍了拍的脑袋，拍出了脑花',
  '捏了捏的，中毒了！！！',
  '戳了戳的脑子，我开启了杀戮',
];

const base = lite + pokeBlock();

async function suite(label, sys) {
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
            { role: 'user', content: `【Anon】[戳一戳·${act}]` },
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
      const ok = calls.includes('poke_back');
      if (ok) hit++;
      marks.push(ok ? '🔧' : '·');
    } catch {
      marks.push('✗');
    }
  }
  console.log(`${label.padEnd(22)} poke_back ${hit}/${ACTS.length} | ${marks.join(' ')}`);
}

await suite('A 现状（对照）', base);
await suite('G 还手是默认的', base + G);
await suite('H G+懒得理例外', base + H);
