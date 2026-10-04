/**
 * 「套话句式」二次改写的回归（2026-10-04 加）。
 *
 * ## 为什么要盯这个
 *   用户原话：「在剧情和事件里 saki **转述的话**里，有大量的『我们谁也没XX』，**要转换一下**」
 *   → 拍板走「**生成后过一次模型改写**」（不是改提示词）。
 *
 *   ⚠️ 这是一次**真模型调用**（虽然便宜），所以两条同样重要：
 *     ① **命中才调用** —— 不命中还去调，等于每条事件白花钱；
 *     ② **任何异常都退回原文** —— 它改的是「她今天真发生过的事」，
 *        改坏了 / 改短了 / 超时了，都必须还能原样发出去（宁可留着套话）。
 *
 * ⚠️ 纯离线：假 LLM 起在本进程（127.0.0.1:39090），不碰真模型、不花钱。
 * ⚠️ 必须**单独一个进程 + 自己的配置**：`config.js` 在**启动时**读 `QQBOT_CONFIG`，
 *    而静态 `import` 会被提升到最前面 ⇒ 那时 env 还没设，就会读到**真实的 config.yml**
 *    ⇒ 拿真 key 去调真模型。所以下面全部用 `await import()`（见文件末尾那几行）。
 * 用法: node test/rewrite.js
 */
import { createServer } from 'node:http';

process.env.QQBOT_CONFIG = 'config.rewrite-test.yml';
process.env.QQBOT_SPEND_FILE = 'logs/__test-rewrite-spend.json';
process.env.QQBOT_SPEND_BASE = 'logs/__test-rewrite-spendbase.json';
// ⚠️⚠️ **必须显式打开**（2026-10-04 踩了）：`run-all.js` 给**所有**套件注入
//    `QQBOT_REWRITE=off`（免得回归里真去调模型），而本套件正是要测这个改写 ——
//    不写这一行的话，**单独跑全绿、一进回归就红**（【3】全变成"没调用、用原文"）。
//    ⚠️ 别依赖"外面没设就是开" —— 那个假设只在手跑时成立。
process.env.QQBOT_REWRITE = 'on';

const PORT = 39090;
let calls = 0;
let reply = '';
const prompts = [];

const server = createServer((req, res) => {
  const __bodyChunks = [];
  req.on('data', (d) => __bodyChunks.push(d));
  req.on('end', () => {
    // ⚠️ 2026-10-06：**必须先把分片收成 Buffer 再一次性按 UTF-8 解码**。
    //    写成 `body += c`（c 是 Buffer）会让**每个 TCP 分片各自解码** ——
    //    中文正好跨分片时那个字就烂成 ��，断言里 includes 中文就永远匹配不上，
    //    表现为**偶发假失败**（真凶抓到过一次：「在吗，��个事」）。
    const body = Buffer.concat(__bodyChunks).toString('utf8');
    calls++;
    let j = {};
    try {
      j = JSON.parse(body);
    } catch {}
    prompts.push((j.messages ?? []).map((m) => String(m.content)).join('\n---\n'));
    // ⚠️ `phrase()` 走的是 `res.json()`（**非流式**）——
    //    这里回 SSE 会让它解析不出内容（这个项目因为"假模型回错格式"踩过四次，见 AGENTS）
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
  });
});

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const { naturalize, looksCliched } = await import('../src/rewrite.js');

// ── 判据 ────────────────────────────────────────────────────
console.log('\n【1】判据：哪句算"有套话"');
for (const t of [
  '我们谁也没喊谁',
  '远远看见立希在马路对面，我们谁也没喊谁。',
  '最后谁都没先出门',
  '碰上素世，谁都没停，就这么走过去了',
  '两个人谁也没让谁',
  '谁也没去', // ⚠️ 短句**也要改**（第一版按"少于 10 字不改"把它挡在外面了，是这条抓出来的）
]) {
  check(looksCliched(t), `命中：${t}`);
}
for (const t of ['我懂了', '', '今天排练到很晚，回来路上买了瓶水', '素世跟我点了个头', '他们聊得挺开心']) {
  check(!looksCliched(t), `不命中：${t || '(空)'}`);
}

// ── 不命中 ⇒ 一次都不花 ─────────────────────────────────────
console.log('\n【2】不命中 → 一次调用都不许发');
calls = 0;
reply = '（这句话不该被用到）';
{
  const src = '今天排练到很晚，回来路上买了瓶水';
  const out = await naturalize(src);
  check(out === src, '原样返回', out);
  check(calls === 0, '调用次数 = 0', `实际 ${calls}`);
}

// ── 命中 ⇒ 调一次、用改写的 ─────────────────────────────────
console.log('\n【3】命中 → 调一次，并用改写后的文本');
calls = 0;
prompts.length = 0;
const SRC = '下了车走两步，远远看见立希在马路对面，我们谁也没喊谁。';
reply = '下了车走两步，远远看见立希在马路对面，我们都没出声。';
{
  const out = await naturalize(SRC, { where: '测试' });
  check(out === reply, '用改写后的文本', out);
  check(calls === 1, '只调一次', `实际 ${calls}`);
  check(prompts.at(-1).includes(SRC), '提示词里带了原文');
  check(prompts.at(-1).includes('事实一个字都不许改'), '提示词里带了"不许改事实"的铁律');
  // ⚠️ 这条是**真实验收抓出来的**：第一版提示词的示例里自己写着
  //    「谁也没说话 → 谁都没开口」—— 等于教模型"换个动词接着用『谁也没』"。
  check(prompts.at(-1).includes('不许再出现'), '提示词要求改完不许再出现「谁也没」');
}

// ── 失败兜底 ────────────────────────────────────────────────
console.log('\n【4】出问题一律退回原文（事件不能因此发不出去）');
calls = 0;
reply = '';
check((await naturalize(SRC)) === SRC, '假模型返回空 → 用原文');

reply = '好的。';
check((await naturalize(SRC)) === SRC, '改写结果太短（< 一半）→ 用原文');

reply = SRC + SRC + SRC;
check((await naturalize(SRC)) === SRC, '改写结果太长（> 两倍）→ 用原文');

// ── 开关 ────────────────────────────────────────────────────
console.log('\n【5】开关（QQBOT_REWRITE=off → 完全不调用）');
process.env.QQBOT_REWRITE = 'off';
calls = 0;
reply = '改过的句子，长度差不多够长了吧。';
{
  const out = await naturalize(SRC);
  check(out === SRC, '关掉后原样返回', out);
  check(calls === 0, '关掉后一次都不调用', `实际 ${calls}`);
}
process.env.QQBOT_REWRITE = 'on';

// ── 边界 ────────────────────────────────────────────────────
console.log('\n【6】边界：空输入 / 非字符串不许抛错');
calls = 0;
for (const v of ['', '   ', null, undefined, 123]) {
  let ok = true;
  let got = '（抛错了）';
  try {
    got = JSON.stringify(await naturalize(v));
  } catch (e) {
    ok = false;
    got = e.message;
  }
  check(ok, `安全处理：${JSON.stringify(v)}`, got);
}
check(calls === 0, '空输入不发调用', `实际 ${calls}`);

server.close();
console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures ? 1 : 0);
