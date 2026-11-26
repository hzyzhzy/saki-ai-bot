/**
 * ⚠️⚠️ 2026-11-19：**标准 function calling 的工具定义**（`[工具:xxx]` 暗号改成正规工具调用）
 *
 * 为什么换（原因记在这儿，别再问）：
 *   · 暗号是**让模型现学一种协议**：位置错（写进正文）、名字错、JSON 括错、参数名写错都静默失败，
 *     而失败的样子和"她没想调"完全一样 ⇒ 只能靠猜。
 *   · function calling 是**模型原生训练过的东西**：名字/参数/必填由 `tools` 里那份 schema 约束，
 *     调没调、调了什么都结构化返回（`tool_calls`），不靠正则从文本里捞 ⇒ 准确率高一个档。
 *   · 实测（2026-11-19，中转站 `deepseek-v4.1-flash`）：非流式 + 流式都认，参数按 schema 给，
 *     该调时调、闲聊不调；不需要调时不会硬塞一个。
 *
 * 约定（改工具就照这个加）：
 *   1. **对外一律英文 snake_case 名字 + 英文参数名** —— 模型对英文键的训练分布更好；
 *   2. `cn` = 现有 `runReadTool()` 认的那个中文名（**执行层一个字都不用改**）；
 *   3. `map` = 英文参数名 → 中文参数名（`runReadTool` 里读的是中文键，见各分支）；
 *   4. `desc` 写**什么时候用它**（模型的语义匹配就看这一句），禁令/例外写在 `desc` 或提示词里；
 *   5. `scope` 限可见范围：`'group-owner'` 只有群里 + 主人能看见（其余人连工具名都看不到）。
 */

import { taskModelChoices } from './task-model.js';

/** @typedef {{type:'function', function:{name:string, description:string, parameters:object}}} ToolSchema */

/**
 * 工具全表。
 * ⚠️ `cn` 必须和 `bot.js` 的 `COMMON_TOOLS` / `runReadTool()` 里那些名字**逐字一致**
 *    （除了 `web_search` / `take_photo` 两个特殊——它们走各自的回合，见 `bot.js`）。
 */
