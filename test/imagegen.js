/**
 * 生图（群里让她「拍个照」）的测试 —— 2026-09-22。
 *
 * ⚠️ **全程离线 + 假生图服务器，不联网、不花钱**（真出图约 0.2 元/张）。
 *
 * 这个套件盯的是四件最容易翻车的事：
 *
 *   ① **标记不许泄露到群里** —— `[拍照:…]` 的场景里**可以带空格和一整句话**，
 *      和 `[表情:xx]` 那种"一个词"完全不同；漏剥就是群里出现一行
 *      `[拍照:夜里站在便利店门口自拍]`（用户对这个零容忍，已经为表情踩过一次）。
 *   ② **失败必须说人话** —— 用户 2026-09-22 原话：
 *      「如果花光了机器人要直接说不想拍照，而不是暴露故障码」。
 *      所以这里有一条**正则级**的断言：话术里不许出现数字、`HTTP`、`code`。
 *   ③ **换服务商只改配置** —— `ark`（火山方舟）和 `openai`（硅基流动等）
 *      请求形状不同（`image` 数组 vs 字符串、`size` vs `image_size`、
 *      水印开关一个是 body 一个是请求头），换一家不许改功能代码。
 *   ④ **接线不能错** —— 生图绝不能 `await`（要 10~30 秒，会把回复流卡死），
 *      但 `sendChunk` 的返回值又必须**非 null**（否则触发"空响应重试"→ 她回两遍）。
 *      这两个是互相拉扯的，所以用源码断言钉死。
 *
 * 用法: node test/imagegen.js
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

/** 一张真的 1×1 PNG（假服务器和假参考图都用它；内容无所谓，够 `toDataUrl` 读就行） */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// ── 隔离：临时配置 + 临时"相册"目录（别碰用户的 library/photo）──
const CFG_REL = 'logs/__test-imagegen.yml';
const PHOTO_REL = 'logs/__test-photo';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://203.0.113.10:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'imagegen:',
    '  enable: true',
    '  provider: ark',
    '  apiKey: "sk-test-image"',
    '  model: test-image-model',
    '  size: "1024x1024"',
    '  timeoutMs: 5000',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_PHOTO_DIR = PHOTO_REL;

// ⚠️ 参考图：真的建一个小文件（`toDataUrl` 要读它）
mkdirSync(join(ROOT, PHOTO_REL), { recursive: true });
const REF = join(ROOT, PHOTO_REL, 'ref.png');
writeFileSync(REF, Buffer.from(PNG_B64, 'base64'));

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// ── 假生图服务 ────────────────────────────────────────
let lastReq = null; // { path, headers, body }
let inFlight = 0;
let peak = 0;
let mode = 'ok'; // ok | credit | reject | busy | server | auth | hang | badjson | noimage
let served = 0;

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    // 生成图的下载地址（Ark 回的是 URL，imagegen 会去把它拉下来）
    if (req.url === '/img.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(Buffer.from(PNG_B64, 'base64'));
    }
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      /* 故意留空：下面按 mode 决定怎么回 */
    }
    lastReq = { path: req.url, headers: req.headers, body };

    const done = (code, obj) => {
      inFlight -= 1;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (mode === 'hang') return; // 故意不回 → 触发客户端超时
    await new Promise((r) => setTimeout(r, 120)); // 留出窗口：并发能被观察到
    if (mode === 'credit') return done(402, { error: { message: 'Insufficient Balance' } });
    if (mode === 'reject') return done(400, { error: { message: 'content policy: sensitive' } });
    // ⚠️ 这是**实测真踩到的**原样响应（2026-09-22）：火山方舟对没在控制台开通的模型
    //    回 404 + `ModelNotOpen`（不是 4xx 参数错，也不是 5xx，所以很容易被归错类）
    if (mode === 'notopen') {
      return done(404, {
        error: {
          code: 'ModelNotOpen',
          message:
            'Your account 2132307030 has not activated the model doubao-seedream-4-0-250828. ' +
            'Please activate the model service in the Ark Console.',
        },
      });
    }
    // ⚠️ 这也是**实测真踩到的**原样响应（2026-09-22）：用户开通模型之后**还是失败**，
    //    真因是「安心体验模式」的用量上限到了、平台把服务暂停了。
    //    ⚠️ 它是 **HTTP 429** —— 只按状态码判就会归成 `busy`（限流），
    //    于是既会白重试一次，又会跟群里说"重来一张"，而用户永远不知道该去关那个开关。
    if (mode === 'limit') {
      return done(429, {
        error: {
          code: 'SetLimitExceeded',
          message:
            'Your account [2132307030] has reached the set usage limit for the ' +
            '[doubao-seedream-5-0-flash] model, and the model service has been paused. ' +
            'To continue using this model, please visit the Model Activation page to adjust ' +
            'or close the "Safe Experience Mode".',
        },
      });
    }
    if (mode === 'busy') return done(429, { message: 'rate limit reached' });
    if (mode === 'server') return done(500, { message: 'internal error' });
    if (mode === 'auth') return done(401, { message: 'invalid api key' });
    if (mode === 'noimage') return done(200, { data: [] });
    if (mode === 'badjson') {
      inFlight -= 1;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('这不是 JSON');
    }
    served += 1;
    done(200, { data: [{ url: `http://203.0.113.10:${server.address().port}/img.png` }] });
  });
});
await new Promise((r) => server.listen(0, '203.0.113.10', r));
const PORT = server.address().port;

const config = (await import('../src/config.js')).config;
const faces = await import('../src/faces.js');
const imagegen = await import('../src/imagegen.js');
const { pickPhoto, stripMarkers } = faces;

/** 把配置指到假服务器 */
function useFake(over = {}) {
  Object.assign(config.imagegen, {
    enable: true,
    provider: 'ark',
    baseURL: `http://203.0.113.10:${PORT}`,
    apiKey: 'sk-test-image',
    model: 'test-image-model',
    size: '1024x1024',
    timeoutMs: 5000,
    watermark: false,
    ...over,
  });
}

