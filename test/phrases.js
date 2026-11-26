// 口癖库（两段）：人工底本自动流程不许动；自动段新词追加、同词只完善用法；两段都能手改。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = 'logs/__test-phrases.yml';
const KD = 'logs/__test-phrases-kd';
mkdirSync(join(ROOT, 'logs'), { recursive: true });
writeFileSync(join(ROOT, CFG), 'llm:\n  baseURL: http://127.0.0.1:1/v1\n', 'utf8');
process.env.QQBOT_CONFIG = CFG;
process.env.QQBOT_KNOWLEDGE_DIR = KD;
process.env.QQBOT_ACCOUNTS_DIR = 'logs/__test-phrases-accounts';
mkdirSync(join(ROOT, 'logs', '__test-phrases-accounts'), { recursive: true });

const dir = join(ROOT, KD);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const p = await import('../src/phrases.js');

const MANUAL = [
  '# 口癖库',
  '',
  '<!-- PHRASES:BEGIN -->',
  '',
  '- 牛逼 ｜ 想夸就一个词',
  '- 滚 ｜ 把话推回去',
  '',
  '<!-- PHRASES:END -->',
  '',
  '## 自动攒的',
  '',
  '<!-- PHRASES-AUTO:BEGIN -->',
  '<!-- PHRASES-AUTO:END -->',
  '',
].join('\n');

// ① 空库：不注入
rmSync(join(dir, 'phrases.md'), { force: true });
assert.equal(p.phrasesBlock(), '');

// ② 人工底本：读得到
writeFileSync(join(dir, 'phrases.md'), MANUAL, 'utf8');
assert.deepEqual(p.listPhrases().map((x) => x.word), ['牛逼', '滚']);
assert.equal(p.readAuto(), '');

// ③ 新词追加到**自动段**（不碰人工段）
const r1 = p.addPhrases([{ word: '牛魔', how: '谐音梗，被逗烦了甩一个' }]);
assert.equal(r1.ok, true);
assert.equal(r1.added, 1);
let text = readFileSync(join(dir, 'phrases.md'), 'utf8');
const manualPart = text.slice(text.indexOf('<!-- PHRASES:BEGIN -->'), text.indexOf('<!-- PHRASES:END -->'));
assert.match(manualPart, /- 牛逼 ｜ 想夸就一个词/, '人工底本一个字不该动');
assert.match(text, /牛魔/, '新词该进自动段');
const autoPart = text.slice(text.indexOf('<!-- PHRASES-AUTO:BEGIN -->'), text.indexOf('<!-- PHRASES-AUTO:END -->'));
assert.match(autoPart, /牛魔/, '新词必须在自动段里');

// ④ 人工底本里的词：自动流程**不许动**（不新增、不改用法）
const r2 = p.addPhrases([{ word: '牛逼', how: '换个说法也不行' }, { word: '滚', how: '也不许' }]);
assert.equal(r2.added, 0);
assert.equal(r2.improved, 0);
text = readFileSync(join(dir, 'phrases.md'), 'utf8');
assert.match(text, /- 牛逼 ｜ 想夸就一个词/, '人工底本被改了 ✗');
assert.equal(p.listPhrases().filter((x) => x.word === '牛逼').length, 1, '不该多出一条');

// ⑤ 自动段里同词：**完善用法**（不出第二行）
const r3 = p.addPhrases([{ word: '牛魔', how: '被反复捏到烦的时候甩一个，别连成一句脏话' }]);
assert.equal(r3.added, 0, '同词不该再加一行');
assert.equal(r3.improved, 1, '同词应该完善用法');
const nm = p.listPhrases().find((x) => x.word === '牛魔');
assert.match(nm.how, /被反复捏/, '用法没被完善');
assert.equal(p.listPhrases().filter((x) => x.word === '牛魔').length, 1);

// ⑥ 注入块：两段都在，且自动段有单独一句提示
const block = p.phrasesBlock();
assert.match(block, /牛逼/);
assert.match(block, /牛魔/);
assert.match(block, /最近群里新起来的说法/);
assert.match(block, /别把它当清单念/);

// ⑦ 手改（界面就这条路）：删掉自动段的词 ⇒ 注入跟着变
writeFileSync(join(dir, 'phrases.md'), text.replace(/^- 牛魔.*\n/m, ''), 'utf8');
assert.equal(p.phrasesBlock().includes('牛魔'), false);

// ⑧ 坏文件（只有说明、没标记）⇒ 不崩、不注入
writeFileSync(join(dir, 'phrases.md'), '# 空壳\n\n> 还没写\n', 'utf8');
assert.equal(p.listPhrases().length, 0);
assert.equal(p.phrasesBlock(), '');

rmSync(dir, { recursive: true, force: true });
console.log('✅ 口癖库：人工底本不动 / 新词进自动段 / 同词只完善用法 / 两段都可手改 / 坏文件不崩 全过');
