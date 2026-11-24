/**
 * 逐个探测 6700 客户端适配器支持的 OneBot action —— **只跑不碰 QQ 界面的那些**。
 *
 * 会切会话（get_group_member_list / get_group_member_info / mark_msg_as_read）
 * 和会真发消息（send_*）的一律跳过：Saki 正连着这个适配器，
 * 切会话会打断她正在处理的对话。
 *
 * 跑法：node tools/probe-capi-actions.mjs
 */

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

function call(action, params = {}, timeout = 60000) {
  const e = String(++echo);
  return new Promise((resolve) => {
    pending.set(e, resolve);
    ws.send(JSON.stringify({ action, params, echo: e }));
    setTimeout(() => {
      if (pending.has(e)) {
        pending.delete(e);
        resolve({ timeout: true, status: 'timeout' });
      }
    }, timeout);
  });
}

// 只读、不切会话、不发消息的
const SAFE = [
  ['get_login_info', {}],
  ['get_status', {}],
  ['get_version_info', {}],
  ['can_send_image', {}],
  ['can_send_record', {}],
  ['get_group_list', {}],
  ['get_friend_list', {}],
  ['get_group_info', { group_id: 200000006 }],
  ['get_group_msg_history', { group_id: 200000006 }],
];

// 适配器根本没实现 / 明确拒绝的（都不会碰 QQ 界面，安全）
const NOT_IMPL = [
  ['get_msg', { message_id: 1 }],
  ['get_image', { file: 'x' }],
  ['get_forward_msg', { id: 'x' }],
  ['get_friend_msg_history', { user_id: 0 }],
  ['get_stranger_info', { user_id: 0 }],
  ['send_group_forward_msg', { group_id: 200000006, messages: [] }],
  ['set_msg_emoji_like', { message_id: 1, emoji_id: '1' }],
  ['delete_msg', { message_id: 1 }],
  ['set_group_ban', { group_id: 200000006, user_id: 0, duration: 60 }],
  ['set_group_whole_ban', { group_id: 200000006, enable: true }],
  ['set_group_kick', { group_id: 200000006, user_id: 0 }],
  ['set_group_card', { group_id: 200000006, user_id: 0, card: 'x' }],
  ['set_group_admin', { group_id: 200000006, user_id: 0, enable: true }],
  ['set_group_name', { group_id: 200000006, group_name: 'x' }],
  ['set_group_leave', { group_id: 200000006 }],
  ['send_poke', { user_id: 0 }],
  ['set_friend_remark', { user_id: 0, remark: 'x' }],
  ['set_restart', {}],
];

const rows = [];

const brief = (r) => {
  if (r.timeout) return 'TIMEOUT';
  const d = r.data;
  let s = '';
  if (Array.isArray(d)) s = `数组 ${d.length} 条`;
  else if (d && typeof d === 'object') s = Object.keys(d).slice(0, 6).join(',');
  else if (d !== undefined && d !== null) s = JSON.stringify(d).slice(0, 60);
  return `status=${r.status} retcode=${r.retcode}${r.msg ? ` msg=${String(r.msg).slice(0, 70)}` : ''}${s ? ` data={${s}}` : ''}`;
};

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

  console.log('=== 真实现（返回真实数据）===');
  for (const [action, params] of SAFE) {
    const r = await call(action, params);
    rows.push({ group: '实装', action, ...r });
    console.log(`${action.padEnd(24)} ${brief(r)}`);
  }

  console.log('\n=== 未实现 / 明确拒绝 ===');
  for (const [action, params] of NOT_IMPL) {
    const r = await call(action, params);
    rows.push({ group: '未实现', action, ...r });
    console.log(`${action.padEnd(24)} ${brief(r)}`);
  }

  console.log('\n=== 跳过（会切会话或真发消息，Saki 正在用）===');
  for (const a of [
    'get_group_member_list',
    'get_group_member_info',
    'mark_msg_as_read',
    'send_group_msg',
    'send_private_msg',
    'send_msg',
  ]) {
    console.log(`${a.padEnd(24)} （跳过）`);
  }

  const okN = rows.filter((r) => r.group === '实装' && r.status === 'ok').length;
  const failN = rows.filter((r) => r.group === '未实现').length;
  console.log(`\n合计：实装且 ok ${okN} 个 / 未实现 ${failN} 个`);

  ws.close();
  process.exit(0);
};

ws.onerror = (e) => {
  console.error('WS 错误:', e.message || e);
  process.exit(1);
};

setTimeout(() => {
  console.error('总超时');
  process.exit(2);
}, 300000);
