/** 测客户端适配器的 API（get_group_member_list / get_group_info / get_group_list 等） */

const WS = 'ws://127.0.0.1:6700';

function toText(d) {
  if (typeof d === 'string') return d;
  if (d instanceof ArrayBuffer) return Buffer.from(d).toString('utf8');
  if (Buffer.isBuffer(d)) return d.toString('utf8');
  if (ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString('utf8');
  return String(d);
}

const ws = new WebSocket(WS);
let echo = 0;
const pending = new Map();

function call(action, params = {}, timeout = 120000) {
  const e = String(++echo);
  return new Promise((resolve) => {
    pending.set(e, resolve);
    ws.send(JSON.stringify({ action, params, echo: e }));
    setTimeout(() => {
      if (pending.has(e)) {
        pending.delete(e);
        resolve({ timeout: true, action });
      }
    }, timeout);
  });
}

ws.onopen = async () => {
  console.log('已连接', WS);
  ws.onmessage = (ev) => {
    const t = toText(ev.data);
    try {
      const j = JSON.parse(t);
      if (j.echo && pending.has(String(j.echo))) {
        pending.get(String(j.echo))(j);
        pending.delete(String(j.echo));
      }
    } catch {}
  };

  console.log('\n=== get_login_info ===');
  console.log(JSON.stringify(await call('get_login_info')));

  console.log('\n=== get_group_list ===');
  const gl = await call('get_group_list');
  console.log('retcode=', gl.retcode, '群数=', (gl.data || []).length);
  for (const g of (gl.data || []).slice(0, 4)) {
    console.log(`  ${g.group_id}  ${g.group_name}  ${g.member_count} 人`);
  }

  console.log('\n=== get_group_info（示例服务器 2026 = 200000007）===');
  console.log(JSON.stringify(await call('get_group_info', { group_id: 200000007 })).slice(0, 300));

  console.log('\n=== get_group_member_list（新实现，约 2~4 秒）===');
  const t0 = Date.now();
  const ml = await call('get_group_member_list', { group_id: 200000007 });
  const ms = Date.now() - t0;
  console.log(`retcode=${ml.retcode} 耗时=${ms}ms 成员数=${(ml.data || []).length}`);
  if (ml.retcode === 0) {
    for (const m of (ml.data || []).slice(0, 8)) {
      console.log(`  [${m.role.padEnd(6)}] 「${m.nickname}」 card=${m.card}`);
    }
  } else {
    console.log('  msg=', ml.msg);
  }

  console.log('\n=== get_status ===');
  console.log(JSON.stringify(await call('get_status')).slice(0, 200));

  ws.close();
  process.exit(0);
};

ws.onerror = (e) => {
  console.error('WS 错误:', e.message || e);
  process.exit(1);
};

setTimeout(() => {
  console.error('超时退出');
  process.exit(2);
}, 240000);
