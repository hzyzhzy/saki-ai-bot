/**
 * 由 `qq-ai-bot-public/README.md` 生成一份**手机能直接看的说明书 HTML**。
 *
 * ## 为什么要它
 *   README 里一直写着「手机打开 群机器人说明书.html 就能看」，
 *   但这个文件**从来没被生成过**（`tools/manual-build.js` 只负责灌 Univer Doc）。
 *   而视频简介里放 PDF 远不如放一个**点开就能看的网页** —— 不用下载、手机自适应。
 *
 * ## 为什么不用 marked 之类的库
 *   这个项目的依赖只有 `ws` + `js-yaml` 两个，**不为一个说明书加依赖**。
 *   README 用到的语法很有限（标题/表格/列表/引用/粗体/代码/链接/分隔线），
 *   手写一个够用的转换器反而更可控。
 *
 * 用法: node tools/manual-html.cjs
 * 产物: manual/群机器人说明书.html
 */
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, '..', 'qq-ai-bot-public', 'README.md');
const OUT = join(ROOT, 'manual', '群机器人说明书.html');

if (!existsSync(SRC)) {
  console.error(`读不到 ${SRC}`);
  process.exit(1);
}
const md = readFileSync(SRC, 'utf8');

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 行内：先转义，再处理链接 / 粗体 / 行内代码 */
function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 图片 ![alt](src) —— README 里基本没有，顺手支持
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 单个 * 的斜体很少用，但别误伤 ** 已处理过的
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return t;
}

const lines = md.split(/\r?\n/);
const out = [];
let i = 0;
let inCode = false;
let codeBuf = [];
let listType = null; // 'ul' | 'ol'

const closeList = () => {
  if (listType) {
    out.push(`</${listType}>`);
    listType = null;
  }
};

/** 表格：当前行是 | a | b |，且下一行是 |---|---| */
function isTableStart(k) {
  return (
    /^\s*\|.*\|\s*$/.test(lines[k] ?? '') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[k + 1] ?? '')
  );
}
const splitRow = (row) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

while (i < lines.length) {
  const line = lines[i];

  // ── 代码块 ──
  if (/^\s*```/.test(line)) {
    if (inCode) {
      out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
      codeBuf = [];
      inCode = false;
    } else {
      closeList();
      inCode = true;
    }
    i++;
    continue;
  }
  if (inCode) {
    codeBuf.push(line);
    i++;
    continue;
  }

  // ── 表格 ──
  if (isTableStart(i)) {
    closeList();
    const head = splitRow(line);
    out.push('<div class="tw"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
    i += 2;
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
      const cells = splitRow(lines[i]);
      out.push('<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      i++;
    }
    out.push('</tbody></table></div>');
    continue;
  }

  // ── 标题 ──
  const h = /^(#{1,6})\s+(.*)$/.exec(line);
  if (h) {
    closeList();
    const lv = h[1].length;
    const id = h[2].replace(/[^\u4e00-\u9fa5\w]+/g, '-').replace(/^-|-$/g, '');
    out.push(`<h${lv} id="${id}">${inline(h[2])}</h${lv}>`);
    i++;
    continue;
  }

  // ── 分隔线 ──
  if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
    closeList();
    out.push('<hr>');
    i++;
    continue;
  }

  // ── 引用（连续多行合成一个块）──
  if (/^\s*>/.test(line)) {
    closeList();
    const buf = [];
    while (i < lines.length && /^\s*>/.test(lines[i])) {
      buf.push(lines[i].replace(/^\s*>\s?/, ''));
      i++;
    }
    out.push('<blockquote>' + buf.map((b) => (b.trim() ? `<p>${inline(b)}</p>` : '')).join('') + '</blockquote>');
    continue;
  }

  // ── 列表 ──
  const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
  const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
  if (ul || ol) {
    const want = ul ? 'ul' : 'ol';
    if (listType !== want) {
      closeList();
      out.push(`<${want}>`);
      listType = want;
    }
    out.push(`<li>${inline((ul ? ul[1] : ol[1]))}</li>`);
    i++;
    continue;
  }

  // ── 空行 ──
  if (!line.trim()) {
    closeList();
    i++;
    continue;
  }

  // ── 普通段落 ──
  closeList();
  out.push(`<p>${inline(line)}</p>`);
  i++;
}
closeList();
if (inCode && codeBuf.length) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);

const title = (md.match(/^#\s+(.+)$/m) || [, '说明书'])[1].trim();

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  /* ⚠️ 手机优先：这份主要是**在手机上点开看**的，所以字号、行距、表格横向滚动都按手机调 */
  :root{color-scheme:light dark;
    --bg:#f6f8fc; --fg:#1b2536; --dim:#5b6b83; --line:#dfe6f0; --card:#ffffff; --accent:#2f6fd0; --code:#f0f3f9}
  @media (prefers-color-scheme:dark){
    :root{--bg:#0e131c; --fg:#e6edf7; --dim:#98a6bd; --line:#243044; --card:#151c28; --accent:#6ea8f0; --code:#1a2231}
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:16px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
    padding:20px 16px 80px;max-width:860px;margin:0 auto;-webkit-text-size-adjust:100%}
  h1{font-size:24px;line-height:1.4;margin:8px 0 16px}
  h2{font-size:20px;margin:34px 0 12px;padding-bottom:8px;border-bottom:2px solid var(--line)}
  h3{font-size:17px;margin:24px 0 8px}
  h4{font-size:16px;margin:18px 0 6px;color:var(--dim)}
  p{margin:10px 0}
  a{color:var(--accent);word-break:break-all}
  hr{border:0;border-top:1px solid var(--line);margin:28px 0}
  ul,ol{margin:10px 0;padding-left:22px}
  li{margin:5px 0}
  blockquote{margin:14px 0;padding:10px 14px;background:var(--card);
    border-left:3px solid var(--accent);border-radius:6px;color:var(--dim)}
  blockquote p{margin:4px 0}
  code{background:var(--code);padding:2px 6px;border-radius:5px;font-size:.92em;
    font-family:ui-monospace,Consolas,monospace}
  pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow-x:auto;
    border:1px solid var(--line)}
  pre code{background:none;padding:0}
  /* ⚠️ 表格在手机上必须能横向滑，否则宽表会把整页撑歪 */
  .tw{overflow-x:auto;margin:14px 0;-webkit-overflow-scrolling:touch}
  table{border-collapse:collapse;width:100%;font-size:14.5px;min-width:420px}
  th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
  th{background:var(--card);font-weight:600;white-space:nowrap}
  strong{color:var(--fg)}
  @media (max-width:520px){ body{padding:14px 12px 60px;font-size:15px} h1{font-size:21px} h2{font-size:18px} }
</style>
</head>
<body>
${out.join('\n')}
</body>
</html>
`;

if (!existsSync(join(ROOT, 'manual'))) mkdirSync(join(ROOT, 'manual'), { recursive: true });
writeFileSync(OUT, html, 'utf8');

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`✅ 生成 ${OUT}`);
console.log(`   ${lines.length} 行 markdown → ${out.length} 个 HTML 块 / ${kb} KB`);
