/**
 * 让**模型**编排 Live2D 动作（用户 2026-10-21：「全部动作流程也由 agent 来完成，而不是脚本」）
 *
 * 为什么交给模型：动作要跟台词的情绪走（说到"我配合"该是点头，说到"折腾半天"该是无奈），
 * 这是**理解人话**，写死在脚本里的时间表换个台词就全错了 ✗
 *
 * 用法：
 *   node tools/pick-actions.mjs                       # 用 logs/bili/intro_lines.json
 *   node tools/pick-actions.mjs --gap 1.4 --out logs/bili/actions.json
 * 输出：actions.json = [{ at, name, kind, why }]，直接喂给
 *       `node tools/live2d-record.mjs --actions-file actions.json`
 *
 * ⚠️ 衔接问题（用户说的「动作中间没有衔接」）：动作播放时不回到待机才有连贯感，
 *    所以间隔要压到 **1.2~2.0 秒**（动作本身约 2~3 秒 ⇒ 自然叠接），别 3 秒一个 ✗
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.BILI_FFMPEG || 'C:\\Users\\<主人>\\AppData\\Roaming\\bilibili\\ffmpeg\\ffmpeg.exe';
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const say = (s) => console.log(`[actions] ${s}`);

const LINES = resolve(arg('lines', join(ROOT, 'logs', 'bili', 'intro_lines.json')));
const VOICE_DIR = resolve(arg('voice', join(ROOT, 'logs', 'bili', 'intro_voice')));
const GAP = Number(arg('gap', '0.35'));
const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', 'actions.json')));

const cfg = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) || {};
const llm = cfg.llm || {};
if (!llm.apiKey || !llm.baseURL) { say('❌ config.yml 里没有 llm 配置'); process.exit(2); }

const durOf = (p) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', p], { encoding: 'utf8' });
  const m = String(r.stderr || '').match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};

const lines = JSON.parse(readFileSync(LINES, 'utf8'))
  .map((x) => (typeof x === 'string' ? x : String(x.text || '').trim()));

// 逐句算出这段台词在总时间轴上的 [start, end]
const wavs = [];
try {
  const fs = readFileSync; // noop 保持风格
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(VOICE_DIR).filter((x) => /^v\d+\.wav$/i.test(x))
    .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)))) wavs.push(join(VOICE_DIR, f));
} catch { /* ignore */ }
if (!wavs.length) { say('❌ 没有配音，先跑 TTS'); process.exit(2); }

const durs = wavs.map(durOf);
let cursor = 0;
const cues = lines.map((text, i) => {
  const dur = durs[i] || 3;
  const c = { i, text, start: +cursor.toFixed(2), end: +(cursor + dur).toFixed(2) };
  cursor += dur + GAP;
  return c;
});
const totalDur = +cursor.toFixed(2);
say(`台词 ${cues.length} 句 / 总长 ${totalDur}s`);

const MOTIONS = {
  head: ['nod01_C', 'nod01_R', 'nod01_L', 'nod02_C', 'nod02_R', 'nod02_L',
         'look01_C', 'look01_R', 'look01_L', 'look02_C', 'look02_R', 'look02_L'],
  hand: ['denial01_C', 'denial01_L', 'denial01_R',
         'check01_C', 'check01_L', 'check01_R',
         'kime01_C', 'kime01_L', 'kime01_R'],
  expr: ['smile01_R', 'smile02_C', 'angry01_C', 'serious01_L', 'surprised01_R',
         'question01_C', 'sad01_C', 'bye01_L'],
};

