// 日记：一天一篇、她自己写、只在有材料时写、写过的不会重写。
// ⚠️ 这里**不调模型**（`writeDiary` 可以注入 `phrase`），所以断言是确定的。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = 'logs/__test-diary.yml';
const KD = 'logs/__test-diary-kd';
mkdirSync(join(ROOT, 'logs'), { recursive: true });
writeFileSync(join(ROOT, CFG), 'llm:\n  baseURL: http://127.0.0.1:1/v1\n', 'utf8');
process.env.QQBOT_CONFIG = CFG;
process.env.QQBOT_KNOWLEDGE_DIR = KD;
process.env.QQBOT_ACCOUNTS_DIR = 'logs/__test-diary-accounts';
mkdirSync(join(ROOT, 'logs', '__test-diary-accounts'), { recursive: true });

const dir = join(ROOT, KD);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'groups'), { recursive: true });

const diary = await import('../src/diary.js');
const TODAY = '2026-11-27';
const now = new Date(2026, 10, 27, 23, 45, 0); // 2026-11-27 23:45 本地时间

// ① 没有材料就不写（不能凭空编一篇"今天很开心"）
const none = await diary.writeDiary({ now, phrase: async () => '# 不该被调用' });
assert.equal(none.ok, false);
assert.equal(none.reason, '今天没有可写的材料');
assert.equal(existsSync(join(dir, 'diary', `${TODAY}.md`)), false, '没材料却写出文件了');

// ② 有材料（主人近况里有今天的条目）→ 写出来
writeFileSync(
  join(dir, 'owner.md'),
  [
    '# <主人>',
    '',
    '<!-- OWNER-RECENT:BEGIN -->',
    '',
    '- 2026-11-27 05:05 ｜ 在改记忆系统，把学习档案换成了笔记',
    '- 2026-11-26 23:36 ｜ 昨天的事，不该进今天的日记',
    '<!-- OWNER-RECENT:END -->',
    '',
  ].join('\n'),
  'utf8',
);

let seen = '';
const r1 = await diary.writeDiary({
  now,
  phrase: async (p) => {
    seen = p.user;
    return '今天他把学习档案换掉了，说原来的太机械。我听着，觉得这话有点道理。';
  },
});
assert.equal(r1.ok, true, r1.reason);
assert.equal(r1.date, TODAY);
const text = readFileSync(join(dir, 'diary', `${TODAY}.md`), 'utf8');
assert.match(text, new RegExp(`^# ${TODAY} 星期`), '文件头要写日期和星期');
assert.match(text, /学习档案换掉了/, '正文要写进去');
// 材料里只该有今天那条，昨天那条不许混进来
assert.match(seen, /在改记忆系统/);
assert.equal(seen.includes('昨天的事'), false, '昨天的条目混进今天的材料了');

// ③ 已经写过 ⇒ 不再写（除非 force）
const again = await diary.writeDiary({ now, phrase: async () => '换一段' });
assert.equal(again.ok, false);
assert.equal(again.reason, '今天已经写过');
assert.match(readFileSync(join(dir, 'diary', `${TODAY}.md`), 'utf8'), /学习档案换掉了/);

const forced = await diary.writeDiary({ now, force: true, phrase: async () => '重写了一段' });
assert.equal(forced.ok, true);
assert.match(readFileSync(join(dir, 'diary', `${TODAY}.md`), 'utf8'), /重写了一段/);

// ④ 列表：新的在前，desc 是正文第一行
writeFileSync(join(dir, 'diary', '2026-11-26.md'), '# 2026-11-26 星期四\n\n昨天那篇的第一句。\n', 'utf8');
const list = diary.listDiaries(10);
assert.equal(list[0].date, TODAY, '新的在最前面');
assert.equal(list[1].date, '2026-11-26');
assert.equal(list[1].desc, '昨天那篇的第一句。');
assert.equal(list[0].name, `diary/${TODAY}.md`, '名字要带 diary/ 前缀（界面拿它去 switch 读写接口）');

// ⑤ 最近一篇能读出来（给她"我还记得昨天写过什么"用）
const latest = diary.latestDiary();
assert.equal(latest.date, TODAY);
assert.match(latest.text, /重写了一段/);

// ⑥ 模型抽风（返回空 / 只返回个标题）⇒ 不写坏文件
rmSync(join(dir, 'diary', `${TODAY}.md`));
const empty = await diary.writeDiary({ now, phrase: async () => '   ' });
assert.equal(empty.ok, false);
assert.equal(existsSync(join(dir, 'diary', `${TODAY}.md`)), false);

const titled = await diary.writeDiary({
  now,
  phrase: async () => '# 我自己加的标题\n\n这才是正文。',
});
assert.equal(titled.ok, true);
assert.match(readFileSync(join(dir, 'diary', `${TODAY}.md`), 'utf8'), /这才是正文/);
// 只该有一个 `# 日期` 头，模型那层标题要被剥掉
assert.equal(
  readFileSync(join(dir, 'diary', `${TODAY}.md`), 'utf8').split('# ').length - 1,
  1,
  '文件头只该有一个标题行',
);

rmSync(dir, { recursive: true, force: true });
console.log('✅ 日记：没材料不写 / 只取当天的材料 / 写过不重写 / force 重写 / 列表与最近一篇 / 空输出防坏文件 全过');
