#!/usr/bin/env node
/**
 * 查「协议端有没有把群消息推给每个号」。
 *
 * ⚠️ 2026-10-24 加（反复踩到的现场）：
 *   SnowLuma 的推送订阅（warmup）只在**它自己启动那一刻、对当时连着的号**建立。
 *   之后中途连上来的号拿不到 ⇒ 表现是「心跳正常、能发消息、**收不到群消息**」，
 *   而且**每次重启漏的是不同的号**（实测三次：漏爱音 / 漏爱音 / 漏主号+谷雨）✗
 *
 * 用法：
 *   node tools/check-push.mjs            # 看最近 40 条群事件，列出每个号收了几条
 *   node tools/check-push.mjs --tail=80  # 看得更多
 *
 * 退出码：0 = 三个号都有；1 = 有号一条都没收到（那就是它半死了）
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
};
const TAIL = Math.max(5, Number(arg('tail', '40')) || 40);
const DIR = process.env.SNOWLUMA_LOG_DIR || 'C:\\SnowLuma\\logs';

// 要盯的号：从 config.yml 的三个账号来（拿不到就用默认）
const ACCOUNTS = (process.env.QQBOT_PUSH_CHECK_QQS || '10000002,10000013,10000014')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** 找最新的日志文件（会滚动：x.log → x.1.log → x.2.log） */
function newestLog() {
  let best = null;
  for (const n of readdirSync(DIR)) {
    if (!n.endsWith('.log')) continue;
    const f = join(DIR, n);
    const m = statSync(f).mtimeMs;
    if (!best || m > best.m) best = { f, m };
  }
  return best?.f ?? '';
}

const f = newestLog();
if (!f) {
  console.log(`❌ 没找到日志（${DIR}）`);
  process.exit(1);
}
console.log(`日志：${f}`);
console.log(`（看最近 ${TAIL} 条群事件）\n`);

const lines = readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.includes('OK') && l.includes('[Event] 群'));
const tail = lines.slice(-TAIL);
if (!tail.length) {
  console.log('⚠️ 日志里一条群事件都没有 —— 群里可能一直没人说话（这一项验不了）');
  process.exit(0);
}

// 每行里第一个方括号是号
const count = new Map();
for (const l of tail) {
  const m = l.match(/\[(\d{6,12})\]/);
  if (!m) continue;
  count.set(m[1], (count.get(m[1]) ?? 0) + 1);
}

let bad = 0;
for (const q of ACCOUNTS) {
  const n = count.get(q) ?? 0;
  if (n > 0) console.log(`✅ ${q} 收到 ${n} 条`);
  else {
    bad++;
    console.log(`❌ ${q} **一条都没收到** ⇒ 这个号的推送订阅掉了（重启它，或者重启协议端）`);
  }
}
for (const [q, n] of count) {
  if (!ACCOUNTS.includes(q)) console.log(`（另外 ${q} 收到 ${n} 条，不在名单里）`);
}

console.log('');
if (bad) {
  console.log(`⚠️ ${bad} 个号的推送掉了 —— 短期内：\`_run-bot.bat <那个号>\` 单独重启它试试；`);
  console.log('   还不行就重启协议端（但每次重启可能换一个号掉，重启完再跑一遍这个脚本确认）。');
} else {
  console.log('✅ 三个号的推送都正常。');
}
process.exit(bad ? 1 : 0);
