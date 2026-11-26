// 一次性自检：把 webui.html 里内联 <script> 的正文抽出来做**语法**检查（不执行）。
// 引擎是页面自己的 JS，`node --check` 查不了 html，所以用它兜一道：
// 语法错（少括号、少逗号）会在这里立刻炸，而不是等浏览器整页白掉。
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/webui.html', import.meta.url), 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let i = 0;
let bad = 0;
for (const m of html.matchAll(re)) {
  i += 1;
  const code = m[1];
  const at = m.index;
  try {
    // 只解析不运行：new Function 会把函数体编译一遍
    new Function(code);
    console.log(`#${i} 行 ${html.slice(0, at).split('\n').length} 起，${code.length} 字节 —— 语法 OK`);
  } catch (e) {
    bad += 1;
    console.error(`#${i} ❌ ${e.message}`);
  }
}
console.log(bad ? `\n有 ${bad} 段语法错误` : `\n共 ${i} 段内联脚本，全部通过`);
process.exit(bad ? 1 : 0);
