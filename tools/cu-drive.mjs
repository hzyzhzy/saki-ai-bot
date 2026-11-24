/**
 * 一段式操作：同一次 worker 会话里「读树 → 点 ref → 等 → 再读树」，
 * 避免 ref 跨进程失效（每次 `computer-use.mjs` 都起新 worker，ref 立刻作废）。
 *
 * 用法：node tools/cu-drive.mjs <动作>
 *   page   —— 切到「消息」页并列出会话（只读，不点群）
 */
const { PowerShellBackend } = await import('file://' + '<项目目录>/qq-ai-bot/tools/vendor/computer-use/backend/bridge.js'.replace(/\\/g, '/'));
const be = new PowerShellBackend({ timeoutMs: 30000 });
const HWND = 328378;
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(5) + 'ms';

const tree = async (nodes = 300) => {
  const r = await be.request('uitree', { hwnd: HWND, maxDepth: 26, maxNodes: nodes });
  return (r.nodes ?? []).map((n) => ({
    ref: n.ref,
    type: String(n.controlType ?? '').replace('ControlType.', ''),
    name: String(n.name ?? ''),
    x: n.x, y: n.y, w: n.width, h: n.height,
    pat: n.patterns ?? [],
  }));
};

try {
  await be.start();
  console.log(ms(), 'worker 就绪');

  const all = await tree();
  console.log(ms(), `读树 ${all.length} 节点`);

  const msgBtn = all.find((n) => /^消息/.test(n.name));
  if (!msgBtn) {
    console.log('✗ 没找到「消息」按钮');
    const cands = all.filter((n) => n.type === 'Button' && n.w < 100 && n.h < 100);
    console.log('  小按钮候选：', cands.slice(0, 12).map((c) => `${c.name || '(无名)'}@${c.x},${c.y}`).join(' | '));
  } else {
    console.log(ms(), `「消息」按钮 ref=${msgBtn.ref}`);
    const r = await be.request('click', { ref: msgBtn.ref });
    console.log(ms(), '点击结果', JSON.stringify(r).slice(0, 160));
    await new Promise((r2) => setTimeout(r2, 900));
    const after = await tree();
    console.log(ms(), `切页后读树 ${after.length} 节点`);
    // 会话列表通常是「有文字、宽度较大、在左栏」的 Text
    const convs = after.filter((n) => n.type === 'Text' && n.name && n.w > 60);
    console.log('  有文字的 Text（前 24）：');
    for (const c of convs.slice(0, 24)) console.log(`    ${c.name.slice(0, 30).padEnd(32)} @${c.x},${c.y} ${c.w}x${c.h}`);
    const tabs = after.filter((n) => n.type === 'TabItem').map((n) => n.name);
    console.log('  TabItem：', tabs.join(' / ') || '(无)');
  }
} catch (e) {
  console.log('❌', e?.message ?? e);
} finally {
  try { be.dispose(); } catch {}
}
