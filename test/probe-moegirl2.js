/**
 * 探针：萌娘百科哪些接口还能用（api.php 被禁了，试试 REST / 其他端点）。
 *
 * 用法: node test/probe-moegirl2.js [关键词]
 */
const q = process.argv[2] || '鸡你太美';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const tryIt = async (name, url, headers = {}) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers },
      signal: ctl.signal,
    });
    const txt = await r.text();
    console.log(`\n[${name}] status ${r.status} | len ${txt.length}`);
    console.log(`  ${txt.slice(0, 300).replace(/\s+/g, ' ')}`);
    return txt;
  } catch (e) {
    console.log(`\n[${name}] ERR ${e.message}`);
    return '';
  } finally {
    clearTimeout(t);
  }
};

const enc = encodeURIComponent(q);
const base = 'https://zh.moegirl.org.cn';

// ① MediaWiki REST API（跟 api.php 是两套，权限往往不同）
await tryIt('REST search', `${base}/rest.php/v1/search/page?q=${enc}&limit=5`);
// ② REST 直接取页面
await tryIt('REST page', `${base}/rest.php/v1/page/${enc}`);
// ③ 有无 opensearch 的 HTML 版
await tryIt('opensearch html', `${base}/index.php?title=Special:Search&search=${enc}&fulltext=1&ns0=1`, {
  Accept: 'text/html',
});
// ④ 静态 JSON（有些 wiki 会导出）
await tryIt('api 只读探测', `${base}/api.php?action=query&meta=siteinfo&format=json`);
// ⑤ 换一个已知存在的条目试试 extracts（验证"api.php 是全禁还是部分禁"）
await tryIt('extracts(已知条目)', `${base}/api.php?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent('高松灯')}&format=json`);
