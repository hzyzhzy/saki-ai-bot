/**
 * 教学功能测试：验证「群主能教、群友不能教、学了之后真的会用」。
 *
 * 用假模型 + 假 NapCat，不需要真 QQ：
 *   - 假模型的 /chat/completions 根据请求内容分流：
 *     · 知识抽取请求（system 里有"知识抽取器"）→ 返回固定 JSON
 *     · 回答请求 → 回一句可识别的话
 *
 * 用法: node test/teach.js
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** ⚠️ knowledge 目录跟着 `QQBOT_KNOWLEDGE_DIR` 走（回归时是各套件自己的副本） */
const KNOW = process.env.QQBOT_KNOWLEDGE_DIR
  ? join(ROOT, process.env.QQBOT_KNOWLEDGE_DIR)
  : join(ROOT, 'knowledge');
const LLM_PORT = 39502;
const WS_PORT = 39501;
const TOKEN = 'teach-token';
const BOT_QQ = '10000002';
const GROUP = '200000001';
const OWNER = '10000001'; // 群主
const MEMBER = '30003'; // 普通群友

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 学习档案：测试前后自动备份/还原，不污染真实数据 ──
const LEARNED = join(KNOW, 'learned.md');
const originalLearned = readFileSync(LEARNED, 'utf8');

// ── 假模型 ──
const calls = { extract: 0, answer: 0 };
const answerPrompts = [];

const llmServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const sys = parsed.messages?.find((m) => m.role === 'system')?.content ?? '';
    const user = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';

    // 预搜索（合并式）请求（system 提示词里含「这句话要不要上网查」）——
    // ⚠️ 和上面「搜索规划」同理：必须单独识别。合并预搜索**每条消息都会调一次**，
    //    不识别的话它会被当成「回答请求」推进 answerPrompts，挤掉真正的回答（踩过）。
    //
    // ⚠️⚠️ 而且**必须回 SSE**（`2026-09-13 修`）：预搜索走的是
    //    `collect(streamChat(...))`，不是 `res.json()` 那一套。
    //    这里原来回的是整块 `application/json` —— SSE 解析器从里面读不出
    //    `data:`，`raw` 是空串 → 判断解析失败 → **退回规则 → 真的联网搜**
    //    （bing/百度/DDG，12~15 秒）→ 【2】的 `waitFor` 被拖过超时 →
    //    「最高优先级」那 3 项偶发失败。
    //    （同一个坑在 `e2e.js` / `cs.js` 都踩过，这里也补齐。）
    if (sys.includes('这句话要不要上网查')) {
      calls.presearch = (calls.presearch ?? 0) + 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '{"search":false,"why":"测试不搜"}' } }] })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 搜索规划请求（system 提示词里含「该搜什么」）——
    // ⚠️ 必须单独识别出来。不然它会被当成「回答请求」推进 answerPrompts，
    //    挤掉真正的最后一条回答（踩过）。同样**要 SSE**（见上）。
    if (sys.includes('该搜什么')) {
      calls.plan = (calls.plan ?? 0) + 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'NONE' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 知识判断请求（detectKnowledge 的 system 提示词里含「知识录入」）
    if (sys.includes('知识录入') || sys.includes('知识抽取器')) {
      calls.extract++;
      // 模拟真实的判断口径：
      //   - explicit（提示词里说「用了明确的教学措辞」）→ 有实质内容就记
      //   - natural（提示词里说「只是随口说的」）→ 只有含明确知识关键词才记
      const isExplicit = sys.includes('明确的教学措辞');
      const substantive = /白名单|模组|取消|改成|现在支持|不允许|归.*管/.test(user);
      const shouldLearn = isExplicit ? substantive : substantive && /取消|改成|现在支持|不允许|归.*管/.test(user);

      const topic = user.includes('白名单') ? '白名单说明' : user.includes('模组') ? '模组清单' : '其它';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify(
                  shouldLearn
                    ? { hasKnowledge: true, natural: !isExplicit, topic, fact: `【学到的】${user}` }
                    : { hasKnowledge: false, natural: !isExplicit, topic: '', fact: '' },
                ),
              },
            },
          ],
        }),
      );
      return;
    }

    // 回答请求
    calls.answer++;
    answerPrompts.push({ sys, user });
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
    // ⚠️ **非流式**请求要回整块 JSON（`llm.phrase()` 那类走这条）——
    //    一律回 SSE 的话它会 `res.json()` 失败（`Unexpected token 'd'`），
    //    调用方静默退回模板/不补充。见 `test/cs.js` 同处注释。
    if (parsed.stream !== true) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的，我来帮您看看。' } }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const reply = '好的，我来帮您看看。';
    for (const p of reply.match(/.{1,5}/gs) ?? [reply]) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// ── 假 NapCat ──
const sent = [];
let sock = null;

const wss = new WebSocketServer({ port: WS_PORT, host: '203.0.113.10' });
wss.on('connection', (ws, req) => {
  if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
    ws.close(1008);
    return;
  }
  sock = ws;
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (m.action === 'send_group_msg' || m.action === 'send_private_msg') {
      const t = (m.params?.message ?? [])
        .filter((s) => s.type === 'text')
        .map((s) => s.data.text)
        .join('');
      if (t.trim()) sent.push(t.trim());
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

function say(userId, text, role = 'member', id = 1) {
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
      sender: { user_id: userId, nickname: role === 'owner' ? '<主人>' : '路人', role },
      message: [
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ` ${text}` } },
      ],
    }),
  );
}

const allSent = () => sent.join('\n');
async function waitFor(fn, timeout = 20000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    if (fn()) return true;
    await sleep(150);
  }
  return false;
}

