// 「不接」工具：设标记、戳一下、不发材料；工作模式拿不到这个工具。
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import * as privateWork from '../src/private-work.js';

const pokes = [];
const fake = {
  async sendPokeBack(uid, gid) {
    pokes.push(`${uid}@${gid}`);
  },
  selfId: '10000002',
};

const event = { group_id: '200000008', user_id: '1425169070', message_type: 'group', message: [] };

const out = await Bot.prototype.runReadTool.call(fake, '不接', {}, event);
assert.equal(out, '', '不接不该产出材料（不重新生成）');
assert.equal(event._skipSpeak, true, '要挂上"这次不发言"的标记');
assert.deepEqual(pokes, ['1425169070@200000008'], '默认戳一下发消息的人');

const event2 = { group_id: '200000008', user_id: '999', message_type: 'group', message: [] };
await Bot.prototype.runReadTool.call(fake, '不接', { 戳: false }, event2);
assert.equal(event2._skipSpeak, true);
assert.equal(pokes.length, 1, '戳:false 时不该再戳');

// 工作模式私聊：工具清单里没有它（`buildTools({workChat:true})` === []）
const { buildTools } = await import('../src/tools-fc.js');
assert.deepEqual(buildTools({ workChat: true }), []);
assert.ok(buildTools({}).some((t) => t.function.name === 'skip_reply'));
void privateWork;
console.log('通过：不接 ⇒ 不产材料、挂不发言标记、戳对方；工作模式不给这个工具');
