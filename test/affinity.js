/**
 * 「好感度」测试（2026-09-14 用户要求）。
 *
 * 用户原话：「加一个**机器人对这个人的好感度**，类似 galgame 的，
 *   默认 50，最小 0 最大 100。但是**其中优先级是低于我和机器人的特殊关系的**。」
 *
 * 加上后面那句：「**好感度也不能修改**」（在说"按时间压缩"时补的）。
 *
 * ⚠️ 这个套件盯的就是这两条**容易在后续改动里被破坏**的约束：
 *   ① **对服主不注入** —— 优先级低于特殊关系
 *   ② **不被自动机制改写** —— observe 的压缩碰不到它
 *
 * ⚠️ 纯离线：走 `QQBOT_AFFINITY_FILE` 指到 logs/，**不碰真实 state/affinity.json**。
 *
 * 用法: node test/affinity.js
 */
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️ 配置 + 状态文件都必须在 import `src/*` **之前**就位
const CFG_REL = 'logs/__test-affinity.yml';
const AFF_REL = 'logs/__test-affinity-state.json';
const AFF = join(ROOT, AFF_REL);
const REAL_AFF = join(ROOT, 'state', 'affinity.json');

writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'affinity:',
    '  enable: true',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_AFFINITY_FILE = AFF_REL;
// ⚠️ 名字表也要隔离，别往真实的 `state/names.json` 里塞测试用的假名字
const NAMES_REL = 'logs/__test-affinity-names.json';
process.env.QQBOT_NAMES_FILE = NAMES_REL;
const NAMES = join(ROOT, NAMES_REL);
rmSync(AFF, { force: true });
rmSync(NAMES, { force: true });

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const aff = await import('../src/affinity.js');
const A = '30001';
const B = '30002';
const OWNER = '10000001';

console.log('\n【0】测试隔离');
{
  check(process.env.QQBOT_AFFINITY_FILE === AFF_REL, '状态文件指向 logs/ 下的临时文件');
  check(AFF !== REAL_AFF, '不是真实的 state/affinity.json');
}

console.log('\n【1】默认值与范围（用户指定：默认 50，0~100）');
{
  aff.__clear();
  check(aff.DEFAULT_AFFINITY === 50, '默认值 = 50');
  // ⚠️ 2026-09-20：上限改成**无限**了（用户要求「把好感度上限修改为无限」）
  check(aff.MIN_AFFINITY === 0 && aff.MAX_AFFINITY === Infinity, '下限 0、**上限无限**');
  check(aff.get(A) === 50, '没记录过的人 → 返回默认 50');
  check(aff.status().tracked === 0, '只是**读**一下不该产生记录（不写盘）');
}

console.log('\n【2】能调：**有下限、但不封顶**');
{
  aff.__clear();
  // 用 force 绕过单次/每日的夹取，专门验"范围"
  aff.adjust(A, 100, { force: true });
  check(aff.get(A) === 150, `不封顶：50 + 100 = 150（实际 ${aff.get(A)}）`);
  aff.adjust(A, 100, { force: true });
  check(aff.get(A) === 250, `还能继续往上（实际 ${aff.get(A)}）`);
  aff.adjust(A, -500, { force: true });
  check(aff.get(A) === 0, `减到底 → 0（实际 ${aff.get(A)}）`);
  aff.adjust(A, -10, { force: true });
  check(aff.get(A) === 0, '再减也不会低于 0');

  // ⚠️⚠️ 2026-09-20 加（用户要求：「**二级剧情加的好感度不被每日好感度限制所限制**」）：
  //    `force: true` 必须**不消耗每日额度** —— 剧情加分走的就是这条路。
  //    （回归价值：以后谁要是把 `force` 的实现改坏了，"剧情加不了分"就会在这里先炸。）
  aff.__clear();
  const before = aff.dailyLeft(A);
  aff.adjust(A, 3, { force: true });
  aff.adjust(A, 3, { force: true });
  check(aff.dailyLeft(A) === before, `force 不吃每日额度（前后都是 ${before}）`);
  aff.__clear();
  aff.adjust(A, 3);
  check(aff.dailyLeft(A) === before - 3, `不加 force 才吃额度（${before} → ${aff.dailyLeft(A)}）`);
}

