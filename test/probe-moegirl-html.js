/**
 * 探针：萌娘百科**搜索页 HTML** 的结构（它的 API 被封了，只能抓页面）。
 *
 * 用法: node test/probe-moegirl-html.js [关键词]
 */
const q = process.argv[2] || '鸡你太美';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const r = await fetch(`https://zh.moegirl.org.cn/index.php?search=${encodeURIComponent(q)}`, {
  headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
});
const html = await r.text();
console.log(`status ${r.status} | HTML ${html.length}\n`);

const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

// ① 先看有没有"共 N 条结果"
const cnt = /第\s*([\d\-]+)\s*条结果，共\s*([\d,]+)\s*条/.exec(html);
console.log('结果计数:', cnt ? cnt[0] : '(没有)');

// ② 搜索结果块长什么样 —— 找几种候选 class
for (const cls of ['mw-search-result', 'searchresult', 'mw-search-results', 'result']) {
  const n = (html.match(new RegExp(cls, 'g')) ?? []).length;
  console.log(`class 含 "${cls}" 出现 ${n} 次`);
}

// ③ 抠出「/zh-cn/条目标题」这种链接
const links = [...html.matchAll(/href="(\/(?:zh-cn|wiki)\/[^"#?]+)"[^>]*title="([^"]*)"/g)];
console.log(`\n/zh-cn/ 链接 ${links.length} 个，前 8 个：`);
for (const m of links.slice(0, 8)) console.log(`  · ${strip(m[2])}  →  ${m[1]}`);

// ④ 打印一段搜索结果的原始 HTML（找 class 的锚点）
const i = html.indexOf('mw-search-result');
if (i > 0) {
  console.log('\n搜索结果块原始 HTML（前 700 字）：');
  console.log(html.slice(i - 100, i + 600).replace(/\s+/g, ' '));
} else {
  // 退化：找"共 N 条"附近
  const j = html.indexOf('条结果');
  console.log('\n"条结果"附近原始 HTML：');
  console.log(html.slice(Math.max(0, j - 400), j + 900).replace(/\s+/g, ' '));
}
