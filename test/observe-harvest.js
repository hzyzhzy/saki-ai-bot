// 群观察顺手抽知识：不 @ 也能学。
// ⚠️ 这里**不调模型**：只验两件纯函数 —— 模型输出的分节解析、`主题｜内容` 的拆分。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = 'logs/__test-harvest.yml';
mkdirSync(join(ROOT, 'logs'), { recursive: true });
writeFileSync(join(ROOT, CFG), 'llm:\n  baseURL: http://127.0.0.1:1/v1\n', 'utf8');
process.env.QQBOT_CONFIG = CFG;
process.env.QQBOT_KNOWLEDGE_DIR = 'logs/__test-harvest-kd';
process.env.QQBOT_ACCOUNTS_DIR = 'logs/__test-harvest-accounts';
mkdirSync(join(ROOT, 'logs', '__test-harvest-kd'), { recursive: true });
mkdirSync(join(ROOT, 'logs', '__test-harvest-accounts'), { recursive: true });

const { __parseSections, splitNoteLine } = await import('../src/observe.js');

// ① 三节都能解析；「值得记住」的东西**不许**混进群友 / 大事
const raw = [
  '### 群友',
  '- 摇光喵喵：喜欢喵喵叫，问他游戏就话多',
  '### 大事',
  '- 最近：群里因为发链接被管理员提醒了一次',
  '### 值得记住',
  '- 群里禁发链接｜发链接会被管理员提醒，要发就先问一句',
  '- 服务器版本｜现在支持 Fabric 了',
].join('\n');
const p = __parseSections(raw);
assert.equal(p.people.length, 1);
assert.equal(p.events.length, 1);
assert.equal(p.notes.length, 2, '两条都该进 notes');
assert.equal(p.events.some((e) => e.includes('禁发链接')), false, '知识混进大事了');
assert.equal(p.people.some((e) => e.includes('Fabric')), false, '知识混进群友了');

// ② 「无」不算一条
assert.equal(__parseSections('### 值得记住\n- 无').notes.length, 0);
assert.equal(__parseSections('### 值得记住\n无').notes.length, 0);

// ③ 最多 2 条（防止模型一口气写十条灌进来）
const many = ['### 值得记住', ...Array.from({ length: 5 }, (_, i) => `- 主题${i}｜内容第${i}条`)].join('\n');
assert.equal(__parseSections(many).notes.length, 2);

// ④ 老格式（只有两节）照旧解析，notes 空
const old = '### 群友\n- <主人>：服主\n### 大事\n- 最近：改了个设置';
const o = __parseSections(old);
assert.equal(o.people.length, 1);
assert.equal(o.events.length, 1);
assert.equal(o.notes.length, 0);

// ⑤ 「主题｜内容」拆分：全角竖线 / 半角竖线都认；没有分隔符 / 太短的丢掉
assert.deepEqual(splitNoteLine('- 群里禁发链接｜发链接会被提醒'), {
  topic: '群里禁发链接',
  fact: '发链接会被提醒',
});
assert.deepEqual(splitNoteLine('服务器版本|现在支持 Fabric 了'), {
  topic: '服务器版本',
  fact: '现在支持 Fabric 了',
});
assert.equal(splitNoteLine('没有竖线的一句话'), null);
assert.equal(splitNoteLine('a｜b'), null, '太短的别记');

// ⑥ 落盘：走 learn，但**已有同名主题就跳过**（观察抽的不如人亲口教的准，不许覆盖）
const { harvestNotes } = await import('../src/memory-harvest.js');
const calls = [];
const fakeLearn = async (topic, fact) => {
  calls.push({ topic, fact });
  return { ok: true, topic, file: 'learned.md' };
};
const got = await harvestNotes(
  [
    { gid: '111', items: ['群里禁发链接｜发链接会被管理员提醒', '服务器版本｜现在支持 Fabric 了'] },
    { gid: '222', items: ['服务器版本｜重复的主题不该再写一遍'] },
  ],
  { learn: fakeLearn, titles: [] },
);
assert.equal(got, 2, '两条新的应该都写进去');
assert.deepEqual(
  calls.map((c) => c.topic),
  ['群里禁发链接', '服务器版本'],
  '第二条重复主题要跳过',
);

const again = await harvestNotes([{ gid: '111', items: ['群里禁发链接｜又说了一遍'] }], {
  learn: fakeLearn,
  titles: ['群里禁发链接'],
});
assert.equal(again, 0, '已经有这条主题了，不该再写');
assert.equal(calls.length, 2, '不该多调一次 learn');

// ⑦ 拆分不出来 / learn 失败都不炸，也不算数
const bad = await harvestNotes(
  [
    { gid: '1', items: ['没有竖线的一句话', '主题｜内容'] },
    { gid: '2', items: ['会失败的｜这条 learn 返回 false'] },
  ],
  {
    learn: async (topic) => ({ ok: topic !== '会失败的', topic }),
    titles: [],
  },
);
assert.equal(bad, 0, '拆不出的、太短的、learn 失败的都不算数');

console.log(
  '✅ 群观察顺手抽知识：三节解析 / 知识不进群友大事 / 无字跳过 / 最多 2 条 / 拆分容错 / 落盘去重 全过',
);
