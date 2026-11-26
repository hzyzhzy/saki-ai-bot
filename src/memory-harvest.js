/**
 * 群观察顺手抽出来的知识 → 落成她的笔记。
 *
 * ⚠️ 为什么要有这条路（2026-11-27）：
 *    学习和「被 @ 到」绑在一起太机械 —— 群里几千条消息里真正教给她的东西，
 *    只要没人 @ 她一次、也没人说「记住」，就**整条丢掉** ✗
 *    而群观察本来就在读**每一批群消息（含不 @ 她的）**，同一批只多要一段模型输出
 *    （见 `observe.js` 的 PROMPT 第三节），**不额外发请求** ⇒ 不 @ 也能学，成本≈0。
 *
 * ⚠️ **只补新知识**：已有同名主题就跳过 —— 观察里抽出来的不如人亲口教的准，不许覆盖。
 * ⚠️ 落盘走 `learn()`（和群里教学同一条路）：它自己判该进专题库还是她的笔记，
 *    也带备份和撤回快照。
 */
import { learn, listEntries } from './learned.js';
import { reloadKnowledge } from './knowledge.js';
import { splitNoteLine } from './observe.js';
import { log } from './log.js';

/**
 * @param {Array<{gid:string, items:string[]}>} list 观察那一轮抽到的「主题｜内容」行
 * @param {{learn?:Function}} [opts] 测试可以注入一个假的 `learn`
 * @returns {Promise<number>} 真正写进去的条数
 */
export async function harvestNotes(list, opts = {}) {
  if (!Array.isArray(list) || !list.length) return 0;
  const doLearn = typeof opts.learn === 'function' ? opts.learn : learn;

  let have = new Set();
  try {
    // ⚠️ `opts.titles` 只是给测试用的（省得为了一条断言去准备整套知识目录）
    const known = Array.isArray(opts.titles) ? opts.titles : listEntries().map((e) => e.title);
    have = new Set(known);
  } catch {
    /* 读不到就当没有，照写 */
  }

  let n = 0;
  for (const { gid, items } of list) {
    for (const line of items ?? []) {
      const one = splitNoteLine(line);
      if (!one) continue;
      const { topic, fact } = one;
      if (have.has(topic)) {
        log.debug(`[观察] 这条笔记已经有了，跳过：${topic}`);
        continue;
      }
      try {
        const r = await doLearn(topic, fact, {
          byName: '群里自己听到的',
          where: gid ? `群${gid}` : '群聊',
          groupId: String(gid ?? ''),
        });
        if (r?.ok) {
          have.add(r.topic ?? topic);
          n += 1;
          log.info(
            `[观察] 自己学到一条：「${r.topic ?? topic}」→ ${r.file ?? 'learned.md'}（${gid ? `群${gid}` : '群聊'}）`,
          );
        }
      } catch (e) {
        log.warn(`[观察] 笔记落盘失败（忽略）：${e.message}`);
      }
    }
  }
  if (n) {
    try {
      reloadKnowledge();
    } catch (e) {
      log.warn(`[观察] 学完重载知识库失败（下次重启生效）：${e.message}`);
    }
  }
  return n;
}
