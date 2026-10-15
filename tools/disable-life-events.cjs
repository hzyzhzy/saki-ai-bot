#!/usr/bin/env node
/**
 * 一次性：**把「日常事件」（随机事件）全部改成关闭**（2026-10-15 用户要求）。
 *
 * 用户原话：「把随机事件默认开关设为关闭，但是**不要修改我现在的设置**，
 *   然后**下次推上的要把别人的随机事件开关关闭**」
 *   →「**如果别人已经配置过，也要把配置全部改成关闭**」
 *
 * ## 什么时候用它
 *
 * 拉到这个版本、而且**以前配过日常事件**的人，跑一次就行（没配过的不用跑 ——
 * 内置默认已经是关的了 ✓）：
 *
 * ```powershell
 * node tools/disable-life-events.cjs
 * ```
 *
 * ## 它改什么
 *
 * ① `config.yml` 的**顶层** `life.enable`（老配置）
 * ② `config.yml` 里每个群的 `groupParams.<群>.life.enable`
 * ③ `accounts/*.yml` 的顶层 `life.enable` + 每个群的 `groupParams.<群>.life.enable`
 *
 * ## ⚠️ 两件必须知道的事
 *
 * 1. **它用 YAML 库解析再 dump 回去** ⇒ 文件会被**重排**（注释、空行、顺序可能变）。
 *    ⇒ 所以**每个文件都先备份**成 `<文件>.bak-<时间戳>-关日常事件` ✓
 *    （⚠️ 我第一版是纯文本改行的，想着"保住注释"—— 结果在账号文件上**漏改了**
 *      `groupParams.<群>.life.enable`（实测抓到的）✗ ⇒ 宁可重排，也要改对 ✓）
 * 2. **`quest`（二级剧情）不受影响** —— 那是另一套开关，这里一个字不碰 ✓
 *
 * ## 改完怎么开回来
 *
 * 管理界面「日常事件」页打开那个群，或者手改 `groupParams.<群>.life.enable: true` ✓
 */
const { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const yaml = require('js-yaml');

// ⚠️ 可以传一个目录当第一个参数（隔离测试用：在临时目录里造份假配置跑，不碰真配置）✓
const ROOT = process.argv[2] ? resolve(process.argv[2]) : join(__dirname, '..');

/** 把一份已解析的配置里所有 `life.enable` 改成 false；返回改了几处 */
function killLife(cfg) {
  let n = 0;
  const one = (obj) => {
    if (!obj || typeof obj !== 'object') return 0;
    let c = 0;
    if (obj.life && typeof obj.life === 'object' && obj.life.enable !== false) {
      obj.life.enable = false;
      c++;
    }
    return c;
  };
  n += one(cfg);
  const gp = cfg.groupParams;
  if (gp && typeof gp === 'object') {
    for (const g of Object.keys(gp)) n += one(gp[g]);
  }
  return n;
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:T]/g, '')
  .slice(0, 14);

const targets = ['config.yml', 'config.example.yml'];
const accDir = join(ROOT, 'accounts');
if (existsSync(accDir)) {
  for (const f of readdirSync(accDir)) if (f.endsWith('.yml')) targets.push(join('accounts', f));
}

let files = 0;
let total = 0;
for (const rel of targets) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  let cfg = null;
  try {
    cfg = yaml.load(readFileSync(p, 'utf8'));
  } catch (e) {
    console.log(`${rel}: ⚠️ YAML 解析失败，跳过（${e.message}）`);
    continue;
  }
  if (!cfg || typeof cfg !== 'object') {
    console.log(`${rel}: 不像配置，跳过`);
    continue;
  }
  const n = killLife(cfg);
  if (!n) {
    console.log(`${rel}: 日常事件本来就是关的（没动）`);
    continue;
  }
  copyFileSync(p, `${p}.bak-${stamp}-关日常事件`);
  writeFileSync(p, yaml.dump(cfg, { lineWidth: 200, noRefs: true }), 'utf8');
  files++;
  total += n;
  console.log(`${rel}: 关掉 ${n} 处 ✓（备份 ${rel}.bak-${stamp}-关日常事件）`);
}

console.log(
  `\n共改了 ${files} 个文件 / ${total} 处。` +
    `\n⚠️ 想让某个群继续跑日常事件：管理界面「日常事件」页把那个群打开，` +
    `或手改 \`groupParams.<群>.life.enable: true\` ✓`,
);
