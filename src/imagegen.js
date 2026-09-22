/**
 * 生图（群里说的「拍个照」）—— **服务商适配层**。
 *
 * ## 为什么要有这一层
 *
 * 跟 `src/provider.js`（协议端适配）同一个思路：
 *   · 功能代码（`bot.js`）只说「按这个场景给我生成一张图」，
 *     **不认识**火山方舟 / 硅基流动 / 百炼；
 *   · **换服务商 = 改 `config.yml` 的 `imagegen.*` 三行**
 *     （`baseURL` / `apiKey` / `model`），不动功能代码。
 *
 * ## 已经实现的两条路（覆盖用户会用到的大部分）
 *
 * | provider | 谁 | 接口 |
 * | --- | --- | --- |
 * | `ark`（默认） | 火山方舟 · 豆包 Seedream | `POST /images/generations`，**同步**一次返回 |
 * | `openai` | 任何 OpenAI 风格的生图接口（硅基流动的 `Qwen-Image-Edit-2509` 等） | 同上，同步 |
 *
 * ⚠️ 以后想加百炼（DashScope）那种**异步两步**的（提交任务 → 轮询结果），
 *    在下面的 `PROVIDERS` 里加一个条目就行 —— 但**必须补测试**，
 *    没测过的分支等于没有（这个项目的规矩：一件没闭合就做下一件 = 白做）。
 *
 * ## ⚠️⚠️ 对外只回「分类」，绝不带原始错误码
 *
 * 群聊里能看到的只有 `deflect()` 那句人话；真实的 HTTP 状态码 / 平台错误码
 * **只进日志**。这条和 `src/bilibili.js` 的规矩一致 ——
 * 用户 2026-09-14 明确要求过：「不要把 `HTTP 412` 这种内部错误码写进事实」，
 * 2026-09-22 又强调一次：「如果花光了机器人要直接说不想拍照，而不是暴露故障码」。
 *
 * ## ⚠️ 每次调用都**现读** `config.imagegen`
 *
 * `config.js` 的 `reloadConfig()` 是**逐顶层键替换**的 ——
 * 缓存 `const c = config.imagegen` 会一直读到旧对象，
 * 表现就是「界面上改完保存了，机器人还用老配置」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './log.js';

/**
 * 生成的图落在这儿（`library/` 在 .gitignore 里，不回灌版本库）。
 * ⚠️ `QQBOT_PHOTO_DIR` 是给测试用的 —— 套件里假服务器"生成"的图不该落进真实相册
 *    （和 `QQBOT_AFFINITY_FILE` 那些隔离变量同一个道理）。
 */
const OUT_DIR = process.env.QQBOT_PHOTO_DIR
  ? path.resolve(ROOT, process.env.QQBOT_PHOTO_DIR)
  : path.join(ROOT, 'library', 'photo');

/**
 * 图片扩展名 → MIME。
 * ⚠️ 火山方舟文档原话：「注意 `<图片格式>` 需小写，如 `data:image/png;base64,…`」——
 *    写成 `image/PNG` 会被拒，所以下面 `toDataUrl()` 统一转小写。
 */
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

/** 失败分类 → 要不要重试（用户定：失败时说人话，能重试的悄悄重试一次） */
const RETRYABLE = new Set(['busy', 'timeout', 'server']);

/** 失败分类 → 她说的那句人话（**不含任何数字 / 错误码**） */
const LINES = {
  off: '……相机今天没带。',
  credit: '相机没电了，今天不拍了。',
  // 用量上限到了 ≈ 对群里来说就是"没电了"，和 credit 同一句
  limit: '相机没电了，今天不拍了。',
  reject: '这个拍不了，换个姿势。',
  busy: '手抖糊了，重来一张。',
  timeout: '手抖糊了，重来一张。',
  server: '手抖糊了，重来一张。',
  auth: '相机坏了，今天不拍了。',
  notopen: '相机坏了，今天不拍了。',
  error: '相机坏了，今天不拍了。',
};

/**
 * 失败分类 → **给管理员看**的下一步（只出现在管理界面，**永远不进群聊**）。
 *
 * ⚠️ 和 `deflect()` 是两回事，别混：
 *   · `deflect()` → 群里听到的（人话、无技术细节）
 *   · `hint()`    → 界面/日志里给用户的（**要具体到"去点哪个按钮"**）
 * 2026-09-22 实测踩到：`ModelNotOpen`（模型没在控制台开通）被归成泛泛的 `error`，
 * 界面上只说"相机坏了" —— 用户根本不知道要去控制台开通模型。这条就是为它加的。
 */
