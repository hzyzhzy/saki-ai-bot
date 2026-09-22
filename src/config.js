import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

/** 允许用环境变量指向另一份配置，方便测试 */
export const CONFIG_FILE = process.env.QQBOT_CONFIG
  ? join(ROOT, process.env.QQBOT_CONFIG)
  : join(ROOT, 'config.yml');

/**
 * `knowledge/` 目录 —— 可以用 `QQBOT_KNOWLEDGE_DIR` **整份搬走**。
 *
 * ⚠️⚠️ 为什么需要（2026-09-15，用户要求「隔离」）：
 *
 *   `run-all.js` 的 `isolatedStateEnv()` 只隔离了 `state/*.json`，
 *   **`knowledge/` 一直没隔离** —— 而 `test/webui.js` / `test/learned-edit.js`
 *   会走"界面保存"那条路，**真的去写 `knowledge/persona.md` 和 `learned.md`**。
 *
 *   **证据**（跑一轮回归，`knowledge/_backup/` 里就多出这些）：
 *     10:31:44 persona.md / 10:31:46 learned.md / 10:31:52 learned.md
 *     10:32:25 learned.md / 10:32:40 learned.md
 *
 *   核过哈希：**目前没坏**（两个套件写完之后会还原，内容和跑之前逐字节一致）。
 *   但只要套件**中途崩一次**，真实人设/学习档案就会**留在测试内容上** ——
 *   那是最贵的一类数据（persona.md 6.8 万字，是攒了很多天的）。
 *
 *   所以给测试一个开关：把整个目录指向一份副本，随便写。
 *
 * ⚠️ **只在这里定义一次**，其余 8 个用到 knowledge/ 的模块都从这里拿 ——
 *    以前那个路径在 9 个文件里各写了一遍，加隔离时漏一个就等于没隔离。
 */
export const KNOWLEDGE_DIR = process.env.QQBOT_KNOWLEDGE_DIR
  ? join(ROOT, process.env.QQBOT_KNOWLEDGE_DIR)  : join(ROOT, 'knowledge');

/**
 * ⚠️ 2026-09-21 加：**人设包目录**（`personas/<id>/`）。
 *
 * 为什么放在 config.js：`knowledge.js` 要按人设选 anime 库、`persona.js` 要读
 * `identity.json` —— 两边都需要这个路径，而它们**不能互相依赖**（会成环）。
 * 纯路径计算，放最底层最合适。
 *
 * ⚠️ **不要缓存**：`persona.id` 是可以在界面上热切换的，缓存住就换不动了。
 * ⚠️ `id` 做白名单校验（只允许字母数字点横线）—— 它从配置来，
 *    不能让一个 `../` 把读取带出项目目录。
 * ⚠️ `QQBOT_PERSONA_DIR` 让测试把整个人设包搬走；**绝对路径直接用**，
 *    相对路径按项目根解析（两种写法测试里都有人用，别拼出 `C:\x\C:\y` 那种怪东西）。
 */
export function personaId() {
  const raw = String(config?.persona?.id ?? 'saki').trim();
  return /^[\w.-]+$/.test(raw) ? raw : 'saki';
}
export const personaDir = () => {
  const env = process.env.QQBOT_PERSONA_DIR;
  if (env) return isAbsolute(env) ? env : join(ROOT, env);
  return join(ROOT, 'personas', personaId());
};

/**
 * 「**有限数才认**」的取值 —— 配置里读数字**一律用它**，别写 `Number(x) || 默认值`。
 *
 * ⚠️ 这个坑踩过两次，两个方向各一次：
 *   · `Number(undefined) ?? 默认值` —— `??` 只挡 null/undefined，**挡不住 NaN**
 *     （`friend.dailyChance` 就是这么算成 `null` 的）
 *   · `Number(0) || 默认值` —— **`0` 会被当成"没填"**
 *     （`quest.affinityBad: 0` 被悄悄改成 `1`；<主人> 想要"坏结局掉好感度"，
 *      结果配了个 0 反而变成 +1。见下面的 `affinityBad`。）
 */
const nz = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ⚠️ 用户**显式写过的**配置（原始 YAML）—— 给「收紧度」滑块用，
//    滑块只在用户没手写那一项时才接管它。
let __explicit = {};

