/**
 * 以另一个号的身份（走 SnowLuma）发消息 —— 群聊 / 私聊 / 戳都支持。
 *
 * ⚠️ **重要限制（2026-11-16 实测）**：走这条"第二条 WS 连接"发的消息
 *    **虽然返回 `retcode 0`，但常常到不了对方的官方 QQ 客户端**
 *    （试了 5 条、3 个群，连会话摘要都不变）。
 *    要发"真到得了"的消息，得用**那个号自己的 bot 连接**，比如爱音的 webui：
 *      POST http://127.0.0.1:3100/api/friend/test-notice  {userId, groupId}
 *      POST http://127.0.0.1:3100/api/life/send-now       {groupId}    ← 内容每次不同
 *    这个脚本留着是给"协议端侧行为"用的（比如查群列表、发戳）。
 *
 *   node tools/anon-send.mjs --group 200000007 --text "@Saki 测试"
 *   node tools/anon-send.mjs --private 10000002 --text "私聊测试"
 *   node tools/anon-send.mjs --poke 10000002 --group 200000007
 */

const argv = process.argv.slice(2);
const pick = (n, d) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? d : v;
};

const PORT = Number(pick('port', '3002'));
const TOKEN = pick('token', '');
const group = pick('group', '');
const priv = pick('private', '');
const pokeUid = pick('poke', '');
const text = pick('text', '');
const imagePath = pick('image', '');  // 2026-11-17：发图用（走 SnowLuma 的 image 段）

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

function call(action, params = {}, timeout = 30000) {
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
    let j = null;
    try {
      j = JSON.parse(toText(ev.data));
    } catch {
      return;
    }
    // ⚠️ 只认带 echo 的 API 响应（连上之后先来的是 lifecycle / message 事件）
    if (!j || j.echo === undefined) return;
    if (pending.has(String(j.echo))) {
      pending.get(String(j.echo))(j);
      pending.delete(String(j.echo));
    }
  };

  const me = await call('get_login_info');
  console.log(`端口 ${PORT} 登录号：`, me?.data?.user_id, me?.data?.nickname);

  if (pokeUid) {
    const r = await call('send_poke', { user_id: Number(pokeUid), group_id: Number(group || 0) });
    console.log('send_poke →', JSON.stringify(r));
  }
  if (priv && text) {
    const r = await call('send_private_msg', {
      user_id: Number(priv),
      message: [{ type: 'text', data: { text } }],
    });
    console.log('send_private_msg →', JSON.stringify(r));
  }
  if (group && (text || imagePath)) {
    const segs = [];
    if (imagePath) {
      // SnowLuma 认 file:// 绝对路径或 base64；用绝对路径最省事
      const abs = imagePath.replace(/\\/g, '/');
      segs.push({ type: 'image', data: { file: abs.startsWith('/') ? 'file://' + abs : 'file:///' + abs } });
    }
    if (text) segs.push({ type: 'text', data: { text } });
    const r = await call('send_group_msg', {
      group_id: Number(group),
      message: segs,
    }, 90000);
    console.log('send_group_msg →', JSON.stringify(r));
  }

  ws.close();
  process.exit(0);
};

ws.onerror = (e) => {
  console.error('WS 错误：', e.message || e);
  process.exit(1);
};
setTimeout(() => process.exit(2), 60000);
