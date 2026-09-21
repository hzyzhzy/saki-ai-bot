/**
 * 身份差异测试：对服主和普通群友要说不一样的话。
 * 假模型会记录收到的系统提示词，断言身份段落是否正确注入。
 *
 * 用法: node test/attitude.js
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LLM_PORT = 39802;
const WS_PORT = 39801;
const TOKEN = 'att-token';
const BOT_QQ = '10000002';
const GROUP = '200000001';
const OWNER = '10000001';
const ADMIN = '10000005';
const MEMBER = '30003';

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probes = [];

const llmServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const sys = parsed.messages?.find((m) => m.role === 'system')?.content ?? '';
    const user = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
    if (parsed.messages) probes.push({ sys, user });

      // ⚠️⚠️ 合并式预搜索（system 里含「这句话要不要上网查」）——
      //    **它走的是流式 `collect(streamChat(...))`，必须回 SSE，不是 JSON**。
      //
      //    这里原来回的是整块 `application/json`：预搜索的 SSE 解析器从里面
      //    读不出任何 `data:` → `raw` 是空串 → 判断解析失败 → **退回规则** →
      //    真的去联网搜（bing/百度/DDG + 抓页，12~15 秒）→ 后面几步的
      //    `waitFor` 被拖过超时 → 偶发假失败。
      //
      //    这个格式坑在 `e2e.js` 里早就写明过，但 `attitude.js` / `cs.js` /
      //    `teach.js` 都漏了（三处都因此产生过"偶发失败"，一直被当成并发噪音）。
      if (sys.includes('这句话要不要上网查')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: '{"search":false,"why":"测试不搜"}' } }] })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    // ⚠️ 「该不该说」判断请求（system 里含「假装成真人群友」）——
    //    它要的是 **JSON**，不是 SSE。假模型不认识它的话会回一段 SSE，
    //    判断解析失败 → 默认「不说」→ 测试里机器人整个哑掉（真实踩过）。
    //    这里统一回「说」，让测试专注在它要验的东西上。
    // ⚠️ 2026-09-13 加：「归属核对」请求也要认得出来。
    //    原来假模型不认识它 → 每次都要等满 8 秒超时 → 回归很慢。
    //    （用户反馈「跑回归时间太长了，是不是有什么 bug」——没 bug，是白等超时。）
    if (sys.includes('【归属核对】')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }));
      return;
    }
    if (sys.includes('假装成真人群友')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"speak":true,"why":"测试","length":"short"}' } }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const reply = '收到。';
    for (const p of reply.match(/.{1,3}/gs) ?? [reply]) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

let sock = null;
const wss = new WebSocketServer({ port: WS_PORT, host: '203.0.113.10' });
wss.on('connection', (ws, req) => {
  if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) return ws.close(1008);
  sock = ws;
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (m.echo !== undefined) {
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: m.echo }));
    }
  });
  ws.send(
    JSON.stringify({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      self_id: BOT_QQ,
      time: Math.floor(Date.now() / 1000),
    }),
  );
});

function say(userId, role, text, id) {
  sock.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: id,
      group_id: GROUP,
      user_id: userId,
      self_id: BOT_QQ,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: userId, nickname: role === 'owner' ? '<主人>' : role === 'admin' ? '管理' : '路人', role },
      message: [
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ` ${text}` } },
      ],
    }),
  );
}

async function waitFor(fn, timeout = 20000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    if (fn()) return true;
    await sleep(120);
  }
  return false;
}

// ⚠️ 必须**排除预搜索的探针**：合并式预搜索每条消息都会调一次，
//    它的 sys 是「该搜什么/要不要上网查」那套，**没有身份信息**。
//    取最后一个的话断言「标明对方是管理员」就会失败（真实踩过）。

const isPresearch = (p) => /这句话要不要上网查|该搜什么/.test(p.sys);
const probeOf = (kw) => [...probes].reverse().find((p) => !isPresearch(p) && p.user.includes(kw));

let bot = null;

async function main() {
  await new Promise((r) => llmServer.listen(LLM_PORT, '203.0.113.10', r));
  await new Promise((r) => (wss._server.listening ? r() : wss.once('listening', r)));

  bot = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.attitude-test.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 203.0.113.10，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '203.0.113.10,localhost,::1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  check(await waitFor(() => !!sock, 12000), '机器人已连接');
  if (!sock) return;

  console.log('\n[1] 服主说话 → 应该用「同级交流」的口吻要求');
  say(OWNER, 'owner', '把群的回复关掉试试', 4001);
  // ⚠️ 等**我要的那一条探针**，不是「有非预搜索探针就行」——
  //    合并式预搜索 / 上一步迟到的说话判断都会推探针，
  //    用数量条件会让断言在真正的聊天请求到达之前就跑（踩过）。
  await waitFor(() => !!probeOf('把群的回复关掉'), 20000);
  const pOwner = probeOf('把群的回复关掉');
  check(!!pOwner, '收到服主的消息');
  check(!!pOwner?.sys.includes('服主 <主人>'), '系统提示词标明了对方是服主');
  check(!!pOwner?.sys.includes('同级口吻'), '要求用同级口吻');
  check(!!pOwner?.sys.includes('不用敬语'), '明确说了不用敬语');
  check(!!pOwner?.sys.includes('不是他的客服'), '明确说明对服主不是客服身份');
  // 注意：知识库里的人设文档也会提到「可以端着一点」（那是给机器人看的通用说明），
  // 所以要只看**最后注入的那段身份指令**——那才是真正影响这次对话的内容。
  const injected = (p) => {
    const i = (p?.sys ?? '').lastIndexOf('## 当前对话者');
    return i === -1 ? '' : p.sys.slice(i);
  };
  const ownerInjected = injected(pOwner);
  check(!!ownerInjected, '身份段落存在');
  check(ownerInjected.includes('<主人> 本人'), '身份段落明确了对方就是服主本人');
  // 2026-09-13 用户要求：平时直接叫 <主人>，「服主」只在说服务器事务时用
  check(ownerInjected.includes('平时') && ownerInjected.includes('叫「<主人>」'), '身份段落交代了称呼规则（平时叫 <主人>）');
  check(ownerInjected.includes('服务器事务'), '身份段落限定了「服主」这个称呼的使用场合');
  check(!ownerInjected.includes('可以端着一点'), '身份段落没有套用「允许端着」那套');
  check(ownerInjected.includes('不要端着'), '身份段落明确说了不要端着');
  check(ownerInjected.includes('不要对他说「你找茏或者 <主人>」'), '身份段落禁止让服主去找自己');

  console.log('\n[2] 普通群友说话 → 应该允许端着、可以怼');
  say(MEMBER, 'member', '服务器怎么进啊烦死了', 4002);
  await waitFor(() => !!probeOf('服务器怎么进啊'), 20000);
  const pMember = probeOf('服务器怎么进啊');
  check(!!pMember, '收到群友的消息');
  check(!!pMember?.sys.includes('普通群友'), '系统提示词标明了对方是普通群友');
  check(!!pMember?.sys.includes('端着'), '允许对群友端着');
  check(!!pMember?.sys.includes('可以硬一点'), '允许怼不讲理的群友');
  check(!!pMember?.sys.includes('不是谁的佣人'), '明确了服务姿态的上限');
  // ⚠️ 别用「同级口吻」「服主 <主人> 本人」这种词判断 —— 知识库/人设里也会出现，会误伤。
  //    只查**只有服主那一段才有**的措辞。
  check(!pMember?.sys.includes('他自己就是'), '对群友没有套用服主那套');
  check(!pMember?.sys.includes('你不是他的客服，是他的助手'), '对群友没有套用「你是他助手」那套');
  check(!pMember?.sys.includes('比朋友近，但没到那一步'), '对群友没有套用「恋人未满」那套');

  console.log('\n[3] 管理员 → 中间档');
  say(ADMIN, 'admin', '外地铁站那边有个问题', 4003);
  await waitFor(() => !!probeOf('外地铁站那边'), 20000);
  const pAdmin = probeOf('外地铁站那边');
  check(!!pAdmin, '收到管理员的消息');
  check(!!pAdmin?.sys.includes('管理员'), '标明对方是管理员');
  check(!pAdmin?.sys.includes('他自己就是'), '没有把他当成服主');
  check(!pAdmin?.sys.includes('你不是他的客服，是他的助手'), '没有给管理员套用服主那套');
  check(!pAdmin?.sys.includes('不是谁的佣人'), '也没有套用对群友的那套');

  console.log('\n[4] 身份段落必须放在提示词最后（位置影响最大）');
  if (pMember) {
    const attIdx = pMember.sys.indexOf('普通群友');
    const kbIdx = pMember.sys.indexOf('知识库');
    check(attIdx > kbIdx, `身份段落在知识库之后（知识库@${kbIdx} < 身份@${attIdx}）`);
  }

  console.log('\n[5] 私聊非服主 → 按群友处理');
  const n3 = probes.length;
  sock.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 4004,
      user_id: MEMBER,
      self_id: BOT_QQ,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: MEMBER, nickname: '路人' },
      message: [{ type: 'text', data: { text: '在吗，问个事' } }],
    }),
  );
  // ⚠️⚠️ 这里原来等的是「非预搜索探针数 > 3」—— 那是**绝对阈值**，
  //    在第 2 步结束时就已经成立了，所以这个 `waitFor` **立刻就返回**，
  //    然后去取一条还不存在的探针：`pPrivate` 是 undefined，
  //    `!!undefined?.sys` → false，于是**【5】约一半概率假失败**
  //    （实测连跑 4 次：过、挂、挂、过）。
  //    ✅ 条件必须**指向我要的那一条**：等关键词出现。
  //    ⚠️ 而且不能只看"数量变多" —— 上一步迟到的探针（说话判断/归属核对）
  //       也会让数量变多，同样会提前放开。
  await waitFor(() => !!probeOf('在吗，问个事'), 20000);
  const pPrivate = probeOf('在吗，问个事');
  check(!!pPrivate?.sys.includes('普通群友'), '私聊里的陌生人按群友对待');
}

async function cleanup() {
  try {
    bot?.kill();
  } catch {}
  try {
    sock?.close();
  } catch {}
  await new Promise((r) => wss.close(r));
  await new Promise((r) => llmServer.close(r));
}

main()
  .catch((e) => {
    console.error('\n测试脚本出错:', e);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
    process.exit(failures === 0 ? 0 : 1);
  });