// ═══════════════════════════════════════════════════════
console.log('\n【1】★ 标记解析：场景**可以是一整句**（和 `[表情:xx]` 完全不同）');
{
  const a = pickPhoto('行，等我一下。[拍照:夜里站在便利店门口，举着手机自拍]');
  check(a && a.scene === '夜里站在便利店门口，举着手机自拍', '带空格和逗号的整句场景能取全', a?.scene);

  const b = pickPhoto('[拍照:在教室里写作业]');
  check(b && b.scene === '在教室里写作业', '紧凑写法也能取到');

  // ⚠️ 这条是本次最容易漏的：`pickMarkers` 的 `[^\]\s]+` 会在第一个空格处截断
  const c = pickPhoto('[拍照:穿着校服 站在天台上 傍晚]');
  check(c && c.scene === '穿着校服 站在天台上 傍晚', '★ 场景里有空格时**不被截断**', JSON.stringify(c?.scene));

  check(pickPhoto('今天天气不错') === null, '没有标记 → null');
  // ⚠️ 2026-09-22 改：**裸标记是合法的** —— 用户要求「这些要先经过 llm 理解需要拍什么
  //    照片得出」，所以允许她只写 `[拍照]`，"拍什么"交给那次单独的理解。
  const bare = pickPhoto('行，等我一下。[拍照]');
  check(bare?.withSelf === true && bare?.scene === '', '★ 裸 `[拍照]` 合法：scene 为空，内容交给"理解"那一步');
  const bareScene = pickPhoto('[拍]');
  check(bareScene?.withSelf === false && bareScene?.scene === '', '★ 裸 `[拍]` 同样是合法的');
  check(pickPhoto('[拍照:   ]')?.withSelf === true, '只给空白的冒号写法 = 等同于裸标记（不是 null）');
  check(pickPhoto('[拍照:甲][拍照:乙]').scene === '甲', '一条里有两个标记 → **只取第一个**（别连拍）');

  // ⚠️ 2026-09-22 加：**两种标记**，区别是"画面里有没有她"（决定带不带参考图）
  const self = pickPhoto('[拍照:我在教室里自拍]');
  const sceneOnly = pickPhoto('[拍:月之森学园的正门，白天下过雨]');
  check(self?.withSelf === true, '`[拍照:…]` → withSelf=true（画面里有她 ⇒ 要带参考图）');
  check(sceneOnly?.withSelf === false, '★ `[拍:…]` → withSelf=false（她拍的东西 ⇒ **不带**参考图）');
  check(sceneOnly?.scene === '月之森学园的正门，白天下过雨', '★ 拍景物那条也能取全整句', sceneOnly?.scene);
  // ⚠️ 交替顺序的坑：`拍照` 必须排在 `拍` 前面，否则 `[拍照:x]` 会被切成 `[拍:照:x]`
  check(self?.scene === '我在教室里自拍', '★★ `[拍照:x]` 不会被误切成 `[拍:照:x]`', self?.scene);
  const mixed = pickPhoto('[拍:校门][拍照:我站在校门口]');
  check(mixed?.withSelf === false && mixed?.scene === '校门', '两种同时出现 → 取**先出现的**那个');
}

console.log('\n【2】★ 标记剥离：绝不能露到群里');
{
  check(!stripMarkers('[拍照:夜里便利店门口自拍]').includes('拍照'), '短场景被剥掉');
  const long = stripMarkers('行，等我一下。[拍照:穿着校服 站在天台上 傍晚的风很大]');
  check(!long.includes('拍照') && !long.includes('['), '★ 带空格的长场景也被剥干净', JSON.stringify(long));
  check(long.trim() === '行，等我一下。', '剥完正文还在（别把整条吃掉出错了）');
  // ⚠️ 漏剥这一种 = 群里直接出现一行 `[拍:月之森校门]`
  check(!stripMarkers('[拍:月之森学园的正门，下午的光]').includes('拍'), '★ `[拍:…]` 也要剥干净');
  // ⚠️⚠️ 2026-09-22 实测**漏进群里了**（用户截图：她回了「又拍啊 [拍照] 行…」）——
  //    原因：剥离规则的冒号是**必需**的，而裸标记没有冒号。
  //    ⇒ 解析端支持裸标记，剥离端**必须同步**支持，这两处是一对。
  check(!stripMarkers('又拍啊 [拍照] 行，今天不上学').includes('['), '★★ 裸 `[拍照]` 也要剥（漏过一次，真发到群里了）');
  check(!stripMarkers('喏 [拍]').includes('['), '★★ 裸 `[拍]` 同样要剥');
  // ⚠️ 剥完**不能留双空格**（2026-09-22 用户截图问「这个突兀的空格是bug吗」）：
  //    「还拍啊 [拍照] 行，…」剥完原来是「还拍啊  行，…」——
  //    标记两边的空格都留下来了。标记是独立写的 ⇒ 那里本来就是断句处 ⇒ 收成一个「，」。
  check(
    stripMarkers('还拍啊 [拍照] 行，今天都成你专属模特了') === '还拍啊，行，今天都成你专属模特了',
    '★★ 剥完不留双空格 —— 断句处补「，」',
    JSON.stringify(stripMarkers('还拍啊 [拍照] 行，今天都成你专属模特了')),
  );
  check(!/[ \t]{2,}/.test(stripMarkers('去 [拍] 好')), '★ 不会留下连续空格');
  check(stripMarkers('行吧。[表情:爆炸]') === '行吧。', '★ 标记紧贴文字时照旧只删标记（不画蛇添足加逗号）');
  // 别误伤：这两个不是标记
  check(stripMarkers('他在拍手').includes('拍手') && stripMarkers('[拍卖]开始了').includes('拍卖'), '不误伤「拍手」/「拍卖」这种普通词');

  // 回归：表情那套不能被这次改动弄坏
  check(stripMarkers('行吧。[表情:爆炸]') === '行吧。', '回归：`[表情:xx]` 照旧剥掉');
  // ⚠️ 这两个是**类别名**不是表情库里的名字 —— 2026-09-19 用户截图（群里出现字面
  //    `[表情包]`）之后定的规矩：**一律剥掉**。别照着 `faces.js` 里那句旧注释改成"留着"。
  check(stripMarkers('这是[图片]和[表情包]') === '这是和', '回归：`[图片]`/`[表情包]` 这些类别名也剥掉');
}