console.log('\n【3】★ 单次幅度和每日总量有上限（防"聊一句就暴涨"）');
{
  aff.__clear();
  const r = aff.adjust(A, 50);
  check(r.applied <= 3, `单次最多 +3（实际 +${r.applied}）`);
  check(aff.get(A) <= 53, `结果不夸张（${aff.get(A)}）`);

  // 连着调，一天的总量也该被夹住
  aff.__clear();
  for (let i = 0; i < 20; i++) aff.adjust(A, 3);
  check(aff.get(A) <= 50 + 8, `一天连调 20 次，总增量仍受每日上限约束（${aff.get(A)}）`);
}

console.log('\n【3b】★★ 减分**不占**每天的加分额度（2026-09-17 用户要求）');
{
  // 用户原话：「有人骂她那肯定得减，而且减2，因为加上来很容易」。
  // 额度是防"刷分"的，而减分不需要防 —— 否则"今天已经和她聊满 8 分"的人
  // 再骂她就减不动了，那等于「先聊熟、再随便骂」，正好是最该扣分的情形。
  aff.__clear();
  for (let i = 0; i < 20; i++) aff.adjust(A, 3); // 先把她聊熟，把额度用光
  const used = aff.get(A);
  check(used >= 58, `加分额度确实已经用满（${used}）`);
  const r = aff.adjust(A, -2, { note: '骂了她（傻逼）' });
  check(r.applied === -2, `额度用满之后**照样能扣 2**（实际 ${r.applied}）`);
  check(aff.get(A) === used - 2, `分数确实掉了（${used} → ${aff.get(A)}）`);

  // 连着骂也不受"每日 8 分"限制（只受单次 -3 那个幅度上限约束）
  aff.__clear();
  for (let i = 0; i < 10; i++) aff.adjust(A, -2);
  check(aff.get(A) === 30, `连骂 10 次 → 50-20=30，没被"每日 8"卡住（${aff.get(A)}）`);
  check(aff.get(A) >= 0, '不会掉到 0 以下');
}

console.log('\n【4】★ 落盘（重启不丢）');
{
  aff.__clear();
  aff.adjust(A, 3);
  const onDisk = JSON.parse(readFileSync(AFF, 'utf8'));
  // ⚠️ 2026-09-15 晚：分群之后盘上是 `byGroup[''].users`（没给群号的落在"没指定群"那个桶）
  check(!!onDisk.byGroup?.['']?.users?.[A], '文件里有这个人的记录（byGroup 形状）');
  check(Number(onDisk.byGroup[''].users[A].v) === aff.get(A), `存的和内存里一致（${onDisk.byGroup[''].users[A].v}）`);

  // 重新加载（模拟重启）
  aff.reload();
  check(aff.get(A) === onDisk.byGroup[''].users[A].v, 'reload 之后还是那个值');
}

console.log('\n【4.五】★★ 好感度**按群各记各的**（<主人>：「好感度也还没有分群」）');
{
  aff.__clear();
  const G1 = '200000006';
  const G2 = '200000001';
  const U = 'u-same';
  aff.adjust(U, 3, { force: true, groupId: G1 });
  aff.adjust(U, -2, { force: true, groupId: G2 });
  check(aff.get(U, G1) === 53, `★★ 同一个号在 A 群 53（拿到 ${aff.get(U, G1)}）`);
  check(aff.get(U, G2) === 48, `★★ 在 B 群 48 —— 两边互不影响（拿到 ${aff.get(U, G2)}）`);
  check(aff.get(U, '999999') === 50, '★ 没去过的群 = 默认 50');
  check(
    aff.top(10, G1).every((x) => x.userId !== 'nobody'),
    '★ 榜单只列那个群的人',
  );
  check(aff.top(10, G1).length === 1 && aff.top(10, G2).length === 1, '★ 两个群各有一份榜');
  check(aff.groupIds().includes(G1) && aff.groupIds().includes(G2), '★ groupIds() 报得出有数据的群');

  // 每天的额度也按群算（在 A 群刷满了，去 B 群照样能加）
  aff.__clear();
  for (let i = 0; i < 20; i++) aff.adjust(U, 3, { groupId: G1 });
  check(aff.get(U, G1) <= 58, `★ A 群受每日上限（${aff.get(U, G1)}）`);
  aff.adjust(U, 3, { groupId: G2 });
  check(aff.get(U, G2) === 53, '★★ B 群的额度和 A 群各算各的（照样能加）');

  // 落盘 + 重新加载
  aff.reload();
  check(aff.get(U, G1) <= 58 && aff.get(U, G2) === 53, '★ 两个群的分都落盘了（重启不丢）');
}