const DEFAULTS = {
  onebot: {
    mode: 'forward',
    url: 'ws://203.0.113.10',
    accessToken: '',
    reconnectInterval: 3000,
  },
  llm: {
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.8,
    // ⚠️ 默认值也必须给足：主模型是推理模型时，思考会占 completion_tokens，
    //    800 会被思考吃光 → 正文空 → 群里出现「模型没有返回内容」（真实踩过）。
    //    config.yml 里现在是 4000；这里保持同样的量级，
    //    免得哪天 config.yml 被重置/丢失就退回危险值。
    maxTokens: 8000,
    timeout: 60000,
    // ⚠️ 超时**上限**（2026-09-13 加）：
    //    解题模式把 max_tokens 抬到 24000，而超时原来写死 60 秒 ——
    //    推理模型产 24k token 不可能 60 秒内完成 → **必然超时**
    //    （真实踩过：群里显示「⚠️ 模型调用出错了，请稍后再试」）。
    //    现在 `streamChat` 会按 token 预算放大超时，上限用这个值。
    timeoutMax: 180000,
    systemPrompt: '你是一个 QQ 聊天机器人，用简洁自然的中文回答。',
  },
  // ⚠️⚠️ 生图 —— 群里让她「拍个照」（2026-09-22 用户要求）。
  //
  //    **换服务商只改这一段**（provider / baseURL / apiKey / model 四行），
  //    功能代码（bot.js）不认识任何一家平台 —— 见 src/imagegen.js 文件头。
  //
  //    已经内置的两条路：
  //      · `ark`    —— 火山方舟 · 豆包 Seedream 4.0。参考图**支持 base64 直传**
  //                    （本地立绘不用图床），多图参考、人物一致性最好。
  //                    0.20 元/张，新模型有 200 张免费额度。
  //      · `openai` —— 任何 OpenAI 风格的 `/images/generations`（例如硅基流动的
  //                    `Qwen/Qwen-Image-Edit-2509`，0.30 元/张，文档写明支持 base64）。
  //
  //    ⚠️ `baseURL` / `model` 留空 = 用该 provider 的默认值（imagegen.js 里那张表）。
  //    ⚠️ `enable: false` 时，人设里那段「你可以拍照」**不会被注入提示词** ——
  //       模型不知道有这个能力，自然就不会写标记，比事后拦截干净。
  imagegen: {
    enable: false,
    provider: 'ark',
    baseURL: '',
    apiKey: '',
    model: '',
    // ⚠️ 留空 = 用该服务商的默认档位。两家的格式**不一样**
    //    （Ark 认 `2K`，OpenAI 系只认 `1024x1024`）—— 默认值唯一的出处是
    //    `src/imagegen.js` 的 `PROVIDERS`，别在这儿再抄一份。
    size: '',
    // 生图比聊天慢得多，别用 llm.timeout 那个量级
    timeoutMs: 180000,
    // 两家默认都会烧一行「AI 生成」水印，必须显式关掉（当客服发群里不能带）
    watermark: false,
    // ⚠️ **防连拍**，不是限额（用户明确说"不用限"）：
    //    同一个群/私聊这么久之内只拍一张 —— 挡住"模型一条回复写两个标记"
    //    和"连着被人刷"。设 0 = 彻底不限。
    cooldownMs: 60000,
    // ⚠️⚠️ **固定风格提示词**（2026-09-22 加）。它和"每次现算的那部分"是**两层**，
    //    用户原话：「要分清本来就有的默认提示词和后加的」：
    //      · **这一层**（画风：背景写实 / 人物二次元 / 随手拍感）→ 界面上改，代码不拼字段；
    //      · 另一层（**时间 / 地点 / 拍什么**）→ 每次现算，见 `src/photo-plan.js`。
    //    `self`  = 画面里**有她**时用的（自拍 / 别人帮她拍）；
    //    `scene` = 画面里**没有她**时用的（她拍下来的东西，比如校门、街景、货架）。
    //    ⚠️ 两层的分工不能混：这层只管"看起来像不像手机拍的、人是二次元还是真人"。
    style: {
      // ⚠️ 为什么必须把人物和环境**分开写画风**：参考立绘本身是动漫的，模型天然会把
      //    **整张图**都拉成动漫 ⇒ 环境就"二次元"了、写实的好处全丢。所以要显式钉住。
      self:
        '照片里的人是你本人，保持二维动画画风（动画线稿、赛璐璐上色）；' +
        '环境是完全写实的真实照片（真实材质、真实光影）。' +
        // ⚠️ 2026-09-22 用户看完第一张自拍后报的两条，都加在这儿：
        //  ①「自拍肯定看不到手机，这明显是别人给她拍的样子」——
        //     自拍 = 相机在手臂距离、**手机本体在镜头后面**，画面里不该出现手机。
        //  ②「真人突然要自拍不会一直都笑得这么开心，要有一种营业感」——
        //     神态要求改成"不用力"，而不是默认灿烂笑。
        // ⚠️⚠️ 2026-09-22 实测：只写"手机不会出现在画面里"**不够** ——
        //    因为"理解"那一步会在场景里写"举着手机自拍"，那句就把这条盖过去了
        //    （用户一眼看出："自拍肯定看不到手机，这明显是别人给她拍的样子"）。
        //    ⇒ 两处一起改：`photo-plan.js` 的规则里**禁止写手机**，这里则**正向**描述
        //      取景框里有什么（"只有她自己"），比单纯否定更容易被模型遵守。
        // ⚠️⚠️ 2026-09-22 第四次修（用户连报两次"太完美、像相机拍的"）。
        //    试过画质词、平淡光之后发现一个**结构性矛盾**：参考立绘是"干净完美的动漫画"，
        //    模型画她时自然给出干净的动漫渲染，而背景按"手机画质"走 ⇒
        //    两边质感对不上，看起来像**把她贴到一张真实照片上**（正脸大特写最容易暴露）。
        //    ⇒ 构图这一层最有效：**别占满画面、别正脸大特写**，用"随手抓拍"的取景，
        //      让动漫渲染和写实背景的落差被掩掉。
        '这是自拍：取景框里只有她自己，画面里看不到手机。' +
        '人物偏在画面一侧、别占满画面、别来正脸大特写，像随手抓拍。' +
        // ⚠️⚠️ 2026-09-22 第二次修（用户：「表情还是太笑了，不真实」）：
        //    第一版我写的是"带一点敷衍的**营业感**"—— 而「营业感」在中文里常被读成
        //    **营业式微笑**，模型于是照旧给她一个甜甜的笑 ✗
        //    ⇒ 改成**正面写死目标表情**（嘴闭合、嘴角不上扬、眼睛平静、不眯眼、不甜美），
        //      并显式排除"营业式微笑"这个词的歧义。光写"不要笑"没用 ——
        //      Seedream 没有负面提示词字段，**正面描述才是它真正照着画的东西**。
        '神态要平：嘴唇闭合、嘴角不上扬、眼睛平静 —— 不笑、不眯眼、不甜美（不是营业式微笑）。' +
        // ⚠️⚠️ 2026-09-22 第三次修（用户：「感觉画风还是有点不像手机拍出来的，过于完美了，
        //    饱和度、对比度太高了，更像是相机拍的，要多加一点手机拍照画质不够的提示词」）。
        //    ⇒ 原来只写了"噪点 + 轻微过曝"，那点信息量不足以把从单反/电影调色那边拉回来。
        //      手机照片真正"差"在：**动态范围窄**（亮部死白、暗部糊成一团）、
        //      **饱和度/对比度偏低、颜色发灰**、**细节不锐利、放大发虚**、
        //      **暗部降噪涂抹**、**白平衡不准**。这些都得**正面写出来**。
        '画质要像手机随手拍、而且不算好：饱和度低、对比度低、颜色发灰，' +
        '亮部死白、暗部糊成一团，细节不锐利，暗部有噪点和涂抹。' +
        '不是单反拍的：没有奶油虚化、没有电影级调色、没有美颜滤镜。' +
        '构图随意，光线平淡，曝光不准。',
      // ⚠️⚠️ 这段里**绝对不能出现"你"**：这条路**不带参考图**，模型不知道"你"是谁，
      //    会**凭空画一个人出来**（实测：要"学校正门"，出来一张真人女性特写）。
      //    ⇒ 无人称 + 明说画面里没有人（Seedream 没有负面提示词字段，否定只能内联写）。
      scene:
        '一张完全写实的真实照片（手机随手拍，画面里没有人）：真实材质、真实光影、真实景深。' +
        // ⚠️ 和 `self` 同一个理由（用户 2026-09-22：「过于完美了，饱和度、对比度太高了，
        //    更像是相机拍的」）：手机照片的"差"要**正面写出来** —— 窄动态范围、发灰、不锐利。
        '画质要像手机随手拍、而且画质不算好：饱和度低、对比度低、颜色发灰发淡，' +
        '亮部容易一片死白、暗部糊成一团（动态范围窄），细节不锐利、放大发虚，' +
        '暗部有降噪涂抹和噪点，白平衡偏。' +
        '不是单反拍的：没有奶油虚化、没有电影级调色、没有商业修图的干净和锐利。' +
        '构图随意、不像摄影作品，光线自然没有补光，可能有点手抖模糊或曝光不准，没有滤镜也没有美颜。',
    },
    // 拍照前那次「单独理解」的超时（见 src/photo-plan.js）
    planTimeoutMs: 10000,
    // ⚠️ 生成图**保留多少小时**就自动删掉（2026-09-22 用户要求：
    //    「图片肯定会越积越多，而且放在本地也没用，发出 1 天之后直接删掉就可以了」）。
    //    ⚠️ 删本地**不影响群里已发出的图** —— 发出去的是 base64 上传的副本。
    //    ⚠️ **只删 `library/photo/`**（`library/` 根目录是表情库，绝不碰）。
    //    ⚠️ 设成 `0` = 关掉自动清理（想留着当相册就设 0）。
    keepHours: 24,
  },
  // ⚠️ API 余额 = 小祥的「工资」（2026-09-13 用户要求）
  //    低于下面档位就抱怨一次（按档位只报一次，落盘 state/balance.json）
  balance: {
    enable: true,
    checkIntervalMs: 1800000, // 半小时查一次
    low: 5,                   // 低于 5 元抱怨一次
    critical: 2,              // 低于 2 元再抱怨一次
    timeoutMs: 15000,
    quietMs: 180000, // 群最后一条消息超过这么久才算「没人说话」（3 分钟）
  },
  // 记账：问「今天花了多少钱 / 这个月用了多少 token」时报数据（2026-09-13）
  spend: {
    enable: true,
  },
  trigger: {
    privateChat: true,
    groupChat: true,
    allowGroups: [],
    debugInjectIds: [],
    /**
     * 群里回复灵敏度，三档：
     *   1 = 只要有能回答的消息就马上回（最活跃，token 消耗最大）
     *   2 = 只有跟服务器有关、或者在聊机器人自己的消息才回
     *   3 = 只有 @ 机器人才回（最安静）
     */
    respondTo: 2,
    /** 兼容旧配置：true 等价于 respondTo=3，false 等价于 respondTo=1 */
    requireAtInGroup: true,
    keywords: [],
    historyRounds: 6,
    cooldownMs: 1500,
    maxInputChars: 1000,
  },
  /** 回答时参考的群聊上下文 */
  context: {
    enable: true,
    /** 最多带几条前面的消息 */
    maxMessages: 15,
    /** 超过这个时间的消息不带了（毫秒），默认 30 分钟 */
    maxAgeMs: 1800000,
    /** 展开的合并转发内容保留多久（之后追问「里面是什么」还能答上来） */
    forwardTtlMs: 600000,
    /** 上下文字数上限，防止撑爆提示词 */
    maxChars: 1200,
  },
  /** NapCat 自己的管理接口（看 QQ 登录状态、出二维码） */
  napcat: {
    enable: true,
    webuiHost: '203.0.113.10',
    webuiPort: 6099,
    /** 留空则自动从 napcat/NapCat.Shell/config/webui.json 读 */
    webuiToken: '',
    timeoutMs: 15000,
    quietMs: 180000, // 群最后一条消息超过这么久才算「没人说话」（3 分钟）
  },
  /**
   * QQ 协议端（OneBot 实现）—— 2026-09-17 加（用户要求「能换协议端」）。
   *
   * ⚠️ 为什么要有这一层：机器人**只通过 OneBot 协议**跟协议端说话，
   *    「收消息/发消息」这部分**跟协议端无关**（换谁都是 ws + token）；
   *    但**管理面**各家差很多：
   *      · NapCat 有自己的 WebUI/HTTP 接口 → 我们能代你出码、重启、快速登录；
   *      · LLBot 是独立应用，有自己的 WebUI/GUI → 那些操作去它界面里做；
   *      · 通用 OneBot 实现**什么管理面都没有**。
   *    所以换协议端 = **改这里**，代码不用动；不支持的能力会明确说"不支持"，不装作能用。
   *
   * ⚠️ 商用提示（详见 README / THIRD-PARTY-NOTICES.md）：
   *    NapCat 自定义许可**禁止商用**；LLBot 是 GPL-2.0（可商用，但**分发**要带源码）；
   *    真正"官方许可"的只有 QQ 开放平台 / 企业微信。
   */
  /**
   * ⚠️ 2026-09-21 加：**用哪个人设包**（`personas/<id>/`）。
   *
   * 人设相关的 md（persona.md / persona-money.md / persona-media.md / voices.md）
   * 从 `personas/<id>/` 读；`knowledge/` 只剩"所有角色共用"的那些
   * （服务器库、群记忆、owner、learned、anime…）。
   * ⇒ **换人设 = 改这一个值**，别的都不用动。
   *
   * ⚠️ 不写就是 `saki`（老配置不受影响）。
   * ⚠️ 这里的值会被 `knowledge.js` 做白名单校验（只允许字母数字点横线），
   *    免得一个 `../` 把它带出项目目录。
   */
  persona: {
    id: 'saki',
  },
  provider: {
    /** napcat | llonebot | snowluma | onebot（通用：只保证 OneBot 收发） */
    name: 'napcat',
    /** 协议端目录（启动/守护脚本要用）。留空 → napcat 用 ../napcat/NapCat.Shell */
    dir: '',
    /** 启动脚本/可执行（相对 dir 或绝对路径）。留空 → napcat 用 launcher-win10-user.bat */
    launcher: '',
    /** 它自己的管理界面地址（只用于在机器人界面里给你一个可点的链接） */
    manageUrl: '',
  },
  /** 反向图搜（SauceNAO）—— 认二次元角色和出处 */
  saucenao: {
    enable: true,
    /** 在 https://saucenao.com/user.php?page=search-api 拿 */
    apiKey: '',
    /** 返回几条 */
    results: 5,
    /** 相似度低于这个的不采信（低了会误导） */
    minSimilarity: 60,
  },
  /** 联网搜索：用 Bing 网页抓取（免费，不用注册） */
  search: {
    enable: true,
    /** 返回几条结果 */
    results: 5,
    /**
     * 默认是「先搜再答」——用户要求：除了服务器和知识库有的，其他都先上网查。
     * 下面这几类跳过（搜了反而更差）：
     */
    skipWhen: {
      /** 纯情绪倾诉（安慰场景不该甩搜索结果） */
      emotion: true,
      /** 纯寒暄/应声/玩梗（没有事实可查） */
      chitchat: true,
      /** 服务器内部问题（本地知识库有权威答案，搜网页可能搜到过时的） */
      server: true,
    },
    /** 用模型规划搜索词（比正则聪明；关掉就退回正则） */
    planWithModel: true,
    /** 规划调用超时 */
    planTimeoutMs: 15000,
    /** 单次搜索超时 */
    timeoutMs: 20000,
  },
  /** 识图：把群友发的图交给带视觉的模型识别 */
  vision: {
    enable: true,
    /** 用哪个模型看图。deepseek-flash 细节最全（推理模型，慢但准）；deepseek-chat 快但粗 */
    model: 'deepseek-flash',
    /** 要不要也识别表情包（默认不识别，省 token 且没必要） */
    describeStickers: false,
    /** 图片大小上限（字节），超过就跳过 */
    maxBytes: 8388608,
  },
  /** 系统状态：把电脑当成小祥的工作电脑 */
  machine: {
    enable: true,
    /** 电脑的名字（她自己的叫法） */
    name: '',
    /** 定时上报的间隔（毫秒），0 = 关闭 */
    reportIntervalMs: 0,
  },
  /** QQ 空间：偶尔把群里的趣事发到空间 */
  qzone: {
    enable: false,
    /** 自动判断该不该发（false = 只能手动） */
    auto: true,
    /** 查看权限：1 所有人可见 / 4 好友可见 / 16 部分好友 / 64 仅自己 / 128 部分不可见 */
    ugcRight: 1,
    /** 每天最多发几条 */
    maxPerDay: 2,
    /** 两次之间最短间隔（默认 4 小时） */
    cooldownMs: 8 * 3600 * 1000,
    /** 多少毫秒检查一次要不要发（默认 20 分钟） */
    checkIntervalMs: 20 * 60 * 1000,
    /** 攒素材的时间窗（默认 12 小时） */
    windowMs: 12 * 3600 * 1000,
    /** 至少攒够多少条素材才考虑自动发 */
    minMaterial: 14,
    /** 准备发的时候，最新的素材不能超过这个时间（默认 1 小时），否则说明群里没动静 */
    maxMaterialAgeMs: 60 * 60 * 1000,
    /** 最多取多少条素材给模型挑 */
    maxMaterial: 60,
    /** 说说正文长度上限 */
    maxChars: 1000,
    /** 素材最小长度 */
    minChars: 4,
  },
  status: {
    enable: false,
    host: '',
    displayName: '服务器',
    cacheSeconds: 60,
    keywords: [],
    apiBase: 'https://api.mcstatus.io/v2/status/java',
  },
  teach: {
    enable: true,
    teachers: [],
    requireOwnerRole: true,
    allowPrivateTeach: false,
    /** 自然教学：正常说话就能教会它，不用记格式 */
    naturalLearning: true,
    /** auto = 直接记下；confirm = 先反问确认；off = 只认关键词 */
    confirmMode: 'auto',
    keywords: [],
  },
  faces: {
    /** 是否自动收集群里发的表情包（进 library/_pending 等审核） */
    collect: true,
  },
  /** 主动接话：群里没 @ 它，也可能插一句。分「回答问题」和「被提到」两种场景 */
  chat: {
    /**
     * ⚠️ 2026-09-21 加：**正在生成回复时，他（同一个人）又发消息 → 最多"丢掉草稿重来"几次**。
     *
     * 用户原话：「这个就是没有把靠近的消息合并的问题」——
     * 他 @ 她一下、紧接着又补一句，原来会**回两条**（各带一个引用框）。
     * 现在改成：发现"他还在说"就**把这一版草稿丢掉、带着新消息重新生成**，
     * 群里只出现一条回复。
     *
     * · `0` = 关掉这个行为（退回"生成完再处理那一批"的老样子，也就是回两条）；
     * · 默认 `2` —— 留个上限，不然他一直刷，她就永远不说话（到顶后照常发出）。
     *
     * ⚠️ 只有**同一个人**连发才打断；别人插话不动这一轮（那本来就是另一件事）。
     * ⚠️ 丢弃的前提是"这一个字都还没发出去"，所以对群里没有可见代价（只多花一次模型调用）。
     */
    requeueMax: 2,
    enable: false,
    group: '',
    question: {
      enable: true,
      keywords: [],
      probability: 0.6,
      cooldownMs: 180000,
      requireQuestionMark: true,
      minChars: 5,
    },
    mention: {
      enable: true,
      names: [],
      probability: 0.4,
      cooldownMs: 300000,
      minChars: 2,
    },
    /** 对话延续：已经聊上了就继续接，直到静默超时 */
    followUp: {
      enable: true,
      idleMs: 180000,
      /**
       * ⚠️ **同一个人**接着跟她说时的窗口（比 `idleMs` 长）。
       *
       * 2026-09-15 用户实测报的问题（截图）：
       *   @她问「最近籽岷有什么新视频」→ 她答完 → **85 秒后**他接着问
       *   「那最近mc圈有什么炸裂的视频」→ **她压根没接**（日志里连这条消息都没有）。
       * 根因：`idleMs` 被收紧度压到 50 秒（config.yml 里还写着 25 秒），
       * 85 秒早就出窗口了 —— 可那明明就是**在跟她说话**。
       *
       * 所以单开一个窗口：**刚才在跟她聊的那位**接着说，3 分钟内都算"对话延续"
       * （仍然要过 speak-judge，不是"必接"）。
       */
      sameUserMs: 180000,
      probability: 1,
      minChars: 2,
    },
    /** 灵敏度=1 时的「随便接话」档（跟服务器无关的闲聊也接） */
    anyMessage: {
      enable: true,
      // ⚠️ 2026-09-13 收紧（用户要求「少说一定比多说要好，真需要机器人时我们会 @ 他」）：
      //    0.35 → 0.15。这层是"自由接话"，最容易显得话多。
      probability: 0.15,
      cooldownMs: 120000,
      minChars: 4,
    },
    /** 有人发了张图（可能是晒建筑 / 作品）时，捧场 */
    share: {
      enable: true,
      // ⚠️ 2026-09-13 收紧：0.8 → 0.4（同上，少说比多说好）
      probability: 0.4,
      cooldownMs: 90000,
    },
    /** 有人只发了个表情包（没配文字）时，接不接梗 */
    sticker: {
      enable: true,
      probability: 0.5,
      cooldownMs: 120000,
      /** 他发的是自己常用的那张 → 原样发回去（「用你的表情回你」） */
      echo: true,
      echoProbability: 0.7,
      echoCooldownMs: 180000,
    },
  },
  /** 生气、还击、否认自己是机器人 */
  attitude: {
    allowAnger: true,
    allowRetort: true,
    denyBeingBot: true,
  },
  ownerQQ: '',
  botQQ: '',
  adminQQ: '',
  chunking: {
    maxChars: 260,
    delayMs: 700,
    firstFlushChars: 90,
  },
  webui: {
    enable: true,
    host: '203.0.113.10',
    port: 3099,
  },
  logLevel: 'info',
};

