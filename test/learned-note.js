// 学习档案 = 她自己的笔记：三段式、来源不进正文、同一件事合并进已有那条。
// ⚠️ 这里**不调真模型**：`learn()` 接受注入的 `rewrite`（`meta.rewrite`），
//    分类那一步的 phrase 走假 baseURL（连不上 ⇒ 回落 other，正是我们要的路径）。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = 'logs/__test-learned.yml';
const KD = 'logs/__test-learned-kd';
mkdirSync(join(ROOT, 'logs'), { recursive: true });
writeFileSync(join(ROOT, CFG), 'llm:\n  baseURL: http://127.0.0.1:1/v1\n  phraseTimeoutMs: 1200\n', 'utf8');
process.env.QQBOT_CONFIG = CFG;
process.env.QQBOT_KNOWLEDGE_DIR = KD;
process.env.QQBOT_ACCOUNTS_DIR = 'logs/__test-learned-accounts';
mkdirSync(join(ROOT, 'logs', '__test-learned-accounts'), { recursive: true });

const dir = join(ROOT, KD);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const FILE = join(dir, 'learned.md');
writeFileSync(
  FILE,
  [
    '# 学习档案',
    '',
    '<!-- LEARNED:BEGIN -->',
    '## 李斯特是谁的指令',
    '',
    '是什么：`list` 和「李斯特」是群里小豆机器人的指令，用来列在线玩家。',
    '什么时候用：群里有人发这两个词时不用理，也不是在叫我。',
    '<!-- LEARNED:END -->',
    '',
  ].join('\n'),
  'utf8',
);

const { learn, listEntries, learnedText, validateFile, renderNote, topicList } = await import(
  '../src/learned.js'
);

const body = () => readFileSync(FILE, 'utf8');

// ① 渲染：空段不写
assert.equal(
  renderNote({ what: '一件事', when: '', warn: '别搞错' }),
  '是什么：一件事\n别弄错：别搞错',
);
assert.equal(renderNote({}), '');

// ② 目录摘要：去掉「是什么：」前缀
const tl = topicList();
assert.equal(tl.length, 1);
assert.equal(tl[0].title, '李斯特是谁的指令');
assert.match(tl[0].gist, /小豆机器人/);
assert.equal(tl[0].gist.startsWith('是什么'), false, '摘要不该带着字段名');

// ③ 新学一条 → 落成三段式笔记，正文里**没有**「教学录入」这种来源尾巴
const r1 = await learn('观影会报名', '超时空辉夜姬观影会 10月11日在潇湘影院，报名群 1106141967', {
  byName: '蒸虾米',
  where: '群200000006',
  rewrite: async (topic, fact) => ({
    topic: '观影会怎么报名',
    what: fact,
    when: '有人问观影会 / 报名 / 票价时',
    warn: '',
    merge: '',
  }),
});
assert.equal(r1.ok, true, r1.error);
assert.equal(r1.topic, '观影会怎么报名');
assert.equal(r1.merged, false);
const text1 = body();
assert.match(text1, /## 观影会怎么报名/);
assert.match(text1, /是什么：超时空辉夜姬/);
assert.match(text1, /什么时候用：有人问观影会/);
assert.equal(text1.includes('教学录入'), false, '来源不该写进她的笔记');
assert.equal(text1.includes('由 蒸虾米'), false);

// ④ 同一件事换个说法 → 合并进已有那条（标题不变、内容被更新）
const r2 = await learn('list 指令', '李斯特其实是小豆的指令，小祥不用理', {
  byName: '<主人>',
  rewrite: async (topic, fact) => ({
    topic: '李斯特 / list 是谁的指令',
    what: fact,
    when: '群里出现这两个词时',
    warn: '别当成对我下的指令',
    merge: '李斯特是谁的指令',
  }),
});
assert.equal(r2.ok, true, r2.error);
assert.equal(r2.merged, true, '应该合并进已有主题');
assert.equal(r2.topic, '李斯特是谁的指令');
const entries = listEntries();
assert.equal(entries.length, 2, '合并之后不该多出一条');
const merged = entries.find((e) => e.title === '李斯特是谁的指令');
assert.match(merged.body, /别弄错：别当成对我下的指令/);

// ⑤ 改写失败（模型编坏 / 超时）→ 照原话记下来，绝不丢
const r3 = await learn('临时通知', '今晚服务器重启', {
  rewrite: async () => {
    throw new Error('模型挂了');
  },
});
assert.equal(r3.ok, true, '改写失败也要写进去');
assert.match(body(), /今晚服务器重启/);

// ⑥ 按需挑：沾边的才带上（标题滑窗，2 字起）
const hit = learnedText('观影会要多少钱');
assert.match(hit, /观影会怎么报名/);
assert.equal(hit.includes('小豆机器人'), false, '不该带上不沾边的那条');
assert.equal(learnedText('今天天气不错'), '', '一条都不沾边就返回空串');

// ⑦ 界面校验：正常文件能过；标记被删要拒绝
assert.equal(validateFile(body()).ok, true);
assert.equal(validateFile('# 学习档案\n## x\n正文').ok, false);

rmSync(dir, { recursive: true, force: true });
console.log('✅ 学习笔记：三段式渲染 / 来源不进正文 / 同义合并 / 改写失败回落 / 按需挑 全过');