const HINTS = {
  off: '生图没开：把配置里的 enable 打开，并填上 API Key。',
  credit: '这家平台的余额 / 免费额度用完了，去平台控制台充值，或等下个月的免费额度。',
  limit:
    '平台给你这个模型设的**用量上限**到了，服务被自动暂停。' +
    '火山方舟是这个原因：去控制台「开通管理」看这个模型的**免费额度还剩多少**，' +
    '把「安心体验模式」关掉、或者把上限调大（⚠️ 关掉之后，超出免费额度就会按量计费，' +
    'Seedream 4.0 是 0.20 元/张、5.0 flash 是 0.12 元/张）。' +
    '⚠️ 官方免费额度表里明确有的是 4.0 / 4.5（200 张）和 5.0-lite（50 张）；' +
    '新模型可能还没给免费额度，那样上限就是 0，开通完会立刻被判"已达上限"。',
  reject: '平台的内容审核拒绝了这次生成（提示词或参考图不合规）。换一个场景描述再试。',
  busy: '平台限流了 —— 过一会儿再试（程序会自动重试一次）。',
  timeout: '生图超时了。可以调大上面的「超时」，或者换一个更快的模型。',
  server: '平台那边出错了（服务端的问题）。等一会儿再试；反复这样就去平台看看公告。',
  auth: 'API Key 不对或没权限 —— 检查上面填的是不是这家平台的 Key、有没有复制全。',
  notopen:
    '这个模型你还没在这家平台开通。去火山方舟控制台 →「开通管理」把它开通（开通免费、按量付费），' +
    '或者在上面模型列表里换一个已经开通的。注意：平台的模型列表返回的是全部模型，不代表都开通了。',
  error: '去看 logs/bot.log 里那行「生图失败」，里面有平台返回的原始错误。',
};

/**
 * 分辨率档要**按模型夹一下**（依据官方《图片生成教程》的「模型能力」表）：
 *
 * | 模型 | 支持的档 |
 * | --- | --- |
 * | Seedream 4.0 | 1K / 2K / **4K** |
 * | Seedream 4.5 | 2K / **4K** |
 * | Seedream 5.0 lite | 2K / 3K / **4K** |
 * | Seedream 5.0 **pro / flash** | 1K / 1.5K / **最高只到 2K** |
 *
 * ⚠️ 所以给 5.0 pro/flash 发 `4K` 会被平台**直接拒**。默认档现在是 4K，
 *    而用户随时能在界面上把模型换成 5.0 flash ⇒ 不夹这一下就会变成一个
 *    「明明刚配好却报参数错」的怪 bug。返回 2K，并在日志里说一声。
 */
function arkSize(model, size) {
  const s = String(size ?? '').trim();
  if (/seedream-5-0-(pro|flash)/i.test(String(model ?? '')) && /^(3K|4K)$/i.test(s)) {
    log.info(`生图：模型「${model}」最高只支持 2K，把尺寸 ${s} 降成 2K（不然平台会拒）`);
    return '2K';
  }
  return s;
}

// ── 服务商 ────────────────────────────────────────────

/**
 * 注册表。每个条目：`{ baseURL, defaultModel, path, headers(s), body(s, prompt, images) }`
 * 其中 `s` 是 `settings()` 的结果，`images` 是**已经编码好的 data URL 数组**。
 */
