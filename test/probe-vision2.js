/** 用真实图片测：模型是真看图还是瞎猜 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { facePath } from '../src/faces.js';

const cfg = yaml.load(readFileSync('config.yml', 'utf8'));
const base = String(cfg.llm.baseURL).replace(/\/+$/, '');
const key = cfg.llm.apiKey;

// 用两张内容完全不同的图，看能不能说出区别
const imgA = facePath('欢呼'); // 黄色方块小人举手
const imgB = facePath('无语'); // 灰发少女半月眼

const toDataUrl = (p) => {
  const buf = readFileSync(p);
  const ext = p.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
};

for (const model of ['deepseek-chat', 'deepseek-flash', 'deepseek-v4-pro']) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`模型: ${model}`);
  for (const [label, path] of [['图A', imgA], ['图B', imgB]]) {
    const body = {
      model,
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '详细描述这张图：里面有什么人物、什么颜色、在做什么？' },
            { type: 'image_url', image_url: { url: toDataUrl(path) } },
          ],
        },
      ],
    };
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      const j = await r.json();
      const out = j.choices?.[0]?.message?.content ?? '';
      console.log(`  ${label} (${path.split(/[\\/]/).pop()}): ${out ? JSON.stringify(out.slice(0, 200)) : '（空回复）'}`);
    } catch (e) {
      console.log(`  ${label} 失败: ${e.message}`);
    }
  }
}
