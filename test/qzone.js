/**
 * QQ 空间的**计数/冷却落盘**测试（2026-09-14）。
 *
 * ## 用户报的 bug
 *
 * 「QQ空间发说说**间隔的设置失效**了」
 *
 * ## 根因（这个套件就是钉住它）
 *
 * `saveState()` 在整个 `qzone.js` 里**只有一个调用点** —— `rollDay()` 里跨天那次。
 * 而发布成功路径**只改内存**（`today.count++` / `lastPostAt = Date.now()`），
 * **从来不写文件**。
 *
 * 后果：
 *   · 每发一条，`lastPostAt` 只在内存里更新，文件里永远是旧值
 *   · 一重启就从文件重新加载那个陈旧值 → **冷却等于被重置**
 *   · 而 `whyNot()` 里是 `if (lastPostAt && left > 0)` —— 文件缺失/为 0 时
 *     **冷却整段跳过**
 *
 * 实测证据（当时真实文件）：`state/qzone-count.json` 里 `lastPostAt` 停在
 * **9/12 07:39**，而 9/13、9/14 都发过说说。
 * 被我调试时的一天十几次重启放大成了"间隔设置失效"。
 *
 * ⚠️ 全离线：`publish()` 的 `call` 参数被 stub 成假的（**不真发说说**），
 *    状态文件走 `QQBOT_QZONE_FILE` 指到 logs/ 下，**不碰真实计数**。
 *
 * 用法: node test/qzone.js
 */
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

const CFG_REL = 'logs/__test-qzone.yml';
const CNT_REL = 'logs/__test-qzone-count.json';
const POSTS_REL = 'logs/__test-qzone-posts.json';
const CNT = join(ROOT, CNT_REL);
const REAL_CNT = join(ROOT, 'state', 'qzone-count.json');
const REAL_POSTS = join(ROOT, 'state', 'qzone-posts.json');

// ⚠️ 两个环境变量/配置都必须在 import `src/*` **之前**就位
//    （`config.js` 和 `qzone.js` 都是模块加载时初始化的）
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'qzone:',
    '  enable: true',
    '  maxPerDay: 6',
    '  cooldownMs: 7200000',
    '  ugcRight: 1',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_QZONE_FILE = CNT_REL;
// ⚠️⚠️ 这个也必须指走 —— 第一版忘了，于是 `qzone.publish()` 里的
//    `digest.markPosted()` 往**真实的** `state/qzone-posts.json` 里
//    塞了一条假说说（`tid=fake-tid-1` / 「测试说说…」）。真踩了。
process.env.QQBOT_DIGEST_FILE = POSTS_REL;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const today = new Date().toISOString().slice(0, 10);
const HOUR = 3600000;

/** 写一份"今天已发 N 条、上次在 X 小时前"的状态，然后**重新加载模块** */
async function freshState({ count = 0, agoMs = null } = {}) {
  writeFileSync(
    CNT,
    JSON.stringify({ date: today, count, lastPostAt: agoMs === null ? 0 : Date.now() - agoMs }, null, 2),
    'utf8',
  );
  // ⚠️ `qzone.js` 的 `lastPostAt` 是模块加载时读进内存的 ——
  //    同一进程里改文件不生效。所以每个场景都要**独立的模块实例**
  //    （用 query 串绕过 import 缓存）。
  const mod = await import(`../src/qzone.js?t=${Date.now()}${Math.random()}`);
  return mod;
}

rmSync(CNT, { force: true });

console.log('\n【0】测试隔离（不能碰真实计数文件）');
{
  check(process.env.QQBOT_QZONE_FILE === CNT_REL, '状态文件指向 logs/ 下的临时文件');
  check(CNT !== REAL_CNT, '不是真实的 state/qzone-count.json');
  // ⚠️ 这条是补的：第一版只隔离了计数文件，`digest` 的已发记录没隔离，
  //    结果测试把一条假说说写进了真实文件（真踩了）。
  check(process.env.QQBOT_DIGEST_FILE === POSTS_REL, '已发说说记录也指向临时文件');
  check(join(ROOT, POSTS_REL) !== REAL_POSTS, '不是真实的 state/qzone-posts.json');
}

