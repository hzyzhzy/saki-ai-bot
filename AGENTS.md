# 操作规程（AGENTS 必读）

> 这份文件是给**改动这个机器人的人（包括 AI 助手）**看的操作约束。
> 每次动完机器人要交付给用户测试之前，先照这里做。

📌 **跨天待办记在 `TODO.md`** —— 有「等用户拍板」「等条件成熟」的事就写那儿，别只记在对话里。

---

## ⚠️ 闲聊不许进任何知识库 / 记忆（2026-09-17 用户定）

> 用户原话：「我先加个规定，**这些闲聊在压缩上下文时直接删掉，因为对工作没用**。」

- **闲聊**（跟服务器、跟祥子本人、跟"这机器人在干什么"**都无关**的聊天 ——
  比如「我会不会 cos 张雪峰」「今天天气怎么样」）**一律不要**写进：
  `knowledge/owner.md`、`knowledge/group-memory.md`、故事线、任何 `state/*` 记录。
- 已经被写进去的 → **压缩 / 整理的时候直接删**，不用犹豫：它们只占提示词，对回答没用。
- ⚠️ **例外（这些不是闲聊，别误删）**：
  - 用户对机器人的**要求 / 偏好 / 规则**（哪怕是从一句玩笑里带出来的）；
  - 他和祥子之间的**相处事实**；
  - 群里的**大事**、以及**能体现某个群友性格**的观察。
- ⚠️ 一句话判断标准：**「这条以后能让她的回答更准 / 更像吗？」** 不能 → 删。

---

## 🗣️ 一律说中文（**连思考过程也是**）—— 2026-09-17 用户定

**用户原话**：「你又说英语或者思考时输出英语了，我看英语的速度没那么快。」

规则写在**全局那份**里（`<DSH 用户目录>\.dsh\AGENTS.md`，
对所有会话生效）：**正文 + 思考过程都中文**；命令、代码、路径、报错原文、`git`/`API` 这类
没中文译名的技术词照旧；但**整句英文和中英混排不许有**。

---

## ⚠️ 一晚改多件没问题，但要「一件一闭合 + 交清单」（2026-09-17 用户定）

**用户原话**：「一晚塞太多改动和一天塞得我感觉应该没区别吧，因为改动不是一步搞完的，
多在凌晨搞是因为是 api 谷价，便宜」。

**结论：风险不在「一晚上做了几件」，在「一件没闭合就去做下一件」。** 所以：

1. **粒度 = 一件完整的功能**（不是一行，也不是一晚上的全部）：
   改完 → 跑相关套件 → **重启一次** → 告诉用户可以测。
   ⚠️ 这条和「铁律②」是一件事的两面：铁律② 要求"别攒到最后才重启"，
   这里要求"别改一行就重启" —— **粒度落在"一件功能"上，两边都满足**。
2. **同一分钟内绝不重启第二次**（那是 QQ 登录风控，跟改了多少无关，只跟我的粒度有关）。
3. **一轮多改，最后必须交一张清单** —— 在真实群里验收的只有用户一个人，
   一次丢 8 件给他、炸了他没法判断是哪件：

   | 改了什么 | 怎么验 | 出事退哪一步 |
   | --- | --- | --- |

4. **每件都要单独可退**：动配置文件/数据文件之前先留备份
   （`logs/*.bak-*`、`state/*.备份-*`），改动尽量分文件、别几件事搅在一处。

**关于谷价**：凌晨是 DeepSeek 的优惠时段。所以**机器人自己跑钱的那些批量活**
（表情打标、知识库抽取、`test/ask-private.js` / `ask-attitude.js` 真实模型验收）
优先安排在优惠时段跑 —— 但改代码本身花的是用户这边的额度，跟谷价无关，
**别拿"谷价便宜"当理由去多刷重启/多刷真实模型验收**。

❌ **别做的事**：为了"一晚多塞几件"跳过测试，或者把几件事混进一次没测的改动里 ——
那样出问题没法归因，等于白做（2026-09-17 我一次改动把 `src/life.js` 写坏过，就是这个教训）。

---

## 🧹 知识库 / 文档的「合并同类项」：定期做，但**先列清单等他拍板**（2026-09-17 用户定）

**用户原话**：

> 「对，**每隔一段时间就合并同类项**，但是要**大概告诉我合什么再做决定**，
>   然后要**提醒我**」

**为什么需要**：每修一个毛病，就往人设 / AGENTS 里加一段规则 —— **总长一直在涨**，
而"太长会漏规则"恰恰是最该防的事。**这两件事是互相拉扯的**。
实测：2026-09-17 一天之内 `persona.md` 从 **31.5K 涨到 35K**
（其中「一、说话的方式」那一节从 10.4K 涨到 **12.7K**），`TODO.md` 更是堆到 **218 KB**。

### 三步，顺序不能变

1. **定期检查** —— 每闭合几件功能顺手看一眼，或者发现某个文件在明显膨胀时；
2. **先给清单，再动手** —— 列清"打算合并/删掉哪些、大概省多少"，**等他点头**。
   ⚠️ **不许自己判断"这段过时了"就删** —— 这些规矩都是他一条条纠过来的，
   删错了他才发现（而且他不会记得自己说过什么）；
3. **主动提醒他** —— 他明确要求「要提醒我」。**别等他问。**

**清单就这么短**（三行以内，别写成报告）：

| 合什么 | 大概省 | 依据 |
| --- | --- | --- |

### ⚠️ 判断"能合"的两条标准

- **代码层已经兜住的** → 人设里可以缩成一句话。
  （例：破折号 —— `bot.js` 会把 `——` 换成逗号**并在那里分条**，
  人设里那 40 行例子其实不必留，留一句"别用，代码会替你处理"就够。）
- **同一件事在多处说过** → 合并到一处，其余地方留一句指路。

### ⚠️ 不能动的（别当成"重复"删掉）

- **铁律在 persona 开头 + 结尾各一份是故意的** —— 那是防"中段迷失"
  （长上下文里中间最容易被漏），**不是重复**；
- 用户明确说过的偏好，以及案例里**他的原话**。

---

## 📦 安装器（一键安装包）—— 2026-09-17 起

用户的目标：**让用户几乎零成本部署** → 一个 `saki-setup.exe`，双击填几项就装完。

- 源码在 `installer/`（**live 目录里维护；源码是公开的** —— 导出时只跳过
  `build/` / `dist/` / `vendor/` 三个产物目录，否则 135MB 的 payload 和 50MB 的 exe
  会被推上公开仓库）。⚠️ 这句原来写成"整个 installer 不进公开副本"，与代码不符，09-17 改正。详见 `installer/README.md`。
- 构建两步：`node installer/build-payload.cjs --refresh` → `ISCC.exe installer\saki-bot.iss`。
- 产物 `installer/dist/saki-setup-1.0.0.exe`（约 **50 MB**，< 蓝奏云 100MB 限制）。
- 配置逻辑在 `tools/first-run-setup.mjs`（**这个要进公开副本**，手动装的人也能用）。

⚠️ 三个已经踩过的坑（别重复踩）：

| 坑 | 症状 | 规矩 |
| --- | --- | --- |
| Inno 的 `MsgBox` 在静默安装下照样弹 | `/VERYSILENT` 装到一半挂死 | 弹框前必须 `if WizardSilent() then Exit;` |
| payload 漏了 `node_modules` | 装完启动 `ERR_MODULE_NOT_FOUND: 'ws'` | 打包脚本里有**依赖齐全断言**；改依赖后要重跑 |
| 改完 payload 没做端到端验证 | 以为好了，其实跑不起来 | **每次都要：静默装到临时目录 → 用它内嵌的 node 启动一次**（用死端口，别抢真 NapCat 的连接） |

---

## 🗂️ 代码有本地 git 了（2026-09-17 建）

**为什么建**：用户问「出事退哪一步」，我一查 —— live 这个目录**没有 `.git`**，
代码改坏了只能靠我手动改回，或者去 `qq-ai-bot-public/` 那份拿（**滞后 + 脱敏**的副本，指望不上）。

现状：`qq-ai-bot/.git`，**纯本地、没有 remote**，初始提交 `ebb14ff`，189 个文件
（`src/` `test/` `tools/` 启动脚本 `*.md` `package*.json`）。

**`.gitignore` 排除的东西（别用 `-f` 绕过）**：