console.log('\n【2b】★ 提示词**两层**：现算的（画面/时间/地点）+ 固定画风（config 可改）');
{
  const self = imagegen.buildPrompt({ what: '站在便利店门口自拍', withSelf: true, time: '晚上', place: '便利店门口' });
  const sceneOnly = imagegen.buildPrompt({ what: '一所学校的白色大门，雨后地面反光', withSelf: false });
  check(self.startsWith('站在便利店门口自拍。'), '画面排在最前面', self.slice(0, 16));
  check(/晚上，便利店门口。/.test(self), '★ 时间地点接在画面后面（这两样是**现算的**一层）');
  check(!/。。/.test(self) && !/。，/.test(self), '标点不会拼坏');
  check(imagegen.buildPrompt({ what: '', withSelf: true }) === '', '没有画面 → 空串（不许拿空提示词去烧钱）');

  // ① 有她 —— 用户原话：「人物保持二次元形态，但是周围环境写实」
  check(/二维动画|动漫/.test(self) && /动画线稿/.test(self), '① 人物那半边明确写"二维动画角色"');
  check(
    /写实/.test(self) && /真实材质|真实光影/.test(self),
    '★★ ① 环境那半边明确写"写实/真实照片" —— 不这么写，整张图会被参考立绘拉成动漫，写实的好处全丢',
  );

  // ② 没她 —— 「让祥子拍一张月之森校门的照片就不是自拍，写实的好处就体现出来了」
  check(!/赛璐璐|动画线稿/.test(sceneOnly), '★ ② 拍景物那条**不该**再提二次元人物画风');
  check(/写实/.test(sceneOnly) && /真实照片/.test(sceneOnly), '② 整张是写实照片');
  // ⚠️⚠️ 那条路**不带参考图**，模型不知道"你"是谁 ⇒ 写了"你"它就会**凭空画一个人**
  //    （实测：要"学校正门"，出来一张真人女性特写）。所以必须无人称 + 明说没人。
  check(!/你/.test(sceneOnly), '★★ ② 全段**不许出现"你"**（否则模型会凭空画一个人出来）');
  check(/画面里没有人/.test(sceneOnly), '★ ② 明说"画面里没有人"（Seedream 没有负面提示词字段，否定只能内联写）');

  // ③ 随手拍感（网上那套「刻意的不完美」公式）
  for (const [name, p] of [
    ['① 有她', self],
    ['② 拍景物', sceneOnly],
  ]) {
    check(/随手/.test(p), `${name}：写了"随手拍"`);
    check(/噪点/.test(p), `${name}：写了自然噪点 —— 这是真实感的引擎（比堆"8K"有用）`);
    check(/滤镜|美颜/.test(p), `${name}：内联否定，禁止滤镜/美颜`);
  }
  check(/过曝|曝光/.test(self), '① 提了曝光不准（"刻意的平庸感"）');
  // ⚠️ 2026-09-22 用户看完第一张自拍后报的两条，各钉一条：
  //  ①「自拍肯定看不到手机，这明显是别人给她拍的样子」
  //  ②「真人突然要自拍不会一直都笑得这么开心，要有一种营业感」
  const selfPlain = self.replace(/\*\*/g, '');
  check(/这是自拍/.test(selfPlain) && /看不到手机|不会出现在画面里/.test(selfPlain),
    '★★ ① 自拍要写明"画面里看不到手机"（不然模型会画成"别人举着手机给她拍"）');
  check(/取景框里.*只有她自己/.test(selfPlain), '★ ① 而且是**正向**描述取景框里有什么（比单纯否定更容易被遵守）');
  // ⚠️⚠️ 只改风格段**不够**：实测"理解"那一步会在场景里写"举着手机自拍"，
  //    那句会把风格段里的"看不到手机"整个盖过去 ⇒ 两处必须一起改。
  const ppSrc = readFileSync(join(ROOT, 'src', 'photo-plan.js'), 'utf8');
  check(
    /不要写"举着手机 \/ 拿着手机/.test(ppSrc) || /绝对不要写"举着手机/.test(ppSrc),
    '★★ ① 理解那一步**禁止写"举着手机"**（实测：场景里写了它，手机就一定会被画出来）',
  );
  // ⚠️ 2026-09-22 第二次修（用户：「表情还是太笑了，不真实」）：第一版写"营业感"，
  //    被读成了**营业式微笑** ⇒ 现在必须**正面写死**目标表情（嘴闭合/嘴角不上扬/不眯眼）。
  check(/嘴唇自然闭合|嘴角不上扬/.test(selfPlain) && /不笑|不眯眼/.test(selfPlain),
    '★★ ② 神态要**正面写死**（嘴闭合、嘴角不上扬、不眯眼）—— 只写"不要笑"没用');
  check(/不是营业式微笑/.test(selfPlain), '★ ② 显式排除"营业式微笑"这个歧义（第一版就栽在这儿）');
  check(!/营业感|自拍/.test(sceneOnly), '拍景物那条**不掺**人物神态/自拍（画面里没人）');

  // ★ 画风那层来自 config（界面上能改能存）—— 改了配置，拼出来的提示词必须跟着变
  const { config } = await import('../src/config.js');
  const saved = JSON.stringify(config.imagegen.style);
  config.imagegen.style = { self: '【我改过的画风】', scene: '【我改过的景物画风】' };
  check(imagegen.buildPrompt({ what: 'X', withSelf: true }).includes('【我改过的画风】'), '★ 改 config 的画风 → 有她那条跟着变');
  check(imagegen.buildPrompt({ what: 'X', withSelf: false }).includes('【我改过的景物画风】'), '★ 改 config 的画风 → 拍景物那条跟着变');
  config.imagegen.style = JSON.parse(saved); // 还原，别影响后面的用例

  // ⚠️ 官方指南：中文提示词建议不超过 300 字
  check(self.length < 300, `① 提示词 ${self.length} 字（官方建议 <300）`);
  check(sceneOnly.length < 300, `② 提示词 ${sceneOnly.length} 字（官方建议 <300）`);
}

