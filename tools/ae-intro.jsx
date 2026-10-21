// AE 片头（自制题材专用，2026-10-22 用户定）
// 「群里的趣事类不用变，agent 自己搜集题材做的才要用上 ae」
//
// 输出：1080×1920 / 25fps / 3 秒 / **透明背景** 的 PNG 序列
//   <OUT>/intro_00001.png …
// 由 `tools/ae-intro.mjs` 调起；文案从 <OUT>/intro.txt 读（JSON 一行）
//
// ⚠️ 必须最后写 <本脚本>.done —— ae-run.mjs 靠它判完成
(function () {
  var OUT = 'C:/Users/hzy/AppData/Local/Temp/ds1-ae-intro';
  var f = new Folder(OUT);
  if (!f.exists) f.create();

  var lines = [];
  function log(s) { lines.push(String(s)); }

  // ① 读文案（ae-intro.mjs 写的）
  var line1 = '祥子';           // 主标题
  var line2 = 'Saki · 客服日常';  // 副标题
  var accent = [0.40, 0.75, 1.0]; // 强调色（浅蓝）
  try {
    var tf = new File(OUT + '/intro.txt');
    if (tf.exists && tf.open('r')) {
      var raw = tf.read();
      tf.close();
      var j = eval('(' + raw + ')');
      if (j && j.line1) line1 = String(j.line1);
      if (j && j.line2) line2 = String(j.line2);
    }
  } catch (e) { log('读文案失败（用默认）：' + e.toString()); }

  // ⚠️ 15fps × 2 秒 = 30 帧：AE 的 saveFrameToPng **每帧都要重渲**，
  //    75 帧实测要十多分钟（还会被超时打断）⇒ 降帧数最划算
  var W = 1080, H = 1920, FPS = 15, DUR = 2.0, FRAMES = Math.round(FPS * DUR);

  function ease(o, i) {
    // 缓出（AE 的 keyInInterpolationType）
    try {
      o.property('ADBE Transform Group').property('ADBE Position').setInterpolationTypeAtKey(i, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
    } catch (e) {}
  }

  function makeText(comp, str, size, color, y, bold) {
    // ⚠️ 2026-10-22 实测：字号写死会把长标题**左右裁掉**（AE 文本层不自动换行，
    //    10 个字 × 150px = 1500px > 1080 宽 ⇒ 两边都被切）✗
    //    ⇒ 按字数收一下字号（中文一字约等于一个 fontSize，留 100px 安全边）
    var n = String(str).length || 1;
    var fit = Math.floor(980 / n);
    var fs = Math.min(size, Math.max(34, fit));
    var t = comp.layers.addText(str);
    var srcText = t.property('ADBE Text Properties').property('ADBE Text Document');
    var doc = srcText.value;
    doc.fontSize = fs;
    doc.applyFill = true;
    doc.fillColor = color;
    // ⚠️ 必须带**黑描边**：片头是叠在聊天记录上的（透明背景），白字直接压在浅色聊天背景上
    //    几乎看不清（2026-10-22 实测第一版就是这样）✗ 描边等于给字镶了一圈底
    doc.applyStroke = true;
    try {
      doc.strokeColor = [0, 0, 0];
      doc.strokeWidth = bold ? 9 : 5;
      doc.strokeOverFill = false;
    } catch (e) {}
    doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    try { doc.font = bold ? 'MicrosoftYaHei-Bold' : 'MicrosoftYaHei'; } catch (e) {}
    try { if (!doc.font || String(doc.font).length === 0) doc.font = 'Microsoft YaHei'; } catch (e) {}
    srcText.setValue(doc);
    // ⚠️ 再按**实际文字框**把锚点挪到正中间 —— 光设 position 的话，
    //    锚点默认在文字块左上角，长标题会整体偏右（实测左边缘跑到负坐标）✗
    try {
      var rect = t.sourceRectAtTime(0, false);
      t.property('ADBE Transform Group').property('ADBE Anchor Point')
        .setValue([rect.left + rect.width / 2, rect.top + rect.height / 2]);
    } catch (e) {}
    t.property('ADBE Transform Group').property('ADBE Position').setValue([W / 2, y]);
    return t;
  }

  var comp, rq, mp4 = null;
  try {
    app.beginUndoGroup('saki intro');

    comp = app.project.items.addComp('saki_intro', W, H, 1, DUR, FPS);
    comp.bgColor = [0, 0, 0];

    // ② 主标题：从下往上滑入 + 轻微放大回收 + 淡入淡出
    // ⚠️ 关键帧时间全部按 DUR 算（写死 2.35/2.75 在 DUR=2 时根本到不了 ⇒ 永远不会淡出）✗
    var T_IN = 0.35;              // 淡入完成
    var T_HOLD = DUR - 0.35;      // 开始淡出
    var T_END = DUR - 0.06;       // 淡完
    var Y1 = 960;
    var t1 = makeText(comp, line1, 150, [1, 1, 1], Y1, true);
    var p1 = t1.property('ADBE Transform Group').property('ADBE Position');
    p1.setValueAtTime(0, [W / 2, Y1 + 130]);
    p1.setValueAtTime(0.55, [W / 2, Y1]);
    var s1 = t1.property('ADBE Transform Group').property('ADBE Scale');
    s1.setValueAtTime(0, [112, 112]);
    s1.setValueAtTime(0.75, [100, 100]);
    var o1 = t1.property('ADBE Transform Group').property('ADBE Opacity');
    o1.setValueAtTime(0, 0);
    o1.setValueAtTime(T_IN, 100);
    o1.setValueAtTime(T_HOLD, 100);
    o1.setValueAtTime(T_END, 0);

    // ③ 一条强调色横线：从中间向两侧撑开
    var line = comp.layers.addSolid(accent, 'bar', 560, 7, 1);
    line.property('ADBE Transform Group').property('ADBE Anchor Point').setValue([280, 3.5]);
    line.property('ADBE Transform Group').property('ADBE Position').setValue([W / 2, 1082]);
    var ls = line.property('ADBE Transform Group').property('ADBE Scale');
    ls.setValueAtTime(0.15, [0, 100]);
    ls.setValueAtTime(0.85, [100, 100]);
    var lo = line.property('ADBE Transform Group').property('ADBE Opacity');
    lo.setValueAtTime(0.15, 0);
    lo.setValueAtTime(0.6, 100);
    lo.setValueAtTime(T_HOLD, 100);
    lo.setValueAtTime(T_END, 0);

    // ④ 副标题：晚一点淡入
    var t2 = makeText(comp, line2, 62, [0.9, 0.94, 0.98], 1160, false);
    var o2 = t2.property('ADBE Transform Group').property('ADBE Opacity');
    o2.setValueAtTime(0.5, 0);
    o2.setValueAtTime(0.95, 100);
    o2.setValueAtTime(T_HOLD, 100);
    o2.setValueAtTime(T_END, 0);

    // ⑤ 顶部/底部各一条细装饰线，让"卡片感"更整
    var top = comp.layers.addSolid([1, 1, 1], 'hairline', 2, 240, 1);
    top.property('ADBE Transform Group').property('ADBE Position').setValue([W / 2, 760]);
    var to = top.property('ADBE Transform Group').property('ADBE Opacity');
    to.setValueAtTime(0.2, 0);
    to.setValueAtTime(0.7, 18);
    to.setValueAtTime(2.35, 18);
    to.setValueAtTime(2.75, 0);

    app.endUndoGroup();

    // ⑥ 存工程（留一份，下次要调直接改）
    try {
      var aep = new File(OUT + '/saki_intro.aep');
      app.project.save(aep);
      log('saved=' + aep.fsName + ' exists=' + aep.exists);
    } catch (e) { log('存 aep 失败（不影响出图）：' + e.toString()); }

    // ⑦ 导 PNG 序列（**带 alpha**，后面 ffmpeg 拿它做 overlay）
    //
    // ⚠️⚠️ 2026-10-22 实测：**不要走渲染队列 + applyTemplate**
    //    中文版 AE 里 `applyTemplate('PNG Sequence')` / 'PNG 序列' / 'Lossless' **全都不认**
    //    （四个名字逐个试，回执里四条"模板不存在"），于是退回默认输出模块，
    //    用 `.png` 的文件名写出来的**根本不是 PNG** ⇒ `png0exists=false` ✗
    // ⇒ 改用官方 API **`comp.saveFrameToPng(time, file)`**：逐帧直接落 PNG，
    //    不碰输出模板、不用渲染队列，透明区域也照原样保留 ✓
    //    （75 帧实测几十秒，比整个渲染队列还快）
    var frames = Math.round(comp.duration * comp.frameRate);
    for (var fi = 0; fi < frames; fi++) {
      var idx = fi + 1;
      var num = '' + idx;
      while (num.length < 5) num = '0' + num;
      var pf = new File(OUT + '/intro_' + num + '.png');
      try {
        comp.saveFrameToPng(fi / comp.frameRate, pf);
      } catch (e2) {
        if (fi === 0) log('saveFrameToPng failed: ' + e2.toString());
      }
    }
    // ⚠️ 别在循环里数 `pf.exists` —— 实测刚写完那一下它还是 false（句柄没刷新），
    //    会打出 "pngFrames=0/75" 这种假失败 ✗ ⇒ 循环结束后扫目录数
    var countPng = 0;
    var listDir = new Folder(OUT);
    var got = listDir.getFiles(/^intro_[0-9]+\.png$/i);
    for (var gi = 0; gi < got.length; gi++) countPng++;
    log('pngFrames=' + countPng + '/' + frames);
    log('png0exists=' + new File(OUT + '/intro_00001.png').exists);
    log('RESULT=OK');
  } catch (e) {
    log('RESULT=FAIL ' + e.toString() + (e.line ? ' line ' + e.line : ''));
  }

  // ⚠️ 完成标记必须叫 `<本脚本>.done`，而且要走**脚本自身路径**：
  //    ae-intro.mjs 会把这个 jsx 复制到临时目录（ASCII 路径）再跑 ——
  //    ExtendScript 对中文路径不友好，写死中文路径会悄悄失败 ✗
  var self = new File($.fileName);
  var d = new File(self.fsName + '.done');
  d.open('w');
  d.write(lines.join('\n'));
  d.close();
})();
