/**
 * QQ 协议端适配层（2026-09-17 加 —— 用户要求「能换协议端」）。
 *
 * ## 为什么要有这么一层
 *   机器人**只通过 OneBot 11 协议**跟协议端说话：
 *     · 「收消息 / 发消息 / 调 action」→ **跟协议端完全无关**（换谁都是 `ws://` + token）
 *     · 「登录状态 / 出二维码 / 重启协议端」→ **各家不一样**，有的压根没有
 *   所以这里把"管理面"抽象成一组能力，谁支持谁不支持写清楚，
 *   换协议端 = 改 `config.yml` 的 `provider.*`，**代码不用动**。
 *
 * ## 各家现状（2026-09-17 核实）
 *   | 协议端 | 类型 | 许可 | 管理面 |
 *   | --- | --- | --- | --- |
 *   | NapCat | 注入官方 QQ 客户端 | 自定义：**禁商用** | 有自己的 WebUI + HTTP 接口（我们能代点） |
 *   | LLBot | **独立应用**（Desktop/CLI/Docker） | GPL-2.0：可商用，**分发**要带源码 | 有自己的 WebUI/GUI |
 *   | 通用 OneBot 实现 | 看实现 | 看实现 | 通常没有 |
 *
 * ## 怎么换（写给用的人）
 *   ```yaml
 *   provider:
 *     name: llonebot                 # napcat | llonebot | onebot
 *     dir: D:\LLBot                  # 启动/守护脚本要用（可选）
 *     launcher: LLBot.exe            # 相对 dir 或绝对路径（可选）
 *     manageUrl: http://127.0.0.1:3080   # 它自己的管理界面（只用于在界面上给你个链接）
 *   ```
 *   ⚠️ **收发那部分不用改**：`onebot.url` + `onebot.accessToken` 保持指向新协议端的 WS 服务端即可。
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { config, ROOT } from './config.js';

/**
 * 能力表。
 * ⚠️ 这里 **false 就是真的不支持** —— 界面和接口会明确说"不支持、请去它自己的界面"，
 *    绝不假装成功（假装成功比报错更坑人）。
 */
const REGISTRY = {
  napcat: {
    label: 'NapCat',
    defaultDir: () => join(ROOT, '..', 'napcat', 'NapCat.Shell'),
    defaultLauncher: 'launcher-win10-user.bat',
    defaultManageUrl: () => `http://${config.napcat?.webuiHost ?? '127.0.0.1'}:${config.napcat?.webuiPort ?? 6099}`,
    caps: {
      status: true, // 看登录状态（走 NapCat 的 HTTP 接口）
      qrcode: true, // 出二维码
      refreshQr: true, // 重新出码（不重启进程）
      restart: true, // 重启协议端
      quickLogin: true, // 免扫码快速登录
      autoRecover: true, // 「一键恢复登录」那套
      launch: true, // 从机器人这边把协议端拉起来
    },
    how: '登录/出码/重启都能在这个管理界面里点（我们代你调 NapCat 的接口）',
    license: '⚠️ 自定义许可：**禁止商用**；再分发要附许可全文并标明来源',
  },
  llonebot: {
    label: 'LLBot（Lucky Lillia Bot）',
    defaultDir: () => '',
    defaultLauncher: '',
    defaultManageUrl: () => '',
    caps: {
      status: false, // 侧信道未知：它没有 NapCat 那套接口；登录状态请看 OneBot 侧（下面那张卡片）
      qrcode: false,
      refreshQr: false,
      restart: false,
      quickLogin: false,
      autoRecover: false,
      launch: true,
    },
    how: 'LLBot 是**独立应用**（Desktop / CLI / Docker）：扫码登录、重连、看码都在它自己的 WebUI/GUI 里做',
    license: '✅ GPL-2.0：允许商用；但**分发**它（打包进你的安装包、或给客户私有化交付）时必须一并提供源码',
  },
  onebot: {
    label: '通用 OneBot 11 实现',
    defaultDir: () => '',
    defaultLauncher: '',
    defaultManageUrl: () => '',
    caps: {
      status: false,
      qrcode: false,
      refreshQr: false,
      restart: false,
      quickLogin: false,
      autoRecover: false,
      launch: true,
    },
    how: '通用实现没有统一的管理接口：登录/重连请用它自己的方式；机器人这边只负责收发消息',
    license: '看具体实现自己的许可（自建的话自己说了算）',
  },
};

