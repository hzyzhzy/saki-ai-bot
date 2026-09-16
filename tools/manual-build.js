/**
 * 把 `qq-ai-bot-public/README.md` 灌进这份 Doc（说明书）。
 *
 * ⚠️ 这个文件是给 `univer_execute` 的 `codeFile` 用的（Facade 代码体），
 *    不是给 node 直接跑的 —— 里面能用的只有注入的 `doc` / `api`，
 *    以及 `import('node:fs/promises')`（执行环境是 Node ESM）。
 *
 * 支持：H1/H2/H3/H4 标题、正文、`- ` 列表、`> ` 引用、``` 代码块、`| |` 表格、`---` 分隔。
 * 行内标记（`**加粗**`、`` `代码` ``、`[文字](链接)`）会被**拍平**成纯文本 ——
 * 说明书是给人手机看的，结构（标题/表格/段落）比行内强调更重要。
 */

const { readFile } = await import('node:fs/promises');

const MD = '<项目目录>/qq-ai-bot-public/README.md';
const md = await readFile(MD, 'utf8');

/** 拍平行内标记：**粗** → 粗；`码` → 码；[文](链) → 文（链） */
function inline(s) {
  return String(s)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .trim();
}

const lines = md.split(/\r?\n/);
const NS = api.Enum.NamedStyleType;
/** 要输出的块：{kind, text|rows} */
const blocks = [];
for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const line = raw.trim();

  // 代码块
  if (line.startsWith('```')) {
    const code = [];
    i++;
    // ⚠️ 这里**必须 i++**（漏了就是死循环 → 一直 push 到数组上限 → `RangeError: Invalid array length`，
    //    我踩过：表现是 univer_execute 报 `UNIT_CONTENT_WORKER_FAILED: Invalid array length`）
    while (i < lines.length && !lines[i].trim().startsWith('```')) {
      code.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'code', text: code.join('\n') });
    continue;
  }
  // 表格：| a | b |  + 分隔行
  if (line.startsWith('|') && lines[i + 1] && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
    const cells = (l) =>
      l
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => inline(c));
    const rows = [cells(line)];
    i += 2; // 跳过表头分隔行
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      rows.push(cells(lines[i]));
      i++;
    }
    i--;
    // ⚠️ 列数必须一致：Markdown 里常有缺列/多列的行，
    //    直接喂给 insertTableFromData 会抛 `Invalid array length`（实测踩过）
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const fixed = rows.map((r) => (r.length === cols ? r : [...r, ...Array(cols - r.length).fill('')].slice(0, cols)));
    if (cols >= 2 && fixed.length >= 2) blocks.push({ kind: 'table', rows: fixed });
    else for (const r of fixed) blocks.push({ kind: 'li', text: r.join('　') });
    continue;
  }
  if (!line) continue;
  if (/^---+$/.test(line)) continue;
  if (line.startsWith('#### ')) blocks.push({ kind: 'h4', text: inline(line.slice(5)) });
  else if (line.startsWith('### ')) blocks.push({ kind: 'h3', text: inline(line.slice(4)) });
  else if (line.startsWith('## ')) blocks.push({ kind: 'h2', text: inline(line.slice(3)) });
  else if (line.startsWith('# ')) blocks.push({ kind: 'h1', text: inline(line.slice(2)) });
  else if (line.startsWith('> ')) blocks.push({ kind: 'quote', text: inline(line.slice(2)) });
  else if (/^[-*] /.test(line)) blocks.push({ kind: 'li', text: inline(line.slice(2)) });
  else blocks.push({ kind: 'p', text: inline(line) });
}

// ── 写进 Doc ─────────────────────────────────────────────
const paras = doc.getParagraphs();
const first = paras[0];
if (!first) throw new Error('空文档没有段落');

const title = (blocks.find((b) => b.kind === 'h1') || { text: '群机器人说明书' }).text;
first.setText(title);
first.setStyle({ namedStyleType: NS.HEADING_1, textStyle: { fs: 22, bl: api.Enum.BooleanNumber.TRUE } });
doc.appendParagraph('（群机器人说明书 · 从 README.md 自动生成，手机/打印版）').setStyle({
  textStyle: { fs: 10, cl: { rgb: '#6b7280' } },
});

let tables = 0;
let added = 0;
for (const b of blocks) {
  if (b.kind === 'h1') continue; // 标题已用第一段
  if (b.kind === 'table') {
    const cols = b.rows[0].length;
    const widths = Array.from({ length: cols }, () => Math.max(60, Math.floor(620 / cols)));
    let t = null;
    try {
      t = doc.insertTableFromData(b.rows, { width: 620, columnWidths: widths, headerRowCount: 1 });
    } catch (e) {
      t = null;
    }
    if (t) {
      tables++;
      added++;
      continue;
    }
    // ⚠️ 表格插不进去就退化成逐行文字（宁可丑，不能整份失败）
    for (const r of b.rows) {
      doc.appendParagraph(`· ${r.join('　')}`).setStyle({ textStyle: { fs: 10.5 }, indentStart: 12 });
      added++;
    }
    continue;
  }
  const style = {
    h2: { namedStyleType: NS.HEADING_1, textStyle: { fs: 17, bl: api.Enum.BooleanNumber.TRUE } },
    h3: { namedStyleType: NS.HEADING_2, textStyle: { fs: 14.5, bl: api.Enum.BooleanNumber.TRUE } },
    h4: { namedStyleType: NS.HEADING_3, textStyle: { fs: 12.5, bl: api.Enum.BooleanNumber.TRUE } },
    li: { textStyle: { fs: 11 }, indentStart: 12 },
    quote: { textStyle: { fs: 11, cl: { rgb: '#374151' } }, indentStart: 16 },
    code: { textStyle: { fs: 10 }, indentStart: 12 },
    p: { textStyle: { fs: 11 } },
  }[b.kind];
  const text = b.kind === 'li' ? `· ${b.text}` : b.text;
  const linesOfText = String(text).split('\n');
  for (const one of linesOfText) {
    doc.appendParagraph(one).setStyle(style);
    added++;
  }
}

return {
  ok: true,
  title,
  blocks: blocks.length,
  added,
  tables,
  paragraphs: doc.getParagraphs().length,
  flavor: doc.getDocumentFlavor ? doc.getDocumentFlavor() : 'unknown',
};
