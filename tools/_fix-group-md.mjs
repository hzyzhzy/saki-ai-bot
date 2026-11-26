/**
 * 修 `knowledge/groups/<gid>.md` 里被**粘连成一行**的段落。
 *
 * 现场（200000001）：
 *   L9 : …定期总结。 ## 一、这个群是什么样 - **主群**：…
 *   L11: …再补。） ## 二、群友（这个群里常说话的） | 群友 | 特点 |
 *   L16: - （待补） ## 四点半、自动观察… <!-- AUTO-OBSERVE:BEGIN -->
 *   L99: <!-- AUTO-OBSERVE:END --> ## 五、怎么用… - 这份**只给 752 群用**
 *
 * ⇒ `## 二、群友` 不在行首 ⇒ 按 `^#{2,3}\s` 切段时**整节取不到**
 *   ⇒ 手写的群友表（mmmawa / <主人> / luomo-San）从来没进过提示词 ✗
 *
 * 做法：在 `## / ### / <!-- AUTO-OBSERVE` 前面补换行（只加换行，不动一个字）。
 * 用法：node tools/_fix-group-md.mjs [--write]   （默认 dry-run，只报告）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'knowledge', 'groups');
const WRITE = process.argv.includes('--write');

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
  const p = path.join(dir, f);
  const src = fs.readFileSync(p, 'utf8');
  let out = src
    // ① 标题前补空行（前面不是换行时）
    .replace(/([^\n])\s*(#{2,3}\s)/g, '$1\n\n$2')
    // ② AUTO 注释前补换行
    .replace(/([^\n])\s*(<!--\s*AUTO-OBSERVE)/g, '$1\n\n$2')
    // ③ AUTO 注释后补换行
    .replace(/(<!--\s*AUTO-OBSERVE:[A-Z]+\s*-->)\s*([^\n])/g, '$1\n\n$2')
    // ④ 表格直接跟在一行文字后面（`。| 群友 |`）
    .replace(/([^\n|])\s*(\|\s*群友\s*\|)/g, '$1\n\n$2');

  const changed = out !== src;
  const addLines = out.split('\n').length - src.split('\n').length;
  console.log(`${f}：${changed ? '需要修（+' + addLines + ' 行）' : '已经正常'}`);
  if (changed && WRITE) {
    const bak = p + '.bak-拆粘连-' + new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '');
    fs.copyFileSync(p, bak);
    fs.writeFileSync(p, out, 'utf8');
    console.log(`   已写回；备份 → ${path.basename(bak)}`);
  }
}
if (!WRITE) console.log('\n（dry-run，加 --write 才真的改）');
