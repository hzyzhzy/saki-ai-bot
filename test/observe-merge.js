import assert from 'node:assert/strict';
import { __merge } from '../src/observe.js';

const old = [
  '### 群友',
  '',
  '- <主人>：新冒泡的群友，爱点名模型版本',
  '- **早起的鸟儿**：爱纠正别人@全员',
  '- **新增：** 整天发「ciallo」',
  '',
  '### 大事',
  '',
  '- 最近：群人数破千',
].join('\n');

// 模型这轮给的是「融合后的完整最新评价」+ 一条把旧评价修正掉的
const merged = __merge(old, {
  people: ['<主人>：群主、服务器服主，爱指定模型让机器人做动画', '小黄瓜（我的世界大肘子）：爱报开源动态'],
  events: ['最近：群人数破千'],
});

const people = merged.split('### 大事')[0].split('\n').filter((l) => l.trim().startsWith('- '));
const <主人> = people.filter((l) => l.replace(/\*/g, '').includes('<主人>'));
assert.equal(<主人>.length, 1, '同一个人只能有一条');
assert.match(<主人>[0], /服务器服主/, '新的完整评价要写进去');
assert.doesNotMatch(<主人>[0], /新冒泡的群友/, '过期的旧评价要被改掉（不是两句并存）');
assert.equal(people.some((l) => /^\s*-\s*\**\s*(新增|性格)\s*[：:]/.test(l)), false, '碎片行不能单独成条');
assert.equal(people.length, 3, '<主人> / 早起的人（碎片已并入）/ 小黄瓜');
assert.equal((merged.match(/群人数破千/g) ?? []).length, 1, '大事不重复');

const again = __merge(merged, { people: [], events: [] });
assert.equal(again.split('\n').filter((l) => l.trim().startsWith('- ')).length, 4, '没有新观察时原样保留');
console.log('通过：同人一条、旧评价可被改写覆盖、碎片并入上一个人、大事不重复');
