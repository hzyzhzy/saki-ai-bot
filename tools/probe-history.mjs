/** 直接看 6700 的 get_group_msg_history 原始响应。 */

function toText(d) {
  if (typeof d === 'string') return d;
  if (d instanceof ArrayBuffer) return Buffer.from(d).toString('utf8');
  if (Buffer.isBuffer(d)) return d.toString('utf8');
  if (ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString('utf8');
  return String(d);
}

const ws = new WebSocket('ws://127.0.0.1:6700');
ws.onopen = () =>
  ws.send(JSON.stringify({ action: 'get_group_msg_history', params: { group_id: 200000007, count: 30 }, echo: '1' }));
ws.onmessage = (ev) => {
  const t = toText(ev.data);
  console.log('原始长度', t.length);
  console.log(t.slice(0, 1200));
  process.exit(0);
};
ws.onerror = (e) => {
  console.error('错误', e.message || e);
  process.exit(1);
};
setTimeout(() => process.exit(2), 120000);
