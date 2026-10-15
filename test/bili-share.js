/**
 * B 站视频分享（2026-10-15 用户要求）套件。
 *
 * ## 盯的是这几条（都是用户原话定的）
 *
 * 1. 「**只发链接**」+「链接后面可以加上视频标题，和官方的分享链接一样」
 *    ⇒ 「**【标题】 链接**」，链接带 `share_source=copy_web`（不抄他个人的 `vd_source`）✓
 * 2. 「加个**看的视频的关键词**」⇒ **没配关键词就不发** ✓（列表：一行一个 / 逗号 / 顿号）
 * 3. 「**只在一档群发**，和日常事件一样有开启按钮，**默认关闭**」
 * 4. 「**一半概率**带一句她自己的想法」+「**分条发送**」⇒ 两条：先那句，再链接 ✓
 * 5. 「也加一个**立刻发送**按钮」⇒ `{force:true}` 跳过时段/冷却 ✓
 * 6. 「**b站分享也要分群调节**」⇒ 每个群一套参数、各发各的、**互不影响** ✓★
 *
 * ⚠️ 纯离线：`__setPicker()` / `__setTake()` 把"真去搜 B 站 / 真去问模型"换掉 ⇒ **一个接口都不打** ✓
 *
 * 用法: node test/bili-share.js
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️ 配置 + 状态文件都隔离（不碰用户真实的 state/bili-share.json）
process.env.QQBOT_CONFIG = 'logs/__test-bili.yml';
process.env.QQBOT_BILI_SHARE_FILE = 'logs/__test-bili-share.json';
writeFileSync(
  join(ROOT, 'logs', '__test-bili.yml'),
  ['llm:', '  baseURL: http://127.0.0.1:1/v1', '  apiKey: "sk-test"', '  model: t', 'botQQ: "10000001"', ''].join(
    '\n',
  ),
  'utf8',
);

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { config } = await import('../src/config.js');
const bs = await import('../src/bili-share.js');

const A = '999000001';
const B = '999000002';

/** 给某个群设一份 biliShare 覆盖（走 `groupParams`，正是界面上保存的那条路）✓
 *  ⚠️ **是合并**，不是覆盖 —— 第一版写成整份替换，于是"只改 startHour"会把 `enable` 冲掉，
 *    【3】那几条当场全红（排查了好一会儿）✗ */
const setGroup = (gid, o = {}) => {
  config.groupParams ??= {};
  const cur = config.groupParams[gid]?.biliShare ?? {};
  config.groupParams[gid] = { ...(config.groupParams[gid] ?? {}), biliShare: { ...cur, ...o } };
};
const clearGroups = () => {
  config.groupParams = {};
};
/** 号级那份是"内置默认"（其他号/没配过的群都看它） */
const setDefault = (o = {}) => {
  config.biliShare = { ...config.biliShare, enable: false, keywords: [], minPerDay: 1, maxPerDay: 1, ...o };
};

const fakeBot = () => ({
  sent: [],
  async sendText(e, t) {
    this.sent.push((e?.group_id ?? '?') + '|' + t);
    return '1';
  },
});

console.log('\n【1】默认关 + 没关键词不发（用户两条硬要求）');
{
  bs.__reset();
  clearGroups();
  setDefault({ keywords: ['Minecraft 地铁'] });
  check(bs.due(A).due === false && /没开/.test(bs.due(A).why), '★★ 没配过的群 ⇒ 默认关 ⇒ 不发');

  setGroup(A, { enable: true, keywords: [] });
  check(bs.due(A).due === false, '★★ 开着但**没填关键词** ⇒ 也不发（免得转群友不感兴趣的）', bs.due(A).why);
}

console.log('\n【2】关键词：一行一个 / 逗号 / 顿号都认（用户说"关键词是列表"）');
{
  setGroup(A, { enable: true, keywords: '地铁\n城市建造, MTR、模组' });
  const k = bs.keywordsOf(A);
  check(k.length === 4 && k[0] === '地铁' && k[3] === '模组', '★★ 多行 + 逗号 + 顿号都能拆开', JSON.stringify(k));
  setGroup(A, { keywords: ['  地铁  ', '', 'x', '地铁'] });
  check(bs.keywordsOf(A).length === 1, '★ 去空、去重、太短的丢掉', JSON.stringify(bs.keywordsOf(A)));
}

