/** 探测：OpenAI 兼容接口的 /models 能不能列出可用模型 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const cfg = yaml.load(readFileSync('config.yml', 'utf8'));
const base = String(cfg.llm.baseURL).replace(/\/+$/, '');
const key = cfg.llm.apiKey;

console.log('baseURL =', base);
console.log('当前 model =', cfg.llm.model);
console.log('');

for (const path of ['/models', '/model/list']) {
  const url = base + path;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
    });
    console.log(`${path} -> HTTP ${r.status}`);
    if (!r.ok) {
      console.log('   ', (await r.text()).slice(0, 200));
      continue;
    }
    const j = await r.json();
    const list = j.data ?? j.models ?? j;
    if (Array.isArray(list)) {
      console.log(`    共 ${list.length} 个模型:`);
      for (const m of list) {
        const id = m.id ?? m.name ?? m.model ?? JSON.stringify(m).slice(0, 60);
        console.log('      -', id);
      }
    } else {
      console.log('    返回结构:', JSON.stringify(j).slice(0, 400));
    }
  } catch (e) {
    console.log(`${path} -> 失败: ${e.message}`);
  }
}
