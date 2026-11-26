// 群记忆的分群/合并规则自测：
// ① 不同群的大事不许混进同一个文件 ② 同一个群友可以跨群参考着合并
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.QQBOT_CONFIG = 'logs/__test-observe-scope.yml';
writeFileSync(
  join(RUN, 'logs', '__test-observe-scope.yml'),
  'llm:\n  baseURL: http://127.0.0.1:1/v1\n  apiKey: "sk-test"\n  model: t\nobserve:\n  enable: true\n',
  'utf8',
);
// ⚠️ `QQBOT_KNOWLEDGE_DIR` 是"相对项目根"的约定（config.js 里 join(ROOT, …)），
//    所以用项目内的临时目录，别塞绝对路径
const REL = 'logs/__test-observe-scope-knowledge';
process.env.QQBOT_KNOWLEDGE_DIR = REL;
const dir = join(RUN, REL);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'groups'), { recursive: true });

const { __targetFileFor: targetFileFor, __merge } = await import('../src/observe.js');
try {
  const a = targetFileFor('111111111');
  const b = targetFileFor('222222222');
  assert.notEqual(a, b, '两个群必须写到不同文件');
  assert.match(a, /groups[\\/]111111111\.md$/);
  assert.match(b, /groups[\\/]222222222\.md$/);
  assert.equal(targetFileFor(''), targetFileFor(''), '无群号时仍走共享文件');

  // A 群记了 <主人> 和一件大事
  writeFileSync(
    a,
    '<!-- AUTO-OBSERVE:BEGIN -->\n### 群友\n- <主人>：群主，爱点模型名\n\n### 大事\n- 最近：A 群搞了观影会\n<!-- AUTO-OBSERVE:END -->\n',
    'utf8',
  );
  // B 群只记自己的事
  const bBody = __merge('', { people: ['<主人>：在 B 群会帮着劝架'], events: ['最近：B 群开新服'] });
  writeFileSync(b, `<!-- AUTO-OBSERVE:BEGIN -->\n${bBody}\n<!-- AUTO-OBSERVE:END -->\n`, 'utf8');

  const bt = readFileSync(b, 'utf8');
  assert.match(bt, /B 群开新服/);
  assert.doesNotMatch(bt, /A 群搞了观影会/, 'B 群文件里绝不能出现 A 群的大事');
  const at = readFileSync(a, 'utf8');
  assert.doesNotMatch(at, /B 群开新服/, 'A 群文件里也不能出现 B 群的大事');

  // 私聊记忆仍然单独一个文件（不能混进群资料库）
  assert.match(targetFileFor('dm:123456'), /dm[\\/]123456\.md$/);
  console.log('通过：群大事按群分开（A/B 互不串），私聊单独存放');
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(RUN, 'logs', '__test-observe-scope.yml'), { force: true });
}
