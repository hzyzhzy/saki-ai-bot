/**
 * 实测「B站评论回复」一条要花多少钱（2026-10-22）
 *
 * 用的是 `tools/bili-comment-bot.mjs` 里**一模一样的**提示词构造，只是把 usage 打出来。
 * 用法：node tools/bili-comment-cost.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { SAKI_VOICE } from '../src/bili-publish.js';
import * as shortMemory from '../src/short-memory.js';
import { costOf, isPeak } from '../src/spend.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) || {};
const llm = cfg.llm || {};

const mem = shortMemory.block({ maxChars: 700 });
const sys = [
  '你在 B 站自己的视频下面回复一条评论。',
  '',
  SAKI_VOICE,
  '',
  mem ? mem + '\n' : '',
  '要求：',
  '0. ⚠️⚠️ **这个视频不一定是"你做的"** —— 这个账号下面还有别人发的旧视频（比如轨交、铁路那些）。',
  '   ⇒ **别认领创作细节**（不要说"我铺的""我调的""我试了三回"这种）✗',
  '   被问技术细节 ⇒ 老实说不清楚 / 让他问作者；被夸 ⇒ 接一句就行（可以自嘲"我也就看看"）',
  '   ⚠️ 只有**明确是你自己发的**（标题像你做的视频、或者短期记忆里记着"我发了…"）才按作者口吻回',
  '1. **一句话就够**，最多两句（8~30 字），别写小作文',
  '2. 别 @ 人、别加「感谢支持」「欢迎关注」这种客套 ✗',
  '3. 对方是**夸你**就接一句（可以嘴硬、可以自嘲）；**提问**就直接答；',
  '   **挑刺/阴阳**就按你的脾气怼回去（但别骂人、别上纲上线）；**没营养的**（就一个表情）',
  '   就短促接一下，别硬聊',
  '4. 别重复对方的话，别解释自己是 AI（除非对方直接问、且你已经承认过的口径）',
  '5. 只输出**回复正文**，不要引号、不要前缀',
].filter(Boolean).join('\n');

const user = [
  '视频：《[MC简式轨交]我的第一条环线铁路》',
  '评论者：up泰和',
  '评论内容：还行，比轨全在地面好，弯道弄的比我强',
].join('\n');

console.log('=== 拼进去的东西 ===');
console.log('① 固定人设语气块 SAKI_VOICE：', SAKI_VOICE.length, '字');
console.log('② 短期共享记忆 block(700)：', mem.length, '字（当前记忆 ' + shortMemory.list().length + ' 条）');
console.log('③ 回复要求：', sys.length - SAKI_VOICE.length - mem.length, '字');
console.log('④ 评论上下文：', user.length, '字');
console.log('⑤ system 总长：', sys.length, '字');

const t0 = Date.now();
const r = await fetch(String(llm.baseURL).replace(/\/+$/, '') + '/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llm.apiKey },
  body: JSON.stringify({
    model: llm.model,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.8,
    max_tokens: 300,
    thinking: { type: 'disabled' },
  }),
});
const body = await r.text();
if (!r.ok) { console.log('❌ HTTP', r.status, body.slice(0, 300)); process.exit(3); }
const j = JSON.parse(body);
const u = j.usage || {};
console.log('\n=== 实测 ===');
console.log('回复：', String(j.choices?.[0]?.message?.content ?? '').trim().slice(0, 60));
console.log('耗时：', ((Date.now() - t0) / 1000).toFixed(1), '秒');
console.log('prompt_tokens =', u.prompt_tokens, '｜completion_tokens =', u.completion_tokens);
console.log('缓存命中 =', u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);

const cost = costOf({
  model: llm.model,
  promptTokens: u.prompt_tokens || 0,
  completionTokens: u.completion_tokens || 0,
  cachedTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
});
console.log('\n=== 钱 ===');
console.log('当前时段：', isPeak() ? '高峰价' : '空闲价（半价）');
console.log('这一条 =', cost.toFixed(6), '元 =', (cost * 100).toFixed(4), '分');
console.log('按这价推算：100 条 =', (cost * 100).toFixed(3), '元 ｜ 1000 条 =', (cost * 1000).toFixed(2), '元');
process.exit(0);