/** 递归合并：用户配置覆盖默认值 */
function merge(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || typeof base !== 'object') return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? merge(base[k], v) : v;
  }
  return out;
}

function load() {
  const path = CONFIG_FILE;
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`找不到配置文件 ${path}`);
  }

  let parsed;
  try {
    parsed = yaml.load(raw) ?? {};
  } catch (e) {
    throw new Error(`config.yml 格式错误: ${e.message}`);
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config.yml 顶层必须是一个对象（键值对）');
  }

  const cfg = merge(DEFAULTS, parsed);

  // ⚠️ 2026-09-13：把**用户显式写过的配置**记下来，给「收紧度」滑块用。
  //    滑块只在用户**没手写**那一项时接管它 —— 否则用户手调的值会被悄悄覆盖，
  //    那种 bug 极难查（"我明明设了 0.5，怎么变成 0.18 了"）。
  __explicit = parsed && typeof parsed === 'object' ? parsed : {};

  // 归一化容易写错的字段
  cfg.onebot.mode = String(cfg.onebot.mode || 'forward').toLowerCase();
  if (!['forward', 'reverse'].includes(cfg.onebot.mode)) {
    throw new Error(`onebot.mode 只能是 forward 或 reverse，当前是 "${cfg.onebot.mode}"`);
  }

  // ── ⚠️ 2026-09-20：允许**从命令行参数 / 环境变量覆盖接入点** ──────────────
  //
  // 用户要求（原话）：「给项目加个标准入口，支持从参数或环境变量读
  //   `onebot.url` / token，不用手改 config.yml」。
  //
  // 为什么需要：想让**别的管理器**（LLBot 的「对接框架」、任何部署脚本）
  //   一键把它拉起来 —— 那种场景它们**不该改我们的配置文件**，
  //   而是把地址 / token 传进来。这也是"能被别人一键接入"的技术前提。
  //
  // 优先级：**命令行参数 > 环境变量 > config.yml**（越临时的越优先）。
  // 两种写法都行：
  //   node src/index.js --onebot-url ws://203.0.113.10 --onebot-token abc --bot-qq 123456
  //   QQBOT_ONEBOT_URL=… QQBOT_ONEBOT_TOKEN=… QQBOT_BOT_QQ=… node src/index.js
  //
  // ⚠️ **只覆盖这三项** —— 别把它扩成"通用配置通道"：那样 config.yml 会失去意义，
  //    而且排错时根本看不出某个值到底从哪来。
  // ⚠️ 覆盖过什么记在 `cfg.__overridden` 里（启动时打印出来，见 `src/index.js`）——
  //    "我明明在 config.yml 里改了，怎么不生效"这种问题，全靠它一眼看出。
  {
    const argv = process.argv.slice(2);
    const argOf = (name) => {
      const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
      if (i < 0) return null; // ⚠️ null = 没传。**不能拿空串当"没传"** —— token 允许就是空的
      const hit = argv[i];
      if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
      const next = argv[i + 1];
      return next && !next.startsWith('--') ? next : '';
    };
    const envOrNull = (k) => (process.env[k] === undefined ? null : process.env[k]);
    const pick = (name, envName) => {
      const a = argOf(name);
      return a !== null ? a : envOrNull(envName);
    };

    const urlOverride = pick('onebot-url', 'QQBOT_ONEBOT_URL');
    if (urlOverride !== null && String(urlOverride).trim()) {
      cfg.onebot.url = String(urlOverride).trim();
      cfg.__overridden = [...(cfg.__overridden ?? []), `onebot.url = ${cfg.onebot.url}`];
    }
    const tokenOverride = pick('onebot-token', 'QQBOT_ONEBOT_TOKEN');
    if (tokenOverride !== null) {
      cfg.onebot.accessToken = String(tokenOverride).trim();
      // ⚠️ 只说"覆盖过"，**不把 token 的值写进去**（那是要保密的东西）
      cfg.__overridden = [...(cfg.__overridden ?? []), 'onebot.accessToken'];
    }
    const qqOverride = pick('bot-qq', 'QQBOT_BOT_QQ');
    if (qqOverride !== null && String(qqOverride).trim()) {
      cfg.botQQ = String(qqOverride).trim();
      cfg.__overridden = [...(cfg.__overridden ?? []), `botQQ = ${cfg.botQQ}`];
    }
  }
  cfg.logLevel = String(cfg.logLevel || 'info').toLowerCase();
  cfg.trigger.keywords = (cfg.trigger.keywords ?? [])
    .filter((k) => typeof k === 'string' && k.trim())
    .map((k) => k.trim().toLowerCase());
  cfg.trigger.historyRounds = Math.max(0, Number(cfg.trigger.historyRounds) || 0);
  // 灵敏度：取 1/2/3，非法值回落到 2
  cfg.trigger.respondTo = [1, 2, 3].includes(Number(cfg.trigger.respondTo))
    ? Number(cfg.trigger.respondTo)
    : 2;
  // 分群灵敏度覆盖：{ "群号": 1|2|3 }，只保留合法值（用户要求「分群调节」）
  cfg.trigger.groupRespondTo = Object.fromEntries(
    Object.entries(cfg.trigger.groupRespondTo ?? {})
      .map(([g, v]) => [String(g).trim(), Number(v)])
      .filter(([g, v]) => /^\d+$/.test(g) && [1, 2, 3].includes(v)),
  );

  cfg.context.enable = cfg.context.enable !== false;
  cfg.context.maxMessages = Math.max(0, Number(cfg.context.maxMessages) || 0);
  cfg.context.maxAgeMs = Math.max(60000, Number(cfg.context.maxAgeMs) || 1800000);
  cfg.context.maxChars = Math.max(200, Number(cfg.context.maxChars) || 1200);
  cfg.context.forwardTtlMs = Math.max(60000, Number(cfg.context.forwardTtlMs) || 600000);
  // 连发消息合并（同一个人短时间内发好几条 → 合成一次回复）
  // 群友性格/大事的暗中观察（后台攒够条数自动总结）
  // 「该不该接这句」—— 用模型判断代替概率抽签（用户要求：像真人一样自己决定）
  // 别的机器人的指令 —— 消息内容就是这些时，不响应（那是叫别人的）
  // 用户要求：「机器人需自动无视关键词『list』和『李斯特』」
  cfg.trigger.otherBotCommands = Array.isArray(cfg.trigger.otherBotCommands)
    ? cfg.trigger.otherBotCommands.map(String)
    : ['list', '李斯特'];

  cfg.speakJudge = cfg.speakJudge ?? {};
  cfg.speakJudge.enable = cfg.speakJudge.enable !== false;
  // 判断的短超时（它挡在每条消息必经之路上，不能拖）
  cfg.speakJudge.timeoutMs = Math.max(2000, Number(cfg.speakJudge.timeoutMs) || 6000);

  // 群禁言（用户要求 2026-09-13）：刷屏时真的禁言 1 分钟
  // ⚠️ 禁言是**公开的社交动作**，所以只给明确的刷屏用，且台词必须轻
  // 读引用内容（用户要求 2026-09-13）：引用段只有 id，要用 get_msg 查原文
  cfg.context = cfg.context ?? {};
  cfg.context.readQuote = cfg.context.readQuote !== false;

  cfg.mute = cfg.mute ?? {};
  cfg.mute.enable = cfg.mute.enable !== false;
  cfg.mute.seconds = Math.max(1, Number(cfg.mute.seconds) || 60);
  // 同一个人多久之内不重复禁言
  cfg.mute.cooldownMs = Math.max(10000, Number(cfg.mute.cooldownMs) || 300000);

  // 玩家在线时长跟踪（用户要求 2026-09-12：能读取玩家上线时间吗）
  // 自己每 60 秒查一次名单，记下谁什么时候上来的 —— API 不给这个信息
  cfg.sessions = cfg.sessions ?? {};
  cfg.sessions.enable = cfg.sessions.enable !== false;
  // ⚠️ 2026-09-13：默认从 60 秒缩到 **30 秒**（用户反馈「上下服时间不对」）——
  //    精度上限就是轮询间隔，缩一半精度就翻倍。有人时才用这个频率。
  cfg.sessions.checkIntervalMs = Math.max(15000, Number(cfg.sessions.checkIntervalMs) || 30000);
  // 没人在线时用这个（省点力气，晚一两分钟发现有人上线也可以接受）
  cfg.sessions.idleIntervalMs = Math.max(30000, Number(cfg.sessions.idleIntervalMs) || 180000);

  // 解题模式（用户要求 2026-09-12）：识别到数学/物理/化学题时，认真解题 + 抬高 token
  cfg.solve = cfg.solve ?? {};
  cfg.solve.enable = cfg.solve.enable !== false;
  // 解题时的 max_tokens —— 比平时大得多，因为推理模型的思考链也算进 completion_tokens
  cfg.solve.maxTokens = Math.max(8000, Number(cfg.solve.maxTokens) || 24000);

  // 发言前核对「在给谁发消息」（防认错人，用户强制要求）
  cfg.attribution = cfg.attribution ?? {};
  cfg.attribution.enable = cfg.attribution.enable !== false;
  // 太短的回复跳过核对（十几个字的接梗不涉及归属）
  cfg.attribution.minChars = Math.max(0, Number(cfg.attribution.minChars) || 12);
  cfg.attribution.timeoutMs = Math.max(2000, Number(cfg.attribution.timeoutMs) || 8000);

  // 防刷屏：同一个人短时间内连发多条 → 劝一句后闭麦，直到他停手
  cfg.flood = cfg.flood ?? {};
  cfg.flood.enable = cfg.flood.enable !== false;
  // 统计窗口（毫秒）
  cfg.flood.windowMs = Math.max(1000, Number(cfg.flood.windowMs) || 10000);
  // 窗口内发够这么多条就算刷屏
  cfg.flood.count = Math.max(3, Number(cfg.flood.count) || 6);
  // 闭麦时长：他每发一条就刷新，所以他停手够久才恢复
  cfg.flood.muteMs = Math.max(5000, Number(cfg.flood.muteMs) || 60000);

  // 有人拍一拍就拍回去
  cfg.poke = cfg.poke ?? {};
  // ⚠️ 默认**不发**戳一戳的包（2026-09-13，防 QQ 风控）——
  //    发包能力在当前 QQ 版本上必然失败，每次失败都是给风控送证据。
  //    降级 QQ 之后可以改成 true 恢复真戳一戳。
  // ⚠️⚠️ 2026-09-21 改（原来是 `=== true`，等于把"没配置"也压成 false）：
  //    **保留"没配置"这个状态** —— 让 `bot.js` 能按协议端给不同默认值：
  //      · snowluma：独立协议实现，`send_poke` 是它自己 action 表里的一个 ⇒ 默认**发**
  //      · napcat  ：走 PacketBackend、QQ 版本越界必然失败 ⇒ 默认**不发**
  //    只认显式配置：`true` = 一定发，`false` = 一定不发，**不写 = 按协议端**。
  //    ⚠️ 踩过：写成 `=== true` 之后"没配置"和"显式关掉"就分不开了 ——
  //      我加了"按协议端默认"，结果 snowluma 下照样不发包（用户戳了一下，日志里什么都没有）。
  if (cfg.poke.tryPacket !== undefined) cfg.poke.tryPacket = cfg.poke.tryPacket === true;
  cfg.poke.enable = cfg.poke.enable !== false;
  // 同一个人多久内只回拍一次（防刷屏）
  cfg.poke.cooldownMs = Math.max(1000, Number(cfg.poke.cooldownMs) || 30000);
  // ⚠️⚠️ 2026-09-21（用户要求）：「机器人戳回来的话在我戳了3次再触发一次就行了」
  //    → 同一个人的戳**攒次数**，每这么多下回拍一次（拍完归零，也就是第 3、6、9… 次）。
  //    ⚠️ 它只管"拍回去"；**文字回应不受它影响**（那个走上面的 `cooldownMs`，
  //      用户明确说了"还是直接和之前一样给回复好一点"）。
  cfg.poke.countPerBack = Math.max(1, Number(cfg.poke.countPerBack) || 3);
  // 发包能力不可用时（QQ 版本越界），退化成用文字回应
  cfg.poke.fallbackText = cfg.poke.fallbackText !== false;
  // ⚠️⚠️ 2026-09-16：**戳一戳交给模型回**（用户要求：
  //     「把戳一戳返回的消息也加入 llm 和上下文，要不然戳一下总是回那几句话」）。
  //     true（默认）= 把这次戳当成一条带 `[戳一戳]` 正文的消息走完整条路
  //     （带上下文、进记忆、回答由模型生成）；
  //     false = 退回老写法（从那四句写死的里随机挑一句）。
  cfg.poke.useLLM = cfg.poke.useLLM !== false;

  // ⚠️ 「喊妈妈」：第一次拒绝，还喊就认了并切**白祥模式**（2026-09-16 用户要求）。
  //    · perUser    同一个人叫到第几次就认（默认 2 = 第二次）
  //    · groupTotal 或者群里累计几次就认（默认 3 = 一群人在起哄，按人次）
  //    · windowMs   计数窗口（默认 30 分钟：太久没叫就重新从"第一次"算）
  //    · modeMs     白祥模式撑多久（默认 2 小时；期间每叫一次会续期）
  //    细则见 src/mama.js 顶部。
  cfg.mama = cfg.mama ?? {};
  cfg.mama.enable = cfg.mama.enable !== false;
  cfg.mama.perUser = Math.max(1, Number(cfg.mama.perUser) || 2);
  cfg.mama.groupTotal = Math.max(1, Number(cfg.mama.groupTotal) || 3);
  cfg.mama.windowMs = Math.max(0, Number(cfg.mama.windowMs ?? 30 * 60 * 1000));
  cfg.mama.modeMs = Math.max(0, Number(cfg.mama.modeMs ?? 2 * 60 * 60 * 1000));

  cfg.observe = cfg.observe ?? {};
  cfg.observe.enable = cfg.observe.enable !== false;
  // 攒够多少条群消息就总结一次
  cfg.observe.threshold = Math.max(20, Number(cfg.observe.threshold) || 200);
  // 多久检查一次（毫秒）
  cfg.observe.checkIntervalMs = Math.max(60000, Number(cfg.observe.checkIntervalMs) || 600000);

  cfg.context.batch = cfg.context.batch ?? {};
  cfg.context.batch.enable = cfg.context.batch.enable !== false;
  cfg.context.batch.windowMs = Math.max(0, Number(cfg.context.batch.windowMs ?? 800));
      // ⚠️ 被 @ / 引用时的合并窗口（短很多）—— 那是明确提问，人在等答案
      //    （2026-09-13 用户反馈「回答速度慢了很多…不用等待太久」）
      cfg.context.batch.windowMsAtMe = Math.max(0, Number(cfg.context.batch.windowMsAtMe ?? 300));
      // ⚠️⚠️ 2026-09-16：**连发碎片的自动续窗**（用户截图报的「多信息合并的极端情况」）。
      //    他一个字一个字地发（或连发一串表情）时，固定的 900/1200ms 窗口接不住 ——
      //    每条都掉在窗口外面，于是被她当成好几句分别答。这四个数就是那套旋钮：
      //      · burstShortChars：多短算「碎片」（1 个字的文本、纯表情/纯图都算）
      //      · burstQuietMs：  碎片进入「连发模式」后，安静这么久才认为他说完了
      //      · burstGapMs：    判定「还在同一串里」的最大间隔（超了就重新起一串）
      //      · burstMaxMs：    一串最多等这么久，到点就按普通窗口发（防刷屏堵嘴）
      //    ⚠️ 只对**碎片**生效，正常一句话照旧 900/1200ms（不然什么都变慢）。
      cfg.context.batch.burstShortChars = Math.max(1, Number(cfg.context.batch.burstShortChars ?? 3));
      cfg.context.batch.burstQuietMs = Math.max(0, Number(cfg.context.batch.burstQuietMs ?? 2500));
      cfg.context.batch.burstGapMs = Math.max(0, Number(cfg.context.batch.burstGapMs ?? 2000));
      cfg.context.batch.burstMaxMs = Math.max(0, Number(cfg.context.batch.burstMaxMs ?? 20000));

  // ⚠️ 「一个字一条」的彩蛋（2026-09-16 用户拍板：加，私聊随便玩、群里只在 @她/引用她 时）：
  //    别人一个字一条说话时，她可以**一个字一个气泡**回过去。
  //    ⚠️ 玩不玩由模型决定（它要按"一个字一行"写），这里管的是"能不能真的发出来"：
  //      · max：最多几个字，超了退回一整句（防刷屏）
  //      · cooldownMs：同一个会话多久最多玩一次
  //      · groupNeedsSummon：群里是不是必须有明确召唤（@她/引用她/点名叫她）
  cfg.chunking.charSplit = cfg.chunking.charSplit ?? {};
  cfg.chunking.charSplit.enable = cfg.chunking.charSplit.enable !== false;
  cfg.chunking.charSplit.max = Math.max(3, Number(cfg.chunking.charSplit.max ?? 8));
  cfg.chunking.charSplit.cooldownMs = Math.max(
    0,
    Number(cfg.chunking.charSplit.cooldownMs ?? 30 * 60 * 1000),
  );
  cfg.chunking.charSplit.groupNeedsSummon =
    cfg.chunking.charSplit.groupNeedsSummon !== false;

  cfg.napcat.enable = cfg.napcat.enable !== false;
  cfg.napcat.webuiPort = Math.max(1, Number(cfg.napcat.webuiPort) || 6099);
  cfg.napcat.webuiToken = String(cfg.napcat.webuiToken ?? '').trim();
  cfg.napcat.timeoutMs = Math.max(3000, Number(cfg.napcat.timeoutMs) || 15000);

  // ── 协议端（provider）────────────────────────────────────
  // ⚠️ 默认 napcat：老配置里没有这一段，行为必须和以前完全一样（向后兼容）。
  // ⚠️⚠️ 2026-09-20：加 `snowluma`。**这行不改的话，config 里写 `name: snowluma`
  //    会被归一化成 `onebot`**（原值只留在 `provider.nameRaw` 里）——
  //    实测踩到：`provider.js` 明明加了 snowluma 档，机器人启动日志却打
  //    `已连接到协议端（onebot）`、caps 也是通用那份，查了半天才定位到这里。
  const KNOWN_PROVIDERS = new Set(['napcat', 'llonebot', 'snowluma', 'onebot']);
  cfg.provider = cfg.provider ?? {};
  const rawProvider = String(cfg.provider.name ?? 'napcat').trim().toLowerCase();
  // 不认识的名字**退回通用 OneBot** 而不是让机器人挂掉（拼错了也能跑，只是管理面少）
  cfg.provider.name = KNOWN_PROVIDERS.has(rawProvider) ? rawProvider : 'onebot';
  cfg.provider.nameRaw = rawProvider;
  cfg.provider.dir = String(cfg.provider.dir ?? '').trim();
  cfg.provider.launcher = String(cfg.provider.launcher ?? '').trim();
  cfg.provider.manageUrl = String(cfg.provider.manageUrl ?? '').trim();

  cfg.saucenao.enable = cfg.saucenao.enable !== false;
  cfg.saucenao.apiKey = String(cfg.saucenao.apiKey ?? '').trim();
  cfg.saucenao.results = Math.min(10, Math.max(1, Number(cfg.saucenao.results) || 5));
  cfg.saucenao.minSimilarity = Math.min(99, Math.max(0, Number(cfg.saucenao.minSimilarity) || 60));

  cfg.search.enable = cfg.search.enable !== false;
  cfg.search.results = Math.min(10, Math.max(1, Number(cfg.search.results) || 5));
  cfg.search.timeoutMs = Math.max(5000, Number(cfg.search.timeoutMs) || 20000);
  cfg.search.planWithModel = cfg.search.planWithModel !== false;
  cfg.search.planTimeoutMs = Math.max(3000, Number(cfg.search.planTimeoutMs) || 15000);
  // 合并式预搜索：一次调用决定「搜不搜/搜什么/要不要读正文」，然后执行
  // 设为 false 退回旧的三步流程（规划 → 搜索 → 回答）
  cfg.search.merged = cfg.search.merged !== false;
  cfg.search.mergedTimeoutMs = Math.max(10000, Number(cfg.search.mergedTimeoutMs) || 45000);

  cfg.search.skipWhen = cfg.search.skipWhen ?? {};
  for (const k of ['emotion', 'chitchat', 'server']) {
    // 合并式预搜索：一次调用决定「搜不搜/搜什么/要不要读正文」，然后执行
  // 设为 false 退回旧的三步流程（规划 → 搜索 → 回答）
  cfg.search.merged = cfg.search.merged !== false;
  cfg.search.mergedTimeoutMs = Math.max(10000, Number(cfg.search.mergedTimeoutMs) || 45000);

  cfg.search.skipWhen[k] = cfg.search.skipWhen[k] !== false;
  }

  cfg.vision.enable = cfg.vision.enable !== false;
  cfg.vision.model = String(cfg.vision.model ?? 'deepseek-flash').trim() || 'deepseek-flash';
  cfg.vision.describeStickers = cfg.vision.describeStickers === true;
  cfg.vision.maxBytes = Math.max(1024*100, Number(cfg.vision.maxBytes) || 8388608);
  // 识图慢时先甩一句「等一下」稳住对方（0=关掉这个行为）
  cfg.vision.ackAfterMs = Math.max(0, Number(cfg.vision.ackAfterMs ?? 9000));
  // 识图**关掉思考链**（实测快 3.2 倍、描述还更长）。想开就设 true
  cfg.vision.thinking = cfg.vision.thinking === true;

  cfg.machine.enable = cfg.machine.enable !== false;
  cfg.machine.name = String(cfg.machine.name ?? '').trim();
  cfg.machine.reportIntervalMs = Math.max(0, Number(cfg.machine.reportIntervalMs) || 0);

  const qz = cfg.qzone;
  qz.enable = qz.enable === true; // 默认关，得显式打开
  qz.auto = qz.auto !== false;
  qz.ugcRight = [1, 4, 16, 64, 128].includes(Number(qz.ugcRight)) ? Number(qz.ugcRight) : 1;
  qz.maxPerDay = Math.max(1, Number(qz.maxPerDay) || 2);
  qz.cooldownMs = Math.max(10 * 60 * 1000, Number(qz.cooldownMs) || 8 * 3600 * 1000);
  qz.checkIntervalMs = Math.max(60 * 1000, Number(qz.checkIntervalMs) || 20 * 60 * 1000);
  qz.windowMs = Math.max(60000, Number(qz.windowMs) || 12 * 3600 * 1000);
  qz.minMaterial = Math.max(1, Number(qz.minMaterial) || 14);
  qz.maxMaterialAgeMs = Math.max(60000, Number(qz.maxMaterialAgeMs) || 60 * 60 * 1000);
  qz.maxMaterial = Math.max(5, Number(qz.maxMaterial) || 60);
  qz.maxChars = Math.max(50, Number(qz.maxChars) || 1000);
  qz.minChars = Math.max(0, Number(qz.minChars) || 4);
  cfg.trigger.allowGroups = (cfg.trigger.allowGroups ?? [])
    .filter((g) => g !== null && g !== undefined && String(g).trim())
    .map((g) => String(g).trim());
  cfg.trigger.debugInjectIds = (cfg.trigger.debugInjectIds ?? [])
    .filter((g) => g !== null && g !== undefined && String(g).trim())
    .map((g) => String(g).trim());
  cfg.status.keywords = (cfg.status.keywords ?? [])
    .filter((k) => typeof k === 'string' && k.trim())
    .map((k) => k.trim().toLowerCase());
  cfg.status.cacheSeconds = Math.max(5, Number(cfg.status.cacheSeconds) || 60);
  cfg.status.host = String(cfg.status.host ?? '').trim();

  cfg.teach.teachers = (cfg.teach.teachers ?? [])
    .filter((g) => g !== null && g !== undefined && String(g).trim())
    .map((g) => String(g).trim());
  // ⚠️ 这些号是**机器人**，不许教它（否则会一直学重复的自动回复）。
  //    Q群管家 = 2854196310：群机器人，NapCat 把它标成 admin，
  //    所以它 @新人 的欢迎语会被误当成「管理员在教学」（真实踩过）。
  cfg.teach.bots = (cfg.teach.bots ?? ['2854196310'])
    .filter((g) => g !== null && g !== undefined && String(g).trim())
    .map((g) => String(g).trim());
  // 超过这个长度就不当教学（教学是一句话，不是一段文章）
  cfg.teach.maxTeachChars = Math.max(20, Number(cfg.teach.maxTeachChars) || 120);
  // 教学关键词必须出现在前 N 个字内（允许前面有个 @称呼）
  cfg.teach.keywordMaxOffset = Math.max(0, Number(cfg.teach.keywordMaxOffset) || 6);
  cfg.teach.keywords = (cfg.teach.keywords ?? [])
    .filter((k) => typeof k === 'string' && k.trim())
    .map((k) => k.trim());
  cfg.teach.allowPrivateTeach = cfg.teach.allowPrivateTeach !== false;
  cfg.teach.naturalLearning = cfg.teach.naturalLearning !== false;
  cfg.teach.confirmMode = ['auto', 'confirm', 'off'].includes(cfg.teach.confirmMode)
    ? cfg.teach.confirmMode
    : 'auto';

  cfg.faces.collect = cfg.faces.collect !== false;
  // 「用他的常用表情回他」：关掉就只从自己库里挑
  cfg.faces.echoCommon = cfg.faces.echoCommon !== false;
  // 表情发送频率「硬闸」：每隔几条回复才准发一张图。
  // 用户要求把频率降到原来的 1/3（原来约 3 条一张 → 现在约 9 条一张）。
  cfg.faces.sendEvery = Math.max(1, Number(cfg.faces.sendEvery) || 9);
  // 用过几次才算「他常用的」
  // ⚠️ count 现在是「用到过的群数」（跨群去重），所以门槛 2 更合理
  cfg.faces.echoMinTimes = Math.max(2, Number(cfg.faces.echoMinTimes) || 2);

  // ⚠️ 「同群连发几次就复读」（斗图，2026-09-13 加）
  //
  //    **和上面的 echoMinTimes 是两个不同的机制，别混**：
  //      · echoMinTimes  → 跨群统计（他在几个群用过这张）→ 判断"他的招牌表情"
  //      · echoSameTimes → 同群连发（他在一个群里连发几次）→ **斗图**
  //
  //    用户要的是后者：「检测到三条相同表情就机器人复读这个表情」。
  //    之前只有前者，所以**在单个群里永远触发不了**（同群发 10 次只算 1）。
  cfg.faces.echoSameTimes = Math.max(2, Number(cfg.faces.echoSameTimes) || 3);

  cfg.chat.enable = cfg.chat.enable === true;
  cfg.chat.group = String(cfg.chat.group ?? '').trim();
  for (const scene of ['question', 'mention', 'followUp']) {
    const s = cfg.chat[scene];
    s.enable = s.enable !== false;
    s.probability = Math.min(1, Math.max(0, Number(s.probability) || 0));
    s.cooldownMs = Math.max(10000, Number(s.cooldownMs) || 180000);
    s.minChars = Math.max(0, Number(s.minChars) || 0);
    s.keywords = (s.keywords ?? [])
      .filter((k) => typeof k === 'string' && k.trim())
      .map((k) => k.trim().toLowerCase());
    s.names = (s.names ?? [])
      .filter((k) => typeof k === 'string' && k.trim())
      .map((k) => k.trim().toLowerCase());
  }
  // ⚠️ 2026-09-13：默认从 180000 缩到 45000（3 分钟太长，会无限续话）
  cfg.chat.followUp.idleMs = Math.max(15000, Number(cfg.chat.followUp.idleMs) || 45000);
  // ⚠️ 2026-09-15 加：**说话判断的节流**（省调用费，跟"说话冷却"分开）。
  //    每个场景在这么久之内只问模型一次 —— 群里刷屏时不会每条消息都多花一次调用。
  //    ⚠️ 它**不**决定"她能不能说"：过了窗口该判还是判
  //       （原来的做法是"判过一次不说就静默 3~5 分钟"，那会漏掉后面真正的问题）。
  cfg.chat.judgeThrottleMs = Math.max(0, Number(cfg.chat.judgeThrottleMs ?? 5000));
  // ⚠️ **同一个人**接着说：窗口比 idleMs 长（默认 3 分钟），但**不能比 idleMs 短**，
  //    否则配置写错了会反倒更难接话。
  cfg.chat.followUp.sameUserMs = Math.max(
    cfg.chat.followUp.idleMs,
    Math.min(15 * 60 * 1000, Number(cfg.chat.followUp.sameUserMs) || 180000),
  );
  cfg.chat.anyMessage.enable = cfg.chat.anyMessage.enable !== false;
  cfg.chat.anyMessage.probability = Math.min(1, Math.max(0, Number(cfg.chat.anyMessage.probability) || 0));
  cfg.chat.anyMessage.cooldownMs = Math.max(10000, Number(cfg.chat.anyMessage.cooldownMs) || 120000);
  cfg.chat.anyMessage.minChars = Math.max(0, Number(cfg.chat.anyMessage.minChars) || 0);
  cfg.chat.share.enable = cfg.chat.share.enable !== false;
  cfg.chat.share.probability = Math.min(1, Math.max(0, Number(cfg.chat.share.probability) || 0));
  cfg.chat.share.cooldownMs = Math.max(10000, Number(cfg.chat.share.cooldownMs) || 90000);
  cfg.chat.sticker.enable = cfg.chat.sticker.enable !== false;
  cfg.chat.sticker.echo = cfg.chat.sticker.echo !== false;
  cfg.chat.sticker.echoProbability = Math.min(1, Math.max(0, Number(cfg.chat.sticker.echoProbability) || 0));
  cfg.chat.sticker.echoCooldownMs = Math.max(10000, Number(cfg.chat.sticker.echoCooldownMs) || 180000);
  cfg.chat.sticker.probability = Math.min(1, Math.max(0, Number(cfg.chat.sticker.probability) || 0));
  cfg.chat.sticker.cooldownMs = Math.max(10000, Number(cfg.chat.sticker.cooldownMs) || 120000);
  cfg.chat.question.requireQuestionMark = cfg.chat.question.requireQuestionMark !== false;

  // ── 「收紧度」滑块（2026-09-13 加，用户要求）─────────────────────────
  //
  // 用户原话：「给1级灵敏度再加个能自由调节收紧度的滑块吧」
  //          「这个滑块**只对 1 生效**」
  //
  // ⚠️ 为什么需要：灵敏度 1（最活跃那档）原来**只有一个档位**，
  //    想让它"再安静一点"得同时改四五个地方（anyMessage 概率、followUp 窗口、
  //    续话上限、还有判断提示词），分散又难权衡 —— 调了不知道哪个在起作用。
  //
  // ⚠️⚠️ **它只在灵敏度 = 1 的群生效**（用户明确要求）：
  //    2 档（只回服务器相关/聊到它）和 3 档（只认 @）本来就是"安静档"，
  //    再叠一个滑块只会互相打架、说不清是哪个在起作用。
  //
  // 这里**只存原始值**（0~100），换算留给 `strictnessFactor()` ——
  // 因为灵敏度是**分群**的，不能在这里算成一个全局倍数。
  cfg.chat.strictness = Math.min(100, Math.max(0, Number(cfg.chat.strictness ?? 50)));

  // ⚠️ 回复超过这么久还没出来 → **先说一句「等一下」**（2026-09-13 用户要求）。
  //    用户原话：「建议超出20秒时，机器人先随便回复一句你等等之类的话」，
  //    而且「回复的话不要太死板，也可以经过 llm」（那句话交给模型现生成）。
  //    0 = 关掉。单位毫秒。默认 20000（用户说的 20 秒）。
  cfg.chat.ackAfterMs = Math.max(0, Number(cfg.chat.ackAfterMs ?? 20000));

  // ⚠️ **「自己接自己」（追补）** —— 和上面的 `chat.followUp`（**对话延续**：
  //    别人又说话了，要不要接着聊）完全是两件事，所以名字必须分开，
  //    否则配置文件里两个 `followUp` 会让人（和我）看错。
  //    见 src/follow-up.js。
  cfg.selfFollowUp ??= {};
  cfg.selfFollowUp.enable = cfg.selfFollowUp.enable !== false;
  // 概率闸：不是每次回完都问模型"要不要补一句"（真人也不会每次都补）
  cfg.selfFollowUp.probability = Math.min(1, Math.max(0, Number(cfg.selfFollowUp.probability ?? 0.35)));
  // 硬上限（用户指定「最多自己接自己五条消息」）
  cfg.selfFollowUp.maxPerReply = Math.min(10, Math.max(1, Number(cfg.selfFollowUp.maxPerReply) || 5));
  // 第 2 条起，还继续补的概率（默认 0.5）—— 见 follow-up.js 的 `CONTINUE_P`
  cfg.selfFollowUp.continueProbability = Math.min(
    1,
    Math.max(0, Number(cfg.selfFollowUp.continueProbability ?? 0.5)),
  );
  // 两条补充话之间的间隔（像真人在打字）
  const gapMs = Array.isArray(cfg.selfFollowUp.betweenMs) ? cfg.selfFollowUp.betweenMs : [400, 1200];
  cfg.selfFollowUp.betweenMs = [
    Math.max(0, Number(gapMs[0]) || 400),
    Math.max(0, Number(gapMs[1]) || 1200),
  ];

  // ── 口癖节流（2026-09-14 用户要求）──────────────────────
  // 用户原话：「『问这个干嘛』这种反问感觉过于频繁，有点不亲近的感觉，
  //   可以适当抑制一下」。见 src/tic.js。
  cfg.tic ??= {};
  cfg.tic.enable = cfg.tic.enable !== false;
  // 多久之内算"最近"（默认 2 小时）
  cfg.tic.windowMs = Math.max(60000, Number(cfg.tic.windowMs) || 2 * 60 * 60 * 1000);
  // 同一个开场白在窗口内出现几次就提醒它（默认 3）
  cfg.tic.repeatLimit = Math.max(2, Number(cfg.tic.repeatLimit) || 3);

  cfg.observe ??= {};
  // ⚠️ 观察相关的新配置（2026-09-14 用户要求「提升记录频率」+「按时间压缩」）
  cfg.observe.keepPeople = Math.max(20, Number(cfg.observe.keepPeople) || 60);
  cfg.observe.keepEvents = Math.max(5, Number(cfg.observe.keepEvents) || 20);
  cfg.observe.compress ??= {};
  cfg.observe.compress.enable = cfg.observe.compress.enable !== false;
  cfg.observe.compress.checkIntervalMs = Math.max(
    600000,
    Number(cfg.observe.compress.checkIntervalMs) || 12 * 3600 * 1000,
  );
  cfg.observe.compress.minIntervalMs = Math.max(
    3600000,
    Number(cfg.observe.compress.minIntervalMs) || 3 * 24 * 3600 * 1000,
  );

  // ── 一级随机事件（日常小事，2026-09-15 用户要求）─────────
  // ⚠️⚠️ 节奏是「**随机 + 冷却**」，不是纯随机 —— 用户特意补的：
  //    「也不是纯随机，随机要加冷却时间」。
  //    纯随机撒点会撞出两条隔八分钟的消息，那比定时还假。
  // ⚠️ 0 点到 startHour 之间**完全不发**（他明确要求 0-7 点不发）。
  cfg.life ??= {};
  cfg.life.enable = cfg.life.enable !== false;
  cfg.life.minPerDay = Math.max(0, Number(cfg.life.minPerDay) || 3);
  cfg.life.maxPerDay = Math.max(cfg.life.minPerDay, Number(cfg.life.maxPerDay) || 5);
  cfg.life.startHour = Math.min(23, Math.max(0, Number(cfg.life.startHour) ?? 7));
  cfg.life.endHour = Math.min(24, Math.max(cfg.life.startHour + 1, Number(cfg.life.endHour) || 24));
  /** 两条之间至少隔多久（默认 90 分钟） */
  cfg.life.cooldownMs = Math.max(60000, Number(cfg.life.cooldownMs) || 90 * 60 * 1000);
  /** 迟到超过这个时长就**跳过不补发**（免得"午饭被偷"半夜发出来） */
  cfg.life.lateToleranceMs = Math.max(0, Number(cfg.life.lateToleranceMs) ?? 30 * 60 * 1000);
  /** 多久检查一次到点没 */
  cfg.life.checkIntervalMs = Math.max(60000, Number(cfg.life.checkIntervalMs) || 5 * 60 * 1000);
  /** 节日（日本节日会换事件池；中国节日只当素材，见 src/holiday.js） */
  cfg.life.holidays = cfg.life.holidays !== false;

  // ── 二级剧情（任务系统，2026-09-15 用户要求）─────────────
  // 「二级作为重头戏……产生的事件都是能改变世界线关键事件……
  //   类似一个游戏任务，并且分阶段。阶段数可以 llm 自定，但是不超过 10 段，
  //   最佳为 3 段，其他段数几率指数下降。每段最长等待时间也就是群友一句话没回时
  //   有半小时……结局分成好结局和坏结局。」
  // ⚠️ 全局**同时只跑 1 条**（用户拍板）；阶段数的"指数下降"在 src/quest.js 里算。
  cfg.quest ??= {};
  /**
   * ⚠️⚠️ **默认关**（2026-09-15 用户要求：「二级剧情还没有开关，先加个开关，
   *   我觉得剧情先多测试几条还需要测试修改一下再正式启用」）。
   *
   * 语义：`enable` 管的是「**自动**开剧情」（一级事件掷骰子那条线）。
   *   · **手动**（界面上点「立即开始剧情」）+ **模拟面板** 不受它影响 ——
   *     开关存在的意义就是"先多测几条"，关着却测不了就没意义了。
   *   · 但"同时只 1 条"对谁都不放宽（两条剧情并行必然打架）。
   */
  cfg.quest.enable = cfg.quest.enable === true;
  /** 二级占比（一成）—— 一级每天 3-5 条 × 一成 ≈ 每周 2-3 条，跟定好的节奏吻合 */
  cfg.quest.chance = Math.min(1, Math.max(0, Number(cfg.quest.chance) ?? 0.1));
  /** 滚动 7 天最多几条 */
  cfg.quest.maxPerWeek = Math.max(1, Number(cfg.quest.maxPerWeek) || 3);
  /** 每一段最多等群友多久（30 分钟） */
  cfg.quest.waitMs = Math.max(60000, Number(cfg.quest.waitMs) || 30 * 60 * 1000);
  // ⚠️ 硬上限 10 段（用户要求：「不超过 10 段」）—— 别让配置把它顶开
  cfg.quest.maxStages = Math.min(10, Math.max(3, Number(cfg.quest.maxStages) || 10));
  /** 一次都没人回时，最多自动续几段就收尾 */
  cfg.quest.coldAutoLimit = Math.max(0, Number(cfg.quest.coldAutoLimit) ?? 1);
  /**
   * 「群友哪句话能改变剧情」的宽严档（<主人> 2026-09-15：「标准再放宽一点」）。
   *   strict = 只认 @她/回她/明显建议
   *   normal = 再加"对着她问的句子"（默认）
   *   loose  = 再加"任何 6 字以上、不是纯起哄"的发言
   */
  cfg.quest.replyMode = ['strict', 'normal', 'loose'].includes(String(cfg.quest.replyMode))
    ? String(cfg.quest.replyMode)
    : 'normal';
  /**
   * 结局对好感度的影响。
   *
   * ⚠️⚠️ 2026-09-15 <主人> 拍板：**坏结局要「掉」好感度**（负数）。
   *    「我一开始是想坏结局要掉好感度的，然后下一个二级事件的开头
   *      可以直接参考坏结局剧情，就可以进行挽回了。」
   *
   * 所以：
   *   · `affinityGood` 夹在 **1..3**（不能是 0 或负 —— 好结局不该扣分）
   *   · `affinityBad`  夹在 **−3..3**（允许 0 和负数；默认 **−2**）
   *   · 用 `nz()` 而不是 `||`：`0` 是**合法值**（"坏结局不加不减"）
   *   · 幅度仍然满足「二级比一级（±1）大」
   */
  cfg.quest.affinityGood = Math.min(3, Math.max(1, nz(cfg.quest.affinityGood, 3)));
  cfg.quest.affinityBad = Math.min(3, Math.max(-3, nz(cfg.quest.affinityBad, -2)));
  /** 多久检查一次"等够了没" */
  cfg.quest.checkIntervalMs = Math.max(30000, Number(cfg.quest.checkIntervalMs) || 60 * 1000);

  // ── 待发箱（2026-09-15 用户要求）────────────────────────────
  // 「如果因为各种原因没发出，在正常之后要补发。然后自动顺延接下来的」
  //
  // ⚠️ 为什么需要：这台机器上的 NapCat 会**间歇性假在线**（探针报 online、
  //    发消息回 retcode 1200「网络连接异常」、群里谁也看不到），而且会自己坏自己好。
  //    所以在"发"和"真的发出去"之间加一层：发失败的留下来，好了再发。
  cfg.outbox ??= {};
  cfg.outbox.enable = cfg.outbox.enable !== false;
  /** 超过这么久还没发出去就丢掉（迟到的聊天回复比不回复更怪） */
  cfg.outbox.maxAgeMs = Math.max(60000, nz(cfg.outbox.maxAgeMs, 30 * 60 * 1000));
  /**
   * ⚠️ 剧情（`kind:'quest'`）的补发窗口。
   *
   * 一开始我给了 6 小时（想的是"剧情是连续的故事线，晚点送到也看得懂"），
   * 但 2026-09-15 被现实打脸：通道坏掉时排进待发箱的那几句，
   * 在一两个小时后才发出去 —— 而那时**那条剧情已经结束了**（甚至已经被丢掉了），
   * 群里看着就是"凭空冒出两句没头没尾的话"（<主人> 截图反馈「说话有点没头没尾」）。
   *
   * 所以收成 **1 小时**：够覆盖"通道抖一下/机器人重启一下"，
   * 又不会把半条旧剧情拖到下一个时段去。想放宽就改这个值。
   */
  cfg.outbox.questMaxAgeMs = Math.max(
    cfg.outbox.maxAgeMs,
    nz(cfg.outbox.questMaxAgeMs, 60 * 60 * 1000),
  );
  /** 通道坏的时候多久试着补一次（别每 60 秒猛敲） */
  cfg.outbox.retryMs = Math.max(30000, nz(cfg.outbox.retryMs, 3 * 60 * 1000));
  /** 箱子里最多存几条（通道坏一整天也不会撑爆文件） */
  cfg.outbox.maxItems = Math.max(1, nz(cfg.outbox.maxItems, 50));
  /** 多久看一眼箱子里有没有要补的 */
  cfg.outbox.checkIntervalMs = Math.max(30000, nz(cfg.outbox.checkIntervalMs, 60 * 1000));

  // ── 「通道假在线」的自救（2026-09-15 用户要求：「下次回 1200 应该自动重启」）──
  //
  // ⚠️ 这里只决定「**什么时候留一张请人重启的条子**」，真正重启协议端的是看门狗
  //    （它那里才有快登凭据检查、10 分钟节流、"在等扫码时绝不重启"、弹窗叫人）。
  cfg.napcatRecover ??= {};
  cfg.napcatRecover.enable = cfg.napcatRecover.enable !== false;
  /** 连着失败几次就留条子（连续失败 = 通道真断了，偶尔一次不算） */
  cfg.napcatRecover.failThreshold = Math.max(1, nz(cfg.napcatRecover.failThreshold, 3));
  /** 两次请求之间至少隔多久（重启 = 一次登录，别把风控喂饱） */
  cfg.napcatRecover.throttleMs = Math.max(60000, nz(cfg.napcatRecover.throttleMs, 30 * 60 * 1000));

  // ── 分群参数覆盖（2026-09-15 <主人>：「参数也可以分群设定」）────────────
  //
  // 形状：`groupParams: { "<群号>": { life: {...}, quest: {...}, chat: {...} } }`
  //   · 只写**要覆盖的那几项**，没写的自动用全局那套（见 `paramsFor()`）
  //   · `life` 目前有意义的是 `enable`（这个群收不收日常事件）
  //   · `quest` 是整个模块都能覆盖：enable / chance / maxPerWeek / waitMs /
  //     maxStages / coldAutoLimit / affinityGood / affinityBad
  //   · `chat` 目前有意义的是 **`strictness`（收紧度）** —— 2026-09-15 晚用户要求：
  //     「收紧度也加一个一样的下拉菜单分群调节」（热闹的大群该松一点才接得上话，
  //      严肃的群该收紧，各群不该一刀切）
  //
  // ⚠️ 和 `trigger.groupRespondTo`（档位）不是一回事，别搞混：
  //    · `groupRespondTo` 管的是「**她要不要在这个群说话**」（0~3 档）
  //    · `groupParams` 管的是「**事件/剧情/收紧度在这个群怎么跑**」
  cfg.groupParams ??= {};
  {
    /**
     * ⚠️⚠️ 2026-09-16：**白名单 + 数值化**（用户要求：
     *    「注意修改的参数**一定要能真正保存**」）。
     *
     * 界面上传过来的是字符串，而且可能填错（"abc"、空串、负数）。
     * 这里逐项过一遍：**认识的就转成数字，认不出来的直接丢掉** ——
     * 这样存进 yaml 的一定是能直接参与计算的数，而不是"存了但不生效"的字符串。
     */
    const LIFE_KEYS = {
      // 开关（布尔）
      enable: 'bool',
      // 节日生效（日本节日换事件池、放假屏蔽学校/通勤事件）
      holidays: 'bool',
      // 每天几条
      minPerDay: 'num',
      maxPerDay: 'num',
      // 允许发消息的时段（小时，0-23 / 1-24）
      startHour: 'num',
      endHour: 'num',
      // 两条之间最少隔多久（毫秒）
      cooldownMs: 'num',
      // 迟到多久就不补发（毫秒）
      lateToleranceMs: 'num',
      // 多久检查一次（毫秒）
      checkIntervalMs: 'num',
    };
    const QUEST_KEYS = {
      enable: 'bool',
      chance: 'num',
      maxPerWeek: 'num',
      waitMs: 'num',
      maxStages: 'num',
      coldAutoLimit: 'num',
      affinityGood: 'num',
      affinityBad: 'num',
      checkIntervalMs: 'num',
      // 群友哪句话才算"能改变剧情"（strict / normal / loose）
      replyMode: 'str',
    };
    const pick = (src, keys) => {
      const out = {};
      for (const [k, type] of Object.entries(keys)) {
        const v = src?.[k];
        if (v === undefined || v === null || v === '') continue;
        if (type === 'bool') {
          out[k] = v !== false && v !== 'false' && v !== 0 && v !== '0';
          continue;
        }
        if (type === 'str') {
          const s = String(v).trim();
          if (s) out[k] = s;
          continue;
        }
        const n = Number(v);
        if (Number.isFinite(n)) out[k] = n;
      }
      return out;
    };

    const g = {};
    for (const [gid, v] of Object.entries(cfg.groupParams ?? {})) {
      const k = String(gid).trim();
      if (!k || !v || typeof v !== 'object') continue;
      const one = {};
      if (v.life && typeof v.life === 'object') {
        const l = pick(v.life, LIFE_KEYS);
        if (Object.keys(l).length) one.life = l;
      }
      if (v.quest && typeof v.quest === 'object') {
        const q = pick(v.quest, QUEST_KEYS);
        // 概率夹在 0~1（写歪了别让它变成"必开"或"永不开"）
        if (q.chance !== undefined) q.chance = Math.min(1, Math.max(0, q.chance));
        if (Object.keys(q).length) one.quest = q;
      }
      if (v.chat && typeof v.chat === 'object') {
        const c = { ...v.chat };
        // 收紧度就是 0~100 的滑块值：写歪了就当没写（别让 NaN 传进后面的判断）
        if (c.strictness !== undefined && c.strictness !== null && c.strictness !== '') {
          const n = Number(c.strictness);
          if (Number.isFinite(n)) c.strictness = Math.min(100, Math.max(0, n));
          else delete c.strictness;
        }
        if (Object.keys(c).length) one.chat = c;
      }
      if (Object.keys(one).length) g[k] = one;
    }
    cfg.groupParams = g;
  }

  // ── 故事线（2026-09-15 用户要求：随机事件 + 任务系统）────────
  // 「新建一个故事线知识库，这个也要按时间进行重要度分级的定期压缩」
  // ⚠️ 二级（主线）条目写进去**不能删、只能最小限度精简** ——
  //    这条判据在 src/storyline.js 的 compress() 里，不在提示词里。
  cfg.storyline ??= {};
  cfg.storyline.enable = cfg.storyline.enable !== false;
  // 一级（日常）条目留多少条；二级永远不裁
  cfg.storyline.keepTier1 = Math.max(20, Number(cfg.storyline.keepTier1) || 80);
  cfg.storyline.compress ??= {};
  cfg.storyline.compress.enable = cfg.storyline.compress.enable !== false;
  cfg.storyline.compress.checkIntervalMs = Math.max(
    600000,
    Number(cfg.storyline.compress.checkIntervalMs) || 12 * 3600 * 1000,
  );
  cfg.storyline.compress.minIntervalMs = Math.max(
    3600000,
    Number(cfg.storyline.compress.minIntervalMs) || 3 * 24 * 3600 * 1000,
  );
  /**
   * 至少攒够几条才值得压。
   * ⚠️ 太少的时候压一次纯属浪费（而且模型会想动刚写下的新鲜事）。
   *   一级事件每天 3-5 条 → 默认 8 条大约两天攒到。
   */
  cfg.storyline.compress.minEntries = Math.max(2, Number(cfg.storyline.compress.minEntries) || 8);

  // ── 好感度（2026-09-14 用户要求）──────────────────────
  // 「加一个机器人对这个人的好感度，类似 galgame 的，默认 50，最小 0 最大 100。
  //   但是其中优先级是低于我和机器人的特殊关系的。」
  // ⚠️ 它**管不到**对 <主人> 的态度 —— 见 src/affinity.js 顶部铁律①。
  cfg.affinity ??= {};
  cfg.affinity.enable = cfg.affinity.enable !== false;
  /** 好感度到多少算「可以加好友了」 */
  cfg.affinity.friendThreshold = Math.min(100, Math.max(50, Number(cfg.affinity.friendThreshold) || 90));
  /** `/好感度` 排行榜显示几个（用户要求 10 个） */
  cfg.affinity.boardSize = Math.min(30, Math.max(1, Number(cfg.affinity.boardSize) || 10));
  /** 「回应了她」的判定窗口：她刚说完话的这段时间内才算 */
  cfg.affinity.interactWindowMs = Math.max(
    60000,
    Number(cfg.affinity.interactWindowMs) || 30 * 60 * 1000,
  );

  // ── 好友（2026-09-15 用户要求）──────────────────────────
  // 「当某位群友好感度到达 90 时……通过之后**每天有几率主动发一次消息**，
  //   时间要在**白天**……**一定不是所有好友都会发**，要不然就尴尬了」
  //
  // ⚠️⚠️ 协议层**发不了**加好友申请（查证过 NapCat 全部 action），
  //    所以按拍板的形态：**群里 @ 他 + 报验证消息，让他来加，机器人自动通过**。
  //    而那条消息**故意是机器化的**，而且**不进聊天上文**（用户要求）。
  cfg.friend ??= {};
  cfg.friend.enable = cfg.friend.enable !== false;
  /** 到线通知的固定模板（`{at}` 会被替换成 @；你想改就改，但别加祥子的口气） */
  cfg.friend.notice = String(
    cfg.friend.notice ??
      '@{at} 恭喜你的好感度到达90!达到加好友的标准,同意之后有几率主动发消息过来',
  );
  // ⚠️ 这里**不能写 `Number(x) ?? 默认值`** —— `Number(undefined)` 是 `NaN`，
  //    而 `??` 只挡 null/undefined，**挡不住 NaN** → 一路算成 NaN（实测过：
  //    dailyChance 变成了 null）。所以统一用"有限数才认"的写法（`nz` 在文件顶部）。
  /** 每天"要不要主动私聊"的概率（**不是每天都发**） */
  cfg.friend.dailyChance = Math.min(1, Math.max(0, nz(cfg.friend.dailyChance, 0.35)));
  /** 只在白天这段里发 */
  cfg.friend.dayFromHour = Math.min(23, Math.max(0, nz(cfg.friend.dayFromHour, 9)));
  cfg.friend.dayToHour = Math.min(24, Math.max(cfg.friend.dayFromHour + 1, nz(cfg.friend.dayToHour, 22)));
  /** 同一个好友两次私聊至少隔多久 */
  cfg.friend.minGapMs = Math.max(3600000, nz(cfg.friend.minGapMs, 20 * 60 * 60 * 1000));
  /** 多久检查一次该不该私聊 */
  cfg.friend.checkIntervalMs = Math.max(60000, nz(cfg.friend.checkIntervalMs, 10 * 60 * 1000));

  cfg.attitude.allowAnger = cfg.attitude.allowAnger !== false;
  cfg.attitude.allowRetort = cfg.attitude.allowRetort !== false;
  cfg.attitude.denyBeingBot = cfg.attitude.denyBeingBot !== false;

  cfg.webui.enable = cfg.webui.enable !== false;
  cfg.webui.host = String(cfg.webui.host ?? '203.0.113.10');
  cfg.webui.port = Math.max(1, Number(cfg.webui.port) || 3099);

  return cfg;
}

