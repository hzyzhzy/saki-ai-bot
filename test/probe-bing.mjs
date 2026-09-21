/** 研究 Bing 搜索结果页的 HTML 结构，找出稳定的解析方式 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/203.0.113.10 Safari/537.36';

const q = process.argv[2] ?? '梦限大 BanG Dream';
const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&mkt=zh-CN';

const r = await fetch(url, {
  headers: {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  },
  signal: AbortSignal.timeout(30000),
});
const html = await r.text();
console.log(`HTTP ${r.status}  ${html.length} 字节`);

// 探测几种常见的结果容器
const patterns = [
  ['<li class="b_algo"', /<li class="b_algo"/g],
  ['b_algo（任意）', /b_algo/g],
  ['<h2><a href=', /<h2><a href="/g],
  ['b_caption', /b_caption/g],
  ['<cite', /<cite/g],
  ['b_algoheader', /b_algoheader/g],
];
console.log('\n=== 结构探测 ===');
for (const [name, re] of patterns) {
  const n = (html.match(re) ?? []).length;
  console.log(`  ${name.padEnd(20)} ${n} 个`);
}

// 试着把前 3 条结果抠出来
console.log('\n=== 尝试解析（粗解）===');
const blocks = html.split(/<li class="b_algo"/).slice(1, 4);
if (!blocks.length) {
  console.log('  没能按 b_algo 切分。打印一段含 h2 的片段:');
  const i = html.indexOf('<h2');
  console.log(html.slice(Math.max(0, i - 200), i + 600).replace(/\s+/g, ' '));
} else {
  blocks.forEach((b, i) => {
    const title = b.match(/<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/);
    const href = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"/);
    const snippet = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const strip = (s) =>
      String(s ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#\d+;/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    console.log(`\n  [${i + 1}] ${strip(title?.[1])}`);
    console.log(`      url: ${href?.[1] ?? '?'}`);
    console.log(`      摘要: ${strip(snippet?.[1]).slice(0, 200)}`);
  });
}
