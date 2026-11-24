/**
 * 验证「结算必须配一次收尾」这条修复（2026-11-08）。
 *
 * 考场里的现象：群里**每分钟一条「【本次剧情结束】」**，停不下来。
 * 真因：`settleQuest()` 只调 `quest.settle()`（算好感度、返回结果对象），
 * **从来没调 `quest.finish()`** ⇒ `current` 没清、`endedAt` 还是 0
 * ⇒ 下一分钟 `questTickOne` 又判 `overdue()` 成立 ⇒ 再结算再播报，无限循环。
 *
 * 这个脚本证明两件事（全在 `logs/qtest/` 里跑，一个真实状态都不碰）：
 *   ① `settle()` 自己**不收尾**（current 还在）—— 所以只调它必然重复；
 *   ② 加一次 `finish()` 之后 `current` 变 null ⇒ `overdue()` 立刻变 false。
 *
 * 跑法：node tools/verify-quest-finish.mjs
 */

import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, 'logs', 'qtest');

// ⚠️ 全部状态文件都要隔离 —— 漏一个就会写进用户正在演的那条真实剧情
process.env.QQBOT_QUEST_FILE = 'logs/qtest/quest.json'; // 这个按 ROOT 相对
process.env.QQBOT_QUEST_SHARED_FILE = join(TMP, 'quest-shared.json');
process.env.QQBOT_QUEST_LINES_FILE = join(TMP, 'quest-lines.json');
process.env.QQBOT_QUEST_YIELD_FILE = join(TMP, 'quest-yield.json');
process.env.QQBOT_STORYLINE_FILE = 'logs/qtest/storyline.json';
process.env.QQBOT_QUEST_CLAIM_DIR = join(TMP, 'claims');

mkdirSync(TMP, { recursive: true });

const quest = await import('../src/quest.js');

const GID = '999000001'; // 考场用的假群号
const MIN = 60 * 1000;
let failed = 0;

const ok = (cond, label, extra = '') => {
  if (cond) {
    console.log(`✅ ${label}${extra ? `（${extra}）` : ''}`);
  } else {
    failed++;
    console.log(`❌ ${label}${extra ? `（${extra}）` : ''}`);
  }
};

quest.__clear();

// 造一条「已经超过时长上限」的线：45 分钟上限，这里给它 90 分钟
const startedAt = Date.now() - 90 * MIN;
const q = {
  id: 'qtest-finish',
  groupId: GID,
  premise: '考场：验证结算只收一次尾',
  cast: ['10000001', '10000002'],
  startedAt,
  endedAt: 0,
  stageIndex: 3,
  userMsgs: [],
  stages: [],
};
quest.__set({ byGroup: { [GID]: { current: q, recent: [], starts: [{ at: startedAt, id: q.id }] } } });

console.log('── ① 这条线现在应该被判「超时」');
ok(quest.overdue(Date.now(), GID) === true, 'overdue() 成立（这就是每分钟触发强制收尾的闸）');

console.log('\n── ② 只调 settle()：不收尾（= 老代码的形状）');
const r = quest.settle(quest.current(GID), 'bad', null);
ok(!!r && r.ending === 'bad', 'settle() 返回了结果对象', `delta=${r?.delta}`);
ok(quest.current(GID) !== null, 'settle() 之后 current **还在**（所以下一分钟会再结算一次）');
ok(quest.overdue(Date.now(), GID) === true, 'settle() 之后 overdue() 依然成立 ⇒ 会无限重复');

console.log('\n── ③ 补一次 finish()：这条线才算真的结束');
const f = quest.finish(quest.current(GID), 'bad', 'settle');
ok(!!f && f.ending === 'bad', 'finish() 返回结局');
ok(quest.current(GID) === null, 'current 已清空');
ok(quest.overdue(Date.now(), GID) === false, 'overdue() 变 false ⇒ 定时器不会再碰它');
ok(quest.runningGroups().length === 0, 'runningGroups() 里没有这条线了');

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ 有 ${failed} 项没过`}`);
process.exit(failed === 0 ? 0 : 1);