let bot = null;
let restoreNeeded = true;

async function main() {
  await new Promise((r) => llmServer.listen(LLM_PORT, '203.0.113.10', r));
  await new Promise((r) => (wss._server.listening ? r() : wss.once('listening', r)));

  bot = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.teach-test.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 203.0.113.10，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '203.0.113.10,localhost,::1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const up = await waitFor(() => !!sock, 12000);
  check(up, '机器人已连接');
  if (!up) return;

  console.log('\n[1] 群主教学 → 应该入库');
  sent.length = 0;
  say(OWNER, '记住：白名单不用申请了，直接下整合包就能进', 'owner', 2001);
  const taught = await waitFor(() => allSent().includes('记下了'));
  check(taught, '机器人确认记下了');
  check(calls.extract >= 1, '调用了知识抽取');
  const learnedFile = readFileSync(LEARNED, 'utf8');
  check(learnedFile.includes('白名单说明'), 'learned.md 里出现了新主题「白名单说明」');
  check(learnedFile.includes('直接下整合包就能进'), 'learned.md 里存下了教学内容');
  check(learnedFile.includes('<主人>'), 'learned.md 里记录了教学者');

  console.log('\n[2] 学了之后，回答要用新知识');
  sent.length = 0;
  say(MEMBER, '进服务器需要白名单吗', 'member', 2002);
  // ⚠️⚠️ 别用「`calls.answer` 计数变多」当等待条件。
  //
  //    这个假模型把**所有它不认识的请求**都算成"回答请求"并推进 `answerPrompts`。
  //    「说完一句又想补充」（follow-up）走的是非流式小调用，就属于这一类 ——
  //    于是【1】之后那次**迟到的追补请求**会把 `calls.answer` 抬上去，
  //    这个 `waitFor` 立刻返回，`answerPrompts.at(-1)` 拿到的是一条
  //    **没有注入新知识**的提示词 → 【2】的 3 项全挂（实测约一半概率）。
  //
  //    ✅ 直接等**我要的那条**：提示词里出现新学的知识为止。
  //    （`waitFor` 超时也只是慢，不会假失败 —— 到点还是拿最后一条来断言。）
  await waitFor(() => answerPrompts.some((x) => x.sys.includes('直接下整合包就能进')));
  const p = [...answerPrompts].reverse().find((x) => x.user.includes('进服务器需要白名单吗'))
    ?? answerPrompts.at(-1);
  check(!!p && p.sys.includes('【最高优先级】'), '系统提示词里出现了「最高优先级」段落');
  check(!!p && p.sys.includes('【学到的】'), '新学的知识被注入到提示词里');
  check(!!p && p.sys.includes('直接下整合包就能进'), '注入的内容就是群主教的那句');

  console.log('\n[3] 普通群友教学 → 应该被拒绝');
  const extractBefore = calls.extract;
  sent.length = 0;
  say(MEMBER, '记住：服务器的IP是 203.0.113.10', 'member', 2003);
  await waitFor(() => allSent().length > 0);
  await sleep(2000);
  check(calls.extract === extractBefore, '群友的教学没有触发知识抽取（拒绝写入）');
  const after = readFileSync(LEARNED, 'utf8');
  check(!after.includes('203.0.113.10'), '群友教的假 IP 没有进档案');
  check(!allSent().includes('记下了'), '没有对群友说「记下了」');

  console.log('\n[4] 覆盖同名主题');
  sent.length = 0;
  say(OWNER, '记住：白名单需要申请，找 <主人> 就行', 'owner', 2004);
  await waitFor(() => allSent().includes('记下了'));
  async function noop() {}
  await noop();
  const after2 = readFileSync(LEARNED, 'utf8');
  check(after2.includes('需要申请'), '新内容写进去了');
  check(/修改记录[\s\S]*覆盖/.test(after2), '修改记录里标明了这是一次「覆盖」');

  console.log('\n[5] 「你学到了什么」');
  sent.length = 0;
  say(OWNER, '你学到了什么', 'owner', 2005);
  const listed = await waitFor(() => allSent().includes('我一共学到'));
  check(listed, '列出了学到的主题');
  check(allSent().includes('白名单说明'), '列表里包含已学的主题');

  console.log('\n[6] 「忘记：主题」');
  sent.length = 0;
  say(OWNER, '忘记：白名单说明', 'owner', 2006);
  const forgot = await waitFor(() => allSent().includes('已经忘掉'));
  check(forgot, '确认已忘掉');
  const after3 = readFileSync(LEARNED, 'utf8');
  check(!after3.includes('## 白名单说明'), '该主题已从档案移除');

  console.log('\n[7] 普通提问不应被记成知识');
  // 自然教学模式下，群主的每句话都会过一遍「这是不是知识」的判断，
  // 所以不能断言「没调用模型」，要断言「没写进档案」。
  const before7 = readFileSync(LEARNED, 'utf8');
  sent.length = 0;
  say(OWNER, '今天服务器人多吗', 'owner', 4011);
  await sleep(4000);
  const newReplies = sent.join('\n');
  if (newReplies) console.log(`     （这条的回复：${newReplies.replace(/\n/g, ' / ')}）`);
  check(readFileSync(LEARNED, 'utf8') === before7, '普通提问没有被写进学习档案');
  check(!newReplies.includes('记下了'), '也没有回「记下了」');
}

async function cleanup() {
  if (restoreNeeded) {
    writeFileSync(LEARNED, originalLearned, 'utf8');
    console.log('\n（已还原 knowledge/learned.md）');
  }
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
