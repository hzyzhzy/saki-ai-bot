/**
 * 识图：把群友发的图片交给带视觉能力的模型，取回详细描述。
 *
 * 实测三家模型的视觉能力（同一张表情包对比）：
 *   deepseek-flash   ✅ 细节最全（注意到呆毛、袖子装饰、小虎牙），但是**推理模型**，
 *                       思考会吃掉大量 token —— 必须给足 max_tokens，否则正文被截断成空。
 *                       代价：约 7.8s、1800 token
 *   deepseek-chat    ✅ 能看，快（1.6s、500 token），但细节明显少一些
 *   deepseek-v4-pro  ❌ 明确报「图片不受支持」
 *
 * 因为用户要的是「精确识别所有细节」，默认用 flash；想省钱可以在配置里换 chat。
 */
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { log } from './log.js';
// ⚠️ 2026-09-15 补：识图也是**直接 fetch** 的，原来**没记账**。
//    图片会占不少输入 token（一张图 + 提示词），不记账的话
//    "余额掉得比账本快"就有它一份。
import { record as recordSpend } from './spend.js';

/** 各模型的推荐参数：推理模型要给足 token，不然回答会被思考过程挤掉 */
const VISION_MODELS = {
  'deepseek-flash': { maxTokens: 8000, reasoning: true },
  'deepseek-chat': { maxTokens: 1500, reasoning: false },
};
const DEFAULT_VISION_MODEL = 'deepseek-flash';

/** flash 是推理模型，思考链会占掉一大半 token，所以这里给得比较宽 */
const DEFAULT_MAX_TOKENS = 8000;

/** 默认上限 20MB —— 群友的游戏截图经常 5~15MB */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/** 描述图片的提示词 —— 要的是「细节」，因为下游要拿这些细节去夸人 */
const DESCRIBE_PROMPT = `详详细细地描述这张图片。规则：

## 最重要的是「只说你看到的」

- **看不清就说看不清。绝对不要猜、不要编。**
- 如果有文字（站牌、路牌、UI、字幕、水印、聊天记录、对话框、**试卷、题目、书本**），
  **逐字念出来**。**截图里的文字常常就是答案本身**，比画面更重要。

## ⚠️ 如果是**题目 / 试卷 / 公式**（用户常发这个，2026-09-12 加）

这类图**文字就是全部内容**，必须**逐字照抄**，一个数字一个符号都不能丢：

- **题干全文照录**，包括题号（「例 3」「第 5 题」）、括号、下划线。
- **公式里每个符号都要念对**：等号、根号（√）、分数线、度（°）、
  上下标、字母大小写（「AD」和「Ad」不一样）。
- **几何图形要把关系说清楚**：有哪些点（A/B/C/D/E…）、
  **哪些线段相等 / 平行 / 垂直**、**哪个点是中点**、
  **虚线是辅助线还是所求线段**、
  **图上标的数值标在哪条边上**（「BD 段上方标着 4√3」这种位置也要说）。
- **最后那句「求什么」一定要抄下来**（「求 DE 的最小值」）。
- **如果某个数字或文字真的看不清，明确指出来**（「底边那个数字模糊」）——
  下游会去问人，比编一个强。

## 说清楚这些

- 主体是什么、什么颜色/材质/风格、画面构图、有什么细节
  （细小装饰、色差、光影、不显眼的小物件都要提）。
- 如果是游戏截图（比如 Minecraft）：在哪个界面、有什么设施、
  有没有可读的编号或站名、建造的精细程度。
- 如果是**别的软件的截图**（比如聊天界面、网页、AI 对话），
  就直说它是截图，然后把**里面的对话内容、角色名、结论**都念出来。
- 如果是表情包/动漫图，照实描述画面，**不要硬认角色**。

## 关于「认角色」这条特别提醒

- **只在你有把握时才说这是谁。** 认角色靠的是**标志物**：
  特定的发饰、服装、随身物品、作品 logo、配色组合。
- **光凭「粉发少女」这种特征不许点名** —— 粉发角色成百上千，硬猜必然错。
- **不确定就别给名字**，只描述特征（「粉发、紫眼、拿着印考拉的手机」）。
  下游会拿你的描述去查资料，你不给错名字反而更有用。
- 如果图里的文字已经写明了是谁（比如截图里有名字），那就**照念**，那是确凿的。

用中文，写 200~500 字。不要客套，直接描述。`;

