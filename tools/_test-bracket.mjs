/**
 * 验证 `stripBracketAct()`：句末括号口癖要留，小说体旁白要剥，
 * 而且**绝不能像 21:18 那次一样把中间整句话吃掉**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'bot.js'), 'utf8');
const a = src.indexOf('export function stripBracketAct');
const b = src.indexOf('export function dropDashBreak', a);
if (a < 0 || b < 0) {
  console.error('抠不到源码', { a, b });
  process.exit(1);
}
const code = src.slice(a, b).replace(/^export /m, ''); // new Function 不认 export
const { stripBracketAct } = new Function(`${code}; return { stripBracketAct };`)();

let bad = 0;
const t = (name, input, want) => {
  const got = stripBracketAct(input);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? '✅' : '❌'} ${name}\n   in : ${JSON.stringify(input)}\n   out: ${JSON.stringify(got)}` + (ok ? '' : `\n   期望: ${JSON.stringify(want)}`));
};

console.log('—— 一、真事故：口癖 `（` 和 `（笑）` 不能连带吃正文 ——');
t(
  '（笑）句末要留、中间那句要留',
  '……你不说我都没注意（。可能是聊得太顺了，就没顾上打（笑）。',
  '……你不说我都没注意。可能是聊得太顺了，就没顾上打（笑）。',
);

console.log('\n—— 二、口癖本体 ——');
t('句末半括号留着', '你快点啊（', '你快点啊（');
t('空括号留着', '就这（）', '就这（）');
t('（笑）在句末留着', '我就笑笑（笑）', '我就笑笑（笑）');

console.log('\n—— 三、小说体旁白照旧剥 ——');
t('开头动作旁白剥掉', '（没退开，眼睛还半垂着）。……谢什么呀', '……谢什么呀');
t('句中长旁白剥掉', '我（叹了口气）也不是不能来', '我也不是不能来');
t('整条都是括号 ⇒ 不发', '（那是在回大豆，不用我应）', '');

console.log(bad === 0 ? '\n全部通过 ✓' : `\n${bad} 项没过 ✗`);
process.exit(bad === 0 ? 0 : 1);
