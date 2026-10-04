/**
 * B站分流的测试（2026-09-14 用户报的真 bug）。
 *
 * ## 用户实测（截图）
 *
 * 他问：「最近 **b站** 有什么比较火的**视频**」
 * 机器人答：「B站接口412了，拉不出来」
 *
 * **根因**：`looksLikeVideoQuestion()` 的判据是
 *   「有 B站/视频 这类词」+「有 多少/最近 这类词」→ 两个都中就当成"问我的投稿"。
 * 于是**任何聊 B站视频的话都被抓走**，去拉他的投稿（那个接口恰好被限流），
 * **而真正该走的"搜热门视频"（`search.js` 的 `bilibiliSearch`）压根没被执行到**。
 *
 * ⚠️ 实测过：同一时刻「搜视频」接口是好的（`code=0` 能出 12 条结果），
 *    只有「拉某人投稿」被封。**所以这是纯分流 bug，不是 B站 挂了。**
 *
 * ## 现在的判据
 *
 * 必须带**明确的归属信号**才算"问我的视频"：
 *   「我的视频」「我的 B站」「我发的」「我投的」「涨粉」「掉粉」、或直接报 UID
 *
 * ⚠️ 纯离线（纯函数 + 源码断言），不联网、不花钱。
 *
 * 用法: node test/bilibili-scope.js
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

const CFG_REL = 'logs/__test-bili-scope.yml';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'bilibili:',
    '  enable: true',
    '  ownerUid: "30000001"',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const bili = await import('../src/bilibili.js');
const UID = '30000001';
/** 服主问的（isOwner=true） */
const ask = (t) => bili.looksLikeVideoQuestion(t, true, UID);

console.log('\n【1】★ 用户报的那句：必须**不算**问自己（要放给搜索）');
{
  // ⚠️ 这是这次的真 bug：原来它会命中，然后去拉投稿 → 被限流 → 报错
  const shouldGoToSearch = [
    '最近b站有什么比较火的视频',
    'b站最近什么梗火',
    'B站有什么火的视频',
    '搜一下B站上的MC视频',
    '这个视频播放量多少', // 问的是别的视频
    'B站那个视频是怎么回事',
    'b站最近有什么好玩的',
  ];
  for (const t of shouldGoToSearch) {
    check(ask(t) === false, `「${t}」→ **不抓走**（交给搜索）`);
  }
}

console.log('\n【2】★ 明确问"我的视频"才算（这才是这个功能的本意）');
{
  const shouldBeMine = [
    '我的视频播放量怎么样',
    '我的b站数据如何',
    '我发的视频最近怎么样',
    '我投的视频有人看吗',
    '我上传的那个视频播放多少',
    '我b站涨粉了吗',
    '最近掉粉了吗',
    '我的播放量最近怎么样',
  ];
  for (const t of shouldBeMine) {
    check(ask(t) === true, `「${t}」→ 抓走（报他的投稿数据）`);
  }
}

console.log('\n【3】直接报 UID 也算（那是明确指向他的号）');
{
  check(ask(`30000001 播放量多少`) === true, '报 UID 的 → 抓走');
  check(ask(`${UID} 最近怎么样`) === true, 'UID + 最近 → 抓走');
  check(ask('394060601 播放量') === false, '别的 UID → 不抓（那是别人的号）');
}

console.log('\n【4】不属于这个功能的（完全不提视频）');
{
  for (const t of ['今天服务器有人吗', '你在干嘛', '晚上吃啥', '哈哈哈']) {
    check(ask(t) === false, `「${t}」→ 不抓`);
  }
}

console.log('\n【5】边界：只对服主生效、长度限制');
{
  check(bili.looksLikeVideoQuestion('我的视频播放量怎么样', false, UID) === false, '群友问 → 不抓（只服务服主）');
  check(ask('我的视频' + '啊'.repeat(60)) === false, '超长消息 → 不抓');
  check(ask('') === false, '空串 → 不抓');
  let threw = false;
  try {
    bili.looksLikeVideoQuestion(undefined, true, UID);
  } catch {
    threw = true;
  }
  check(!threw, 'undefined 不抛异常');
}

