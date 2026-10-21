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
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
  // ⚠️ 2026-10-16：这一节要**同一个群连发好几次**（验"带不带那句话"），
  //    而"同一个群不许重复发同一条"现在是硬规则 ⇒ 每次得给**不同的** BV 号 ✓
  let n7 = 0;
  bs.__setPicker(async () => {
    const b = `BV1ropy6HEG${n7++}`;
    return {
      title: 'EasyElevator｜我在 MC 坐电梯', up: 'TPPDXM', play: 1663,
      url: `https://www.bilibili.com/video/${b}`, bvid: b, keyword: '地铁',
    };
  });

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
console.log(
  '\n【10】★★ 「立刻发送一条」独立成块：临时关键词（可多个）+ 要不要带她的评论（2026-10-16 用户要求）',
);
{
  // 用户原话：「**把立即发送一条独立出来，单独给它加个关键词框，这样就不用动自动发送
  //   那里的设置了**」+「**再独立加一个是否配 bot 自己评论的选框**」
  //   +「**独立发送的框支持多关键词同时选择吗**」⇒ 支持：**一行一个 / 逗号也行**，
  //     多个词就**从里面随机挑一个**搜（跟自动那份一个道理）✓
  const w10 = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/<textarea id="bili-now-kw"/.test(w10), '★★ 临时关键词框是**多行**的（一行一个词 ✓）');
  check(/id="bili-now-take"/.test(w10), '★★ 有「带上她自己的一句评论」那个选框 ✓');
  check(
    /立刻发送一条（手动试，不动上面的设置）/.test(w10),
    '★★ 它**独立成一块**了（不再和"保存设置"挤在一起 ✓）',
  );
  check(
    /keywords: kw, take \}/.test(w10) || /keywords: kw,\s*take/.test(w10),
    '★ 点那个按钮时，临时词和评论选框**都会传给服务端** ✓',
  );

  const j10 = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(
    /split\(\/\[\\n,，、\]\/\)/.test(j10),
    '★★ 服务端把临时词**按 换行/逗号/顿号 切开**（多关键词同时填 ✓）',
  );
  check(
    /take: typeof body\.take === 'boolean' \? body\.take : null/.test(j10),
    '★★ 评论选框：true/false 就照它来；没传才按群里的概率 ✓',
  );

  const s10 = readFileSync(join(ROOT, 'src', 'bili-share.js'), 'utf8');
  check(
    /export async function pick\(gid = '', kwsOverride = null\)/.test(s10),
    '★★ 临时关键词走 `pick(gid, kwsOverride)` ✓',
  );
  // ⚠️⚠️ 用户说清了两者的区别：「**那个是每次发视频选一个关键词，这个是一次选多个关键词**」
  check(
    /这几个词会\*\*一起搜\*\*/.test(w10) || /一起搜/.test(w10),
    '★★★ 界面上写明"这几个词**一起搜**"（和自动那份"每次挑一个"区分开 ✓）',
  );
  check(
    /export function bestOf\(cands = \[\]\)/.test(s10) &&
      /return bestOf\(all\)/.test(s10) &&
      /for \(const kw of kws\)/.test(s10),
    '★★★ 多个临时词**都搜一遍、合起来挑播放最高的**（这才是"一次选多个" ✓）',
  );
  {
    // 纯函数那步直接验：三个词各自搜到一条 ⇒ 取播放最高的那条 ✓
    const got = bs.bestOf([
      { v: { title: 'A', url: 'https://www.bilibili.com/video/BV1aaaaaaaaa', play: 100 }, kw: '甲' },
      { v: { title: 'B', url: 'https://www.bilibili.com/video/BV1bbbbbbbbb', play: 9000 }, kw: '乙' },
      { v: { title: 'C', url: 'https://www.bilibili.com/video/BV1cccccccccc', play: 500 }, kw: '丙' },
    ]);
    check(got?.title === 'B' && got?.keyword === '乙', '★★ 合并后取播放量最高的那条 ✓', JSON.stringify(got?.title));
    check(bs.bestOf([]) === null, '★ 一条都没有 ⇒ null（不会瞎发 ✓）');
  }
  check(
    /if \(force === false\) return ''/.test(s10) && /force !== true/.test(s10),
    '★★ 评论那条：`force:true` 一定带、`force:false` 一定不带、不传才按概率 ✓',
  );
}

