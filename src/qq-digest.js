/**
 * **QQ 这边的短期摘要**（2026-10-22 加）
 *
 * 用户要求：「短期记忆共享知识库里要有**在 QQ 这边最近发生了什么事**」
 *
 * ## 为什么是"定时总结"而不是"每条消息都记"
 *   ① 用户明确说"都是**总结性**内容" —— 原文在 `state/recent.json`，这里只放一句话
 *   ② 每条都记会把提示词撑爆，而且没有信息量（"嗯""好"也记一条 = 噪音）✗
 *
 * ## 节奏
 *   每 `qqDigest.everyMinutes`（默认 120 分钟）看一眼**最近 2 小时**的群消息，
 *   让模型写一句"这段时间群里在聊什么"，写进短期记忆（`kind: 'qq'`）。
 *   ⚠️ 没什么可总结的（消息太少 / 全是水）就**不写**（别硬编一句）
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, stateDir } from './config.js';
import { log } from './log.js';
import * as llm from './llm.js';
import * as shortMemory from './short-memory.js';

let lastAt = 0;
let running = false;

export function settings() {
  const c = config.qqDigest || {};
  return {
    enable: c.enable !== false,            // 默认**开**（只是写一句摘要，风险低）
    everyMinutes: Math.max(30, Math.min(720, Number(c.everyMinutes) || 120)),
    windowHours: Math.max(1, Math.min(12, Number(c.windowHours) || 2)),
    group: String(c.group || '') || String(config.biliPublish?.group || ''),
  };
}

function recentMessages(group, sinceMs) {
  try {
    const rj = JSON.parse(readFileSync(join(stateDir(), 'recent.json'), 'utf8'));
    const all = (rj.groups || {})[group] || [];
    return all
      .filter((m) => {
        const t = Number(m.time ?? m.ts ?? 0) * (String(m.time ?? m.ts ?? 0).length <= 10 ? 1000 : 1);
        return Number.isFinite(t) && t >= sinceMs;
      })
      .slice(-150);
  } catch {
    return [];
  }
}

export async function runOnce() {
  if (running) return { ok: false, why: 'busy' };
  const c = settings();
  const group = c.group || '200000001';
  const since = Date.now() - c.windowHours * 3600 * 1000;
  const msgs = recentMessages(group, since);
  if (msgs.length < 8) {
    log.info(`[QQ摘要] 最近 ${c.windowHours} 小时只有 ${msgs.length} 条 ⇒ 这次不总结`);
    return { ok: false, why: 'too-few' };
  }

  running = true;
  try {
    const listing = msgs
      .map((m) => `${m.self ? '[她自己]' : ''}${String(m.nickname || m.name || '').slice(0, 10)}：${String(m.text || '').slice(0, 60)}`)
      .join('\n');
    const ans = await llm.phrase({
      system: [
        '把下面这段 QQ 群聊**总结成一句话**（不超过 40 字），写清"这段时间群里在聊什么/发生了什么事"。',
        '',
        '要求：',
        '1. 只写**实际发生的事**（谁在折腾什么、解决了什么、聊了个什么话题）',
        '2. 🚫 别写"大家在聊天""气氛融洽"这种空话',
        '3. 🚫 别记闲聊口水（吃什么、天气、"嗯""好"）',
        '4. 真的没什么事 ⇒ 只回「无」',
        '',
        '只输出那一句话，不要前缀。',
      ].join('\n'),
      user: listing,
      maxTokens: 120,
      timeoutMs: 30000,
      thinking: { type: 'disabled' },
    });
    const text = String(ans ?? '').trim().replace(/^["'「]|["'」]$/g, '').trim();
    if (!text || text === '无' || text.length < 4) {
      log.info('[QQ摘要] 模型说没什么事 ⇒ 不记');
      return { ok: false, why: 'nothing' };
    }
    shortMemory.add('qq', text, { key: `qq:${Math.floor(Date.now() / (c.everyMinutes * 60000))}` });
    log.info(`[QQ摘要] 记下了：${text}`);
    return { ok: true, text };
  } catch (e) {
    log.warn(`[QQ摘要] 总结失败：${e.message}`);
    return { ok: false, why: e.message };
  } finally {
    running = false;
  }
}

/** 每 30 秒被 index.js 调一次 */
export function tick() {
  const c = settings();
  if (!c.enable) return;
  if (running) return;
  if (Date.now() - lastAt < c.everyMinutes * 60 * 1000) return;
  lastAt = Date.now();
  void runOnce();
}

export function status() {
  const c = settings();
  return { ...c, running, lastAt: lastAt ? new Date(lastAt).toISOString() : '' };
}