export const config = load();

/**
 * ⚠️⚠️ 2026-09-16：**life / quest 的「全局默认」取消了**。
 *
 * 用户原话：「直接也**不要默认设定**了，**完全按照分群设定**」。
 *
 * 所以 `paramsFor('life'|'quest', 群号)` 的底稿是**代码里的这份内置默认**，
 * **不再读 `config.yml` 里那两段**（那两段现在是历史遗留：改了也不生效）。
 * ⚠️ 但"没设过的群"总得有个起点 —— 就用这份内置默认，界面上**每个群都能覆盖**。
 * ⚠️ 值就是原来 config.yml 里那份（保证行为不变）；改这里等于改所有群的**起点**。
 */
export const DEFAULT_LIFE = {
  enable: true,
  minPerDay: 3,
  maxPerDay: 3,
  startHour: 7,
  endHour: 24,
  cooldownMs: 90 * 60 * 1000,
  lateToleranceMs: 30 * 60 * 1000,
  checkIntervalMs: 5 * 60 * 1000,
  holidays: true,
};
export const DEFAULT_QUEST = {
  enable: false,
  chance: 0.1,
  maxPerWeek: 3,
  waitMs: 30 * 60 * 1000,
  maxStages: 10,
  coldAutoLimit: 1,
  replyMode: 'loose',
  affinityGood: 3,
  affinityBad: -2,
  checkIntervalMs: 60000,
};

