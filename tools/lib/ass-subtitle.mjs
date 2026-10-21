/**
 * 字幕 → ASS（libass 预排版）
 *
 * 为什么换掉 drawtext（用户 2026-10-21：「把字幕生成方式改一下」）：
 *   · drawtext 每条字幕都挂在滤镜链上，**每一帧都要重新排版 19 条**
 *     （34 秒 × 25fps × 19 = 1.6 万次排版）⇒ 合成里 2~3 分钟全耗在这 ✗
 *   · ASS 是**一次性排版**，libass 之后只做贴图 ⇒ 快得多 ✓
 *   · 顺带好处：字幕能用标准工具检查/预览，样式集中在一个文件里
 *
 * 视觉要和原来的 drawtext 版保持一致（用户 2026-10-21 确认过那版「正常」）：
 *   微软雅黑 56 号、白色、每行**各自一个半透明黑底框**、水平居中、从底部往上排
 */

const hex2ass = (r, g, b, a = 0) => {
  // ASS 是 BGR 顺序 + alpha（00=不透明，FF=全透明）
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `&H${h(a * 255)}${h(b)}${h(g)}${h(r)}`;
};

/** 秒 → ASS 时间戳 H:MM:SS.cc */
export const assTime = (sec) => {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')}`;
};

/**
 * @param {Array<{start:number,end:number,rows:string[]}>} blocks 每句一行数组
 * @param {object} opt
 *   W/H          画布尺寸（默认 1080×1920）
 *   fontSize     字号（默认 56）
 *   lineGap      行距（默认 80，和 drawtext 版一致）
 *   baseY        单行时框的顶边（默认 1700，和 drawtext 版一致）
 *   shadowAlpha  黑底不透明度（0.6 ⇒ alpha 0.4）
 *   border       框内边距（对应 drawtext 的 boxborderw，默认 24）
 */
export function buildAss(blocks, opt = {}) {
  const {
    W = 1080, H = 1920, fontSize = 56, lineGap = 80,
    baseY = 1700, shadowAlpha = 0.6, border = 24,
    fontName = 'Microsoft YaHei',
  } = opt;

  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',        // 不自动折行（换行我们已经算好了）
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
      'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, ' +
      'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // BorderStyle=3 ⇒ 不透明底框（用 BackColour 当框色）
    `Style: Sub,${fontName},${fontSize},${hex2ass(255, 255, 255)},${hex2ass(255, 255, 255)},` +
      `${hex2ass(0, 0, 0)},${hex2ass(0, 0, 0, 1 - shadowAlpha)},` +
      `0,0,0,0,100,100,0,0,3,${border},0,5,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = [];
  for (const b of blocks) {
    const rows = b.rows || [];
    const n = rows.length;
    // 与 drawtext 版同一套坐标：框顶 y = baseY - (n-1)*lineGap + k*lineGap
    // ASS 用 \an5（中心对齐）\pos ⇒ 给的是**文字块中心**，
    // 框高 ≈ 字高 + 2×内边距 ⇒ 中心 = 框顶 + (fontSize + 2*border)/2
    const halfH = (fontSize + 2 * border) / 2;
    rows.forEach((ln, k) => {
      const top = baseY - (n - 1) * lineGap + k * lineGap;
      const cy = top + halfH;
      const text = String(ln).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
      events.push(
        `Dialogue: 0,${assTime(b.start)},${assTime(b.end)},Sub,,0,0,0,,` +
        `{\\an5\\pos(${Math.round(W / 2)},${Math.round(cy)})}${text}`
      );
    });
  }

  return head.concat(events).join('\n') + '\n';
}