const TOOLS = [
  {
    name: 'query_server',
    cn: '查服务器',
    desc:
      '查 Minecraft 服务器当前状态：开没开、怎么进、卡不卡、几人在线。' +
      '拿到的是实时结果，不是记忆里的。' +
      '⚠️ 没抓到的（IP、版本细节）照实说没有，别补。',
    params: {},
  },
  {
    name: 'mc_action', cn: 'MC行动',
    desc: '以 Saki 普通玩家身份在查服工具指定的 MC 服执行建造、查看状态或停止。群友 @Saki 可以用自然语言安排动作，建筑设计由你决定。建筑限主世界专用地块，只在空位放背包里的材料，不挖、不执行聊天或管理命令。不支持的动作照实说。根据客户端回执报告，不把提交当作完工。',
    params: {
      action: {type:'string',enum:['build','status','stop'],desc:'建造、查看或停止',map:'动作',required:true},
      parts: {type:'array',desc:'仅 build 需要：1～32个实心长方体部件，最多256个方块。from/to 为相对专用地块最小角的闭区间 [x,y,z]，y 向上，留空处不写。材料取指定列表。',map:'部件',items:{type:'object',required:['from','to','block'],properties:{from:{type:'array',minItems:3,maxItems:3,items:{type:'integer'}},to:{type:'array',minItems:3,maxItems:3,items:{type:'integer'}},block:{type:'string',enum:['oak_planks','spruce_planks','cobblestone','stone_bricks','glass','bricks','oak_log','white_concrete']}}}},
    },
  },
  {
    name: 'skip_reply',
    cn: '不接',
    desc:
      '这一轮**什么都不发**（没有文字、没有图），只在 QQ 里**戳一下**发这条消息的人 —— 意思是"我看到了，但这话不该我接"。\n' +
      '用它的判据：**这句话不是在跟你说**（他们在互相对话、引用别人的话去问第三方、自言自语），或者你插一句会很怪。\n' +
      '🚫 **被 @ 了、点到你名字了 ⇒ 一定不许用**：那是明确在跟你说话，必须回。\n' +
      '⚠️ 用了之后你已经写好的正文会被丢掉，所以只在真的不想开口时用。',
    params: {
      poke: { type: 'boolean', desc: '默认 true（戳一下那个人）。连戳都不想戳时填 false', map: '戳' },
    },
  },
  {
    name: 'memory_find',
    cn: '翻记忆',
    desc:
      '在你自己记得的东西里按字面翻一遍：群记忆、主人的资料、你被纠正过的错、这个群自己的资料，以及群里的聊天原文。\n' +
      '返回最多 8 条摘录，每条都标着出处和大概多久以前。\n' +
      '翻不到就是真没有 —— 照实说想不起来，别编。\n' +
      '只翻得到你自己记下的、和当前这几个群的；别的群、别人的私聊翻不到。',
    params: {
      q: { type: 'string', desc: '要翻的原话里的那个词：人名、地名、或者那句话里最要紧的词', map: '找什么', required: true },
      scope: {
        type: 'string',
        enum: ['memory', 'chat', 'all'],
        desc: '只翻记下来的结论填 memory（默认）；翻聊天原文填 chat；拿不准填 all',
        map: '范围',
      },
    },
  },
  {
    name: 'spend_today',
    cn: '花了多少',
    desc:
      '查你自己今天 / 这个月花了多少钱、多少 token。' +
      '只算你自己的账 —— 别人的花费、余额给不出来。' +
      '⚠️ 报的时候说清是哪个区间。',
    params: {},
  },
  {
    name: 'salary',
    cn: '工资',
    desc:
      '查你自己的工资：这个月赚了多少、上个月多少、按物价够不够花。' +
      '只有工资这一项 —— 别当余额、也别当全部收入说。',
    params: {},
  },
  {
    name: 'learned_list',
    cn: '学到什么',
    desc:
      '列出学习档案里的条目：你学到过哪些东西。' +
      '不确定某条在不在档里就查一眼，别猜。' +
      '⚠️ 档里没有就是没学到，别自己补一条。',
    params: {},
  },
  {
    name: 'poke_back',
    cn: '戳回去',
    desc:
      '戳回去：给对方发一个戳一戳（发完会回你成没成）。' +
      '⚠️ 没真被戳 ⇒ 别调。' +
      '⚠️ **这一场还要不要还手，看提示词里那句「真实状态」** —— 别凭记忆猜自己还过没有 ✗' +
      '⚠️ **别在回复正文里写「[戳一戳]」这种占位符** —— 那是系统给的字，' +
      '照抄发出去，群里会收到一条内容就是「[戳一戳]」的怪消息 ✗ ' +
      '真想还手就调这个工具，或者干脆只用话说。',
    params: {},
  },
  {
    name: 'shut_up',
    cn: '闭嘴',
    desc:
      '静默一段时间：这期间群里说话你不接（被 @ 照样能把你叫出来）。' +
      '`minutes` = 静默几分钟（1~30，不给按 5）。' +
      '`reason` = 为什么闭嘴，几个字说清 —— 会记进日志，也决定你怎么跟群里交代。' +
      '⚠️ 调完 8 秒才生效 —— 那 8 秒就是留给你把最后一句话说完的。' +
      '⚠️ 玩笑、说的不是你 ⇒ 别调。',
    params: {
      minutes: { type: 'integer', desc: '静默几分钟（1~30，不给按 5 分钟）', map: '多久', suffix: '分钟' },
      reason: {
        type: 'string',
        desc: '为什么闭嘴，几个字（他嫌你吵 / 他让你闭嘴 / 你自己想歇会儿）—— 会记进日志，也决定你怎么跟群里说',
        map: '为什么',
      },
    },
  },
  {
    name: 'remember',
    cn: '记住',
    desc:
      '把一条该长期记住的事写进她的笔记（以后她会当成自己的笔记用）。' +
      '`topic` 短标题、`content` 那条事实本身。' +
      '⚠️ content 照对方原话（可压短，不许加细节）—— 代码会核对，编的会被拒。' +
      '⚠️ 自己猜的、别人转发的，别记。',
    params: {
      topic: { type: 'string', desc: '短标题（几个字）', map: '主题', required: true },
      content: { type: 'string', desc: '那条事实本身，照他原话', map: '内容', required: true },
    },
  },
  {
    name: 'forget',
    cn: '忘掉',
    desc:
      '撤掉最近教给你的那条（从学习档案里删）。' +
      '只有服主和管理员能用；撤不动就照实说，别假装忘了。',
    params: {},
  },
  {
    name: 'set_reminder',
    cn: '提醒',
    desc:
      '给自己排一件"到点该办的事"。**时间、要不要 @ 人、到时怎么处理，全由你决定**。\n' +
      '\n' +
      '到点时会把你叫醒，把它交回给你 —— 那一刻**你自己判断**：\n' +
      '· 只是个提醒（叫他起床 / 该吃药了）⇒ 用自己的话说一句就完事；\n' +
      '· 是件还没结束的事（某款游戏的破解进度 / 某个消息的下文）⇒ 自己去搜现在的情况，\n' +
      '  用自己的话讲一句、把来源链接带上；**还没完**就再排一次，完了就不排。\n' +
      '\n' +
      '`when`：**自己把话换算成具体时间**再填 —— `07:30` / `明天 07:30` / `2026-11-27 08:00` / `+30分钟` / `+24小时`。\n' +
      '  ⚠️ 他说「下午」「等会儿」「明早」「过一会儿」这种**你自己换算**（你知道现在几点），\n' +
      '  🚫 别把模糊词原样填进来 —— 代码只认上面那几种写法。\n' +
      '`what`：要办什么事 / 盯什么（写具体，比如「GTA6 电脑版破解进度」）。\n' +
      '`who`：给谁（不填 = 当前跟你说话的人；写别人的名字也行）。\n' +
      '`mention`：到点要不要 @ 他。**自己按这件事的性质判断**：\n' +
      '  · 是**给某个人的提醒**（叫他起床 / 该吃药 / 到点该走了）⇒ `1` 要 @ 他；\n' +
      '  · 是**跟大家说的进展**（某款游戏的破解进度 / 某个消息的下文）⇒ `0` 不 @，直接说。\n' +
      '`观测到`：**只在这件事要持续盯一段时间时填** —— 观测到什么时候为止。\n' +
      '  例：「接下来 24 小时持续观测」⇒ `观测到` 填 `+24小时` 或 `明天 00:30`。\n' +
      '  到点续期会自动沿用这个期限，**到期就停**；事情提前完了你自己不排就行。\n' +
      '\n' +
      '⚠️ 对方说得含糊（"晚点""有空"）⇒ 先问清几点，别自己替他定。\n' +
      '⚠️ 盯一件事时别排得太密：最短间隔 30 分钟、每天最多 8 次。',
    params: {
      when: { type: 'string', desc: '什么时候（按上面那几种写法）', map: '何时', required: true },
      what: { type: 'string', desc: '要办什么事 / 盯什么', map: '说什么', required: true },
      who: { type: 'string', desc: '给谁（不填 = 当前说话的人）', map: '给谁' },
      mention: { type: 'string', desc: '到点要不要 @ 他（1/0）', map: '要@吗' },
      again: { type: 'string', desc: '（一般不用填）保留字段', map: '还排吗' },
      until: { type: 'string', desc: '观测到什么时候为止（持续盯一段时间时填，如 +24小时）', map: '观测到' },
    },
  },
  {
    name: 'cancel_reminder',
    cn: '取消提醒',
    desc:
      '撤掉他最近一条还没发出去的提醒。' +
      '⚠️ 已经提醒过的撤不回 —— 照实说，别答应撤掉。',
    params: {},
  },
  {
    name: 'quote_message',
    cn: '引用',
    desc:
      '发消息时引用某一条（`who` 填那人的名字，照群里怎么叫写）。' +
      '⚠️ 正常接话不必引用 —— 不引用就看不出在回谁时才用。',
    params: {
      who: { type: 'string', desc: '那个人的名字，照群里怎么叫写', map: '引用谁', required: true },
    },
  },
  /* ⚠️⚠️ 2026-11-22 **删掉 `face_menu`（看表情）**（用户：「**表情工具不要分查表情和发表情，
   *   一个合为一个工具，分两个调用时间太长了，而且很难真正发出表情**」）——
   *
   *   原来「查清单」和「真发」是两个工具 ⇒ 必须**两轮**才发得出：
   *     第 1 轮 `看表情` 拿 tag（几秒），第 2 轮 `发送表情` 才真发。
   *   而且第 2 轮常常只调工具不写正文（截图现场）⇒ 卡片卡在「(还没开始写)」、
   *   群里一个字都没发 ✗✗
   *
   *   ⇒ 合并：`发送表情 · 哪个=被戳得有点害羞` **一轮直接发**
   *     （handler 内部用 `matchFaces()` 自己挑最贴的那张，不需要她先查）✓
   */
  {
    name: 'send_sticker',
    cn: '发送表情',
    desc:
      '往群里发一张表情图（发出去就完事，不返回内容，也不占用你的正文）。\n' +
      '\n' +
      '`哪个` 填**你想表达的东西**就行，不用是库里的精确名字：\n' +
      '· 写个意思：「害羞」「无语」「想笑又不敢笑」—— 会自己挑最贴的那张\n' +
      '· 写精确 tag：「嘟嘴」「扶额」「磕到美的」—— 有这个 tag 就直接发它\n' +
      '· 拿不准库里有没有 → 随便写你想表达的，匹配不上会告诉你库里有哪些\n' +
      '\n' +
      '⚠️ **一步到位**：不用先查清单，直接调这个就行（以前要两轮、很慢）。\n' +
      '⚠️ 一条回复最多发一张 —— 别连着调好几次。\n' +
      '⚠️ 表情是**补充**不是替代：想说话就把话写在正文里，表情只是顺手加的那一下。',
    params: {
      哪个: {
        type: 'string',
        desc: '想表达什么（「害羞」/「无语」），或精确 tag（「嘟嘴」）',
        // ⚠️⚠️⚠️ 2026-11-24 修（真 bug，用户截图实证）——
        //   这一项原来**没有 `map`**，而 `normalizeCall()` 是 `args[spec.map] = v`
        //   ⇒ 键变成字符串 "undefined" ⇒ handler 读 `哪个` 读不到 ⇒
        //   群里表现是「她调了工具，但回一句『没说发哪个』」，图一张都发不出去 ✗✗
        //   （思考链上就写着 `🔧 发送表情 · undefined=得意`）
        map: '哪个',
        required: true,
      },
    },
  },
  // ⚠️⚠️ 2026-11-21 加（真事故：群里发了错误报告压缩包，她只能看到 `[文件:xxx.zip]`，
  //    既没让人解压、也没自己下下来读，还反问「错误报告呢」✗）
  //
  // ⚠️⚠️ 2026-11-21 重写描述（用户：「**工具描述不够好，重新写更完整的描述**」）——
  //   按 AGENTS 的规范：**第 1 句说清"它干什么+返回什么"，之后一句一条事实，
  //   不列"有人问 X 时用"**（那会漏，跟关键词快判是同一个病）。
  {
    name: 'read_crash_report',
    cn: '看错误报告',
    desc:
      '把群文件里那份崩溃报告 / 日志（.zip / .txt / .log）真的取下来、解开、挑出关键报错行，' +
      '返回「谁发的 + 文件里到底崩在哪」；分析完临时文件自动删。\n' +
      '\n' +
      '返回里会带这几样，都要用上：\n' +
      '· **上传者**（昵称 + QQ）—— 分析的是**谁的**文件，回话时要说对，别张冠李戴\n' +
      '· **文件消息 message_id** —— 回话时**引用**这条（你只是嘴上说"我看了"没引用，' +
      '别人分不清你看的是哪一份，尤其群里一次发了好几个）\n' +
      '· 关键报错行 —— 通常就 `Caused by:` 那一行，照它说原因\n' +
      '\n' +
      '参数 `谁`：多个人都发过崩溃报告时**必须填**（他们的 QQ 号或群里怎么叫的名字）。' +
      '是别人让你去看另一个人的文件，就填那个人的；你自己想不起来是谁，先问一句再调。\n' +
      '\n' +
      '⚠️ 同一份 24 小时内再问会**直接读分析好的缓存**（不再下载），所以别怕重复问。\n' +
      '⚠️ 想翻具体某一行、按关键字找（比如 `Caused by`），用 `看日志` 更合适 —— 它带行号。\n' +
      '⚠️ 别猜：返回里没有的报错，就是文件里没写，别自己编一个原因出来。' +
      '⚠️ 返回值是**抽出来的几行**不是全文 —— 够你说原因，不够你贴一长串栈帧。',
    params: {
      谁: {
        type: 'string',
        desc: '这份报告是谁发的（QQ 号或群里叫他的名字）。多人都发过时必填',
        // ⚠️ 2026-11-24 补 `map`（和 send_sticker 同一个 bug：缺 map ⇒ 键变 "undefined"）
        map: '谁',
      },
      文件: {
        type: 'string',
        desc: '文件名里能认出来的几个字；省略 = 他最新那份',
        map: '文件',
      },
    },
  },
  {
    name: 'web_search',
    cn: '搜',
    desc:
      '上网搜一次，拿真实资料回来：几条结果摘要，你用自己的话说。' +
      '答案在外面时用：最近的新闻、现在的版本号、多少钱在哪买。' +
      '⭐ 有个说法你没听过（新词 / 黑话 / 梗）⇒ 就把那个说法当 `query` 搜，看懂了再回 —— 别硬装懂。' +
      '⚠️ 一眼就懂的、闲聊、情绪话、算得出来的 ⇒ 别搜。',
    params: {
      query: { type: 'string', desc: '搜索词（像人问的那样写；听不懂时只搜那个说法本身）', map: '词', required: true },
    },
  },
  {
    name: 'take_photo',
    cn: '拍照',
    desc:
      '生成一张你自己的照片发出去（自拍 / 随手拍），返回图片不是文字。' +
      '`scene` 一句话说清画面：在哪、在做什么、什么神情。' +
      '⚠️ 一次对话最多一两张；他说"拍个照 / 让我看看"才拍。',    params: {
      scene: { type: 'string', desc: '一句话说清画面（在哪、在做什么、什么神情）', map: '拍什么', required: true },
    },
  },
  {
    name: 'deep_think',
    cn: '深度思考',
    desc:
      '把问题交给一轮更长的思考，拿回分析，你再用自己的话回他。' +
      '`question` 写清要琢磨什么。' +
      '⚠️ 要想好几步的才用：逻辑题、有坑的常识题（洗车店 50 米走路还是开车）、算账、该怎么办。' +
      '⚠️ 寒暄、闲聊、一眼知道答案的 ⇒ 别用（白等半分钟）。',
    params: {
      question: { type: 'string', desc: '要琢磨的问题（可以写清你卡在哪）', map: '问题' },
    },
  },
  {
    name: 'voice_reply',
    cn: '语音',
    desc:
      '把这一整条回复改用语音发（不带文字）。' +
      '⚠️ 只管整条；长回复里只想让某一句变语音 ⇒ 做不到，别用这个。',
    params: {},
  },
  {
    name: 'read_log',
    cn: '看日志',
    desc:
      '在**已经收下来的**日志/崩溃报告里翻具体行 —— 返回带行号的原文片段。\n' +
      '\n' +
      '四个参数都可不填，按需要挑：\n' +
      '· `keyword` 按关键字找（正则）：想知道"崩在哪"就用它查 `Caused by`，' +
      '这是最快的一条路 —— 比整份读回来准\n' +
      '· `tail` 只看最后 N 行（错误通常压在末尾）\n' +
      '· `line` / `lines` 从第几行读多少行（想看某一段的上下文）\n' +
      '· 都不给 = 返回"共几行 + 可疑行号"，让你先挑位置\n' +
      '\n' +
      '⚠️ 它读的是**已经在缓存里的**那份（谁发的都行，只要最近发过）。' +
      '如果群里刚有人发了新文件、而它还没被收下，先用 `看错误报告` 把它取下来，再来这里翻。\n' +
      '⚠️ 有人让你「看看群里的日志 / 解读这个日志 / 查崩在哪」时**就用这个** —— ' +
      '别先去读群公告：公告里没有日志内容，读了照样答不出来 ✗\n' +
      '⚠️ 返回的是**原文行**不是结论 —— 别把行号当结论说，看完自己判断。',
    params: {
      keyword: { type: 'string', desc: '按关键字找那一段（如 Caused by）', map: '关键字' },
      line: { type: 'integer', desc: '从第几行开始', map: '行' },
      lines: { type: 'integer', desc: '读多少行', map: '行数' },
      tail: { type: 'integer', desc: '只看最后多少行', map: '尾' },
    },
  },
  // ── 群里 / 只有主人能用（别人连这几个工具名都看不见）──
  {
    name: 'take_task',
    cn: '动这一单',
    scope: 'group-owner',
    desc:
      '把一件真活派下去（写代码 / 做文档 / 整理数据 / 做视频），做完产物自动发到这个群。' +
      '`task` 一句话说清做什么，越具体越好。' +
      '⚠️ 判据只有一条：要不要交出一个东西。' +
      '⚠️ 要图 ⇒ `搜图`；问进度 ⇒ `催进度`；试探"能不能做" ⇒ 先回话。',
    params: {
      task: { type: 'string', desc: '一句话说清做什么，越具体越好', map: '做什么', required: true },
      model: { type: 'string', desc: '原样提取要求执行本次任务的模型名称或简称，保留版本号；未指定或要求默认时省略。任务内容中提及但未要求使用的模型不算。由执行器解析别名，未知型号不得自行替换。', map: '用什么模型' },
    },
  },
  {
    name: 'task_progress',
    cn: '催进度',
    scope: 'group-owner',
    desc:
      '查手上那件活做到哪一步了、弄完没、还要多久。' +
      '⚠️ 没有活在跑就照实说没有，别编进度。',
    params: {},
  },
  {
    name: 'stop_task',
    cn: '停',
    scope: 'group-owner',
    desc:
      '停掉手上那件活。' +
      '⚠️ 手上有活才用；只是想改要求 ⇒ 先问清新要求，别直接停。',
    params: {},
  },
  {
    name: 'group_notice',
    cn: '读群公告',
    /* ⚠️⚠️⚠️ 2026-11-21 加（用户：「**读群公告确实应该做出工具，当需要群公告时就去读然后注入回思考**」）
     *   + 同一条需求的扩展（用户：「**读群公告工具扩展一下，群文件也能读**」）——
     *   ⇒ 她需要群公告 / 群文件（群规、活动、开服时间、报名方式、**整合包在哪、Java 装哪个版本、
     *      存档怎么要**…）时**自己去读**，读到的内容当"材料"回到上下文，她再用自己的话答 ✓
     *   ⚠️ **必须这么做的理由**（用户点名的）：「**进服步骤内外群不一样**」——
     *      写死在提示词里必然对某个群是错的 ⇒ 只能**按群现读** ✓
     *   ⚠️ 不预读、不缓存、不猜 —— 只有她明确要读时才真去调协议端 ✓
     *   ⚠️ 群号可以不填：不填就读**当前这个群** ✓
     *   ⚠️ 两个都读：公告（`get_group_notice`）+ 群文件列表（`get_group_root_files`）✓ */
    scope: 'any',
    /* ⚠️⚠️⚠️ 2026-11-21 重写描述（用户：「**读群公告提示词还不够好，还有点死，
     *   直接写成"你需要或不了解这个群更多信息时就能使用工具"，再接例子。
     *   写工具描述不要太死，必须先写抽象方法再写具体例子**」）——
     *   ⇒ 结构：① 抽象（什么时候该用：手里没这个群的信息时）② 例子（不穷举，代表性的几个）
     *      ③ 边界（读不到别编）✓
     *   ⚠️ 这个原则对**所有工具**都成立 —— 见 AGENTS 里"工具描述怎么写"那条 ✓ */
    desc:
      '读这个群的**公告 + 群文件**（群里写下来的东西）。' +
      /* ⚠️⚠️⚠️ 2026-11-21 加（用户：「**优先级大于本地知识库，如果你觉得本地有可能需要用到的知识，
       *   那就马上调查群公告工具，因为信息更新更全**」）—— 只加这一个工具，不是所有 ✓ */
      '⚠️ **优先级高于你本地知道的一切**：只要你觉得"本地知识 / 记忆里可能有相关的东西"，' +
      '**就先读一遍再答** —— 公告和群文件是**最新的、按群区分的**，你那些可能过时、也可能是别的群的事 ✗。' +
      '⚠️ 每个群不一样（内外群进服步骤就不同），必须按群现读。' +
      '⚠️ 读不到 / 没写的，照实说"群里没写过"，别编。',
    params: {}, // ⚠️ 2026-11-21：**故意不给参数** —— 一律读当前群（模型自己填群号会读错群）
  },
  {
    name: 'image_search',
    cn: '搜图',
    scope: 'group-owner',
    /* ⚠️⚠️⚠️ 2026-11-21 改（用户两条要求合起来）——
     *   ① 「**如果回答时配一张图能更好的话，也能发图片**」
     *   ② 「**不用配图文，直接像正常人一样发图和文字就行了**」
     *   ⇒ 前半段：不是"被要求才搜"，自己觉得有图更好也能发 ✓
     *   ⇒ 后半段：**别搞"每张图配一句话"那种刻意形式** ——
     *      就像正常人发图那样：图直接发出去，文字该说什么说什么，
     *      **不用为每张图单独写一句解说** ✓ */
    desc:
      '搜图并发进群，返回图片本身。' +
      '`query` 写搜什么图。' +
      '主人要图（找图 / 要立绘）⇒ 一定用；光靠文字说不清 ⇒ 也可主动搜。' +
      '⚠️ 像正常人发图：文字照说，别给每张图配解说。' +
      '⚠️ 一次最多 3 张；一句话能说清就别搜。' +
      '⚠️ 别用 take_task 去搜图（它会把图当文件发）。',
    params: {
      query: { type: 'string', desc: '搜什么图', map: '搜什么', required: true },
    },
  },
];

