/** 问一下 SnowLuma 各端口现在登录的是哪个号 —— 用来判断能不能把适配器没实现的接口转过去。 */

const PORTS = [3001, 3002, 3003];

function toText(d) {
  if (typeof d === 'string') return d;
  if (d instanceof ArrayBuffer) return Buffer.from(d).toString('utf8');
  if (Buffer.isBuffer(d)) return d.toString('utf8');
  if (ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString('utf8');
  return String(d);
}

function ask(port, action, params = {}, timeout = 15000) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch (e) {
      resolve({ ok: false, err: String(e.message || e) });
      return;
    }
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ ok: false, err: 'timeout' });
    }, timeout);
    ws.onopen = () => ws.send(JSON.stringify({ action, params, echo: '1' }));
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      let j = null;
      try { j = JSON.parse(toText(ev.data)); } catch {}
      try { ws.close(); } catch {}
      resolve(j ? { ok: true, j } : { ok: false, err: 'bad json' });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ ok: false, err: 'connect failed' });
    };
  });
}

for (const p of PORTS) {
  const r = await ask(p, 'get_login_info');
  if (r.ok && r.j?.data) {
    console.log(`端口 ${p}: 登录号 ${r.j.data.user_id} 昵称 ${JSON.stringify(r.j.data.nickname)}`);
  } else {
    console.log(`端口 ${p}: ${r.err || JSON.stringify(r.j).slice(0, 80)}`);
  }
}

// 顺便看 3001 支不支持 send_poke（只查不真发：故意传个不存在的 user_id，看它回什么错）
const sp = await ask(3001, 'send_poke', { user_id: 0, group_id: 0 });
console.log('\n3001 send_poke 探测:', JSON.stringify(sp.j || sp).slice(0, 200));

process.exit(0);