/** 当前协议端名字（已归一化：不认识的名字会退回 `onebot`） */
export function name() {
  return config.provider?.name ?? 'napcat';
}

/** 当前协议端的注册表项（永远有值：认不出就退回通用） */
export function def() {
  return REGISTRY[name()] ?? REGISTRY.onebot;
}

/** 协议端目录（配置优先；没配就用该协议端的默认值）。解析不出就是空串。 */
export function dir() {
  const cfgDir = String(config.provider?.dir ?? '').trim();
  if (cfgDir) return cfgDir;
  try {
    return def().defaultDir() || '';
  } catch {
    return '';
  }
}

/** 启动脚本/可执行的**绝对路径**（配置的 launcher 相对 `dir` 解析）。解析不出就是空串。 */
export function launcherPath() {
  const l = String(config.provider?.launcher ?? '').trim() || def().defaultLauncher || '';
  if (!l) return '';
  if (isAbsolute(l)) return l;
  const d = dir();
  return d ? join(d, l) : '';
}

/** 启动方式在不在（文件真的存在才算） */
export function canLaunch() {
  const p = launcherPath();
  return !!p && existsSync(p);
}

/** 它自己的管理界面地址（配置优先） */
export function manageUrl() {
  const u = String(config.provider?.manageUrl ?? '').trim();
  if (u) return u;
  try {
    return def().defaultManageUrl() || '';
  } catch {
    return '';
  }
}

/**
 * 这个协议端支持某个能力吗？
 * ⚠️ `launch` 要**文件真的存在**才算支持 —— 否则界面会显示一个点了没用的按钮。
 */
export function can(cap) {
  if (cap === 'launch') return canLaunch();
  return def().caps?.[cap] === true;
}

/** 某能力不支持时给用户看的话（明确指出"去哪儿做"） */
export function unsupported(cap) {
  const d = def();
  const where = manageUrl() ? `去它自己的管理界面：${manageUrl()}` : '去它自己的管理界面';
  const what = {
    qrcode: '出二维码',
    refreshQr: '重新出码',
    restart: '重启协议端',
    quickLogin: '免扫码快速登录',
    autoRecover: '一键恢复登录',
    status: '查协议端侧的登录状态',
    launch: '从这边启动协议端',
  }[cap] ?? '这个操作';
  if (cap === 'launch' && !launcherPath()) {
    return `当前协议端是 ${d.label}，还没配启动方式 —— 在 config.yml 里填 provider.dir / provider.launcher，或自己把它启动起来`;
  }
  return `当前协议端是 ${d.label}，它没有统一的「${what}」接口 —— ${where}（${d.how}）`;
}

/** 给管理界面看的整块信息（界面据此决定按钮能不能点） */
export function info() {
  const d = def();
  return {
    name: name(),
    label: d.label,
    dir: dir(),
    launcher: launcherPath(),
    launcherExists: canLaunch(),
    manageUrl: manageUrl(),
    caps: { ...(d.caps ?? {}) },
    how: d.how,
    license: d.license,
    // 收发那部分跟协议端无关，这里一并带出来，方便界面显示"连的是哪个地址"
    onebot: {
      mode: config.onebot?.mode ?? 'forward',
      url: config.onebot?.url ?? '',
      tokenSet: !!String(config.onebot?.accessToken ?? '').trim(),
    },
  };
}

/** 是不是 NapCat（有些 NapCat 专属逻辑要判这个，比如假在线自愈） */
export function isNapcat() {
  return name() === 'napcat';
}

export const NAMES = Object.keys(REGISTRY);
