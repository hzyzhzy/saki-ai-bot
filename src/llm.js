import { config } from './config.js';
import { log } from './log.js';
import * as spend from './spend.js';
import { ProxyAgent } from 'undici';
import net from 'node:net';

// ⚠️⚠️ 2026-09-16 深夜：**运行中自动切换网络出口**（用户要求：
//    「要能自动切换网络，比如关掉代理」）。
//
//    背景：那晚机器人整晚不能聊天 —— `_run-bot.bat` 写死走本地代理 127.0.0.1:7890，
//    而代理软件关着 → 每个模型请求 ECONNREFUSED。
//    bat 那边已经能在**启动时**自动选（探端口）；这里再补**运行中**的：
//      · 先用当前出口发请求
//      · 网络类失败（ECONNREFUSED / fetch failed / 超时…）→ **换另一种出口重试一次**
//        （走代理挂了就改直连；直连不通就试代理）—— 不用重启机器人
//      · 记住这次哪种通了，之后的请求优先用它
//
//    ⚠️ 只在**网络类**错误时切换；402/401/风控这些业务错误原样抛（那是另一套处理）。
const PROXY_URL = process.env.QQBOT_PROXY || 'http://127.0.0.1:7890';
let egress = 'unknown'; // 'direct' | 'proxy' | 'unknown'
let proxyAgent = null;
let probedAt = 0;
let proxyOk = false;

