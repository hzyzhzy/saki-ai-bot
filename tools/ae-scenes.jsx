/**
 * AE 分镜动画（2026-11-08）
 *
 * 用户原话：「不是这种简单的动画啊，**要是那种能帮助观众理解视频的动画**」
 *          「真的是**太死板了**」「**最好直接用 ae 做动效，html 不适合用来做视频**」
 *
 * 和 `ae-intro.jsx` 的区别：那个只会渲一张**标题卡**；这个是按 `scenes.json`
 * 一段一段做**分镜**，每段把一个要点变成看得见的画面：
 *
 *   title   —— 大字砸下来（关键词高亮）
 *   compare —— 左右两个框往中间挤，一边高亮一边灰（对比）
 *   list    —— 三/四条文字依次落下（"排上三条"这种就得让它真的一条条出来）
 *   bars    —— 两条长度条按比例生长（"话多 vs 一句话"直接量出来）
 *
 * 输入：`<OUT>/scenes.json`（由 `tools/ae-scenes.mjs` 写）
 *   [{ "type":"title", "text":"…", "em":"…", "sub":"…", "sec":3 }, …]
 *
 * 输出：`<OUT>/scene_00001.png …`（1080×1920 / 带 alpha）
 *
 * ⚠️ ExtendScript 是 ES3 环境：只用 var、不用箭头函数、不用模板字符串 ✓
 */
