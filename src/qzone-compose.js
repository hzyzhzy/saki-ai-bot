/**
 * 生成 QQ 空间说说。
 *
 * 给小祥一份「群聊素材 + 服务器状态 + 最近发过的」，让它自己判断：
 *   ① 有没有值得发的
 *   ② 发什么（趣事 / 汇总 / 感想）
 *   ③ 配哪张表情
 *
 * 注意：发布的权限判断不在这里（在 qzone.js），这里只管「写什么」。
 */
import { config } from './config.js';
import { log } from './log.js';
import { streamChat } from './llm.js';
import { knowledgeText } from './knowledge.js';
import { faceMenuText } from './faces.js';
import { queryServer, describe } from './status.js';
import * as digest from './digest.js';
import * as persona from './persona.js';

/** 空间说说的写作要求 —— 和群里聊天完全不同，这里是对着好友广播 */
// ⚠️ 2026-09-21：说说的写作指南（131 行的人设文案）搬到了
//    `personas/<id>/prompt/qzone-guide.md` —— 长段放 JSON 里要转义换行、没法读、
//    界面上也没法编辑，所以**短句走 identity.prompt，长段走这里的 md**。
export function postGuide() {
  return persona.promptFile('qzone-guide');
}

/**
 * 让模型写一条说说。
 * @param {{liveStatus?: string}} opts
 * @returns {Promise<{post:boolean, type:string, content:string, faces:string[], reason:string}>}
 */
export async function compose({ liveStatus = '' } = {}) {
  const material = digest.materialText();
  if (!material) {
    return { post: false, type: '', content: '', faces: [], reason: '素材库是空的' };
  }

  // 服务器状态：能查到就带上，让它有「汇总」的素材
  let serverLine = liveStatus;
  if (!serverLine) {
    try {
      const cfgStatus = config.status ?? {};
      if (cfgStatus.enable && cfgStatus.host) {
        const data = await queryServer(cfgStatus.host, cfgStatus.cacheSeconds * 1000);
        serverLine = describe(data, cfgStatus.displayName ?? '服务器');
      }
    } catch (e) {
      log.debug(`说说取服务器状态失败：${e.message}`);
    }
  }

  const kb = knowledgeText();
  const faces = faceMenuText();
  const posted = digest.recentPostsText();

  const system = [
    postGuide(),
    '',
    '# 【服务器知识库】（写汇总时只能依据这里的内容，不要编）',
    kb || '（空）',
    '',
    serverLine ? `# 【服务器实时状态】\n${serverLine}` : '',
    '',
    faces ? `# 【可用表情】（faces 字段只能用这些标签）\n${faces}` : '',
    '',
    posted
      ? [
          '# 【最近已经发过的说说】⚠️ 这些话题**绝对不要再发一遍**',
          posted,
          '',
          '上面每一条都已经在空间里了。**同一个话题、同一个梗、同一件事，换多少种说法都算重复** ——',
          '比如已经发过「群友拿轻薄本开整合包卡成 PPT」，就**不许再发**这个，',
          '不管是换个措辞、还是换个角度（吐槽分辨率、吐槽帧数）都算重复。',
          '**宁可今天不发，也别重发聊过的事。**',
        ].join('\n')
      : '',
  ]
    .filter((x) => x !== null && x !== undefined)
    .join('\n');

  const user = [
    `# 【今天群里攒下来的素材】（共 ${digest.stats().count} 条）`,
    '',
    material,
    '',
    '根据上面的素材，决定发不发说说，以及发什么。只输出 JSON。',
  ].join('\n');

  let raw = '';
  const t0 = Date.now();
  for await (const piece of streamChat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ])) {
    raw += piece;
    if (Date.now() - t0 > 90000) break;
  }

  return parseCompose(raw);
}

/** 解析模型返回的 JSON（容忍 markdown 代码块和前后废话） */
export function parseCompose(raw) {
  const text = String(raw ?? '').trim();
  // 抠出第一个 { ... } 块
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { post: false, type: '', content: '', faces: [], reason: `模型没返回 JSON：${text.slice(0, 80)}` };
  }
  let j;
  try {
    j = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return { post: false, type: '', content: '', faces: [], reason: `JSON 解析失败：${e.message}` };
  }

  const content = String(j.content ?? '').trim();
  const post = j.post === true && content.length > 0;
  // ⚠️ 一条说说**只配一张图**（用户明确要求）。
  //    以前这里读的是 faces 数组，现在只取第一张，兼容模型偶尔返回数组的情况。
  const faceList = (Array.isArray(j.faces) ? j.faces : j.face ? [j.face] : [])
    .map((x) => String(x).trim())
    .filter(Boolean);
  // 尽量别跟最近几条用过同一个标签（否则看起来老是同一张图）
  const recentlyUsed = new Set(
    (digest.posts?.() ?? []).slice(0, 3).map((p) => String(p.face ?? '').trim()).filter(Boolean),
  );
  const face = faceList.find((f) => !recentlyUsed.has(f)) ?? faceList[0] ?? '';
  return {
    post,
    type: ['funny', 'summary', 'thought'].includes(j.type) ? j.type : 'funny',
    content,
    face,
    faces: face ? [face] : [],
    reason: String(j.reason ?? '').trim(),
  };
}
