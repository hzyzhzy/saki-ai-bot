/**
 * 开机自启的回归（2026-09-17 加）。
 *
 * ## 为什么要盯这个
 *   「开机自启」和别的功能不一样：**它是唯一一个会去动用户系统设置的功能**
 *   （写 `HKCU\...\Run` 注册表）。所以最怕的是三件事：
 *     ① 开了之后**其实没写进去**（用户以为开了，开机啥也没发生）；
 *     ② 项目换了目录、自启项还指着旧路径 —— 界面却显示"已开启"；
 *     ③ 关不掉（注册表里留一个删不掉的启动项）。
 *   这个套件就是盯这三条，外加"重复开/关不许报错"（用户连点两下很正常）。
 *
 * ## ⚠️ 它真的会写注册表（但只写一个测试专用的名字）
 *   值名走 `QQBOT_AUTOSTART_VALUE=SakiBotSelfTest` —— **绝不碰用户真实的 `SakiBot` 那一项**。
 *   结尾有 `finally` 清理。万一这个套件被强杀、留了残留，手动删一次：
 *     `Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name SakiBotSelfTest`
 *
 * ⚠️ 纯离线：不联网、不启动任何东西、不碰真 QQ。
 * 用法: node test/autostart.js
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as autostart from '../src/autostart.js';

// ⚠️ 必须在**调用**之前设 —— `autostart.valueName()` 是每次调用时读环境变量的
//    （不是模块加载时读死，所以放在 import 之后也来得及）
const NAME = 'SakiBotSelfTest';
process.env.QQBOT_AUTOSTART_VALUE = NAME;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

console.log('\n【1】环境');
if (!autostart.supported) {
  console.log(`  ⏭️ 这个系统是 ${process.platform}，开机自启只在 Windows 上有 —— 跳过`);
  process.exit(0);
}
check(autostart.supported, '当前系统支持开机自启', process.platform);
check(existsSync(join(ROOT, '_autostart-hidden.vbs')), '_autostart-hidden.vbs 在（没它就只能弹黑框）');
check(autostart.valueName() === NAME, '用的是测试专用值名，不会碰用户真正的启动项', autostart.valueName());

try {
  console.log('\n【2】先清干净 → 应该是"未开启"');
  autostart.disable();
  let st = autostart.status();
  check(st.ok, 'status() 读得到');
  check(st.enabled === false, '清干净后 enabled=false');
  check(st.stale === false, '清干净后 stale=false');

  console.log('\n【3】开启');
  st = autostart.enable();
  check(st.enabled === true, '开启后 enabled=true');
  check(String(st.current).includes('_autostart-hidden.vbs'), '注册的值指向隐藏启动脚本');
  check(String(st.current).includes(ROOT), '指向的正是当前项目目录');
  check(/^wscript\.exe /i.test(String(st.current)), '用 wscript 起（不是 cmd/powershell —— 那样开机要闪黑框）');

  console.log('\n【4】读回来对得上（不是只在内存里）');
  st = autostart.status();
  check(st.enabled === true, '重新读注册表仍然是开的');
  check(st.stale === false, 'stale=false（指向本目录）');

  console.log('\n【5】重复开启不许报错（用户连点两下很正常）');
  st = autostart.enable();
  check(st.enabled === true, '再开一次：不报错，状态还是开的');

  console.log('\n【6】项目换位置 → 要认得出"指向别的目录"');
  // 纯逻辑判定：拿一个别的目录去比对，注册表不动
  st = autostart.status(join(ROOT, 'napcat'));
  check(st.stale === true, 'stale=true（认得出自启项指着别处）');
  check(st.enabled === false, 'stale 时 enabled=false（不能让用户以为开机起得来）');
  check(String(st.reason).length > 0, 'reason 里有给人看的解释', JSON.stringify(st.reason).slice(0, 40));

  console.log('\n【7】关闭');
  st = autostart.disable();
  check(st.enabled === false, '关闭后 enabled=false');
  check(!st.current, '注册表里这个值已经没了', `current=${JSON.stringify(st.current)}`);
  st = autostart.disable();
  check(st.enabled === false, '再关一次也不报错（幂等）');

  console.log('\n【8】纯函数（不碰注册表）');
  check(
    autostart.launcherPath('C:\\x').endsWith('_autostart-hidden.vbs'),
    'launcherPath 拼得对',
    autostart.launcherPath('C:\\x'),
  );
  check(
    autostart.runValue('C:\\x y').includes('"C:\\x y\\_autostart-hidden.vbs"'),
    'runValue 给路径加了引号（路径里有空格也不会断）',
  );
} finally {
  // 不管上面哪一步抛了，都要把测试用的启动项删掉
  try {
    autostart.disable();
  } catch (e) {
    console.log(`  ⚠️ 清理失败，可能要手动删：${e.message}`);
  }
}

// ⚠️ 这个收尾格式不是随便写的 —— `test/run-all.js` 靠**最后一条 `结果: …`** 判断套件过没过
//    （`[...out.matchAll(/结果:\s*(.+)/g)].pop()`）。
//    我第一版写成「✅ autostart 套件：0 项失败」，单独跑 21 项全绿，
//    但进回归却显示「（无结果行）」→ 被算成失败。别改这个格式。
console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures ? 1 : 0);
