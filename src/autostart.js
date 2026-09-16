/**
 * 开机自启动（Windows）。
 *
 * 干什么：往 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 写一个值，
 *         值是「隐藏跑 autostart.ps1」的命令；开机登录进桌面时由系统执行它。
 *         （autostart.ps1 会先等 OneDrive 同步完、等网络通，再启动并重试 3 轮，
 *           最后把控制权交给看门狗 —— 所以这里只管"注册"，不等、也不启动。）
 *
 * 为什么用注册表 Run 键，而不是往「启动」文件夹扔快捷方式：
 *   ① 读 / 写 / 删各一条 PowerShell 命令 —— 不用 COM 去建 .lnk、不用管理员权限
 *      （安装器是 `PrivilegesRequired=lowest`，能不弹 UAC 就不弹）
 *   ② **状态能判定**：值能读回来跟当前目录比对，所以分得清「没开」和
 *      「开过、但项目挪了位置，自启项还指着旧路径」—— 后者得提示用户重开一次
 *   ③ 任务管理器 →「启动」页里能看到这一项，用户想自己关掉也行
 *
 * ⚠️ 参数走**环境变量**传给 PowerShell，绝不拼进命令行：
 *    这个项目的路径长这样 `<本机用户目录>\OneDrive - yijia\文档\...`（空格 + 中文），
 *    拼命令行必然掉进 Windows 的引号地狱（这台机器上为类似的事踩过好几次）。
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ROOT } from './config.js';

/** 注册表位置（PowerShell 的 `HKCU:` 驱动器写法） */
const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** 注册表里的值名 —— 任务管理器「启动」页显示的就是它 */
const NAME = 'SakiBot';

/**
 * 查询：有就回值，没有回 `__NONE__`。
 *
 * ⚠️ 用 `Get-ItemProperty` 而不是 `Get-ItemPropertyValue` —— 后者要 PowerShell 5.0+，
 *    这个脚本要在**别人的机器**上跑，能兼容就兼容。
 * ⚠️ `$p.($env:SAKI_RUN_NAME)` 是"按变量名取属性"，这样值名不用拼进脚本里。
 */
const PS_GET =
  `$p = Get-ItemProperty -Path '${RUN_KEY}' -ErrorAction SilentlyContinue; ` +
  `if ($p -and ($p.PSObject.Properties.Name -contains $env:SAKI_RUN_NAME)) ` +
  `{ $p.($env:SAKI_RUN_NAME) } else { "__NONE__" }`;

/** 写入（键不存在就先建出来 —— 正常 Windows 上这个键一定在，但不赌） */
const PS_SET =
  `$k = '${RUN_KEY}'; ` +
  `if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }; ` +
  `Set-ItemProperty -Path $k -Name $env:SAKI_RUN_NAME -Value $env:SAKI_RUN_VALUE -Type String`;

/**
 * 删除（本来就没有也不算错）。
 *
 * ⚠️⚠️ 末尾那个 `exit 0` 不能省 —— 这是 2026-09-17 自测抓出来的：
 *    `Remove-ItemProperty` 在**属性不存在**时，即使加了 `-ErrorAction SilentlyContinue`，
 *    也会把 `$?` 置成 false，而 `powershell -Command` 的退出码跟着它走 →
 *    我这边就当成"命令失败"抛错 → **用户点「关闭」时如果本来就没开，会看到"失败"**。
 *    （而且错误信息是空的，因为错误被 SilentlyContinue 吃掉了，更难查。）
 */
const PS_DEL =
  `Remove-ItemProperty -Path '${RUN_KEY}' -Name $env:SAKI_RUN_NAME -ErrorAction SilentlyContinue; exit 0`;

/** 开机自启只在 Windows 上有 —— 别的系统上界面要如实说"不支持"，别假装成功 */
export const supported = process.platform === 'win32';

/** 给界面看的说明（一行） */
export const how = '写进注册表的启动项（任务管理器 →「启动」里叫 ' + NAME + '）';