| 排除 | 为什么 |
| --- | --- |
| ~~`config*.yml`~~ **2026-09-23 起不再排除** | 用户要求进版本库（配置改坏了要有退路）。⚠️ 它含 API key / token ⇒ **更不许加 remote**。 |
| `personas/` **同上，不再排除** | 同理：人设改动要有退路。公开副本走 `tools/make-public.cjs`，它自己排除 personas |
| `state/`、`logs/`、`library/` | 运行期数据、图片，来回变，进版本库没意义 |
| `knowledge/` | `owner.md` / `group-memory.md` / `groups/` 有**用户和群友的真实信息** |
| `manual/`、二维码/凭据临时文件（`.napcat-jwt`、`qrcode.txt`、`*-qrcode.png`） | 二进制 / 一次性的东西 |

⚠️⚠️ **永远不要给它加 remote、也不要 push** —— 这个目录里带着用户的真实资料。
要公开的那份走 `tools/make-public.cjs`（它自己会脱敏）。

**怎么用**（退回去就靠这几条）：

```powershell
cd '<项目目录>\qq-ai-bot'
git status --short            # 我改了哪些文件
git diff src/bot.js           # 具体改了哪几行
git log --oneline -10         # 最近十次
git checkout -- src/webui.js  # 把某一个文件退回上次提交（⚠️ 会丢当前改动）
git revert <sha>              # 整次提交退回去（留记录，比 reset 安全）
```

**规矩**：

1. **每闭合一件功能就 commit 一次** —— 和上面「一件一重启」**同一个粒度**，
   message 用中文写「改了什么 + 为什么」（这样 `git log` 就是一份改动台账）。
2. 交付清单里那条「出事退哪一步」，以后直接写 commit 号 / 文件名。
3. ⚠️ `.gitattributes` 里钉了 `*.bat` `*.ps1` `*.vbs` **`eol=crlf`** ——
   别再手工转行尾了，git 会保证检出来就是 CRLF。

---

## 🌐 这机器上 **GitHub 必须走代理**（2026-09-17 实测）

- `hosts` 里 `github.com` / `api.github.com` / `raw.githubusercontent.com` / `github.io`
  等一大串指向了 `127.0.0.1` —— **用户说这大概率是代理软件（Clash）自己写进去的**，
  所以**代理非正常退出时，那些条目和系统代理会留下** →
  表现就是「代理明明关了/挂了，GitHub 反而还是连不上」。
  遇到这种情况：**先看系统代理和 hosts，而不是怀疑 GitHub 或 git**。
- Clash 在跑时（`127.0.0.1:7890` 在听）这样推：

```powershell
cd '<项目目录>\qq-ai-bot-public'
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push -u origin main
```

- ⚠️ **不要写进 `git config --global`** —— 代理一关，之后所有 git 操作都会卡死。
  用 `-c` 一次性传（或者只写进这一个仓库的 local config）。
- 查 GitHub API 也一样：`Invoke-RestMethod ... -Proxy http://127.0.0.1:7890`。
- ⚠️ 我这边 `git push` 报 **exit code 1 但其实是成功** —— PowerShell 会把 git 写到
  stderr 的进度行当成错误记录。**看 `main -> main` 那行**，别只看退出码。
- 公开副本远端：`https://github.com/hzyzhzy/saki-ai-bot`（**只有公开副本能推**；
  live 那份（`qq-ai-bot/`）**永远不加 remote**）。

### 🚦 推之前先给用户过一眼「推哪些 / 排除哪些」（2026-09-17 用户定）

每次 `push` / 删文件**之前**，先列一小段（三行以内）等他点头：

| 推 / 删什么 | 排除什么 | 为什么 |
| --- | --- | --- |

⚠️ **别因为"我很确定"就跳过**。`owner.md`、群号、群名、`LICENSE` 这四个问题都是这么抓出来的
（尤其 `LICENSE` —— 它是公开副本独有的、由用户维护的文件，导出工具差点把它删掉）。

### ⚠️⚠️ **commit message 也要脱敏**（2026-10-05 用户抓到的）

用户截图问：「**readme 有还隐私信息没脱敏**」—— 一查，问题不在 README，而在**一条 commit 的正文**里
写着 **`10000010`**（群里另一个机器人的真实 QQ 号），而**公开仓库上这条 message 是能看到的**。

⚠️ **`tools/make-public.cjs` 的 `scrub()` 只管「文件内容」，管不到 commit message** ——
它替换的是导出后的源码/配置/文档，**git 历史里的信息它一个字都碰不到**。
（脱敏表里**早就有**这个号，见 `make-public.cjs` 的 `['10000010', '10000010']` —— 照样漏。）

**规矩**：

- 🚫 **commit message 里不写真实 QQ 号 / 群号 / 域名 / 路径** —— 一律用占位符：
  `999000001`（群）、`10000001`（人）、`203.0.113.10`（TEST-NET-3 的 IP）、`example.com`。
- ⚠️ **公开副本尤其要紧**：live 仓库的 message 只在你本机，公开副本的**全世界都看得到**。
- ⚠️ 想说明"是哪个号的问题"就写**特征**：「群体里另一个机器人那个号」「同类池里那个号」——
  反正代码和配置里有，git 里不必有。
- 🔁 **改历史要用户点头**：已经推上去的 message 想清掉，只能改写历史 + `--force`，
  那会让群友的 `git pull` 直接冲突 ⇒ **先问，别自己动**。
  （2026-10-05 那次就是：规矩定在"以后不再写"，没有改写历史。）

### 📣 阶段做完要**主动提醒用户推**（2026-09-17 用户定）

**用户原话**：「以后阶段性成果之后再提醒我推」。

- 粒度：**一个阶段 = 一轮改动都做完了、回归绿了、机器人能跑起来**（不是每个文件）。
- 到了这个点，我**主动说一句**：「这批算一个阶段了，要推吗？」+ 附上面那张三行清单。
- ⚠️ 反向也要守：**别在阶段中间反复问**（改一个文件就问一次 = 噪音）。
- ⚠️ 例外：**隐私/安全隐患类**的修复**立刻推**，不等阶段。

---

## 🔌 协议端适配层（2026-09-17 加，用户要求「能换协议端」）

**为什么**：NapCat 的许可**禁止商用**，而用户的机器人只是通过 OneBot 协议跟它说话 ——
不该被某一家协议端绑死。所以把"管理面"抽象出来，换协议端 = **改 `config.yml`**。

- 代码：`src/provider.js`（能力表 + 目录/启动器解析）、`config.provider.*`。
- **收发那部分完全通用**（`onebot.url` + token），跟协议端无关 —— 这是设计底线。
- 管理能力按协议端分派，**不支持就明确说"不支持"**（`provider.unsupported(cap)`），
  **绝不假装成功**：`webui.js` 的 qrcode / refresh-qr / restart / launch / recover 路由都先问 `provider.can()`。
- `napcat-recover.js`（假在线自愈）**只在 provider = napcat 时**才写重启条子，免得误导看门狗。
- 支持的协议端：

| name | 是什么 | 管理能力 | 许可 |
| --- | --- | --- | --- |
| `napcat`（默认） | 注入官方 QQ 客户端 | 全开（出码/重启/快速登录/启动） | ⚠️ **禁止商用** |
| `llonebot` | LLBot，**独立应用**（Desktop/CLI/Docker） | 只能"启动"（如果配了 launcher）；出码/登录去它自己的 WebUI | GPL-2.0：可商用，**分发**要带源码 |
| `onebot` | 任何通用 OneBot 11 实现 | 只保证收发 | 看具体实现 |

⚠️ 名字写错会**退回 `onebot`**（不让机器人挂掉），原值留在 `provider.nameRaw` 里便于排查。
⚠️ `src/provider.js` 只读 `provider.*`，**不碰 `onebot.*`** —— 回归套件 `test/provider.js` 专门盯这条。

---

## 🖥️ 开机自启（2026-09-17 加，用户要求「界面上能设自启动」）

**用户在管理界面点开关就行，不用再去翻 `shell:startup`。**

- 逻辑：`src/autostart.js` —— 写注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，
  值名 **`SakiBot`**，值 = `wscript.exe //nologo "<ROOT>\_autostart-hidden.vbs"`。
- 那个 vbs **隐藏**跑 `autostart.ps1`（等 OneDrive 同步 → 等网络 → 重试 3 轮 → 转看门狗）。
  ⚠️ 别改成用 `cmd` / `powershell` 直接起 —— 开机会闪一个黑框，用户为这个抱怨过（见 `_run-bot-hidden.vbs`）。
- 界面：「状态」页 →「开机自启」卡片；接口 `GET/POST /api/autostart`。

**三条设计上的讲究（别改）**：

