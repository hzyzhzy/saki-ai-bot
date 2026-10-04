/**
 * 「webui 那个码就没扫成功过 / 重新出码也一直不出」的回归（2026-09-15）。
 *
 * ## 两个真实原因
 *
 * **① 拿到的永远是过期快照。**
 *   界面原来只走 `napcat.getQrcode()` → NapCat 的 `GetQQLoginQrcode`，而它
 *   **根本不刷新**：
 *
 *   ```js
 *   tue = async (t, e) => {                  // GetQQLoginQrcode
 *     if (ve.getQQLoginStatus()) return ne(e, "QQ Is Logined");
 *     const n = ve.getQQLoginQrcodeURL();    // ← 只是读**缓存**的那个 URL
 *     return Hn(n) ? ne(e, "QRCode Get Error") : me(e, { qrcode: n });
 *   }
 *   ```
 *
 *   缓存是上一次 `onQRCodeGetPicture` 存的快照，**二维码几分钟就死** ——
 *   所以画出来的十有八九是一张死码。
 *   真正会重出的是 `POST /api/QQLogin/RefreshQRcode`。
 *
 * **② 「重新出码」走的是重启 NapCat。**
 *   那是**一次 QQ 登录**（风控信号）+ 等 20 秒，而且新实例还没生成码、
 *   界面就先去取了 → 「一直不出」。重出二维码是轻活，要用轻接口。
 *
 * （还有 ③ 显示层的坑：NapCat 的原图只有 147×147，界面却用
 *   `image-rendering:pixelated` 拉到 280px —— 最近邻放大把模块拉得宽窄不一，
 *   摄像头认不出来。这条只能在界面源码上盯。）
 *
 * ⚠️ 纯离线：假 NapCat 跑在随机端口，`QQBOT_CONFIG` 指到 `logs/`。
 *    **不碰真 NapCat、不碰真实 cache/qrcode.png**。
 *
 * ## ③ 2026-09-17 追加：NapCat 压根没跑的时候，那个按钮是个**死按钮**
 *
 *   用户报「**重启 NapCat 按钮还是没用，那两个窗口没动静**」。
 *   查明：`RestartNapCat` 是发给**正在运行的** NapCat 的请求，它没跑时必然 `ECONNREFUSED`
 *   （界面弹「重启失败: fetch failed」）—— 那个按钮**从来没有"启动 NapCat"的能力**，
 *   所以点多少遍都不会有窗口出来。现在先探端口：没跑 → `napcat.launch()`（走 launcher 开窗口）。
 *   顺带修了「NapCat 没跑还把 cache 里那张几小时前的死码发出去」。
 *
 * 用法: node test/qq-qrcode.js
 */
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-qqqr.yml';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

/** 记录假 NapCat 收到的请求路径，用来断言"走的是哪个接口" */
const hits = [];
let scenario = {};

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    hits.push(req.url);
    const send = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/api/auth/login') return send({ code: 0, data: { Credential: 'fake-cred' } });
    if (String(req.headers.authorization ?? '') !== 'Bearer fake-cred') {
      return send({ code: -1, message: 'unauthorized' });
    }
    if (req.url === '/api/QQLogin/CheckLoginStatus') {
      return send({
        code: 0,
        data: {
          isLogin: scenario.isLogin === true,
          isOffline: false,
          qrcodeurl: 'https://txz.qq.com/p?k=stale-cached-url',
          loginError: scenario.loginError ?? '',
        },
      });
    }
    if (req.url === '/api/QQLogin/GetQuickLoginList') return send({ code: 0, data: [] });
    if (req.url === '/api/QQLogin/RefreshQRcode') {
      return send(scenario.refreshReply ?? { code: 0, data: null, message: 'success' });
    }
    if (req.url === '/api/QQLogin/RestartNapCat') {
      return send({ code: 0, data: { message: '进程重启请求已发送' }, message: 'success' });
    }
    if (req.url === '/api/QQLogin/GetQQLoginQrcode') {
      return send({ code: 0, data: { qrcode: 'https://txz.qq.com/p?k=stale-cached-url' } });
    }
    return send({ code: -1, message: `unexpected: ${req.url}` });
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    'botQQ: "10000002"',
    'napcat:',
    '  enable: true',
    '  webuiHost: 127.0.0.1',
    `  webuiPort: ${PORT}`,
    '  webuiToken: "test-token"',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;

const napcat = await import('../src/napcat.js');

// ─────────────────────────────────────────────────────
console.log('\n【1】★ 重新出码走的是 `RefreshQRcode`，**绝不许重启 NapCat**');
{
  hits.length = 0;
  scenario = { loginError: '二维码已过期，请刷新' };
  const r = await napcat.refreshQrcode();
  check(r.ok === true, '调通', JSON.stringify(r));
  check(
    hits.some((u) => u === '/api/QQLogin/RefreshQRcode'),
    '★ 发了 RefreshQRcode（真正会重出二维码的那个接口）',
  );
  check(
    !hits.some((u) => u === '/api/QQLogin/RestartNapCat'),
    '★★ 没有碰 RestartNapCat —— 重出二维码不该是一次 QQ 登录',
  );
}

