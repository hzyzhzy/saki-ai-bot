/**
 * 真实模型验收：让它根据素材决定发不发说说、发什么。
 * **只生成，不发布。**
 *
 * 用法: node test/check-qzone.js [场景]
 *   场景: funny（趣事，默认） / dull（平淡素材） / summary（服务器）
 */
import '../src/config.js';
import * as digest from '../src/digest.js';
import { compose } from '../src/qzone-compose.js';
import { config } from '../src/config.js';

const scene = process.argv[2] ?? 'funny';

// 打开空间功能（只是为了让 digest 收素材）
config.qzone.enable = true;

const ev = (nick, text) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: '200000001',
  user_id: String(10000 + Math.floor(Math.random() * 9000)),
  sender: { nickname: nick, role: 'member' },
  message: [{ type: 'text', data: { text } }],
});

const SCENES = {
  funny: [
    ['<主人>', '我把服务器开成创造模式了'],
    ['群友A', '？'],
    ['群友B', '那我们建的东西不就变成别人的玩具了'],
    ['<主人>', '不是 我只给自己开'],
    ['群友A', '更糟了好吗'],
    ['群友C', '腐竹带头搞特权是吧 我要举报'],
    ['<主人>', '我是腐竹 我举报我自己？'],
    ['群友B', '笑死 自己查自己'],
    ['群友C', '建议成立调查组 调查腐竹'],
    ['<主人>', '行吧 我下不为例'],
    ['群友A', '记下了 这是你说的'],
  ],
  dull: [
    ['群友A', '早上好'],
    ['群友B', '早'],
    ['群友A', '今天天气不错'],
    ['群友B', '嗯'],
    ['群友C', '有人吗'],
    ['群友A', '在'],
    ['群友B', '在的'],
    ['群友C', '哦'],
  ],
  summary: [
    ['群友A', '今天服务器人好多啊'],
    ['群友B', '是啊 我看到 30 多个人'],
    ['群友C', '新线路通车了 从首都到安岛县'],
    ['群友A', '终于 以前要走半小时'],
    ['群友B', '谁建的'],
    ['群友C', '我建的 花了三个晚上'],
    ['群友A', '牛'],
    ['<主人>', '不错 我给你记一功'],
  ],
};

for (const [nick, text] of SCENES[scene] ?? SCENES.funny) {
  digest.note(ev(nick, text), { text });
}

console.log(`=== 场景: ${scene}，素材 ${digest.stats().count} 条 ===\n`);
console.log('--- 素材 ---');
console.log(digest.materialText());
console.log('\n--- 模型的判断 ---');

const t0 = Date.now();
const r = await compose({});
console.log(`（耗时 ${Math.round((Date.now() - t0) / 1000)} 秒）\n`);
console.log(JSON.stringify(r, null, 2));