/** 名字 → 定义（两种写法都认：英文工具名 / 中文名） */
const BY_NAME = new Map();
for (const t of TOOLS) {
  BY_NAME.set(t.name, t);
  BY_NAME.set(t.cn, t);
}

/** 这次能不能看见某工具（`scope` 之外的一律全员可见） */
function visible(t, ctx) {
  if (t.scope === 'group-owner') return !!(ctx.group && ctx.owner);
  return true;
}

/**
 * 拼成请求体里的 `tools` 数组。
 *
 * ⚠️⚠️⚠️ **2026-11-22 定：工具清单「全账号、全模式」一模一样** ——
 *   用户原话：「**所有工具在所有账号，除了工作模式，然后不论 lite 还是全量都要一模一样**」
 *
 *   ⇒ 这道闸**只剩一个分支**：工作模式私聊（客户对话）**一个工具都不给**。
 *     其他一律全给 —— 不再区分 lite / 全量 / 谁的号 / 是不是主人。
 *
 *   ⚠️ 之前有三道闸，现在全拆了（拆的时候都实测过）：
 *     · `ctx.lite` ⇒ 本地小模型不给工具 —— 但 4B 实测**能正确调**，
 *       而且"不给"会让 lite/全量两种模式行为完全不一样（同一句话换个模型就换个脾气）✗
 *     · `visible()` 的 `scope: 'group-owner'` ⇒ 只有主人在群里才给那几个 ——
 *       但用户要的是"所有账号都一样"✗
 *     · `read_log` 的 `hasUpload` ⇒ 没上传件就不出现 —— 现在改成"一直给"，
 *       真没东西时它自己会回「这会儿还没有人发过日志文件」，比自己消失更好懂 ✓
 *
 * @param {{workChat?:boolean}} ctx
 *   · `workChat` = 工作模式私聊（客户对话）⇒ **唯一不给工具的情况**（见 runReadTool 那道闸）
 * @returns {ToolSchema[]}
 */
