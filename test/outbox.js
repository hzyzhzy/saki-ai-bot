/**
 * 待发箱（`src/outbox.js`）回归 —— 纯离线，不连 NapCat、不调模型。
 *
 * 用户要求（2026-09-15）：
 *   「如果因为各种原因没发出，在正常之后要补发。然后自动顺延接下来的」
 *
 * ⚠️ 这套的重点不是"能存能取"，而是**不会重复发**：
 *    部分成功时只能补没出去的那几条（不然通道恢复后同一句话刷两遍）。
 */
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = 'logs/__test-outbox-cfg.yml';
const FILE = 'logs/__test-outbox.json';

writeFileSync(
  join(ROOT, CFG),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    'outbox:',
    '  enable: true',
    '  maxAgeMs: 600000', // 10 分钟
    '  questMaxAgeMs: 1800000', // 剧情给 30 分钟（生产默认是 1 小时）
    '  retryMs: 60000', // 1 分钟（测试里用 force 跳过）
    '  maxItems: 3', // 故意调小，好测上限
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG;
process.env.QQBOT_OUTBOX_FILE = FILE;

const outbox = await import('../src/outbox.js');
const { config } = await import('../src/config.js');

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures++;
};

const T0 = Date.now();
/** 假时间：手动推进 */
let nowMs = T0;
const now = () => nowMs;
const reset = () => {
  outbox.__clear();
  nowMs = T0;
  config.outbox.enable = true;
};

// ─────────────────────────────────────────────────────────────
console.log('\n【1】收下：只收"没发出去的那几条"，同样的不重复塞');
{
  reset();
  check(outbox.pending() === 0, '一开始是空的');
  check(outbox.add({ groupId: 'g1', parts: ['第一句', '第二句'], kind: 'chat' }) === true, '能收下');
  check(outbox.pending() === 1, '箱子里 1 批');
  check(outbox.items()[0].parts.length === 2, '那批里有 2 条');
  check(outbox.add({ groupId: 'g1', parts: ['第一句', '第二句'] }) === false, '★ 同样内容不会重复塞');
  check(outbox.pending() === 1, '箱子里还是 1 批');
  check(outbox.add({ groupId: 'g2', parts: ['第一句', '第二句'] }) === true, '换个群就是新的一批');
  check(outbox.pending() === 2, '现在 2 批');
  check(outbox.add({ groupId: 'g1', parts: [] }) === false, '空内容不收');
  check(outbox.add({ parts: ['没群号'] }) === false, '没群号不收');
}

console.log('\n【2】上限：箱子里最多留 maxItems 批（通道坏一整天也不会撑爆）');
{
  reset();
  for (let i = 0; i < 6; i++) outbox.add({ groupId: `g${i}`, parts: [`第${i}批`] });
  check(outbox.pending() === 3, `配置里 maxItems=3 → 实际 ${outbox.pending()} 批`);
  const kept = outbox.items().map((x) => x.groupId);
  check(kept.join(',') === 'g3,g4,g5', `★ 留的是**最新的**几批（${kept.join(',')}）`);
}

console.log('\n【3】补发：通道还坏着 → 留着；好了 → 清空');
{
  reset();
  outbox.add({ groupId: 'g1', parts: ['A', 'B'], at: now() });

  // ① 全线失败 → 留着，tries +1
  const r1 = await outbox.flush(async () => ['A', 'B'], { now, force: true });
  check(r1.tried === 1 && r1.kept === 1 && r1.delivered === 0, '★ 还是发不出去 → 留着（没丢）');
  check(outbox.pending() === 1 && outbox.items()[0].tries === 1, 'tries 记了 1 次');

  // ② 通道好了 → 发出去、清空
  const sent = [];
  const r2 = await outbox.flush(
    async (item) => {
      sent.push(...item.parts);
      return [];
    },
    { now, force: true },
  );
  check(r2.delivered === 1, '★ 补发成功');
  check(sent.join(',') === 'A,B', '内容是原来那两条');
  check(outbox.pending() === 0, '★ 箱子清空');
}