const PROVIDERS = {
  /**
   * 火山方舟（豆包 Seedream 4.0）。
   * 文档：https://docs.volcengine.com/docs/ark/image-generation-api
   *
   * ⚠️ 两个已经踩过 / 查证过的点：
   *   ① `image` 字段**支持 URL 或 Base64**（`data:image/png;base64,…`），
   *      所以本地立绘**直接编码传**，不需要图床 / 对象存储。
   *      4.0 最多 14 张参考图，单张 ≤ 30MB、宽高比 [1/16, 16]。
   *   ② `watermark` 默认是 true —— 不显式关掉的话，生成的图右下角会烧一行
   *      「AI 生成」水印。当客服发到群里必须关。
   */
  ark: {
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seedream-4-0-250828',
    // Ark 认 `1K/2K/4K` 这种档位。
    // ⚠️ 2026-09-22 改成 `4K`（用户要求「发出的时候改成 800 万像素，这样就和真实照片
    //    完全一致」）：实测 4.0 用 4K 出的是 **4992×3328 ≈ 1660 万像素**，
    //    而原来的 2K 只有 2304×1728 ≈ 400 万 —— 在 QQ 里显示得跟表情包差不多大。
    //    ⚠️ 价格是**按张**的（4.0 = 0.20 元/张），跟分辨率无关，所以提上去不额外花钱。
    //    ⚠️ 但**不是所有模型都吃 4K** —— 见下面的 `arkSize()`。
    defaultSize: '4K',
    /**
     * **内置候选 Model ID**（2026-09-22 从官方《图片生成教程》抄的，别照印象编 ——
     * 这些 id 都带日期后缀，写错一个字就是"模型不存在"）。
     * ⚠️ 这只是**下拉框的建议值，不是白名单**：`model` 仍可填任意值
     *    （平台出新模型不该要改代码）。
     * ⚠️ 顺序有意义：第一个是默认值。4.0 是我给用户报过价的那档（0.20 元/张 + 200 张免费）。
     */
    models: [
      'doubao-seedream-4-0-250828',
      'doubao-seedream-4-5-251128',
      // 官方原话「生图速度更快、价格更低」—— 想省钱可以试这个（价格页没给具体数字，自己核）
      'doubao-seedream-5-0-flash-260915',
      'doubao-seedream-5-0-260128',
      'doubao-seedream-5-0-lite-260128',
      'doubao-seedream-5-0-pro-260628',
    ],
    path: '/images/generations',
    headers: (s) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` }),
    body: (s, prompt, images) => ({
      model: s.model,
      prompt,
      ...(images.length ? { image: images } : {}),
      size: arkSize(s.model, s.size),
      // ⚠️⚠️ **故意不传 `sequential_image_generation`**（2026-09-22 改）：
      //    官方 API 文档写明 **Seedream 5.0 pro / flash 不支持配置这个参数** ——
      //    传了会被拒。而官方教程里 5.0 lite 的例子也**根本不传它**
      //    （不传 = 默认就是单图），所以删掉最稳、且对全系列都成立。
      response_format: 'url',
      watermark: !!s.watermark,
    }),
  },

  /**
   * 任何 OpenAI 风格的 `POST /images/generations`。
   * 硅基流动的 `Qwen/Qwen-Image-Edit-2509` 就走这条（文档写明 `image` 支持 base64）。
   *
   * ⚠️ 硅基流动默认给生成的图加「AI 生成」水印，要 `X-Enable-Watermark: 0` 才关 —
   *    这是**请求头**，不是 body 字段，容易漏。
   */
  openai: {
    baseURL: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen-Image-Edit-2509',
    // OpenAI 系一般只认具体像素，不认 `2K` 这种档位
    defaultSize: '1024x1024',
    /**
     * 内置候选。⚠️ 同样不是白名单。
     * 这几个 id 来自硅基流动的**价格页**和**接口文档的示例**（不是编的）。
     */
    models: ['Qwen/Qwen-Image-Edit-2509', 'Qwen/Qwen-Image-Edit', 'Qwen/Qwen-Image', 'Kwai-Kolors/Kolors'],
    path: '/images/generations',
    headers: (s) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.apiKey}`,
      'X-Enable-Watermark': s.watermark ? '1' : '0',
    }),
    body: (s, prompt, images) => ({
      model: s.model,
      prompt,
      ...(images.length ? { image: images.length === 1 ? images[0] : images } : {}),
      image_size: s.size,
      batch_size: 1,
    }),
  },
};

