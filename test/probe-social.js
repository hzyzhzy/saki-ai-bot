/**
 * 探针：B站 / 小红书 这类平台的搜索接口能不能用（写成文件跑，避免 shell 吃引号）。
 *
 * 用法: node test/probe-social.js [关键词]
 */
const q = process.argv[2] || '中国人能飞';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };

const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim();

const get = async (url, headers = H) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    const txt = await r.text();
    return { status: r.status, txt };
  } catch (e) {
    return { status: 0, txt: '', err: e.message };
  } finally {
    clearTimeout(t);
  }
};

console.log(`\n关键词：${q}\n`);

// ① 综合搜索：有哪些结果类型
{
  const r = await get(`https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(q)}`);
  let j = null;
  try {
    j = JSON.parse(r.txt);
  } catch {}
  console.log('[1] B站综合搜索  status', r.status, 'code', j?.code);
  if (j?.data?.result) {
    console.log(
      '    结果类型：',
      j.data.result.map((x) => `${x.result_type}(${x.data?.length ?? 0})`).join(' '),
    );
    for (const type of ['video', 'article']) {
      const list = j.data.result.find((x) => x.result_type === type)?.data ?? [];
      console.log(`    ${type} 前 3：`);
      for (const v of list.slice(0, 3)) {
        console.log(
          `      · ${strip(v.title)}  | 播放 ${v.play} 赞 ${v.like} 弹幕 ${v.video_review ?? v.danmaku ?? '?'} | ${v.bvid ?? v.id}`,
        );
      }
    }
  } else {
    console.log('    原始前 120 字：', r.txt.slice(0, 120).replace(/\s+/g, ' '));
  }
}

// ② 搜索建议（最适合判断"这是不是个梗"）
{
  const r = await get(`https://s.search.bilibili.com/main/suggest?term=${encodeURIComponent(q)}&main_ver=v1`);
  let j = null;
  try {
    j = JSON.parse(r.txt);
  } catch {}
  console.log('\n[2] B站搜索建议  status', r.status);
  console.log('    tag：', (j?.result?.tag ?? []).map((t) => t.value).slice(0, 10).join(' / ') || '(空)');
  console.log('    up ：', (j?.result?.up ?? []).map((t) => t.value).slice(0, 5).join(' / ') || '(空)');
}

// ③ 全站热搜榜（当下热梗）
{
  const r = await get('https://api.bilibili.com/x/web-interface/search/square?limit=20');
  let j = null;
  try {
    j = JSON.parse(r.txt);
  } catch {}
  console.log('\n[3] B站热搜榜  status', r.status, 'code', j?.code);
  const list = j?.data?.trending?.list ?? [];
  console.log('    前 10：', list.slice(0, 10).map((x) => x.keyword).join(' / ') || '(空)');
}

// ④ 小红书：看 HTML 里有没有可抓的内容（应该是客户端渲染）
{
  const r = await get(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}`, {
    'User-Agent': UA,
  });
  const hasNotes = /note-item|noteId|"noteCard"/.test(r.txt);
  console.log('\n[4] 小红书网页  status', r.status, '| 长度', r.txt.length, '| HTML 里有笔记数据?', hasNotes);
  // 看看有没有内嵌的初始状态 JSON
  const m = r.txt.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]{0,200})/);
  console.log('    有 __INITIAL_STATE__?', Boolean(m), m ? m[1].slice(0, 80) : '');
}

// ⑤ 抖音 / 知乎 / 微博 对照
for (const [name, url] of [
  ['抖音', `https://www.douyin.com/search/${encodeURIComponent(q)}`],
  ['知乎', `https://www.zhihu.com/search?q=${encodeURIComponent(q)}`],
  ['微博', `https://s.weibo.com/weibo?q=${encodeURIComponent(q)}`],
]) {
  const r = await get(url, { 'User-Agent': UA });
  const body = /<body[^>]*>([\s\S]{0,300})/.exec(r.txt)?.[1] ?? '';
  console.log(`\n[5] ${name}  status ${r.status} | 长度 ${r.txt.length} | body 前 80 字：${strip(body).slice(0, 80)}`);
}