/** 代理端口通不通（缓存 60 秒；`force` 时立刻重探） */
async function proxyAlive(force = false) {
  if (!force && Date.now() - probedAt < 60000) return proxyOk;
  probedAt = Date.now();
  let u;
  try {
    u = new URL(PROXY_URL);
  } catch {
    proxyOk = false;
    return false;
  }
  proxyOk = await new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(400, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
  return proxyOk;
}

const isNetErr = (e) =>
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timeout|aborted/i.test(
    `${e?.message ?? ''} ${e?.cause?.code ?? ''}`,
  );

/** 用指定出口发一次请求 */
function rawFetch(url, opts, mode) {
  if (mode === 'proxy') {
    proxyAgent ??= new ProxyAgent(PROXY_URL);
    return fetch(url, { ...opts, dispatcher: proxyAgent });
  }
  return fetch(url, opts);
}

/**
 * 带**自动切换出口**的 fetch（llm.js 里所有模型请求都走它）。
 * ⚠️ 换出口重试**只做一次**（两次都挂就是真挂，交给上层按故障处理）。
 */
export async function llmFetch(url, opts = {}) {
  if (egress === 'unknown') egress = (await proxyAlive()) ? 'proxy' : 'direct';
  const first = egress;
  try {
    return await rawFetch(url, opts, first);
  } catch (e) {
    if (!isNetErr(e)) throw e;
    const other = first === 'proxy' ? 'direct' : 'proxy';
    if (other === 'proxy' && !(await proxyAlive(true))) throw e; // 代理本来就不通，别白试
    log.warn(
      `[网络] ${first === 'proxy' ? '代理' : '直连'}失败（${e?.cause?.code || e?.message}）→ 换` +
        `${other === 'proxy' ? '代理' : '直连'}重试一次（运行中自动切换，2026-09-16）`,
    );
    const res = await rawFetch(url, opts, other);
    egress = other;
    log.info(`[网络] 切到${other === 'proxy' ? '代理' : '直连'}，接下来的请求都用它`);
    return res;
  }
}

// 注意：不要在模块顶层解构 config.llm —— 那样会把配置固化在加载时，
// 管理界面改了模型或 Key 之后就不生效了。统一在函数里现读。
const llmCfg = () => config.llm;

/**
 * 调用 OpenAI 兼容接口，流式产出文本增量。
 * @param {{role:string, content:string}[]} messages
 * @param {AbortSignal} [outerSignal]
 * @param {{maxTokens?:number}} [opts] 按次覆盖参数（解题模式要更大的上限）
 * @returns {AsyncGenerator<string>}
 */
export async function* streamChat(messages, outerSignal, opts = {}) {
  const llm = llmCfg();

  // ⚠️ 解题模式要更大的 max_tokens（2026-09-12）：
  //    flash 的**思考链也计入 completion_tokens** —— 一道折叠最值题想清楚了
  //    可能就烧掉几千 token，正文没写几句就被截断（表现是"空回复"或"说到一半没了"）。
  const maxTokens = Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : llm.maxTokens;

  // ⚠️⚠️ 2026-09-13 修：**超时要跟着 token 预算放大**。
  //
  //    踩过（用户截图）：他发了张图 + 一句短话，被判成「解题模式」→
  //      `max_tokens` 抬到 **24000**，而超时**还是写死的 60 秒** →
  //      推理模型产出 24k token 根本不可能 60 秒内完成 →
  //      **`LLM 请求超时`** → 群里显示「⚠️ 模型调用出错了，请稍后再试」。
  //
  //    也就是说：**解题模式在旧代码下几乎必然超时** ——
  //    max_tokens 调大了、但等它的时间没跟着调大，等于白调。
  //
  //    现在：按「每 1000 token ≈ 3 秒」估算，最少用 `llm.timeout`，
  //    上限 `llm.timeoutMax`（默认 180 秒）。普通回复（8000）→ 仍是 60 秒左右；
  //    解题（24000）→ 放宽到 ~72 秒以上。
  const estMs = Math.ceil(maxTokens / 1000) * 3000;
  const timeoutMs = Math.min(
    Math.max(llm.timeout, estMs),
    Number(llm.timeoutMax) > 0 ? Number(llm.timeoutMax) : 180000,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('LLM 请求超时')), timeoutMs);
  const onAbort = () => controller.abort(outerSignal?.reason);
  outerSignal?.addEventListener('abort', onAbort, { once: true });

  if (timeoutMs !== llm.timeout) {
    log.debug(`本次超时放宽到 ${Math.round(timeoutMs / 1000)} 秒（max_tokens=${maxTokens}）`);
  }

  // ⚠️ `usage` 必须声明在 **try 外面** —— 它要在 `finally` 里用来记账，
  //    而 finally 是 try 的**兄弟作用域**，看不到 try 块里声明的变量。
  //    （第一版就写在了 try 里面 → `ReferenceError: usage is not defined`。）
  let usage = null;

  try {
    const res = await llmFetch(`${llm.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages,
        temperature: llm.temperature,
        max_tokens: maxTokens,
        stream: true,
        // ⚠️ 加了这行，流式响应才会在**最后一块**带 `usage`
        //    （记账要用它，见 spend.js；不加的话只能估算）
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM 接口返回 ${res.status} ${res.statusText}${body ? ` :: ${body.slice(0, 400)}` : ''}`);
    }
    if (!res.body) throw new Error('LLM 接口没有返回响应体');

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let sawAny = false;
    /** 有没有产出过思考链 —— 用来判断「正文为空」是不是被思考吃光了 token */
    let sawReasoning = false;

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });

      // SSE 以空行分隔事件
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const rawLine of block.split('\n')) {
          const line = rawLine.trim();
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;

          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;

          let json;
          try {
            json = JSON.parse(payload);
          } catch {
            continue; // 半包/噪声，跳过
          }
          if (json.error) {
            throw new Error(`LLM 返回错误: ${json.error.message ?? JSON.stringify(json.error)}`);
          }

          // ⚠️⚠️ **先抓 usage，再判 delta**（2026-09-13）。
          //    DeepSeek 把用量放在**最后一块**，而那一块 `choices` 是**空数组** ——
          //    所以必须放在下面 `if (!delta) continue` **之前**，
          //    否则永远拿不到用量（记账就全空了）。
          //    （请求里要带 `stream_options:{include_usage:true}`，见下面 body。）
          if (json.usage) usage = json.usage;

          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          // 推理模型的思维链单独放在 reasoning_content 里，不发给用户。
          // ⚠️ 但要记一下「有没有思考过」—— 用来判断正文为空是不是被思考吃光了。
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            sawReasoning = true;
          }
          const text = delta.content;
          if (typeof text === 'string' && text) {
            sawAny = true;
            yield text;
          }
        }
      }
    }

    if (!sawAny) {
      // ⚠️ 这里**不能只用 debug** —— 正文为空是个很容易被忽略的故障：
      //    表现是「群里只回一句莫名其妙的空话」，而日志里什么都看不到。
      //    真实踩过三次（vision / extract / 教学回执），都是同一个原因：
      //    **推理模型的思考链把 max_tokens 吃光了**，正文一个字都写不出来。
      if (sawReasoning) {
        log.warn(
          `LLM 只产出了思考链、没有正文 —— 很可能是 max_tokens(${llmCfg().maxTokens}) 被思考吃光了。` +
            `可以把 max_tokens 调大，或者对这类任务设 thinking:{type:'disabled'}`,
        );
      } else {
        log.warn('LLM 流结束，但没有任何产出（模型返回空）');
      }
    }
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
    // ⚠️ **记账**（2026-09-13）：把这次的 token 用量记下来
    //    （用户要"问它今天花了多少钱 / 这个月用了多少 token"）。
    //    放在 finally：**报错也要记** —— 失败的调用同样烧 token。
    if (usage) {
      try {
        spend.record({ model: llm.model, usage });
      } catch (e) {
        // ⚠️ 这里**必须用 warn 而不是 debug** —— 我第一次就是把
        //    `spend` 的 import 漏了，`ReferenceError` 被 debug 吞掉，
        //    表现是"记账永远是 0"，查了很久。记账失败要看得见。
        log.warn(`记账失败（用量没记上）：${e.message}`);
      }
    }
  }
}