console.log('\n【2】★ 已登录时不许乱刷');
{
  hits.length = 0;
  scenario = { isLogin: true, refreshReply: { code: -1, message: 'QQ Is Logined' } };
  const r = await napcat.refreshQrcode();
  check(r.ok === false && /已经登录/.test(r.message), '已登录 → 明确说"不需要二维码"', JSON.stringify(r));
}

console.log('\n【3】`qrcodeFile()` 不炸、也不写盘');
{
  const f = napcat.qrcodeFile();
  check(f === null || (typeof f.path === 'string' && f.mtimeMs > 0), '返回 null 或 {path,mtimeMs,size}', JSON.stringify(f));
}

console.log('\n【4】★ 接线：界面和后端都必须带 `fresh=1` / 走轻接口');
{
  const js = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  const html = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');

  // 后端：出图时先重出
  const qrRoute = js.slice(js.indexOf("'GET /api/qq/qrcode.png'"), js.indexOf("'POST /api/qq/refresh-qr'"));
  check(/fresh=1/.test(qrRoute), '后端认 `?fresh=1`');
  check(/refreshQrcode\(\)/.test(qrRoute), '★ 后端在出图前会 `refreshQrcode()`');
  check(
    /过期\|刷新/.test(qrRoute),
    '★ NapCat 说「二维码已过期」时也会自动重出',
  );
  // ⚠️ 2026-09-20 改：这条原来匹配字面量 `napcat.qrcodeFile()`。换 LLBot 之后路由改成
  //    **按协议端分派**（`const qs = provider.name() === 'llonebot' ? llbot : napcat`），
  //    字面量就没了 → 套件误报失败（代码其实是对的）。
  //    断言的本意是「**优先用协议端自己写的那张原图**，而不是自己按 URL 画」——
  //    所以认 `qs.` / `napcat.` / `llbot.` 三种前缀。
  check(
    /(qs|napcat|llbot)\.qrcodeFile\(\)/.test(qrRoute),
    '优先用协议端写的那张原图（NapCat 的 qrcode.png / LLBot 的 login-qrcode.png）',
  );
  check(/width:\s*640/.test(qrRoute), '自己画时画大一点（640，不是 420）');
  check(/margin:\s*2/.test(qrRoute), '静区留 2 个模块（原来 1 太窄）');
  check(/'POST \/api\/qq\/refresh-qr'/.test(js), '新增了轻量出码接口 /api/qq/refresh-qr');

  // 前端：显式要新码 + 轻按钮
  check(/qrcode\.png\?fresh=1/.test(html), '★ 界面上点「显示二维码」时带 `fresh=1`');
  check(/function qqNewQr\(/.test(html), '新增了「重新出码」按钮的处理函数');
  check(/api\/qq\/refresh-qr/.test(html), '★ 那个按钮走轻接口，不是 /api/qq/restart');
  check(/id="btn-qq-newqr"/.test(html), '按钮挂上了');

  // 显示层的坑
  check(
    !/id="qq-qr-img"[\s\S]{0,300}?image-rendering:\s*pixelated/.test(html),
    '★★ 二维码 img **不再用 `image-rendering: pixelated`**（最近邻放大 147→280 会把模块拉坏）',
  );
  check(
    !/id="qq-qr-img"[\s\S]{0,300}?width:280px;height:280px/.test(html),
    '不再把图硬写成 280×280 拉大',
  );
}

console.log('\n【5】★ NapCat 没在跑时：「重启」必须变成「启动」（2026-09-17 用户报按钮没用）');
{
  // 端口探测得是真探，不能拍脑袋
  const up = await napcat.running({ webuiPort: PORT, onebotPort: 1 });
  check(up.webui === true, 'running() 看得出管理接口在听（假 NapCat）', JSON.stringify(up));
  const down = await napcat.running({ webuiPort: 1, onebotPort: 1 });
  check(
    down.webui === false && down.onebot === false,
    '★ 端口没在听 → running() 报「没在跑」（原来这一步不存在，所以点按钮只会弹 fetch failed）',
    JSON.stringify(down),
  );

  // 已经在跑的时候不许重复启动（假 NapCat 在跑 → 必须走 already 分支，不 spawn 任何东西）
  const l = await napcat.launch();
  check(l.ok === true && l.already === true, 'launch() 在已运行时直接返回，不重复启动', JSON.stringify(l));

  // 接线：后端在"没在跑"时必须走 launch
  const js = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  const route = js.slice(js.indexOf("'POST /api/qq/restart'"), js.indexOf("'POST /api/qq/launch'"));
  check(/napcat\.running\(\)/.test(route), '重启路由先看端口在不在听');
  check(/napcat\.launch\(\)/.test(route), '★★ 没在跑的时候走 `napcat.launch()`（把窗口启动起来）');
  // ⚠️ 2026-09-17 改：按钮文案不再写死「NapCat」—— 它现在按**协议端**分派
  //    （支持重启就说"重启协议端"，只支持启动就说"启动协议端"，都不支持就禁掉）。
  //    所以这里断言的是**新行为**，不是旧字面量。
  const html = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(
    /btn-qq-restart/.test(html) && /启动协议端/.test(html) && /canRestart/.test(html),
    '界面按钮跟着「状态 + 协议端能力」变（启动/重启协议端，不支持就禁掉）',
  );
  check(/id="qq-restart-hint"/.test(html), '状态卡里会说明当前协议端是什么、该去哪儿操作');
}

try {
  server.close();
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
