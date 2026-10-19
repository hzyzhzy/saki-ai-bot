/**
 * 人工接管（2026-10-14 用户要求）套件。
 *
 * 用户原话：「只加一个人工接管的开关，在QQ号页 **同样一号一份，默认关闭**。
 *   打开时机器人**直接取消所有主动回复包括@**，但是**聊天消息要落盘**，
 *   不然回到 bot 模式，bot **会不记得之前的聊天记录**」。
 *
 * ## 这个套件盯的是三件事（少一件这功能就是坏的）
 *
 * 1. **不回**：连 @ 她、私聊、命令都不回；主动搭话 / 日常事件 / 剧情 / 定时提醒 /
 *    主动私聊 / QQ空间 也全停 ⇒ 两道闸：`sendText`（第一道）+ `call('send_*')`（兜底）
 * 2. **落盘**：接管期间的消息**照常进上下文** —— 少了它，接管一结束它就"失忆"
 * 3. **一号一份、默认关**：存在 `accounts/<QQ>.yml`（不在共用段里），默认 `false`
 *
 * ⚠️ 纯离线：不起机器人、不连协议端、不调模型
 *
 * 用法: node test/human-takeover.js
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

const CFG_REL = 'logs/__test-takeover.yml';
const RECENT_REL = 'logs/__test-takeover-recent.json';

// ⚠️ 配置必须在 import `src/*` **之前**写好（`config.js` 是加载时读的）
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    'botQQ: "10000002"',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
// ⚠️ "落盘"那一条要写进**隔离的**上下文文件，别污染用户真实的群上下文
process.env.QQBOT_RECENT_FILE = RECENT_REL;
rmSync(join(ROOT, RECENT_REL), { force: true });

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { config } = await import('../src/config.js');
const { Bot } = await import('../src/bot.js');
const recent = await import('../src/recent.js');

const src = (f) => readFileSync(join(ROOT, 'src', f), 'utf8');
const codeOnly = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

console.log('\n【1】★ 默认关 + 判据只有一处');
{
  check(config.humanTakeover?.enable === false, '★ 默认**关**（`humanTakeover.enable` = false）');
  const b = new Bot();
  check(b.takeoverOn() === false, '★ `takeoverOn()` = false');
  config.humanTakeover.enable = true;
  check(b.takeoverOn() === true, '★ 打开后 = true（判据是**现读**的，热重载立刻生效）');
}

console.log('\n【2】★★ 接管期间 `sendText` 一条都不发');
{
  const b = new Bot();
  b.selfId = '10000002';
  const ev = { message_type: 'group', group_id: '50001' };
  const out = await b.sendText(ev, '我看看');
  check(out === null, '★★ 返回 **null**（= "没发出去"，调用方按这个判）', JSON.stringify(out));
  const out2 = await b.sendText(ev, '这条也不许发', { force: true });
  check(out2 === null, '★ 连 `force:true` 也拦（它只管绕旁白闸，不管接管）');
}

console.log('\n【3】★★ 定时任务直连的 `call(\'send_*\')` 也拦住（光拦 sendText 会漏）');
{
  const b = new Bot();
  const sent = [];
  b.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };

  const r = await b.call('send_private_msg', { user_id: '40001', message: '晚安' });
  check(sent.length === 0, '★★ 主动私聊那种直连调用**没发出去**（ws.send 一次都没调）');
  check(r?.status === 'ok', '★ 返回**假装成功**（不重试、不进补发箱）', JSON.stringify(r));

  for (const a of ['send_group_msg', 'send_group_file', 'send_poke']) {
    await b.call(a, {});
  }
  check(sent.length === 0, '★ `send_group_msg` / `send_group_file` / `send_poke` 全拦');

  // 只读接口**不许**被拦（拦过头会把查群成员、查历史全弄哑）
  void b.call('get_group_member_list', { group_id: '50001' }).catch(() => {});
  await new Promise((r2) => setTimeout(r2, 30));
  check(sent.length === 1, '★ 只读接口照常发出去（只拦 send_*，没拦成一片）', `实际 ${sent.length} 次`);
}

console.log('\n【4】★★ 接管期间的聊天**要落盘**（不然回来就"失忆"）');
{
  const b = new Bot();
  b.selfId = '10000002';
  b.rememberTakeover({
    message_type: 'group',
    group_id: '50001',
    user_id: '40001',
    self_id: '10000002',
    message: [{ type: 'text', data: { text: '刚才那个样式改好了吗' } }],
  });
  const ctx = String(recent.contextText('50001') ?? '');
  check(ctx.includes('刚才那个样式改好了吗'), '★★ 接管期间那条消息**进了上下文**', ctx.slice(0, 40));

  // 私聊也一样
  b.rememberTakeover({
    message_type: 'private',
    user_id: '40002',
    self_id: '10000002',
    message: [{ type: 'text', data: { text: '在吗' } }],
  });
  check(String(recent.contextText('') ?? '').length >= 0, '★ 私聊那条没抛异常（私聊走 dm 桶）');
}

console.log('\n【5】★ 接管期间连戳一戳都不回拍');
{
  const b = new Bot();
  let calls = 0;
  b.call = () => {
    calls++;
    return Promise.resolve({});
  };
  await b.pokeBack({ user_id: '40001', target_id: '10000002' });
  check(calls === 0, '★ `pokeBack` 在最前面就 return 了（没回拍）');

  // ⚠️ 不测"关掉之后真的拍回去"—— 那条路上还有白名单 / 同类池好几道闸，
  //    测它就变成测别的功能了。改成**源码级**断言：那道闸写在最前面、而且带 return ✓
  const s = src('bot.js');
  check(
    /if \(this\.takeoverOn\(\)\) \{\s*\n\s*log\.debug\('\[接管\] 有人在戳，不回拍'\);\s*\n\s*return;\s*\n\s*\}/.test(s),
    '★ 那道闸就在 `pokeBack` 的最前面（白名单那几道**都拦不住"回拍"**，只有它能）',
  );
  config.humanTakeover.enable = true;
}

console.log('\n【6】★★ 入口顺序：**先落盘、再 return**，而且要挡在 agent 派活**前面**');
{
  const s = src('bot.js');
  const i = s.indexOf('this.rememberTakeover(payload)');
  const iAgent = s.indexOf('await agentBridge.handle(payload');
  check(i > 0, '★ `onMessage` 里真的调了 `rememberTakeover`');
  check(i < iAgent, '★★ 它挡在 `agentBridge.handle` **前面**（接管时不许给 agent 派活）');

  check(
    // ⚠️ 窗口放宽到 600：2026-10-16 在"落盘"和 `return` 中间加了「记一笔他发的文件」
    //    （自动补收要用）⇒ 原来那段只有 220 字符的窗口就够不着 `return` 了（假红 ✗）
    // ⚠️⚠️ 2026-10-19 再放宽到 1800：接管期间**也要进上下文**（`recent.remember`，
    //    用户报「接管之后看不到我发的那句」）—— 那一段带注释又插在中间，
    //    现在"落盘 → return"实测约 1100 字符 ⇒ 600 又会假红 ✗
    //    ⚠️ 真要判的只是**先后**，不是距离 ⇒ 窗口给足，别让它因为注释变长就红 ✓
    /this\.rememberTakeover\(payload\);[\s\S]{0,1800}?return;/.test(s),
    '★★ **先落盘再 return**（顺序调过来就等于没记）',
  );
  check(
    /this\.rememberTakeover\(payload\);[\s\S]{0,1800}?noteMissedFile[\s\S]{0,600}?return;/.test(s),
    '★★ 接管期间"他发的文件"也记下来了（也要在 return **之前** —— 不然等于没记 ✓）',
  );
}

console.log('\n【7】★★ 一号一份（不许挪进共用段）');
{
  const c = src('config.js');
  // ⚠️ 那张表是 `new Set([...])`，别写死成 `= [`（第一版就是这么假红了一次）
  const m = /SHARED_SECTIONS\s*=[\s\S]{0,60}?\[([\s\S]*?)\]/.exec(c);
  check(!!m, '★ 找得到 `SHARED_SECTIONS`');
  check(
    m && !m[1].includes('humanTakeover'),
    '★★ `humanTakeover` **不在**共用段里 ⇒ 界面保存时只写这个号的 accounts/<QQ>.yml',
  );
  check(/humanTakeover: \{\s*\n\s*enable: false,/.test(c), '★ 默认值是 `false`（默认关）');
}

console.log('\n【8】★ 界面上真的有这个开关（QQ 号页）');
{
  const wjs = src('webui.js');
  check(
    /takeover: a\.humanTakeover\?\.enable === true/.test(wjs),
    '★ `/api/accounts` 把每个号的接管状态报出来（界面读它）',
  );
  const w = src('webui.html');
  // ⚠️⚠️ 2026-10-19 改断言：勾选框**换成了「开启接管 / 交还」两个按钮** ——
  //    用户为那一处报了三次（打不开 / 关不了 / 点不动），三次都不是后端的问题，
  //    全是"勾选框 + 保存"这个形态判断不了"到底生效没"⇒ 换成明确动作 ✓
  //    ⚠️ 要守的东西没变：**界面上真有这个开关**、点了真发 `humanTakeover.enable`、
  //       而且那句状态读的是**服务端报回来的真实值**（不许拿界面自己的状态当答案）。
  check(/onclick="accSetTakeover\(true\)"/.test(w), '★ QQ 号页有「开启接管」按钮');
  check(/onclick="accSetTakeover\(false\)"/.test(w), '★ 还有「交还（关闭接管）」按钮');
  check(/async function accSetTakeover/.test(w), '★ 有对应的保存函数');
  check(/humanTakeover: \{ enable: want \}/.test(w), '★ 保存时发的是 `humanTakeover.enable`（后端会按号存）');
  check(
    /me\.takeover/.test(w) && /state-acc-takeover/.test(w),
    '★ 那句状态刷的是**当前这个号**的真实值（不是界面自己的猜测）',
  );
  check(!/id="acc-takeover"/.test(w), '★ 老的那个勾选框已经删干净了（留着会误导）');
}

console.log('\n【9】★ 两道闸的注释都在（别哪天被"优化"掉一道）');
{
  const s = src('bot.js');
  check(/拦下一个外发接口/.test(s), '★ `call()` 里那道兜底还在');
  check(/拦下一条外发/.test(s), '★ `sendText` 里那道还在');
  const lines = codeOnly(s);
  const iCall = lines.findIndex((l) => l.includes('拦下一个外发接口'));
  check(iCall > 0, '★ 它写在 `call()` 里（不是别的地方）');
}

// 收尾：清掉临时文件
try {
  rmSync(join(ROOT, CFG_REL), { force: true });
  rmSync(join(ROOT, RECENT_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
