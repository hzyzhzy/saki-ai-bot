#!/usr/bin/env node
/**
 * 给 **agent** 用的 B 站查询工具（2026-10-19 加）
 *
 * ## 为什么要这个
 *   用户原话：「把**询问 b站内容的问题都接入 b站工具**，**直接把问题丢给 agent**，
 *     但是让 agent 的回复**尽量快速简短，节约时间和 token**」。
 *   只把问题丢给 agent，它会**自己上网翻 HTML** —— 又慢又费 token，标题还容易抄错 ✗
 *   给它一条现成命令，它跑一条就拿到结果 ✓
 *
 * ## ⚠️ 但要**灵活**（2026-10-19 用户第二句：「agent 应该有更灵活的查询方式吧」）
 *   所以不是只给它几个写死的子命令：
 *   ① 常用查询有子命令 + **可选参数**（排序 / 分区 / 时间范围 / 条数）；
 *   ② 不够用就 `raw <函数名> <JSON>` —— **直接把参数交给 `src/bilibili.js` 里那个函数**，
 *      那边有什么能力它就能用什么能力（不用改我这个脚本）；
 *   ③ `--json` 让它自己加工（默认给的是「一行一条」的纯文本，能照抄就照抄）。
 *
 * ## 用法
 *   ```
 *   node tools/bili.mjs                                   # 打用法（agent 忘了就看这个）
 *   node tools/bili.mjs hot 8                             # 全站热门榜前 8
 *   node tools/bili.mjs hot game 8                        # 分区热门（game / 动画 / 音乐 …）
 *   node tools/bili.mjs search 关键词 8                    # 按关键词搜，默认按播放量
 *   node tools/bili.mjs search 关键词 8 --order=pubdate    # 按最新
 *   node tools/bili.mjs search 关键词 8 --order=dm         # 按弹幕
 *   node tools/bili.mjs search 关键词 8 --tid=4 --pubtime=30   # 限定分区 + 最近 30 天
 *   node tools/bili.mjs up UP主名 8                        # 某个 UP 主的近期投稿
 *   node tools/bili.mjs video BV1xx411c7mD                 # 单条视频的播放/点赞
 *   node tools/bili.mjs owner 8                            # 服主自己的投稿
 *   node tools/bili.mjs raw searchVideos '{"keyword":"原神","limit":5,"order":"pubdate"}'
 *   node tools/bili.mjs raw videoInfo '["BV1xx411c7mD"]' --json
 *   ```
 *   ⚠️ 参数可以**任意顺序**；`--json` 加在最后（或任意位置）都认。
 *
 * ## 两条讲究
 *   ① 默认输出是「一行一条」的纯文本，**照抄就行** —— agent 见到 JSON 就会想"加工"，反而变慢变长 ✗
 *   ② 失败只报**一句人话**（「查不到：搜不到结果」），**不把 `HTTP 412` 这种内部错误码打出去** ✗
 *      （它最终会进群，见 `src/bilibili.js` 里那条老规矩）
 */

import * as bili from '../src/bilibili.js';

const argv = process.argv.slice(2);
const out = (s) => process.stdout.write(`${String(s ?? '')}\n`);

/** `--json` 开关（可以出现在任意位置） */
const asJson = argv.some((x) => x === '--json' || x === '-j');
/** 取指定 `--key=value` 的值 */
const opt = (key, dflt = undefined) => {
  const hit = argv.find((x) => x.startsWith(`--${key}=`));
  return hit === undefined ? dflt : hit.slice(key.length + 3);
};
/** 去掉 `--json` 之后的"实参"（⚠️ 别把所有 `--xxx` 都滤掉 —— `raw` 要用 `--key=value`） */
const args = argv.filter((x) => x !== '--json' && x !== '-j');
/** 参数里的数字 = 条数（1~20，缺省 8） */
const pickLimit = (dflt = 8) => {
  const n = Number(args.find((x, i) => i > 0 && /^\d+$/.test(x)));
  return Number.isFinite(n) && n > 0 ? Math.min(20, n) : dflt;
};
/** 非数字实参 = 关键词 / 分区名 / 名字 */
const words = () => args.slice(1).filter((x) => !/^\d+$/.test(x));