console.log('\n【6】★ 退避按接口分开记（不再一个封全封）');
{
  const src = readFileSync(join(ROOT, 'src', 'bilibili.js'), 'utf8');
  check(/const throttles = new Map\(\)/.test(src), '退避表是 Map（按接口）');
  check(/function throttledUntil\(endpoint\)/.test(src), '查询按 endpoint');
  check(/function bumpThrottle\(endpoint/.test(src), '标记按 endpoint');
  // ⚠️ 全局变量必须清干净 —— 留着它就意味着"一个接口封了全都停"
  const stale = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter((l) => /throttleUntil/.test(l));
  check(stale.length === 0, `代码里没有全局 throttleUntil 了（实际 ${stale.length} 处）`);
  check(/EP_ARC/.test(src) && /throttles\.clear\(\)/.test(src), '清缓存时也会清退避表');
}

console.log('\n【7】★ 限流时不许把错误码甩给用户');
{
  const src = readFileSync(join(ROOT, 'src', 'bilibili.js'), 'utf8');
  // ⚠️ 原来的事实文本是 `（拉 B站 数据失败：${r.error}）`，r.error 是 "HTTP 412"，
  //    模型就照念「B站接口412了」。
  check(
    !/拉 B站 数据失败：\$\{r\.error/.test(src),
    '事实文本里不再直接插 r.error（那会带出 HTTP 412）',
  );
  // ⚠️ 别用"抠函数体"那种脆正则 —— 函数里有 `// ⚠️` 注释行，
  //    我第一版写的 /export async function ownerVideoFacts[\s\S]{0,900}?\n}/ 就漏了。
  //    直接断言整个文件里有这两句关键要求即可。
  check(/别说任何数字、别提错误码/.test(src), '明确交代了「别提错误码」');
  check(/现在查不到，过会儿再问/.test(src), '给了自然的口语说法');
  check(/限流\|412\|799\|429/.test(src), '限流和真故障分开处理');
}

console.log('\n【8】退避时长够长（别勤快地反复撞）');
{
  const src = readFileSync(join(ROOT, 'src', 'bilibili.js'), 'utf8');
  const m = src.match(/const throttleMs = \(\) =>[^;]+;/);
  const mins = Number((m?.[0] ?? '').match(/(\d+)\s*\*\s*60\s*\*\s*1000/)?.[1] ?? 0);
  check(mins >= 30, `默认退避 ≥30 分钟（实际 ${mins} 分钟）`);
}

console.log('\n【9】★「最近 mc / 籽岷 有什么火的视频」（2026-09-15 用户要求）');
{
  // 用户原话：「可以问她最近 mc 或者籽岷有什么比较火的视频吗」
  const q1 = bili.hotQuery('最近mc有什么比较火的视频');
  check(q1?.mode === 'topic' && q1.keyword === '我的世界', '「最近 mc 有什么比较火的视频」→ 按**题材**搜「我的世界」');
  const q2 = bili.hotQuery('籽岷最近有什么视频');
  check(q2?.mode === 'up' && q2.name === '籽岷', '「籽岷最近有什么视频」→ 按 **UP 主**搜');
  check(bili.hotQuery('籽岷最近有什么比较火的视频')?.name === '籽岷', '「籽岷最近有什么比较火的」→ 也认');
  check(bili.hotQuery('b站最近有什么火的视频')?.mode === 'all', '「b站最近有什么火的视频」→ **全站热门**（老功能保住）');
  check(bili.hotQuery('b站热榜')?.mode === 'all', '「b站热榜」→ 全站热门');
  // ⚠️ 别抢"问他自己投稿"（那是 ownerVideoFacts 的活）
  check(bili.hotQuery('我最近视频播放量怎么样') === null, '问**他自己投稿**的 → 不抢');
  // ⚠️ 太含糊的别抢（交给正常聊天）
  check(bili.hotQuery('最近有什么火的视频') === null, '没提题材/人名/B站 → 不抢（太含糊）');
  check(bili.hotQuery('今天下午开黑吗') === null, '普通闲聊 → 不抢');
  check(bili.hotQuery('') === null && bili.hotQuery(undefined) === null, '空串/undefined → 不抢（也不抛）');
}

console.log('\n【10】★ 搜出来的东西要**筛**（B站会拆词、会混进别人的视频）');
{
  // ⚠️ 实测两个坑：
  //   ① 搜「我的世界」会被 B站**拆词**（拆成"我的"+"世界"），混进
  //      《世界上的另一个我》《这是我的世界》这种蹭字的；
  //   ② 搜「籽岷」会混进**别人做的、提到他的**视频（实测 30 条里 3 条不是他的）。
  const realFetch = globalThis.fetch;
  const urls = [];
  const headers = [];
  const canned = {
    我的世界: [
      { title: '<em class="keyword">我的世界</em>克苏鲁全集', author: '这名玩家', play: 25724177, pubdate: 1743206400, bvid: 'BV1' },
      { title: '世界上的另一个我', author: 'TF家族', play: 39070000, pubdate: 1625875200, bvid: 'BV2' },
    ],
    籽岷: [
      { title: '籽岷的模组生存 第一集', author: '籽岷', play: 960271, pubdate: 1790000000, bvid: 'BV3' },
      { title: '籽岷讲一下当初怎么认识的', author: '千舸竞流', play: 1, pubdate: 1791000000, bvid: 'BV4' },
    ],
  };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    urls.push(u);
    headers.push(init?.headers ?? {});
    const kw = decodeURIComponent((u.match(/keyword=([^&]*)/) ?? [])[1] ?? '');
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { result: canned[kw] ?? [] } }) };
  };
  try {
    const tv = await bili.topicVideos('我的世界', { tids: 17, match: /(我的世界|minecraft|\bmc\b)/i });
    check(tv.length === 1, `题材搜索**筛掉蹭字的**（《世界上的另一个我》不许进来，实际剩 ${tv.length} 条）`);
    check(tv[0]?.title === '我的世界克苏鲁全集', '标题里的 `<em>` 高亮标签洗掉了');
    const uv = await bili.upVideos('籽岷');
    check(uv.list.length === 1 && uv.list[0].up === '籽岷', 'UP 主搜索**只留作者本人**（别人的不混进来）');
    check(uv.fresh === true, '有近 90 天内的稿 → fresh=true');
    check(
      headers.length > 0 && headers.every((h) => /buvid3=/.test(String(h?.Cookie ?? ''))),
      '每个搜索请求都带 **buvid3**（不带时 B站会回 HTTP 412，实测踩过）',
    );
    check(urls.length >= 2, `UP 主那条会拉不止一遍（时间筛时灵时不灵要重试，实际 ${urls.length} 次请求）`);
    check(urls.some((u) => /pubtime=30/.test(u)), '用 `pubtime` 做时间筛');
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('\n【12】★「Luminiflux有什么视频」要**真去查**（2026-09-15 用户截图）');
{
  // 用户截图：他问「Luminiflux有什么视频」→ 她答「Luminiflux是谁啊，**我去搜搜**」
  // → 用户「快去搜」→ **没下文**。用户原话：「这种能不能**真的去做这件事情**然后给回复」。
  check(
    bili.hotQuery('Luminiflux有什么视频')?.mode === 'up',
    '「<名字>有什么视频」→ 按 **UP 主**真去 B站 查（原来认不出来 → 只答"我去搜搜"）',
  );
  check(bili.hotQuery('Luminiflux的视频')?.name === 'Luminiflux', '「<名字>的视频」→ 也认');
  check(bili.hotQuery('籽岷的视频')?.mode === 'up', '中文名同理');
  check(bili.hotQuery('群里有什么视频') === null, '「群里有什么视频」→ **不抢**（那不是人名）');
  check(bili.hotQuery('这个视频播放量多少') === null, '「这个视频…」→ 不抢（那是问某个具体视频）');

  const src = readFileSync(join(ROOT, 'src', 'bilibili.js'), 'utf8');
  const botSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const guard = readFileSync(join(ROOT, 'src', 'attribution-guard.js'), 'utf8');
  check(/noAuthor/.test(src) && /e\.noAuthor/.test(botSrc), 'B站没这个人 → 标 `noAuthor`，交给正常搜索（**不硬答**）');
  check(
    /fallThrough/.test(botSrc) && /放行走正常搜索/.test(botSrc),
    '★ 没这个人时**放行**（继续走网页搜索那条真去查的路）',
  );
  check(!/没搜到「\$\{wanted\}」本人的投稿，下面/.test(src), '不再拿"别人做的视频"冒充他本人的投稿');
  check(/绝对不许改成"空头承诺"/.test(guard), '★ 归属核对里明令**不许改成"我去搜搜"**这种空头承诺');
  check(/noteLookupPromise/.test(botSrc) && /takeLookup/.test(botSrc), '★ 万一是承诺也记下"欠着一件事"');
  check(/真的去查/.test(botSrc), '  ↳ 他催一句「快去搜」→ **换成原来那个问题**真去查');
  check(/setLastHot/.test(src) && /setLastHot\(promptText/.test(botSrc), '记住上一轮 → 接着问「那…」时能**接上文**');
}

console.log('\n【13】★ @ 前缀不许混进解析（2026-09-15 日志实测）');
{
  // 日志原文（她实际拿到的）：
  //   `@saki酱saki酱saki酱saki酱saki酱 Ch1hayaAnon_QWQ有什么视频`
  // 她原来提取出来的是 `hayaAnon_QWQ`（被 12 字上限砍掉一半）→ 拿错名字去搜
  const at = '@saki酱saki酱saki酱saki酱saki酱 Ch1hayaAnon_QWQ有什么视频';
  const q = bili.hotQuery(at);
  check(q?.mode === 'up' && q.name === 'Ch1hayaAnon_QWQ', `★ @ 前缀去掉、长昵称不许截断（实际 ${JSON.stringify(q)}）`);
  check(
    bili.hotQuery('@某个人 籽岷最近有什么视频')?.name === '籽岷',
    '@ 前缀 + 中文名 → 也只留名字',
  );
  // ⚠️ @ 的正好是她自己时，「@她的名字 有什么视频」不该把她的名字当人名去搜
  check(bili.hotQuery('@saki酱有什么视频') === null, '「@她的名字 有什么视频」→ 不把人名当成 UP 主');
  // ⚠️ 但**提示词那边的文本不能动** —— 「@<主人> …」是"@ 的是别人"的信号（见 test/at-other.js）
  const botSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    !/promptText\s*=\s*promptText\.replace\(\/\^\(\?:@/.test(botSrc),
    '没有在提示词文本上动 @（那个信号要留着）',
  );
}


console.log('\n【11】★「最近」拿不到就照实说（别吹成刚发的）');
{
  const src = readFileSync(join(ROOT, 'src', 'bilibili.js'), 'utf8');
  check(/没抓到他最近发的新稿/.test(src), '拿不到新稿 → 事实里**明确告诉模型别提"最近刚发"**');
  check(/v\.up === wanted/.test(src), 'UP 主那条**按作者本人**筛');
  check(/tids: 17/.test(src) && /我的世界/.test(src), 'MC 走了分区（`tids=17` 单机游戏）');
  check(/允许筛完不够就放开分区/.test(src) || /list\.length < 4/.test(src), '分区筛太狠时会放开再拿一遍');
  // ⚠️ 不许再用 `order=pubdate` 拿 UP 主的稿 —— 实测那一遍回来的**全是别人的**视频
  check(/order: 'pubdate'/.test(src) === false, '不再拿 `order=pubdate` 当"某人的最新"（实测全是别人的）');
}


try {
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
