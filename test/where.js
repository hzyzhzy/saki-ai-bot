/**
 * 「她人在哪 / 正在做什么」状态机（`src/where.js`）回归。
 *
 * ⚠️ 纯离线：不连 NapCat、不花钱、不碰真实 `state/where.json`
 *    （走 `QQBOT_WHERE_FILE` + `test` 配置名两道隔离）。
 *
 * 盯的是用户拍板的那三条：
 *   · **上限 2 小时**（到点自动回落日程 —— 防"卡在某个状态里出不来"）
 *   · **空的不许覆盖**（别把状态写坏）
 *   · **提示词里要说"优先于日程"**（否则她还是会按日程说"我在教室上课"）
 *
 * 用法: node test/where.js
 */
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-where.yml';
const WHERE_REL = 'logs/__test-where-state.json';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

writeFileSync(
  join(ROOT, CFG_REL),
  ['llm:', '  baseURL: http://127.0.0.1:1/v1', '  apiKey: "sk-test"', '  model: t', ''].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_WHERE_FILE = WHERE_REL;

const w = await import('../src/where.js');
w.__clear();

console.log('\n【1】没有覆盖时不占提示词');
{
  check(w.current().active === false, '一开始没有覆盖');
  check(w.hint() === '', '★ 没有覆盖 → 提示词里一个字都不占（不浪费）');
}

console.log('\n【2】★ 覆盖生效，而且提示词里明确"压过日程"');
{
  w.apply({ where: '外面', doing: '找人', source: '测试' });
  const s = w.current();
  check(s.active === true && s.where === '外面', '★ 覆盖生效', JSON.stringify({ where: s.where }));
  const h = w.hint();
  check(/外面/.test(h) && /找人/.test(h), '★ 提示词里带上了位置和在做的事');
  // ★★ 这条是命门：不写"优先于日程"，她还是会按小时算的那份说"我在教室上课"
  check(/优先于/.test(h), '★★ 提示词里写明了**优先于按日程算出来的那个**');
  check(/别再说/.test(h), '★ 而且给了行为指令（别再说跟它对不上的话）');
}

console.log('\n【3】★★ 上限 2 小时：到点自动作废（回落日程）');
{
  const t0 = w.current().since;
  check(w.current(t0 + 60 * 60 * 1000).active === true, '1 小时后还算数');
  check(w.current(t0 + 119 * 60 * 1000).active === true, '1 小时 59 分还算数');
  check(w.current(t0 + 121 * 60 * 1000).active === false, '★★ 超过 2 小时 → 作废');
  check(w.hint(t0 + 121 * 60 * 1000) === '', '★★ 作废之后提示词里也不再提（回到日程）');
  check(w.DEFAULT_KEEP_MINUTES === 120, '默认上限就是 2 小时（用户拍板的）');
}

console.log('\n【4】空的不许覆盖（别把状态写坏）');
{
  w.__clear();
  check(w.apply({}) === false, '空对象 → 不覆盖');
  check(w.apply({ where: '   ', doing: '  ' }) === false, '全是空白 → 不覆盖');
  check(w.current().active === false, '★ 状态没被写坏');
}

console.log('\n【5】后一次覆盖盖掉前一次，并且落盘能重载');
{
  w.__clear();
  w.apply({ where: '地铁口', doing: '找人' });
  w.apply({ where: '家', doing: '回去了' });
  check(w.current().where === '家', '★ 新的覆盖盖掉旧的');
  check(w.current().since > 0 && w.current().until > w.current().since, 'since / until 都对');

  w.reload();
  check(w.current().where === '家' && w.current().doing === '回去了', '★★ 重启（reload）之后还记得');
}

console.log('\n【6】边界：路径 / 隔离');
{
  check(existsSync(join(ROOT, WHERE_REL)), '★ 状态确实写盘了（落盘路径通）');
  check(String(w.path()).includes('__test-where'), '★ 用的是测试状态文件，不是真实那份', w.path());
  check(w.status().keepMinutes === 120, 'status() 也报得出上限');
}

try {
  rmSync(join(ROOT, CFG_REL), { force: true });
  rmSync(join(ROOT, WHERE_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