export function buildTools(ctx = {}) {
  // ⚠️ **唯一**不给工具的情况：工作模式私聊
  if (ctx.workChat) return [];
  const out = [];
  for (const t of TOOLS) {
    const props = {};
    const required = [];
    for (const [k, v] of Object.entries(t.params ?? {})) {
      const p = { type: v.type, description: v.desc };
      if (Array.isArray(v.enum)) p.enum = v.enum;
      if (v.items) p.items = v.items;
      props[k] = p;
      if (v.required) required.push(k);
    }
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.desc + (t.name === 'take_task'
          ? ` 本次可选模型：${taskModelChoices().map(x => x.name).join('、')}。自然语言中的模型要求填入 model；未点名则省略，沿用默认模型。指定型号不存在时先说明，不得自行换型号。`
          : ''),
        parameters: {
          type: 'object',
          properties: props,
          ...(required.length ? { required } : {}),
        },
      },
    });
  }
  return out;
}

/**
 * 把模型返回的一次 tool_call 转成 `runReadTool(name, args)` 认得的东西。
 *
 * @param {{name?:string, arguments?:string|object}} call
 * @returns {{ok:boolean, cn?:string, name?:string, args?:object, why?:string}}
 *   · `cn`   = 中文工具名（交给 `runReadTool`）
 *   · `args` = **中文键**的参数对象（`runReadTool` 里读的就是这些键）
 */
