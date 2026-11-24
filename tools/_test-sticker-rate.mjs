/**
 * 表情工具到底会不会被她自己发起？
 *
 * 做法：拿**真实的 lite.md**（原样当 system）+ **真实的 `buildTools()`**（原样当 tools），
 *       直接打本地模型，跑一批日常话术，数三件事：
 *         ① tool_calls 里有没有 `send_sticker`
 *         ② 正文里有没有 `[表情:xxx]`（老的标记路）
 *         ③ 正文里有没有 emoji（第三种"假装发了表情"）
 *
 * ⚠️ 这个脚本不发群、不碰 state，纯本地推理（不花钱）。
 * 用法：node tools/_test-sticker-rate.mjs [--n=8] [--dump]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTools } from '../src/tools-fc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const DUMP = !!args.dump;

const system = fs.readFileSync(path.join(root, 'personas', 'saki', 'prompt', 'lite.md'), 'utf8');
const tools = buildTools({});

/** 一批"真人会发、而且真人一般会顺手带个表情"的话 */
const INPUTS = [
  '今天好累啊，上了一天课',
  '你在干嘛呢',
  '哈哈哈哈哈笑死我了',
  '我明天要去医院复查，有点紧张',
  '呃……好吧',
  '你觉得我这个人怎么样',
  '（连着刷了三条一样的「在吗」）',
  '晚安，早点睡',
];

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const MARK = /\[\s*(?:表情\s*[:：]\s*)?[^\]\s]+\s*\]/;

function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 70);
}

const rows = [];
let toolHit = 0;
let markHit = 0;
let emojiHit = 0;

for (const text of INPUTS) {
  const body = {
    model: 'qwen3.5-4b',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ],
    tools,
    tool_choice: 'auto',
    max_tokens: 220,
    stream: false,
    temperature: 0.8,
  };
  let out = '';
  let calls = [];
  let usage = {};
  try {
    const r = await fetch('http://127.0.0.1:18085/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    const j = await r.json();
    const m = j.choices?.[0]?.message ?? {};
    out = String(m.content ?? '');
    calls = Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => c.function?.name) : [];
    usage = j.usage ?? {};
  } catch (e) {
    out = `（请求失败：${e.message}）`;
  }
  const hasSticker = calls.includes('send_sticker');
  const hasMark = MARK.test(out);
  const hasEmoji = EMOJI.test(out);
  if (hasSticker) toolHit++;
  if (hasMark) markHit++;
  if (hasEmoji) emojiHit++;
  rows.push({ text, calls, hasSticker, hasMark, hasEmoji, out: clean(out) });
  console.log(
    `${hasSticker ? '🔧' : '  '} ${hasMark ? '📝' : '  '} ${hasEmoji ? '😀' : '  '} | ` +
      `${text.slice(0, 18).padEnd(18)} | 工具=${calls.length ? calls.join('+') : '无'} | ${clean(out)}`,
  );
  if (DUMP) console.log(`     usage=${JSON.stringify(usage)}`);
}

const n = INPUTS.length;
console.log('\n── 统计（n=' + n + '）──');
console.log(`发起 send_sticker：${toolHit} / ${n}`);
console.log(`正文写 [表情:x]  ：${markHit} / ${n}`);
console.log(`正文用 emoji     ：${emojiHit} / ${n}`);