console.log('\n【5】★★ 对服主**不注入**（用户：优先级低于我和机器人的特殊关系）');
{
  aff.__clear();
  aff.adjust(OWNER, 3, { force: true });
  check(aff.get(OWNER) !== 50, '服主的好感度**是能记的**（记着没问题）');
  check(
    aff.promptLine(OWNER, { isOwner: true }) === '',
    '★ 但对服主**不注入提示词** —— 不让"私人评分"去和 relationship 打架',
  );
  // 普通群友要注入
  check(aff.promptLine(A, { isOwner: false, name: '小夏' }) !== '', '对普通群友会注入');
}

console.log('\n【6】注入的内容要合格（别让她把数字说出来）');
{
  aff.__clear();
  aff.adjust(A, 3, { force: true });
  const line = aff.promptLine(A, { isOwner: false, name: '小夏' });
  check(line.includes('小夏'), '点名了是谁');
  // ⚠️ 2026-09-20：上限改无限之后，提示词里**不再写 `/100`**（那会让她以为满分就是 100）。
  //    只要给得出具体数值就行。
  check(/\d+/.test(line) && !/\/100/.test(line), '给了数值，而且不写 /100（上限无限）');
  check(/不许说出数字|别说出来/.test(line), '★ 明确要求**不许说出数字**');
  check(/好感度/.test(line) && /别说|出戏/.test(line), '也要求不许提「好感度」这个词');
  check(/<主人>/.test(line), '★ 写明"管不到 <主人>"（优先级约束传达到了）');
  check(/优先级|高于/.test(line), '写明了优先级关系');
  check(/该给的答案要给|该答的还是答/.test(line), '低好感度也不能不干活');
}

console.log('\n【7】档位描述随数值变（高/中/低要说不一样的话）');
{
  aff.__clear();
  const hi = (() => {
    aff.adjust(A, 3, { force: true });
    aff.adjust(A, 300, { force: true });
    return aff.promptLine(A, { name: 'X' });
  })();
  aff.__clear();
  aff.adjust(B, -300, { force: true });
  const lo = aff.promptLine(B, { name: 'X' });
  check(hi !== lo, '高好感度和低好感度的注入内容**不一样**');
  // ⚠️ 2026-09-17：`promptLine` 新加了 90 那一档（"非常亲近（已经是熟人 / 朋友那种）"，
  //    为的是"好感度到 90 以上就不用再推开'宝宝'这种称呼"）——
  //    那一档的措辞里没有"很熟/喜欢"，所以把"亲近"也认成正面描述。
  check(/很熟|喜欢|亲近/.test(hi), '高的时候描述偏正面');
  check(/不耐烦|不想理/.test(lo), '低的时候描述偏冷');
}

