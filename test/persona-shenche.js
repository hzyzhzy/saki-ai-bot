// 人设包能被代码真正加载：切到 shenche，读 identity / 人设正文 / 名册。
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = 'logs/__test-persona-shenche.yml';
const ACC = 'logs/__test-persona-shenche-accounts';
mkdirSync(join(ROOT, ACC), { recursive: true });
writeFileSync(
  join(ROOT, CFG),
  [
    'llm:',
    '  baseURL http://127.0.0.1:1/v1',
    'persona:',
    '  id: shenche',
    '',
  ].join('\n').replace('baseURL http', 'baseURL: http'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG;
// ⚠️ 主号账号文件里有 persona.id: saki，会盖掉顶层 ⇒ 账号目录也要隔离
process.env.QQBOT_ACCOUNTS_DIR = ACC;

const persona = await import('../src/persona.js');
const knowledge = await import('../src/knowledge.js');
try {
  assert.equal(String(persona.charName()), '沈策', '读不到沈策 = 没切到这个人设包');
  assert.ok(persona.callNames().includes('沈策'));
  assert.ok(persona.nicknames().includes('断眉'));
  console.log(`identity：${persona.charName()} / 叫法 ${persona.callNames().join('、')} ✓`);

  const text = String(knowledge.personaText?.() ?? '');
  assert.ok(text.includes('沈策'), '人设正文（persona.md）没被读到');
  assert.ok(text.includes('结案'), 'persona.md 里那段没被读到');
  const chat = String(knowledge.knowledgeText?.({ groupId: '' }) ?? '');
  assert.ok(chat.includes('沈策') || chat.includes('屋里'), '知识库注入里没有这个人设的内容');
  console.log(`persona.md ${text.length} 字、注入合计 ${chat.length} 字，都含沈策 ✓`);
  console.log('加载通过');
} finally {
  rmSync(join(ROOT, CFG), { force: true });
  rmSync(join(ROOT, ACC), { recursive: true, force: true });
}