/**
 * 取**某个模块在某个群**的参数：内置默认 + 这个群的覆盖项。
 *
 * 用户要求（2026-09-15）：「参数也可以分群设定」；
 * 2026-09-16 又收紧了一次：「**不要默认设定了，完全按照分群设定**」——
 * 所以底稿从 `config.life/quest` 换成了上面那两个常量。
 *
 * ```js
 * paramsFor('quest', '200000002')   // → 内置默认 + groupParams['200000002'].quest
 * paramsFor('life',  '200000001')
 * ```
 *
 * ⚠️ 只覆盖**写了的**那几项，没写的跟着内置默认走。
 * ⚠️ `groupId` 给空/给不出 → 只用内置默认（老调用点、私聊、模拟面板都走这条）。
 * ⚠️ 返回的是**新对象**（浅合并），别拿它去改 —— 改了不会落盘。
 *
 * @param {'life'|'quest'|string} kind
 * @param {string|number} [groupId]
 */
export function paramsFor(kind, groupId) {
  let base;
  if (kind === 'life') {
    // ⚠️ 中间那一层 `config.life` 是**老配置的兜底**（界面上已经没有编辑入口了，
    //    参数一律在「按群设定」页里按群设）；内置默认在最底下兜底。
    base = { ...DEFAULT_LIFE, ...(config.life ?? {}) };
  } else if (kind === 'quest') {
    base = { ...DEFAULT_QUEST, ...(config.quest ?? {}) };
  } else {
    base = config[kind] ?? {};
  }
  const gid = String(groupId ?? '').trim();
  const over = gid ? config.groupParams?.[gid]?.[kind] : null;
  if (!over || typeof over !== 'object') return { ...base };
  return { ...base, ...over };
}