// ── 出图风格 ──────────────────────────────────────────
//
// 2026-09-22 按用户要求加。用户原话：
//   「人物保持二次元形态，但是周围环境写实，而且不一定是自拍，比如让祥子拍一张
//     月之森校门的照片就不是自拍，而且写实的好处就体现出来了，而且要加一点随手拍的
//     提示词，就更像真人在发照片了」
//
// 这三条素材是网上找来的（不是我自己编的审美）：
//   ① 「拍废片」公式（Reddit/X 上刷屏、被爱范儿那篇总结过）——
//      真实感来自**刻意的不完美**：运动模糊、曝光不准、角度尴尬、构图混乱，
//      「像从口袋里掏手机时误按快门拍到的一张」。
//   ② 一份 Seedream 提示词实战指南（atlascloud）总结的六层结构里，真正管用的是
//      **第五层「相机物理特性」**：自然噪点 / 手持拍摄瑕疵 / 无美颜滤镜 / 无影棚灯光。
//      它还有一条反直觉的结论：**要求不完美比堆"8K"这类词更能救真实感**
//      （Seedream 的皮肤有过度平滑的毛病，加不完美词正是它的解法）。
//   ③ 同一条指南 + 官方指南的两条硬约束：
//      · **没有负面提示词字段** ⇒ 排除项要**内联**写进去（"没有美颜滤镜"这种）；
//      · **中文提示词别超过 300 字** ⇒ 堆关键词反而会让模型丢细节，所以下面写得很短，
//        而且是**完整句子**（官方原话：模型是靠指令推理，不是模式匹配标签）。
//
// ⚠️⚠️ 为什么**必须把人物和环境分开写画风**（这是这个需求的技术核心）：
//    参考立绘本身是动漫的，模型天然会把**整张图**都拉成动漫风 ⇒
//    环境就"二次元"了，写实的好处全丢。所以两段都要显式钉住各自的画风：
//    人是**二维动画角色**（线稿 + 赛璐璐上色），环境是**真实拍摄的照片**。
//
// ⚠️ 这段文字**本体存在 `config.js` 的 DEFAULTS 里**（`imagegen.style.self/scene`），
//    因为用户要求它**在界面上可改可存**；这里只负责读它 + 一个兜底。
const STYLE_FALLBACK = '真实照片，手机随手拍，没有滤镜也没有美颜。';

/**
 * 把「这次拍什么」拼成真正发给生图 API 的提示词。
 *
 * ⚠️⚠️ 提示词是**两层**拼的，两层的出处不同、谁都不许掺和对方
 *    （用户 2026-09-22：「要分清本来就有的默认提示词和后加的」）：
 *      · 这一层（`what` / `time` / `place`）是**每次现算的** ——
 *        见 `src/photo-plan.js`（一次模型理解）和 `bot.js`（系统真实状态）；
 *      · 另一层是**固定画风**（`config.imagegen.style`）—— 界面上改。
 *
 * @param {object} p
 * @param {string} p.what       这张照片的画面（一句看得见的话）
 * @param {boolean} p.withSelf  画面里有没有她 —— 决定用 `style.self` 还是 `style.scene`
 * @param {string} [p.time]     时间（一样一样按"事实在前、画风在后"排）
 * @param {string} [p.place]    地点
 */
export function buildPrompt({ what, withSelf = true, time = '', place = '' } = {}) {
  const body = String(what ?? '')
    .trim()
    .replace(/[。.]+$/, ''); // 免得拼出"。。"
  if (!body) return '';
  const style = config.imagegen?.style ?? {};
  const pick = String((withSelf ? style.self : style.scene) ?? '').trim() || STYLE_FALLBACK;
  // ⚠️ 顺序固定为「画面 → 时间地点 → 画风」：前面是"这次是什么"，后面是"长什么样"。
  //    反过来写模型会把画风当成主体描述的一部分。
  const when = [String(time ?? '').trim(), String(place ?? '').trim()].filter(Boolean).join('，');
  return [body + '。', when ? `${when}。` : '', pick].filter(Boolean).join('');
}

// ── 缓存清理 ──────────────────────────────────────────
//
// 用户 2026-09-22 要求：「图片肯定会越积越多，而且放在本地也没用，
// 发出 1 天之后直接删掉就可以了」。
//
// ⚠️ 为什么可以放心删：发出去的图是 **base64 上传给协议端**的（`imageRef()`），
//    QQ 那边拿到的是**它自己的副本** —— 本地文件删掉**不影响群里已经发出去的图**。
//    所以生成图在本地只是"发送用的中转"，留一天够重看 / 够排障了。
//
// ⚠️⚠️ **只删 `OUT_DIR`（`library/photo/`）里的文件，绝不碰它的父目录** ——
//    `library/` 根目录是**表情库**（`index.json` + 表情图片），删了她就没表情包了。
//    （`test/imagegen.js` 有一条断言专门盯这个：在同级放一个文件，清完必须还在。）
//
// ⚠️ 不需要额外的定时器：**清理的唯一触发条件是"又生成了新图"**，
//    所以挂在"生成之前"顺手扫一遍最自然（见 `bot.js` 的 `runPhoto()`）。
//    目录里通常只有几十个文件，扫一遍的开销可以忽略。