/**
 * 生成一句**「等一下」的过渡话**（回复超过若干秒时才用）。
 *
 * ⚠️ 为什么要有这个（2026-09-13，用户要求）：
 *    用户原话：「**建议超出20秒时，机器人先随便回复一句你等等之类的话**」，
 *    接着又补：「**回复的话不要太死板，也可以经过 llm**」。
 *
 *    背景：生成慢的时候（识图、联网搜、解题）群友会以为它死了，
 *    发「怎么不回我」。所以要在等的时候先应一声。
 *
 *    ⚠️ 但**不能用固定的三句话**（原来写死「哦，等下，我看看」那种）——
 *    同一句反复出现很机械，而且接不上对方具体问了什么。
 *    所以这里花一次**很轻**的调用，让它自己说一句。
 *
 * ⚠️ 关键：必须**关掉思考链**并给很小的 max_tokens。
 *    这是推理模型 —— 不关思考的话它会开始"想"，几秒起步、还可能把
 *    token 吃光（那就变成又一次超时了）。目标是**1~2 秒出话**。
 *
 * ⚠️ 提示词里必须明确「**先别答**」—— 否则它可能把答案一起说了，
 *    等真正的回复出来就变成答两遍。
 *
 * @param {{name?:string, text?:string, extra?:string}} p
 * @returns {Promise<string>} 一句话；失败就返回空串（调用方会退回兜底话术）
 */