console.log('\n【1】★ 发布成功后**必须落盘**（就是这个 bug）');
{
  const qz = await freshState({ count: 0, agoMs: null });
  check(existsSync(CNT), '初始状态文件在');

  // 造一个"卡在冷却里"的状态：2 小时前刚发过 → 不该放行
  const before = JSON.parse(readFileSync(CNT, 'utf8'));
  check(before.lastPostAt === 0, '初始 lastPostAt = 0（今天还没发过）');
  check(qz.whyNot(false) === null, '刚加载时可以发（因为还没发过）');

  // 发布一条（call 是假的，不会真发出去）
  const fakeCall = async () => ({ status: 'ok', data: { tid: 'fake-tid-1' } });
  await qz.publish(fakeCall, { content: `测试说说${Date.now()}`, force: true });

  const after = JSON.parse(readFileSync(CNT, 'utf8'));
  check(after.count === 1, `★ 发完 count 落盘了（文件里 = ${after.count}）`);
  check(
    Number(after.lastPostAt) > 0,
    `★ 发完 lastPostAt 落盘了（= ${after.lastPostAt > 0 ? new Date(after.lastPostAt).toLocaleString('zh-CN') : '0'}）`,
  );

  // ★ 最关键的一条：**重启后冷却仍然生效**
  const qz2 = await freshState({ count: after.count, agoMs: Date.now() - Number(after.lastPostAt) });
  const why = qz2.whyNot(false);
  check(why !== null, `★★ 重启后仍然被冷却拦住（"${why}"）`);
}

console.log('\n【2】冷却按配置生效（2 小时）');
{
  const soon = await freshState({ count: 3, agoMs: 0.5 * HOUR });
  check(soon.whyNot(false) !== null, '0.5 小时前发过 → 拦住');

  const late = await freshState({ count: 3, agoMs: 2.5 * HOUR });
  check(late.whyNot(false) === null, '2.5 小时前发过 → 放行');
}

console.log('\n【3】★ 跨天 / 陈旧时间戳不能被采信（第二道防线）');
{
  // 文件里写着"今天是 09-14"，但 lastPostAt 是好几天前的
  writeFileSync(
    CNT,
    JSON.stringify({ date: today, count: 0, lastPostAt: Date.now() - 72 * HOUR }, null, 2),
    'utf8',
  );
  const qz = await import(`../src/qzone.js?t=${Date.now()}${Math.random()}`);
  check(
    qz.status().lastPostAt === null || qz.status().lastPostAt === 0,
    '★ 陈旧（3 天前）的 lastPostAt 被丢弃，当作今天没发过',
    String(qz.status().lastPostAt),
  );

  // 未来时间戳（时钟被改过）也不能信
  writeFileSync(
    CNT,
    JSON.stringify({ date: today, count: 0, lastPostAt: Date.now() + 6 * HOUR }, null, 2),
    'utf8',
  );
  const qz2 = await import(`../src/qzone.js?t=${Date.now()}${Math.random()}b`);
  check(qz2.status().lastPostAt === null || qz2.status().lastPostAt === 0, '未来的时间戳也被丢弃');
}

console.log('\n【4】每天上限仍然生效');
{
  const qz = await freshState({ count: 6, agoMs: 3 * HOUR });
  const why = qz.whyNot(false);
  check(why !== null && /6 条/.test(why), `到上限就拦住（"${why}"）`);
}