const day = (ts) => (ts ? new Date(Number(ts) * 1000).toLocaleDateString('zh-CN') : '');

/**
 * ⚠️⚠️ 换身份重试（2026-10-19 加，用户：「**agent 应该有办法避开风控和限流吧**」）
 *
 * B 站对"同一个 buvid 连续来"会返 `-352 / -412 / -799`（风控 / 限流）——
 * 但**换个身份往往立刻就通**。`src/bilibili.js` 里 `__clearCache()` 会把
 * `biliCookie` 清掉，下一次请求 `ensureBuvid()` 会重新去要一个**新的 buvid**
 * （`upVideos()` 自己就是这么重试 3 遍的，见那边的注释）。
 * ⇒ 这里把它提到工具层：**任何一条命令**失败都自动换个身份再试一遍 ✓
 */
async function withRetry(fn, times = 2) {
  let last;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i + 1 < times) {
        bili.__clearCache(); // 换身份（下次请求会要新的 buvid）
        await new Promise((r) => setTimeout(r, 400 + i * 800));
      }
    }
  }
  throw last;
}
const line = (v, i, extra = '') =>
  `· ${i + 1}. ${v.title}（UP：${v.up ?? v.author ?? '未知'}，播放 ${bili.fmtNum(v.play ?? v.view ?? 0)}` +
  `${v.date ? `，${day(v.date)}` : ''}${v.bvid ? `，${v.bvid}` : ''}${extra}）`;

const USAGE = [
  '用法：node tools/bili.mjs <命令> [参数…]',
  '  hot    [分区] [条数]                全站/分区热门榜（不写分区 = 全站）',
  '  search <关键词> [条数] [选项]        按关键词搜（默认按播放量）',
  '         选项：--order=click|pubdate|dm|stow   排序：播放/最新/弹幕/收藏',
  '               --tid=分区号                    限定分区',
  '               --pubtime=天数                  只看最近几天',
  '  up     <UP主名> [条数]              某个 UP 主的近期投稿',
  '  video  <BV号>                      单条视频的播放 / 点赞',
  '  owner  [条数]                      服主自己的投稿',
  '  raw    <函数名> [实参…] [--key=值]  直接调 src/bilibili.js 里的函数（最灵活）',
  '         ⚠️ 推荐用 --key=值（JSON 里的双引号在某些 shell 下会被吃掉）',
  '         例：raw searchVideos --keyword=原神 --limit=5 --order=pubdate',
  "         例：raw searchVideos 原神 '{\"limit\":5,\"order\":\"pubdate\"}'",
  "             raw upVideos 马小花儿 '{\"limit\":3}'",
  "             raw videoInfo '[\"BV1xx411c7mD\"]'",
  '  --json                            输出原始 JSON（默认是「一行一条」的纯文本）',
  '可用的 raw 函数：' + Object.keys(bili).filter((k) => !k.startsWith('__')).join(' / '),
].join('\n');

