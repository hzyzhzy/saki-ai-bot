/**
 * 群禁言 —— 刷屏时把那个人**真的禁言**一分钟（不只是机器人自己闭麦）。
 *
 * 用户要求（2026-09-13）：
 *   「加个禁言机制吧，检测到刷屏或者触发拦截时禁言1分钟，群已经有管理员权限了。
 *     触发的时候也可以发一句评论语，但是不能有攻击性，可以带玩笑意味。」
 *   「和傲娇成分」
 *
 * ⚠️ 和原来那句"停一下，你刷屏了（"的区别：
 *    **原来只是机器人自己不回他**（software mute），现在是真的**调用群禁言**（把嘴堵上）。
 *    性质完全不同 —— 这是**公开的、别人看得见的社交动作**，所以：
 *
 *    · **语气必须轻**。禁言已经是个惩罚了，配一句凶的话就是仗势欺人。
 *      要像"损友顺手按住你"那样：嫌弃、但明显没生气（傲娇）。
 *    · **绝不能用**：「你被禁言了」「违规」「请遵守群规」这种管理腔 ——
 *      听起来像在行使权力，非常招黑。
 *    · **禁言失败要静默**（没权限就退回"机器人自己不理他"）。
 *
 * ⚠️ 已知风险：禁言是**有争议的动作**。所以：
 *    · 只给**明确的刷屏**用（判据干净）
 *    · 服主/管理员**永不**禁言
 *    · 同一个人有冷却（别反复禁）
 */
import { config } from './config.js';
import { log } from './log.js';

/** 傲娇味的禁言台词 —— 嫌弃但不凶，带玩笑 */
const LINES = [
  '停，一分钟。吵得我脑仁疼（',
  '你话太多了，歇会儿（',
  '……闭嘴一分钟，就一分钟',
  '吵死了，我替你按个暂停（',
  '你这一串，我看不过来了，先安静会儿',
  '行了行了，你先冷静一分钟',
  '再刷我就当你在练打字速度了',
  '给你一分钟，组织一下语言',
];

/**
 * 随机一句禁言台词。
 * ⚠️ 不许有攻击性 —— 这里的每句都是"嫌弃但没生气"，不是指责。
 */
export function muteLine() {
  return LINES[Math.floor(Math.random() * LINES.length)];
}

/**
 * 真的禁言一个人。
 *
 * @param {object} p
 * @param {(action:string,params:object)=>Promise<any>} p.call OneBot 调用函数（bot.call）
 * @param {string|number} p.groupId
 * @param {string|number} p.userId
 * @param {number} [p.seconds] 禁言多少秒（默认 config.mute.seconds ?? 60）
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function muteMember({ call, groupId, userId, seconds }) {
  const cfg = config.mute ?? {};
  if (cfg.enable === false) return { ok: false, error: '禁言功能没开' };
  if (!call) return { ok: false, error: '没有可用的 QQ 接口' };

  const dur = Math.max(1, Number(seconds) || Number(cfg.seconds) || 60);
  try {
    // ⚠️ NapCat 的 set_group_ban 走 setMemberShutUp **普通调用**（不是发包），
    //    所以在这个 QQ 版本上应该能用 —— 和戳一戳那种发包的不一样（2026-09-13 查证）。
    const r = await call('set_group_ban', {
      group_id: String(groupId),
      user_id: String(userId),
      duration: dur,
    });
    const ok = r?.status === 'ok' || r?.retcode === 0 || r === undefined;
    if (!ok) {
      log.warn(`禁言失败：${JSON.stringify(r).slice(0, 120)}`);
      return { ok: false, error: JSON.stringify(r).slice(0, 120) };
    }
    log.info(`[禁言] ${userId} 在群 ${groupId} 被禁言 ${dur} 秒`);
    return { ok: true };
  } catch (e) {
    log.warn(`禁言出错：${e.message}`);
    return { ok: false, error: e.message };
  }
}