| 讲究 | 为什么 |
| --- | --- |
| 参数走**环境变量**传给 PowerShell，绝不拼命令行 | 这个项目的路径里有空格 + 中文（放在 OneDrive 里），拼命令行必掉进引号地狱 |
| `status()` 把 **enabled / stale 分开** | "开着但指着旧路径"（项目搬过位置）**不能**显示成"已开启"，否则用户以为开机起得来 |
| 开关都**写完读回来核对** | 这功能一旦"以为开了其实没开"，用户是**下次开机**才发现，代价太大 |

**⚠️ 三个已经踩过的坑**：

1. **`Remove-ItemProperty` 在属性不存在时，会让 `powershell -Command` 的退出码变成 1** ——
   即使加了 `-ErrorAction SilentlyContinue`。表现：用户点「关闭」时如果本来就没开，会看到"失败"，
   而且错误信息是**空的**（被 SilentlyContinue 吃掉了），更难查。解法：那条命令末尾补 `exit 0`。
   （**是 `test/autostart.js` 抓出来的** —— 所以那个套件里"重复关闭不报错"这条别删。）
2. **套件收尾必须是 `结果: 全部通过 ✅`** —— `run-all.js` 靠正则 `结果:\s*(.+)` 抓**最后一条**。
   我第一版写成「✅ autostart 套件：0 项失败」，单独跑 21 项全绿，进回归却显示「（无结果行）」→ 被判失败。
3. **测试绝不许碰用户真实的启动项** —— 值名走 `QQBOT_AUTOSTART_VALUE`（自检用 `SakiBotSelfTest`），
   并且 `finally` 里一定要 `disable()`。别图省事在测试里用真值名。

---

## 铁律②：改完就启动，别等测试跑完

**用户明确要求（2026-09-11）**：「每次你改完测试之前就要启动机器人方便我测试」

所以流程是：

```
改代码/人设 → **立刻重启机器人** → 然后才跑测试 → 告诉用户可以测了
```

**不要**攒一堆改动、跑完回归、再启动 —— 那样用户要等很久才能试。
**尤其**：改了人设（persona.md）或知识库之后**必须重启**，因为那些是启动时读进内存的，
不重启用户测到的还是旧版本，会以为你没改对。

### ⚠️ 但别「改一行就重启」（用户 2026-09-11 反馈：「确实次数太多了」）

我一轮里为调试重启了十几次，结果踩出两个真 bug：

| 踩的坑 | 后果 |
| --- | --- |
| `digest.lastPosts`（已发说说记录）只在内存 | 重启就忘 → 同一个梗**连发三遍到 QQ 空间** |
| `qzone.today.count`（今日已发条数）只在内存 | 重启就归零 → 同一天可能**超发** |

两个都已落盘修好（`state/*.json`）。但**原则要记住**：

1. **能热重载的不要重启**（改完界面点保存即可，不用重启）：
   - 知识库（persona / 服务器库 / 群记忆 / anime）
   - 表情库 · `config.yml`
2. **纯代码改动才重启** —— 而且**一个功能改完再重启**，别改一行重启一次。
3. **新加内存状态时先问：「重启会不会出问题」** ——
   会就落盘。参考 `src/digest.js` / `src/qzone.js`，
   都是原子写（写 `.tmp` 再 `renameSync`）。
4. **重启前想一下**：这次会不会让它忘掉什么、或者重做什么？
   （典型：刚发过说说、刚提醒过用户、冷却计时中）
5. ⚠️ **两次重启别 1 分钟内背靠背** —— 见下面「重启就是一次登录」。
   （⚠️ 2026-09-30 起**不再强制 5 分钟**：协议端换成 SnowLuma 后稳定得多。）

### ⚠️⚠️ **别为了重启而干等**（2026-09-18 用户定）

**用户原话**：「不要等时间重启，在这一段时间**我不能打断你，我说不了话**，
你**直接在下一次重启**就行了」。

⚠️ 背景：当时那条「两次重启之间至少隔 5 分钟」是真的（重启 = 一次 QQ 登录，
这个号是风险设备）—— ⚠️ **2026-09-30 已放宽，见下面那节**。但这一节的道理不变：
我当时为了守它，写过好几次 `Start-Sleep -Seconds 250` 再重启 ——
**那 4 分钟里用户被我晾着**：这一轮我占着，他想改主意、想让我先干别的，**都插不进来**。

**所以**：

- ✅ **别 sleep 凑时间**。改动**攒着**，等下一次因为别的原因（新功能、真需要重启的改动）
  要重启时**顺手带上** —— 那些改动会在那一次一起生效。
- ✅ 真要马上验，**先问一句**（「这条要重启才生效，现在方便吗？」），他点头就重启。
- ⚠️ 例外：如果**已经在等**别的长任务（跑回归、编译 exe），那段时间本来就在跑 ——
  把重启排在它之后是合理的；**但别为了凑那 5 分钟专门 sleep**。
- ⚠️ 一句话判断：**这段时间里用户是不是"插不进来话"？** 是 → 就不该等。

### ⚠️ 重启就是一次登录（**2026-09-30 放宽：不再强制 5 分钟**）

> **用户原话（2026-09-30）**：「现在**不用那么严格遵守了**，**snowluma 的稳定性高很多**」。
>
> 这条规矩是 **2026-09-14 为 NapCat 立的** —— 那时协议端是注入式、走的是 QQ 官方客户端，
> 这个号还被标记成"风险设备"、几小时就掉一次线，所以短时间内的**会话更迭**是最敏感的风控特征。
> 现在协议端换成 **SnowLuma**，实测登录态稳定得多 ⇒ **"隔 5 分钟"降级成"能攒就攒"的建议**。
>
> ⚠️ **仍然保留的硬下限：别在 1 分钟内背靠背重启** ——
> 那是真正的"会话秒级更迭"，跟"几分钟里改了两次"不是一回事。
>
> ⚠️ **哪天换回 NapCat（或别的注入式协议端），这条要恢复成 5 分钟** ——
> 放宽的依据是 **SnowLuma 的稳定性**，不是"风控不存在了"。

**2026-09-14 查证的**：一次"重启机器人" = **一次新的 QQ 登录会话**，
而**这个号被 QQ 安全中心标记过"风险设备"**（收到过外挂类处罚通知）——
短时间内的会话更迭是风控最敏感的特征。
（当时实测过 45 秒内重启 3 次；⚠️ 也**别把掉线都算成重启害的**，
那个号那阵子本来就是每几小时掉一次。）⇒ **别 1 分钟内背靠背**就够了。

**规矩**：

- 改完**攒一次**再重启，别为了跑个临时脚本又重启一遍
- 需要"测真实模型"就跑**离线/假模型**的套件 —— 那类**不需要重启**（也不碰真 NapCat）
- **能攒就攒**（几件改动一起重启更省事），但**不再强制**"中间隔 5 分钟以上" ——
  2026-09-30 放宽；**唯一硬下限是别 1 分钟内背靠背**
- 重启完先看日志确认 `已登录 QQ`，再往下做别的

#### ✅ 正确顺序（2026-09-15 晚起用这个）

> ⚠️⚠️ **第 0 步（2026-09-15 晚我自己又踩了一次）**：重启前**先算一下距上次登录多久**：
> ```powershell
> (Get-Content logs\bot.log | Select-String '已登录' | Select-Object -Last 1).Line
> ```
> **能攒就攒，但 2026-09-30 起不再强制 5 分钟**（协议端换成 SnowLuma，稳定性高得多）。
> ⚠️ 唯一硬下限：**别 1 分钟内背靠背** —— 那才是真正的"会话秒级更迭"。
> （下面这句留作背景：2026-09-15 我 22:10:57 重启完、22:11:42 又重启了一次，
> **只隔 31 秒** —— 那是 NapCat 时代，确实不该。）