/** `raw <函数名> [实参…]` —— 实参**按位置**传；能当 JSON 解析的就解析，否则当字符串 ✓ */
async function raw() {
  const fn = String(args[1] ?? '').trim();
  if (!fn) throw new Error('没给函数名（不带参数会打用法）');
  const f = bili[fn];
  if (typeof f !== 'function') throw new Error(`没有这个函数：${fn}`);
  // ⚠️ 两条写法都认（`--key=value` 优先，因为它**不会掉进引号地狱** ——
  //    PowerShell / cmd 传 JSON 时会把里面的双引号吃掉，JSON.parse 直接失败 ✗）：
  //      raw searchVideos --keyword=原神 --limit=5 --order=pubdate
  //      raw searchVideos 原神 '{"limit":5}'          ← JSON 也行，但某些 shell 会吃引号
  const opts = {};
  let hasOpt = false;
  const positional = [];
  for (const x of args.slice(2)) {
    const m = /^--([A-Za-z_][\w-]*)=(.*)$/.exec(String(x));
    if (m) {
      hasOpt = true;
      opts[m[1]] = coerce(m[2]);
      continue;
    }
    const t = String(x).trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const v = JSON.parse(t);
        // ⚠️ 数组 ⇒ **展开成多个实参**（`raw videoInfo '["BV…"]'` 那种写法最省事）✓
        positional.push(...(Array.isArray(v) ? v : [v]));
        continue;
      } catch {
        /* 不是合法 JSON ⇒ 当普通字符串 */
      }
    }
    positional.push(t.replace(/^['"]|['"]$/g, ''));
  }
  // ⚠️⚠️ 有些函数第一个参数是**"主参数"**（关键词 / 名字 / BV 号），选项在第二个 ——
  //    `--keyword=…` 必须**提回位置参数**，否则它会整个对象被当成关键词 ✗
  //    （实测没提的时候：`searchVideos({...})` ⇒ 关键词变成 `[object Object]` ⇒
  //      搜出来一堆标题里带 "object" 的视频 ✗）
  for (const k of ['keyword', 'name', 'uid', 'bvid', 'text']) {
    if (k in opts) {
      positional.unshift(opts[k]);
      delete opts[k];
      break;
    }
  }
  const hasOpts = hasOpt && Object.keys(opts).length > 0;
  return hasOpts ? await f(...positional, opts) : await f(...positional);
}

/** `--key=value` 的值：能当数字/布尔就转，否则原样字符串 */
function coerce(v) {
  const t = String(v ?? '').trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  return t;
}

try {
  const cmd = String(args[0] ?? '').toLowerCase();
  const r = await (async () => {
    if (cmd === 'hot') return withRetry(() => bili.hotFacts({ query: { mode: words()[0] ?? 'all' }, limit: pickLimit() }));
    if (cmd === 'search') {
      const kw = words()
        .filter((x) => !/^--/.test(x))
        .join(' ')
        .trim();
      if (!kw) throw new Error('没给关键词');
      const list = await withRetry(() => bili.searchVideos(kw, {
        limit: pickLimit(),
        order: String(opt('order', 'click')),
        tids: Number(opt('tid', 0)) || 0,
        pubtime: Number(opt('pubtime', 0)) || 0,
      }));
      return list;
    }
    if (cmd === 'up') {
      const name = words().join(' ').trim();
      if (!name) throw new Error('没给 UP 主名');
      const u = await withRetry(() => bili.upVideos(name, { limit: pickLimit() }));
      if (u.noAuthor) throw new Error(`B 站没搜到「${name}」这个人`);
      return { note: `（${name}｜${u.fresh ? '按发布时间倒排' : '按播放量排'}）`, list: u.list };
    }
    if (cmd === 'video') {
      const bv = words()[0];
      if (!bv) throw new Error('没给 BV 号');
      const v = await withRetry(() => bili.videoInfo(bv));
      if (!v) throw new Error('没查到这条视频');
      return [v];
    }
    if (cmd === 'owner') return withRetry(() => bili.ownerVideoFacts({ limit: pickLimit() }));
    if (cmd === 'raw') return raw();
    return undefined;
  })();

  if (r === undefined) {
    out(USAGE);
    process.exitCode = cmd ? 2 : 0;
  } else if (asJson) {
    // `--json`：原样给它，怎么加工随它 ✓
    out(JSON.stringify(r));
  } else if (typeof r === 'string') {
    out(r);
  } else if (r && Array.isArray(r.list)) {
    if (r.note) out(r.note);
    out(r.list.map((v, i) => line(v, i)).join('\n'));
  } else if (Array.isArray(r)) {
    out(r.map((v, i) => line(v, i)).join('\n'));
  } else if (r && typeof r === 'object' && r.title) {
    out(line(r, 0));
  } else {
    out(JSON.stringify(r));
  }
} catch (e) {
  // ⚠️ 只报人话，别把内部错误码（`HTTP 412` 那种）打出去 —— 它会照抄进群 ✗
  out(`查不到：${String(e?.message ?? e).replace(/HTTP\s*\d{3}/gi, '').trim()}`);
  process.exitCode = 1;
}