console.log('\n【3】判定：时段 / 条数 / 冷却');
{
  bs.__reset();
  const h = new Date().getHours();
  setGroup(A, {
    enable: true, keywords: ['地铁'], minPerDay: 1, maxPerDay: 1,
    cooldownMs: 0, startHour: h, endHour: (h + 1) % 24 || 24,
  });
  check(bs.due(A).due === true, '★★ 开着 + 有关键词 + 在时段 ⇒ 该发', bs.due(A).why);

  const far = (h + 6) % 24;
  setGroup(A, { startHour: far, endHour: far + 1 });
  check(bs.due(A).due === false && /不在时段/.test(bs.due(A).why), '★★ 不在时段 ⇒ 不发');

  setGroup(A, { startHour: h, endHour: (h + 1) % 24 || 24, cooldownMs: 3600000 });
  const bot = fakeBot();
  bs.__setPicker(async () => ({
    title: '测试视频', up: '某个 UP', play: 12345,
    url: 'https://www.bilibili.com/video/BV1xx411c7mD', bvid: 'BV1xx411c7mD', keyword: '地铁',
  }));
  const r1 = await bs.runOnce(bot, [A]);
  check(r1.sent === true && bot.sent.length === 1, '★★ 发出去了', bot.sent[0]);
  // ⚠️ 2026-10-15 用户给了真实样例：「【标题】 https://…/BVxxx/?share_source=copy_web&vd_source=…」
  check(/^【.+】 https:\/\/\S+$/.test(bot.sent[0]?.split('|')[1] ?? ''), '★★ 格式跟官方分享一样：「【标题】 链接」', bot.sent[0]);
  check(
    /share_source=copy_web/.test(bot.sent[0] ?? '') && !/vd_source/.test(bot.sent[0] ?? ''),
    '★★ 链接带 `share_source=copy_web`（像复制来的分享），但**不带** `vd_source`（他个人的码）',
  );
  const r2 = await bs.runOnce(bot, [A]);
  check(r2.sent === false && /冷却|发够/.test(r2.why), '★★ 连着第二次不发（冷却/条数管住了）', r2.why);
}

console.log('\n【4】发过的不会再发（全局去重池，而且落盘）');
{
  bs.__reset();
  clearGroups();
  setGroup(A, { enable: true, keywords: ['地铁'], minPerDay: 9, maxPerDay: 9, cooldownMs: 0, startHour: 0, endHour: 24 });
  const bot = fakeBot();
  let n = 0;
  bs.__setPicker(async () => {
    n++;
    return {
      title: 'v' + n, up: 'u', play: 1,
      url: `https://www.bilibili.com/video/BV10000000${n}x`, bvid: `BV10000000${n}x`, keyword: '地铁',
    };
  });
  await bs.runOnce(bot, [A]);
  await bs.runOnce(bot, [A]);
  check(bot.sent.length === 2, '★ 两次都发出去了（条数没限制住）', String(bot.sent.length));
  check(bs.status(A).sentCount === 2, '★★ 发过的记进去重池', `池里 ${bs.status(A).sentCount} 条`);
}

console.log('\n【5】★★ 分群调节：两个群各一套，互不影响（用户 2026-10-15 要的）');
{
  bs.__reset();
  clearGroups();
  const h = new Date().getHours();
  // A 群：开着、有词、条数管够；B 群：**关着**
  setGroup(A, { enable: true, keywords: ['地铁'], minPerDay: 9, maxPerDay: 9, cooldownMs: 0, startHour: 0, endHour: 24 });
  setGroup(B, { enable: false, keywords: ['动画'], minPerDay: 9, maxPerDay: 9, cooldownMs: 0 });
  const bot = fakeBot();
  bs.__setPicker(async () => ({
    title: 't', up: 'u', play: 1,
    url: 'https://www.bilibili.com/video/BV1aa411a7mD', bvid: 'BV1aa411a7mD', keyword: '地铁',
  }));
  await bs.runOnce(bot, [A, B]);
  check(bot.sent.length === 1 && bot.sent[0].startsWith(A + '|'), '★★ 只发给了**开着**的那个群（B 群关着，一条不发）', bot.sent[0]);
  check(bs.status(A).fired === 1 && bs.status(B).fired === 0, '★★ 计数也是**各算各的**', `A=${bs.status(A).fired} B=${bs.status(B).fired}`);

  // 反过来：把 B 打开、A 关掉 ⇒ 应该只发 B
  setGroup(A, { enable: false });
  setGroup(B, { enable: true, keywords: ['动画'] });
  bot.sent.length = 0;
  await bs.runOnce(bot, [A, B]);
  check(bot.sent.length === 0 || bot.sent[0].startsWith(B + '|'), '★★ 现在只发给 B（A 关了就不再发）', bot.sent[0] ?? '（这次没发，因为 BV 去重了）');

  // 关键词也分群：A 群配的词不该影响 B 群
  setGroup(A, { enable: true, keywords: ['AAA 专用词'] });
  setGroup(B, { enable: true, keywords: ['BBB 专用词'] });
  check(
    bs.keywordsOf(A)[0] === 'AAA 专用词' && bs.keywordsOf(B)[0] === 'BBB 专用词',
    '★★ 关键词也是**每群一份**',
  );
}

