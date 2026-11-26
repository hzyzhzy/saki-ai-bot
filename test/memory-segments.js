// 记忆页的「区段」：只读那一段、只写那一段，别的东西一个字都不许动。
// ⚠️ 三个真坑都在这里钉住：
//   ① 说明行里同时提到 BEGIN/END（拿来给人对照）—— 不许被当成真标记
//   ② 真标记行前面挂着半句文案（`> ⚠️ … ✗ <!-- OWNER-RECENT:BEGIN（…）-->`）、后面拖着 ` ---`
//   ③ 读了就存回去，文件不许悄悄多出空行
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = 'logs/__test-seg.yml';
const KD = 'logs/__test-seg-kd';
mkdirSync(join(ROOT, 'logs'), { recursive: true });
writeFileSync(join(ROOT, CFG), 'llm:\n  baseURL: http://127.0.0.1:1/v1\n', 'utf8');
process.env.QQBOT_CONFIG = CFG;
process.env.QQBOT_KNOWLEDGE_DIR = KD;
process.env.QQBOT_ACCOUNTS_DIR = 'logs/__test-seg-accounts';
mkdirSync(join(ROOT, 'logs', '__test-seg-accounts'), { recursive: true });

const dir = join(ROOT, KD);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// 故意做成和真实文件一样难缠：说明行同时提到两个标记；BEGIN 前挂文案；END 后拖尾巴
const OWNER = [
  '# <主人> · 专属知识',
  '',
  '> 标记写法是 `<!-- OWNER-RECENT:BEGIN -->` 到 `<!-- OWNER-RECENT:END -->`，别删。',
  '',
  '## 他是谁',
  '',
  '- 服主本人',
  '',
  '> 上面这句后面挂着说明 ✗ <!-- OWNER-RECENT:BEGIN（这一段是机器人自己维护的，别手改）-->',
  '',
  '- 2026-11-27 05:05 ｜ 他在看记忆架构的视频',
  '- 2026-11-26 23:36 ｜ 他在试 Astra 做代码动画',
  '',
  '<!-- OWNER-RECENT:END -->',
  '',
  '## 别的资料',
  '',
  '- 这一段绝对不许被改动',
  '',
].join('\n');
writeFileSync(join(dir, 'owner.md'), OWNER, 'utf8');

const { readSegment, replaceSegment, memoryOverview, EDITABLE_SEGMENTS } = await import(
  '../src/memory-overview.js'
);

// ① 取到的正好是段内正文（不是说明行那半截）
const seg = readSegment(dir, 'owner.md', 'OWNER-RECENT');
assert.ok(seg, '应该能取到这一段');
assert.equal(seg.body.includes('2026-11-27 05:05'), true);
assert.equal(seg.body.includes('别的资料'), false, '段外的东西不许混进来');
assert.equal(seg.body.includes('标记写法是'), false, '说明行不许被当成段内正文');

// ② 幂等：读出来原样写回，文件一个字节都不变（不许悄悄多空行）
assert.equal(replaceSegment(OWNER, 'OWNER-RECENT', seg.body), OWNER);

// ③ 换内容：BEGIN 行（含前面那半句文案）与 END 行原样保留，段外一字不动
const next = replaceSegment(OWNER, 'OWNER-RECENT', '- 2026-11-27 06:00 ｜ 换了内容');
assert.match(next, /> 上面这句后面挂着说明 ✗ <!-- OWNER-RECENT:BEGIN（这一段是机器人自己维护的，别手改）-->/);
assert.match(next, /<!-- OWNER-RECENT:END -->/);
assert.match(next, /- 2026-11-27 06:00 ｜ 换了内容/);
assert.equal(next.includes('他在看记忆架构的视频'), false, '旧内容该被换掉');
assert.match(next, /- 这一段绝对不许被改动/, '段外的资料必须还在');
assert.match(next, /## 他是谁/, '段外的标题必须还在');
// 再读回来（落盘之后再读，才是真实那条路），读到的就是新内容
writeFileSync(join(dir, 'owner.md'), next, 'utf8');
const again = readSegment(dir, 'owner.md', 'OWNER-RECENT');
assert.match(again.body, /06:00/);

// ④ 文件里没有这一段 ⇒ null（不许凭空造）
assert.equal(readSegment(dir, 'owner.md', 'NOT-THERE'), null);
assert.equal(replaceSegment(OWNER, 'NOT-THERE', 'x'), null);

// ⑤ 只有白名单里的段能改（群印象是自动维护的，界面只给看）
assert.equal(EDITABLE_SEGMENTS.has('OWNER-RECENT'), true);
assert.equal(EDITABLE_SEGMENTS.has('LEARNED'), true);
assert.equal(EDITABLE_SEGMENTS.has('AUTO-OBSERVE'), false, '群印象不许从界面改');

// ⑥ 记忆页清单：主人那段以「区段」形式出现，并且**不会**把整份 owner.md 当记忆列出来
const o = memoryOverview(dir);
const people = o.sections.find((s) => s.key === 'people');
const own = people.items.find((i) => i.name === 'owner.md');
assert.ok(own, '「对主人的记忆」必须出现在清单里');
assert.equal(own.seg, 'OWNER-RECENT');
assert.equal(own.count, 1, '换成一条之后就只该算一条');

// ⑦ 她的笔记按 `## 主题` 数条（不是按 `- `），而且说明行里的标记也不许被当成真标记
const LEARNED = [
  '# 她的笔记',
  '',
  '> 标记是 `<!-- LEARNED:BEGIN -->` / `<!-- LEARNED:END -->`，别删。',
  '',
  '<!-- LEARNED:BEGIN -->',
  '## 观影会怎么报名',
  '',
  '是什么：10 月 11 日潇湘影院。',
  '',
  '## 上游风控关了',
  '',
  '是什么：那层 API 已经关了。',
  '<!-- LEARNED:END -->',
  '',
].join('\n');
writeFileSync(join(dir, 'learned.md'), LEARNED, 'utf8');
const note = memoryOverview(dir)
  .sections.find((s) => s.key === 'learned')
  .items.find((i) => i.name === 'learned.md');
assert.ok(note, '「她的笔记」必须出现在清单里');
assert.equal(note.seg, 'LEARNED');
assert.equal(note.count, 2, '两条笔记');
assert.equal(note.readonly, undefined, '笔记是可改的（群印象才是只读）');
assert.equal(
  replaceSegment(LEARNED, 'LEARNED', readSegment(dir, 'learned.md', 'LEARNED').body),
  LEARNED,
);

rmSync(dir, { recursive: true, force: true });
console.log('✅ 记忆区段：取段准确 / 幂等 / 只换中间 / 段外不动 / 白名单 / 清单正确 / 笔记数条 全过');
