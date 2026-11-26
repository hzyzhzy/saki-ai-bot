// 真实案例回归：引用**别人**的话去问第三方，不该当成"在跟我说话"。
// 走真实 judgeSpeak（云端模型），三种引用归属各判一次。
import { judgeSpeak } from '../src/speak-judge.js';

const context = [
  '鲸鲸：那个 6.2 的模型是蒸馏出来的',
  'Morden_Crusaders：自己蒸自己是想干啥啊',
  '鲸鲸：反正我这儿能跑',
  '【你自己说的】6.2 那版我在跑',
].join('\n');

const mkEvent = (name, uid, text = '具体说一下') => ({
  group_id: '200000008',
  message_type: 'group',
  user_id: uid,
  sender: { card: name, nickname: name },
  message: [
    { type: 'reply', data: { id: '270957745' } },
    { type: 'text', data: { text } },
  ],
});

const cases = [
  { name: '引用归属不明（回复还没回填）', quoted: null, want: false },
  { name: '引用的是鲸鲸的话', quoted: { id: '270957745', self: false, name: '鲸鲸', text: '反正我这儿能跑' }, want: false },
  {
    name: '引用的是她自己说的话',
    quoted: { id: '270957745', self: true, name: 'Saki', text: '6.2 那版我在跑' },
    text: '那你说的 6.2 还能跑吗',
    want: true,
  },
];

let bad = 0;
let uidSeed = 1425169070;
for (const c of cases) {
  let v;
  try {
    // ⚠️ 每条换一个 QQ 号：同一个号 0 秒内判过"不说"会走"连着刷"的去重，测不出引用那条逻辑
    v = await judgeSpeak(mkEvent('摇光喵喵', String(++uidSeed), c.text), {
      context,
      strictness: 50,
      quoted: c.quoted,
    });
  } catch (e) {
    console.log(`\n=== ${c.name} ===\n❌ 调用失败：${e.message}`);
    bad++;
    continue;
  }
  const ok = v.speak === c.want;
  console.log(`\n=== ${c.name} ===`);
  console.log(`speak=${v.speak} why=${String(v.why ?? '').slice(0, 120)}`);
  if (!ok) {
    bad++;
    console.log(`❌ 期望 speak=${c.want}`);
  } else console.log('✅ 符合预期');
}
console.log(bad ? `\n${bad} 个用例不符` : '\n全部通过');
process.exit(bad ? 1 : 0);