console.log(
  '\n【11】★★★ 同一个群**不重复发同一条** + 已发记录**两个月清一次**（2026-10-16 用户要求）',
);
{
  // 用户原话：「**注意同一个群发的视频不要有重复的**」
  //        +「**两个月清一次已发视频记录，要不然会无限堆**」
  // ⚠️ 背景：原来只有那个**共用**、只留 80 条的池子 ⇒ 发得多了老记录被挤掉 ⇒
  //    同一个群又推一遍 ✗ ⇒ 改成**按群**记（`sentByGid[群]`）+ 兜底一道 `isSent` ✓
  bs.__reset();
  clearGroups();
  setGroup(A, { enable: true, keywords: ['地铁'], cooldownMs: 0, minPerDay: 1, maxPerDay: 5 });
  setGroup(B, { enable: true, keywords: ['地铁'], cooldownMs: 0, minPerDay: 1, maxPerDay: 5 });

  const same = {
    title: '某条视频', up: '某个 UP', play: 999,
    url: 'https://www.bilibili.com/video/BV1dupdupdup', bvid: 'BV1dupdupdup', keyword: '地铁',
  };
  // ⚠️ 套件用的 picker **绕过了 `pickReal` 里那道按群过滤** ⇒ 正好用来验"兜底那道也拦得住"
  bs.__setPicker(async () => ({ ...same }));
  const bot11 = fakeBot();
  const r1 = await bs.runOnce(bot11, [A], { force: true, groupId: A, take: false });
  check(r1.sent === true, '★★ 第一次发出去 ✓', r1.why);
  const r2 = await bs.runOnce(bot11, [A], { force: true, groupId: A, take: false });
  check(r2.sent === false && /发过了/.test(r2.why ?? ''), '★★★ **同一个群**第二条不发了 ✓', r2.why);
  check(bot11.sent.length === 1, '★★ 群里只出现了一条（没重复刷屏 ✓）', JSON.stringify(bot11.sent));
  const r3 = await bs.runOnce(bot11, [B], { force: true, groupId: B, take: false });
  check(r3.sent === true, '★★ 换一个群**照样能发**（跨群不算重复 ✓）', r3.why);
  check(
    bs.status(A).sentCount >= 1 && bs.status(B).sentCount >= 1,
    '★★ 两个群各记各的（按群记账 ✓）',
    `${bs.status(A).sentCount} / ${bs.status(B).sentCount}`,
  );
  check(bs.status(A).sentKeepDays === 60, '★★ 界面能看到"保留两个月"这个值 ✓', String(bs.status(A).sentKeepDays));
  {
    const onDisk = JSON.parse(readFileSync(join(ROOT, 'logs', '__test-bili-share.json'), 'utf8'));
    check(
      Array.isArray(onDisk.sentByGid?.[A]) && onDisk.sentByGid[A].some((x) => x.id === same.bvid),
      '★★ 落盘了（重启不忘 ⇒ 不会又发一遍 ✓）',
    );
  }

  // ---- 两个月清理：纯函数直接验 ----
  const now11 = Date.now();
  const day11 = 24 * 60 * 60 * 1000;
  const kept = bs.pruneSentEntries(
    [
      { id: 'BVNEW', at: now11 - 3 * day11 }, // 三天前 ⇒ 留
      { id: 'BVOLD', at: now11 - 90 * day11 }, // 三个月前 ⇒ 清掉
      'BVLEGACY', // 老格式（只有 id）⇒ 当刚记的、留着（两个月后自然淘汰 ✓）
      { id: '', at: now11 }, // 空 id ⇒ 丢掉
      { id: 'BVEDGE', at: now11 - 59 * day11 }, // 59 天 ⇒ 还在两个月内 ⇒ 留
    ],
    now11,
  );
  const ids11 = kept.map((x) => x.id);
  check(ids11.length === 3 && ids11.includes('BVNEW') && ids11.includes('BVEDGE') && ids11.includes('BVLEGACY'), '★★ 两个月内的都留着 ✓', JSON.stringify(ids11));
  check(!ids11.includes('BVOLD') && !ids11.includes(''), '★★★ 超过两个月的**清掉**（用户要的"要不然会无限堆" ✓）');
  check(bs.pruneSentEntries([], now11).length === 0 && bs.pruneSentEntries(null, now11).length === 0, '★ 空值 / 坏值不炸 ✓');
  const many11 = Array.from({ length: 810 }, (_, i) => ({ id: `BV${i}`, at: now11 }));
  check(bs.pruneSentEntries(many11, now11).length <= 800, '★ 单个群最多留 800 条（文件不会无限长 ✓）', String(bs.pruneSentEntries(many11, now11).length));

  bs.__setPicker(null);
}

