import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = join('personas', 'shenche');
let bad = 0;
const need = [
  'identity.json', 'persona.md', 'persona-chat.md', 'cast.md', 'life-events.md',
  'quest-ideas.md', 'prompt/system.md', 'prompt/lite.md', 'prompt/bili-comment.md',
];
for (const f of need) {
  const ok = existsSync(join(dir, f));
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${f}`);
}

const id = JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8'));
for (const k of ['id', 'name', 'selfName', 'prompt', 'address', 'style', 'qq']) {
  if (!id[k]) { console.log(`✗ identity 缺 ${k}`); bad++; }
}
if (id.id !== 'shenche') { console.log('✗ id 不对'); bad++; }

const lite = readFileSync(join(dir, 'prompt/lite.md'), 'utf8');
const liteChars = lite.replace(/<!--[\s\S]*?-->/g, '').trim().length;
console.log(`lite 正文 ${liteChars} 字（建议 ≤300，硬要求不卡）${liteChars <= 400 ? ' ✓' : ' ⚠️ 偏长'}`);

const bili = readFileSync(join(dir, 'prompt/bili-comment.md'), 'utf8').trim().length;
console.log(`bili-comment ${bili} 字（要求 ≤1500）${bili <= 1500 ? ' ✓' : ' ✗ 超长'}`);
if (bili > 1500) bad++;

// 全量人设别写古文腔的口头语（吾/汝/在下/阁下）
const persona = readFileSync(join(dir, 'persona.md'), 'utf8');
const banned = ['吾乃', '汝', '在下', '阁下'];
const hits = banned.filter((w) => persona.includes(w) && !persona.includes(`❌`));
console.log(`古风话剧词检查：${hits.length ? '⚠️ 出现 ' + hits.join('/') : '✓ 没有'}`);

console.log(bad ? `\n${bad} 项不合格` : '\n人设包齐全');
process.exit(bad ? 1 : 0);
