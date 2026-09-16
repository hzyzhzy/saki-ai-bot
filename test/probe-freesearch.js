/** 测试不需要 API key 的免费搜索路子能不能用 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function tryFetch(label, url, opts = {}) {
  console.log(`\n=== ${label} ===`);
  console.log(`   ${url.slice(0, 100)}`);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/html', ...(opts.headers ?? {}) },
      signal: AbortSignal.timeout(25000),
    });
    const text = await r.text();
    console.log(`   HTTP ${r.status}  ${text.length} 字节`);
    if (r.ok) {
      // 看有没有真的搜到东西
      const hasResult = /梦限大|MyGO|BanG|result|title/i.test(text);
      console.log(`   含结果关键词: ${hasResult ? '✅' : '❌'}`);
      console.log(`   前 200 字: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    } else {
      console.log(`   失败内容: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    }
    return r.ok;
  } catch (e) {
    console.log(`   ❌ ${e.message}`);
    return false;
  }
}

// ① DuckDuckGo 的 lite 版（HTML，不用 key）
await tryFetch('DuckDuckGo lite', 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent('梦限大 BanG Dream'));

// ② DuckDuckGo Instant Answer API（官方但有局限）
await tryFetch(
  'DuckDuckGo Instant Answer API',
  'https://api.duckduckgo.com/?q=' + encodeURIComponent('MyGO') + '&format=json&no_html=1',
);

// ③ 维基百科 API（完全免费，无限制）
await tryFetch(
  '中文维基百科搜索',
  'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
    encodeURIComponent('BanG Dream') +
    '&format=json&utf8=1',
);

// ④ 萌娘百科（二次元资料，API 开放）
await tryFetch(
  '萌娘百科搜索',
  'https://zh.moegirl.org.cn/api.php?action=query&list=search&srsearch=' +
    encodeURIComponent('MyGO') +
    '&format=json&utf8=1',
);

// ⑤ Bing（不用 key 的 HTML）
await tryFetch('Bing 网页搜索', 'https://www.bing.com/search?q=' + encodeURIComponent('梦限大'));