1. **按 PID** 杀掉机器人（绝不按名字杀，见下）；
2. **等 10~15 秒，先看门狗**：它多半会自己补一个。
   - 补上了 → **就用它的，我不要自己再起**（它还会等"已连接到协议端"）；
   - 没补 → 这才自己起，**照下面这个写法**：

   ```powershell
   # ⚠️⚠️ 必须是 `start "" /min cmd /c _run-bot.bat`。
   #    漏掉 `cmd /c`、写成 `start "" /min _run-bot.bat` 的话 ——
   #    `start` 对 .bat 的**默认**行为是 `cmd /K`（**跑完保留窗口**）⇒
   #    每重启一次就留一个**永不关闭的黑窗**。
   #    2026-09-22 用户截图问我：「现在有好几个这个窗口，已经分不清哪个属于
   #    正在运行的机器人了，为什么不会自动关闭」—— 就是我一晚上攒出来的 6 个。
   #    项目自己的「启动机器人（后台）.bat」第 56 行写的就是
   #    `start "客服小祥" /min cmd /c "_run-bot.bat"`，照它抄就对了。
   Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
     CommandLine = "cmd.exe /c cd /d `"$dir`" && start `"`" /min cmd /c _run-bot.bat"
   } | Out-Null
   ```

   ⚠️⚠️ **想"零窗口"，用 `Start-Process -WindowStyle Hidden`**（2026-09-22 实测可行）：
   ```powershell
   # 机器人（bat 自己重定向日志，这里**不要**加 -RedirectStandardOutput —— 那会让脚本卡死）
   Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','_run-bot.bat' -WorkingDirectory $dir -WindowStyle Hidden
   # 协议端 SnowLuma 同理（它自带 node.exe，必须在它自己目录里跑）
   Start-Process -FilePath 'C:\SnowLuma\node.exe' -ArgumentList 'index.mjs' -WorkingDirectory 'C:\SnowLuma' -WindowStyle Hidden
   ```
   · 它**建一个隐藏的控制台**（`conhost` 还在，但**界面上看不见**）⇒ 任务栏 / 任务视图里都不会冒出来；
   · ⚠️ 别用 `start "" /min _run-bot.bat`（那是 `cmd /K`，留一个**看得见**的黑窗，
     而且永远不关 —— 用户 2026-09-22 就是被这个坑到"分不清哪个是机器人"，
     还**误把协议端那个黑窗关掉了**，机器人于是连不上）；
   · ⚠️ 也别指望 `wscript _run-bot-hidden.vbs`（试过两次都不行：WMI 直接起 `wscript`
     起不来；`start /min wscript …` 也不起来）—— **`Start-Process -WindowStyle Hidden` 才是正解**。
   ⚠️ 还有一条：**刚杀过一批进程时，别在同一条命令里立刻起** ——
   实测会静默失败（WMI 返回 `ReturnValue=0`，但 node 压根没起来）。隔几秒、分成两条命令。
3. **最后必须数实例数，必须是 1**：
   ```powershell
   (Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
     Where-Object { $_.CommandLine -match 'src[\\/]index\.js' } | Measure-Object).Count
   # 谁真的握着连接：
   Get-NetTCPConnection -RemotePort 3001 -State Established | Select-Object OwningProcess
   ```
4. ⚠️ **跑回归（`run-all`）期间只许"看"，不许杀任何 `src/index.js`** ——
   `test/behavior.js` 第 627/675 行就是 `spawn(node, [src/index.js])`，**它自己会起一个真机器人**。
   我杀进程时把它一起杀了，behavior 直接 4 项失败（看着像代码坏了，其实是误杀）；
   单独重跑（带隔离 env）全过。

### ⚠️ 重启次数的两次放宽（结论）

- **2026-09-15**：有了 `catchUpMissed()`（上线前 10 分钟内被吞掉的 @ / 关键词 / 服务器问题
  会被捞回来补答）⇒ **改完一个功能就可以重启**，不必攒到最后。
- **2026-09-30**：协议端换成 SnowLuma 后登录态稳得多 ⇒
  **"两次重启至少隔 5 分钟"作废**，降级成"能攒就攒"的建议。

| 已放宽的 | **还留着的** |
| --- | --- |
| 改完一个功能就重启（不用等回归跑完） | **别 1 分钟内背靠背**（真正的会话秒级更迭） |
| ~~至少隔 5 分钟~~（2026-09-30 起不强制） | 用户正在连着你测时，**先问一句再重启** |
| 重启后不必手工补消息 | 别拿"反正有补看"当理由去刷重启 |

### ⚠️ 补看**不覆盖**的东西（别以为它万能）

它只认 **@她 / 关键词 / 服务器问题**，而且**只看上线前 10 分钟**。
⇒ 下面这些**不补**：闲聊和主动搭话的时机（过去了就过去了）、图片表情的即时反应、
**正在生成中的那条回复**（进程被杀时写了一半的会丢）、
说说 / 主动私聊 / 日常事件的时点（那些是定时任务，重启会重排）。

## ⚠️ 不许断言「没扫码 / 不用扫码」（用户 2026-09-15 明确要求）

**用户原话**：「**不要轻易断言没有扫码**」。

我**看不到** QQ / NapCat 的二维码窗口（没有任何截图或界面访问能力），
日志里也**不记录**"这次是缓存登录态登的还是扫码登的" —— 两边都不写这一条。
所以：

- 🚫 **不许**说「不用扫码就登上了」「直接用缓存登录态登的」这种话
- 🚫 也不许反过来断言「这次肯定要扫码」
- ✅ 能说的只有**我能验证的**：进程在不在、3001/6099 在不在听、
  机器人日志有没有「已连接到协议端」、`node tools/napcat-state.mjs` 报什么
  （`online:nocred` 只说明"在线 + 本地凭据是空的"，**推不出登录方式**）
- 想确认登录方式，**问用户**（他看得见那个窗口）

⚠️ 类似的还有：别断言"用户没发过""用户没看到"——
我读到的本地记录可能是**本机回显**（踩过：以为用户发不出去，其实是 NapCat 假在线）。

## 铁律：启动机器人前，必须确认 QQ 协议端（NapCat）也在跑

**用户明确要求**：改完机器人设置、启动机器人时，要**同时把 QQ 协议端也起来**，这样他可以立刻在 QQ 里测，不用自己动手。

原因：机器人只是 OneBot 客户端，**没有 NapCat 它连不上 QQ，用户根本没法测**。只启动机器人等于交付了一个死的东西。

### 正确顺序

```
① 检查 NapCat（3001 端口是否监听）
   ├─ 在跑   → 直接进第 ②
   └─ 没在跑 → 启动 NapCat，等它就绪（最多 90 秒），再进第 ②
② 启动机器人
③ 确认日志里出现「已连接到协议端」+「已登录 QQ」
④ 告诉用户可以测了（顺带说明管理界面地址）
```

### 一键完成（推荐）

```
qq-ai-bot\一键启动（QQ+机器人）.bat          双击运行，启动完问一句要不要开管理界面
qq-ai-bot\一键启动（QQ+机器人）.bat /y      直接开管理界面
qq-ai-bot\一键启动（QQ+机器人）.bat /n      不打开（脚本化调用用这个）
```

底层是 `start-all.ps1`，它会：
1. 检查 3001 端口 → 没在跑就**先关掉残留 QQ** 再启动 NapCat，等它就绪（最多 90 秒）
2. 按 PID 停掉旧的机器人进程（不会误伤别的 node）
3. 启动机器人并轮询日志，确认出现「已连接到协议端」
4. 打印管理界面地址和日志路径

**从零启动实测 5.4 秒**（NapCat 已在跑的情况）。

> ⚠️ 这台机器上**没有 `pwsh`**，只有 Windows PowerShell 5.1（`powershell`）。
> 写脚本时用 `powershell`，别用 `pwsh`。

### 起机器人时踩过的坑（都记下来，别再踩）

**1. 不要用 `Start-Process -RedirectStandardOutput` 起机器人。**
父进程会等子进程的输出句柄关闭，而 node 一直活着，**脚本永远不返回**（表现为"启动脚本卡死"）。
解决办法：让一个专门的 bat 去做重定向（`_run-bot.bat`），脚本只负责 `cmd /c start` 它。

**2. 不要在 PowerShell 里拼 `cmd /c start ... cmd /c "node ... > log"`。**
多层引号转义必然出错，**日志会是空的、机器人也没起来**。
同上，重定向交给 `_run-bot.bat`。

**3. 在 .bat 里判断端口状态，不要用 `for /f` 包 powershell，也不要用 `errorlevel`。**
实测 `for /f %%c in ('powershell ...') ` 会返回 0（错误），`errorlevel` 在管道 + powershell 组合下也不可靠。
**正确做法是写临时文件再读**：

```bat
set "NAPFILE=%TEMP%\_napcat_check.txt"
powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count" > "%NAPFILE%" 2>nul
set "NAP=0"
if exist "%NAPFILE%" set /p NAP=<"%NAPFILE%"
del "%NAPFILE%" >nul 2>&1
```

**4. .bat 文件必须是 CRLF 行尾。**
用工具写出来的是 LF，cmd 会解析错乱（报一堆「'xxx' is not recognized」）。
写完记得转：

```powershell
$c = [System.IO.File]::ReadAllText($p) -replace "`r`n","`n" -replace "`n","`r`n"
[System.IO.File]::WriteAllText($p, $c, [System.Text.UTF8Encoding]::new($false))
```

**5. `timeout /t N` 在标准输入被重定向的环境下会报错**（「Input redirection is not supported」）。
用 `ping -n N -w 1000 127.0.0.1 >nul` 代替。

**6. `chcp 65001` 之后，命令行里的 `>` 重定向和硬编码的中文路径可能出问题。**
`_run-bot.bat` 里用的是相对路径 `logs\bot.log`，够用。

> 补充：我用 AI 会话的后台任务起机器人时，**我的任务被强杀会连带杀掉机器人**（Windows job 对象会带走子进程），
> 这是测试环境的限制，不是脚本问题。用户双击 bat 时父进程是 explorer.exe，不受影响。
> 所以**验证服务是否真的活着，要以用户视角看：双击脚本后 QQ 里能不能收到回复**。

### 手工命令（脚本不好使时）

```powershell
# ① 协议端：现在多数情况是 SnowLuma（自带 node，必须在它自己目录里跑）
Start-Process -FilePath 'C:\SnowLuma\node.exe' -ArgumentList 'index.mjs' -WorkingDirectory 'C:\SnowLuma' -WindowStyle Hidden
# ⚠️ NapCat 那条路（只有退回 NapCat 才用）：launcher 的窗口**必须可见** ——
#    登录态失效时它会停在二维码等你扫，隐藏窗口启动你就会看到"QQ 起了但 3001 一直不监听"。

