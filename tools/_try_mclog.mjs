/** 用现有的 mc-log 解析用户发的那份 latest.log —— 证明"只差把文件拿到手"。 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import * as mclog from '../src/mc-log.js';

const p = String.raw`E:\Downloads\latest.log`;
console.log('文件:', p);
console.log('存在:', existsSync(p), '| 大小:', existsSync(p) ? Math.round(statSync(p).size / 1024) + ' KB' : '-');

if (!existsSync(p)) process.exit(1);

const buf = readFileSync(p);
const res = mclog.analyzeFile({ name: 'latest.log', buf });
console.log('analyzeFile ok =', res.ok, '| reason =', res.reason || '无');

if (res.ok) {
  const block = mclog.logBlock(res.parsed);
  console.log('--- logBlock 前 1200 字 ---');
  console.log(String(block).slice(0, 1200));
}