export async function quickAck(p = {}) {
  const llm = llmCfg();
  const who = String(p.name ?? '').trim() || '群友';
  const asked = String(p.text ?? '').trim().slice(0, 60);
  const extra = String(p.extra ?? '').trim();

  const sys = [
    // ⚠️ 自称用「Saki」（2026-09-13 用户：「祥子的话遇到没看过 MyGO 的很容易误认为骆驼祥子」）
    '你在一 QQ 群里当客服，人设：Saki（丰川祥子），有点傲娇、说话短、不像客服腔。',
    '',
    '现在对方刚发来一条消息，**你还在处理**（可能是在想怎么说，也可能真的要去查一下），需要先说一句让他别等急。',
    '',
    '## 要求',
    '· **只回一句话**，不超过 15 字',
    '· 自然、像随手打的，**别客套**（不要「请稍等」「正在为您处理」这种客服腔）',
    '· ⚠️ **先别回答他问的问题** —— 你只是在说"我看看"，答案等下再说',
    // ⚠️⚠️ 2026-09-16 用户截图报的：「问动画的信息，说**翻翻**有点奇怪」——
    //    她答的是「嗯…等我翻翻」。问题在于：**她是本人，手边没有资料库**，
    //    "翻翻/查查/搜搜"这种话说出来就成了"客服台在翻档案"，一秒露馅。
    //    所以这里把两件事分开：
    //      · 只是**在想/在组织语言**（问她自己的事、回忆、看法）→ 说「我想想」「嗯…」
    //      · **真的要去上网查**（新番、别人的歌、游戏数据）→ 才可以用"查/搜"
    '· ⚠️⚠️ **除非真的要上网查，否则不许说「翻 / 查 / 搜 / 资料 / 档案 / 记录」这类词** ——',
    '  那听起来像你手边有一份资料可翻（你不是客服台，也没有档案）。',
    '  问**你自己的事、你的回忆、你的想法**（「你还记得…」「月之森有没有…」）→',
    '  说「我想想」「让我回忆一下」「嗯…」这种就行；',
    '  真的在**上网查**（别人的歌 / 新出的东西 / 游戏数值）→ 才可以用「我去查查」「等我搜一下」',
    // ⚠️ 2026-09-13 用户反馈「**吵死了**这个有点不好听」——
    //    它本意是"我看看"，但说成"吵死了"就是在训人。
    //    这句话的功能是**安抚**（让人知道我在处理），语气不能反着来。
    '· ⚠️ **语气要是"别急、我在看"，不是在训人** ——',
    '  不要说「吵死了」「别催」「烦不烦」「催什么催」这种**嫌弃对方**的话；',
    '  也不要反问、不要抱怨。你是随口应一声，不是被打扰了在发火',
    // ⚠️⚠️ 2026-09-17 用户截图报的（原话：「**等等机制的文案不对**」）：
    //    群友发的是一张**几何题图**，题面清清楚楚写着「求 △DEF 周长的最小值？」，
    //    而过渡话说的是「**喊我五遍有什么用，题呢，打字发过来**」——
    //    **断言了"图里没有题面"**，可她根本还没看完那张图（正文里答案是发出来了的）。
    //    这和上面"不许说翻/查"是同一类毛病：**还没看就先下结论**。
    '· ⚠️⚠️ **对方发了图的时候，绝对不许说「图我看不到」「看不清」「你打字发过来」',
    '  「题呢」「文字呢」「没看到题目」这类话** —— 你**正在看图**，只是还没看完。',
    '  这时候只要应一声（「我看看」「嗯…等下」「这图我瞅瞅」），或者顺着图说一句中性的。',
    '  ❌ 尤其**不许断言图里缺少什么**：等正文一给出答案，那句过渡话就成了打自己脸。',
    '· ⚠️ 可以带点你自己的语气（好奇、随口应一声都行）',
    // ⚠️ 实测（2026-09-13）：不加这条会**六条里五条都是「我看看」** ——
    //    同一句反复出现就成模板了（人设里专门有一条反对固定句式）。
    // ⚠️ 2026-09-16：例句里**删掉了「等我翻翻」**（用户就是被这句击中的），
    //    并把它换成了"回忆型"的说法。
    '· ⚠️ **别老用「我看看」这个说法**（偶尔可以）：换换词 ——',
    '  「稍等」「等我一下」「让我想想」「嗯…我想想」「让我回忆一下」…',
    '  或者就应一声（「哦」「嗯」「收到」）加半句你自己的话，别每次同一个句式',
    '· 直接给这句话，不要引号、不要解释',
  ].join('\n');

  const user = [`${who}：${asked || '（发了个东西）'}`];
  if (extra) user.push(`（${extra}）`);

  try {
    const res = await llmFetch(`${llm.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user.join('\n') },
        ],
        temperature: 1.0,
        max_tokens: 200,
        thinking: { type: 'disabled' },
        stream: false,
      }),
      // 这句话本身不能慢 —— 它就是为了"显得没卡住"，自己卡住就没意义了
      signal: AbortSignal.timeout(Number(llm.ackTimeoutMs) > 0 ? Number(llm.ackTimeoutMs) : 8000),
    });
    if (!res.ok) {
      log.debug(`过渡话生成失败 HTTP ${res.status}`);
      return '';
    }
    const json = await res.json();
    // 记账（非流式也有 usage）
    if (json.usage) {
      try {
        spend.record({ model: llm.model, usage: json.usage });
      } catch {}
    }
    const t = String(json.choices?.[0]?.message?.content ?? '')
      .trim()
      .replace(/^["'「『]|["'」』]$/g, '')
      .replace(/\s*\n+\s*/g, ' ')
      .trim();
    // 太长就不像"随口一句"了，截断
    const out = t.length > 30 ? t.slice(0, 30) : t;
    if (out) log.debug(`过渡话：「${out}」`);
    return out;
  } catch (e) {
    log.debug(`过渡话生成出错：${e.message}`);
    return '';
  }
}

/**
 * 润色类请求共用的**人设一句话**。
 *
 * ⚠️ 为什么要抽出来（2026-09-13）：同一句自我介绍我复制到了
 *    `quickAck` / `phraseMoney` / `spend.earnReply` 三处，
 *    一改自称就漏一处（真的漏了 —— 用户要求自称改「Saki」时，
 *    我改了两个地方才发现第三个还写着「客服小祥」）。
 *
 * ⚠️ **自称用「Saki」**（用户原话：「祥子的话遇到没看过 MyGO 的
 *    很容易误认为骆驼祥子」——中文里「祥子」第一反应是老舍那个车夫）。
 *    别人怎么叫她另说（小祥/祥子都认，见 `knowledge/anime.md` 的外号表）。
 */
export const PERSONA_LINE =
  '你是丰川祥子（自称一律用 **Saki**；群里管你叫「客服 Saki」「客服小祥」，' +
  '但**别人喊你什么外号都照常应答，别去纠正称呼**），在一 QQ 群里当客服。';

/**
 * 「把一段事实用她的口吻说出来」—— 一次**非流式、关思考**的短调用。
 *
 * ⚠️ 用途（2026-09-13 用户要求）：「回复的话不要太死板，也可以经过 llm」——
 *    典型场景是报账（`spend.js` 的 `spendReply`）和月末工资单
 *    （`monthly-report.js`）：数字必须准，但**说法不能像念报表**，
 *    所以把数字交给模型润色。
 *
 * 为什么关思考 + 非流式：
 *   · 内容已经定死了，不需要它推理，开着思考只是白等几秒
 *   · 非流式拿到的是一整段，不用自己拼
 *
 * **任何失败都返回空串**，调用方退回模板 —— 宁可说法死板，也不能不回答。
 *
 * @param {{system:string, user:string, maxTokens?:number, timeoutMs?:number}} p
 * @returns {Promise<string>}
 */
export async function phrase(p = {}) {
  const llm = llmCfg();
  const sys = String(p.system ?? '').trim();
  const user = String(p.user ?? '').trim();
  if (!sys || !user) return '';
  const maxTokens = Math.max(60, Math.min(900, Number(p.maxTokens) || 220));
  const timeoutMs = Math.max(3000, Number(p.timeoutMs) || Number(llm.phraseTimeoutMs) || 15000);

  try {
    const res = await llmFetch(`${llm.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature: 1.0,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn(`润色失败 HTTP ${res.status}`);
      return '';
    }
    const json = await res.json();
    if (json.usage) {
      try {
        spend.record({ model: llm.model, usage: json.usage });
      } catch {}
    }
    const t = String(json.choices?.[0]?.message?.content ?? '')
      .replace(/```[a-z]*\n?/gi, '')
      .replace(/\*\*/g, '')
      .replace(/^["'「『]|["'」』]$/g, '')
      .trim();
    if (t) log.debug(`润色：「${t.replace(/\s+/g, ' ').slice(0, 80)}」`);
    return t;
  } catch (e) {
    log.warn(`润色出错：${e.message}`);
    return '';
  }
}

/**
 * 账目类润色的**共用提示词**（报账 + 月末工资单都走这里）。
 *
 * ⚠️ 为什么抽出来：这两处的铁律完全一样（数字不许改、不许说净赚、
 *    别解释算式）。各写一份的话，改了一处忘了另一处 —— 这种"两套规矩"
 *    迟早会让同一个问题在不同路径下答得不一样，用户一眼就能看出是机器人。
 *
 * @param {{facts:string, asked:string, style?:string, maxLines?:number,
 *          extraRules?:string[]}} p
 * @returns {Promise<string>}
 */
export async function phraseMoney(p = {}) {
  const facts = String(p.facts ?? '').trim();
  if (!facts) return '';
  const asked = String(p.asked ?? '').trim().slice(0, 80);
  const maxLines = Math.max(1, Number(p.maxLines) || 2);

  const sys = [
    PERSONA_LINE,
    '性格：有点傲娇、说话短、自然，**绝对不要客服腔**（不要「您好」「请查收」「为您统计」）。',
    '',
    '系统已经把**准确的数字**给你了。你的任务只是**用你自己的口吻把数字说出来**。',
    '',
    '## 铁律',
    '· ⚠️ **数字一个字都不能改、不能四舍五入、不能自己算** —— 照抄系统给的数',
    '· ⚠️ 系统没给的数字**不要编**（比如余额、单价、汇率）',
    '· ⚠️ **不要解释算式**（别说"成本乘一百"这种）—— 就当是你自己挣的钱',
    '· ⚠️ **绝对不要说「净赚」「利润」这两个词** —— 用「工资」',
    // ⚠️⚠️ 方向问题（2026-09-13 用户截图）：HZY 问「你现在工资多少钱」，
    //    她答「1876，就这点，**别嫌少了**」——「别嫌少」是**发钱的人**说的话，
    //    一句话就把自己摆到老板位置上，人设整个翻掉。
    //    这条必须放进**每一个报钱路径**（不能只写在余额那段，报账/月结也要有）。
    '· ⚠️⚠️ **你是领工资的那个，HZY 是发工资的**（他雇你）—— 别说发钱方的台词：',
    '  不说「别嫌少」「将就一下」「这个月就发这么多」「省着点用」—— 那是老板口吻。',
    // ⚠️⚠️ 这里**故意不给领钱方的示例台词**（2026-09-14 用户反馈）。
    //
    //    原来这条写的是：
    //      '  要说也只能是领钱方的：「就这么点」「还不够花」「你还没发呢」'
    //    —— 结果模型**直接抄**了「就这么点」当成口头禅，
    //    用户看到的原话：「**就这么多**和**九牛一毛**这两个词汇都反复出现了」。
    //
    //    教训：**提示词里凡是带引号的短句，都可能被逐字抄进回复。**
    //    要示范"方向"就描述方向（上面那半句），别给可直接复用的句子。
    //    （同类问题见 `anime.md` 一点六和 `earnReply` 的 extraRules。）
    '  判据是**立场**：这句话像不像"发钱的人在安抚拿钱的"？像就换掉。',
    '  ⚠️ 至于"领钱方该怎么说"，**上面那几句是反例，不是模板** ——',
    '    自己按那个立场想新说法，别把上面任何一句的字面措辞搬进回复。',
    '· 问什么答什么：问花销就只说花销，问工资就只说工资，别把整张账单糊过去',
    '· 谁问都照实说（**群友问工资也报** —— 那是你自己挣的，没什么好藏的）',
    `· 短，${maxLines} 行以内，不要分点列表，不要 markdown`,
    ...(p.extraRules ?? []),
  ].join('\n');

  const user = [
    asked ? `他问/要的是：「${asked}」` : '',
    String(p.style ?? '').trim(),
    '',
    '## 系统实测数据（照这个说）',
    facts,
  ]
    .filter((x) => x !== '')
    .join('\n');

  const t = await phrase({ system: sys, user, maxTokens: p.maxTokens, timeoutMs: p.timeoutMs });
  // ── 防跑偏（这里拦不住的话就会**原样发到群里**）──
  //  · 把提示词原话吐出来（踩过：把「别解释算式」发到群里了）
  //  · 说了「净赚/利润」（用户明确不许）
  //  · 把 token 说成「烧了/消耗了」（那是程序员的话，不是她的话）
  //    ⚠️ 这条原来只在预览脚本里查，结果生产路径漏出去过（实测出现过
  //      「吭哧吭哧烧了一百多万 token」）—— 黑名单必须在**发送路径**上。
  //  · 把自己当发工资的那方（踩过：「别嫌少了」）
  if (!t) return '';
  // ⚠️ "在复述提示词"的形状 —— 实测漏过一次「**说我叫丰川祥子**，工资 1850」
  //    （它把「他问的是：『你叫什么名字』」里的内容当成自己要说的东西了）。
  //    这类句子发到群里非常明显是机器人在读稿。
  //    ⚠️ 判据要收窄：「说你什么好」这种正常话别误伤。
  if (/别解释算式|系统实测|铁律|照抄|##/.test(t)) return '';
  if (/^(说|回答|回复)我(叫|是|的|有|该|这)/.test(t) || /^我(应该|要)(说|回答|回复)/.test(t)) return '';
  if (/净赚|利润/.test(t)) return '';
  if (/烧了|烧掉|消耗了\s*\d|花掉了\s*\d/.test(t)) return '';
  // 把自己当发工资的那方（踩过：「别嫌少了」）
  if (/别嫌少|将就一下|这个月就发这么多|省着点用/.test(t)) return '';
  // ⚠️ 自称别用「祥子」（2026-09-13 用户：「祥子的话遇到没看过 MyGO 的
  //    很容易误认为骆驼祥子」）。人设里的示例台词大量用「小祥」，
  //    模型很容易顺手写「我祥子可没说过」——「小祥」没问题，「祥子」要拦。
  //
  //    ⚠️ 不能简单搜「我祥子」：**"别喊我祥子，叫我 Saki" 是她在纠正别人**，
  //      那句话该放行（把纠正也拦掉，等于逼她接受这个称呼）。
  //      所以只拦**自我断言**的形状：「我祥子」后面紧跟动词/助词。
  if (/我祥子[可也的确是不没就别能会要想来在说从干做]/.test(t) || /祥子我[觉认以想说]/.test(t)) return '';
  // ⚠️⚠️ 她**不该去管别人怎么叫她**（用户 2026-09-13：「别人叫她所有外号都应该
  //    没关系，正常回应」）。纠正称呼 = 答非所问，而且显得在意外号。
  //    只有对方**认真问"该怎么称呼"**时才该答，那种情况下面这些形状也不会出现。
  if (/我不叫(祥子|小祥)|别叫我(祥子|小祥)|叫我\s*Saki\s*就(行|好)|请叫我\s*Saki/.test(t)) return '';
  // ⚠️⚠️ 168 亿 **不是她的债、她没有偿还义务** —— 但**也不能因此撇清**
  //    （用户 2026-09-13：「**反正也不是我要还的**感觉也有点 OOC 了，
  //      她之前努力打工也有一部分努力在这里」）。
  //
  //    三种口气要分清（前两种对，第三种 OOC）：
  //      ✅ 自嘲：      "跟 168 亿比这点算什么"「九牛一毛都算不上」
  //      ✅ 事实澄清：  "那是损失，不是欠条"（不承认自己在还债）
  //      ⛔ 冷漠撇清：  "反正不是我要还的""关我什么事"← **人设崩在这**
  //
  //    ⚠️ 为什么不用"穷举句式"来判：我试过写一串正则（把跟它没关系/关我什么事/
  //      又不是我要还…全列上），结果**标点一插就漏**（「那又不是欠条，关我什么事」
  //      的逗号让 `.*` 的写法失效）。改成**算两边的证据分**，稳得多：
  //        · dismissal = 撇清用的词（反正、关我什么事、轮不到我…）
  //        · owning    = 认这件事的词（我在挣、我没说跟我无关、那是我们家的事…）
  //      有撇清 / 没有"认"的迹象 → 拦。
  if (/168\s*亿|一六八亿/.test(t)) {
    // ① 宣布自己在还债（这是"负债少女"，也不对）
    //    正则按形状写，别写死短语 —— 第一版写「我在还」，
    //    结果「我还**在**还那 168 亿呢」直接漏了（中间插了个字）。
    const declaring = /还[在得要想该能会]{0,2}\s*还|还债|还清|还完|偿还|我欠|欠着|还不上/;
    // ⚠️ 「不是欠条」**不能**算作澄清 —— 「那又**不是欠条**，关我什么事」
    //    里的"不是欠条"是**撇清的一部分**，不是事实澄清（这个误判害我白查一轮）。
    //    真正的澄清要带"损失 / 不是我的债 / 没说我在还"。
    const factOnly = /那是损失|不是我的债|不是我欠|没签欠条|我没在还|我没说我在还/;
    if (declaring.test(t) && !factOnly.test(t)) return '';

    // ② 冷漠撇清（OOC）
    const dismissal = /反正|关我什么|关我啥|不关我|跟我没关系|跟我无关|轮不到我|不是我要还/;
    const owning = /我在.{0,3}(挣|做|干|忙)|我一直在|我没说跟我|是(我|我们)家|你以为是为什么|不然我|我图什么/;
    if (dismissal.test(t) && !owning.test(t)) return '';
  }
  return t;
}

/**
 * 数字 → 中文读法（"1834" → "一千八百三十四"）。
 *
 * ⚠️ 为什么要它：发给群里的东西如果写成「工资 ¥1834」，一眼就是机器打印的。
 *    写成「一千八百三十四」才像人在说话。
 *
 * 只处理整数；不支持的超大数就原样返回。
 *
 * @param {number} num
 * @returns {string}
 */
export function cjkNum(num) {
  const v = Math.round(Number(num) || 0);
  if (!Number.isFinite(v) || v < 0 || v > 99999999) return String(v);
  if (v === 0) return '零';
  const D = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const U = ['', '十', '百', '千'];
  const section = (x) => {
    let s = '';
    let zero = false;
    for (let i = 3; i >= 0; i -= 1) {
      const d = Math.floor(x / 10 ** i) % 10;
      if (d === 0) {
        zero = s !== '';
      } else {
        if (zero) s += '零';
        zero = false;
        // "一十"读作"十"
        s += (d === 1 && i === 1 && s === '' ? '' : D[d]) + U[i];
      }
    }
    return s;
  };
  const yi = Math.floor(v / 1e8);
  const wan = Math.floor((v % 1e8) / 1e4);
  const rest = v % 1e4;
  let out = '';
  if (yi) out += `${section(yi)}亿`;
  if (wan) out += `${wan < 1000 && out ? '零' : ''}${section(wan)}万`;
  if (rest) out += `${rest < 1000 && out ? '零' : ''}${section(rest)}`;
  return out || '零';
}

/**
 * 非流式调用，用于自检。
 * @returns {Promise<string>}
 */
export async function ping() {
  const llm = llmCfg();
  const res = await llmFetch(`${llm.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({
      model: llm.model,
      messages: [{ role: 'user', content: '回复"ok"两个字母即可' }],
      // ⚠️ 原来只给 16 —— 主模型是推理模型，思考一下就没 token 写正文了，
      //    自检会**误报「模型不可用」**（明明它是好的）。给足 + 关思考。
      max_tokens: 200,
      thinking: { type: 'disabled' },
      stream: false,
    }),
    signal: AbortSignal.timeout(llm.timeout),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` :: ${body.slice(0, 300)}` : ''}`);
  }
  const json = await res.json();
  // ⚠️ 2026-09-15 补：自检这条路原来也没记账（一次 200 token 的量级，很小，
  //    但结构测试要求**每一处打模型的地方都记账** —— 免得下次又漏一个大的）。
  try {
    if (json.usage) spend.record({ model: llm.model, usage: json.usage });
  } catch {}
  return json.choices?.[0]?.message?.content ?? '';
}