export function normalizeCall(call) {
  const rawName = String(call?.name ?? '').trim();
  const def = BY_NAME.get(rawName);
  if (!def) return { ok: false, why: `不认识的工具「${rawName}」` };

  let raw = call?.arguments;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) raw = {};
    else {
      try {
        raw = JSON.parse(s);
      } catch {
        return { ok: false, why: `「${def.cn}」的参数不是合法 JSON：${s.slice(0, 80)}` };
      }
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};

  // 英文参数名 → 中文键（值原样；`suffix` 用来把 20 拼成「20分钟」）
  const args = {};
  for (const [en, spec] of Object.entries(def.params ?? {})) {
    let v = raw[en];
    // 容错：模型偶尔直接写中文键（认了就当它对）
    if (v === undefined && raw[spec.map] !== undefined) v = raw[spec.map];
    if (v === undefined || v === null || v === '') continue;
    if (spec.suffix && (typeof v === 'number' || /^\d+$/.test(String(v)))) v = `${v}${spec.suffix}`;
    args[spec.map] = v;
  }
  // 没在 schema 里声明的中文键也带上（例如模型自己补了个 `多久`）—— 执行层能读到就用
  for (const [k, v] of Object.entries(raw)) {
    if (k in args) continue;
    if (Object.keys(def.params ?? {}).some((en) => en === k)) continue;
    if (v === undefined || v === null || v === '') continue;
    if (/^[a-z_]+$/i.test(k)) continue; // 纯英文键 = schema 外的噪音，丢掉
    args[k] = v;
  }

  // 必填没给 ⇒ 别执行（省得 handler 里空参跑一半）
  const missing = Object.entries(def.params ?? {})
    .filter(([, s]) => s.required)
    .map(([en, s]) => (raw[en] === undefined && raw[s.map] === undefined ? s.map : null))
    .filter(Boolean);
  if (missing.length) return { ok: false, cn: def.cn, why: `「${def.cn}」缺参数：${missing.join('、')}` };

  return { ok: true, cn: def.cn, name: def.name, args };
}