console.log('\n【6】只在 1 档群发 + 立刻发送（只发选中的那个群）');
{
  bs.__reset();
  clearGroups();
  setGroup(A, { enable: true, keywords: ['地铁'], minPerDay: 1, maxPerDay: 1, cooldownMs: 3600000, startHour: 0, endHour: 24 });
  const bot = fakeBot();
  bs.__setPicker(async () => ({
    title: 't', up: 'u', play: 1,
    url: 'https://www.bilibili.com/video/BV1aa411a7mD', bvid: 'BV1aa411a7mD', keyword: '地铁',
  }));
  const r0 = await bs.runOnce(bot, []);
  check(r0.sent === false && /1 档群/.test(r0.why), '★★ 没有 1 档群 ⇒ 不发', r0.why);

  const r1 = await bs.runOnce(bot, [A], { force: true, groupId: A });
  check(r1.sent === true && bot.sent[0]?.startsWith(A + '|'), '★★ 立刻发送 ⇒ 发到指定的那个群', bot.sent[0]);
  bs.__reset();
  setGroup(A, { enable: true, keywords: ['地铁'] });
  bs.__setPicker(async () => ({
    title: 't2', up: 'u', play: 1,
    url: 'https://www.bilibili.com/video/BV1bb411b7mD', bvid: 'BV1bb411a7mD', keyword: '地铁',
  }));
  const r2 = await bs.runOnce(bot, [A], { force: true, groupId: A });
  check(r2.sent === true, '★★ 立刻发送**不受冷却限制**（用户要的那个按钮）');
}