console.log('\n【3】火山方舟（ark）的请求形状');
{
  useFake();
  mode = 'ok';
  served = 0;
  const r = await imagegen.generate({ prompt: '在教室里自拍', refs: [REF] });
  check(r.ok === true, '生成成功', r.ok ? `${r.ms}ms` : r.reason);
  check(!!r.file && existsSync(r.file), '图落到了本地（发送那条路只认本地路径）');
  check(!String(r.file).includes('library'), '★ 图落在隔离目录里，没污染真实相册', r.file?.replace(ROOT, '.'));

  check(lastReq.path === '/images/generations', '打到 `/images/generations`', lastReq.path);
  const b = lastReq.body;
  check(b.model === 'test-image-model', 'body.model 用的是配置里的模型名');
  check(b.prompt === '在教室里自拍', 'body.prompt 是场景');
  check(Array.isArray(b.image) && b.image.length === 1, '★ `image` 是**数组**（Ark 的形状）');
  check(String(b.image?.[0]).startsWith('data:image/png;base64,'), '★ 参考图走 **base64 直传**（不用图床）');
  check(String(b.image?.[0]).includes('image/PNG') === false, '★ 格式名是**小写**（Ark 文档明确要求）');
  check(b.watermark === false, '★ `watermark:false` —— 不然生成的图会烧「AI 生成」水印');
  check(
    b.sequential_image_generation === undefined,
    '不传 `sequential_image_generation`（不传 = 默认单图，且 5.0 pro/flash 不认这个参数）',
  );
  check(b.response_format === 'url', 'response_format=url');

  // ⚠️ 2026-09-22 加：分辨率档要**按模型夹** —— Seedream 5.0 pro/flash 最高只到 2K，
  //    给它们发 4K 会被平台拒。默认档是 4K（用户要求"发出来像真照片、800 万像素"），
  //    而用户随时能在界面上换成 5.0 flash ⇒ 不夹这一下就会变成"刚配好却报参数错"。
  useFake({ model: 'doubao-seedream-5-0-flash-260915', size: '4K' });
  await imagegen.generate({ prompt: '自拍', refs: [REF] });
  check(lastReq.body.size === '2K', '★ 5.0 pro/flash 写 4K → 自动降成 2K（它们最高只有 2K）');
  useFake({ model: 'doubao-seedream-4-0-250828', size: '4K' });
  await imagegen.generate({ prompt: '自拍', refs: [REF] });
  check(lastReq.body.size === '4K', '★ 4.0 写 4K → 原样发出（4.0 支持 4K ≈ 1660 万像素）');
  useFake();
}

console.log('\n【4】★ 换服务商只改配置（`openai` 形状 = 硅基流动那一类）');
{
  useFake({ provider: 'openai', model: 'Qwen/Qwen-Image-Edit-2509' });
  mode = 'ok';
  const r = await imagegen.generate({ prompt: '在教室自拍', refs: [REF] });
  check(r.ok === true, '同一个功能代码，换成 openai 形状也能出图');
  const b = lastReq.body;
  check(typeof b.image === 'string', '★ `image` 是**字符串**（不是数组）—— 两家形状确实不同');
  check(b.image_size === '1024x1024', '★ 尺寸字段叫 `image_size`（不是 `size`）');
  check(lastReq.headers['x-enable-watermark'] === '0', '★ 水印靠**请求头**关（body 字段不管用）');
  check(b.sequential_image_generation === undefined, '不把 Ark 专属字段塞给别家');

  // 回到 ark，别影响后面
  useFake();
}

console.log('\n【5】baseURL / model 留空 → 用该 provider 的默认地址');
{
  const d = imagegen.describe({ baseURL: '', model: '' });
  check(d.baseURL.includes('volces.com'), 'ark 留空 → 默认火山方舟地址', d.baseURL);
  const d2 = imagegen.describe({ provider: 'openai', baseURL: '', model: '' });
  check(d2.baseURL.includes('siliconflow'), 'openai 留空 → 默认硅基流动地址', d2.baseURL);
}

