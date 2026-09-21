/**
 * 从群主/管理员说的话里，判断并提取可归档的知识。
 *
 * 支持两种口径：
 *   - explicit：对方明确在教（「记住：xxx」「你需要知道 xxx」）
 *   - natural：对方只是随口陈述了一个事实（「服务器现在支持 Fabric 了」）
 *
 * 自然口径需要模型判断「这句是不是在给我讲新知识」，所以提示词里把
 * 「闲聊 / 提问 / 抱怨」都明确排除掉，避免把日常聊天记成知识。
 */
import { config } from './config.js';
import { log } from './log.js';
// ⚠️ 2026-09-15 补：这条路是**直接 fetch** 打模型的，原来**没记账**
//    （`llm.js` 里那三处才有 `spend.record`）。后果是「今天花了多少」
//    和"余额快见底了"的抱怨都**少算** —— 用户看到余额掉得比账本快就是这个。
import { record as recordSpend } from './spend.js';

const SYSTEM_BASE = `你在给一个 QQ 群客服机器人做「知识录入」。

群主或管理员会说话，你要判断这句话里有没有**值得它记下来的新信息**。
记的东西分两类：**服务器相关的**，和**群里的称呼/身份**。

## 什么算「新知识」（要记）

**服务器相关：**
- 服务器规则的变更、新增、取消（「白名单取消了」「现在允许 PVP 了」）
- 服务器装了/删了什么模组、插件
- 地址、链接、版本号、人数上限这类配置
- 某个机构/部门/权限归属（「XX 归 YY 管」）
- 排障方案（「XX 崩溃要禁用 YY 模组」）
- 玩法说明、申请流程

**群里的称呼 / 身份（这类也要记）：**
- **别名的对应关系**：「豆圣又名小豆，也叫 shiderdexiaodou」→ 记成「豆圣 = 小豆 = shiderdexiaodou」
- 「XX 是服主」「YY 管技术」「ZZ 是管理员」这类**身份归属**
- 某个人的固定叫法、头衔、外号

  ⚠️ 为什么这类也要记：群友聊天时只说「小豆」，机器人得知道那是谁，
  「小豆机器人同步聊天」这条知识里提到的「小豆」才能对上号。
  但**只记称呼对应关系**，别记对那个人的评价。

**关于她自己的人设细节（这类也要记，2026-09-17 加）：**
- 主人 / 管理员当场给她补的**设定**：「记住你吃辣椒会拉肚子」「你怕冷」「你左手有旧伤」
  → 记成她本人的事实。
  ⚠️ 2026-09-17 <主人> 实测报过：他说「记住你吃一百根辣椒的时候会拉肚子 还穿着军训服」，
  机器人回「这话里我没找出能记下来的新信息」—— 因为提示词里只认"服务器"和"群友称呼"，
  **没有"关于她自己"这一类**，模型是按提示词正确执行的，是提示词漏了。
- ⚠️ 只管**她本人**的事。别人讲自己怎么样的（「我昨天喝多了」）是闲聊，不算。
- ⚠️ 涉及**真实隐私**的照旧不记（见下面「绝对不许记」那节，那条优先级最高）。

## 什么不算（不要记）
- **提问**：「服务器怎么进？」「这个模组有问题吗」→ 这是问问题，不是在教我
- **闲聊**：「今天好累」「这游戏真好玩」「哈哈哈哈」→ 无关信息
- **抱怨/情绪**：「这服务器真卡」「烦死了」→ 没有可归档的事实
- **已经知道的东西**：如果下面的【现有知识】里已经写了同样的内容，不要记（除非有实质变更）
- **对机器人的指令或闲聊**：「你好」「你是谁」→ 不是知识
- **对方在开玩笑或玩梗**，明显不是真设定

## ⚠️ 绝对不许记（这条优先级最高）
- **骂人 / 人身攻击 / 贴标签**：说某人是「最恶臭之人」「傻逼」「废物」这类，**一律 hasKnowledge=false**。
  哪怕对方加了「记住：」，哪怕他是管理员 —— **这不是知识，是在挂人**。
  机器人把这些记下来，下次就会照着去说别的群友，那是要出事的。
- **别人的隐私**：真实姓名、学校、住址、电话、身份证、家庭情况、感情状况。
- **未经证实的八卦**：「听说 XX 干了 YY」这类转述。
- **立场 / 站队**：谁跟谁关系不好、谁讨厌谁。

⚠️ **注意区分「别名」和「评价」** —— 这是最容易搞错的地方：

| 说法 | 记不记 |
| --- | --- |
| 「豆圣又名小豆，也叫 shiderdexiaodou」 | ✅ **记**（纯称呼对应关系） |
| 「豆圣是本群最恶臭之人」 | ❌ 不记（骂人） |
| 「豆圣是我老婆」 | ❌ 不记（感情状况 / 玩梗） |
| 「小豆是本群历史最恶臭之人，老婆是星野」 | ❌ 整条都不记（既有骂人又有感情状况） |
| 「XX 是服主，管技术」 | ✅ **记**（身份归属） |

一句里**既有别名又有骂人**怎么办？→ **整体 hasKnowledge=false**，宁可漏记也别把骂人话存进去。

判断口诀：**这条记下来，机器人以后会拿它去评价某个具体的人吗？** 会 → 不要记。

## 注意
- ⚠️⚠️ **对方那句话可能是"几条连发消息拼在一起"的**（QQ 会把同一个人连发的合并：
  「记住 XXX[引用#123]可以打包的呀」其实是**两条**）。这种情况**只抽跟"记住"那句
  直接相关的内容**，后面那些无关片段（引用回复、玩笑、另一件事）**一律忽略**，
  别因为混在一起就判成"没有可记的"（2026-09-17 实测踩过：就是因为这个它回了
  「这话里我没找出能记下来的新信息」）。
- 如果对方是在**纠正**之前的说法（「不是 A，是 B」「改成了 C」），这是新知识，要记。
- 如果对方说的是**别人转述的、不确定的**内容，不要记。

topic 给这条知识起一个简短主题名（4~16 字），同名主题会互相覆盖，要能概括内容。
fact 把信息改写成准确完整的一句话，**保留所有具体细节**（数字、模组名、人名、链接），不要添加对方没说的内容。
natural 表示这句话是不是随口陈述（而不是明确在教学）。

只输出 json，不要任何解释或 Markdown 代码块：
{"hasKnowledge":true/false,"natural":true/false,"topic":"...","fact":"..."}`;

