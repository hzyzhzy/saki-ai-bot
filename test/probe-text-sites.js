/**
 * 探针：哪些**以文字为主**的站能抓（找热梗/ACG 信息）。
 *
 * 用户 2026-09-13：「那还有没有像小红书这类**文字为主**的，文字肯定更容易获取信息」——
 * 对。纯文字站的 HTML 直接就是内容，不像小红书/抖音是 JS 壳 + 反爬。
 *
 * 判据（都实测，不猜）：
 *   · HTTP 状态
 *   · 页面上**有没有真的文字内容**（不是 JS 壳、不是验证码）
 *   · 能不能从 HTML 里抠出「标题 + 链接」这种可用的东西
 *
 * 用法: node test/probe-text-sites.js [关键词]
 */
const q = process.argv[2] || '中国人能飞';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/203.0.113.10 Safari/537.36';

const strip = (s) =>
  String(s ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const get = async (url, headers = {}) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers },
      signal: ctl.signal,
    });
    const txt = await r.text();
    return { status: r.status, txt, err: '' };
  } catch (e) {
    return { status: 0, txt: '', err: e.message };
  } finally {
    clearTimeout(t);
  }
};

/** 抓到的"有效文字量"—— JS 壳/验证码页这个数会很小或全是模板话 */
const useful = (txt) => strip(txt).length;

/** 能不能抠出「标题 + 链接」 */
const extract = (txt, re) => {
  const out = [];
  let m;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = r.exec(txt)) && out.length < 3) {
    const t = strip(m[1] ?? '').slice(0, 60);
    if (t) out.push(`${t}  →  ${String(m[2]).slice(0, 70)}`);
  }
  return out;
};

const enc = encodeURIComponent(q);
const sites = [
  // ── 百科 / 梗词典（最对口）──
  ['萌娘百科(搜索)', `https://zh.moegirl.org.cn/index.php?search=${enc}`, /<a[^>]+href="(\/zh-cn\/[^"]+)"[^>]*title="([^"]+)"/],
  ['萌娘百科(API)', `https://zh.moegirl.org.cn/api.php?action=opensearch&search=${enc}&limit=5&format=json`, null],
  ['小鸡词典', `https://jikipedia.com/search?phrase=${enc}`, null],
  ['百度百科', `https://baike.baidu.com/search?word=${enc}`, null],

  // ── 论坛 / 问答（文字为主）──
  ['百度贴吧', `https://tieba.baidu.com/f/search/res?qw=${enc}`, /<a[^>]+href="(\/p\/\d+)"[^>]*>([\s\S]{0,80}?)<\/a>/],
  ['NGA(游戏论坛)', `https://bbs.nga.cn/thread.php?key=${enc}`, null],
  ['豆瓣(小组搜索)', `https://www.douban.com/group/search?cat=1013&q=${enc}`, null],
  ['知乎(API)', `https://www.zhihu.com/api/v4/search_v3?t=general&q=${enc}&limit=5`, null],

  // ── 微博 ──
  ['微博(移动版)', `https://m.weibo.cn/api/container/getIndex?containerid=100103type%3D1%26q%3D${enc}&page_type=searchall`, null],
];

for (const [name, url, re] of sites) {
  const r = await get(url, name.includes('萌娘') || name.includes('NGA') ? { Referer: 'https://www.google.com/' } : {});
  const text = strip(r.txt);
  const flags = [];
  if (/验证码|安全验证|captcha|人机验证|滑动验证/i.test(r.txt)) flags.push('⚠️验证码');
  if (/<script/i.test(r.txt) && text.length < 400) flags.push('⚠️疑似JS壳');
  if (/403|访问过于频繁|拒绝访问|Forbidden/i.test(r.txt)) flags.push('⚠️被拒');
  console.log(`\n${name}`);
  console.log(`  status ${r.status} | HTML ${r.txt.length} | 有效文字 ${text.length} ${flags.join(' ')}`);
  if (r.err) console.log(`  ERR ${r.err}`);
  // 正文样本（前 150 字）——最能说明"有没有真内容"
  console.log(`  正文样本：${text.slice(0, 150)}`);
  if (re) {
    const hits = extract(r.txt, re);
    if (hits.length) {
      console.log('  可抠出的条目：');
      for (const h of hits) console.log(`    · ${h}`);
    } else {
      console.log('  （按给定选择器没抠出条目）');
    }
  }
}
