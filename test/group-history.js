// 读取指定群的消息历史（正确分页），按发言者统计并保存。
// 用法: node test/group-history.js <群号> <页数> <输出文件>
// NapCat 的 get_group_msg_history 语义：message_seq 是游标，返回它「之后」的 count 条。
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const URL = 'ws://127.0.0.1:3001';
// ⚠️ Token **不许写死在代码里**（2026-09-15 准备开源时清掉的），
//    一律从项目自己的 config.yml 读：onebot.accessToken
const TOKEN = (await import('../src/config.js')).config.onebot?.accessToken ?? '';
if (!TOKEN) { console.error('config.yml 里没读到 onebot.accessToken'); process.exit(2); }
const GROUP = process.argv[2] ?? '200000001';
const PAGES = Number(process.argv[3] ?? 20);
const OUT = process.argv[4] ?? 'group-history.json';
const PAGE_SIZE = 100;

const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let seq = 0;

function call(action, params = {}, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const echo = `h${++seq}`;
    pending.set(echo, { resolve, reject });
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => {
      if (pending.delete(echo)) reject(new Error(`${action} 超时`));
    }, timeout);
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
    const members = await call('get_group_member_list', { group_id: GROUP }).catch(() => []);
    console.log(`=== 群 ${GROUP} 成员数: ${members.length} ===`);
    for (const m of members.filter((x) => x.role === 'owner' || x.role === 'admin')) {
      console.log(`  [${m.role}] ${m.user_id}  ${m.card || m.nickname}`);
    }

    const seen = new Map();
    let cursor = '';
    for (let i = 1; i <= PAGES; i++) {
      let page;
      try {
        page = await call('get_group_msg_history', {
          group_id: GROUP,
          count: PAGE_SIZE,
          ...(cursor ? { message_seq: cursor } : {}),
        });
      } catch (e) {
        console.log(`第 ${i} 页失败: ${e.message}`);
        break;
      }
      const msgs = page?.messages ?? [];
      if (!msgs.length) {
        console.log(`第 ${i} 页为空，停止`);
        break;
      }

      let added = 0;
      for (const m of msgs) {
        const key = String(m.message_id);
        if (!seen.has(key)) {
          seen.set(key, m);
          added++;
        }
      }

      // 游标推进到本页「最后一条」（时间上最新）的 seq
      const last = msgs[msgs.length - 1];
      const next = String(last?.message_seq ?? last?.message_id ?? '');
      if (!next || next === cursor) {
        console.log(`第 ${i} 页游标未推进，停止`);
        break;
      }
      cursor = next;

      if (i % 5 === 0 || added === 0) {
        console.log(`第 ${i} 页: 本页 ${msgs.length} 条，新增 ${added}，累计 ${seen.size}`);
      }
      if (added === 0 && i > 3) {
        console.log('连续无新增，停止');
        break;
      }
    }

    const all = [...seen.values()].sort((a, b) => a.time - b.time);
    console.log(`\n=== 去重后共 ${all.length} 条 ===`);
    if (all.length) {
      console.log('时间范围:', new Date(all[0].time * 1000).toLocaleString(), '→', new Date(all.at(-1).time * 1000).toLocaleString());
    }

    const byUser = new Map();
    for (const m of all) {
      const uid = String(m.user_id);
      if (!byUser.has(uid)) byUser.set(uid, { count: 0, name: '', msgs: [] });
      const e = byUser.get(uid);
      e.count++;
      e.name = m.sender?.card || m.sender?.nickname || e.name;
      e.msgs.push(m);
    }
    console.log('\n=== 发言排行 ===');
    [...byUser.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20)
      .forEach(([uid, e]) => console.log(`  ${String(e.count).padStart(5)} 条  ${uid}  ${e.name}`));

    writeFileSync(OUT, JSON.stringify(all, null, 2), 'utf8');
    console.log(`\n已保存到 ${OUT}`);
  } catch (e) {
    console.error('出错:', e.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});

ws.on('error', (e) => {
  console.error('连接失败:', e.message);
  process.exitCode = 1;
});