console.log('\n【5b】★ 模型候选列表（界面下拉框靠它 —— id 写错一个字符就是"模型不存在"）');
{
  const ark = imagegen.presets({ provider: 'ark' });
  // ⚠️ 这些 id 是 2026-09-22 从官方《图片生成教程》的「模型能力」表抄的。
  //    它们都带日期后缀，**别照印象改** —— 所以在这里逐个钉住。
  const wantArk = [
    'doubao-seedream-4-0-250828',
    'doubao-seedream-4-5-251128',
    'doubao-seedream-5-0-flash-260915',
    'doubao-seedream-5-0-260128',
    'doubao-seedream-5-0-lite-260128',
    'doubao-seedream-5-0-pro-260628',
  ];
  for (const id of wantArk) check(ark.models.includes(id), `ark 候选里有 ${id}`);
  check(ark.models[0] === 'doubao-seedream-4-0-250828', 'ark 第一个是默认（给我报过价的那档）');
  check(ark.defaultModel === ark.models[0], '★ 默认模型**必须也在候选里**（否则下拉框选不到它）');

  const oa = imagegen.presets({ provider: 'openai' });
  check(oa.models.includes('Qwen/Qwen-Image-Edit-2509'), 'openai 候选里有硅基流动的 Qwen-Image-Edit-2509');
  check(oa.defaultModel === oa.models[0], '★ 同样：默认模型在候选里');

  // ⚠️ 候选**不是白名单** —— 平台出新模型不该要改代码
  check(
    imagegen.describe({ model: '我瞎编的模型名' }).model === '我瞎编的模型名',
    '★ 候选不是白名单：任意模型名照收（用户要求"能自动拉列表选择"，不是"只能选列表里的"）',
  );

  // 尺寸：留空时按 provider 取默认（两家的格式本来就不一样）
  // ⚠️ Ark 的默认是 **4K**（≈1660 万像素）—— 用户要求"发出来像真照片"，
  //    2K 只有 400 万，在 QQ 里显示得跟表情包差不多大。
  check(imagegen.describe({ provider: 'ark', size: '' }).size === '4K', 'ark 尺寸留空 → 4K（≈1660 万像素）');
  check(imagegen.describe({ provider: 'openai', size: '' }).size === '1024x1024', 'openai 尺寸留空 → 1024x1024');
}

console.log('\n【5c】★★ 别给 Seedream 5.0 pro/flash 塞它们不认的参数');
{
  useFake();
  mode = 'ok';
  await imagegen.generate({ prompt: '自拍', refs: [REF] });
  // ⚠️ 官方 API 文档写明 **Seedream 5.0 pro / flash 不支持配置 `sequential_image_generation`** ——
  //    传了会被拒。官方教程里 5.0 lite 的例子也**根本不传它**（不传 = 默认单图），
  //    所以干脆不传：对 4.0 / 4.5 / 5.0 全系列都成立。
  //    （这条是 2026-09-22 查文档时才发现的真 bug：原来一直在传 `disabled`。）
  check(
    lastReq.body.sequential_image_generation === undefined,
    '★ 请求体里**没有** `sequential_image_generation`（5.0 pro/flash 不认这个参数）',
  );
  check(lastReq.body.size === '1024x1024', '尺寸按配置走');
  check(lastReq.body.output_format === undefined, '不硬塞 `output_format`（4.0 只出 jpeg，默认就行）');
}

console.log('\n【6】★ 失败分类（决定"要不要重试"和"说什么话"）');
{
  const cases = [
    ['credit', 'credit', false, '余额/额度耗尽'],
    ['reject', 'reject', false, '内容审核拒绝'],
    ['busy', 'busy', true, '限流'],
    ['server', 'server', true, '服务端 5xx'],
    ['auth', 'auth', false, 'Key 不对'],
    ['notopen', 'notopen', false, '模型没在控制台开通（实测踩到的原样响应）'],
    ['limit', 'limit', false, '★ 用量上限到了、服务被暂停（**HTTP 429**，实测踩到的原样响应）'],
    ['noimage', 'error', false, 'HTTP 200 但没图'],
    ['badjson', 'server', true, '返回不是 JSON'],
  ];
  for (const [m, want, retry, desc] of cases) {
    useFake();
    mode = m;
    const r = await imagegen.generate({ prompt: '自拍', refs: [REF] });
    check(r.ok === false && r.reason === want, `${desc} → ${want}`, `实际 ${r.reason}`);
    check(r.retryable === retry, `  ...可重试=${retry}`);
  }
  useFake({ timeoutMs: 400 });
  mode = 'hang';
  const t = await imagegen.generate({ prompt: '自拍', refs: [REF] });
  check(t.ok === false && t.reason === 'timeout' && t.retryable === true, '超时 → timeout（可重试）', t.reason);
  mode = 'ok';
}

console.log('\n【7】★★ 失败话术**绝不许**泄露故障码（用户明确要求）');
{
  const reasons = ['off', 'credit', 'limit', 'reject', 'busy', 'timeout', 'server', 'auth', 'notopen', 'error'];
  for (const r of reasons) {
    const line = imagegen.deflect(r);
    check(typeof line === 'string' && line.trim().length > 0, `${r} 有话说（不能是空的）`);
  }
  // ⚠️ 这条是用户的原话要求：「要直接说不想拍照，而不是暴露故障码」
  for (const r of reasons) {
    const line = imagegen.deflect(r);
    check(/\d/.test(line) === false, `★ ${r}：话术里**没有数字**`, line);
    check(/http|code|错误|失败|异常|api|token/i.test(line) === false, `★ ${r}：没有技术词`, line);
  }
  check(/没电|没带|坏了/.test(imagegen.deflect('credit')), '没额度 → 说"相机没电/没带"这种话');
  check(imagegen.deflect('不认识的原因') === imagegen.deflect('error'), '没见过的分类 → 兜底话术（不许回 undefined）');

  // ── 给**管理员**的提示是另一套（要具体到"去点哪个按钮"）──
  for (const r of reasons) {
    const h = imagegen.hint(r);
    check(typeof h === 'string' && h.trim().length > 0, `${r} 对管理员也有提示`);
  }
  check(
    /开通/.test(imagegen.hint('notopen')) && /控制台|Console|开通管理/.test(imagegen.hint('notopen')),
    '★ 「模型没开通」对管理员说清楚**去哪开通**（只说"相机坏了"用户根本不知道该干嘛）',
  );
  check(/logs\/bot\.log|原始错误/.test(imagegen.hint('error')), '兜底的 error 提示告诉他去日志看原始错误');
  check(
    /安心体验|上限/.test(imagegen.hint('limit')) && /开通管理|控制台/.test(imagegen.hint('limit')),
    '★ 「用量上限到了」要告诉他去关哪个开关（只说"重来一张"他会一直重试到天亮）',
  );
  // ⚠️ 两边是**两套话**，不能是同一句 —— 否则等于把技术细节端到群里
  check(imagegen.hint('notopen') !== imagegen.deflect('notopen'), '★ 群里那句 ≠ 给管理员那句');
}