console.log('\n【8】★★ 自动机制不许改好感度（用户：「好感度也不能修改」）');
{
  const obs = readFileSync(join(ROOT, 'src', 'observe.js'), 'utf8');
  // ⚠️ 先把**提示词模板整段剔掉**再查代码 ——
  //    提示词里**故意**提了「好感度不在这个文件里，别往这儿写」，
  //    直接按行过滤会把那句当成"代码碰了好感度"（第一版就是这么假失败的）。
  const codeOnly = obs
    .replace(/const PROMPT = `[\s\S]*?`;/g, '')
    .replace(/const COMPRESS_PROMPT = `[\s\S]*?`;/g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  const hits = codeOnly.split('\n').filter((l) => /affinity|好感度/.test(l));
  check(hits.length === 0, `observe.js 的代码里完全没碰好感度（实际 ${hits.length} 处）`, hits[0] ?? '');

  // 压缩的提示词里也不许**让它去维护**好感度
  const m = obs.match(/const COMPRESS_PROMPT = `([\s\S]*?)`;/);
  const prompt = m?.[1] ?? '';
  check(/不许写任何\*\*数字评分\*\*|不在这个文件里/.test(prompt), '★ 提示词明确说了"好感度不在这个文件里"');
  check(!/（好感度[^）]*）/.test(prompt) || /别往这儿写/.test(prompt), '提到好感度时是**禁止**语气，不是让它写');
}

console.log('\n【9】关掉开关就不注入');
{
  aff.__clear();
  const { config } = await import('../src/config.js');
  const before = config.affinity.enable;
  config.affinity.enable = false;
  check(aff.promptLine(A, { name: 'X' }) === '', 'affinity.enable=false → 不注入');
  const r = aff.adjust(A, 3);
  check(r.ok === false, '也不允许调（会返回 reason）');
  config.affinity.enable = before;
}

console.log('\n【10】边界与安全');
{
  aff.__clear();
  check(aff.promptLine('', { name: 'X' }) === '', '空 userId → 不注入');
  check(aff.promptLine(undefined) === '', 'undefined → 不注入');
  let threw = false;
  try {
    aff.adjust(undefined, 3);
    aff.adjust('', 3);
    aff.adjust(A, NaN);
  } catch {
    threw = true;
  }
  check(!threw, '异常入参不抛错');
}

console.log('\n【11】★★ 榜单要显示**名字**，不能只甩 QQ 号（2026-09-15 用户截图）');
{
  // 用户原话：「**30003 是谁**？建议直接改成以 QQ 昵称显示」
  // ⚠️ 根因：代码里读的是 `this.nameCache`，可它**从来没被写过** → 永远退回号码。
  //    现在名字由 `src/names.js` 管（每条群消息顺手记，群名片优先，落盘）。
  const nm = await import('../src/names.js');
  nm.__clear();

  const ev = (uid, { card = '', nickname = '' } = {}, gid = '200000001') => ({
    message_type: 'group',
    group_id: gid,
    user_id: uid,
    sender: { user_id: uid, card, nickname },
  });

  check(nm.of(A) === '', '没见过的号 → 空串（调用方退回号码）');
  nm.note(ev(A, { nickname: '路人甲' }));
  check(nm.of(A) === '路人甲', '见到一条消息 → 记下昵称');
  nm.note(ev(A, { card: '甲甲', nickname: '路人甲' }));
  check(nm.of(A, '200000001') === '甲甲', '★ 有群名片时**优先用群名片**（这个群里大家认得的是它）');
  check(nm.of(A) === '路人甲', '  ↳ 不带群号时还是全局昵称');

  // ⚠️ 群名片是"每个群各一份"
  nm.note(ev(A, { card: '狗管理', nickname: '路人甲' }, '999888777'));
  check(nm.of(A, '999888777') === '狗管理' && nm.of(A, '200000001') === '甲甲', '★ 同一个人在不同群显示各自的名片');

  // ⚠️ 空名片**不许擦掉**已记下的（有人没设名片时 card 是空的）
  nm.note(ev(A, { card: '', nickname: '' }));
  check(nm.of(A, '200000001') === '甲甲', '空名片/空昵称 → **不覆盖**已有的');

  check(nm.label('30003') === '30003', '查不到 → `label()` 退回 QQ 号（不会显示空）');
  check(nm.label(A, '200000001') === '甲甲', '查得到 → 显示名字');

  // ★ 落盘：不然**每次重启榜单又变回号码**（用户刚看到的就是这个）
  nm.flush();
  nm.__clear();
  check(nm.of(A, '200000001') === '', '清空后确实没了（对照）');
  nm.reload();
  check(nm.of(A, '200000001') === '甲甲' && nm.of(A) === '路人甲', '★ 重新载入 → 名字还在（重启不丢）');

  // 接线：bot 的榜单和"到线通知"的 @ 都得用它
  const bj = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const wj = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  const wh = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/names\.label\(x\.userId, event\.group_id\)/.test(bj), '★ `/好感度` 榜单用 names.label（群名片优先）');
  check(!/this\.nameCache/.test(bj.replace(/\/\/[^\n]*/g, '')), '★ 那个"只读不写"的 `nameCache` 已经清掉');
  check(/names\.of\(String\(userId\), gid\)/.test(bj), '★ 「到线通知」的 @ 也取名字（空 name 的 @ 会显示成 @全体成员）');
  check(/names\.note\(payload\)/.test(bj), '★ 每条群消息都会记一笔（不用额外调接口）');
  check(/names\.of\(String\(x\.userId\)\)/.test(wj), '★ 界面的榜单也带上名字');
  check(/x\.name \|\| '（还没说过话）'/.test(wh), '★ 界面上名字 + 号码都显示（管理用）');
}

// ── 收尾 ──────────────────────────────────────────────
try {
  rmSync(AFF, { force: true });
  rmSync(join(ROOT, CFG_REL), { force: true });
  rmSync(NAMES, { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