console.log('\n【4】★★ 部分成功：只能补**没出去的那几条**（不能重复发）');
{
  reset();
  outbox.add({ groupId: 'g1', parts: ['1', '2', '3'], at: now() });
  // 第一次补发：只成功第 1 条，返回剩下 2 条
  await outbox.flush(async () => ['2', '3'], { now, force: true });
  check(outbox.pending() === 1, '还留着');
  check(outbox.items()[0].parts.join(',') === '2,3', `★★ 只剩没出去的两条（${outbox.items()[0].parts.join(',')}）`);
  // 第二次：成功第 2 条，剩第 3 条
  await outbox.flush(async () => ['3'], { now, force: true });
  check(outbox.items()[0].parts.join(',') === '3', '★ 又出去一条，只剩最后那条');
  check(
    !outbox.items()[0].parts.includes('1'),
    '★★ 已经发出去的那条**不在箱子里**（否则恢复后会看到同一句话两遍）',
  );
  // 最后一条也出去了
  const r = await outbox.flush(async () => [], { now, force: true });
  check(r.delivered === 1 && outbox.pending() === 0, '全出去之后箱子空了');
}

console.log('\n【5】过期就丢（迟到的聊天回复比不回复更怪）');
{
  reset();
  outbox.add({ groupId: 'g1', parts: ['旧话'], at: now() });
  nowMs = T0 + 20 * 60 * 1000; // 过了 20 分钟（maxAge 是 10 分钟）
  let called = false;
  const r = await outbox.flush(async () => {
    called = true;
    return [];
  }, { now, force: true });
  check(r.dropped === 1 && r.delivered === 0, '★ 过期的那批被丢掉了');
  check(!called, '★ 而且**根本没去发**（省一次调用）');
  check(outbox.pending() === 0, '箱子空了');
}

console.log('\n【6】节流：通道坏着的时候别每 60 秒猛敲一次');
{
  reset();
  outbox.add({ groupId: 'g1', parts: ['X'], at: now() });
  let tries = 0;
  const fn = async () => {
    tries++;
    return ['X'];
  };
  await outbox.flush(fn, { now }); // 第一次（不 force，没有历史 → 允许）
  await outbox.flush(fn, { now: () => nowMs + 10 * 1000 }); // 10 秒后再来
  check(tries === 1, `★ 10 秒内第二次被节流掉了（实际发了 ${tries} 次）`);
  await outbox.flush(fn, { now: () => nowMs + 2 * 60 * 1000 }); // 过了 retryMs
  check(tries === 2, '★ 过了 retryMs 之后再试一次');
  await outbox.flush(fn, { now: () => nowMs + 3 * 60 * 1000, force: true });
  check(tries === 3, 'force 可以跳过（手动/测试用）');
}

console.log('\n【7】落盘：重启不能丢（"重启修通道"这个动作本身不能把要补的东西弄没）');
{
  reset();
  outbox.add({ groupId: 'g9', parts: ['落盘测试'], at: now() });
  const raw = JSON.parse(readFileSync(join(ROOT, FILE), 'utf8'));
  check(Array.isArray(raw.items) && raw.items.length === 1, '★ 真的写进文件了');
  nowMs = T0;
  outbox.reload();
  check(outbox.pending() === 1 && outbox.items()[0].parts[0] === '落盘测试', '★ reload 之后还在');
}

console.log('\n【8】总开关：关了就不收也不发');
{
  reset();
  config.outbox.enable = false;
  check(outbox.add({ groupId: 'g1', parts: ['关着呢'] }) === false, '★ 关着 → 不收');
  check(outbox.pending() === 0, '箱子里是空的');
  config.outbox.enable = true;
  outbox.add({ groupId: 'g1', parts: ['开着呢'] });
  config.outbox.enable = false;
  const r = await outbox.flush(async () => [], { now, force: true });
  check(r.tried === 0 && outbox.pending() === 1, '★ 关着 → 不补发（东西留着，别丢）');
  config.outbox.enable = true;
}

console.log('\n【5b】★ 剧情比聊天宽限（测试：聊天 10 分钟、剧情 30 分钟；生产默认 30 分钟 / 1 小时）');
{
  reset();
  outbox.add({ groupId: 'g1', parts: ['聊天回复'], kind: 'chat', at: now() });
  outbox.add({ groupId: 'g2', parts: ['剧情第 1 段'], kind: 'quest', at: now() });
  nowMs = T0 + 20 * 60 * 1000; // 20 分钟
  // ⚠️ 假发送要**失败**（返回"还没出去的"），不然剧情那批会当场发出去、测不到期限
  await outbox.flush(async (item) => item.parts, { now, force: true });
  const kept = outbox.items();
  check(outbox.pending() === 1, `★ 只剩 1 批（实际 ${outbox.pending()}）`);
  check(kept[0]?.kind === 'quest', '★★ 留下的是**剧情**那批（聊天那批已经过期丢了）');
  // 再过一会儿，剧情也过期
  nowMs = T0 + 40 * 60 * 1000;
  const r = await outbox.flush(async (item) => item.parts, { now, force: true });
  check(r.dropped === 1 && outbox.pending() === 0, '★ 过了期限，剧情也丢掉');
}

