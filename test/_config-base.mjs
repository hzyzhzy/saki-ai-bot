/**
 * 测试用的「真实生效的那份配置」—— 2026-10-07 加（多 QQ 号拆分之后）。
 *
 * ## 为什么需要
 *
 * 十几个套件原来都是这么干的：
 *
 * ```js
 * const base = readFileSync(join(ROOT, 'config.yml'), 'utf8');
 * base.replace(/url:\s*ws:\/\/127\.0\.0\.1:\d+/, `url: ws://127.0.0.1:${WS_PORT}`)
 * ```
 *
 * 也就是"把真配置抄一份、把接入点改成自己的假服务"。
 *
 * ⚠️⚠️ 但 2026-10-07 起配置**分了家**：`onebot`（连哪个端口 + token）属于
 *    **每个号私有**，搬进了 `accounts/<主号>.yml`，`config.yml` 里只剩共用的那些。
 *    于是上面那行替换**静默失效**（正则找不到就原样返回，不报错）——
 *    后果是套件会拿着 `config.yml` 里的默认 `ws://127.0.0.1:3001`
 *    去连**真实的协议端**：假服务收不到消息、套件超时或空跑，
 *    最坏的情况是和正在跑的机器人**抢同一条连接**。
 *    （`test/sensitivity.js` 里那句 `if (!parsed.onebot?.url.includes(...)) throw`
 *      是唯一一个会当场炸的，其它套件是**默默跑歪**——更难查。）
 *
 * ## 做法：只把 `onebot` 段补回去，别的字段保持原文
 *
 * 为什么不是"读完整配置再 dump 一遍"：这些套件的替换正则（`respondTo:`、
 * `groupRespondTo:`、`probability:`、`baseURL:`…）都是照着 **config.yml 的原始排版**
 * 写的，整份重排会让其中一些替换悄悄失效 —— 那就从"一个坑"变成"一堆坑"。
 * 所以这里只做一件事：**没有 onebot 段时，把主号私有文件里那段摘出来贴在开头。**
 * 有（老结构）就原样返回，行为跟以前一字不差。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 把一段对象缩进成 YAML 片段（贴到顶层用） */
function indentBlock(obj, pad = '  ') {
  return yaml
    .dump(obj, { lineWidth: 200, noRefs: true })
    .split('\n')
    .filter((l) => l.length)
    .map((l) => pad + l)
    .join('\n');
}

/**
 * 返回**可以直接拿去做正则替换**的配置文本 —— 内容是"这台机器上真实生效的那份配置"。
 *
 * ⚠️ 拆分之后必须**合并**：`config.yml`（共用）+ `accounts/<主号>.yml`（这个号的私有），
 *    否则套件拿到的是"半份配置"——`trigger` / `chat` / `life` / `observe` 全是内置默认值，
 *    断言会莫名其妙地挂在"值不对"上（`test/webui.js`、`test/observe-compress.js` 都这么红过）。
 *
 * ⚠️ 为什么用 `yaml.dump` 重新排版、而不是拼原文：合并之后本来就是一份新文档了。
 *    各套件的替换正则（`url:` / `accessToken:` / `baseURL:` / `respondTo:` /
 *    `probability:` / `groupRespondTo:`）在 dump 出来的标准排版下**照样匹配**
 *    （缩进同为 2 空格、标量该加引号就加引号）。
 */
export function configWithOnebot() {
  let shared;
  try {
    shared = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) ?? {};
  } catch {
    return '';
  }
  let merged = shared;
  try {
    const main = String(shared.mainAccount ?? '').trim();
    if (main) {
      const f = join(ROOT, 'accounts', `${main}.yml`);
      if (existsSync(f)) merged = { ...shared, ...(yaml.load(readFileSync(f, 'utf8')) ?? {}) };
    }
  } catch {
    merged = shared; // 私有文件读坏了就退回共用那份，别把套件直接弄崩
  }
  // ⚠️⚠️ `mainAccount` 必须换成一个**不存在的占位号**（2026-10-07 加）：
  //    换掉之前，套件起的进程会拿真实主号去 `accounts.read()` —— 单跑套件时
  //    （没有 `run-all` 那层 `QQBOT_ACCOUNTS_DIR` 隔离）就会读到**真实的账号配置**
  //    （里面有协议端 token、真实群号），而且"私有段写账号文件"那条路会把
  //    测试数据写进真实文件。换成占位号之后：`accounts.has()` 为假 ⇒
  //    一切都退回"老的单号行为"，读的只有套件自己生成的临时配置。
  if (merged.mainAccount) merged.mainAccount = '10000000';
  return yaml.dump(merged, { lineWidth: 200, noRefs: true });
}

/**
 * ⚠️ 副作用（**在 import 本模块时就执行**）：把这个**测试进程自己**的
 * `QQBOT_CONFIG` 也指到"合并后"的那一份临时配置。
 *
 * 为什么需要（2026-10-07 踩到）：有些套件会在**测试进程里**直接
 * `await import('../src/life.js')` 然后断言 `config` 里的东西
 * （`test/webui.js` 的「1 档群 = 进事件系统」就是）。而拆分之后
 * `trigger.groupRespondTo` 搬到了 `accounts/<主号>.yml` ——
 * 测试进程读的是 `config.yml`，那份里**没有**它 ⇒ 断言拿到默认值、莫名红。
 *
 * ⚠️ 必须在**本模块顶层**做：`config.js` 的 `CONFIG_FILE` 是**模块加载时**算的，
 *    晚一步设就没用了（这也是为什么不用"在 main() 里设"）。
 * ⚠️ 名字带 `__test-` ⇒ `cleanup.js` 的规则会顺手收掉它。
 */
export const MERGED_CONFIG_FILE = (() => {
  try {
    const rel = `logs/__test-configbase-${process.pid}.yml`;
    writeFileSync(join(ROOT, rel), configWithOnebot(), 'utf8');
    // ⚠️ **只在没设的时候才指过去**：让 `QQBOT_CONFIG=xxx node test/xxx.js`
    //    这种"显式指定配置"的用法仍然说了算（那是有意为之的调试手段）。
    if (!process.env.QQBOT_CONFIG) process.env.QQBOT_CONFIG = rel;
    return rel;
  } catch {
    return '';
  }
})();
