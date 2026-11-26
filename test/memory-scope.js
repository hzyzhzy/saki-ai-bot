// 副号（`knowledge/accounts/<QQ>/`）的记忆页：共用那几份要能回落到共用知识目录，
// 但群记忆 / 笔记这种"每号自己的"绝不许串号。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = 'logs/__test-scope.yml';
const SHARED = 'logs/__test-scope-shared';
const PRIV = 'logs/__test-scope-priv';
mkdirSync(join(ROOT, 'logs'), { recursive: true });
writeFileSync(join(ROOT, CFG), 'llm:\n  baseURL: http://127.0.0.1:1/v1\n', 'utf8');
process.env.QQBOT_CONFIG = CFG;
process.env.QQBOT_KNOWLEDGE_DIR = SHARED;
process.env.QQBOT_ACCOUNTS_DIR = 'logs/__test-scope-accounts';
mkdirSync(join(ROOT, 'logs', '__test-scope-accounts'), { recursive: true });

const shared = join(ROOT, SHARED);
const priv = join(ROOT, PRIV);
for (const d of [shared, priv]) {
  rmSync(d, { recursive: true, force: true });
  mkdirSync(join(d, 'groups'), { recursive: true });
}

// 共用那几份
writeFileSync(
  join(shared, 'owner.md'),
  ['# <主人>', '', '## 他是谁', '- 服主', '', '<!-- OWNER-RECENT:BEGIN -->', '', '- 2026-11-27 05:05 ｜ 在弄记忆系统', '<!-- OWNER-RECENT:END -->', ''].join('\n'),
  'utf8',
);
writeFileSync(join(shared, 'memes.md'), '# 梗库\n- 大肥鱼\n', 'utf8');
writeFileSync(join(shared, 'relationship.md'), '# 关系\n', 'utf8');
// 主号自己的群记忆 / 笔记（副号**不该**看到这两份）
writeFileSync(join(shared, 'group-memory.md'), '<!-- AUTO-OBSERVE:BEGIN -->\n- 主号记的人\n<!-- AUTO-OBSERVE:END -->\n', 'utf8');
writeFileSync(join(shared, 'learned.md'), '<!-- LEARNED:BEGIN -->\n## 主号的笔记\n\n是什么：主号学的。\n<!-- LEARNED:END -->\n', 'utf8');

// 副号自己的
writeFileSync(join(priv, 'group-memory.md'), '<!-- AUTO-OBSERVE:BEGIN -->\n- 副号记的人\n<!-- AUTO-OBSERVE:END -->\n', 'utf8');
writeFileSync(join(priv, 'learned.md'), '<!-- LEARNED:BEGIN -->\n## 副号的笔记\n\n是什么：副号学的。\n<!-- LEARNED:END -->\n', 'utf8');

const { memoryOverview } = await import('../src/memory-overview.js');

const o = memoryOverview(priv);
const find = (key, name) =>
  o.sections.find((s) => s.key === key)?.items.find((i) => i.name === name);

// ① 共用的能回落：副号目录里没有 owner.md，也要看到「主人最近的近况」
const owner = find('people', 'owner.md');
assert.ok(owner, '副号也要能看到「对主人的记忆」（它落在共用目录里）');
assert.equal(owner.seg, 'OWNER-RECENT');
assert.equal(owner.count, 1);
assert.ok(find('people', 'relationship.md'), '关系那份也是共用的');
assert.ok(find('learned', 'memes.md'), '梗库也是共用的');

// ② 每号自己的绝不串号：看到的是副号那份
assert.match(find('group', 'group-memory.md').label, /共享群记忆/);
assert.equal(find('learned', 'learned.md').count, 1);
const segBody = (await import('../src/memory-overview.js')).readSegment(priv, 'learned.md', 'LEARNED').body;
assert.match(segBody, /副号学的/);
assert.equal(/主号学的/.test(segBody), false, '串到主号的笔记了');

// ③ 自己也有同名文件时，私有优先（不会被共用那份盖掉）
writeFileSync(
  join(priv, 'owner.md'),
  ['# 副号自己的', '', '<!-- OWNER-RECENT:BEGIN -->', '', '- 副号视角的一条', '<!-- OWNER-RECENT:END -->', ''].join('\n'),
  'utf8',
);
const o2 = memoryOverview(priv);
const owner2 = o2.sections.find((s) => s.key === 'people').items.find((i) => i.name === 'owner.md');
assert.ok(owner2, '有私有那份时也要列出来');
assert.match(
  (await import('../src/memory-overview.js')).readSegment(priv, 'owner.md', 'OWNER-RECENT').body,
  /副号视角的一条/,
);

for (const d of [shared, priv]) rmSync(d, { recursive: true, force: true });
console.log('✅ 副号记忆页：共用回落 / 私有优先 / 群记忆与笔记不串号 全过');
