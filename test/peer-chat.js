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

console.log('\n【4】★★ 只剩两个机器人互刷 → 在**提示词里**告诉她"该结束了"，由她自己判断');
{
  const recent = await import('../src/recent.js');
  const { Bot } = await import('../src/bot.js');
  const b = new Bot();
  const t0 = Date.now();
  const put = (arr, gapMs = 1000) =>
    recent.__storeForTest().set(
      G,
      arr.map((x, i) => ({
        name: x.n,
        userId: x.u,
        self: x.self === true,
        text: 'x',
        time: t0 - (arr.length - i) * gapMs,
      })),
    );
  // 造 n 条"她"或"同类"的发言
  const mine = (n) => Array.from({ length: n }, () => ({ n: 'Saki', u: '__self__', self: true }));
  const peer = (n) => Array.from({ length: n }, () => ({ n: '大肥鱼', u: '1001' }));

  // ⚠️⚠️ 2026-10-06 改：**4 条不再命中**。用户把它定死了：
  //   「也不是一定要满多少条，最好是机器人自己说了想停下来再停」「就是发出足够多条
  //    在提示词里说该结束了，机器人自己判定自己该说的话说完了没有，自己决定结束」
  //   ⇒ 条数只用来决定"**什么时候提醒她该收场**"，停不停由她自己在那一轮里判断。
  put([...mine(2), ...peer(2)]);
  check(b.botOnlyChain(G) === false, '★ 才两个来回（4 条）→ 还不到提醒她收场的时候');

  put([...mine(5), ...peer(5)]);
  check(b.botOnlyChain(G) === true, '★★ 五个来回（10 条）→ 命中（该在提示词里提醒她了）');

  put([...mine(3), ...peer(3)], 40000);
  check(b.botOnlyChain(G) === true, '★ 条数不够但跨了 4 分钟 → 也命中');

  put([
    { n: 'Saki', u: '__self__', self: true },
    { n: '大肥鱼', u: '1001' },
    { n: '<主人>', u: '10000001' },
    ...mine(4),
    ...peer(4),
  ]);
  check(b.botOnlyChain(G) === false, '★★ 窗口里有真人 → 立刻为假（有人来就继续）');

  put(mine(12));
  check(b.botOnlyChain(G) === false, '★ 只有她自己连发 → 不算"互相聊"（那是自言自语）');

  // 硬闸：刷到离谱才由**代码**直接收尾兜底
  put([...mine(12), ...peer(12)]);
  check(b.botChainHard(G) === true, '★★ 刷到 24 条 → 硬闸（不等她自己收了，代码收尾）');
  put([...mine(5), ...peer(5)]);
  check(b.botChainHard(G) === false, '★ 10 条只在软阈值里，还没到硬闸');

  // ★ 软命中时必须**真的把那句"该结束了"注入提示词**
  put([...mine(5), ...peer(5)]);
  const evG = { message_type: 'group', group_id: G, user_id: '1001' };
  const sys = b.buildSystemPrompt('', evG, null, '');
  check(sys.includes('只有你们两个机器人在说话'), '★★ 提示词注入了"只剩你们两个"那一段');
  check(/想说的话说完了没有/.test(sys), '★★ 而且是让她**自己判断**说完了没有');
  check(/收场/.test(sys), '★ 给了"收场"这个动作（不是让代码替她说）');

  put(mine(1));
  const sys2 = b.buildSystemPrompt('', evG, null, '');
  check(!sys2.includes('只有你们两个机器人在说话'), '★ 没互刷时一个字都不加（不影响日常语气）');

  recent.clear(G);
}

console.log('\n【5】★ 认她自己说的"收场话"（决定权在她，代码只负责跟上）');
{
  const { Bot } = await import('../src/bot.js');
  const b = new Bot();
  for (const t of ['行，不跟你贫了', '我忙去了', '先这样吧', '到此为止', '不聊了，拜拜', '那我先走了']) {
    check(b.isFarewell(t) === true, `认：${t}`);
  }
  // ⚠️ 误认 = 她被动进冷却（之后同类说话她不理）⇒ 这两条护栏比"认得出"更重要
  check(b.isFarewell('他走了') === false, '★ 不认「他走了」（正则锚在"我"上，别误伤）');
  check(b.isFarewell('这个多少钱') === false, '不认：这句只是普通提问');
  check(
    b.isFarewell('我跟你说啊，昨天那个客人从早上一直站到晚上，走的时候还回头跟我拜拜了一下，我当时都没反应过来') === false,
    '★ 长段落不算收场（≤40 字那条护栏；「不聊了」「拜拜」都在里面，但那是长段落）',
  );
}

try {
  rmSync(join(ROOT, 'logs', '__test-peerchat.json'), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
