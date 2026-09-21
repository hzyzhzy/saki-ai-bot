# 安装器（一键安装包）

给最终用户用的：**一个 `saki-setup.exe`，双击 → 填几项 → 装完就能跑**。
用户不需要装 Node、不需要 clone 仓库、不需要手写 YAML。

## 怎么构建

```powershell
cd qq-ai-bot

# ① 打包「要装进去的内容」（从**公开副本**拷，顺带内嵌 node.exe 和 npm 依赖）
node installer\build-payload.cjs --refresh     # --refresh = 先重跑 tools/make-public.cjs

# ② 用 Inno Setup 编译（本机已装：%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe）
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" installer\saki-bot.iss

# 产物：installer\dist\saki-setup-1.0.0.exe（约 50 MB）
```

静默安装（自测用）：

```powershell
installer\dist\saki-setup-1.0.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART `
  /DIR="$env:TEMP\saki-test" /LOG="$env:TEMP\saki.log"
```

## 装完是什么样

```
%LOCALAPPDATA%\SakiBot\
├─ node\node.exe          内嵌运行时（用户不用装 Node）
├─ node_modules\          npm 依赖（ws / undici / js-yaml / qrcode / sharp）
├─ src\ tools\ test\ library\ knowledge\
├─ config.yml             向导里填的内容生成的（token 自动随机）
├─ 安装信息.txt             ⚠️ 协议端要用的 token + 上手步骤（按你选的协议端生成）
├─ THIRD-PARTY-NOTICES.md  第三方许可声明（Node=MIT；NapCat / SnowLuma 都没打包）
├─ build-info.txt          这一版是用哪次提交打的
└─ napcat\                 留给用户放 NapCat.Shell（安装包**不含** NapCat）
```

## 协议端怎么选（2026-09-21 加）

向导第 2 页选协议端，**默认 SnowLuma**。三家**都没有打包**进安装包，区别只在
"安装器能替你做到哪一步"：

| 选择 | 安装器做什么 | 会自动下载吗 |
| --- | --- | --- |
| **snowluma（默认）** | 只把 `config.yml` 的 `provider.name` 写对；弹一次许可说明；给官方下载页链接 | ❌ **不行** —— 它的 EULA 5.4 明确要求事先书面授权才能"并入第三方安装包"或"通过自动化脚本部署"（**跟地址公不公开无关**）。所以它需要用户自己去 [官方 Release](https://github.com/SnowLuma/SnowLuma/releases) 下载并装好 |
| NapCat | 从官方 Release 下载 → 校验 SHA256 → 解压 → 写 `onebot11_<QQ>.json` | ✅ |
| LLBot | 只写配置（它自己的登录/启动在它的 GUI 里） | ❌ |

⚠️ 选非 NapCat 时，"NapCat 怎么来"那一页会**整页跳过**（`ShouldSkipPage`）。

## 这个目录里有什么

| 文件 | 作用 |
| --- | --- |
| `build-payload.cjs` | 从公开副本生成 `build/payload/`，再补上 node.exe + 依赖 + 许可声明 |
| `saki-bot.iss` | Inno Setup 脚本（向导页、快捷方式、安装后调配置脚本） |
| `languages/ChineseSimplified.isl` | 中文界面语言文件（Inno 官方**不带**中文，从 [issrc 仓库](https://github.com/jrsoftware/issrc/blob/main/Files/Languages/ChineseSimplified.isl) 取的） |
| `build/`、`dist/` | 生成物，**已 gitignore**（135MB / 50MB，别提交） |

配置逻辑本身不在这里 —— 在 `tools/first-run-setup.mjs`（安装器和手动装的人都用它）。

## 踩过的坑（别重复踩）

1. **静默安装卡死**：`NextButtonClick` 里的 `MsgBox` 在 `/VERYSILENT` 下照样会弹，
   而 `/SUPPRESSMSGBOXES` **只抑制 Inno 自己的消息框**。→ 必须用 `WizardSilent()` 先判。
2. **漏了 npm 依赖**：第一版 payload 没带 `node_modules`，装完一启动就
   `ERR_MODULE_NOT_FOUND: 'ws'`。→ 现在 `build-payload.cjs` 里有**依赖齐全断言**，缺了直接退出。
3. **`copyTree` 的跳过清单会伤到自己**：`node_modules` 在跳过清单里，复用它拷依赖会「拷 0 个文件却不报错」。
   → 拷依赖时必须传 `useSkip = false`。
4. **`.iss` 必须存成 UTF-8 带 BOM**，否则中文变乱码。
5. **`tools/first-run-setup.mjs` 要能处理带 BOM 的 JSON**（记事本/PowerShell 写的答案文件常带 BOM）。
6. **⚠️ PowerShell 里别对 `ISCC.exe` 用 `| Select-Object -First N`**：
   取够 N 行会**掐断上游进程**，ISCC 被编译到一半杀掉 → 留下一个**体积偏小一半的坏 exe**
   （表现：运行它 1.5 秒退出码 1、**连日志文件都不生成**）。
   正确做法：`& $iscc ... > out.txt 2>&1`，然后再读 `out.txt` 的尾部。
   （同理别对任何"输出很多"的原生命令这么干。）
7. **`--proxy` 要同时作用于 API 查询和下载**：第一版只给下载加了代理，
   API 查询还是直连 → 国内网络下明明传了 `--proxy` 依然 `fetch failed`。
   现在还会**自动探测本机常见代理端口**（7890/7897/10809/1080/10808），用户不用自己填。

## 还没做（下一步）

- **LLBot 的自动下载**（它也是官方 Release，GPL-2.0 可以分发，但**分发时要带源码**，
  所以只做"从官方地址下载"、不镜像）。
- 代码签名（否则杀软误报率会很高）。
- 自动更新（比对 GitHub Release 的版本号）。

## 已做

- **NapCat 自动下载 + 自动配置**：勾选后从官方 Release 直链下载 → 校验 SHA256 → 解压到
  `<安装目录>\napcat\NapCat.Shell\` → 自动写 `onebot11_<QQ>.json`（端口/token）。
  ⚠️ 下载前必须把 NapCat 的许可弹给用户确认；**不镜像、不打包**（它是 Limited
  Redistribution License：再分发要附许可全文 + 标来源 + 不得商用）。
- **协议端选择页**（2026-09-21）：默认 SnowLuma；SnowLuma 只写配置、**不下载也不部署**
  （EULA 5.4），见上面那张表。
