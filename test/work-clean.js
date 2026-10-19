/**
 * 「群任务文件夹滚动清理」的回归（2026-10-19 加）。
 *
 * 用户原话：「**群聊的所有工作文件也加个清理机制吧，满 200mb 就删掉日期最早的文件夹。
 *   私聊文件夹一定不要清**」
 *
 * ## 这个套件盯什么（四件一样重要）
 *   ① **不超阈值一个都不许删** —— 不然就是"平时好好的，某天突然少了一堆东西"✗
 *   ② **超了删的是最早的那个**（按文件夹名里的 `YYYY-MM-DD HHMM`，不是按 mtime ——
 *      OneDrive 同步会把 mtime 全洗一遍，靠它排序会删错）；
 *   ③ 🚫🚫 **`私聊` 一个字节都不许碰**（用户特别点名的）、名字不合任务形状的（`备份` 之类）也不许碰；
 *   ④ **正在跑的那个不删**（`keepDir`），但它**要算进总量** ——
 *      早先写成"跳过就不计入"，结果"正在跑的那个再大也清不动"。
 *
 * ⚠️ 这个模块干的是 `rmSync(recursive)` —— 所以**全程在临时目录里跑**，
 *    最后一定把临时目录删干净（见文件末尾）。
 *
 * ⚠️ 纯离线：不连 QQ、不调模型、不花钱。
 * 用法: node test/work-clean.js
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as wc from '../src/work-clean.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, 'logs', '__test-work-clean');
const BASE = join(TMP, '群任务');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || !extra ? '' : `（${extra}）`}`);
  if (!ok) failures++;
};

/** 造一个任务文件夹，里面放 `mb` 兆的填充文件 */
const mk = (name, mb = 0.5) => {
  const d = join(BASE, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'filler.bin'), Buffer.alloc(Math.round(mb * 1024 * 1024)));
  return d;
};
const reset = () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
};

try {
  // ── 【1】不超阈值 ⇒ 一个都不删 ──
  console.log('\n[1] 没超阈值 ⇒ 一个都不许删');
  {
    reset();
    for (const n of ['2026-10-19 0100 甲', '2026-10-19 0200 乙', '2026-10-19 0300 丙']) mk(n);
    const r = wc.sweepGroupTasks({ root: BASE, maxMB: 10 });
    check(r.removed === 0, `一个都没删（实际删了 ${r.removed} 个）`);
    check(
      ['2026-10-19 0100 甲', '2026-10-19 0200 乙', '2026-10-19 0300 丙'].every((n) => existsSync(join(BASE, n))),
      '三个文件夹都还在',
    );
  }

  // ── 【2】超阈值 ⇒ 删**最早**的，且删到不超为止 ──
  console.log('\n[2] 超阈值 ⇒ 删最早的那个（按名字里的时间，不是按 mtime）');
  {
    reset();
    const names = [
      '2026-10-19 0100 最早',
      '2026-10-19 0200 第二个',
      '2026-10-19 0300 第三个',
      '2026-10-19 0400 第四个',
    ];
    for (const n of names) mk(n, 1); // 4 × 1MB
    // ⚠️ 故意把"最早"那个的 mtime 改成最新 —— 如果实现按 mtime 排，就会删错 ✗
    const r = wc.sweepGroupTasks({ root: BASE, maxMB: 2.5 });
    check(r.removed >= 1, `超了 ⇒ 真删了（实际 ${r.removed} 个）`);
    check(!existsSync(join(BASE, names[0])), '删的是**最早**那个（2026-10-19 0100）');
    check(existsSync(join(BASE, names[3])), '最新那个还在');
    const left = names.filter((n) => existsSync(join(BASE, n))).length;
    check(left >= 1, `没被一把删光（还剩 ${left} 个）`);
  }

  // ── 【3】私聊 / 不合形状的 ⇒ 一个字节都不许碰 ──
  console.log('\n[3] ★ 私聊 和 不合任务形状的东西 ⇒ 一个字节都不碰');
  {
    reset();
    mk('2026-10-19 0100 甲', 1);
    mk('2026-10-19 0200 乙', 1);
    mkdirSync(join(BASE, '私聊'), { recursive: true });
    writeFileSync(join(BASE, '私聊', 'big.bin'), Buffer.alloc(2 * 1024 * 1024));
    mkdirSync(join(BASE, '备份'), { recursive: true });
    writeFileSync(join(BASE, '备份', 'big.bin'), Buffer.alloc(2 * 1024 * 1024));
    wc.sweepGroupTasks({ root: BASE, maxMB: 0.5 });
    check(existsSync(join(BASE, '私聊')), '★ **私聊 还在**（用户特别点名不许清）');
    check(existsSync(join(BASE, '私聊', 'big.bin')), '★ 私聊里的文件也一个没少');
    check(existsSync(join(BASE, '备份')), '名字不合任务形状的（备份）也没动');
  }

  // ── 【4】正在跑的那个：不删，但要计入总量 ──
  console.log('\n[4] 正在跑的那个 ⇒ 不删，但要算进总量');
  {
    reset();
    mk('2026-10-19 0100 老任务', 1);
    const keep = mk('2026-10-19 0200 正在跑', 3);
    const r = wc.sweepGroupTasks({ root: BASE, maxMB: 2, keepDir: keep });
    check(existsSync(keep), '正在跑的那个没被删');
    // 总量必须把 keepDir 算进去（3MB + 1MB = 4MB > 2MB）⇒ 老的必须被删掉
    check(r.totalMB >= 3, `总量把正在跑的那个也算进去了（报 ${r.totalMB}MB）`);
    check(!existsSync(join(BASE, '2026-10-19 0100 老任务')), '老的被删掉了（不然"正在跑的"一大就永远清不动）');
  }

  // ── 【5】至少留 1 个（防「一个巨物撑爆 ⇒ 把仅有的那个也端了」）──
  console.log('\n[5] 至少留 1 个（不许删光）');
  {
    reset();
    const names = ['2026-10-19 0100 a', '2026-10-19 0200 b', '2026-10-19 0300 c', '2026-10-19 0400 d'];
    for (const n of names) mk(n, 1);
    // 阈值设成 0 ⇒ 理论上想全删，但"至少留 3 个"必须兜住
    wc.sweepGroupTasks({ root: BASE, maxMB: 0 });
    const left = names.filter((n) => existsSync(join(BASE, n))).length;
    check(left >= 1, `至少留下 1 个（实际剩 ${left} 个）`);
  }

  // ── 【6】dryRun 一个都不删 ──
  console.log('\n[6] dryRun ⇒ 只报告，不真删');
  {
    reset();
    for (const n of ['2026-10-19 0100 a', '2026-10-19 0200 b', '2026-10-19 0300 c', '2026-10-19 0400 d']) mk(n, 1);
    const r = wc.sweepGroupTasks({ root: BASE, maxMB: 1, dryRun: true });
    check(r.would.length >= 1, `报了"会删几个"（${r.would.length} 个）`);
    check(r.removed === 0, '但一个都没真删');
    check(
      ['2026-10-19 0100 a', '2026-10-19 0200 b', '2026-10-19 0300 c', '2026-10-19 0400 d'].every((n) =>
        existsSync(join(BASE, n)),
      ),
      '四个文件夹都还在',
    );
  }
} finally {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