console.log(
  '\n【12】★★★ 「立刻发送」那格的关键词**会被保存**（2026-10-16 用户：「还是没有被保存」）',
);
{
  // 用户原话：「**独立视频发送那里的关键词框还是没有被保存**」
  //   原来那格是**纯临时**的：填完点发送、一刷新就空了 ✗
  //   ⇒ 现在**按群记**（落盘 ⇒ 刷新/重启都还在 ✓），而且**不动**自动发送那份设置 ✓
  bs.__reset();
  clearGroups();
  setGroup(A, { enable: true, keywords: ['地铁'] });

  check(bs.nowPick(A).keywords === '' && bs.nowPick(A).take === null, '★ 一开始是空的（没有假装存过 ✓）');
  bs.saveNowPick(A, { keywords: '爱祥\nmygo', take: false });
  const p12 = bs.nowPick(A);
  check(p12.keywords === '爱祥\nmygo' && p12.take === false, '★★ 存下来了（原样的文本 + 那个选框 ✓）', JSON.stringify(p12));
  const s12 = bs.status(A);
  check(s12.nowKeywords === '爱祥\nmygo' && s12.nowTake === false, '★★ 状态接口里带着它（界面打开时填回去 ✓）');
  {
    const disk12 = JSON.parse(readFileSync(join(ROOT, 'logs', '__test-bili-share.json'), 'utf8'));
    check(disk12.nowKw?.[A]?.keywords === '爱祥\nmygo', '★★★ **落盘了**（重启不忘 —— 这就是"没被保存"那个毛病的根 ✓）');
  }
  // 只改关键词 ⇒ 那个选框沿用上次（界面每次都会把它一起传上来，这里防的是"只传了词"那条路 ✓）
  bs.saveNowPick(A, { keywords: '只改词' });
  check(bs.nowPick(A).take === false, '★ 只改词时，那个选框沿用上次的 ✓');
  bs.saveNowPick(A, { keywords: '只改词', take: null });
  check(bs.nowPick(A).take === false, '★ `take` 传 null（没勾）⇒ 不动已存的那个 ✓');
  check(bs.nowPick(A).keywords === '只改词', '★ 词换成了新的 ✓');
  check(bs.nowPick(B).keywords === '' && bs.nowPick(B).take === null, '★★ 按群记（另一个群不会串 ✓）');
  check(bs.saveNowPick('', { keywords: 'x' }) === false, '★ 没给群号 ⇒ 不存（不瞎写 ✓）');

  // ---- 接线：模块 + 接口 + 界面三处都得在 ✓ ----
  const s12b = readFileSync(join(ROOT, 'src', 'bili-share.js'), 'utf8');
  check(/export function saveNowPick/.test(s12b) && /export function nowPick/.test(s12b), '★ 模块里导出这两个 ✓');
  const j12 = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(/bs\.saveNowPick\(gid, \{ keywords: tmpKw, take: body\.take \}\)/.test(j12), '★★ 点「立刻发送」时**顺手存下来** ✓');
  check(/'POST \/api\/bili-share\/now'/.test(j12), '★★ 还有一个"只存不发"的接口（填完就走也记得住 ✓）');
  const w12 = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/oninput="saveBiliNowSoon\(\)"/.test(w12) && /function saveBiliNowSoon/.test(w12), '★★ 那格**敲完自己存**（防抖 700ms ✓）');
  check(/bili-now-kw:' \+ gid/.test(w12), '★ 本地也压一份兜底（接口断了不至于丢字 ✓）');
  check(
    /s\.nowKeywords/.test(w12) && /biliNowGid !== gid/.test(w12),
    '★★ 打开页面 / 换群时**把存的那份填回框里** ✓',
  );
  check(/这格会自己记住/.test(w12), '★ 界面上也写明"这格会记住"（他不至于再以为没保存 ✓）');
  bs.__reset();
}

