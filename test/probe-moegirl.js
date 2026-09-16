/**
 * 探针：萌娘百科 MediaWiki API 的正确用法（它有正规 API，应该用接口而不是抓 HTML）。
 *
 * 背景：`opensearch` 只做**标题前缀匹配**，搜「中国人能飞」当然空 ——
 * 要用 `list=search`（全文检索）。
 *
 * 用法: node test/probe-moegirl.js [关键词]
 */
const q = process.argv[2] || '中国人能飞';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const API = 'https://zh.moegirl.org.cn/api.php';

const get = async (url) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    return { status: r.status, txt: await r.text() };
  } catch (e) {
    return { status: 0, txt: '', err: e.message };
  } finally {
    clearTimeout(t);
  }
};

const strip = (s) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

console.log(`\n关键词：${q}\n`);

// ① 全文检索：标题 + 摘要片段
{
  const url =
    `${API}?action=query&list=search&srsearch=${encodeURIComponent(q)}` +
    `&srlimit=5&srprop=snippet|wordcount|timestamp&format=json&origin=*`;
  const r = await get(url);
  let j = null;
  try {
    j = JSON.parse(r.txt);
  } catch {}
  console.log('[1] list=search（全文检索）status', r.status);
  const hits = j?.query?.search ?? [];
  if (!hits.length) console.log('    （无结果）原始：', r.txt.slice(0, 160));
  for (const h of hits) {
    console.log(`    · ${h.title}  (${h.wordcount} 字)`);
    console.log(`      ${strip(h.snippet).slice(0, 120)}`);
  }
}

// ② 换了措辞再试（「XX是什么梗」这种问法）
for (const alt of [`${q} 梗`, `${q} 是什么梗`]) {
  const url =
    `${API}?action=query&list=search&srsearch=${encodeURIComponent(alt)}&srlimit=3&srprop=snippet&format=json`;
  const r = await get(url);
  let j = null;
  try {
    j = JSON.parse(r.txt);
  } catch {}
  const hits = j?.query?.search ?? [];
  console.log(`\n[2] 搜「${alt}」→ ${hits.length} 条`);
  for (const h of hits) console.log(`    · ${h.title} ｜ ${strip(h.snippet).slice(0, 90)}`);
}

// ③ 直接取条目的纯文本摘要（真的能读到内容）
{
  const url = `${API}?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(q)}&format=json`;
  const r = await get(url);
  let j = null;
  try {
    j = JSON.parse(r.txt);
  } catch {}
  const pages = Object.values(j?.query?.pages ?? {});
  console.log('\n[3] 直接取条目摘要（extracts）');
  for (const p of pages) {
    console.log(`    ${p.title}: ${String(p.extract ?? '(没有这个条目)').slice(0, 200)}`);
  }
}

// ④ 站内热搜/最近更改（看这站活不活跃）
{
  const r = await get(`${API}?action=query&list=recentchanges&rclimit=5&rcprop=title&format=json`);
  let j = null;
  try {
    j = JSON.parse(r.txt);
  } catch {}
  const rc = j?.query?.recentchanges ?? [];
  console.log('\n[4] 最近编辑（说明站点活跃度）:', rc.map((x) => x.title).join(' / ') || '(取不到)');
}
