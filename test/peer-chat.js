/**
 * 「同类机器人主动搭话」的判据回归（2026-10-05 加）。
 *
 * ## 用户需求
 *   「…填入的 QQ 号直接默认为同类机器人，**会随机主动 @ 找那个同类机器人聊天**」
 *   「**有时候还可以主动去戳池里的机器人**」
 *   拍板：只在**群里冷场**时；开场白**由模型现想**。
 *
 * ## 这个套件盯的是**五道闸**（缺一个就会变成话痨或被群友嫌）
 *   ① 没配池 → 不找；② 只在 9~23 点；③ 冷场（idleMs，默认 15 分钟）；
 *   ④ 冷却（默认 30 分钟）；⑤ 每日上限（默认 4 次）。
 *   ⚠️ 「不找」的理由也要能说出来（`reason`）—— 排错时全靠它。
 *
 * ⚠️ 纯离线：不调模型、不发消息（`tick()` 需要真 bot，这里只测纯判据）。
 * 用法: node test/peer-chat.js
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

process.env.QQBOT_PEERCHAT_FILE = 'logs/__test-peerchat.json';
// ⚠️⚠️ **必须显式打开**（`run-all.js` 给所有套件注入 `QQBOT_PEERCHAT=off`，
//    免得回归里真往群里发消息）—— 而本套件正是要测这个判定：
//    不写这一行就会「单独跑全绿、一进回归就红」。
//    ⚠️ 这个坑我在 `test/rewrite.js` 上已经踩过一次了，别再踩第三次。
process.env.QQBOT_PEERCHAT = 'on';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { config, ROOT } = await import('../src/config.js');
const pc = await import('../src/peer-chat.js');

const G = '999000001';
const G2 = '999000002';
config.peerChat = { enable: true, idleMs: 900000, cooldownMs: 1800000, maxPerDay: 4 };
config.groupParams ??= {};
config.groupParams[G] = { peers: ['1001', '1002'] };

const at = (h) => new Date(2026, 9, 5, h, 0, 0).getTime();
const now = at(15);
const idleOk = now - 16 * 60 * 1000; // 16 分钟前有人说过话（> 15 分钟）

console.log('\n【1】五道闸：该找 / 不该找');
{
  pc.reset();
  check(pc.shouldPing(now, G, idleOk).ok === true, '★ 冷场 16 分钟 + 配了池 → 可以找');
  check(
    pc.shouldPing(now, G, now - 60000).ok === false,
    '★ 群里一分钟前刚有人说话 → 不找',
    pc.shouldPing(now, G, now - 60000).reason,
  );
  check(
    pc.shouldPing(at(3), G, idleOk).ok === false,
    '★ 凌晨 3 点 → 不找',
    pc.shouldPing(at(3), G, idleOk).reason,
  );
  check(
    pc.shouldPing(now, G2, idleOk).ok === false,
    '★ 这个群没配同类池 → 不找',
    pc.shouldPing(now, G2, idleOk).reason,
  );
  const saved = config.peerChat.enable;
  config.peerChat.enable = false;
  check(pc.shouldPing(now, G, idleOk).ok === false, '★ 总开关关掉 → 不找');
  config.peerChat.enable = saved;
  check(pc.shouldPing(now, G, 0).ok === false, '★ 不知道群里最后一条什么时候 → 不找（宁可不动）');
}

console.log('\n【2】冷却与每日上限');
{
  pc.reset();
  pc.note(G, '1001', now);
  check(
    pc.shouldPing(now + 60000, G, idleOk).ok === false,
    '★ 刚找过（1 分钟后）→ 还在冷却',
    pc.shouldPing(now + 60000, G, idleOk).reason,
  );
  check(pc.shouldPing(now + 31 * 60 * 1000, G, idleOk).ok === true, '★ 过了 30 分钟 → 又能找');

  pc.reset();
  for (let i = 0; i < 4; i++) pc.note(G, '1001', now + i * 40 * 60 * 1000);
  const late = now + 5 * 60 * 60 * 1000;
  check(
    pc.shouldPing(late, G, idleOk).ok === false,
    '★ 今天已经 4 次 → 不找（每日上限）',
    pc.shouldPing(late, G, idleOk).reason,
  );
  // 跨天就重置
  const tomorrow = new Date(2026, 9, 6, 15, 0, 0).getTime();
  check(pc.shouldPing(tomorrow, G, idleOk).ok === true, '★ 到了第二天 → 计数重置，又能找');
}

console.log('\n【3】挑号：池里多个号时不该连着挑同一个');
{
  pc.reset();
  const a = pc.pickPeer(G, ['1001', '1002'], () => 0);
  pc.note(G, a, Date.now());
  const b = pc.pickPeer(G, ['1001', '1002'], () => 0);
  check(a !== b, '★ 两个号里换了另一个', `上一次 ${a}，这次 ${b}`);
  check(pc.pickPeer(G, ['1001'], () => 0) === '1001', '★ 池里只有一个就还是它');
  check(pc.pickPeer(G, [], () => 0) === '', '★ 池是空的 → 返回空（调用方会跳过）');
}

console.log('\n【4】★★ 只剩两个机器人在互相说话 → 该停就停（用户：要不然会一直发下去）');
{
  const recent = await import('../src/recent.js');
  const { Bot } = await import('../src/bot.js');
  const b = new Bot();
  const t0 = Date.now();
  const put = (arr) =>
    recent.__storeForTest().set(
      G,
      arr.map((x, i) => ({
        name: x.n,
        userId: x.u,
        self: x.self === true,
        text: 'x',
        time: t0 - (arr.length - i) * 1000,
      })),
    );

  put([
    { n: 'Saki', u: '__self__', self: true },
    { n: '大肥鱼', u: '1001' },
    { n: 'Saki', u: '__self__', self: true },
    { n: '大肥鱼', u: '1001' },
  ]);
  check(b.botOnlyChain(G) === true, '★★ 两个机器人一来一回 4 条 → 判"该停"');

  put([
    { n: 'Saki', u: '__self__', self: true },
    { n: '大肥鱼', u: '1001' },
    { n: '<主人>', u: '10000001' },
    { n: 'Saki', u: '__self__', self: true },
  ]);
  check(b.botOnlyChain(G) === false, '★★ 真人插过一句 → 立刻恢复（有人来就继续）');

  put([
    { n: 'Saki', u: '__self__', self: true },
    { n: 'Saki', u: '__self__', self: true },
    { n: 'Saki', u: '__self__', self: true },
    { n: 'Saki', u: '__self__', self: true },
  ]);
  check(b.botOnlyChain(G) === false, '★ 只有她自己连发 → 不算"互相聊"（那是自言自语）');

  put([
    { n: 'Saki', u: '__self__', self: true },
    { n: '大肥鱼', u: '1001' },
  ]);
  check(b.botOnlyChain(G) === false, '★ 才一个来回 → 还没到停的时候');

  put([
    { n: 'Saki', u: '__self__', self: true },
    { n: '大肥鱼', u: '1001' },
    { n: '路人', u: '999999' },
    { n: '大肥鱼', u: '1001' },
  ]);
  check(b.botOnlyChain(G) === false, '★ 池外的人说话 → 当真人，不拦');

  recent.clear(G);
}

try {
  rmSync(join(ROOT, 'logs', '__test-peerchat.json'), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