console.log('\n【5】★★ 素材里必须**带上她自己说过的话**（<主人> 2026-09-15 深夜）');
console.log('        「她自己造的这个词，自己居然还不知道自己说过了」');
{
  // ⚠️ 起因：她在群里自己造了「回滚点」，发说说时素材里**只有群友那句**
  //    「有人问我回滚点是什么」✗ → 于是写了一条「……我说过这个词吗。」
  //    现在：她在群里说的话也进素材，而且**明确标成"你自己说的"**。
  const d = await import('../src/digest.js');
  d.clearAll();
  d.note(
    { message_type: 'group', group_id: '200000001', user_id: '1941048728', sender: { nickname: 'Jimmy' }, message_id: 'm1' },
    { text: '回滚点又是啥' },
  );
  check(!/你自己/.test(d.materialText()), '★ 群友说的话**不**带"你自己"标记');
  d.noteBot('200000001', '哦还有，装之前先把回滚点打了');
  const mat = d.materialText();
  check(mat.includes('装之前先把回滚点打了'), '★★ 她自己的话进素材了');
  check(/你自己在群里说的/.test(mat), '★★ 而且**明确标着"你自己在群里说的"**（不然她认不出来）');
  check(/Jimmy：回滚点又是啥/.test(mat), '★ 群友那句照旧在里面（两种都在才对）');
  // 太短的（「好的，已停止。」这种）不收
  d.clearAll();
  d.noteBot('200000001', '嗯');
  check(d.stats().count === 0, '★ 太短的话不当素材（和群友那条一样的门槛）');
  d.clearAll();

  // 提示词层面：必须给模型讲清这个标记 + 禁止"怀疑自己说过"
  // ⚠️ 2026-09-21：这段提示词已搬进**人设包**（`personas/<id>/prompt/qzone-guide.md`），
  //    所以**不能再读 `src/qzone-compose.js` 的源码** —— 那查的是"字还在不在代码里"，
  //    而搬家之后它本来就不该在代码里。改成读人设包的实际出口，
  //    测的是**真的会进模型的那段**，比读源码更强。
  // ⚠️⚠️ 这里**必须动态 import**，不能挪到文件顶上去 —— 见上面第 44 行那条：
  //     `src/*` 一被加载，`config.js` 就把配置固化住了。顶上写成静态 import 的话，
  //     ESM 会把它提升到**设 env 之前**求值 → 隔离全废 → `publish()` 走真实路径，
  //     报「拿不到 h5.qzone.qq.com 的 cookies」（2026-09-21 真踩了这一次）。
  const { promptFile } = await import('../src/persona.js');
  const src = promptFile('qzone-guide');
  check(!!src, '★ 人设包里读到了说说提示词（qzone-guide）');
  check(/别怀疑、别否认自己说过什么/.test(src), '★★ 提示词里禁止"怀疑/否认自己说过的话"');
  check(/我说过这个词吗/.test(src), '★ 而且把真实踩过的例子写进去了（当反面教材）');
  check(/别把素材里的话安错人/.test(src), '★ 也说清了别把"你自己"的行当成群友说的');
}

console.log('\n【6】★★ 手动「立刻发送说说」不受冷却限制（2026-09-15 深夜修）');
{
  // ⚠️ 真实踩过：她 02:03 刚发过一条说说，用户 02:15 点「立刻发送说说」——
  //    被"离上次发布还不到…"挡住 ✗，而界面上只显示「失败： undefined」✗
  //    （接口给的是 `skipped`，界面读的是 `error`）。
  //    代码注释本来就写着「手动也要守**每天上限**」= 手动不该被冷却挡。
  const q1 = await freshState({ count: 0, agoMs: 12 * 60 * 1000 }); // 12 分钟前刚发过
  const autoWhy = q1.whyNot(true);
  check(typeof autoWhy === 'string' && /离上次发布/.test(autoWhy), `★ 自动模式：仍然被冷却挡住（${autoWhy}）`);
  check(q1.whyNot(false, { manual: true }) === null, '★★ **手动不受冷却限制**（点了就该能发）');

  // 但每天上限对**手动**仍然生效（手滑刷屏的兜底）
  const q2 = await freshState({ count: 999 });
  const manualWhy = q2.whyNot(false, { manual: true });
  check(typeof manualWhy === 'string' && /今天已经发了/.test(manualWhy), `★★ 手动仍然守每天上限（${manualWhy}）`);

  // 界面上必须**先看 `skipped`**（不然又是「失败： undefined」）
  const html = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/if \(r\.skipped\)/.test(html), '★★ 界面先判 `skipped`（"没有发：<原因>"），不再显示 undefined');
  check(/r\.error \|\| '（没给原因，去看日志）'/.test(html), '★ 真失败时也不会显示 undefined');
  // 跳过原因要能查：bot.js 里那些"不发"必须打到 info（原来是 debug = 看不见）
  const botSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/log\.info\(`\[空间\] 不发：/.test(botSrc), '★ 「不发」的原因打在 info 日志里（能查了）');
  check(/log\.info\(`\[空间\] 手动发但被拦住：/.test(botSrc), '★ 手动被拦住也打 info');
}

// ── 收尾 ──────────────────────────────────────────────
try {
  rmSync(CNT, { force: true });
  rmSync(join(ROOT, POSTS_REL), { force: true });
  rmSync(join(ROOT, CFG_REL), { force: true });
  delete process.env.QQBOT_QZONE_FILE;
  delete process.env.QQBOT_DIGEST_FILE;
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
