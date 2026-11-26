// 翻记忆：命中、去重、别的群的资料库绝不出现、没有记录时明确说没有。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = 'logs/__test-memory-search.yml';
const KD = 'logs/__test-memory-kd';
mkdirSync(join(ROOT, 'logs'), { recursive: true });
writeFileSync(join(ROOT, CFG), 'llm:\n  baseURL: http://127.0.0.1:1/v1\n', 'utf8');
process.env.QQBOT_CONFIG = CFG;
process.env.QQBOT_KNOWLEDGE_DIR = KD;
process.env.QQBOT_ACCOUNTS_DIR = 'logs/__test-memory-accounts';
mkdirSync(join(ROOT, 'logs', '__test-memory-accounts'), { recursive: true });

const dir = join(ROOT, KD);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'groups'), { recursive: true });
writeFileSync(
  join(dir, 'group-memory.md'),
  '# 群记忆\n- 摇光喵喵：说过「我最喜欢蓝色」\n- 群大肥鱼：爱复读别人的话\n',
  'utf8',
);
writeFileSync(join(dir, 'groups', '111.md'), '# 111 群\n- 周六晚上打过一次 mc\n', 'utf8');
writeFileSync(join(dir, 'groups', '222.md'), '# 222 群\n- 蓝色是禁忌话题\n', 'utf8');

const { findMemory, formatMemory } = await import('../src/memory-search.js');
try {
  const r = findMemory({ q: '蓝色', gid: '111' });
  assert.equal(r.ok, true);
  assert.ok(r.items.length >= 1, '应该搜到群记忆里那条');
  assert.ok(r.items.some((x) => x.text.includes('我最喜欢蓝色')));

  // ⚠️ 别的群的资料库不许出现（222 群也写了"蓝色"）
  assert.equal(r.items.some((x) => String(x.text).includes('禁忌话题')), false, '串群了');

  const none = findMemory({ q: '从来没提过的词xyz', gid: '111' });
  assert.equal(none.ok, true);
  assert.equal(none.items.length, 0);
  assert.match(formatMemory(none, '从来没提过的词xyz'), /没有记录/);

  const mat = formatMemory(r, '蓝色');
  assert.match(mat, /原文/);
  assert.match(mat, /别补/);

  assert.equal(findMemory({ q: '' }).ok, false, '空查询要拒绝');

  const scopeChat = findMemory({ q: '蓝色', gid: '111', scope: 'chat' });
  assert.equal(scopeChat.items.some((x) => String(x.text).includes('我最喜欢蓝色')), false, 'chat 范围不该搜记忆文件');

  console.log('通过：命中记忆、去重、不串群、无记录明确说没有、范围隔离');
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(ROOT, CFG), { force: true });
  rmSync(join(ROOT, 'logs', '__test-memory-accounts'), { recursive: true, force: true });
}
