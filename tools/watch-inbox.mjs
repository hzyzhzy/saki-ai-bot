/**
 * 盯适配器日志，等一条「真的被推上来的消息 / 戳」。
 *
 * ## 为什么需要它
 * 「收消息」这一环必须**有人真的发一条**才能验。而实测：
 *   · 从 SnowLuma 的**第二个客户端连接**发（`anon-send.mjs`）—— `retcode 0` 但消息**到不了**
 *     （连会话摘要都不变，试了 5 条、3 个不同的群）
 *   · 所以只能由真人发。
 * 这个工具把"发完之后自己看日志"这一步做成一条命令：它盯着日志，
 * 一出现 `📥 收到` 或 `👉 被「」` 就打印出来并退出 0。
 *
 *   node tools/watch-inbox.mjs              # 盯 120 秒
 *   node tools/watch-inbox.mjs --sec 300    # 盯 5 分钟
 *   node tools/watch-inbox.mjs --grep '@Saki'  # 只认含这个串的
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(ROOT, 'logs', 'qq-onebot.log');

const argv = process.argv.slice(2);
const pick = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] : d;
};
const sec = Number(pick('sec', '120')) || 120;
const grepWant = String(pick('grep', '') || '');

if (!existsSync(LOG)) {
  console.error('没有日志文件：' + LOG);
  process.exit(2);
}

// 从**当前文件末尾**开始盯（不看历史）
let offset = statSync(LOG).size;
console.log(`👀 盯 ${LOG}（${sec} 秒）…`);
console.log('   现在去 QQ 里发一条「@Saki 测试」，或者戳她一下。');
if (grepWant) console.log(`   只认含 "${grepWant}" 的行。`);

const HIT = /📥 收到|👉 被「|👀 屏幕消息/;
const deadline = Date.now() + sec * 1000;
let hits = 0;

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  let size = 0;
  try {
    size = statSync(LOG).size;
  } catch {
    continue;
  }
  if (size <= offset) continue;
  let chunk = '';
  try {
    const buf = readFileSync(LOG);
    chunk = buf.slice(offset).toString('utf8');
  } catch {
    continue;
  }
  offset = size;
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    if (!HIT.test(line)) continue;
    if (grepWant && !line.includes(grepWant)) continue;
    console.log('  ' + line.trim());
    hits++;
  }
  if (hits > 0 && /📥 收到|👉 被「/.test(chunk)) {
    console.log(`\n✅ 收到 ${hits} 条相关日志 —— 收消息这条路是通的`);
    process.exit(0);
  }
}

console.log(`\n❌ ${sec} 秒内没等到 📥 收到 / 👉 被「」`);
console.log('   排查顺序：');
console.log('   1. 适配器在不在：Get-NetTCPConnection -LocalPort 6700');
console.log('   2. 锚点是哪个群：grep 锚点 logs\\qq-onebot.log | tail -1');
console.log('   3. 会话是否为空：grep "当前会话「」" logs\\qq-onebot.log | tail -3');
process.exit(1);
