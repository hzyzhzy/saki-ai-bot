/** 查爱音（3002）在哪些群 —— 找她真能发消息的目标群。 */

const PORT = 3002;
const TOKEN = '';

function toText(d) {
  if (typeof d === 'string') return d;
  if (d instanceof ArrayBuffer) return Buffer.from(d).toString('utf8');
  if (Buffer.isBuffer(d)) return d.toString('utf8');
  if (ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString('utf8');
  return String(d);
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
let n = 0;
const pending = new Map();

function call(action, params = {}, timeout = 20000) {
  const e = String(++n);
  return new Promise((r) => {
    pending.set(e, r);
    ws.send(JSON.stringify({ action, params, echo: e }));
    setTimeout(() => {
      if (pending.has(e)) {
        pending.delete(e);
        r({ timeout: true });
      }
    }, timeout);
  });
}

ws.onopen = async () => {
  ws.onmessage = (ev) => {
    try {
      const j = JSON.parse(toText(ev.data));
      if (j.echo && pending.has(String(j.echo))) {
        pending.get(String(j.echo))(j);
        pending.delete(String(j.echo));
      }
    } catch {}
  };

  const me = await call('get_login_info');
  console.log('本号：', me?.data?.user_id, me?.data?.nickname);

  const gl = await call('get_group_list');
  const list = gl?.data || [];
  console.log(`群 ${list.length} 个：`);
  for (const g of list) console.log(`  ${g.group_id}  ${g.group_name}`);

  ws.close();
  process.exit(0);
};

ws.onerror = (e) => {
  console.error('WS 错误：', e.message || e);
  process.exit(1);
};
setTimeout(() => process.exit(2), 60000);