/**
 * 清掉过期的生成图。
 * @param {number} [keepMs] 保留多久（毫秒）。不传就用 `config.imagegen.keepHours`。
 *   `keepHours: 0` = **关掉自动清理**（一张都不删）。
 * @returns {{enabled:boolean, removed:number, kept:number, freedBytes:number, keptBytes:number}}
 */
export function sweep(keepMs) {
  const hours = Number(config.imagegen?.keepHours ?? 24);
  const ms = keepMs !== undefined ? Number(keepMs) : hours > 0 ? hours * 3600_000 : 0;
  const out = { enabled: ms > 0, removed: 0, kept: 0, freedBytes: 0, keptBytes: 0 };

  let names = [];
  try {
    names = fs.readdirSync(OUT_DIR);
  } catch {
    return out; // 目录还不存在（一张都没生成过）
  }

  const cutoff = Date.now() - ms;
  for (const n of names) {
    const f = path.join(OUT_DIR, n);
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue; // 刚被别的路径删掉了
    }
    if (!st.isFile()) continue; // 子目录不碰
    if (ms > 0 && st.mtimeMs < cutoff) {
      try {
        fs.rmSync(f, { force: true });
        out.removed += 1;
        out.freedBytes += st.size;
      } catch {
        // 删不掉（占用/权限）就留着，下次再试 —— 清理失败不该让拍照失败
        out.kept += 1;
        out.keptBytes += st.size;
      }
    } else {
      out.kept += 1;
      out.keptBytes += st.size;
    }
  }
  if (out.removed) {
    log.info(
      `生图缓存：删了 ${out.removed} 张（${(out.freedBytes / 1048576).toFixed(1)} MB），` +
        `还剩 ${out.kept} 张 / ${(out.keptBytes / 1048576).toFixed(1)} MB（保留 ${hours} 小时）`,
    );
  }
  return out;
}

// ── 小工具 ────────────────────────────────────────────

/**
 * 读配置。`over` 用于「界面上填了还没保存」的测试调用。
 * ⚠️ 现读 `config.imagegen`，不缓存 —— 见文件头那段。
 */
function settings(over = {}) {
  const c = config.imagegen ?? {};
  const provider = String(over.provider ?? c.provider ?? 'ark').trim().toLowerCase();
  const P = PROVIDERS[provider];
  const pick = (k, dflt) => {
    const v = over[k] ?? c[k];
    return v === undefined || v === null || v === '' ? dflt : v;
  };
  return {
    enable: pick('enable', true) !== false,
    provider,
    baseURL: String(pick('baseURL', P?.baseURL ?? '')).replace(/\/+$/, ''),
    apiKey: String(pick('apiKey', '')),
    model: String(pick('model', P?.defaultModel ?? '')),
    // ⚠️ 留空 = 用该 provider 的默认档位。两家的尺寸格式**不一样**
    //    （Ark 认 `2K`，OpenAI 系只认 `1024x1024`）—— 默认值只有 `PROVIDERS` 里那一份，
    //    别在 config / 界面里再抄一遍，抄两遍迟早不一致。
    size: String(pick('size', P?.defaultSize ?? '1024x1024')),
    timeoutMs: Number(pick('timeoutMs', 180000)),
    watermark: pick('watermark', false) === true,
  };
}

/** 失败：对外只给分类，真实原因进日志 */
function fail(reason, detail) {
  if (detail) log.warn(`生图失败（${reason}）：${detail}`);
  return { ok: false, reason, retryable: RETRYABLE.has(reason) };
}