/**
 * 重新从 config.yml 读取配置（管理界面改完配置后调用，不用重启机器人）。
 * 保留同一个对象引用，这样所有 `import { config }` 的地方都能看到新值。
 */
export function reloadConfig() {
  const fresh = load();
  for (const k of Object.keys(fresh)) config[k] = fresh[k];
  return config;
}

/** 启动前体检，返回问题列表（空数组 = 没问题） */
export function validate() {
  const problems = [];
  const { llm, onebot, trigger, status } = config;

  if (!llm.apiKey || llm.apiKey.includes('在这里填')) {
    problems.push('llm.apiKey 还没填 —— 请到 config.yml 填入真实的大模型 API Key');
  }
  if (!llm.baseURL?.startsWith('http')) {
    problems.push('llm.baseURL 必须以 http:// 或 https:// 开头');
  }
  if (!/^wss?:\/\//.test(onebot.url)) {
    problems.push(`onebot.url 必须以 ws:// 或 wss:// 开头，当前是 "${onebot.url}"`);
  }
  if (!trigger.privateChat && !trigger.groupChat) {
    problems.push('trigger.privateChat 和 trigger.groupChat 都是 false，机器人不会回复任何消息');
  }
  if (status.enable && !status.host) {
    problems.push('status.enable 开着，但 status.host 是空的 —— 实查功能无效');
  }
  if (status.enable && status.keywords.length === 0) {
    problems.push('status.keywords 为空，实查永远不会被触发');
  }
  return problems;
}

