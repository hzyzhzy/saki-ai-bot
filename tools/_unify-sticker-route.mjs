/**
 * 统一表情路由：只留 `send_sticker` 工具，删掉「正文里写 `[表情:名字]`」那套。
 *
 * 用户要求：「不要两条路了，就留工具这一套」。
 *
 * 用法：node tools/_unify-sticker-route.mjs [--write]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');

/** lite.md：从「· 怎么发（最省事的一条）」到「哪种顺手用哪种。」 */
const LITE_RE = /[ \t]*· 怎么发（\*\*最省事的一条\*\*）：正文里写一个 `\[表情:名字\]`[\s\S]*?哪种顺手用哪种。/;
const LITE_NEW = `  · 怎么发：**调 \`send_sticker\` 工具** —— 把想表达的情绪（「有点尴尬又不想认输」这种）
    写进 \`哪个\`，它自己挑最贴的那张发出去（一轮就发，不用先查清单）。
    ⚠️ 正文里**不写** \`[表情:xxx]\`（那条路已经关了，写了也不会发图）—— 想发图就调工具 ✓
    ⚠️ 库里能挑的有这些，写 \`哪个\` 时可以参考：
    大笑 无语 害羞 得意 生气 哭哭 抱抱 无奈 紧张 嘟嘴 托腮 震惊 冷眼 狂笑 扶额 憋笑 摸头 吃瓜 欢呼 比耶 挥手 送花 思考 疑惑`;

/** persona.md：从「- **怎么发**（两种都行…）」到「它自己挑最贴的那张发出去。」 */
const POST_RE = /[ \t]*- \*\*怎么发\*\*（两种都行，哪种顺手用哪种）：[\s\S]*?它自己挑最贴的那张发出去。/;
const POST_NEW = `- **怎么发**：**调 \`send_sticker\` 工具** —— 把想表达的情绪（「有点尴尬又不想认输」这种）
  写进 \`哪个\`，它自己挑最贴的那张发出去（一轮就发，不用先查清单）。
  ⚠️ 正文里**不写** \`[表情:xxx]\`（那条路已经关了，写了也不会发图）—— 想发图就调工具 ✓
  ⚠️ 库里能挑的有这些，写 \`哪个\` 时可以参考：
  大笑 无语 害羞 得意 生气 哭哭 抱抱 无奈 紧张 嘟嘴 托腮 震惊 冷眼 狂笑 扶额 憋笑 摸头 吃瓜 欢呼 比耶 挥手 送花 思考 疑惑`;

const targets = [];
for (const p of ['saki', '<主人>', 'anon']) {
  targets.push([`personas/${p}/prompt/lite.md`, LITE_RE, LITE_NEW]);
  targets.push([`personas/${p}/persona.md`, POST_RE, POST_NEW]);
}

for (const [rel, re, rep] of targets) {
  const f = path.join(root, rel);
  const src = fs.readFileSync(f, 'utf8');
  if (!re.test(src)) {
    console.log(`⚠️ ${rel}：没匹配到（可能已经改过）`);
    continue;
  }
  const out = src.replace(re, rep);
  console.log(`✅ ${rel}：命中，${src.length} → ${out.length} 字`);
  if (WRITE) {
    const bak = f + '.bak-统一表情路-' + new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '');
    fs.copyFileSync(f, bak);
    fs.writeFileSync(f, out, 'utf8');
  }
}
if (!WRITE) console.log('\n（dry-run，加 --write 才写）');
