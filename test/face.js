/**
 * 表情包功能测试：
 *   1. 回复里的 [表情:xxx] 标记会被转成真正的图片段发出去
 *   2. 发给群友的文字里不残留标记
 *   3. 不存在的标签被忽略，不会崩
 *   4. 标记被流式分条切断时不会发出半个标记
 *
 * 用法: node test/face.js
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { facePath } from '../src/faces.js';
import { isStickerSeg, extractText } from '../src/message.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LLM_PORT = 39602;
const WS_PORT = 39601;
const TOKEN = 'face-token';
const BOT_QQ = '10000002';
const GROUP = '200000001';
const USER = '30003';

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假模型按问题返回不同的内容，用来验证各种情况
let reply = '';
const llmServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const user = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
    const sys = parsed.messages?.find((m) => m.role === 'system')?.content ?? '';

    // ⚠️ 「该不该说」判断请求（system 里含「假装成真人群友」）——
    //    它要的是 **JSON**，不是 SSE。必须放在**最前面**，
    //    否则会被下面「按 user 内容分派」的分支误伤成表情回复。
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
      res.end(
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: '{"speak":true,"why":"测试","length":"short"}' } },
          ],
        }),
      );
      return;
    }

    if (user.includes('崩溃')) reply = '行吧，又崩了。[表情:无语]';
    else if (user.includes('不存在')) reply = '试试这个 [表情:根本没有这张图] 看看';
    else if (user.includes('纯文本')) reply = '这条没有任何标记。';
    else if (user.includes('长文')) {
      // 故意让标记跨越 40 字的分条边界（config 里 maxChars=40）
      reply = '这是一段很长的回答，用来测试分条的时候标记会不会被切成两半，标记在中间[表情:欢呼]然后后面还有更多内容继续写下去。';
    } else reply = '好的。[表情:欢呼]';

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    // 一次只吐 1~2 个字符，最大化「标记被切开」的概率
    for (const ch of reply.match(/[\s\S]{1,2}/g) ?? []) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

const sent = []; // { text, images }
let sock = null;

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
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
      const segs = m.params?.message ?? [];
      const text = segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('');
      const imageSegs = segs.filter((s) => s.type === 'image');
      const images = imageSegs.map((s) => s.data.file);
      if (text.trim() || images.length) {
        sent.push({ text, images, imageData: imageSegs.map((s) => s.data) });
      }
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

function say(text, id = 1) {
  sock.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: id,
      group_id: GROUP,
      user_id: USER,
      self_id: BOT_QQ,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: USER, nickname: '测试', role: 'member' },
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
    await sleep(150);
  }
  return false;
}

const allText = () => sent.map((s) => s.text).join('\n');
const allImages = () => sent.flatMap((s) => s.images);

let bot = null;

async function main() {
  await new Promise((r) => llmServer.listen(LLM_PORT, '127.0.0.1', r));
  await new Promise((r) => (wss._server.listening ? r() : wss.once('listening', r)));

  bot = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.face-test.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 127.0.0.1，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  check(await waitFor(() => !!sock, 12000), '机器人已连接');
  if (!sock) return;

  // 每个测试段先清空对话（同时会重置表情频率闸门）—— 不然计数跨段累积
  // 会把后面的图挡掉（真实踩过：加了频率闸后 face.js 挂了 1 项）
  say('清空对话', 3099);
  await sleep(1500);

  console.log('\n[1] 带表情标记的回复 → 图片应该单独成一条');
  sent.length = 0;
  say('服务器崩溃了', 3001);
  await waitFor(() => sent.length > 0);
  await sleep(3000);

  // 关键：文字一条、图片一条，不能打包在同一条里
  const textOnly = sent.filter((s) => s.text.trim() && s.images.length === 0);
  const imgOnly = sent.filter((s) => s.images.length > 0 && !s.text.trim());
  const mixed = sent.filter((s) => s.images.length > 0 && s.text.trim());

  check(imgOnly.length === 1, `图片单独发了 1 条（实际 ${imgOnly.length} 条）`);
  check(mixed.length === 0, '没有任何一条把文字和图片打包在一起');
  check(textOnly.length >= 1, '文字是单独一条发的');

  // 图片用 base64 发（NapCat 对 file:// 支持不稳），所以校验方式变了：
  // 解码回来的内容必须和 face_wuyu 那张文件**逐字节相同**。
  const sentImg = imgOnly[0]?.images[0] ?? '';
  check(sentImg.startsWith('base64://'), '图片用 base64:// 发送（不用 file://）');

  // ⚠️ 2026-09-20 加：**发出去的表情必须是"表情"而不是"大图"** —— 靠图片段上的字段告诉协议端，
  //    而字段名各家不同（NapCat `sub_type` / LLBot 的 ob11 适配器 `subType`）→ **两个都要发**。
  //    真实踩过：换成 LLBot 后只发了 `sub_type`（以为它认），结果它读 `data.subType` 读到 undefined
  //    → `Number(undefined)||0` = 0 = 普通图片 → 用户连着两次反馈「表情包还是大图」。
  const d0 = imgOnly[0]?.imageData?.[0] ?? {};
  check(Number(d0.sub_type) === 1, '图片段带 sub_type: 1（NapCat 的口径）');
  check(Number(d0.subType) === 1, '图片段带 subType: 1（LLBot ob11 的口径，驼峰）');
  let imgOk = false;
  let imgNote = '';
  try {
    const got = Buffer.from(sentImg.replace(/^base64:\/\//, ''), 'base64');
    const want = readFileSync(facePath('无语'));
    imgOk = got.equals(want);
    imgNote = imgOk
      ? `${got.length} 字节，与 face_wuyu 逐字节一致`
      : `不一致（收到 ${got.length} 字节，期望 ${want.length}）`;
  } catch (e) {
    imgNote = `解码失败: ${e.message}`;
  }
  check(imgOk, `图片内容正确（${imgNote}）`);
  check(!allText().includes('[表情'), '文字里没有残留标记');

  say('清空对话', 3099);
  await sleep(1200);

  console.log('\n[2] 不存在的标签 → 忽略且不崩');
  sent.length = 0;
  say('试试不存在的标签', 3002);
  await waitFor(() => sent.length > 0);
  await sleep(2500);
  check(allImages().length === 0, '没有发出图片');
  check(!allText().includes('[表情'), '未知标记也被清掉了，不会原样发给群友');

  say('清空对话', 3099);
  await sleep(1200);

  console.log('\n[3] 纯文本 → 不发图');
  sent.length = 0;
  say('给我一段纯文本', 3003);
  // ⚠️⚠️ 等**这一条回复的文本**，不要等"有东西发出来了"（2026-09-15 修偶发失败）。
  //    踩过：`waitFor(() => sent.length > 0)` 会被**上一步迟到的回复**立刻满足，
  //    于是断言跑在真正那条回复之前，报「文本正常 ❌」——
  //    单独跑必过、并行跑偶发挂，白查很久。这就是 AGENTS.md trap ② 那个坑。
  const gotPlain = await waitFor(() => allText().includes('没有任何标记'));
  await sleep(2500);
  check(allImages().length === 0, '没有发图');
  // ⚠️⚠️ 2026-09-23：这条**实测偶发**（隔离后跑 4 次挂 1 次），而假模型是**确定性**的
  //    （见上面 `user.includes('纯文本')` 那条分支）、`waitFor` 又有 **20 秒** ——
  //    所以超时只可能是"**她压根没回**"，不是"回错了"也不是"排队慢"。
  //    ⇒ 把"她实际说了什么"打出来，下次红的时候才有线索（原来只有一行 ❌，什么也查不到）。
  check(
    gotPlain && allText().includes('没有任何标记'),
    '文本正常',
    `实际发出 ${allText().length} 条：${JSON.stringify(allText().slice(0, 3))}`,
  );

  say('清空对话', 3099);
  await sleep(1200);

  console.log('\n[4] 标记跨越分条边界 → 不能发出半个标记');
  sent.length = 0;
  say('来段长文', 3004);
  await waitFor(() => sent.length > 0);
  await sleep(4000);
  const t = allText();
  // 关键：不能出现 "[表情" 这种半截东西
  check(!/\[表情/.test(t), '没有半个标记泄漏到文字里');
  check(!/\[表$|\[$/.test(t.trim()), '没有以半个标记结尾');
  // ⚠️⚠️ 2026-09-20 改：原来是 `>= 1`（**太松，放过了重复**）。
  //    用户截图报「**一次发了两个一模一样的表情包**」，真身是流式分条那里
  //    拿 `sentText.length`（**清洗后**的长度）去切原文 buffer → 尾巴被当成新一段又发一遍。
  //    这段原文里**只有 1 个** `[表情:欢呼]` 标记，所以**发出的图必须正好 1 张**；
  //    多一张就是那个 bug 回来了。
  check(allImages().length === 1, `分条后发出了 1 张图（实际 ${allImages().length} 张）`);
  console.log(`     （分了 ${sent.length} 条发送）`);

  // ⚠️ 2026-09-20 加 [5]：**接收侧**认不认得出表情包 —— 字段名各协议端不一样。
  //    真实踩过（换 LLBot 之后）：只认下划线 `sub_type` → 群友发的表情包被判成"普通图片"，
  //    于是 ① 提示词里 `[表情包]` 变成 `[图片]`（她以为对方在晒截图，一本正经地捧场）
  //        ② 表情收集器一张都收不到 ③ 识图缓存会去描述表情包，白花 token。
  console.log('\n[5] 表情包判定：各协议端的字段名都要认');
  const seg = (data) => ({ type: 'image', data });
  check(isStickerSeg(seg({ sub_type: 1 })), 'NapCat 口径 sub_type:1 → 是表情');
  check(isStickerSeg(seg({ subType: 1 })), 'LLBot ob11 口径 subType:1（驼峰）→ 是表情');
  check(isStickerSeg(seg({ sub_type: 'sticker' })), "字符串 'sticker'（LLBot 私有 API 口径）→ 是表情");
  check(!isStickerSeg(seg({ sub_type: 0 })), 'sub_type:0 → 不是表情');
  check(!isStickerSeg(seg({ subType: 0 })), 'subType:0 → 不是表情');
  check(!isStickerSeg(seg({})), '没有类型字段 → 不是表情');
  check(extractText([seg({ subType: 1 })]) === '[表情包]', 'LLBot 口径的表情包在提示词里显示成 [表情包]');
  check(extractText([seg({ sub_type: 0 })]) === '[图片]', '普通图片在提示词里显示成 [图片]');
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

