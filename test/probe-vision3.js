/**
 * 测试识图能力：给它一张真实的 MC 建筑截图，看能识别出多少细节。
 * 用法: node test/probe-vision3.js <图片路径>
 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const cfg = yaml.load(readFileSync('config.yml', 'utf8'));
const base = String(cfg.llm.baseURL).replace(/\/+$/, '');
const key = cfg.llm.apiKey;
const file = process.argv[2];

if (!file) {
  console.log('用法: node test/probe-vision3.js <图片路径>');
  process.exit(1);
}

const buf = readFileSync(file);
const ext = file.split('.').pop().toLowerCase();
const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/webp' ? 'image/webp' : 'image/jpeg';
console.log(`图片: ${file}  ${(buf.length / 1024).toFixed(0)}KB  ${mime}`);

const PROMPT = `请极其详细地描述这张图片。这是一个 Minecraft 服务器群里群友发的建筑截图，我需要知道：

1. 画面里有什么建筑/设施？（车站、铁路、道路、建筑…）
2. 有没有可读的文字、站牌、线路名？逐字念出来。
3. 用了什么材质、什么颜色、什么风格？
4. 构图角度是怎么取的？
5. 从建造水平看，这个人花了多少心思？有什么细节做得特别好？
6. 有没有让你联想到什么动漫场景、现实地标、其他作品？

尽量具体。看不清的地方就说看不清，不要编。`;

const body = {
  model: 'deepseek-chat',
  max_tokens: 1200,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
      ],
    },
  ],
};

const r = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(120000),
});
const j = await r.json();
if (!r.ok) {
  console.log('HTTP', r.status, JSON.stringify(j).slice(0, 400));
  process.exit(1);
}
console.log('\n=== 识图结果 ===');
console.log(j.choices?.[0]?.message?.content ?? '（空）');
console.log('\n=== 用量 ===');
console.log(JSON.stringify(j.usage));