/** HTTP 状态 + 响应文本 → 分类 */
function classify(status, text) {
  const t = String(text ?? '');
  // ⚠️ 顺序有讲究：402 + `Insufficient Balance` 必须先判成 credit，
  //    否则会被后面的 4xx 规则吃掉，变成含糊的 error。
  if (/insufficient|balance|arrears|quota|欠费|余额|额度|recharge|top.?up/i.test(t)) return 'credit';
  // ⚠️ 2026-09-22 加（实测踩到）：火山方舟对**没在控制台开通**的模型回
  //    `404 {"code":"ModelNotOpen","message":"…has not activated the model…"}`。
  //    这是**配置问题**、不是平台故障 —— 归成泛泛的 error 的话，界面上只会说
  //    "相机坏了"，用户完全不知道该去控制台开通模型。所以单列一类。
  if (/modelnotopen|not\s+activated|not\s+open|未开通|没有开通|开通该模型/i.test(t)) return 'notopen';
  // ⚠️⚠️ 2026-09-22 实测踩到（用户开通模型之后**还是失败**，查了半天）：
  //    火山方舟的「安心体验模式」达到用量上限后**主动暂停模型服务**，
  //    回的是 **HTTP 429 + `SetLimitExceeded`** —— 只按状态码判成 `busy`（限流）的话：
  //      ① 会**悄悄重试一次**（白试，上限没变）
  //      ② 群里听到"手抖糊了，重来一张"，而真实原因是**他的花钱上限到了**
  //    ⇒ 用户永远不知道要去关掉那个开关。单列一类，且**不可重试**。
  if (/setlimitexceeded|usage limit|has been paused|safe experience/i.test(t)) return 'limit';
  if (/sensitive|content.?policy|violat|审核|违规|敏感|risk.?control|blocked|safety/i.test(t)) return 'reject';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'busy';
  if (status >= 500) return 'server';
  return 'error';
}

/** 本地图片 → data URL */
export function toDataUrl(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`不认识的图片格式：${ext || '(无扩展名)'}`);
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

/** 从各家五花八门的响应里挑出那张图 */
function pickImage(j) {
  const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.images) ? j.images : [];
  const one = arr[0];
  if (!one) return null;
  if (typeof one === 'string') {
    return /^https?:/i.test(one) ? { url: one } : { b64: one };
  }
  if (one.b64_json) return { b64: one.b64_json };
  if (one.url) return { url: one.url };
  if (one.image_url) return { url: one.image_url };
  return null;
}

