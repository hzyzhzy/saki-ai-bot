// 一次性整理已有的群记忆自动区：同一人合并成一条、去掉「新增/性格」碎片行。
// 只动 <!-- AUTO-OBSERVE --> 区域，手写内容原样保留；改前先备份。
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { __merge } from '../src/observe.js';

const file = process.argv[2] || 'knowledge/group-memory.md';
const BEGIN = '<!-- AUTO-OBSERVE:BEGIN -->';
const END = '<!-- AUTO-OBSERVE:END -->';

const raw = readFileSync(file, 'utf8');
const i = raw.indexOf(BEGIN);
const j = raw.indexOf(END);
if (i < 0 || j < 0) throw new Error('这个文件没有自动观察区');
const area = raw.slice(i + BEGIN.length, j).trim();

const tidied = __merge(area, { people: [], events: [] })
  // 旧记忆把主人写成了"新冒泡的群友"——按事实修正（他是服主/把机器人叫起来的人）
  .replace(/- <主人>：新冒泡的群友[；;]?/, '- <主人>：群主、服务器服主；')
  .replace(/- <主人>：新冒泡的群友$/, '- <主人>：群主、服务器服主');

const before = area.split('\n').filter((l) => l.trim().startsWith('- ')).length;
const after = tidied.split('\n').filter((l) => l.trim().startsWith('- ')).length;

mkdirSync('logs/knowledge.bak', { recursive: true });
const bak = join('logs/knowledge.bak', `${new Date().toISOString().replace(/[:.]/g, '-')}__${basename(file)}`);
copyFileSync(file, bak);

writeFileSync(file, `${raw.slice(0, i + BEGIN.length)}\n${tidied}\n${raw.slice(j)}`, 'utf8');
console.log(`整理完成：${before} 条 → ${after} 条（备份 ${bak}）`);