const sys = `你在给一条 B 站竖屏短视频排 Live2D 动作。

视频是一个 AI 角色（祥子）的自我介绍，她自己说话，画面右下角是她的**半身**。
你要决定在哪些秒数、点哪个动作/表情，让她**不僵硬、跟台词情绪对得上**。

可用动作（只能用这些名字，别自创）：
- 头部：${MOTIONS.head.join('、')}
- 手部：${MOTIONS.hand.join('、')}
- 表情：${MOTIONS.expr.join('、')}

硬性要求：
1. **间隔 1.2~1.8 秒一个动作**（动作本身约 2~3 秒，间隔大了会回到待机、看着"没有衔接"）
2. 全片**一共约 ${Math.round(totalDur / 1.5)} 个动作**（±2 个），别少于 ${Math.round(totalDur / 1.8)}
   —— 数量不够就会有大段空档，这正是用户抱怨的"动作中间没有衔接"✗
3. 每句台词至少 1 个动作；长句（>4 秒）要 2~3 个
4. **按情绪选**：说到打招呼/笑 → smile；说到点头认同 → nod；说到"我配合" → nod/check；
   说到疑惑 → question01_C / look；说到无奈/折腾 → sad01_C；说到认真 → serious01_L；
   说到强调/摆姿势 → kime；结尾告别 → bye01_L
5. 手部动作（check/denial/kime）要占一定比例（用户要求"多一点手部动作"），
   别全是头和表情
6. **不要同一类连续 3 次以上**（会显得机械）
7. 时间不能超出 0~${totalDur} 秒

只输出 JSON，不要解释：
{"actions":[{"at":0.4,"name":"smile01_R","kind":"motion","why":"开场微笑打招呼"},...]}`;

const userPrompt = `【台词时间轴】
${cues.map((c) => `L${c.i} ${c.start}s~${c.end}s：${c.text}`).join('\n')}`;

say('正在让模型编排动作…');
let actions = null;
try {
  const res = await fetch(`${String(llm.baseURL).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: userPrompt }],
      temperature: 0.5,
      max_tokens: 4000,
      thinking: { type: 'disabled' },
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${bodyText.slice(0, 300)}`);
  const j = JSON.parse(bodyText);
  const raw = j?.choices?.[0]?.message?.content ?? '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型没给 JSON：' + raw.slice(0, 200));
  actions = (JSON.parse(m[0]).actions || []);
} catch (e) {
  say('❌ 编排失败：' + e.message);
  process.exit(3);
}

// 校验：名字必须在可用清单里、时间在范围内、按时间排序
const known = new Set([...MOTIONS.head, ...MOTIONS.hand, ...MOTIONS.expr]);
const bad = [];
actions = actions
  .filter((a) => {
    const okName = known.has(String(a.name || ''));
    const okAt = Number.isFinite(Number(a.at)) && Number(a.at) >= 0 && Number(a.at) <= totalDur;
    if (!okName) bad.push(`未知动作 ${a.name}`);
    if (!okAt) bad.push(`时间越界 ${a.at}`);
    return okName && okAt;
  })
  .map((a) => ({ at: +Number(a.at).toFixed(2), name: String(a.name), kind: 'motion', why: String(a.why || '') }))
  .sort((x, y) => x.at - y.at);

if (bad.length) say(`⚠️ 剔掉 ${bad.length} 条不合规：${bad.slice(0, 5).join('；')}`);

// 间隔自检（太稀会导致"没有衔接"）
const gaps = actions.slice(1).map((a, i) => a.at - actions[i].at);
const avgGap = gaps.length ? gaps.reduce((x, y) => x + y, 0) / gaps.length : 0;
const maxGap = gaps.length ? Math.max(...gaps) : 0;

writeFileSync(OUT, JSON.stringify({ totalDur, count: actions.length, avgGap: +avgGap.toFixed(2), actions }, null, 2), 'utf8');
say(`✅ ${OUT}`);
say(`   ${actions.length} 个动作，平均间隔 ${avgGap.toFixed(2)}s，最大 ${maxGap.toFixed(2)}s`);
if (maxGap > 2.6) say(`⚠️ 有 ${maxGap.toFixed(1)}s 的空档，动作会回到待机（"没有衔接"）`);
say('   ' + actions.slice(0, 8).map((a) => `${a.at}s ${a.name}`).join(' | '));
