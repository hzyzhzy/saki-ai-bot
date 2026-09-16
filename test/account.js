// 查询 NapCat 当前登录账号的信息，并读取好友列表里包含指定关键词的条目。
import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:3001';
// ⚠️ Token **不许写死在代码里**（2026-09-15 准备开源时清掉的），
//    一律从项目自己的 config.yml 读：onebot.accessToken
const TOKEN = (await import('../src/config.js')).config.onebot?.accessToken ?? '';
if (!TOKEN) { console.error('config.yml 里没读到 onebot.accessToken'); process.exit(2); }
const keyword = process.argv[2] ?? '';

const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let seq = 0;

function call(action, params = {}) {
  return new Promise((resolve, reject) => {
    const echo = `q${++seq}`;
    pending.set(echo, { resolve, reject });
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => {
      if (pending.delete(echo)) reject(new Error(`${action} 超时`));
    }, 15000);
  });
}

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString('utf8'));
  if (m.echo && pending.has(m.echo)) {
    const p = pending.get(m.echo);
    pending.delete(m.echo);
    if (m.status === 'ok' || m.retcode === 0) p.resolve(m.data);
    else p.reject(new Error(`${m.retcode} ${m.message ?? m.wording ?? ''}`));
  }
});

ws.on('open', async () => {
  try {
    const info = await call('get_login_info');
    console.log('=== 当前登录的 QQ 账号 ===');
    console.log(`  QQ 号  : ${info.user_id}`);
    console.log(`  昵称   : ${info.nickname}`);

    const status = await call('get_status').catch(() => null);
    if (status) console.log(`  在线状态: ${status.online ? '在线' : '离线'} / ${status.good ? '正常' : '异常'}`);

    const friends = await call('get_friend_list').catch(() => []);
    console.log(`\n=== 好友总数: ${friends.length} ===`);
    if (keyword) {
      const hit = friends.filter(
        (f) => String(f.user_id).includes(keyword) || (f.nickname ?? '').includes(keyword),
      );
      console.log(`匹配「${keyword}」的 ${hit.length} 条：`);
      for (const f of hit) console.log(`  ${f.user_id}  ${f.nickname}`);
    } else {
      console.log('前 15 条：');
      for (const f of friends.slice(0, 15)) console.log(`  ${f.user_id}  ${f.nickname}`);
    }

    const groups = await call('get_group_list').catch(() => []);
    console.log(`\n=== 已加入的群: ${groups.length} 个 ===`);
    for (const g of groups.slice(0, 15)) console.log(`  ${g.group_id}  ${g.group_name}`);
  } catch (e) {
    console.error('查询失败:', e.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});

ws.on('error', (e) => {
  console.error('连接失败:', e.message);
  process.exitCode = 1;
});
