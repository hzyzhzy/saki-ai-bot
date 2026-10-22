/**
 * 她的**实时状态机**（2026-10-22 加，用户要求「b站这边也带上几个实时状态机，更具活人感」）
 *
 * ## 为什么需要
 *   光有人设和语气，她还是"随时都一个样"—— 半夜三点和中午十二点说的话一模一样，
 *   一看就是程序 ✗ 真人说话**受此刻状态影响**：困了就短、忙了就不耐烦、刚吃完饭会顺口提一句。
 *
 * ## 四个维度（都是"此刻"的，会随时间自己变）
 *   ① `activity` 此刻在干什么（在客服室 / 吃饭 / 出门 / 快睡了…）
 *   ② `energy`   精力 0~1（深夜低、下午低谷）
 *   ③ `mood`     心情（今天有个**底子**，当天不变；再叠一点时段影响）
 *   ④ `since`    这个状态已经持续多久（"忙了快两个钟头了"）
 *
 * ## ⚠️ 三条设计上的讲究（别改成随机）
 *   ① **确定性**：同一个小时内多次调用结果**必须一样** —— 否则她上一句"在吃饭"、
 *      下一句"在睡觉"，比没有状态机还假 ✗ ⇒ 用"日期+小时"做种子，不用 `Math.random()`
 *   ② **当天有底子**：起床早晚、今天忙不忙、心情基线 —— **当天随机一次就定死**，落盘
 *   ③ **状态要持续**：一小时换一次（不是每分钟），而且"干了多久"要说得出
 *
 * ## 用在哪
 *   · B站评论回复（`bili-comments.js` 的提示词里）
 *   · 以后的主动评论（`tools/bili-proactive-comment.mjs`）
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './config.js';

const file = () => join(stateDir(), 'bili-presence.json');
const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 用字符串算一个稳定的 0~1 伪随机（同输入永远同输出） */
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function loadDay(day) {
  try {
    const j = JSON.parse(readFileSync(file(), 'utf8'));
    if (j && j.day === day) return j;
  } catch { /* ignore */ }
  // 今天的"底子"：随机一次，当天不变
  const r = (k) => hash01(`${day}:${k}`);
  const next = {
    day,
    /** 今天起得早不早（影响精力曲线） */
    earlyBird: r('rise') > 0.5,
    /** 今天忙不忙（影响回评论的耐心） */
    busyDay: r('busy') > 0.55,
    /** 心情基线 0~1（0.5 = 平平） */
    baseMood: Math.round(r('mood') * 100) / 100,
    /** 今天有没有什么"小事"（顺口能提一句，增加活人感） */
    tidbit: [
      '早上差点睡过头',
      '路上看见一只很胖的猫',
      '昨天剩的饭今天又热了一遍',
      '楼下的店换招牌了',
      '手机膜又裂了一道',
      '被隔壁装修吵了一上午',
      '',
    ][Math.floor(r('tidbit') * 7)],
  };
  try {
    mkdirSync(stateDir(), { recursive: true });
    const tmp = file() + '.tmp';
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    try { renameSync(tmp, file()); } catch { writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8'); }
  } catch { /* ignore */ }
  return next;
}

/** 按小时段推「此刻在干什么」—— 同一小时结果固定 */
function activityOf(h, day, base) {
  const r = (k) => hash01(`${day}:${h}:${k}`);
  if (h >= 0 && h < 6) {
    return r('a') > 0.75
      ? { text: '躺着还没睡着，翻手机', energy: 0.15, mood: -0.05 }
      : { text: '睡着了（要是这会儿看到消息，那是被吵醒的）', energy: 0.05, mood: -0.15 };
  }
  if (h < 8) {
    return { text: base.earlyBird ? '刚起来，还没完全清醒' : '赖在床上不想起', energy: 0.35, mood: -0.05 };
  }
  if (h < 11) {
    return base.busyDay
      ? { text: '在客服室忙着回一堆人', energy: 0.7, mood: -0.08 }
      : { text: '在客服室待着，没什么人', energy: 0.65, mood: 0.05 };
  }
  if (h < 13) {
    return { text: r('a') > 0.5 ? '在吃饭' : '刚吃完，在收拾', energy: 0.6, mood: 0.1 };
  }
  if (h < 17) {
    return base.busyDay
      ? { text: '下午最忙的一段，手头一堆事', energy: 0.5, mood: -0.1 }
      : { text: '下午有点犯困，硬撑着', energy: 0.4, mood: -0.03 };
  }
  if (h < 19) {
    return { text: r('a') > 0.5 ? '在弄晚饭' : '刚吃完', energy: 0.55, mood: 0.08 };
  }
  if (h < 22) {
    return { text: r('a') > 0.6 ? '在刷手机，没什么正事' : '在家待着，看看东西', energy: 0.6, mood: 0.1 };
  }
  if (h < 24) {
    return { text: '准备睡了，但还没关灯', energy: 0.3, mood: 0.02 };
  }
  return { text: '这个点还没睡', energy: 0.2, mood: 0 };
}

/**
 * 当前状态（**同一小时内结果固定**）
 * @returns {{activity:string, energy:number, mood:number, moodText:string, sinceMin:number, tidbit:string, hour:number}}
 */
export function now(at = new Date()) {
  const day = dayKey(at);
  const base = loadDay(day);
  const h = at.getHours();
  const a = activityOf(h, day, base);
  const energy = Math.max(0, Math.min(1, a.energy + (base.earlyBird ? -0.05 : 0.05)));
  const mood = Math.max(-1, Math.min(1, (base.baseMood - 0.5) * 1.2 + a.mood));

  const moodText = mood > 0.35 ? '挺好的'
    : mood > 0.1 ? '还行'
      : mood > -0.1 ? '平平的'
        : mood > -0.35 ? '有点烦'
          : '不太高兴';

  return {
    hour: h,
    activity: a.text,
    energy: Math.round(energy * 100) / 100,
    mood: Math.round(mood * 100) / 100,
    moodText,
    // 这个状态从整点开始算（"已经多久了"）
    sinceMin: at.getMinutes(),
    tidbit: base.tidbit,
  };
}

/**
 * 拼成给提示词用的一段。
 *
 * ⚠️ 别写成一堆数字（"精力 0.35"模型看不懂）⇒ 翻成人话 ✓
 * ⚠️ 空的不返回（没东西就不占 token）
 */
export function block(at = new Date()) {
  const s = now(at);
  const energyText = s.energy < 0.25 ? '快没电了（说话会更短、更懒）'
    : s.energy < 0.45 ? '有点累'
      : s.energy < 0.7 ? '正常'
        : '挺有精神';
  const lines = [
    '【你此刻的状态（**实时**，不是设定）】',
    `· 这会儿：${s.activity}`,
    `· 精力：${energyText}`,
    `· 心情：${s.moodText}`,
  ];
  if (s.tidbit) lines.push(`· 今天有件小事：${s.tidbit}（想提就提一句，别硬塞）`);
  lines.push(
    '⚠️ **别跟这个状态矛盾**：说困就别精神抖擞，说在吃饭就别讲在跑步；',
    '⚠️ 也**别把状态当台词念**（不用每句都提"我正在吃饭"）—— 它只影响你的语气和长短。',
  );
  return lines.join('\n');
}

/** 给界面/调试看 */
export function status(at = new Date()) {
  return { ...now(at), block: block(at) };
}
