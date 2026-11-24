/**
 * 假 bot：验证适配器的 OneBot 契约 + 直接测 send_group_msg。
 * ⚠️ 之前的坑：Node 全局 WebSocket 的 message 事件在文本帧较大时给的是 ArrayBuffer，
 *    直接 JSON.parse(String(ev.data)) 会得到 "[object ArrayBuffer]" ⇒ 看起来"超时"，
 *    其实服务端早就回包了（日志里能看到 [api] 回 ... frame=1596B）。
 */
const PORT = Number(process.argv[2] || 6700);
const GID = process.argv[3] || '200000007';
const TEXT = process.argv[4] || '';
const DO_SEND = TEXT.length > 0;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
ws.binaryType = 'arraybuffer';
let seq = 1;
const pending = new Map();

function api(action, params = {}, timeoutMs = 240000) {
  const echo = 'x' + seq++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(echo); reject(new Error('超时 ' + action)); }, timeoutMs);
    pending.set(echo, (r) => { clearTimeout(t); resolve(r); });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

/** 把 ws 的 data（string / ArrayBuffer / Blob / Buffer）统一成字符串 */
async function toText(d) {
  if (typeof d === 'string') return d;
  if (Buffer.isBuffer(d)) return d.toString('utf8');
  if (d instanceof ArrayBuffer) return Buffer.from(d).toString('utf8');
  if (typeof Blob !== 'undefined' && d instanceof Blob) return await d.text();
  if (ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString('utf8');
  return String(d);
}

ws.addEventListener('open', async () => {
  console.log('✅ 已连上适配器');
  try {
    const gl = await api('get_group_list');
    const n = Array.isArray(gl?.data) ? gl.data.length : 0;
    console.log('get_group_list →', n, '个群');
    const target = (gl?.data || []).find((g) => String(g.group_id) === String(GID));
    console.log('目标群:', target ? `${target.group_id}=${target.group_name}` : '⚠️ 没找到');

    const login = await api('get_login_info');
    console.log('get_login_info →', JSON.stringify(login?.data));

    if (DO_SEND) {
      console.log('发送中（要走 UIA + 键鼠，约 30~60 秒）…');
      const t0 = Date.now();
      const r = await api('send_group_msg', {
        group_id: Number(GID),
        message: [{ type: 'text', data: { text: TEXT } }],
      });
      console.log(`send_group_msg → (${((Date.now() - t0) / 1000).toFixed(1)}s)`, JSON.stringify(r).slice(0, 240));
    }
  } catch (e) {
    console.log('❌', e.message);
  }
  process.exit(0);
});

ws.addEventListener('message', async (ev) => {
  let j;
  try {
    j = JSON.parse(await toText(ev.data));
  } catch {
    return;
  }
  if (j.echo && pending.has(j.echo)) {
    pending.get(j.echo)(j);
    pending.delete(j.echo);
    return;
  }
  if (j.post_type === 'message') {
    console.log('📨 事件:', j.group_id, j.sender?.card, String(j.raw_message).slice(0, 30));
  }
});

ws.addEventListener('error', (e) => console.log('WS 错误:', e.message || e.type));
setTimeout(() => { console.log('总超时'); process.exit(1); }, 300000);
