// 验收：多提供商 + 存档 + 降级（2026-10-22 用户要求的三件）
// ⚠️ 先存原值 → 测 → 恢复原值，并断言恢复成功
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const PORT = process.argv[2] || '3099';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const say = (s) => console.log(`[模型页] ${s}`);
const BASE = `http://127.0.0.1:${PORT}`;

// 读配置（llm 是共用段 ⇒ 在 config.yml）
function readLlm() {
  const o = yaml.load(readFileSync('config.yml', 'utf8')) || {};
  return o.llm || {};
}

const before = readLlm();
say(`测试前：providers=${(before.providers || []).length} 个，activeId=${before.activeId || '(无)'}，model=${before.model}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2500);

// ① 界面元素在不在
await page.evaluate(() => document.querySelector('nav button[data-tab="model"]').click());
await page.waitForTimeout(2000);
const ui = await page.evaluate(() => ({
  provList: !!document.getElementById('prov-list'),
  fallback: !!document.getElementById('prov-fallback'),
  pfList: !!document.getElementById('pf-list'),
  addBtn: [...document.querySelectorAll('button')].some((b) => /添加提供商/.test(b.textContent || '')),
}));
say('界面元素：' + JSON.stringify(ui));

// ② 建两个提供商 + 启用第一个
const r1 = await (await fetch(`${BASE}/api/llm-providers`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    providers: [
      { id: 'test-a', name: '测试主', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-test-a', model: 'deepseek-flash' },
      { id: 'test-b', name: '测试备', baseURL: 'https://api.example.com/v1', apiKey: 'sk-test-b', model: 'backup-model' },
    ],
    activeId: 'test-a',
  }),
})).json();
say(`建两个提供商：${r1.ok ? '✓' : '❌ ' + (r1.error || '')}（${(r1.providers || []).length} 个）`);

// ③ 读回（应该写进扁平字段）
const after1 = readLlm();
const flatOk = after1.baseURL === 'https://api.deepseek.com/v1' && after1.model === 'deepseek-flash';
say(`启用后扁平字段同步：${flatOk ? '✓' : '❌'}（baseURL=${after1.baseURL}, model=${after1.model}）`);

// ④ 存档
const r2 = await (await fetch(`${BASE}/api/llm-profiles/save`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '__验收存档__' }),
})).json();
say(`存档：${r2.ok ? '✓' : '❌ ' + (r2.error || '')}（共 ${(r2.profiles || []).length} 份）`);

// ⑤ 载入存档
const r3 = await (await fetch(`${BASE}/api/llm-profiles/load`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '__验收存档__' }),
})).json();
say(`载入存档：${r3.ok ? '✓' : '❌ ' + (r3.error || '')}`);

// ⑥ 降级状态接口
const fo = await (await fetch(`${BASE}/api/llm-providers`)).json();
say(`降级状态：level=${fo.fallback?.level} total=${fo.fallback?.total} hold=${fo.fallback?.holdMinutes}分钟 ${fo.fallback?.total >= 2 ? '✓ 有两个级别可降' : '⚠️ 只有一个'}`);

// ⑦ 复位接口
const r4 = await (await fetch(`${BASE}/api/llm-fallback/reset`, { method: 'POST' })).json();
say(`复位：${r4.ok ? '✓' : '❌'}`);

// ⑧ 清理：删存档 + 恢复原来的 providers/activeId
await fetch(`${BASE}/api/llm-profiles/delete`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '__验收存档__' }),
});
await fetch(`${BASE}/api/llm-providers`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ providers: before.providers || [], activeId: before.activeId || '' }),
});
await page.waitForTimeout(1200);
const back = readLlm();
const backOk = (back.providers || []).length === (before.providers || []).length
  && String(back.activeId || '') === String(before.activeId || '')
  && String(back.model || '') === String(before.model || '');
say(`已恢复：providers=${(back.providers || []).length} 个，activeId=${back.activeId || '(无)'}，model=${back.model} ${backOk ? '✓' : '❌'}`);

if (errs.length) say('页面 JS 报错：' + errs.slice(0, 3).join(' | '));
await browser.close();
const all = ui.provList && ui.fallback && ui.pfList && ui.addBtn && r1.ok && flatOk && r2.ok && r3.ok && r4.ok && backOk && !errs.length;
say(all ? '\n结果: 全部通过 ✅' : '\n结果: 有项没过 ❌');
process.exit(all ? 0 : 1);
