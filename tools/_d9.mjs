// 对比知识库大段（111812 字）到底哪里在变（跑完删）
import { readFileSync } from 'node:fs';

const K = '⚠️ 下面这些是**已经在你手上的资料**';
const LEN = 111812;
const a = readFileSync('logs/_prompt-group200000008.prev.txt', 'utf8');
const b = readFileSync('logs/_prompt-group200000008.last.txt', 'utf8');
const ia = a.indexOf(K), ib = b.indexOf(K);
console.log(`标题位置 prev@${ia} last@${ib}`);
const A = a.slice(ia, ia + LEN), B = b.slice(ib, ib + LEN);
let i = 0;
while (i < A.length && i < B.length && A[i] === B[i]) i++;
console.log(`第一处不同：第 ${i} 字（段内 ${((i / LEN) * 100).toFixed(2)}%）`);
console.log('\n前 100: ' + JSON.stringify(A.slice(Math.max(0, i - 100), i)));
console.log('\nprev: ' + JSON.stringify(A.slice(i, i + 300)));
console.log('\nlast: ' + JSON.stringify(B.slice(i, i + 300)));