/**
 * 值名。测试会用 `QQBOT_AUTOSTART_VALUE` 换一个名字，
 * 免得自检真的往**用户的开机自启**里写东西。
 */
export function valueName() {
  return process.env.QQBOT_AUTOSTART_VALUE || NAME;
}

/** 开机时要跑的那个隐藏启动脚本 */
export function launcherPath(root = ROOT) {
  return join(root, '_autostart-hidden.vbs');
}

/** 注册进注册表的完整命令行（写死 wscript，不用 cmd/powershell 起 —— 会闪黑框） */
export function runValue(root = ROOT) {
  return `wscript.exe //nologo "${launcherPath(root)}"`;
}

/** 跑一段 PowerShell，stdout 去掉尾部空白后返回；失败抛错 */
function ps(script, extraEnv = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error((r.stderr || '').trim() || `powershell 退出码 ${r.status}`);
  }
  return (r.stdout || '').trim();
}

/**
 * 当前状态。
 *
 * `enabled` = 自启项在，**而且**指向的就是这个目录；
 * `stale`   = 自启项在，但指向别处（项目搬过位置）—— 这种要提示用户关掉再开一次。
 */
export function status(root = ROOT) {
  const name = valueName();
  const launcher = launcherPath(root);
  const expect = runValue(root);
  const base = {
    ok: true,
    supported,
    valueName: name,
    launcher,
    launcherExists: existsSync(launcher),
    expect,
    how,
  };

  if (!supported) {
    return {
      ...base,
      enabled: false,
      stale: false,
      reason: `这个系统是 ${process.platform} —— 开机自启目前只在 Windows 上有`,
    };
  }

  let current;
  try {
    current = ps(PS_GET, { SAKI_RUN_NAME: name });
  } catch (e) {
    return { ...base, ok: false, enabled: false, stale: false, error: e.message, current: '' };
  }

  const none = !current || current === '__NONE__';
  const enabled = !none && current === expect;
  const stale = !none && current !== expect;
  return {
    ...base,
    enabled,
    stale,
    current: none ? '' : current,
    reason: enabled
      ? ''
      : stale
        ? '自启项指向的是另一个目录（项目搬过位置？）—— 点「关闭」再点「开启」就会指到当前目录'
        : '',
  };
}

/**
 * 开启（幂等：已经开着再点一次也不出错）。
 *
 * ⚠️ 写完**读回来核对**，不是"命令没报错就当成功" ——
 *    安全软件拦注册表写入、或者写到别的视图里，都可能让命令返回 0 但其实没生效。
 *    这个功能一旦"以为开了其实没开"，用户是**下次开机**才发现，代价太大。
 */
export function enable(root = ROOT) {
  if (!supported) throw new Error(`开机自启只在 Windows 上有（这个系统是 ${process.platform}）`);
  const launcher = launcherPath(root);
  if (!existsSync(launcher)) {
    throw new Error(`找不到自启脚本：${launcher}（安装包可能不完整）`);
  }
  ps(PS_SET, { SAKI_RUN_NAME: valueName(), SAKI_RUN_VALUE: runValue(root) });
  const st = status(root);
  if (!st.ok || !st.enabled) {
    throw new Error(
      st.error
        ? `写注册表之后读不回来：${st.error}`
        : '写进去了但读回来对不上（可能被安全软件拦了）',
    );
  }
  return st;
}

/** 关闭（幂等：本来就没开也不算错），同样删完要读回来确认真的没了 */
export function disable(root = ROOT) {
  if (!supported) throw new Error(`开机自启只在 Windows 上有（这个系统是 ${process.platform}）`);
  ps(PS_DEL, { SAKI_RUN_NAME: valueName() });
  const st = status(root);
  if (!st.ok) throw new Error(`删完之后读不回来：${st.error}`);
  if (st.enabled || st.stale) {
    throw new Error('启动项还在（可能被别的程序占着）—— 刷新一下看看，还在就重开一次管理界面再试');
  }
  return st;
}
