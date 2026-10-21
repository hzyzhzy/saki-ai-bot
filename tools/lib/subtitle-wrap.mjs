/**
 * 字幕断行（B站短视频专用）
 *
 * 为什么要单独抽出来：`tools/bili-intro3.mjs` 合成时要用，`tools/subtitle-wrap-test.mjs`
 * 交付前自检也要用 —— 两份各写一份必然走偏（之前就踩过：自检的算法和实际用的是两版）✗
 *
 * 规则（都是踩出来的）：
 *   ① **先按标点切句**，标点跟着前一句走 ⇒ 「自己」「最好」这种词不会被拆开
 *   ② 贪心合行，一行不超过 SUB_WIDTH 个"视觉宽"单位（中文 1、英文/数字 0.55）
 *   ③ 只有**一个标点都没有**的超长片段才按宽度硬切
 *   ④ 硬切时英文词组整块不拆（DeepSeek Harness 不会被劈成两行）
 *   ⑤ **一个字都不许丢** —— 老版本"按字符数硬切 + 只留两行"把长句的尾巴整段丢了，
 *      字幕变成「是 DeepSeek Harne」（用户 2026-10-21 抓到）
 */

// ⚠️ 2026-10-21：16.5 时「16 个汉字 + 逗号」正好超一点 ⇒ 逗号被挤成单独一行（画面很难看）。
// 17 个汉字 = 952px，1080 宽仍留 64px 边距 ⇒ 放到 17.2，让标点跟着前一句走 ✓
export const SUB_WIDTH = 17.2; // 56 号中文约 56px/字，1080 宽一行最多 17 字 ⇒ 取 17.2 留边距

export const charW = (ch) => (/[\x00-\xff]/.test(ch) ? 0.55 : 1);
export const widthOf = (s) => [...String(s)].reduce((a, ch) => a + charW(ch), 0);

export function wrapSub(text, maxWidth = SUB_WIDTH) {
  const src = String(text || '');
  // ① 按标点切句（标点跟前面的句子一起）
  const parts = src.match(/[^，。、；：！？,.;:!?]+[，。、；：！？,.;:!?]?/g) || [src];
  // ② 贪心合行
  const rows = [];
  let cur = '';
  for (const p of parts) {
    if (!cur) { cur = p; continue; }
    if (widthOf(cur + p) <= maxWidth) { cur += p; continue; }
    rows.push(cur.trim());
    cur = p;
  }
  if (cur.trim()) rows.push(cur.trim());
  // ③④ 超宽片段按宽度硬切，英文词组整块不拆
  const out = [];
  for (const r of rows) {
    let rest = r;
    while (widthOf(rest) > maxWidth) {
      let w = 0;
      let i = 0;
      for (; i < rest.length; i++) {
        const cw = charW(rest[i]);
        if (w + cw > maxWidth) break;
        w += cw;
      }
      let cut = Math.max(1, i);
      // 别切在英文单词中间（两侧都是字母/数字 ⇒ 回退到最近空格）
      if (/[A-Za-z0-9]/.test(rest[cut] || '') && /[A-Za-z0-9]/.test(rest[cut - 1] || '')) {
        const sp = rest.lastIndexOf(' ', cut);
        if (sp > 0) cut = sp;
      }
      // 切点落在英文词组内部（"…是 DeepSeek| Harness …"）⇒ 退回词组开头
      const enTail = /[A-Za-z0-9][A-Za-z0-9 .&+\-]*$/.exec(rest.slice(0, cut));
      if (enTail) {
        const start = cut - enTail[0].length;
        if (/[A-Za-z0-9]/.test(rest.slice(cut).trimStart()[0] || '') && start > maxWidth * 0.4) {
          cut = start;
        }
      }
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out.filter(Boolean);
}

/** 自检：拆完拼回去必须和原文一字不差（只忽略空白） */
export function lossless(text) {
  const a = wrapSub(text).join('').replace(/\s/g, '');
  const b = String(text || '').replace(/\s/g, '');
  return a === b;
}