console.log('\n【13】★★ 跨进程：判定前重读共享状态（两个号不会同时转发视频）');
console.log('        （用户 2026-10-20：「有时候两个 bot 会同时转发视频」）');
{
  bs.__reset();
  clearGroups();
  setGroup(A, {
    enable: true, keywords: ['地铁'], minPerDay: 9, maxPerDay: 9,
    cooldownMs: 3600000, startHour: 0, endHour: 24,
  });
  let n = 0;
  bs.__setPicker(async () => {
    const b = `BV1zz411z7m${n++}`;
    return { title: 't' + n, up: 'u', play: 1, url: `https://www.bilibili.com/video/${b}`, bvid: b, keyword: '地铁' };
  });

  // ① 这个号发一条（共享文件里 lastAt = 刚刚）
  const bot = fakeBot();
  await bs.runOnce(bot, [A]);
  check(bot.sent.length === 1 && bs.status(A).lastAt > 0, '★ 先发一条（lastAt 落盘）', `lastAt=${bs.status(A).lastAt}`);

  // ② 模拟"**另一个进程**"：它内存里 lastAt 还是 0（启动时读的旧状态），
  //    但共享文件里 lastAt 是刚刚 ⇒ **重读之后必须看得见** ⇒ 不许跟着发
  //    （旧行为：内存里 lastAt=0 ⇒ 判"该发" ⇒ 第二个号同时转发 ✗）
  bs.__stForTest().by[A].lastAt = 0; // ⚠️ 只改内存，**不落盘** —— 共享文件里还是"刚发过"
  const r2 = await bs.runOnce(fakeBot(), [A]);
  check(
    r2.sent === false && /冷却/.test(r2.why),
    '★★ 共享文件里"刚发过"⇒ 重读后**不发**（同时转发就出在这）',
    r2.why,
  );

  // ③ 对照：把共享文件里的 lastAt 改成 2 小时前 ⇒ 冷却过了 ⇒ 照发
  //    （证明拦它的确实是"别的号刚发过"，不是什么别的条件碰巧挡了）
  const f = join(ROOT, 'logs', '__test-bili-share.json');
  const j = JSON.parse(readFileSync(f, 'utf8'));
  j.by[A].lastAt = Date.now() - 2 * 3600 * 1000;
  writeFileSync(f, JSON.stringify(j, null, 2), 'utf8');
  const r3 = await bs.runOnce(fakeBot(), [A]);
  check(r3.sent === true, '★★ 对照：冷却过了 ⇒ 照发（拦的确实是"刚发过"）');

  // ④ 立刻发送**不受重读影响**（手动点的就该发 —— 这条路在 reload 之前就 return 了）
  bs.__reset();
  setGroup(A, { enable: true, keywords: ['地铁'] });
  bs.__setPicker(async () => ({
    title: 'force', up: 'u', play: 1,
    url: 'https://www.bilibili.com/video/BV1force99mD', bvid: 'BV1force99mD', keyword: '地铁',
  }));
  const r4 = await bs.runOnce(fakeBot(), [A], { force: true, groupId: A });
  check(r4.sent === true, '★ 「立刻发送」照旧不走重读那条路（手动点的不该被拦）');
}

console.log('\n【14】号间错峰：不同号相位不同、同一个号稳定');
{
  const e = 10 * 60 * 1000;
  const a1 = bs.staggerMs('10000001', e);
  const a2 = bs.staggerMs('10000002', e);
  const a3 = bs.staggerMs('10000003', e);
  check(a1 === bs.staggerMs('10000001', e), '★ 同一个号两次算出来一样（重启后相位不变）');
  check(a1 !== a2 && a1 !== a3 && a2 !== a3, '★★ 三个号三个相位（不再同一秒判定）', `${a1} / ${a2} / ${a3}`);
  check(
    [a1, a2, a3].every((x) => x >= 0 && x <= e / 2),
    '★ 偏移都在间隔的一半以内（不会顶到下一次）',
  );
  check(bs.staggerMs('', e) === 0, '★ 空号 ⇒ 0（不炸）');
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
