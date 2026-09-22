/**
 * 把 `src/webui.html` **正文区**里的 `**xx**` 换成 `<b>xx</b>`（一次性脚本）。
 *
 * 为什么：`class="hint"` 是纯文本，markdown 的 `**` 不会加粗 ——
 * 界面上就**原样显示两个星号**（用户截图里到处都是）。
 *
 * ⚠️⚠️ 两个区**绝对不能碰**：
 *   · `<style>` 里的 `**` 在 CSS 注释里（动了只是噪音）；
 *   · `<script>` 里的 `**` 是**喂给模型的提示词标记**（"你就是**小祥**"要跟着进模型），
 *     动了会毁人设。
 *   ⇒ 所以只处理 `<style>` 之后、`<script>` 之前那一段。
 *
 * ⚠️ 这个脚本上一版是**用 PowerShell 正则改坏的**（引号转义失败 → 写入时丢了
 *    `<head>`+`<style>` 整整 541 行，靠 `git checkout` 才救回来）。
 *    教训：**改脚本文件就用编辑器/文件工具整体重写，别用 shell 正则去 patch。**
 *
 * 用法：
 *   node logs/__fix-stars.mjs          # dry-run
 *   node logs/__fix-stars.mjs --write  # 真改
 */
import { readFileSync, writeFileSync } from 'node:fs';

const f = 'src/webui.html';
const src = readFileSync(f, 'utf8');
const lines = src.split(/\r?\n/);

const styleEnd = lines.findIndex((l) => /<\/style>/.test(l));
const scriptAt = lines.findIndex((l) => /<script/.test(l));
if (styleEnd < 0 || scriptAt < 0 || scriptAt <= styleEnd) {
  console.error(`切分失败（styleEnd=${styleEnd} scriptAt=${scriptAt}）—— 不敢动`);
  process.exit(1);
}

const before = lines.slice(0, styleEnd + 1); // 含 </style>
const body = lines.slice(styleEnd + 1, scriptAt);
const after = lines.slice(scriptAt);

let n = 0;
const fixed = body.map((l) =>
  l.replace(/\*\*([^*\n]+?)\*\*/g, (_m, t) => {
    n++;
    return `<b>${t}</b>`;
  }),
);

// 安全闸：行数必须一模一样（只做行内替换，绝不该增删行）
if (fixed.length !== body.length) {
  console.error(`行数变了（${body.length} → ${fixed.length}）—— 中止`);
  process.exit(1);
}

console.log(`正文区：第 ${styleEnd + 2} ~ ${scriptAt} 行，共 ${body.length} 行`);
console.log(`替换 ${n} 处 **xx** → <b>xx</b>`);
const sample = body.join('\n').match(/\*\*([^*\n]+?)\*\*/g) ?? [];
for (const s of sample.slice(0, 5)) console.log(`  · ${s}`);

if (process.argv.includes('--write')) {
  const out = [...before, ...fixed, ...after].join('\n');
  // 再一道闸：写完的文本必须还是完整的 html
  // ⚠️ 大小写**不敏感**：文件里其实写的是小写 `<!doctype html>`，
  //    第一版用 `out.includes('<!DOCTYPE')` 判断 ⇒ 永远"缺" ⇒ 每次都中止
  //    （安全闸把自己拦住了，白跑两轮）。
  const low = out.toLowerCase();
  for (const must of ['<!doctype', '<style>', '</style>', '<script>', '</script>', '</html>']) {
    if (!low.includes(must)) {
      console.error(`写完的文本缺了「${must}」—— 中止，不写盘`);
      process.exit(1);
    }
  }
  writeFileSync(f, out, 'utf8');
  console.log('✅ 已写入');
} else {
  console.log('（dry-run，加 --write 才真改）');
}