console.log('\n【9】★ 接线：发送失败要真的进箱子；日常事件要靠"顺延"而不是补发');
{
  const botSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const idxSrc = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');

  // ① sendChatLike 里：失败的原文要交给待发箱
  const seg = botSrc.slice(botSrc.indexOf('async sendChatLike('), botSrc.indexOf('async sendParts('));
  check(/failed\.push\(/.test(seg), '★ `sendChatLike` 记下了**没出去的那几条**');
  check(/outbox\.add\(\{ groupId, parts: failed/.test(seg), '★★ 而且把它们交给了待发箱');
  check(/opts\.outbox !== false/.test(seg), '★ 留了 `outbox:false` 的口子（日常事件不用补发）');

  // ② 补发的方法存在，而且契约是"返回剩下没发出去的"
  check(/async sendParts\(/.test(botSrc), '★ 有 `sendParts`（补发专用）');
  // ⚠️ 别用 `indexOf('sendLooksBroken(')` 当结束锚点 —— 它在更早的注释里就出现过一次
  //    （`call()` 那段解释），切出来的区间会是反的。直接取固定长度。
  const sp = botSrc.slice(botSrc.indexOf('async sendParts('), botSrc.indexOf('async sendParts(') + 1200);
  check(/left\.push\(/.test(sp) && /return left/.test(sp), '★★ 返回的是**仍然失败的那几条**（部分成功才不重复发）');

  // ③ 通道健康判据
  check(/sendLooksBroken\(/.test(botSrc), '★ 有"通道看起来不通"的判据');
  check(/lastSendFailAt/.test(botSrc) && /lastSendOkAt/.test(botSrc), '★ 靠发送的成败时间戳判断（探针看不出来假在线）');

  // ④ 定时器注册了
  check(/startOutboxTick\(\);/.test(idxSrc), '★★ 待发箱的轮询定时器**真的注册了**');
  check(/outbox\.flush\(/.test(idxSrc), '★ 轮询里调了 `flush`');

  // ⑤ 日常事件：发不出去 → **不记账**（= 顺延）+ 不进待发箱
  //    区间：从"掉线时别发"到"待发箱"那一段注释（就是整个一级事件的 tick）
  //    ⚠️ 起点要选在 `sendLooksBroken` 那道守卫**之前**（它在"先掷骰"上面）
  const life = idxSrc.slice(idxSrc.indexOf('掉线时别发'), idxSrc.indexOf('// ── 待发箱'));
  check(life.length > 500, `（锚点找得到，切出 ${life.length} 字）`);
  // ⚠️ 2026-09-16 分群改造：tick 变成**挨个群问**（`for (const g of groups)`），
  //    "发失败"的判据也跟着变成"这个群一条都没发出去" —— 但那件事没变：
  //    **发失败就不记账（`fired` 不加）→ 今天顺延重排**。
  check(
    /if \(!Array\.isArray\(sent\) \|\| !sent\.length\)/.test(life),
    '★ 日常那段判了"这个群一条都没发出去"',
  );
  const noOk = life.slice(
    life.indexOf('if (!Array.isArray(sent)'),
    life.indexOf('life.commit(plan, text'),
  );
  check(noOk.length > 20, `（"没发出去"那段切出来了，${noOk.length} 字）`);
  check(/continue;/.test(noOk), '★★ 发不出去 → **跳过，不走到 commit**（= 不记账 → 今天顺延重排）');
  check(!/life\.commit/.test(noOk), '★★ 上面那段里**不许**有 `life.commit`（有就等于把配额烧了）');
  check(/outbox: false/.test(life), '★ 日常事件明确不进待发箱（不然顺延 + 补发会重复发）');
  check(/sendLooksBroken\(\)/.test(life), '★ 通道明显不通时先不润色（省一次模型调用）');
}

try {
  rmSync(join(ROOT, FILE), { force: true });
  rmSync(join(ROOT, `${FILE}.tmp`), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