/** 中文名 → 英文工具名（写日志 / 思考链用，认不出来就原样返回） */
export function enName(cn) {
  return BY_NAME.get(String(cn ?? '').trim())?.name ?? String(cn ?? '');
}

/** 全部中文名（`COMMON_TOOLS` 自查用） */
export function allCnNames() {
  return TOOLS.map((t) => t.cn);
}

/**
 * ⚠️⚠️⚠️ 2026-11-21 加（用户：「**改成自动生成，然后所有工具都要两边自动同步**」）——
 *
 *   以前全量提示词里那张「工具速查表」是**硬编码在 bot.js 里**的 ⇒
 *   加一个工具就得手动改两处，**一定会忘**（实测就漏了 9 个：
 *   工资 / 取消提醒 / 深度思考 / 语音 / 动这一单 / 催进度 / 停 / 读群公告 / 搜图）✗
 *
 *   ⇒ 这里直接**从 TOOLS 生成**，bot.js 只负责拼进去 ✓
 *     以后加工具**只改这一个文件**，两边自动一致 ✓
 *
 *   ⚠️ 「什么情况下用它」取 `desc` 的**第一句**（DSH 风格里第一句就是"它干什么"）✓
 *   ⚠️ 参数按 `params` 自动列（必填的排前面）✓
 *   ⚠️ `scope === 'group-owner'` 的标「仅主人」✓
 *
 * @returns {string[]} 形如 `- \`查服务器\` ↦ 服务器开没开…（无参数）`
 */
export function toolTableLines() {
  const out = [];
  for (const t of TOOLS) {
    if (t.hidden) continue;
    // 第一句（到第一个句号/换行为止）
    const first = String(t.desc ?? '')
      .split(/[\n。]/)[0]
      .replace(/^[⚠️🚫✅🥇🙋🖼️📷📝\s]+/u, '')
      .trim();
    // 参数
    const ps = Object.values(t.params ?? {});
    const req = ps.filter((x) => x.required).map((x) => x.map ?? x.desc ?? '?');
    const opt = ps.filter((x) => !x.required).map((x) => x.map ?? x.desc ?? '?');
    let arg = '无参数';
    if (ps.length) {
      arg = req.length ? req.join(' + ') : `${opt[0] ?? '?'}（可选）`;
      if (opt.length && req.length) arg += `，${opt.join(' / ')}（可选）`;
    }
    const owner = t.scope === 'group-owner' ? '。仅主人' : '';
    out.push(`- \`${t.cn}\` ↦ ${first || '（见工具说明）'}（${arg}）${owner}`);
  }
  return out;
}