console.log('\n【8】★ 串行：同一时刻只跑一个生成任务');
{
  useFake();
  mode = 'ok';
  inFlight = 0;
  peak = 0;
  imagegen.__resetQueue();
  const ps = [
    imagegen.generate({ prompt: 'A', refs: [REF] }),
    imagegen.generate({ prompt: 'B', refs: [REF] }),
    imagegen.generate({ prompt: 'C', refs: [REF] }),
  ];
  check(imagegen.busy() === true, '跑起来之后 `busy()` 是 true');
  const rs = await Promise.all(ps);
  check(rs.every((r) => r.ok), '三个都成功（一个失败不能把队列弄断）');
  check(peak === 1, `★ 峰值并发 = 1（实际 ${peak}）—— 同时来 5 个人不会烧 5 张`);
  check(imagegen.busy() === false, '跑完 `busy()` 回到 false');
}

console.log('\n【9】ready() / describe()：没配好不许假装能用');
{
  check(imagegen.ready({ enable: false }).ok === false, 'enable:false → 不可用');
  check(imagegen.ready({ apiKey: '' }).ok === false, '没 key → 不可用');
  // ⚠️ 模型名留空**是设计**：用该 provider 的默认模型（`config.yml` 里也写了"留空=用默认"）
  check(imagegen.ready({ model: '' }).ok === true, 'model 留空 → 回落到该 provider 的默认模型（不是 bug）');
  check(imagegen.ready({ provider: '不存在的平台' }).ok === false, '不认识的服务商 → 不可用（不崩）');
  useFake();
  check(imagegen.ready().ok === true, '配全了 → 可用');
  const d = imagegen.describe();
  check(d.provider === 'ark' && d.hasKey === true, 'describe() 报出 provider / 有没有 key');
  check(!('apiKey' in d), '★ describe() **不回** key 本身（界面用不到，日志里也不该有）');
}

