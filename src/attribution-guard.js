/**
 * 发言前**强制核对**：这条回复到底是在给谁发消息、有没有把别人的事安到他头上。
 *
 * 用户要求（2026-09-12）：
 *   「现在还是存在认错人的情况，在多人高密度发言时。
 *     我建议在每次编写发言之前强制判断一遍到底是在给谁发消息」
 *
 * 背景（真实踩过两次）：
 *   ① 「小猪名单」那次：机器人编了一份名单，两分钟后**拿自己编的去认人**，
 *      把问话的群友认成了榜单上的另一个人
 *   ② 多人高密度发言时，经常把 A 说的安到 B 头上
 *
 * 做法：草稿写完之后、**发出去之前**，再问一次模型：
 *   · 你这条回复是在回谁？
 *   · 有没有把别人做的事/说的话安到他头上？
 *   · 有没有认错人（比如把人认成名单里的人、认成对话里的另一个人）？
 * 不对就重写，对就原样发。
 *
 * ⚠️ 三个设计约束：
 *   1. **限时**（默认 8 秒）—— 它挡在每条回复前面，不能拖
 *   2. **失败放行**（默认"没问题"）—— 核对本身是保险，不能变成新的故障点
 *      （判断服务一挂就永远不回复，那是更糟的 bug）
 *   3. **短回复跳过** —— 十几个字的接梗几乎不涉及归属，省一次调用
 */
import { config } from './config.js';
import { log } from './log.js';
import { streamChat } from './llm.js';
import * as persona from './persona.js';

// ⚠️ 开头的「【归属核对】」是**给测试用的标记**（2026-09-13 加）：
//    测试的假模型要能一眼分辨这是"归属核对"的请求还是"该不该说"的请求 ——
//    原来它只认 speak-judge 的「假装成真人群友」，认不出归属核对 →
//    **每次都要等满 8 秒超时**，回归因此变得很慢（用户反馈「跑回归时间太长了」）。
const PROMPT = `【归属核对】你在检查一条**即将发到 QQ 群里**的回复，看它有没有**认错人**。

## 你会看到
1. 群聊最近的记录（每条标了**是谁说的**）
2. 刚才是谁发了什么（**你是要回他**）
3. 你写好的一条回复草稿

## 你要查的就一件事：**这条回复把话说给谁了？对不对？**

具体查这几种错：

- **认错人**：回复里提到的人 / 回应的事，其实是**另一个人**说的或做的
  （例：A 说要请假，你回「B 你要请假？」，就是在认错人）
- **把事安错人**：A 分享了一件事，你却在回 B
- **对着错的角色说话**：把服主当普通群友、把群友当服主
- **编造身份**：给人安了图里/上下文里没有的身份（「你就是名单上那个」）

⚠️ **特别注意**：如果草稿里出现了某个人的名字，**核实那个名字是不是当前说话的人**。
名字对不上就是这个错。

## 输出（只输出 JSON）

没认错人：
{"ok": true}

认错了（给出改好的版本）：
{"ok": false, "why": "一句话说明错在哪（15 字内）", "fixed": "改好的回复"}

## 改的时候注意
- 保持**原来的语气和人设**${persona.promptText('attributionTone')}
- **保持短**（大部分不超过 15 字，除非原来是技术解答）
- 只改「认错人」这部分，**别的别动**
- 如果原回复其实没问题，就别改（宁可 ok:true）
- 🚫 **绝对不许改成"空头承诺"**：像「**我去搜搜**」「等我查查」「我看看哈」
  「一会儿告诉你」这种 —— **说了又不会真去做**，等于没回答。
  ⚠️ 2026-09-15 用户截图就是这一条：草稿胡说「Luminiflux 是他自己的号」，
  核对把它改成了「Luminiflux是谁啊，**我去搜搜**」，用户回「快去搜」，然后**没有下文**。
  用户原话：「这种能不能**真的去做这件事情**然后给回复」。
  · 要改就往**确定的方向**改：直接说你不认识 / 直接说系统给的事实 / 直接说不确定
  · 🚫 也别改成反问（「你问这个干嘛」）或者让人自己去查（「你自己去搜」）`;

/**
 * 核对一条草稿。
 *
 * @param {object} p
 * @param {string} p.draft   草稿正文
 * @param {string} p.context 群聊最近记录（带说话人）
 * @param {{name:string, text:string}} p.current 当前说话的人和内容
 * @returns {Promise<{ok:boolean, why:string, fixed:string, ms:number, checked:boolean}>}
 */
export async function checkAttribution({ draft, context = '', current = { name: '', text: '' } }) {
  const t0 = Date.now();
  const pass = { ok: true, why: '', fixed: '', ms: 0, checked: false };

  const d = String(draft ?? '').trim();
  if (!d) return pass;

  if (config.attribution?.enable === false) return pass;

  // ③ 短回复跳过：十几个字的接梗几乎不涉及"把事安到谁头上"
  const minChars = Math.max(0, Number(config.attribution?.minChars) ?? 12);
  if (d.length < minChars) return { ...pass, ms: Date.now() - t0 };

  const timeoutMs = Math.max(2000, Number(config.attribution?.timeoutMs) || 8000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('归属核对超时')), timeoutMs);

  const user = [
    '# 群聊最近的记录（从旧到新，每条前面是说话人）',
    context || '（没有更多上下文）',
    '',
    '# 现在要回的是这个人',
    `${current.name || '（未知）'}：${current.text || '（空）'}`,
    '',
    '# 你写好的回复草稿',
    d,
    '',
    '这条回复认错人了吗？',
  ].join('\n');

  try {
    let raw = '';
    try {
      for await (const chunk of streamChat(
        [
          { role: 'system', content: PROMPT },
          { role: 'user', content: user },
        ],
        ctl.signal,
      )) {
        raw += chunk;
        if (raw.length > 900) break; // 够解析了
      }
    } finally {
      clearTimeout(timer);
    }

    const m = String(raw).match(/\{[\s\S]*\}/);
    if (!m) {
      log.debug(`[归属核对] 没给出 JSON（${String(raw).slice(0, 40)}），放行`);
      return { ...pass, ms: Date.now() - t0 };
    }
    const j = JSON.parse(m[0]);
    const ok = j.ok !== false;
    const fixed = String(j.fixed ?? '').trim();
    const out = {
      ok,
      why: String(j.why ?? '').slice(0, 30),
      fixed: !ok && fixed ? fixed : '',
      ms: Date.now() - t0,
      checked: true,
    };
    if (!ok) {
      log.info(`[归属核对] ❌ 认错人：${out.why}${out.fixed ? `，改成了「${out.fixed.slice(0, 30)}」` : ''}`);
    } else {
      log.debug(`[归属核对] ✅ 没问题（${out.ms}ms）`);
    }
    return out;
  } catch (e) {
    // ⚠️ 核对出错一律**放行**（不能因为保险失效就不说话了）
    log.warn(`[归属核对] 出错（${e.message}），放行`);
    return { ...pass, ms: Date.now() - t0 };
  }
}