(function () {
  var OUT = 'INJECT_OUT';
  var W = 1080, H = 1920, FPS = 25;

  function readText(p) {
    var f = new File(p);
    if (!f.exists) return '';
    f.encoding = 'UTF-8';
    f.open('r');
    var s = f.read();
    f.close();
    return String(s || '');
  }

  function say(s) { $.writeln('[ae-scenes] ' + s); }

  /* 完成标记（成功/失败都写）——**必须写在 jsx 自身旁边**：
   * 这个脚本会被复制到 ASCII 临时目录再跑，写死在 OUT 里 ae-scenes.mjs 就等不到 ✗ */
  function writeDone(msg) {
    var self = new File($.fileName);
    var d = new File(self.fsName + '.done');
    d.encoding = 'UTF-8';
    d.open('w');
    d.write(msg);
    d.close();
  }

  try {   // ⚠️ 整个主体都在 try 里：不然抛错时 AE 只弹一个「脚本错误」框，
         //    closeDialogs 把它点掉 ⇒ 错误内容彻底丢掉，只能看到"没写完成标记" ✗
  var raw = readText(OUT + '/scenes.json');
  if (!raw) { writeDone('FAIL no scenes.json'); return; }

  var scenes;
  try { scenes = eval('(' + raw.replace(/^\uFEFF/, '') + ')'); }
  catch (e) { writeDone('FAIL scenes.json 解析不了: ' + e.toString()); return; }
  if (!scenes || !scenes.length) { writeDone('FAIL scenes 是空的'); return; }

  /* 总时长：各段 sec 之和 */
  var DUR = 0, i;
  for (i = 0; i < scenes.length; i++) {
    if (!scenes[i].sec) scenes[i].sec = 3;
    DUR += Number(scenes[i].sec);
  }
  say('共 ' + scenes.length + ' 段，总长 ' + DUR + ' 秒');

  try {
  app.beginUndoGroup('ae-scenes');
  var project = app.project;
  var comp = project.items.addComp('saki_scenes', W, H, 1, DUR, FPS);
  comp.bgColor = [0.039, 0.051, 0.067];

  var TEXT_MAIN = [1, 1, 1];
  var ACCENT = [0.494, 0.878, 0.788];      // 青绿
  var MUTED = [0.545, 0.596, 0.647];       // 灰
  var DIM = [0.216, 0.255, 0.310];         // 深灰（框）

  /* 建一个**段落文字**（box text）——2026-11-08 改：
   *   点文字（addText）的锚点在基线左端，要靠 sourceRectAtTime 反算才能居中，
   *   实测算出来还是会整体偏移 ✗
   *   ⇒ 换成 addBoxText：框宽占画布 92%、justification=CENTER ⇒ **天然水平居中**，
   *     Position 直接就是框中心，不用算锚点 ✓ */
  var BOXW = W * 0.92;
  var DBG = [];   // 调试：把每个文字层的实际数值记下来，最后写进 .done 看
  function addText(comp, str, size, color, font) {
    var boxH = Math.max(size * 2.4, 160);
    var t = comp.layers.addBoxText([BOXW, boxH], String(str));
    var src = t.property('ADBE Text Properties').property('ADBE Text Document');
    var doc = src.value;
    doc.resetCharStyle();
    doc.fontSize = size;
    doc.fillColor = color;
    doc.applyFill = true;
    doc.applyStroke = false;
    try { doc.font = font || 'MicrosoftYaHei-Bold'; } catch (eF) {}
    doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    src.setValue(doc);
    try {
      var r = t.sourceRectAtTime(0, false);
      var pos = t.property('ADBE Transform Group').property('ADBE Position').value;
      var anc = t.property('ADBE Transform Group').property('ADBE Anchor Point').value;
      var scl = t.property('ADBE Transform Group').property('ADBE Scale').value;
      DBG.push(
        '[' + String(str).slice(0, 8) + '] pos=' + pos[0] + ',' + pos[1] +
        ' anc=' + anc[0] + ',' + anc[1] +
        ' scl=' + scl[0] + ',' + scl[1] +
        ' rect=' + r.left + ',' + r.top + ',' + r.width + ',' + r.height,
      );
    } catch (eD) { DBG.push('[dbg fail] ' + eD.toString()); }
    return t;
  }

  /* ⚠️⚠️ 锚点必须用**文字真实的边界**算（2026-11-08 现场：写死 [1200/2, 160/2]
   *   ⇒ 锚点落在文字外面 ⇒ 所有文字整体偏移，跑到画面边缘还被裁掉 ✗）
   *   `sourceRectAtTime` 拿到的才是这一层实际的 left/top/width/height ✓ */
  /* 2026-11-08：改用 addBoxText 之后不需要再算锚点了（框宽固定、居中）*/
  function anchorToCenter(layer) { void layer; }


  /* 淡入 + 位移（最常用的一招） */
  function slideIn(layer, t0, dur, fromY, toY, fromX, toX) {
    var p = layer.property('ADBE Transform Group').property('ADBE Position');
    var o = layer.property('ADBE Transform Group').property('ADBE Opacity');
    var fx = fromX === null ? W / 2 : fromX;
    var tx = toX === null ? W / 2 : toX;
    p.setValueAtTime(t0, [fx, fromY]);
    p.setValueAtTime(t0 + dur, [tx, toY]);
    setEase(layer, 'ADBE Position', t0, t0 + dur);
    o.setValueAtTime(t0, 0);
    o.setValueAtTime(t0 + dur * 0.7, 100);
  }

  function setEase(layer, prop, t0, t1) {
    try {
      var pr = layer.property('ADBE Transform Group').property(prop);
      pr.setInterpolationTypeAtKey(1, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
      if (pr.numKeys >= 2) {
        pr.setInterpolationTypeAtKey(pr.numKeys, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
      }
    } catch (e) {}
  }

  /* 纯色块（当卡片/条子）—— addSolid 是全画布，用 scale 缩 */
  function addBlock(comp, w, h, x, y, color, opacity) {
    var s = comp.layers.addSolid(color, 'blk', w, h, 1, DUR);
    s.property('ADBE Transform Group').property('ADBE Anchor Point').setValue([w / 2, h / 2]);
    s.property('ADBE Transform Group').property('ADBE Position').setValue([x, y]);
    if (opacity != null) s.property('ADBE Transform Group').property('ADBE Opacity').setValue(opacity);
    return s;
  }

  /* 一条对比条（⚠️ 必须定义在顶层：ExtendScript 是 ES3，**函数声明不能写在 if 块里**，
   *  否则整个脚本在解析阶段就挂掉，连 catch 都进不去 ⇒ 完成标记永远写不出来） */
  function oneBar(comp, yBase, label, pct, color, delay, t0, tEnd) {
    var lb = addText(comp, String(label || ''), 34, MUTED);
    lb.property('ADBE Transform Group').property('ADBE Position').setValue([230, yBase - 48]);
    anchorToCenter();
    var olb = lb.property('ADBE Transform Group').property('ADBE Opacity');
    olb.setValueAtTime(t0 + delay, 0);
    olb.setValueAtTime(t0 + delay + 0.3, 100);
    olb.setValueAtTime(tEnd - 0.35, 100);
    olb.setValueAtTime(tEnd, 0);

    var full = addBlock(comp, 800, 46, W / 2, yBase, DIM, 100);
    var of = full.property('ADBE Transform Group').property('ADBE Opacity');
    of.setValueAtTime(t0 + delay, 0);
    of.setValueAtTime(t0 + delay + 0.3, 60);
    of.setValueAtTime(tEnd - 0.35, 60);
    of.setValueAtTime(tEnd, 0);

    var fill = addBlock(comp, 800, 46, W / 2, yBase, color, 100);
    var fs = fill.property('ADBE Transform Group').property('ADBE Scale');
    var target = Math.max(4, Math.min(100, Number(pct) || 0));
    fs.setValueAtTime(t0 + delay + 0.2, [0, 100]);
    fs.setValueAtTime(t0 + delay + 1.1, [target, 100]);
    try {
      fs.setInterpolationTypeAtKey(1, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
      fs.setInterpolationTypeAtKey(2, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
    } catch (e3) {}
    var off = fill.property('ADBE Transform Group').property('ADBE Opacity');
    off.setValueAtTime(t0 + delay, 0);
    off.setValueAtTime(t0 + delay + 0.25, 100);
    off.setValueAtTime(tEnd - 0.35, 100);
    off.setValueAtTime(tEnd, 0);
  }

  var tCur = 0;
  for (i = 0; i < scenes.length; i++) {
    var sc = scenes[i];
    var sec = Number(sc.sec) || 3;
    var t0 = tCur;
    var tEnd = tCur + sec;
    var type = String(sc.type || 'title');
    say('  段 ' + (i + 1) + '：' + type + ' @' + t0 + 's');

    if (type === 'title') {
      var main = addText(comp, String(sc.text || ''), 76, TEXT_MAIN);
      main.property('ADBE Transform Group').property('ADBE Position').setValue([W / 2, H / 2 - 60]);
      anchorToCenter();
      slideIn(main, t0 + 0.15, 0.55, H / 2 + 40, H / 2 - 60, null, null);
      var ol = main.property('ADBE Transform Group').property('ADBE Opacity');
      ol.setValueAtTime(tEnd - 0.35, 100);
      ol.setValueAtTime(tEnd, 0);

      if (sc.em) {
        var em = addText(comp, String(sc.em), 76, ACCENT);
        em.property('ADBE Transform Group').property('ADBE Position').setValue([W / 2, H / 2 + 40]);
        anchorToCenter();
        slideIn(em, t0 + 0.45, 0.5, H / 2 + 140, H / 2 + 40, null, null);
        var oe = em.property('ADBE Transform Group').property('ADBE Opacity');
        oe.setValueAtTime(tEnd - 0.35, 100);
        oe.setValueAtTime(tEnd, 0);
      }
      if (sc.sub) {
        var sub = addText(comp, String(sc.sub), 40, MUTED);
        sub.property('ADBE Transform Group').property('ADBE Position').setValue([W / 2, H / 2 + 190]);
        anchorToCenter();
        slideIn(sub, t0 + 0.9, 0.5, H / 2 + 250, H / 2 + 190, null, null);
        var os = sub.property('ADBE Transform Group').property('ADBE Opacity');
        os.setValueAtTime(tEnd - 0.35, 100);
        os.setValueAtTime(tEnd, 0);
      }
    }

    if (type === 'compare') {
      /* 左右两个框：先出框再出字，颜色一高一黯 */
      var bx1 = W * 0.27, bx2 = W * 0.73, by = H * 0.46;
      var c1 = addBlock(comp, 400, 300, bx1, by, ACCENT, 18);
      var c2 = addBlock(comp, 400, 300, bx2, by, DIM, 100);
      slideIn(c1, t0 + 0.2, 0.55, by, by, bx1 - 200, bx1);
      slideIn(c2, t0 + 0.45, 0.55, by, by, bx2 + 200, bx2);
      var oc1 = c1.property('ADBE Transform Group').property('ADBE Opacity');
      oc1.setValueAtTime(tEnd - 0.35, 18); oc1.setValueAtTime(tEnd, 0);
      var oc2 = c2.property('ADBE Transform Group').property('ADBE Opacity');
      oc2.setValueAtTime(tEnd - 0.35, 100); oc2.setValueAtTime(tEnd, 0);

      var q1 = addText(comp, String(sc.left || ''), 42, ACCENT);
      q1.property('ADBE Transform Group').property('ADBE Position').setValue([bx1, by]);
      anchorToCenter();
      slideIn(q1, t0 + 0.6, 0.4, by, by, null, null);
      var oq1 = q1.property('ADBE Transform Group').property('ADBE Opacity');
      oq1.setValueAtTime(tEnd - 0.35, 100); oq1.setValueAtTime(tEnd, 0);

      var q2 = addText(comp, String(sc.right || ''), 42, MUTED);
      q2.property('ADBE Transform Group').property('ADBE Position').setValue([bx2, by]);
      anchorToCenter();
      slideIn(q2, t0 + 0.85, 0.4, by, by, null, null);
      var oq2 = q2.property('ADBE Transform Group').property('ADBE Opacity');
      oq2.setValueAtTime(tEnd - 0.35, 100); oq2.setValueAtTime(tEnd, 0);

      if (sc.cap) {
        var cap = addText(comp, String(sc.cap), 38, MUTED);
        cap.property('ADBE Transform Group').property('ADBE Position').setValue([W / 2, by + 300]);
        anchorToCenter();
        slideIn(cap, t0 + 1.4, 0.45, by + 360, by + 300, null, null);
        var ocap = cap.property('ADBE Transform Group').property('ADBE Opacity');
        ocap.setValueAtTime(tEnd - 0.35, 100); ocap.setValueAtTime(tEnd, 0);
      }
    }

    if (type === 'list') {
      if (sc.head) {
        var hd = addText(comp, String(sc.head), 44, [0.79, 0.83, 0.89]);
        hd.property('ADBE Transform Group').property('ADBE Position').setValue([W / 2, H * 0.26]);
        anchorToCenter();
        slideIn(hd, t0 + 0.15, 0.45, H * 0.26 - 40, H * 0.26, null, null);
        var ohd = hd.property('ADBE Transform Group').property('ADBE Opacity');
        ohd.setValueAtTime(tEnd - 0.35, 100); ohd.setValueAtTime(tEnd, 0);
      }
      var items = sc.items || [];
      for (var k = 0; k < items.length; k++) {
        var yy = H * 0.40 + k * 210;
        var bar = addBlock(comp, 14, 150, 130, yy, ACCENT, 100);
        var oy = bar.property('ADBE Transform Group').property('ADBE Opacity');
        oy.setValueAtTime(t0 + 0.25 + k * 0.55, 0);
        oy.setValueAtTime(t0 + 0.4 + k * 0.55, 100);
        oy.setValueAtTime(tEnd - 0.35, 100); oy.setValueAtTime(tEnd, 0);

        var it = addText(comp, String(items[k]), 40, [0.91, 0.93, 0.96]);
        it.property('ADBE Transform Group').property('ADBE Position').setValue([W / 2 + 30, yy]);
        anchorToCenter();
        slideIn(it, t0 + 0.25 + k * 0.55, 0.45, yy - 50, yy, null, null);
        var oit = it.property('ADBE Transform Group').property('ADBE Opacity');
        oit.setValueAtTime(tEnd - 0.35, 100); oit.setValueAtTime(tEnd, 0);
      }
    }

    if (type === 'bars') {
      var L = sc.left || {};
      var R = sc.right || {};
      oneBar(comp, H * 0.40, L.label, L.pct, [0.36, 0.42, 0.50], 0.2, t0, tEnd);
      oneBar(comp, H * 0.56, R.label, R.pct, ACCENT, 1.1, t0, tEnd);

      if (sc.quote) {
        var qq = addText(comp, String(sc.quote), 38, [0.79, 0.83, 0.89]);
        qq.property('ADBE Transform Group').property('ADBE Position').setValue([W / 2, H * 0.72]);
        anchorToCenter();
        slideIn(qq, t0 + 2.0, 0.5, H * 0.72 + 50, H * 0.72, null, null);
        var oqq = qq.property('ADBE Transform Group').property('ADBE Opacity');
        oqq.setValueAtTime(tEnd - 0.35, 100); oqq.setValueAtTime(tEnd, 0);
      }
    }

    tCur = tEnd;
  }

  app.endUndoGroup();

  /* ── 逐帧 saveFrameToPng
   * ⚠️⚠️ **不要用渲染队列 + applyTemplate**（2026-10-22 实测过，见 ae-intro.jsx）：
   *   中文版 AE 里 `applyTemplate('PNG Sequence')` / 'PNG 序列' / 'Lossless' **全都不认**，
   *   退回默认输出模块后虽然文件名是 .png，写出来的**根本不是 PNG** ✗
   *   ⇒ 官方 API `comp.saveFrameToPng(time, file)` 逐帧直接落盘，透明区域照原样保留 ✓ */
  var frames = Math.round(comp.duration * comp.frameRate);
  for (var fi = 0; fi < frames; fi++) {
    var num = '' + (fi + 1);
    while (num.length < 5) num = '0' + num;
    try {
      comp.saveFrameToPng(fi / comp.frameRate, new File(OUT + '/scene_' + num + '.png'));
    } catch (e2) {
      if (fi === 0) say('saveFrameToPng 失败: ' + e2.toString());
    }
  }
  /* ⚠️ 别在循环里数 pf.exists（刚写完句柄还没刷新，会打出 "0/xxx" 这种假失败），
   *    循环结束再扫目录 ✓ */
  var got = (new Folder(OUT)).getFiles(/^scene_[0-9]+\.png$/i);
  var nGot = got ? got.length : 0;
  say('pngFrames=' + nGot + '/' + frames);

  /* ⚠️ 完成标记必须写进 **jsx 自身的 .done**（这个脚本会被复制到 ASCII 临时目录再跑，
   *    写死在 OUT 里的话 ae-scenes.mjs 那边等不到 ⇒ 白等 TIMEOUT 秒 ✗）*/
  var self = new File($.fileName);
  var df = new File(self.fsName + '.done');
  df.encoding = 'UTF-8';
  df.open('w');
  df.write('RESULT=OK frames=' + nGot + ' dur=' + DUR + '\\n--- DBG ---\\n' + DBG.join('\\n'));
  df.close();
  } catch (eMain) {
    /* 运行时错误也写进 .done —— 不写的话 ae-scenes.mjs 只会说"没写完成标记"，
     * 真正的原因（哪个 API 不认）就丢了 ✗ */
    writeDone('FAIL 运行时: ' + eMain.toString() + (eMain.line ? ' line ' + eMain.line : ''));
    say('运行时错误: ' + eMain.toString());
  }
  } catch (e0) {
    writeDone('FAIL 早期: ' + e0.toString() + (e0.line ? ' line ' + e0.line : ''));
    say('早期错误: ' + e0.toString());
  }
})();
