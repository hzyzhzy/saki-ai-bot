// 给 SnowLuma 加"登录即摘"：UIN 不在白名单 ⇒ 立刻 unloadProcess(pid)
// 原版只在"注入前探测 UIN"这一步过滤，而实测探测常常拿不到
// （日志：一片「探测不到 UIN（QQ 可能刚起）⇒ 照常注入」）⇒ 主人自己的号也被注入。
// ⚠️ 本地自用补丁，不对外分发。
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const P = 'C:/SnowLuma/index.mjs';
const src = readFileSync(P, 'utf8');
if (src.includes('__wl__')) {
  console.log('已经打过这个补丁，跳过');
  process.exit(0);
}

const anchor = `		session.on("login", (uin, sender) => {
			this.invalidateAccounts();
			this.bridgeManager.onHookLogin(pid, uin, sender);
			this.notifySessionsChanged();
		});`;
if (!src.includes(anchor)) throw new Error('找不到 login 监听那段');

const patched = `		session.on("login", (uin, sender) => {
			/* ⚠️ 2026-11-27 本地补丁 __wl__：登录 UIN 不在白名单 ⇒ **立刻卸掉这个 pid 的钩子**。
			 *    原版只在"注入前探测 UIN"过滤，而实测探测经常拿不到（日志一片「探测不到 UIN ⇒ 照常注入」）
			 *    ⇒ 本机登录的号（含主人自己的）全被注入。改成"注进来之后一读到 UIN 就摘掉" ✓ */
			try {
				const _wl = readUinWhitelist();
				if (_wl.length && uin && !_wl.includes(String(uin))) {
					console.warn("[UIN白名单] %s 不在白名单（PID=%d）⇒ 卸载钩子，这个号不动", String(uin), pid);
					Promise.resolve(this.unloadProcess(pid)).catch((e) => {
						console.warn("[UIN白名单] 卸载失败：%s", (e && e.message) || e);
					});
					return;
				}
			} catch (e) {
				console.warn("[UIN白名单] 判断失败（按老行为继续注入）：%s", (e && e.message) || e);
			}
			this.invalidateAccounts();
			this.bridgeManager.onHookLogin(pid, uin, sender);
			this.notifySessionsChanged();
		});`;

copyFileSync(P, `${P}.bak-加登录即摘-${new Date().toISOString().replace(/[:.]/g, '-')}`);
writeFileSync(P, src.replace(anchor, patched), 'utf8');
console.log('已打补丁：登录即摘');
