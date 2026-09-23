/**
 * 「她到底看没看到那张图」—— 识图（vision）的两条不变量。
 *
 * ## 这个套件是为什么建的（2026-09-23）
 *
 * 用户截图问：**「这个机器人识别到图片了吗，按道理 @ 她应该会读一遍图片的」**
 *
 * 现场（`logs/bot.log`，群 200000001）：
 * ```
 * [13:34:24] [收到] <主人>：[图片/表情]        ← 图是**单独一条**消息（没文字、没 @，处理不了）
 * [13:34:29] [收到] <主人>：你能分清吗         ← 5 秒后才 @ 她
 * [13:34:30] [群200000001] at <- 你能分清吗  ← 只处理了这一条
 * ```
 * 她的回复「怎么，考我能不能分清真假学姐啊」里**没提图里任何内容** —— 没看图。
 *
 * **两条路同时断了**：
 *   ① 捡缓存 —— 那张图**从来没被识别过**，缓存里没有 ✗
 *   ② 补识别 —— 判据是 `/(这|那|它|上面|刚才?|刚发|前面|图|照片|图片|看|像|样|什么意思|什么梗)/`，
 *      而「你能分清吗」**一个词都没命中**（"分清"不在表里）⇒ 连识图都不做 ✗
 *
 * ⚠️ 而 `bot.js` 那段注释**自己就写过**「启发式判据靠不住，第一版就漏了它」——
 *    这是被同一个坑咬的第二口。所以修法是**不再靠指代词表**：
 *    **上下文里有刚发过的图（`cands` 非空）就识别。**
 *
 * ✅ 敢放宽的成本边界（硬的）：**每张图至多识别一次** —— 识别完进 `visionCache`，
 *    之后所有消息都走"捡缓存"（零成本）。识图用便宜的 flash 模型。
 *
 * 用法: node test/vision.js
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const bot = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');

console.log('\n【1】★★★ 补识图的判据**不许再依赖指代词表**（"你能分清吗"就是一个都没命中）');
{
  check(/const refersBack = cands\.length > 0;/.test(bot), '★ 判据 = 上下文里有刚发过的图就识别');
  check(
    !/const refersBack = \/\(这\|那\|它\|上面/.test(bot),
    '★★ 那个只认指代词的正则**已经不在了**（它是这次漏看的直接原因）',
  );
  check(
    /cands\.length > 0[\s\S]{0,120}?if \(refersBack\)/.test(bot),
    '★ 判据仍然守在那个"没缓存才补做"的分支里（不是无条件每句都识别）',
  );
}

console.log('\n【2】★★ 先捡缓存、再补识别（零成本那条路必须在前面）');
{
  const iCache = bot.indexOf('cachedDescriptions(cands.map');
  const iReal = bot.indexOf('describeImagesByFile(');
  check(iCache > 0 && iReal > 0 && iCache < iReal, '★ 捡缓存（不要钱）在真的识图（要钱）之前');
  check(
    /if \(!vision\) \{\s*\n\s*const cached = visionCache\.cachedDescriptions/.test(bot),
    '★ 而且已经有 `vision` 了就不再重复捡/识别',
  );
}

console.log('\n【3】★★ 成本边界必须写在注释里（这是敢放宽判据的前提，别被后人删掉）');
{
  check(/每张图至多识别一次/.test(bot), '★ 注释里写明了「每张图至多识别一次」');
  check(/识别完就进 `?visionCache`?/.test(bot) || /识别完就进 visionCache/.test(bot),
    '★ 并说明了为什么：进缓存后走零成本那条路');
}

console.log('\n【4】★★ 补识别要有料可用 —— `recent` 必须存下图片的 file 标识');
{
  const recent = readFileSync(join(ROOT, 'src', 'recent.js'), 'utf8');
  check(/imageFiles/.test(recent), '★ `recent.js` 存了 `imageFiles`（不然"补识别"没图可看）');
  check(
    /recentImages\s*\(/.test(recent) || /export function recentImages/.test(recent),
    '★ 有 `recentImages()` 供 `bot.js` 取"最近刚发过的图"',
  );
}

console.log('\n【5】★ 识图失败不许把主流程带崩（也不许把错误码发给群友）');
{
  const vision = readFileSync(join(ROOT, 'src', 'vision.js'), 'utf8');
  check(/识图失败 HTTP/.test(vision), '★ 失败会打日志（`识图失败 HTTP …`）—— 排查时要能看到');
  check(/识图跳过/.test(vision), '★ 跳过也打日志（`识图跳过：…`）—— "她为什么没看图"要能一眼查');
  check(!/return[^\n]*response\.status/.test(vision), '★ 不会把 HTTP 状态码当描述返回给上层');
}

console.log('\n【6】★★★ 取图必须能吃不一定是"本地路径"的返回值（换协议端的回归）');
{
  // ⚠️⚠️ 2026-09-23 实测：`get_image` 在 **SnowLuma** 下返回的是 **http(s) URL**
  //    （`https://multimedia.nt.qq.com.cn/…`），而老代码 `readFileSync(p)` 一把梭 ⇒
  //    `ENOENT … open '…\qq-ai-bot\https:\multimedia.nt.qq.com.c…'` ⇒
  //    **识图从来没成功过一次**（用户报了三次「她看不到图」才挖到）。
  //    NapCat 返回本地路径 ⇒ 这条回归是**换协议端**时引进来的。
  const vc = readFileSync(join(ROOT, 'src', 'vision-cache.js'), 'utf8');
  check(/async function loadImageBytes/.test(vc), '★ 取图走 `loadImageBytes()` 按形态分派');
  check(/\^https\?:\\\/\\\//.test(vc) && /await fetch\(s,/.test(vc), '★★ http(s) 的图片要去**下载**，不是当路径读');
  check(/fileURLToPath/.test(vc), '★ `file://` 要转成本地路径');
  check(/base64:\/\//.test(vc) && /Buffer\.from\(b64, 'base64'\)/.test(vc), '★ `base64://` / `data:` 要解码');
  check(/return readFileSync\(s\);/.test(vc), '★ 本地路径照旧直接读（NapCat 那条路不能弄坏）');
  check(/r\?\.data\?\.url \?\? r\?\.url/.test(vc), '★ 兜底也认 `url` 字段（有的实现只给 url）');
  check(
    /log\.warn\(`取图失败/.test(vc),
    '★★ 取图失败必须是 **warn** —— 原来记 `debug`，`logLevel: info` 下**完全看不到**，"她为什么看不到图"就这样藏了两周',
  );

  // ⚠️⚠️ 上面都是源码断言，**不算验证**。下面真跑一遍四种形态：
  //    这条根因（URL 被当路径读）必须端到端验过，不然就是又一次空转。
  const { createServer } = await import('node:http');
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  // ⚠️ Windows 上 ESM 的动态 import 只认 file:// URL（直接给 `C:\…` 会报
  //    ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'）。
  const vcMod = await import(pathToFileURL(join(ROOT, 'src', 'vision-cache.js')).href);

  // 一张最小的真 PNG（1×1 透明）—— 不用真图，只要字节能取回来
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  const tmp = mkdtempSync(join(tmpdir(), 'vision-'));
  const localFile = join(tmp, 'x.png');
  writeFileSync(localFile, PNG);

  // ① http(s) URL —— **就是 SnowLuma 那条路**（NapCat 下拿不到的形态）
  const srv = createServer((_q, r) => {
    r.writeHead(200, { 'Content-Type': 'image/png' });
    r.end(PNG);
  });
  await new Promise((res) => srv.listen(0, '203.0.113.10', res));
  const url = `http://203.0.113.10:${srv.address().port}/x.png`;
  const gotUrl = await vcMod.loadImageBytes(url);
  check(
    Buffer.isBuffer(gotUrl) && gotUrl.equals(PNG),
    '★★★ http(s) URL 能**下载**成图片字节（换协议端后 `get_image` 返回的就是这个）',
    `拿到 ${gotUrl?.length ?? 0} 字节`,
  );
  srv.close();

  // ② file:// URL
  const gotFileUrl = await vcMod.loadImageBytes(pathToFileURL(localFile).href);
  check(Buffer.isBuffer(gotFileUrl) && gotFileUrl.equals(PNG), '★ `file://` 能取到');

  // ③ data: URL / base64://
  const gotData = await vcMod.loadImageBytes(`data:image/png;base64,${PNG.toString('base64')}`);
  check(Buffer.isBuffer(gotData) && gotData.equals(PNG), '★ `data:` 能解码');
  const gotB64 = await vcMod.loadImageBytes(`base64://${PNG.toString('base64')}`);
  check(Buffer.isBuffer(gotB64) && gotB64.equals(PNG), '★ `base64://` 能解码');

  // ④ 本地路径 —— **NapCat 那条路，不能弄坏**
  const gotLocal = await vcMod.loadImageBytes(localFile);
  check(Buffer.isBuffer(gotLocal) && gotLocal.equals(PNG), '★★ 本地路径照旧能读（NapCat 不被牺牲）');

  // ⑤ 坏输入不许抛给上层（要 return null 而不是崩）
  check((await vcMod.loadImageBytes('')) === null, '★ 空值返回 null，不抛');
  let threw = false;
  try {
    await vcMod.loadImageBytes(join(tmp, '不存在.png'));
  } catch {
    threw = true;
  }
  check(threw, '（记录现状：路径不存在时会抛，由 `fetchImage` 的 try/catch 兜住）');
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
