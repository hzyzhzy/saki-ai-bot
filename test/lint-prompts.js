/**
 * 语法自检：`src/*.js` 都能被 Node 解析。
 *
 * ## ⚠️ 为什么重写成这样（2026-09-13，血泪）
 *
 * 这个文件原来有两个检查：
 *   ① 一个**手写的"模板串里有没有裸反引号"启发式**（逐行数反引号、翻 inTemplate 状态）
 *   ② 真的 import 每个文件（抓 `node --check` 漏掉的跨行字符串断裂）
 *
 * ①**从来没准过**。它的状态机碰上**注释里的反引号**就会错位
 * （这个项目里注释中写 `` `state/day.json` `` 这种非常多），
 * 错位之后"整个文件后面每一行都被当成在模板串里"，一次报 200+ 处假问题。
 * 我为了它白查过两轮：第一次以为是自己改坏了代码，第二次想修它，
 * 越修越糟（先报 10 处、改成 280 处、再改成 229 处，全是假的）。
 *
 * 后来实测确认：**`node --check` 能抓到裸反引号，而且能报出准确行号**：
 *   ```
 *   $ node --check bad.js
 *   const t = `hello ` world`;
 *                      ^^^^^
 *   SyntaxError: Invalid or unexpected token
 *   ```
 *
 * 所以：**别维护一个不可靠的重复检查**。直接跑 `node --check`，
 * 它才是"语法问题"的权威判定；再 import 一次抓它可能漏的跨行情况。
 *
 * 用法：node test/lint-prompts.js
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'src';
const files = readdirSync(dir).filter((x) => x.endsWith('.js'));
let bad = 0;

// ── ① node --check：权威的语法检查（裸反引号、跨行断裂全都抓得到）──
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', join(dir, f)], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad++;
    const msg = String(r.stderr ?? '')
      .split('\n')
      .filter((l) => /SyntaxError|Error:/.test(l))
      .slice(0, 2)
      .join(' ')
      .trim();
    console.log(`  ❌ ${f} 语法错误：${msg || '(见 node --check 输出)'}`);
    // 顺带把出错行打出来，省得再去翻（node 的报错格式是 `路径:行号`）
    const lineNo = Number((String(r.stderr ?? '').match(/\.js:(\d+)/) ?? [])[1]);
    if (lineNo) {
      const src = spawnSync(
        process.execPath,
        [
          '-e',
          `console.log(require('fs').readFileSync(${JSON.stringify(join(dir, f))},'utf8').split(/\\r?\\n/)[${lineNo - 1}] ?? '')`,
        ],
        { encoding: 'utf8' },
      );
      console.log(`     第 ${lineNo} 行：${String(src.stdout ?? '').trim().slice(0, 100)}`);
    }
  }
}
console.log(bad ? '' : '  ✅ 所有 src/*.js 语法都正确');

// ── ② 真的 import 一次：抓 `node --check` 可能漏的（跨行字符串断裂）──
//
//    ⚠️ 踩过：改提示词时字符串跨了行（漏了 `',` + 换行），
//    结果 `node --check` **返回 0（假通过）**，但真正 import 时才抛
//    `SyntaxError: Invalid or unexpected token`。
{
  let importBad = 0;
  for (const f of files) {
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `import('./src/${f}').catch(e=>{ if(/SyntaxError/.test(e.name||'')) { console.error('SYNTAX'); process.exit(3); } })`,
      ],
      { cwd: join(dir, '..'), encoding: 'utf8', timeout: 20000 },
    );
    if (r.status === 3) {
      importBad++;
      console.log(`  ❌ ${f} 有语法错误（node --check 可能查不出来）`);
    }
  }
  console.log(
    importBad ? `  ❌ ${importBad} 个文件语法有问题` : '  ✅ 所有 src/*.js 都能被 import（语法层面）',
  );
  bad += importBad;
}
process.exit(bad ? 1 : 0);
