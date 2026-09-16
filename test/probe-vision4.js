/**
 * 严谨复测：deepseek-flash / deepseek-v4-pro / deepseek-chat 到底谁支持视觉。
 * 用两张内容差异极大的图，看回答有没有区分度。
 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { facePath } from '../src/faces.js';

const cfg = yaml.load(readFileSync('config.yml', 'utf8'));
const base = String(cfg.llm.baseURL).replace(/\/+$/, '');
const key = cfg.llm.apiKey;

const dataUrl = (p) => {
  const buf = readFileSync(p);
  const ext = p.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
};

// 图1：黄色方块小人举手（欢呼）  图2：灰发少女半月眼（无语）
const A = dataUrl(facePath('欢呼'));
const B = dataUrl(facePath('无语'));

const MODELS = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat'];

for (const model of MODELS) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`【${model}】`);

  for (const [label, img] of [['图A', A], ['图B', B]]) {
    const body = {
      model,
      max_tokens: 300,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '用一句话说这张图里主体的颜色和表情。' },
            { type: 'image_url', image_url: { url: img } },
          ],
        },
      ],
    };
    const t0 = Date.now();
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
      const txt = await r.text();
      const ms = Date.now() - t0;
      if (!r.ok) {
        console.log(`  ${label}: HTTP ${r.status}  ${txt.slice(0, 200)}`);
        continue;
      }
      let j;
      try {
        j = JSON.parse(txt);
      } catch {
        console.log(`  ${label}: 返回不是 JSON: ${txt.slice(0, 200)}`);
        continue;
      }
      const msg = j.choices?.[0]?.message;
      const content = msg?.content ?? '';
      const reasoning = msg?.reasoning_content ?? '';
      console.log(`  ${label} (${ms}ms, finish=${j.choices?.[0]?.finish_reason}):`);
      console.log(`     content   : ${content ? JSON.stringify(content.slice(0, 180)) : '(空)'}`);
      if (reasoning) console.log(`     reasoning : ${JSON.stringify(reasoning.slice(0, 180))}`);
      console.log(`     usage     : ${JSON.stringify(j.usage)}`);
    } catch (e) {
      console.log(`  ${label}: 失败 ${e.message}`);
    }
  }
}
