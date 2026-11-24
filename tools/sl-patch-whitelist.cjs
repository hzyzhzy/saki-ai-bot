/**
 * 给 SnowLuma v2.x 打「UIN 白名单 — 事后卸载」补丁
 *
 * ## 和 v1 那版补丁的关系
 * v1 的 `_patch-uin-whitelist.cjs` 匹配的是：
 *     notifySessionsChanged() { ... errMsg$1(err) ... }
 * v2.4.2 里那个函数还在、结构几乎一样，**只是 `errMsg$1` 改名成了 `errorMessage`** ✓
 * ⇒ 这个脚本按 v2 的原文匹配，逻辑和 v1 那版一致（不改行为）。
 *
 * ## 做了什么
 * 往 `notifySessionsChanged()` 末尾挂一次 `enforceUinWhitelist()`：
 *   · 环境变量 `SNOWLUMA_UIN_WHITELIST=10000002,10000013,10000014` 里的号才保留注入
 *   · 别的号（比如用户自己日常用的 10000001）⇒ **自动 unload**（QQ 进程不动）
 *   · 不设环境变量 = 完全不生效（老行为一个字都不变）✓
 *
 * ⚠️⚠️ **这个补丁只做"事后卸载"** —— v2 把 v1 的「注入前探测」（`probeQqLoginInfo`，
 *    走 QQ 本地 ptlogin 端口 4301~4310 先问是哪个号）**整个删掉了** ✗
 *    ⇒ 所以 v2 上是"先注入、发现不是白名单号再卸"。而 v1 里之所以加"注入前探测"，
 *      正是因为**事后 unload 经常卸不干净**（`pipe still up`，见 v1 index.mjs 里那段注释）。
 *    ⇒ 真要上 v2，这条得单独重做（见 TODO）。
 *
 * ## 用法
 *     node tools\sl-patch-whitelist.cjs C:\Temp\sl2\extracted\index.mjs
 *     （不给路径就默认 C:\SnowLuma\index.mjs）
 *
 * ## 回滚
 * 脚本自己会先备份成 `<原文件>.bak-wl前-<时间>`，改坏了拷回去即可。
 */
const fs = require('node:fs');
const path = require('node:path');

const P = process.argv[2] || path.join('C:', 'SnowLuma', 'index.mjs');

if (!fs.existsSync(P)) {
  console.error('❌ 文件不存在:', P);
  process.exit(1);
}

let s = fs.readFileSync(P, 'utf8');

if (s.includes('enforceUinWhitelist')) {
  console.log('已经打过这个补丁了，跳过 ✓');
  process.exit(0);
}

// v2 的原文（注意 errMsg$1 → errorMessage）
const OLD_V2 = [
  '\tnotifySessionsChanged() {',
  '\t\tif (this.disposed) return;',
  '\t\tif (!this.onSessionsChangedRaw) return;',
  '\t\ttry {',
  '\t\t\tthis.onSessionsChangedRaw();',
  '\t\t} catch (err) {',
  '\t\t\tthis.log.warn("onSessionsChanged threw: %s", errorMessage(err));',
  '\t\t}',
  '\t}',
].join('\n');

// v1 的原文（兼容老版本，errMsg$1）
const OLD_V1 = OLD_V2.replace('errorMessage(err)', 'errMsg$1(err)');

const useV2 = s.includes(OLD_V2);
const useV1 = !useV2 && s.includes(OLD_V1);

if (!useV2 && !useV1) {
  console.error('❌ 两个版本的 notifySessionsChanged 原文都没匹配到，文件未改');
  console.error('   说明这个 SL 版本的代码又变了 —— 先看 index.mjs 里 notifySessionsChanged 的实际写法再改脚本');
  process.exit(1);
}
const ERR_FN = useV2 ? 'errorMessage' : 'errMsg$1';
console.log('匹配到 %s 版原文 ⇒ 用 %s 作为错误格式化函数', useV2 ? 'v2' : 'v1', ERR_FN);

const NEW = [
  '\tnotifySessionsChanged() {',
  '\t\tif (this.disposed) return;',
  '\t\tif (this.onSessionsChangedRaw) {',
  '\t\t\ttry {',
  '\t\t\t\tthis.onSessionsChangedRaw();',
  '\t\t\t} catch (err) {',
  `\t\t\t\tthis.log.warn("onSessionsChanged threw: %s", ${ERR_FN}(err));`,
  '\t\t\t}',
  '\t\t}',
  '\t\tthis.enforceUinWhitelist();',
  '\t}',
  '\t/**',
  '\t * 「UIN 白名单」：不在名单里的号，注入后**自动卸载**（QQ 进程不动）。',
  '\t *   环境变量 SNOWLUMA_UIN_WHITELIST=10000002,10000013,10000014',
  '\t *   不设 = 完全不生效（老行为）',
  '\t *   ⚠️ 这是**事后**卸载 —— v2 没有 v1 那个"注入前探测"，所以非白名单号会先被注入一下。',
  '\t */',
  '\tenforceUinWhitelist() {',
  '\t\ttry {',
  '\t\t\tif (this.__wl === undefined) {',
  '\t\t\t\tthis.__wl = String(process.env.SNOWLUMA_UIN_WHITELIST || "")',
  '\t\t\t\t\t.split(",")',
  '\t\t\t\t\t.map((x) => x.trim())',
  '\t\t\t\t\t.filter(Boolean);',
  '\t\t\t\tif (this.__wl.length) {',
  '\t\t\t\t\tthis.log.info("[UIN白名单] 已启用，只保留: %s", this.__wl.join(","));',
  '\t\t\t\t}',
  '\t\t\t}',
  '\t\t\tif (!this.__wl.length) return;',
  '\t\t\tconst now = Date.now();',
  '\t\t\tfor (const ss of this.sessions.values()) {',
  '\t\t\t\tconst u = String(ss.uin || "");',
  '\t\t\t\tif (!u || u === "0" || this.__wl.includes(u)) continue;',
  '\t\t\t\tif (ss.__wlTried && now - ss.__wlTried < 60000) continue;',
  '\t\t\t\tss.__wlTried = now;',
  '\t\t\t\tthis.log.warn("[UIN白名单] 号 %s (PID=%d) 不在白名单 ⇒ 自动卸载注入（QQ 进程不动）", u, ss.pid);',
  '\t\t\t\tPromise.resolve(ss.unload()).catch(() => {});',
  '\t\t\t}',
  '\t\t} catch (e) {',
  `\t\t\tthis.log.warn("enforceUinWhitelist 出错（忽略）: %s", ${ERR_FN}(e));`,
  '\t\t}',
  '\t}',
].join('\n');

// 备份
const stamp = new Date()
  .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
  .replace(/[-: ]/g, '')
  .slice(0, 13);
const bak = P + '.bak-wl前-' + stamp;
fs.copyFileSync(P, bak);
console.log('已备份:', bak);

s = s.replace(useV2 ? OLD_V2 : OLD_V1, NEW);
fs.writeFileSync(P, s, 'utf8');
console.log('✅ 已插入 enforceUinWhitelist（事后卸载）到', P);