/** 把生成结果落到本地文件 —— 发送那条路只认本地路径（见 `bot.js` 的 `file://` 兜底） */
async function materialize(picked, s) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (picked.b64) {
    const file = path.join(OUT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(picked.b64, 'base64'));
    return file;
  }
  const r = await fetch(picked.url, { signal: AbortSignal.timeout(Math.min(s.timeoutMs, 60000)) });
  if (!r.ok) throw new Error(`下载生成图 HTTP ${r.status}`);
  const ct = String(r.headers.get('content-type') ?? '');
  const ext = ct.includes('jpeg') ? '.jpg' : ct.includes('webp') ? '.webp' : '.png';
  const file = path.join(OUT_DIR, `${name}${ext}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

// ── 对外 ──────────────────────────────────────────────

/** 能不能用。`bot.js` 靠它决定**要不要把人设里那段「你可以拍照」注入提示词**。 */
export function ready(over = {}) {
  const s = settings(over);
  if (!s.enable) return { ok: false, why: 'imagegen.enable 是关的' };
  if (!PROVIDERS[s.provider]) return { ok: false, why: `不认识的服务商「${s.provider}」` };
  if (!s.apiKey) return { ok: false, why: '没配 API key' };
  if (!s.model) return { ok: false, why: '没配模型名' };
  return { ok: true, provider: s.provider, model: s.model, baseURL: s.baseURL };
}

/** 界面上的「测试」用：把当前（可能还没保存的）配置报出来，顺便校验形状 */
export function describe(over = {}) {
  const s = settings(over);
  return {
    enable: s.enable,
    provider: s.provider,
    baseURL: s.baseURL,
    model: s.model,
    size: s.size,
    known: !!PROVIDERS[s.provider],
    hasKey: !!s.apiKey,
    // ⚠️ 只回"有没有 key"，**绝不回 key 本身**（界面用不到，日志里也不该有）
  };
}

/**
 * 这个 provider 的**内置候选**（地址 / 默认模型 / 默认尺寸 / 可选 Model ID）。
 *
 * ⚠️ 为什么要内置一份候选：`/models` 不是所有生图平台都实现，而且
 *    **火山方舟的模型还要先在控制台开通**才会出现在列表里 ——
 *    拉不到时下拉框不能是空的，否则用户只能去翻文档手抄
 *    `doubao-seedream-4-0-250828` 这种带日期后缀的 id（抄错一个字符就是"模型不存在"）。
 * ⚠️ 候选**不是白名单**：`model` 仍可填任意值，平台出新模型不该要改代码。
 */
export function presets(over = {}) {
  const s = settings(over);
  const P = PROVIDERS[s.provider];
  return {
    provider: s.provider,
    baseURL: s.baseURL,
    defaultModel: P?.defaultModel ?? '',
    defaultSize: P?.defaultSize ?? '',
    models: [...(P?.models ?? [])],
  };
}

/** 失败分类 → 人话（群里听到的那句） */
export function deflect(reason) {
  return LINES[reason] ?? LINES.error;
}

/**
 * 失败分类 → **给管理员**的下一步（界面提示用，**永远不进群聊**）。
 * ⚠️ 和 `deflect()` 是一对，不是重复：一个说人话，一个说"去点哪个按钮"。
 */
export function hint(reason) {
  return HINTS[reason] ?? HINTS.error;
}

/**
 * 真正的生成（串行由下面那层壳负责）。
 * @param {{prompt?:string, refs?:string[], over?:object}} p
 * @returns {Promise<{ok:boolean, file?:string, ms?:number, reason?:string, retryable?:boolean}>}
 */
async function doGenerate({ prompt, refs = [], over = {}, expectRef = true } = {}) {
  const s = settings(over);
  const P = PROVIDERS[s.provider];
  if (!P) return fail('error', `imagegen.provider「${s.provider}」不在注册表里`);
  if (!s.apiKey) return fail('auth', 'imagegen.apiKey 是空的');
  if (!s.model) return fail('error', 'imagegen.model 是空的');

  const scene = String(prompt ?? '').trim();
  if (!scene) return fail('error', '场景描述是空的');

  let images = [];
  try {
    images = refs.filter(Boolean).map(toDataUrl);
  } catch (e) {
    return fail('error', `读参考图失败：${e.message}`);
  }
  // 没有参考图 = 每次画一张新脸 = 人设崩。不拦（还能用），但日志里喊一声。
  // ⚠️ `expectRef === false` 是**故意不带**的（`[拍:…]` 拍景物，她本来就不在画面里）
  //    —— 那种情况喊这一句是误报，会让人以为配置坏了。
  if (!images.length && expectRef) log.warn('生图没有参考图 —— 生成的人脸会和立绘不一致');

  const url = `${s.baseURL}${P.path}`;
  const started = Date.now();
  let res;
  let text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: P.headers(s),
      body: JSON.stringify(P.body(s, scene, images)),
      signal: AbortSignal.timeout(s.timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    const to = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return fail(to ? 'timeout' : 'server', `${url} ${e?.name ?? ''} ${e?.message ?? e}`);
  }

  if (!res.ok) return fail(classify(res.status, text), `${url} HTTP ${res.status} ${String(text).slice(0, 400)}`);

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('server', `${url} 返回的不是 JSON：${String(text).slice(0, 200)}`);
  }

  const picked = pickImage(json);
  if (!picked) {
    // 有的平台 HTTP 200 但 body 里塞一个 error
    const inner = json?.error?.message ?? json?.message ?? text;
    return fail(classify(res.status, inner), `${url} 响应里没有图：${String(inner).slice(0, 400)}`);
  }

  try {
    const file = await materialize(picked, s);
    const ms = Date.now() - started;
    log.info(`生图成功：${path.basename(file)}（${ms} ms，${s.provider}/${s.model}）`);
    return { ok: true, file, ms };
  } catch (e) {
    return fail('server', `生成图落盘失败：${e.message}`);
  }
}

// ⚠️ **同一时刻只跑一个生成任务**。
//    用户定的是「不限次数」，但同时来 5 个人会：① 烧 5 张钱 ② 撞接口的并发限流
//    ③ 生成完的图挤在一起分不清是谁要的。这里只负责**串行**，
//    「排队呢，等会儿」那句话由调用方（`bot.js`）看着 `busy()` 说。
let chain = Promise.resolve();
let running = 0;

/**
 * 现在有没有**在排队或正在跑**的生图任务。
 * ⚠️ 计数在 `generate()` 里**同步**加 —— 放在链的回调里加的话，
 *    调用方紧接着调 `busy()` 会拿到 false（那时还在微任务队列里没执行到），
 *    这个坑是 `test/imagegen.js` 抓出来的。
 */
export function busy() {
  return running > 0;
}

export function generate(p = {}) {
  running += 1;
  const run = chain.then(async () => {
    try {
      return await doGenerate(p);
    } finally {
      running -= 1;
    }
  });
  // 别让一次失败把整条链断掉（后面的人还得能排队）
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** 测试用：把串行链和计数复位 */
export function __resetQueue() {
  chain = Promise.resolve();
  running = 0;
}

export const OUT = OUT_DIR;
