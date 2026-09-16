/**
 * 给表情补注释（tag / who / when / desc）—— 管理界面和命令行脚本共用。
 *
 * 场景：从群里自动收集来的表情只有文件名，`who`/`when` 是空的，
 * 模型在清单里看到的就是一串乱码，根本不敢用。这个模块用视觉模型看图、
 * 再让模型按「这张图该在什么时候用」写注释。
 *
 * ⚠️ 角色名只认**有把握**的（靠标志物）。认不出就写客观特征 +「（角色不确定）」，
 *    绝不硬编名字 —— 用户明确要求过「不给错名字比给错名字有用」。
 *
 * ⚠️ 为什么抽成模块：原来这段只在 test/annotate-faces.js 里，
 *    界面上没法用。用户要求「直接和更新表情库集成」。
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ROOT } from './config.js';
import { log } from './log.js';
import { describeImageDetailed } from './vision.js';
import { streamChat } from './llm.js';

const LIB = join(ROOT, 'library');

const PROMPT = `你在给一个 QQ 群客服机器人的**表情库**写注释。

上面有一张表情包的视觉描述。请输出 JSON（**只输出 JSON，不要解释、不要代码块围栏**）：

{
  "tag": "两个字的短标签",
  "who": "图里是谁 / 画的是什么",
  "when": "什么时候该用这张",
  "desc": "一句话描述画面"
}

## 各字段怎么填

**tag**：**两个汉字**，好记、能区分（比如「戴锅」「吃瓜」「扶额」「磕到了」）。
  不要用文件名、不要用字母数字。这是模型用来选图的键，必须短。
  ⚠️ 如果这个情绪已经有同名的图了**也没关系** —— 同 tag 会随机发一张，
  这正是我们想要的（同一个情绪多张备选，才不会老发一样的图）。

**who**：图里是谁。⚠️ **只在你从描述里能确认时才写角色名**，
  认角色靠**标志物**（特定发饰、服装、随身物品、作品 logo）。
  光凭「粉发少女」这种特征**不许点名** —— 粉发角色成百上千，硬猜必错。
  不确定就写客观特征 + 「（角色不确定）」，
  例如「蓝发女仆装的手办（角色不确定）」「黄色方块小人」。
  纯梗图/网络表情就写它是什么，例如「网络梗图（猪头）」。

**when**：**什么时候该用这张**。一句话，说清情绪和使用场合。
  例如「看到极其离谱、让人说不出话的发言时」「群里有人在吵架，你在旁边围观的时候」。
  这条最重要 —— 模型靠它选对图。

**desc**：画面本身的客观描述，一句话。

## 硬要求
- 中文。JSON 里不要有注释、不要有多余格式。
- 认不出角色就老实说，**别编名字**。`;

/** 把流式输出收成一段文本 */
async function collect(messages) {
  let out = '';
  for await (const d of streamChat(messages)) out += d;
  return out;
}

/** 注释是否不完整（需要补） */
export function needsAnnotation(f) {
  if (!f?.who) return true;
  if (!f?.when || String(f.when).trim().length < 6) return true;
  return false;
}

/** 挑出需要补注释的 */
export function listUnannotated(faces) {
  return (faces ?? []).filter(needsAnnotation);
}

/**
 * 给一张图生成注释。
 * @param {string} file 文件名（library/ 下的）
 * @param {object} face 原记录（失败时返回原 tag 兜底）
 * @returns {Promise<{tag:string, who:string, when:string, desc:string}>}
 */
export async function annotateFace(file, face = {}) {
  const p = join(LIB, file);
  if (!existsSync(p)) throw new Error(`文件不存在：${file}`);

  const v = await describeImageDetailed(p);
  if (!v?.text) throw new Error('识图没拿到描述');

  const raw = await collect([
    { role: 'system', content: PROMPT },
    { role: 'user', content: `视觉描述：\n${v.text}` },
  ]);

  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型没返回 JSON');
  const j = JSON.parse(m[0]);

  const tag = String(j.tag ?? '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    .slice(0, 6);
  return {
    tag: tag || face.tag || '表情',
    who: String(j.who ?? '').trim().slice(0, 40),
    when: String(j.when ?? '').trim().slice(0, 120),
    desc: String(j.desc ?? '').trim().slice(0, 120),
  };
}

/**
 * 批量补注释。**边做边回调**，让界面能显示进度。
 *
 * @param {object[]} faces index.json 的 faces 数组（会被原地修改）
 * @param {{limit?:number, onProgress?:(done:number,total:number,face:object,note:string)=>void,
 *          save?:(faces:object[])=>void}} opts
 * @returns {Promise<{ok:number, failed:number, results:Array}>}
 */
export async function annotateAll(faces, opts = {}) {
  const todo = listUnannotated(faces);
  const limit = opts.limit ? Math.max(1, Number(opts.limit)) : todo.length;
  const target = todo.slice(0, limit);

  let ok = 0;
  let failed = 0;
  const results = [];

  for (let i = 0; i < target.length; i++) {
    const f = target[i];
    try {
      const a = await annotateFace(f.file, f);
      f.tag = a.tag;
      f.who = a.who;
      f.when = a.when;
      f.desc = a.desc;
      if (f.who && f.when) delete f._未完善;
      ok++;
      results.push({ file: f.file, ok: true, tag: a.tag, who: a.who });
      opts.onProgress?.(i + 1, target.length, f, `[${a.tag}] ${a.who}`);
    } catch (e) {
      failed++;
      results.push({ file: f.file, ok: false, error: e.message });
      opts.onProgress?.(i + 1, target.length, f, `失败：${e.message}`);
    }
    // 每张都存一次，中途中断也不丢进度
    try {
      opts.save?.(faces);
    } catch (e) {
      log.warn(`保存表情注释失败：${e.message}`);
    }
  }

  log.info(`表情注释：成功 ${ok}，失败 ${failed}（共 ${target.length} 张待补）`);
  return { ok, failed, results };
}
