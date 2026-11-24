/**
 * 验证「截图 → 视觉定位 → frameproject 换算 → 点击」这条链。
 * 思路：QQ NT 是自绘界面、UIA 的 ref 会失效，但**截图是准的**，
 *       worker 提供 frameproject 把「图上的像素点」换算成「桌面坐标」。
 *
 * 本脚本只做前半段：截 QQ 窗口、打印 frame 信息、并试一次 frameproject。
 */
const { PowerShellBackend } = await import(
  'file://<项目目录>/qq-ai-bot/tools/vendor/computer-use/backend/bridge.js'
);
const be = new PowerShellBackend({ timeoutMs: 45000 });
const HWND = 328378;
const OUT = 'C:/Temp/qq-shot.png';
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(5) + 'ms';

try {
  await be.start();
  const shot = await be.request('screenshot', { hwnd: HWND, path: OUT });
  console.log(ms(), '截图 →', JSON.stringify({
    path: shot.path, w: shot.width, h: shot.height, scale: shot.effectiveScale ?? shot.scale,
    frame: shot.frame ?? shot.frameId ?? '(无 frame 字段)',
  }));
  console.log(ms(), '截图回执全部字段:', Object.keys(shot).join(','));

  const frameId = shot.frame ?? shot.frameId;
  if (frameId) {
    // 试：图上 (100,100) 对应桌面哪一点
    const r = await be.request('frameproject', { frame: frameId, x: 100, y: 100 }).catch((e) => ({ error: e.message }));
    console.log(ms(), 'frameproject(100,100) →', JSON.stringify(r).slice(0, 240));
  } else {
    console.log(ms(), '⚠️ 截图没回 frame id，看看 frameattach 的用法');
    const r = await be.request('frameattach', { frame: 'probe', width: shot.width, height: shot.height }).catch((e) => ({ error: e.message }));
    console.log(ms(), 'frameattach 试探 →', JSON.stringify(r).slice(0, 200));
  }
} catch (e) {
  console.log('❌', e?.message ?? e);
} finally {
  try {
    be.dispose();
  } catch {}
}
