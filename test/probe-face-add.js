/**
 * 探测：能否往这个 QQ 号的收藏表情里加图（决定用户能否用 QQ 自带收藏管理表情）。
 * 做法：发一张已知图片给自己 → 立刻重新拉收藏列表 → 看有没有多出来。
 *
 * 用法: node test/probe-face-add.js
 * 需要先停掉机器人（NapCat 只允许单客户端）。
 */
import WebSocket from 'ws';

const URL_ = 'ws://127.0.0.1:3001';
// ⚠️ Token **不许写死在代码里**（2026-09-15 准备开源时清掉的），
//    一律从项目自己的 config.yml 读：onebot.accessToken
const TOKEN = (await import('../src/config.js')).config.onebot?.accessToken ?? '';
if (!TOKEN) { console.error('config.yml 里没读到 onebot.accessToken'); process.exit(2); }
const SELF = '10000002';

const ws = new WebSocket(URL_, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let seq = 0;

const call = (action, params = {}, t = 30000) =>
  new Promise((res, rej) => {
    const e = `x${++seq}`;
    pending.set(e, { res, rej });
    ws.send(JSON.stringify({ action, params, echo: e }));
    setTimeout(() => {
      if (pending.delete(e)) rej(new Error(`${action} 超时`));
    }, t);
  });

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString('utf8'));
  if (m.echo && pending.has(m.echo)) {
    const p = pending.get(m.echo);
    pending.delete(m.echo);
    m.status === 'ok' || m.retcode === 0
      ? p.res(m.data)
      : p.rej(new Error(`${m.retcode} ${m.message ?? m.wording ?? ''}`));
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.on('open', async () => {
  try {
    const before = await call('fetch_custom_face', { count: 100 });
    console.log(`操作前收藏数: ${before.length}`);

    // 用群里的一张图当素材，发给机器人自己
    const h = await call('get_group_msg_history', { group_id: '200000001', count: 200 });
    const img = (h?.messages ?? [])
      .flatMap((m) => m.message ?? [])
      .find((s) => s.type === 'image');
    if (!img) {
      console.log('没找到可用图片，放弃');
      return;
    }
    const file = img.data.file ?? img.data.url;
    console.log(`尝试发送图片: ${String(file).slice(0, 60)}…`);

    const r = await call('send_private_msg', {
      user_id: SELF,
      message: [{ type: 'image', data: { file } }],
    });
    console.log('发送结果:', JSON.stringify(r).slice(0, 150));

    await sleep(4000);
    const after = await call('fetch_custom_face', { count: 100 });
    console.log(`操作后收藏数: ${after.length}`);
    console.log(
      after.length > before.length
        ? '→ 收藏数增加，说明「发送图片给自己」可能被算作收藏（可以试试）'
        : '→ 收藏数没变，说明发消息不会自动进收藏夹，需要手动在 QQ 里长按收藏',
    );
  } catch (e) {
    console.error('出错:', e.message);
  } finally {
    ws.close();
  }
});

ws.on('error', (e) => console.error('连接失败:', e.message));
