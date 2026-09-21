/**
 * 检查 `src/webui.html` 里内联 JS 的**语法**（临时脚本）。
 *
 * ⚠️ 为什么需要：`node --check` 只能查 `.js`，查不了 html 里的 `<script>`。
 *    而那段 JS 一旦有语法错，**整个管理界面直接死**（按钮全没反应），
 *    用户看到的是"界面坏了"，不是一行报错。所以在交付前必须过一遍。
 */
import { readFileSync } from 'node:fs';

const html = readFileSync('src/webui.html', 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
console.log(`内联 <script> 段数：${blocks.length}`);
let bad = 0;
blocks.forEach((m, i) => {
  const code = m[1];
  const line = html.slice(0, m.index).split('\n').length;
  try {
    // 只查语法：包一层函数体，不执行
    new Function(code);
    console.log(`  ✅ 第 ${i + 1} 段（html 第 ${line} 行起，${code.split('\n').length} 行）语法 OK`);
  } catch (e) {
    bad++;
    console.log(`  ❌ 第 ${i + 1} 段（html 第 ${line} 行起）语法错：${e.message}`);
  }
});

// 顺便查一下我新加的页面有没有引用不存在的 id（最常见的低级错）
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...html.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
const missing = [...used].filter((x) => !ids.has(x) && !x.includes('"') && !x.includes('+'));
console.log(`\n界面里用到的 id：${used.size} 个；html 里定义了 ${ids.size} 个`);
console.log(missing.length ? `⚠️ 这些 id 没找到（可能是模板拼出来的，人工看一眼）：\n  ${missing.join('\n  ')}` : '✅ 没有找不到的 id');
process.exit(bad ? 1 : 0);