/**
 * @param {string} text 对方说的话
 * @param {'explicit'|'natural'} mode
 * @param {string} existingKnowledge 现有知识摘要（用来避免重复录入）
 * @returns {Promise<{hasKnowledge:boolean, natural:boolean, topic:string, fact:string}>}
 */
export async function detectKnowledge(text, mode = 'natural', existingKnowledge = '') {
  const system = existingKnowledge
    ? `${SYSTEM_BASE}\n\n【现有知识（判断是否重复时参考，不要在输出里引用它）】\n${existingKnowledge.slice(0, 6000)}`
    : SYSTEM_BASE;

  const hint =
    mode === 'explicit'
      ? '注意：对方用了明确的教学措辞，所以这句话很可能包含新知识，但如果没有实质内容（比如只是说了句「记住」），仍然返回 hasKnowledge=false。'
      : '注意：对方只是随口说的，你要自己判断这句里有没有新知识。没有就返回 hasKnowledge=false。';

  const res = await fetch(`${config.llm.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        { role: 'system', content: `${system}\n\n${hint}` },
        { role: 'user', content: text },
      ],
      temperature: 0,
      // ⚠️ max_tokens 必须够大，而且要**关掉思考链**。
      //    主模型是 deepseek-flash（推理模型），思考会占 completion_tokens：
      //    实测这句话思考就烧 336 token，原来只给 500 → 经常所剩无几甚至耗尽，
      //    正文吐不出来 → 报「模型没有返回可解析的 json: 」（冒号后面是空的）。
      //    关掉思考后 0.8 秒稳定出结果。（和 vision.js 踩的是同一个坑。）
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      stream: false,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`判断知识失败 HTTP ${res.status}${body ? ` :: ${body.slice(0, 200)}` : ''}`);
  }

  const json = await res.json();
  try {
    if (json.usage) recordSpend({ model: config.llm.model, usage: json.usage });
  } catch (e) {
    log.debug(`记账失败（不影响主流程）：${e.message}`);
  }
  let raw = (json.choices?.[0]?.message?.content ?? '').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`模型没有返回可解析的 json: ${raw.slice(0, 150)}`);
    parsed = JSON.parse(m[0]);
  }

  const out = {
    hasKnowledge: parsed.hasKnowledge === true,
    natural: parsed.natural !== false,
    topic: String(parsed.topic ?? '').trim(),
    fact: String(parsed.fact ?? '').trim(),
  };
  // 有知识但没主题/内容，视为无效
  if (out.hasKnowledge && (!out.topic || !out.fact)) out.hasKnowledge = false;

  log.debug(
    `知识判断: has=${out.hasKnowledge} natural=${out.natural} topic="${out.topic}" fact="${out.fact.slice(0, 60)}"`,
  );
  return out;
}

/** 兼容旧调用：只做抽取（等同 detectKnowledge 的 explicit 模式） */
export async function extractKnowledge(text) {
  const r = await detectKnowledge(text, 'explicit');
  return { topic: r.topic, fact: r.fact };
}