/**
 * 把图片转成 data URL。
 * @param {Buffer|string} input Buffer，或者文件路径
 */
function toDataUrl(input) {
  let buf;
  let mime = 'image/jpeg';
  if (Buffer.isBuffer(input)) {
    buf = input;
    // 按文件头猜类型
    if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
    else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
    else if (buf[0] === 0x52 && buf[1] === 0x49) mime = 'image/webp';
  } else {
    buf = readFileSync(input);
    const ext = String(input).split('.').pop().toLowerCase();
    mime =
      ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  }
  return { url: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length, mime };
}

/**
 * 图片太大就压一下再送。
 *
 * ⚠️ 为什么需要：群友发的游戏截图经常 5~15MB。之前超过 8MB 直接跳过，
 *    结果主模型拿不到描述，就回「图我看不到内容」——用户真实遇到过（9.1MB 的截图）。
 *
 * ⚠️⚠️ 但**不能压太狠**（用户明确反馈过）：第一版压到 19KB，细节全没了，
 *    站牌编号、小装饰、光影全都识别不出来。识别细节是这个功能的核心价值。
 *
 * 所以策略是「尽量少压」：
 *   1. 先只限长边到 2560，用高质量（92）—— 大多数截图这一步就够了
 *   2. 不够再逐级降，但**分辨率优先保**，宁可降画质也别降尺寸
 *   3. 最后才降到 1600 / 1280（这时文字已经可能看不清了）
 *   4. 截图（PNG 且偏静态）保持 PNG，避免 JPEG 把文字边缘糊掉
 */
async function shrink(buf, maxBytes) {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    log.warn('识图：图片过大，但 sharp 不可用所以无法压缩');
    return null;
  }

  // 先看看原图多大、什么格式（用 sharp 拿元数据，别自己猜）
  let meta = {};
  try {
    meta = await sharp(buf).metadata();
  } catch {}
  const isPng = meta.format === 'png';
  const origSide = Math.max(meta.width ?? 0, meta.height ?? 0);
  // 尺寸本来就不大的图，不用缩，只降画质
  const capFirst = origSide && origSide <= 2560 ? origSide : 2560;

  // [长边上限, JPEG 质量]。分辨率优先保，最后才降尺寸。
  const LADDER = [
    [capFirst, 92],
    [capFirst, 85],
    [2048, 88],
    [2048, 78],
    [1600, 85],
    [1600, 72],
    [1280, 80],
    [1280, 65],
    [1024, 70],
  ];

  const tryOne = async (side, quality, format) => {
    let img = sharp(buf, { animated: false }).rotate(); // 按 EXIF 摆正
    if (meta.width && meta.height && Math.max(meta.width, meta.height) > side) {
      img = img.resize(side, side, { fit: 'inside', withoutEnlargement: true });
    }
    const out =
      format === 'png'
        ? await img.png({ compressionLevel: 9, palette: false }).toBuffer()
        : await img.jpeg({ quality, mozjpeg: true }).toBuffer();
    return out;
  };

  // ① 截图优先保 PNG（文字边缘不糊）
  if (isPng) {
    for (const [side] of LADDER.slice(0, 3)) {
      try {
        const out = await tryOne(side, 0, 'png');
        if (out.length <= maxBytes) {
          log.info(
            `识图：压缩(PNG) ${(buf.length / 1024 / 1024).toFixed(1)}MB → ${(out.length / 1024).toFixed(0)}KB（长边 ${side}）`,
          );
          return { url: `data:image/png;base64,${out.toString('base64')}`, bytes: out.length, mime: 'image/png' };
        }
      } catch (e) {
        log.debug(`识图：PNG 压缩失败（${side}）：${e.message}`);
      }
    }
  }

  // ② 退到 JPEG，按阶梯逐级试
  for (const [side, quality] of LADDER) {
    try {
      const out = await tryOne(side, quality, 'jpeg');
      if (out.length <= maxBytes) {
        log.info(
          `识图：压缩(JPEG q${quality}) ${(buf.length / 1024 / 1024).toFixed(1)}MB → ${(out.length / 1024).toFixed(0)}KB（长边 ${side}）`,
        );
        return { url: `data:image/jpeg;base64,${out.toString('base64')}`, bytes: out.length, mime: 'image/jpeg' };
      }
    } catch (e) {
      log.debug(`识图：压缩失败（长边 ${side} q${quality}）：${e.message}`);
    }
  }
  return null;
}