console.log('\n【10】★ 接线断言（源码级 —— 这两个坑互相拉扯，必须钉死）');
{
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');

  // ① 生图绝不能 await（10~30 秒，会把回复流卡死）
  check(/if \(photo\) this\.runPhoto\(/.test(src), '★ `[拍照:]` 是**登记后不管**，没 await');
  check(/await this\.runPhoto/.test(src) === false, '★ 全文件没有 `await this.runPhoto`');

  // ② 但返回值必须非 null —— 否则触发「空响应重试」，她整条回复发两遍
  check(
    /!text && !markers\.length && !photo/.test(src) && /!text && !keepMarkers\.length && !photo/.test(src),
    '★ 两处 early-return 都放行了"只有拍照标记"的回复',
  );
  check(
    /return sentText \|\| \(keepMarkers\.length \|\| photo \? '' : null\)/.test(src),
    '★ 返回值不是 null —— 否则 `sentFirst` 保持 false → 触发重试 → **回两遍**',
  );

  // ③ 没配生图时，一个字都不许提（不然会冒"相机没带"这种莫名其妙的台词）
  check(/if \(imagegen\.ready\(\)\.ok\) \{/.test(src), '★ 提示词里那段"你可以拍照"只在**配好了**才注入');

  // ③-b 两种标记要**分工明确**地教给模型，而且"没她"那条要能被识别
  check(/\{photo\.withSelf \? '有她' : '拍景物'\}/.test(src), '日志里标出这次是"有她"还是"拍景物"（事后对账用）');
  // ⚠️⚠️ 2026-09-22 用户要求「时间/地点/是否自拍 要先经过 llm 理解」之后，
  //    这条链变成：**先跑一次理解 → 再拼提示词 → 再生成**。下面几条钉住这个顺序。
  check(/await photoPlan\.plan\(/.test(src), '★ 生图之前**先跑一次"理解"**（photo-plan.js）');
  check(/imagegen\.buildPrompt\(\{/.test(src), '★ 用 `buildPrompt` 拼（现算层 + 固定画风层）');
  check(/time: picked\.time \|\| facts\.now/.test(src), '★★ 时间**以系统真实状态为准**，LLM 只填了才覆盖它');
  check(/place: picked\.place \|\| facts\.where/.test(src), '★★ 地点同理');
  check(/whereNow\(nowAt\)/.test(src), '★ 事实来源：`whereNow()`（她说的话优先，**和日程矛盾时以日程为准**）');
  check(
    /const refs = withSelf \? persona\.refImages\(\) : \[\]/.test(src),
    '★★ "拍景物"**不传参考图** —— 传了模型会硬塞一个人进去，而拍景物要的正是纯写实',
  );
  check(/expectRef: withSelf/.test(src), '★ 拍景物时**不报**"没有参考图"的假警告');
  // ⚠️⚠️ 2026-09-23 实测（用户：「为什么我 @ 她让她看上一句话，她直接给我发照片了」）：
  //    他只是 @ 了一下、没打字（引子是"看看最近的消息，回他一句"），她**自己拍了一张**。
  //    而且先说了「这个点能拍出什么好看的来」**然后照样拍**，自相矛盾。
  check(
    /别自己找机会拍/.test(src) && /群友只是在聊别的[\s\S]{0,60}一律不拍/.test(src),
    '★★ 拍照要**克制到场景级**：只有明确要照片才拍，@ 一下让看消息这种**一律不拍**',
  );
  check(/说了不拍就别拍/.test(src), '★ 别"说不拍、然后照样拍"（实测她就是这么干的）');
  check(
    /他是想让你看看最近的消息，\*\*回他一句\*\*[\s\S]{0,80}别发照片/.test(src),
    '★★ "只 @ 了没打字"那条引子里明说**只要一句话、别发照片**（那次就是这么跑偏的）',
  );
  // ⚠️ 2026-09-22 用户定的分寸：**别一律端着**（"袜子这种平台又不会拒，第一次拒绝、
  //    第二次就发出来算了，要不然容易误伤"）⇒ 必须把"有点随意"和"真的越线"分开写清，
  //    否则模型会自己缩得太紧。
  check(/第一次可以端着拒绝一下/.test(src) && /对方再说一次就顺着来/.test(src),
    '★★ 分寸：有点随意的要求"第一次端一下、第二次就顺着来"（用户拍板，怕误伤正常请求）');
  check(/真的越线的/.test(src) && /一律不拍，怎么要都不拍/.test(src),
    '★★ 但**真的越线的一律不拍** —— 松的是"随意/调侃"，不是这条底线');

  // ⚠️⚠️ 2026-09-22 用户截图「发的还是表情格式」——
  //    照片被当**表情**发了（QQ 里是小图 + `[动画表情]`），真因是 `sendText` 的
  //    `asSticker` **默认 `true`**（那是给表情包设的），而拍照这条路没传它。
  const sd = /sendText\(event, text, \{ reply = false, faceFile = null, asSticker = ([a-z]+) \}/.exec(src);
  check(sd && sd[1] === 'false', '★★ `sendText` 的 `asSticker` 默认必须是 **false**（默认 true 那次让照片变成了表情）', sd?.[1]);
  check(
    /await this\.sendText\(event, '', \{ faceFile: r\.file, asSticker: false \}\)/.test(src),
    '★★ 拍照显式按**图片**发（`asSticker: false`）—— 这才是"尺寸像表情包"的真因',
  );
  check(
    /sendText\(event, '', \{ faceFile: p, asSticker: true \}\)/.test(src) &&
      /sendText\(event, '', \{ faceFile: file, asSticker: true \}\)/.test(src),
    '★ 反过来，表情包那两处**显式**要 sticker（别再靠默认值）',
  );

  const pp = readFileSync(join(ROOT, 'src', 'photo-plan.js'), 'utf8');
  check(/withSelf: j\.withSelf === true/.test(pp), '★ 判断不出来时**偏向"没有她"**（宁可少画一个人）');
  check(/不许改成和事实矛盾的地方/.test(pp), '★★ 理解那一步**明确禁止**编出和真实处境矛盾的地点');
  check(/p\.marker/.test(pp), '★ 她自己写的标记会作为**意图线索**喂给理解那一步');
  check(/planTimeoutMs/.test(pp), '理解那一步有自己的超时（别拖住整条拍照链）');

  // ④ 群聊里说的只有 deflect() 那一句
  check(/imagegen\.deflect\(r\.reason\)/.test(src), '失败时发的是 `deflect()` 的话术');
  check(/log\.warn\(`拍照最终失败/.test(src), '真实原因进日志（可追溯），不进群聊');

  const ig = readFileSync(join(ROOT, 'src', 'imagegen.js'), 'utf8');
  check(/log\.warn\(`生图失败（\$\{reason\}）：\$\{detail\}`\)/.test(ig), 'imagegen 里失败**带 detail 打日志**（HTTP 码在这）');
  check(/deflect\(reason\)/.test(ig) && /LINES\[reason\]/.test(ig), '话术表在 imagegen 里（换角色可改）');

  // ⑤ 相册目录可隔离（测试别污染真实 library/photo）
  check(/QQBOT_PHOTO_DIR/.test(ig), '生成图目录可用 `QQBOT_PHOTO_DIR` 隔离');
}

console.log('\n【11】配置能热切换（和语言模型同一套：改 config.yml 就生效）');
{
  const webui = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(/imagegen: \{ \.\.\.config\.imagegen \}/.test(webui), 'webui 把 imagegen 吐给前端（不然界面读不到）');
  check(/put\('imagegen', patch\.imagegen\)/.test(webui), 'webui 保存时写回 imagegen');
  check(/'imagegen', 'groupParams'/.test(webui), 'saveConfig 白名单里有 imagegen（不然**静默丢弃**）');
  check(/'POST \/api\/imagegen\/test'/.test(webui), '有 `/api/imagegen/test` 路由');

  const cfg = readFileSync(join(ROOT, 'src', 'config.js'), 'utf8');
  check(/imagegen: \{/.test(cfg) && /provider: 'ark'/.test(cfg), 'config.js 的 DEFAULTS 里有 imagegen 段');
  // ⚠️ 固定画风那层**存在 config 里**（用户要「界面上能改能存」），不是写死在 imagegen.js
  check(/style: \{/.test(cfg) && /self:/.test(cfg) && /scene:/.test(cfg), '★★ 固定画风存在 config 的 `imagegen.style`（界面上能改）');
  check(!/const STYLE_SELF/.test(readFileSync(join(ROOT, 'src', 'imagegen.js'), 'utf8')), '★ imagegen.js 里**不再**硬编码那份画风（只有兜底一句）');

  const html = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/id="ig-style-self"/.test(html) && /id="ig-style-scene"/.test(html), '界面上有两个画风输入框（有她 / 没她）');
  check(/style: \{ self: sSelf \|\| cur\.self/.test(html), '★ 保存时**两个一起发**（只发一半会把另一半从 config 抹掉）');

  // ⚠️ 现读 config.imagegen（reloadConfig 会把顶层键换成新对象，缓存就永远读到旧值）
  const ig = readFileSync(join(ROOT, 'src', 'imagegen.js'), 'utf8');
  check(/const c = config\.imagegen \?\? \{\}/.test(ig), '★ 每次调用**现读** `config.imagegen`（不缓存）');
}

console.log('\n【12】★ 缓存清理：只删过期的，而且**绝不碰表情库**');
{
  const { config: cfg2 } = await import('../src/config.js');
  const dir = join(ROOT, PHOTO_REL);
  mkdirSync(dir, { recursive: true });

  /** 造一个"多久之前"的假图 */
  const mk = (name, ageHours) => {
    const f = join(dir, name);
    writeFileSync(f, 'x'.repeat(2000));
    const t = new Date(Date.now() - ageHours * 3600_000);
    utimesSync(f, t, t);
    return f;
  };
  const old25 = mk('__old-25h.jpg', 25);
  const old30 = mk('__old-30h.jpg', 30);
  const fresh1 = mk('__fresh-1h.jpg', 1);
  // ⚠️ 在同级（logs/）放一个"表情库"文件 —— 清完**必须还在**，证明只动 library/photo/
  const faceLike = join(ROOT, 'logs', '__fake-face-library.png');
  writeFileSync(faceLike, 'keep me');

  cfg2.imagegen.keepHours = 24;
  const r = imagegen.sweep();
  check(r.enabled === true, '保留 24 小时 → 清理是开的');
  check(r.removed === 2, `删掉 2 张过期的（实际 ${r.removed}）`);
  check(!existsSync(old25) && !existsSync(old30), '★ 25 小时 / 30 小时前的**都被删了**');
  check(existsSync(fresh1), '★ 1 小时前的**留着**（"发出 1 天之后删"不是"发完就删"）');
  check(existsSync(faceLike), '★★ 同级的「表情库」文件**没被动过** —— 只清 library/photo/，不碰 library/ 根目录');
  check(r.kept >= 1 && r.keptBytes > 0, `剩余张数/体积报得出来（${r.kept} 张）`);

  // ⚠️ keepHours=0 = 关掉自动清理（用户可能想留着当相册）
  const old50 = mk('__old-50h.jpg', 50);
  cfg2.imagegen.keepHours = 0;
  const r0 = imagegen.sweep();
  check(r0.enabled === false && r0.removed === 0, '★ keepHours=0 → 一张都不删');
  check(existsSync(old50), '★ 那种情况下 50 小时前的也留着');

  cfg2.imagegen.keepHours = 24;
  for (const f of [old50, fresh1, faceLike]) rmSync(f, { force: true });
  check(imagegen.sweep().removed === 0, '清干净之后没有可删的（不报假数）');

  // 清理目录必须是那个可被 env 隔离的目录（测试别去删用户的真实相册）
  check(
    String(imagegen.OUT).includes(PHOTO_REL.replace(/\//g, '\\')) || String(imagegen.OUT).includes(PHOTO_REL),
    '★ 清理目标是 `QQBOT_PHOTO_DIR` 指的那个目录（测试不碰真实 library/photo）',
    imagegen.OUT.replace(ROOT, '.'),
  );

  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/imagegen\.sweep\(\)/.test(src), '★ 拍照**之前**会顺手扫一遍（不需要额外定时器）');

  const webSrc = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(/'POST \/api\/imagegen\/cache'/.test(webSrc), '有 `/api/imagegen/cache` 路由（查占用 / 立即清理）');
  check(/imagegen\.sweep\(Number\.MAX_SAFE_INTEGER\)/.test(webSrc), '★ `dryRun` 用"保留期无穷大"实现 —— 只统计、一张不删');
  const webHtml = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/id="ig-keepHours"/.test(webHtml) && /id="btn-ig-sweep"/.test(webHtml), '界面能改保留时长 + 「立即清理」按钮');
}

console.log('\n【13】★ 拍照用的"她此刻在哪"：不许是对象、不许和日程矛盾');
{
  const bot = await import('../src/bot.js');
  const day = bot.whereAmI(new Date());
  // ⚠️ 2026-09-22 踩过：`whereAmI()` 返回的是**对象**，原来拍照直接把它塞进提示词
  //    ⇒ 生图提示词里出现 `地点：[object Object]`（只是被"有覆盖"掩盖了没暴露）。
  check(typeof day === 'object' && typeof day.place === 'string', '★ `whereAmI()` 现在带 `place`（拍照用的短地点）');
  check(day.place.trim().length > 0 && day.place.length < 30, `place 是一句短话：「${day.place}」`);
  // 生图提示词里**不能**有 `**`（那是给人设看的 markdown）和换行
  check(!/[*\n]/.test(day.place), '★★ `place` 里没有 `**` / 换行（那是 `line` 那种提示词文案，不能进生图提示词）');

  const now = bot.whereNow(new Date());
  check(typeof now?.where === 'string' && now.where.trim().length > 0, `★ \`whereNow()\` 给出一句地点：「${now.where}」`);
  check(!/[*\n]/.test(now.where), '★ 它同样干净（不含 `**` / 换行）');
  check(['schedule', 'override'].includes(now.source) || /群|override|schedule/.test(String(now.source)), `来源标的出来（${now.source}）`);

  // ⚠️⚠️ 用户截图报的那条：她刚说「今天秋分放假」，照片却是**教室**。
  //    根因是"她说过的话"留下的覆盖（2 小时窗口）无条件压过日程。
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/export function whereNow\(/.test(src), '★ 有 `whereNow()`（覆盖 + 日程的一致性检查）');
  check(
    /day\?\.schoolDay === false && \/教室\|上课\|学校\|校门\/\.test\(said\)/.test(src),
    '★★ 放假的日子不可能"在教室上课" → 那种覆盖会被推翻、以日程为准',
  );
  check(/where: whereNow\(nowAt\)\.where/.test(src), '★★ 拍照的事实走 `whereNow()`（不再直接用对象/覆盖）');
  const web = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(/import \{ whereNow \} from '\.\/bot\.js'/.test(web), '★ 界面测试那条路用**同一个**来源');
  check(!/whereAmI\(nowAt\)/.test(web), '★ 界面里不再直接用 `whereAmI()`（那个返回对象）');
}

// ── 收尾 ──
server.close();
try {
  rmSync(join(ROOT, CFG_REL), { force: true });
  rmSync(join(ROOT, PHOTO_REL), { recursive: true, force: true });
} catch {
  /* 清不掉就算了，logs/ 本来就不进版本库 */
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
