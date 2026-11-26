import { readFileSync } from 'node:fs';

const t = readFileSync('src/bot.js', 'utf8');
const a = t.indexOf('要模仿戳一戳对语气词的规定');
const b = t.indexOf('# 【说话方式：语气词一个都不许省】');
const c = t.indexOf('也别写成对括号包旁白');
console.log('注释锚点', a, '| 段落', b, '| 结尾', c);
if (c > 0) console.log('结尾片段：', JSON.stringify(t.slice(c, c + 120)));
console.log('段落起点往前：', JSON.stringify(t.slice(b - 60, b + 20)));