/**
 * 描述一张图片，并带出「为什么没识别」的原因。
 * @param {Buffer|string} image Buffer 或文件路径
 * @param {{prompt?:string, maxBytes?:number, model?:string, maxTokens?:number}} opts
 * @returns {Promise<{text:string, skipped:string|null, model?:string}>}
 */
export async function describeImageDetailed(image, opts = {}) {
  const maxBytes = opts.maxBytes ?? config.vision?.maxBytes ?? DEFAULT_MAX_BYTES;
  let data;
  try {
    data = toDataUrl(image);
  } catch (e) {
    log.warn(`识图：读图失败 ${e.message}`);
    return { text: '', skipped: `读图失败：${e.message}` };
  }

  // 超限先压缩，别再直接跳过
  if (data.bytes > maxBytes) {
    const buf = Buffer.isBuffer(image) ? image : readFileSync(image);
    const small = await shrink(buf, maxBytes);
    if (!small) {
      const msg = `图片太大（${(data.bytes / 1024 / 1024).toFixed(1)}MB）且压缩失败`;
      log.warn(`识图跳过：${msg}`);
      return { text: '', skipped: msg };
    }
    data = small;
  }

  const baseURL = String(config.llm.baseURL ?? '').replace(/\/+$/, '');
  const key = config.llm.apiKey;
  if (!baseURL || !key) return { text: '', skipped: '没配置模型' };

  const model = opts.model ?? config.vision?.model ?? DEFAULT_VISION_MODEL;
  const preset = VISION_MODELS[model] ?? { maxTokens: DEFAULT_MAX_TOKENS, reasoning: true };
  const body = {
    model,
    // ⚠️ 推理模型（flash）的思考过程会计入 completion_tokens。
    //    给少了会出现「思考完了但正文被截断成空」——踩过这个坑。
    max_tokens: opts.maxTokens ?? preset.maxTokens,
    temperature: 0.2, // 描述要稳，不要发挥
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: opts.prompt ?? DESCRIBE_PROMPT },
          { type: 'image_url', image_url: { url: data.url } },
        ],
      },
    ],
  };

  // ── 关掉思考链 ──
  // ⚠️ 实测（同一张图）：
  //      flash + 思考   → 6.7s，完成 1071 tok（其中思考 836），描述 338 字
  //      flash 关思考   → 2.1s，完成  254 tok（思考   0），描述 386 字
  //    **快 3.2 倍，描述还更长。** 描述图片这活儿不需要推理链，
  //    思考纯粹是白烧时间和 token（用户抱怨过识图 30 秒太慢）。
  //    deepseek-flash 支持这个参数；老模型不认就被服务端忽略，无副作用。
  if (config.vision?.thinking === false || preset.reasoning === false) {
    body.thinking = { type: 'disabled' };
  }

  try {
    const r = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      log.warn(`识图失败 HTTP ${r.status}：${t.slice(0, 200)}`);
      return { text: '', skipped: `接口报错 HTTP ${r.status}`, model };
    }
    const j = await r.json();
    try {
      if (j.usage) recordSpend({ model, usage: j.usage });
    } catch (e) {
      log.debug(`记账失败（不影响主流程）：${e.message}`);
    }
    const out = String(j.choices?.[0]?.message?.content ?? '').trim();
    if (!out) {
      log.warn(`识图返回空（模型 ${model} 可能不支持视觉，或 token 不够）`);
      return { text: '', skipped: '模型返回空', model };
    }
    log.info(`识图完成：${(data.bytes / 1024).toFixed(0)}KB → ${out.length} 字描述（${model}）`);
    return { text: out, skipped: null, model };
  } catch (e) {
    log.warn(`识图出错：${e.message}`);
    return { text: '', skipped: `识图出错：${e.message}`, model };
  }
}

/**
 * 兼容旧调用：只要描述文本。
 * @deprecated 新代码请用 describeImageDetailed，能拿到跳过原因
 */
export async function describeImage(image, opts = {}) {
  const r = await describeImageDetailed(image, opts);
  return r.text;
}

/** 哪些模型能用来看图（给管理界面提示用） */
export function visionModelInfo() {
  return {
    visionModel: config.vision?.model ?? DEFAULT_VISION_MODEL,
    available: Object.keys(VISION_MODELS),
    currentModel: config.llm.model,
  };
}
