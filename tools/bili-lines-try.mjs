/**
 * 快速验证「台词带人设」的效果 —— 只调一次模型生成台词，不跑整条管线（约 20 秒）
 *
 * 用法：node tools/bili-lines-try.mjs [题材]
 * 输出：8 句台词 + 一句话说明它玩了什么梗（给用户看够不够"活"）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { SAKI_VOICE } from '../src/bili-publish.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOPIC = process.argv[2] || '聊聊「AI 合成的声音算不算我的声音」这件事';

const cfg = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) || {};
const llm = cfg.llm || {};
if (!llm.apiKey || !llm.baseURL) {
  console.log('❌ config.yml 里没有 llm.apiKey / llm.baseURL');
  process.exit(2);
}

const sys = [
  '你给一条 B 站竖屏短视频写台词。视频里说话的人是**祥子（Saki）**，',
  '在一个 MC 服务器的 QQ 群里兼职当客服。',
  '',
  '⚠️ 这些台词**全部是她自己说的话**（第一人称），会配成真人语音往视频里放。',
  '',
  SAKI_VOICE,
  '',
  '要求：',
  '1. 8 句，每句 8~22 个字',
  '2. 第一句直接说事（不要"大家好我是XX"）；最后一句收尾，别营销腔',
  '3. 只输出 JSON：{"lines":["…","…"],"memes":["这条玩了哪 0~2 个梗（没有就空数组）"]}',
].join('\n');

const r = await fetch(String(llm.baseURL).replace(/\/+$/, '') + '/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llm.apiKey },
  body: JSON.stringify({
    model: llm.model,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: '这次的题材：' + TOPIC }],
    temperature: 0.75,
    max_tokens: 1600,
    thinking: { type: 'disabled' },
  }),
});
const txt = await r.text();
if (!r.ok) {
  console.log('❌ HTTP ' + r.status + ' ' + txt.slice(0, 300));
  process.exit(3);
}
const j = JSON.parse(txt);
const raw = j?.choices?.[0]?.message?.content ?? '';
const m = raw.match(/\{[\s\S]*\}/);
if (!m) {
  console.log('❌ 模型没给 JSON：' + raw.slice(0, 300));
  process.exit(3);
}
const out = JSON.parse(m[0]);
console.log('题材：' + TOPIC);
console.log('');
(out.lines || []).forEach((t, i) => console.log(`${i + 1}. ${t}`));
console.log('');
console.log('玩的梗：' + ((out.memes || []).length ? out.memes.join(' / ') : '（没玩）'));
const total = (out.lines || []).reduce((a, t) => a + String(t).length, 0);
console.log(`字数：${total}（8 句约 ${(total / 4.2).toFixed(0)} 秒说话量）`);
