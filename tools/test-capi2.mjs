/** 测新补的四个 API：get_friend_list / send_private_msg / get_group_member_info / mark_msg_as_read */

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

function call(action, params = {}, timeout = 180000) {
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
  ws.onmessage = (ev) => {
    try {
      const j = JSON.parse(toText(ev.data));
      if (j.echo && pending.has(String(j.echo))) {
        pending.get(String(j.echo))(j);
        pending.delete(String(j.echo));
      }
    } catch {}
  };

  console.log('=== get_friend_list（新）===');
  const fl = await call('get_friend_list');
  console.log('retcode=', fl.retcode, ' 好友数=', (fl.data || []).length);
  for (const f of (fl.data || []).slice(0, 5)) {
    console.log(`  nickname=${JSON.stringify(f.nickname)} _clientName=${JSON.stringify(f._clientName)} user_id=${f.user_id}`);
  }

  console.log('\n=== get_group_member_info（新）===');
  const mi = await call('get_group_member_info', { group_id: 200000007, nickname: '<主人>' });
  console.log('retcode=', mi.retcode);
  if (mi.data) console.log('  ', JSON.stringify(mi.data));
  else console.log('  msg=', mi.msg);

  console.log('\n=== get_group_member_info（不存在的名字）===');
  const mi2 = await call('get_group_member_info', { group_id: 200000007, nickname: '不存在的人XYZ' });
  console.log('retcode=', mi2.retcode, ' msg=', String(mi2.msg || '').slice(0, 80));

  console.log('\n=== mark_msg_as_read（新）===');
  const mk = await call('mark_msg_as_read', { group_id: 200000007 });
  console.log('retcode=', mk.retcode, ' msg=', String(mk.msg || '').slice(0, 60));

  if ((fl.data || []).length) {
    console.log('\n=== send_private_msg（新）===');
    const target = fl.data[0]._clientName;
    console.log('  目标会话 =', JSON.stringify(target));
    const sp = await call('send_private_msg', { _clientName: target, message: [{ type: 'text', data: { text: '私聊发送测试P1' } }] }, 300000);
    console.log('retcode=', sp.retcode, ' msg=', String(sp.msg || '').slice(0, 80));
    if (sp.data) console.log('  message_id=', sp.data.message_id);
  } else {
    console.log('\n（没有私聊会话，跳过 send_private_msg）');
  }

  ws.close();
  process.exit(0);
};

ws.onerror = (e) => {
  console.error('WS 错误:', e.message || e);
  process.exit(1);
};

setTimeout(() => {
  console.error('超时');
  process.exit(2);
}, 600000);
