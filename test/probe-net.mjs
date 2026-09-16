/** 区分：是 IPv6 问题还是被墙 */
import dns from 'node:dns/promises';

const HOSTS = [
  'www.bing.com',
  'zh.wikipedia.org',
  'lite.duckduckgo.com',
  'api.tavily.com',
  'api.search.brave.com',
  'api.deepseek.com',
  'www.baidu.com',
  'www.zhihu.com',
];

for (const h of HOSTS) {
  let v4 = [];
  let v6 = [];
  try {
    v4 = (await dns.resolve4(h)).slice(0, 2);
  } catch (e) {
    v4 = [`(${e.code})`];
  }
  try {
    v6 = (await dns.resolve6(h)).slice(0, 2);
  } catch (e) {
    v6 = [`(${e.code})`];
  }
  console.log(`${h.padEnd(24)} IPv4: ${v4.join(', ').padEnd(34)} IPv6: ${v6.join(', ')}`);
}

console.log('\n=== Node fetch 实测 ===');
for (const h of HOSTS) {
  const url = `https://${h}/`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    console.log(`  ✅ ${h.padEnd(24)} HTTP ${r.status}  (${Date.now() - t0}ms)`);
  } catch (e) {
    const msg = e.cause?.code ?? e.message;
    console.log(`  ❌ ${h.padEnd(24)} ${msg}  (${Date.now() - t0}ms)`);
  }
}