# ② 机器人
cd '<项目目录>\qq-ai-bot'
node src/index.js

# ③ 确认连上了（日志里必须出现这几行，缺一不可）：
#   已加载表情库 N 张 / 已连接到协议端 / 已登录 QQ: 10000002 / 管理界面: http://127.0.0.1:3099
```

⚠️ 更省事的做法：双击 `一键启动（QQ+机器人）.bat`（里面就是这套顺序）。

## 启动前的四项自检

改完配置或代码、重启之前，过一遍这些。**都是踩过坑的地方**：

| 检查 | 为什么 |
| --- | --- |
| **`library/index.json` 登记的图片文件都在** | 表情文件丢过两次（OneDrive 同步），启动日志会警告「登记了但文件不存在」。用 `node test/tidy-library.js` 查 |
| **`knowledge/` 三个 md 都在** | `persona.md`（人设）、`hzymtr-server.md`（知识库）、`learned.md`（学习档案） |
| **`config.yml` 能解析** | YAML 缩进错会直接启动失败。`npm run check` 能查出来 |
| **配置项没写错值** | `node --check src/*.js` 查语法；`npm run check` 查配置 |

```powershell
cd '<项目目录>\qq-ai-bot'
node --check src/bot.js ; node --check src/config.js ; node --check src/index.js
npm run check
```

---

## 测试脚本会抢 NapCat 连接（重要）

**NapCat 的 WebSocket 服务端只允许一个客户端。** 机器人占着它的时候，任何自己连 3001 的脚本都会 `ECONNREFUSED`。

会抢连接的脚本：

| 脚本 | 用途 |
| --- | --- |
| `test/ask-private.js` | 真实模型私聊验收（自己开探针，会起一个 bot） |
| `test/ask-attitude.js` | 态度对比验收（同上） |
| `test/collect-faces.js` | 从群历史补收表情 |
| `test/scan-stickers.js` | 统计群表情使用频率 |
| `test/group-history.js` / `fetch-history.js` | 拉群历史 |
| `test/fetch-faces.js` | 下载 QQ 收藏表情 |

**跑之前先停机器人，跑完记得把它起回来**（连同 NapCat 检查）。

不占连接的脚本（假模型 + 假 NapCat，随便跑）：

```
test/attitude.js  test/face.js  test/webui.js  test/teach.js  test/cs.js  test/e2e.js
```

---

## ⚠️ 不要用名字匹配杀 node 进程

这台机器上跑着多个 node 程序（**DSH 自己也是 node**）。按名字杀会误伤，我犯过两次，两次都把正在服务的机器人弄停了。

**正确做法**：先看清楚再按 PID 精确停。

```powershell
# 先列出来，确认哪个是机器人
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'index\.js' } |
  Select-Object ProcessId, CreationDate, CommandLine

# 再按 PID 停
Stop-Process -Id <PID> -Force
```

或者直接用 `停止机器人.bat`（它内部是按命令行精确匹配的）。

### ⚠️⚠️ 更阴的一手：**宽匹配会杀到我自己**（2026-09-15 踩了）

> ## 🚨 硬规矩（2026-10-05 一晚**又踩两次**之后定的，别讨价还价）
>
> **杀进程的命令里，不许出现任何 `CommandLine` 匹配。** 一次都不许。
> 一律走这三步：**① 只读列出全部 node → ② 人工认出 PID → ③ 用硬编码 PID 杀。**
>
> ⚠️ 为什么连"顺手加个 `-like`"都不行：**DSH 跑我的命令时外面套的 runner 本身就是
> `node.exe`，而它的命令行里带着我这一整段脚本的原文** —— 我在脚本里写什么串，
> runner 的命令行里就有什么串 ⇒ **过滤条件必然命中它自己** ⇒ 命令跑到一半、
> 我自己把自己杀了（`exit code 4294967295`，什么都不输出）。
>
> ⚠️ **两次都不是"手滑"，都是"看起来很合理"的写法**：
> · 第一次：装完包想看看「验证进程起来没有」→ `-like "*saki-install-test*"` ✗
> · 第二次：收尾想「按 PID 杀验证进程」→ 循环里还是那个 `-like` ✗
> ⇒ **验证脚本、收尾脚本一样算数** —— 不是只有"清理"才危险。
>
> ✅ 安全写法（**唯一**）：
> ```powershell
> # ① 只读列出，人工看（命令里不要出现任何要匹配的串）
> Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
>   Select-Object ProcessId, CreationDate, @{n='cmd';e={$_.CommandLine.Substring(0,80)}}
> # ② 认出 PID 之后，硬编码杀掉
> foreach ($id in 480300, 332844) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
> ```

我用 `CommandLine -match 'watchdog\.ps1|看门狗\.bat'` 批量停看门狗 ——
结果**把我自己那条 pwsh 也杀了**：因为**我的命令行里就写着这个正则**，
它当然匹配上了。表现是命令直接 `exit code -1`、什么都没输出，查半天。

⚠️⚠️ **2026-09-22 又踩了一次，而且是更狠的版本**：过滤条件是
`-Filter "Name='node.exe'"` + `CommandLine -match 'index\.mjs'`（想找协议端）。
问题在于 —— **DSH 跑我的命令时，外面套的 runner 本身就是 `node.exe`，
而且它的命令行里带着我这一整段脚本的原文**（见全局 AGENTS 里那条）。
⇒ 正则命中了 runner ⇒ **我把正在执行这条命令的 runner 杀了** ⇒
命令报 `Windows Job runner exited with exit code 4294967295 before proving its managed range empty`，
**什么都没输出**，而且那半截命令只执行到一半（SnowLuma 被杀光了，起它的那行没跑到）。

**所以**：

- 🚫 **凡是 `Name='node.exe'` 再配 `CommandLine -match` 的过滤，一律先想想会不会打中 runner**；
- ✅ 稳的做法：**先只读列出全部 node 进程**（这条命令里**不要出现**那个匹配字面量），
  **人工认出 PID**，再 `Stop-Process -Id <确切PID>`；
- 或者**把模式拆开拼**（`'index' + '\.mjs'`），别让整串字面量出现在自己的命令行里；
- 杀进程前先 `Where-Object { $_.ProcessId -ne $PID }`（排除自己）——
  ⚠️ 但这**挡不住 runner**（它是父进程，不是 `$PID`），所以只能靠"不匹配"或"按 PID"。

**另外**：我（AI 助手）用后台任务方式起的机器人，会被我的会话生命周期牵连。**交付给用户长期跑的，应该用 `启动机器人（后台）.bat` 或 `一键启动（QQ+机器人）.bat`**，那样和我解耦。

### ⚠️ 我的命令被强杀会带走子进程 → 要"脱离 job"就用 WMI

同一个坑的另一面（2026-09-15）：我用 `Start-Process` 起 NapCat 的 launcher，
**那条命令超时被强杀，launcher 跟着一起死了**（Windows 的 job 对象会带走子进程）。
表现是"NapCat 怎么都起不来"，其实是被我自己的超时连累的。

**要起"该活过我这条命令"的进程，用 WMI 创建** —— 它的父进程是 `WmiPrvSE`，
**不在我的 job 对象里**：

```powershell
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'cmd.exe /c start "" /min "C:\…\看门狗.bat"'
}
```

⚠️ 反过来：**别指望 `Start-Process` 起的东西能活久** —— 短命令里查一下状态没事，
但要交付给用户长期跑的服务，就得走上面这条路（或者让用户双击 bat）。

### ⚠️⚠️ WMI 起不了 PowerShell —— AI 会话里补不了看门狗（2026-09-20 实测）

WMI（`Win32_Process Create`）能起 `cmd /c start …` 这类**辅助进程**，
但**起不了 PowerShell** —— 它建出来的进程跑在非交互式窗口站里，一起来就没。
三种起法实测（`powershell -File watchdog.ps1` / 用 vbs 包一层 / `cmd /c start "" /min powershell …`）
**都不行**，`watchdog.log` 一行都不写。

⇒ **要补看门狗只有两条**：
- 用户**双击 `看门狗.bat`**；或者
- 走**计划任务**（`Register-ScheduledTask` + `-LogonType Interactive` +
  `ExecutionTimeLimit` 设 `[TimeSpan]::Zero`，**故意不配触发器**以免和开机自启的
  `SakiBot` 重复起两个）—— 2026-10-06 实测可行。

⚠️ **正道还是开机自启**（`SakiBot` → `autostart.ps1` 最后一行起它）：那是 explorer 在
**用户会话**里启动的，能连续跑几小时。⚠️ 查它的时候**别用 `-match 'watchdog'`** ——
我自己的命令行里就写着那个词，会**打中我自己**，于是"看见"一个根本不存在的 PID。

### ⚠️ 起 NapCat 必须走 launcher（只在"哪天退回 NapCat"时才用得上）

`launcher-win10-user.bat` 看着只是调一下 exe，真正干的事是**设五个环境变量** ——
其中 `NAPCAT_LOAD_PATH` 指的那个 `loadNapCat.js` 才是"把 napcat.mjs 注入进 QQ"的入口。
**直接调 `NapCatWinBootMain.exe` 而不设这些** ⇒ **QQ 起来了、但 NapCat 完全没跑**
（6099/3001 都不监听、日志也不写），看着像"启动失败"，其实是**注入根本没发生**
（2026-09-15 实测）。⇒ **走 launcher，别自己拼 exe。**

## ⚠️ 写测试假模型的两条铁律（踩了 4 次，务必照做）

几乎每个套件都会起一个「假模型」（假的 OpenAI 兼容 HTTP 服务）。
**它回错格式不会报错，只会让机器人静默走错分支** —— 表现是"偶发失败"，
而且每次挂的项还不一样，极难查。2026-09-13 一次性修掉 4 处，全是这两个错：

### ① 先看那个请求**是不是流式**，再决定回 SSE 还是整块 JSON

判断依据是请求体里的 **`stream`** 字段，不是提示词内容：

| 请求方 | 走哪条路 | 假模型该怎么回 |
| --- | --- | --- |
| 主聊天 / **预搜索**（`search-presearch.js`）/ **搜索规划** | `collect(streamChat(...))` | **SSE**（`text/event-stream` + `data: {...}\n\n`） |
| 说话判断 / 归属核对 / 知识抽取 / 归属 | `res.json()` | 整块 `application/json` |
| `llm.phrase()` / `phraseMoney()` / **追补（follow-up）** | `res.json()`，**非流式** | 整块 `application/json` |

**两个方向的坑都踩过**：

- 预搜索回成了 JSON → SSE 解析器读不到 `data:` → `raw` 空串 →
  判断失败 → **退回规则 → 真的联网搜**（bing/百度/DDG + 抓页，12~15 秒）
  → 后面几步 `waitFor` 全超时。**这就是 cs / attitude / teach 长年"偶发失败"的真凶**，
  一直被误当成"并发抢 CPU 的噪音"。
- 非流式请求回成了 SSE → 调用方 `res.json()` 报
  `Unexpected token 'd', "data: {"ch"...` → **静默退回模板**。

**省事的写法**：把「非流式 → 回 JSON」放在最后一道兜底（在 SSE 之前），
再逐个识别需要 SSE 的提示词。参考 `test/cs.js` 里的假模型。

### ② `waitFor` 的条件必须**指向我要的那一条请求**

*不要*写这些条件 —— 它们在**发送之前就可能已经成立**，于是断言跑在真正
的请求到达之前，而且取到的是上一步迟到的请求：

| ❌ 别写 | 为什么错 |
| --- | --- |
| `() => probes.length > 3` | 绝对阈值，发之前就成立 |
| `() => calls.answer > before` | 上一步迟到的请求（追补 / 说话判断 / 归属核对）也会让它变多 |
| `() => probeFor('关键词')` | 追补请求会把**整段群聊上下文**带上，含这个关键词 |

| ✅ 该写 | 说明 |
| --- | --- |
| `() => !!chatFor('关键词')` | 只认"主聊天请求"（user 形如「XX刚发来的消息：「…」」） |
| `() => prompts.some((x) => x.sys.includes('要注入的那段'))` | 直接等**我要的那个特征**出现 |

⚠️ `check(p?.sys.includes(...))` 这种带 `?.` 的断言有个陷阱：
**"没等到"和"没这个特征"都返回 false，看起来一样**。
所以等不到时要么让 `waitFor` 真的等到，要么额外断言 `!!p`（参考 `test/cs.js` 里
`闲聊确实发生了一次模型调用` 那条）。

### ③ 假服务跑在本进程里时，**绝对不能用 `spawnSync`**（2026-09-15 踩了）

写 `test/watchdog-state.js` 时我起了个"假 NapCat"（本进程的 HTTP server），
然后把探针工具用 **`spawnSync`** 拉起来 —— **每一条都失败**，
探针统一返回"超时"，看着像工具坏了。

真相：**`spawnSync` 会阻塞本进程的事件循环** →
子进程发 HTTP 请求过来，**父进程（我）正卡在 `spawnSync` 里，永远没法响应** →
TCP 连得上但没响应 → 子进程 `AbortSignal.timeout` 到点。

**改成异步 `execFile` 就好了**：

```js
const pExecFile = promisify(execFile);
const { stdout } = await pExecFile(process.execPath, [tool], { cwd: ROOT, env: {...} });
```

**记住**：**只要那个假服务跟你写在同一个进程里，就不能用任何 `*Sync` 去等对面**。

### ④ 收请求体：**先把分片拼成 Buffer，再一次性解码**（2026-10-06 抓到的，19 个套件全中招）

```js
// ❌ 别这么写：`c` 是 Buffer，`+=` 会**每个 TCP 分片各自 toString()** ——
//    中文正好跨分片时那个字就烂成 `��`
let body = '';
req.on('data', (c) => (body += c));

// ✅ 先收 Buffer，最后一次性按 UTF-8 解码
const chunks = [];
req.on('data', (c) => chunks.push(c));
req.on('end', () => {
  const body = Buffer.concat(chunks).toString('utf8');
});
```

**为什么这个坑特别阴**：只在**中文跨分片**时发作，而分片时机由请求体大小和 TCP 决定 ⇒
表现是**偶发假失败**，而且**报出来的完全不是那件事**。
实测（`test/attitude.js` 的【5】）：约 **1/5** 概率挂在「私聊里的陌生人按群友对待」，
看着像"态度注入错了"；实际是假模型收到的正文里**那个「问」字烂了**，
`probes` 里 `user.includes('问个事')` 永远匹配不上。
而 bot 自己的日志还显示「她明明回复了」⇒ 更让人怀疑自己的代码。

⚠️ 顺带纠正一个**假结论**：清理测试的隔离状态后曾经"连过 13 次" ——
那只是让提示词变短、大概率一个分片发完，**降低概率、不是修复**。
（请求体越容易跨分片越容易中：提示词攒多了、`recent` 长了。）

⚠️ **2026-10-06 已把 `test/*.js` 里 19 处全部改成 `Buffer.concat` 版**，写新的假模型照抄。

⚠️ **教训**：碰到"偶发失败"，除了上面那两条，再加一条 ——
**把发给假模型的原文打印出来看一眼**（`user=「…」`）。
字节级被破坏的东西一眼能看出来，比读代码猜快得多（这次绕了很久）。

---

## 交付前要跑的回归

### ⚠️⚠️ **回归一律在「后台 job」里跑，不许占着前台等**（2026-10-06 用户定）

**用户原话**：

> 「**以后跑回归都像刚才那样在后台跑**，这个时候我可以发送新发现插话」

- ✅ 起命令时就用 **`run_in_background: true`**（DSH 的后台 job），
  命令**立刻返回一个 job id**；过几分钟它跑完了会**主动通知**结果。
- ✅ 启动之后**马上告诉用户一句**「回归在后台跑着」，然后**该干嘛干嘛** ——
  他在这几分钟里随时能发新发现、改主意、让你先干别的。
- ✅ 后台 job 跑完会**主动通知**我 ⇒ **通知一到就立刻去 `job_output` 读结果、
  马上把结论报给他**（哪几套过了、哪几套没过、为什么）。
  🚫 **不许攒着**、不许等他问、更不许当没看见 —— 他刚才就是为这个补的要求。
- ✅✅ **红了就当场修，不许只报不修**（同一句要求的下半句：「**出问题要修复**」）。
  修的顺序：① 读 `logs/test-<套件名>.log` 定位是哪一项；
  ② 分清**是我这次改动引起的**（就去改代码，或者改那条已经过时的断言）
  还是**并发偶发**（先单独重跑：`node test/run-all.js <套件名>` ——
  带隔离 env，别直接 `node test/<套件名>.js`）；
  ③ 改完**复跑那一套**，必要时再跑一遍全量；④ 把"修了什么、为什么"一起报给他。
  ⚠️ 只有**确实需要他拍板**的（比如要动真实数据、要改配置）才停下来问。
- ⚠️ 改完**一定要重启机器人**（铁律②），别让"回归绿了"和"用户能测"脱节。
- 🚫 **不要**前台阻塞着等那 2.5~4 分钟 —— 那段时间**他插不进话**，
  和上面「⚠️⚠️ 别为了重启而干等」是**同一个毛病**（占着会话 = 让人干等）。
- ⚠️ 回归跑着的时候**不许去杀任何 `src/index.js`**（`test/behavior.js` 自己会
  spawn 一个真机器人，见下面那节）—— 但**可以**继续改代码、写测试、读日志。

**首选一条命令**（并行跑全部套件，约 2.5~4 分钟，各套件用独立端口互不干扰）：

```powershell
cd '<项目目录>\qq-ai-bot'
node test/run-all.js            # 默认 2 个并行
node test/run-all.js --jobs 1   # 退化成串行（排查某个套件时用）
node test/run-all.js poke quest # 只跑指定套件（**仍然带隔离 env**，
                                #   比自己 node test/poke.js 安全，见下面那节）
```

⚠️ **并发别调高**：并发 5 时超时更容易触发。但要注意 —— **2026-09-13 查清了，
以前那些"并发才偶发"的失败大部分根本不是负载问题**，而是上面那条
「假模型的响应格式 + `waitFor` 条件」的坑。以后再看到偶发失败，
**先去上面那节对照一遍**，别先怀疑 CPU。

### ⚠️⚠️ **单独跑套件会写真实的 `state/`**（2026-09-15 踩了，污染了用户的榜单）

`node test/run-all.js` 会给每个套件注入**隔离的**状态文件路径
（`isolatedStateEnv`：`QQBOT_AFFINITY_FILE` / `QQBOT_NAMES_FILE` / … 都指到 `logs/__run-*`）。
但**直接 `node test/behavior.js` 不走那一层** —— 套件里那些假群友会**直接写进真实的 `state/*.json`**。

实测后果：我在这一轮里直接跑了 `node test/behavior.js`（它里面假群友的 `user_id`
是 **`30003`**），结果**用户的 `/好感度` 榜上多出一个「30003」**，
他截图来问「**30003 是谁？**」——那不是真人，是我跑的测试。

**所以**：

- 要单独跑某套件时，**先自己设隔离**，或者**跑完检查一遍真实 state**：
  ```powershell
  # 例：只跑一个套件，并且不碰真实 state
  $env:QQBOT_AFFINITY_FILE='logs/__manual-affinity.json'
  $env:QQBOT_NAMES_FILE='logs/__manual-names.json'
  node test/behavior.js
  ```
- 涉及**会落盘的模块**的套件尤其注意：`affinity` / `names` / `spend` / `balance` /
  `qzone` / `life` / `quest` / `storyline` / `outbox` / `friend` / `tic`
- 已经污染过的：**看清楚再删**（`state/*.json` 里那些**不在任何群成员名单里**的 uid，
  多半就是测试留下的）。删之前先停机器人（不然它内存里那份会写回来）。

想单独跑某一套（都不占 NapCat 连接）：
```powershell
node test/attitude.js     # 服主 / 群友 / 管理员 的身份差异
node test/face.js         # 表情标记 → 单独发图片、分条边界保护
node test/webui.js        # 管理界面改配置热重载、路径穿越防护
node test/teach.js        # 群里教学、权限防护
node test/cs.js           # 群限定、知识注入、实时查询
node test/e2e.js          # 基础收发
node test/follow-up.js    # 「说完又想补充」自己接自己（离线判定 + 真进程接线）
node test/tic.js          # 口癖节流（同一个开场白反复出现时抑制）
node test/punctuation.js  # 聊天里不用的标点（破折号→逗号）+ 破折号处要分条
node test/cooldown.js     # 主动接话冷却按群隔离 + 「收紧度≤2 跳过 judge」没被误删
node test/join-scope.js   # 「能在哪些群主动搭话」读 allowGroups（不再看废弃的 chat.group）
node test/at-other.js     # 「@ 的是别人别插嘴」—— at 段 + **文本形态**（`@<主人> 给个服世界地图。`）两种都要拦
node test/quote.js        # ★「引用」两条规矩：引用她=直接对她说话；间隔≥4条就该引用；引用够了**不许再补 @**（余额见底那条 @ 不许动）
node test/tone.js         # 「别一直质疑对方」—— 连着抬杠的计数 + ≥2 才注入"这句接住"
node test/watchdog-state.js # 看门狗判「QQ 在不在线」：★「已登录,无法重复登录」是**卡死**不是在线
node test/qq-qrcode.js    # 二维码：★ 重新出码走 RefreshQRcode（**不许重启 NapCat**）+ 界面必须带 fresh=1
node test/provider.js     # ★ 协议端适配：换 LLBot 后收发不变、**不支持的能力必须明确拒绝**（不假装成功）
node test/storyline.js   # 故事线：★ 二级条目锁定，模型想删/扩写都被拦（整次作废）
node test/life.js        # 一级事件：时段匹配 + 随机+冷却 + 0-7点不发 + 掉线不补发
node test/holiday.js     # 节日：农历自动算 + 闰月跳过 + 日本/中国节日不混 + 放假屏蔽学校事件
node test/quest.js       # 二级剧情：阶段数≤10/最佳3指数下降 + 冷场最多续1次 + 硬上限 + 落盘可恢复
node test/qzone.js        # 发说说的计数/冷却**必须落盘**（不然重启就重置）+ 陈旧时间戳不采信
node test/bilibili-scope.js # 「问B站热门视频」不许被当成「查我的投稿」+ 退避按接口 + 不泄露错误码
node test/imagegen.js    # ★ 生图（她「拍个照」）：标记剥净 + **失败话术不许泄露故障码** + 换服务商只改配置 + 串行只跑一个（**离线假服务器，不花钱**）
node test/learned-edit.js # learned.md 能在界面改（保存时校验格式）+ /api/reload 带知识库
node test/affinity.js     # 好感度（默认50/0~100）+ 对服主不注入 + 自动机制不许改它
node test/observe-compress.js # 群记忆压缩：性格条数不许变少（少了整次作废）
npm run check             # 配置与模型连通性
```

改了**真实回答质量相关**的东西（人设、知识库、态度、表情标签），额外跑一次真实模型验收：

```powershell
# 先停机器人！
node test/ask-private.js "新人怎么进服务器"
node test/ask-attitude.js
```

---

## 快速排障对照

| 现象 | 原因 |
| --- | --- |
| 机器人一直「连接失败 / 3s 后重连」 | NapCat 没起或没登录 |
| NapCat 起了但 3001 不监听 | 登录态失效在等扫码，或被隐藏窗口启动了 |
| 日志说「已登录,无法重复登录」但其实收不到消息 | ⚠️ **卡死态**（登录态被作废，QQ 核心还攥着旧会话）。跑 `node tools/napcat-state.mjs` 看是不是 `stale` —— 是就重启 NapCat；`stale:nocred` 则只能扫码 |
| 扫码页显示「二维码已过期，请刷新」 | 正常（刚重启完就是这样）。3099 点「显示二维码」会刷一张新的 |
| 用户说「QQ 又连不上」 | 用户自己开了 QQ，那个实例没有 NapCat（NapCat 只在启动时注入） |
| 浏览器打不开 3099 | 换 `127.0.0.1` / `localhost` / `[::1]` 试（已做双栈）；还不行看有没有代理软件劫持回环 |
| 表情图纸空白 | 图片文件丢了，看启动警告 |
| 测试脚本 `ECONNREFUSED 3001` | 机器人占着连接，先停它 |
| 看门狗窗口反复刷 `Cannot validate argument on parameter 'ArgumentList'` + 「等了 90 秒 NapCat 仍未监听 3001」 | **空数组传给了 `Start-Process -ArgumentList`**：`@()` 会抛异常，命令直接中断 → NapCat **压根没被启动**（2026-09-17 修的 `watchdog.ps1`；同一次还修了它读 `config.yml` **不认单引号** `botQQ: '10000002'` 的 bug）。⚠️ 这个坑 `start-all.ps1` 09-15 就修过，watchdog 那份漏了 —— **两个脚本都要看** |
| `logs/watchdog.log` 反复写「机器人未在 30 秒内连上」，但当日 `logs/bot-YYYY-MM-DD.log` 里明明有「已连接到协议端」 | ⚠️ **看门狗进程跑的是旧脚本**（2026-10-06 实测）。`powershell -File watchdog.ps1` 是**常驻循环**，脚本只在**启动那一刻**读进内存 ⇒ **改了 `watchdog.ps1` 必须重启看门狗**，否则旧进程永远按老逻辑判断。那次是两个 10-02 启动的看门狗还在找 `logs\bot.log` —— 而那个文件在 10-02 的「日志按天留存」改造后**就不存在了** ⇒ 每次启动都白等 30 秒、报假警报（`Start-Bot` 的返回值被 `Out-Null` 丢掉，所以**只是误报、不会重复拉起**）。<br>⚠️ 顺带：**`logs\bot.log` 不是当前日志**，别照它去查；当日日志是 `logs\bot-YYYY-MM-DD.log`（由 `src/log.js` 按天追加写）。<br>⚠️ 补一个看门狗的办法（AI 会话里 WMI / `Start-Process` 都留不住它）：**计划任务**，`Register-ScheduledTask` + `-LogonType Interactive` + `ExecutionTimeLimit` 设 `[TimeSpan]::Zero`（默认 72 小时会把长驻循环杀掉），**故意不配触发器**以免和开机自启的 `SakiBot` 重复起两个 |
| 在管理界面点了「重启 NapCat」，它到底会不会自己回来 | ✅ **会，而且很快**（2026-09-17 03:12 实测：03:12:05 点 → WS 断开 → 03:12:08 QQ 进程换新 → **03:12:11 已登录，6 秒**）。`RestartNapCat` 自己就会把 QQ 重新拉起来，**看门狗都来不及出手**（它 20 秒才查一次）。<br>⚠️ 那 03:04 用户点完为什么就没回来？**因为当时坏掉的看门狗把恢复过程打断了**：`Start-NapCat` 每轮先 `Stop-Process QQ` 再 `Start-Process`，而后者又因为空数组抛异常 → **QQ 被强杀、NapCat 又没起来**，于是死循环。两处都修好（`e4ad20b`）后这条链才是通的。<br>→ 所以**点重启是安全的**（约 6 秒不可用），出问题才需要看门狗兜底；点完 1 分钟还不通，去看 `logs/watchdog.log` |

---

## 🔄 协议端换过好几次（NapCat → LLBot → SnowLuma）—— 只留结论

**现状**：`config.yml` 里 `provider.name: snowluma`（`dir: C:\SnowLuma`，管理页 `http://127.0.0.1:5099`）。
它是**独立实现、不注入 QQ 客户端**，登录态比 NapCat 稳得多 —— 2026-09-30 之所以能把
"两次重启至少隔 5 分钟"放宽成"能攒就攒"，依据就是这一点。

⚠️ **换协议端时踩过的坑（换哪一家都适用）**：

1. **两个协议端不能同时跑** —— 都抢 3001，而且连的是同一个号；顺序必须是
   **停旧的（连 QQ 一起）→ 再起新的**。
2. **NapCat 的 launcher 会把 QQ 拉回来**（就是那个 cmd 窗口），光杀 QQ 没用。
3. **首次登录要扫码**；各家"自动登录"的凭据都可能被腾讯作废（NapCat 那份就被作废过）。
4. 管理能力按家分派（出码 / 重启 / 快速登录），**不支持就明确说"不支持"**，见 `src/provider.js`。

⚠️ `src/cred-backup.js` + `tools/napcat-cred.mjs` 是 **NapCat 专用**的（现在不会执行，
留着是"哪天退回 NapCat 还能用"）—— **不是死代码，别删**。

## 🚀 发 GitHub Release（2026-09-30 加）

**凭据**：GitHub PAT 存在 **`logs/发布凭据.md`**（用户要求「记下 token，下次就不用我再生成了」）。
- ⚠️ `logs/` 在 `.gitignore` 里、也在 `make-public.cjs` 的跳过清单里 ⇒ **不进任何仓库**，已验证。
- ⚠️⚠️ **绝不要把 token 抄进这份 `AGENTS.md`** —— 它会被导出到公开仓库
  （`qq-ai-bot-public/AGENTS.md` 就是它），写进去等于把凭据公开。这里只写"它在哪"。

**PAT 要求**：fine-grained token，Repository access 选 `<主人>/saki-ai-bot`，
Repository permissions 里 **`Contents: Read and write`**。
- ⚠️ 只勾 `Repository advisories` **不够**（2026-09-30 踩过：建 Release 直接
  `403 Resource not accessible by personal access token`）。Release 和它的附件都算在 `Contents` 底下。

**流程**（这台机器上**没装 `gh` CLI**，所以走 REST API）：

```powershell
$token = (Get-Content '<项目目录>\qq-ai-bot\logs\发布凭据.md' -Raw).Trim()
$h  = @{ Authorization = "Bearer $token"; 'User-Agent' = 'dsh-release'; Accept = 'application/vnd.github+json' }
$px = 'http://127.0.0.1:7890'
$api = 'https://api.github.com/repos/hzyzhzy/saki-ai-bot'

# ① 建 Release（body 是中文 + markdown ⇒ 必须自己转 UTF8 字节，别直接传字符串）
$payload = @{ tag_name='v1.0.x'; name='标题'; body=$body; draft=$false; prerelease=$false } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "$api/releases" -Headers $h -Proxy $px `
  -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))

# ② 传附件（走 uploads.github.com）
Invoke-RestMethod -Method Post -Headers $h -Proxy $px -ContentType 'application/octet-stream' -TimeoutSec 1200 `
  -Uri "https://uploads.github.com/repos/hzyzhzy/saki-ai-bot/releases/<id>/assets?name=saki-setup-1.0.x.exe" `
  -InFile '<项目目录>\qq-ai-bot\installer\dist\saki-setup-1.0.x.exe'
```

**三个坑（都踩过，别再踩）**：

| 坑 | 现象 | 规矩 |
| --- | --- | --- |
| hosts 把 `github.com` / `api.github.com` 指向 `127.0.0.1` | 命令行连 GitHub 一律 `ECONNREFUSED`；浏览器却可能能进（走代理时域名由代理解析，绕开 hosts） | **每次 API 调用都显式带 `-Proxy http://127.0.0.1:7890`**；别指望系统代理开关 —— 它经常是 `0`，但 7890 本身是通的（`Test-NetConnection 127.0.0.1 -Port 7890` 一测就知道） |
| `git push` 能成、API 却 401 | GCM 那份凭据**只给 git 用**，`git credential fill` 取不出来（返回空） | Release 资产**必须**用 PAT —— 跟 push 是两套认证 |
| 发出去的 exe 里是旧代码 | `build-payload` 的源是**公开副本**，不先重新导出就会打包上一版 | 顺序：改代码 → `make-public.cjs` → `build-payload.cjs`（**别加 `--refresh`**：它自己会再跑一次 make-public，两个前后脚跑会把 README/LICENSE 删掉）→ `ISCC` → 静默装到临时目录验一次 |

**已发布的 tag**：`v1.0.0` → `3695e0e`、`v1.0.1` → `3f9fea3`，各带自己的 `saki-setup-*.exe`。

⚠️ **验证安装包时别留僵尸**：用 `cmd /c node src\index.js` 起的验证进程，
`Stop-Process` 杀 `cmd.exe` **不会**带走里面的 node —— 必须按 node 的 PID 杀，
否则它会一直跑着（2026-09-30 就留了两个，还误以为是"端口 3099 被占用"）。