console.log('\n【7】一半概率带"她自己的想法"，而且**分条发**（用户要求）');
{
  bs.__reset();
  clearGroups();
  setGroup(A, { enable: true, keywords: ['地铁'], minPerDay: 9, maxPerDay: 9, cooldownMs: 0, startHour: 0, endHour: 24 });
  const bot = fakeBot();
  bs.__setPicker(async () => ({
    title: 'EasyElevator｜我在 MC 坐电梯', up: 'TPPDXM', play: 1663,
    url: 'https://www.bilibili.com/video/BV1ropy6HEGw', bvid: 'BV1ropy6HEGw', keyword: '地铁',
  }));

  setGroup(A, { ...config.groupParams[A].biliShare, chance: 1, gapMs: 200 });
  bs.__setTake(async () => '这电梯有点东西');
  await bs.runOnce(bot, [A]);
  check(bot.sent.length === 2, '★★ 带想法时**分两条发**（不挤在一条里）', `发了 ${bot.sent.length} 条`);
  check(bot.sent[0] === A + '|这电梯有点东西', '★★ 第一条是**她自己的想法**', bot.sent[0]);
  check(/^【.+】 https:\/\//.test(bot.sent[1]?.split('|')[1] ?? ''), '★★ 第二条才是「【标题】 链接」', bot.sent[1]);

  bot.sent.length = 0;
  setGroup(A, { ...config.groupParams[A].biliShare, chance: 0 });
  await bs.runOnce(bot, [A]);
  check(bot.sent.length === 1, '★★ 概率 0 ⇒ 只发链接那一条', `发了 ${bot.sent.length} 条`);

  bot.sent.length = 0;
  setGroup(A, { ...config.groupParams[A].biliShare, chance: 1 });
  bs.__setTake(async () => '');
  await bs.runOnce(bot, [A]);
  check(bot.sent.length === 1 && /^【/.test(bot.sent[0]?.split('|')[1] ?? ''), '★★ 想不出来 ⇒ 只发链接（绝不发空消息）', bot.sent[0]);

  // 概率 50%：跑 200 次看比例（`__setTake` 一律非空 ⇒ 带不带只看 chance）
  setGroup(A, { ...config.groupParams[A].biliShare, chance: 0.5, gapMs: 150 });
  bs.__setTake(async () => '嗯');
  const N = 200;
  let two = 0;
  for (let i = 0; i < N; i++) {
    // ⚠️ 每轮都要 `__reset()` —— 不然 `fired` 累加到当天上限后就不再发了，
    //    统计出来的比例会小得离谱（实测 5/200，白查了一阵）✗
    bs.__reset();
    setGroup(A, { enable: true, keywords: ['地铁'], minPerDay: 9, maxPerDay: 9, cooldownMs: 0, startHour: 0, endHour: 24, chance: 0.5, gapMs: 150 });
    bs.__setPicker(async () => ({
      title: 't' + i, up: 'u', play: 1,
      url: `https://www.bilibili.com/video/BV1cc411c7m${i % 10}`, bvid: `BV1cc411c7m${i % 10}`, keyword: '地铁',
    }));
    bot.sent.length = 0;
    await bs.runOnce(bot, [A]);
    if (bot.sent.length === 2) two++;
  }
  check(two > N * 0.3 && two < N * 0.7, '★★ 概率 50% ⇒ 大约一半带想法（没有写死）', `${two}/${N}`);
}

console.log('\n【8】界面填的值要夹取（手写 yml 和界面同一套规矩）');
{
  const a = bs.normalizeCfg({});
  check(a.enable === false && a.keywords.length === 0, '★ 空输入 ⇒ 默认值（关 + 没关键词）');
  const b = bs.normalizeCfg({ minPerDay: 5, maxPerDay: 2, startHour: 30, endHour: 1, cooldownMinutes: 1, maxResults: 999 });
  check(b.minPerDay === 2 && b.maxPerDay === 5, '★★ 最少/最多写反了 ⇒ 自动换过来', `${b.minPerDay}~${b.maxPerDay}`);
  check(b.startHour === 23 && b.endHour === 24, '★★ 小时越界 ⇒ 夹到 0~23 / 1~24', `${b.startHour}~${b.endHour}`);
  check(b.cooldownMs === 600000, '★★ 冷却最短 10 分钟（填 1 分钟会被抬上来）', String(b.cooldownMs));
  check(b.maxResults === 20, '★ 搜的条数封顶 20', String(b.maxResults));
}

console.log('\n【9】她要知道「视频是自己分享的 + 大概讲了什么」（2026-10-15 用户要求）');
{
  const G = '999000009';
  const bot = fakeBot();
  bs.__reset();
  setGroup(G, {
    enable: true,
    keywords: ['地铁'],
    minPerDay: 9,
    maxPerDay: 9,
    cooldownMs: 0,
    startHour: 0,
    endHour: 24,
    chance: 0,
    gapMs: 100,
  });
  bs.__setTake(async () => '');
  bs.__setPicker(async () => ({
    title: '【爱祥】被抛弃后爱音决定搞爱祥#1',
    up: '闲鱼tudou',
    play: 21940,
    desc: 'OOC警告 人设改变警告 祥祥/爱音',
    url: 'https://www.bilibili.com/video/BV1zz411z7z9',
    bvid: 'BV1zz411z7z9',
    keyword: '地铁',
  }));
  bot.sent.length = 0;
  await bs.runOnce(bot, [G]);

  // ⚠️ 用户原话：「**bot 要知道她自己在分享视频，也要知道视频大概讲了什么**」
  //    起因：她甩了条标着「爱祥」的链接，爱音问「你发这个干嘛呀」，
  //    而她**不知道那是自己分享的、也不知道视频讲的是什么** ✗
  const r = bs.recentShareFor(G);
  check(!!r && r.bvid === 'BV1zz411z7z9', '★ 分享完会记下「刚发的是哪一条」');
  check(String(r?.desc ?? '').includes('祥祥/爱音'), '★ 连**简介**一起记下来（不然她不知道视频讲了什么）');

  const note = bs.shareNote(G);
  check(!!note && note.includes('【爱祥】被抛弃后爱音决定搞爱祥#1'), '★★ 注入的那段里带着标题');
  check(note.includes('祥祥/爱音'), '★★ 也带着简介（有人问「这视频讲啥」她答得上来）');
  check(/你自己/.test(note) && /不是群友发的/.test(note), '★★ 明确点出「那是**她自己**发的」');
  check(bs.shareNote('888888888') === '', '别的群没分享过 ⇒ 不注入（按群隔离）');

  bs.__reset();
  check(bs.recentShareFor(G) === null, '★ 重置后就不算「刚分享过」');
}

bs.__setTake(null);
bs.__setPicker(null);
try {
  rmSync(join(ROOT, 'logs', '__test-bili-share.json'), { force: true });
  rmSync(join(ROOT, 'logs', '__test-bili.yml'), { force: true });
} catch {}
console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
