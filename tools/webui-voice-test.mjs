// 验「语音设置」板块（2026-10-21）
// ⚠️ 铁律：先存原值 → 测 → 恢复原值
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const ROOT = process.cwd();
const PORT = process.argv[2] || '3099';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const say = (s) => console.log(`[语音页] ${s}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2000);

// ① nav + 切页
const hasTab = await page.evaluate(() => !!document.querySelector('nav button[data-tab="voice"]'));
say('nav 上有「语音」：' + (hasTab ? '✓' : '❌'));
await page.evaluate(() => document.querySelector('nav button[data-tab="voice"]').click());
await page.waitForTimeout(1200);
const vis = await page.evaluate(() => {
  const s = document.getElementById('tab-voice');
  return {
    显示: !!s && !s.classList.contains('hidden'),
    有开关: !!document.getElementById('vc-enable'),
    有戳一戳开关: !!document.getElementById('vc-poke'),
    音色选项数: document.getElementById('vc-ref')?.options?.length || 0,
    状态文字: (document.getElementById('vc-status')?.textContent || '').slice(0, 80),
  };
});
say('板块：' + JSON.stringify(vis));

// ② 存原值
const cfg0 = yaml.load(readFileSync(`${ROOT}/config.yml`, 'utf8')) || {};
const prev = {
  enable: cfg0.voice?.enable !== false,
  pokeVoice: cfg0.voice?.pokeVoice === true,
  ref: String(cfg0.voice?.ref || ''),
};
say('测试前：' + JSON.stringify(prev));

// ③ 改三个值 → 保存
const target = { enable: true, pokeVoice: true, ref: 'saki_ref.wav' };
await page.evaluate((t) => {
  document.getElementById('vc-enable').value = t.enable ? '1' : '0';
  document.getElementById('vc-poke').value = t.pokeVoice ? '1' : '0';
  document.getElementById('vc-ref').value = t.ref;
  document.getElementById('vc-save').click();
}, target);
await page.waitForTimeout(3000);

// ④ 读回核对（直接打接口，比读 yml 更准 —— voice 是按号私有，可能在 accounts/<QQ>.yml）
const back = await (await fetch(`http://127.0.0.1:${PORT}/api/voice`)).json();
const ok = back.cfg.enable === true && back.cfg.pokeVoice === true && back.cfg.ref === 'saki_ref.wav';
say(`存进去了？${ok ? '✓' : '❌'} → ${JSON.stringify(back.cfg)}`);

// ⑤ 恢复原值
await fetch(`http://127.0.0.1:${PORT}/api/voice`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(prev),
});
await page.waitForTimeout(1200);
const after = await (await fetch(`http://127.0.0.1:${PORT}/api/voice`)).json();
const backOk = after.cfg.enable === prev.enable && after.cfg.pokeVoice === prev.pokeVoice && after.cfg.ref === prev.ref;
say(`已恢复：${JSON.stringify(after.cfg)} ${backOk ? '✓' : '❌'}`);

if (errs.length) say('页面 JS 报错：' + errs.slice(0, 3).join(' | '));
await browser.close();
const all = hasTab && vis.显示 && vis.有开关 && vis.有戳一戳开关 && vis.音色选项数 >= 18 && ok && backOk && !errs.length;
say(all ? '\n结果: 全部通过 ✅' : '\n结果: 有项没过 ❌');
process.exit(all ? 0 : 1);
