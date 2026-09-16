; ⚠️ 这个文件必须存成 **UTF-8 带 BOM**，否则 Inno 会把中文当 ANSI 读成乱码。
;    改完用这条转一下（PowerShell）：
;      $p='installer\saki-bot.iss'; $c=[System.IO.File]::ReadAllText($p); [System.IO.File]::WriteAllText($p,$c,(New-Object System.Text.UTF8Encoding($true)))

#define AppName "客服小祥"
#define AppVer "1.0.0"
#define AppPub "hzyzhzy"
#define AppURL "https://github.com/hzyzhzy/saki-ai-bot"

[Setup]
; AppId 一旦发布就不能改（它决定"升级时认不认得出是同一个软件"）
AppId={{8F3A2C10-7B4E-4A6D-9C21-5E7D9B3A1F42}
AppName={#AppName}
AppVersion={#AppVer}
AppVerName={#AppName} {#AppVer}
AppPublisher={#AppPub}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
DefaultDirName={localappdata}\SakiBot
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; ⚠️ 按用户安装（不要管理员）—— 少一次 UAC，也不往 Program Files 里塞东西
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=saki-setup-{#AppVer}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName}
SetupLogging=yes
; 安装完可以让用户直接启动（见 [Run]）

[Languages]
Name: "chinese"; MessagesFile: "languages\ChineseSimplified.isl"

[Files]
; payload 由 installer/build-payload.cjs 生成（= 脱敏后的公开副本 + 内嵌 node.exe）
Source: "build\payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
Name: "{app}\logs"
Name: "{app}\state"
Name: "{app}\manual"
Name: "{app}\napcat"

[Icons]
Name: "{userdesktop}\客服小祥"; Filename: "{app}\一键启动（QQ+机器人）.bat"; WorkingDir: "{app}"; Comment: "先确认 QQ 协议端，再启动机器人"
Name: "{group}\客服小祥（启动）"; Filename: "{app}\一键启动（QQ+机器人）.bat"; WorkingDir: "{app}"
Name: "{group}\管理界面"; Filename: "{app}\预览.bat"; WorkingDir: "{app}"
Name: "{group}\安装信息（含 token）"; Filename: "{app}\安装信息.txt"
Name: "{group}\卸载客服小祥"; Filename: "{uninstallexe}"

[Run]
; 🚫 都做成"可勾选项"，**不静默安装任何东西**（杀软最恨静默装东西的行为）
Filename: "{app}\安装信息.txt"; Description: "查看安装信息（NapCat 要用的 token 在这里）"; Flags: postinstall shellexec nowait skipifsilent
Filename: "{app}\一键启动（QQ+机器人）.bat"; Description: "现在启动客服小祥"; Flags: postinstall shellexec skipifsilent
Filename: "https://github.com/NapNeko/NapCatQQ/releases"; Description: "打开 NapCat 官方下载页（本安装包不含 NapCat）"; Flags: postinstall shellexec nowait skipifsilent unchecked

[Code]
var
  PageBasic: TInputQueryWizardPage;
  PageNap: TInputOptionWizardPage;
  ConfigNote: String;

{ 把值里会破坏 JSON 的字符去掉（引号/反斜杠/换行） }
function JsonSafe(const S: String): String;
begin
  Result := S;
  StringChangeEx(Result, '"', '', True);
  StringChangeEx(Result, '\', '', True);
  StringChangeEx(Result, #13, '', True);
  StringChangeEx(Result, #10, '', True);
end;

procedure InitializeWizard();
begin
  { ── 第 1 页：四件事（都能留空，之后在管理界面改） ── }
  PageBasic := CreateInputQueryPage(wpSelectDir,
    '基本设置',
    '这几件事之后都能改',
    '全部可以先留空 —— 装好后在管理界面（http://127.0.0.1:3099）里也能填。' + #13#10 +
    '但填了的话，装完就能直接跑。');
  PageBasic.Add('机器人 QQ 号（要用哪个号当机器人）', False);
  PageBasic.Add('你自己的 QQ 号（主人）', False);
  PageBasic.Add('大模型 API Key（如 DeepSeek，可留空）', True);
  PageBasic.Add('要在哪些群说话（群号，逗号分隔，可留空）', False);

  { ── 第 2 页：NapCat 怎么来 ── }
  PageNap := CreateInputOptionPage(PageBasic.ID,
    'QQ 协议端（NapCat）',
    '本安装包**不包含** NapCat',
    'NapCat 是第三方 QQ 协议端，遵循它自己的许可（不得商用；再分发要附许可全文并标明来源）。' + #13#10 +
    '所以本安装包**不打包**它 —— 勾第一项的话，装完会**从官方 Release 自动下载**' + #13#10 +
    '（约 28 MB，会校验官方 sha256），并自动解压到 napcat\NapCat.Shell\、' + #13#10 +
    '把端口和 token 一次配好。你不用自己去翻下载页。' + #13#10 + #13#10 +
    '之后只剩"登录"这一步（没人能替你点）：完全退出 QQ → 双击 napcat\NapCat.Shell\' + #13#10 +
    'launcher-win10-user.bat → 出二维码就扫 → 回来双击「一键启动（QQ+机器人）.bat」。',
    True, False);
  PageNap.Add('装完自动下载并配置 NapCat（推荐）');
  PageNap.Add('我自己来，先别下载');
  PageNap.Values[0] := True;
end;

{ 用户选了"自动下载 NapCat"吗？（静默安装一律当作"不下载" —— 别在无人值守时联网下东西） }
function WantsNapCat(): Boolean;
begin
  Result := (not WizardSilent()) and PageNap.Values[0];
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  { ⚠️⚠️ 2026-09-17 踩过：这里必须判 `WizardSilent()`。
      静默安装（/VERYSILENT）时这几页不会显示，可 MsgBox 照样会弹 ——
      而 /SUPPRESSMSGBOXES **只抑制 Inno 自己的消息框，管不到脚本里自己调的 MsgBox**。
      症状：静默装到一半弹出看不见的对话框，进程就挂在那儿（我第一次自测就是这么超时的）。 }
  if WizardSilent() then
    Exit;

  if CurPageID = PageBasic.ID then
  begin
    if PageBasic.Values[0] = '' then
    begin
      if MsgBox('没填机器人 QQ 号。装完后要自己改 config.yml 里的 botQQ，确定继续吗？',
        mbConfirmation, MB_YESNO) = IDNO then
        Result := False;
    end;
    if PageBasic.Values[2] = '' then
    begin
      if MsgBox('没填大模型 API Key。装完机器人起来了也还不能说话（要先在管理界面填 Key），确定继续吗？',
        mbConfirmation, MB_YESNO) = IDNO then
        Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Answers, NodeExe, Script, Params, NapParams: String;
  Code: Integer;
begin
  if CurStep <> ssPostInstall then
    Exit;

  { 把向导里的答案写成 JSON，交给 node 去生成 config.yml }
  Answers := ExpandConstant('{tmp}\saki-answers.json');
  SaveStringToFile(Answers,
    '{"botQQ":"' + JsonSafe(PageBasic.Values[0]) + '"' +
    ',"ownerQQ":"' + JsonSafe(PageBasic.Values[1]) + '"' +
    ',"apiKey":"' + JsonSafe(PageBasic.Values[2]) + '"' +
    ',"groups":"' + JsonSafe(PageBasic.Values[3]) + '"}', False);

  NodeExe := ExpandConstant('{app}\node\node.exe');
  Script := ExpandConstant('{app}\tools\first-run-setup.mjs');
  Params := '"' + Script + '" --answers "' + Answers + '" --force';

  if not FileExists(NodeExe) then
    ConfigNote := '⚠️ 找不到内嵌的 node.exe，config.yml 没生成（安装包可能不完整）。'
  else if not FileExists(Script) then
    ConfigNote := '⚠️ 找不到 tools\first-run-setup.mjs，config.yml 没生成。'
  else if Exec(NodeExe, Params, ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, Code) then
  begin
    if Code = 0 then
      ConfigNote := '✅ config.yml 已按你的填写生成。'
    else
      ConfigNote := '⚠️ 配置脚本返回了错误码 ' + IntToStr(Code) + '，请手动跑一次：' + #13#10 +
        '   node\tools\first-run-setup.mjs';
  end
  else
    ConfigNote := '⚠️ 没能运行配置脚本，请手动跑：node\tools\first-run-setup.mjs';

  { ── NapCat：勾了就下载 + 自动配置 ── }
  { ⚠️ 许可必须让用户**当场确认**（NapCat 是 Limited Redistribution License：不得商用）。
      这里是唯一一次问他的机会，别省。 }
  if WantsNapCat() then
  begin
    if MsgBox('接下来会从 NapCat 官方 Release 下载 NapCat（约 28 MB），并自动解压到' + #13#10 +
      ExpandConstant('{app}') + '\napcat\NapCat.Shell\、把端口和 token 配好。' + #13#10 + #13#10 +
      '请先确认你接受 NapCat 的许可（Limited Redistribution License，© 2024 Mlikiowa）：' + #13#10 +
      '  · 不得用于任何商业用途；' + #13#10 +
      '  · 再分发必须附许可全文并标明来源；' + #13#10 +
      '  · 程序按"原样"提供，不提供担保。' + #13#10 + #13#10 +
      '许可全文：https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE' + #13#10 + #13#10 +
      '现在开始下载吗？（下载窗口会显示进度；国内网络会慢，必要时先开代理）',
      mbConfirmation, MB_YESNO) = IDYES then
    begin
      NapParams := '"' + ExpandConstant('{app}\tools\install-napcat.mjs') + '" --bot-qq ' +
        JsonSafe(PageBasic.Values[0]) + ' --accept-license';
      if Exec(NodeExe, NapParams, ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, Code) then
      begin
        if Code = 0 then
          ConfigNote := ConfigNote + #13#10 + '✅ NapCat 已下载并配置好（接下来按提示扫码登录）。'
        else
          ConfigNote := ConfigNote + #13#10 + '⚠️ NapCat 没装成（错误码 ' + IntToStr(Code) +
            '）—— 装好后可以随时手动重跑：' + #13#10 + '   node\tools\install-napcat.mjs --bot-qq ' +
            JsonSafe(PageBasic.Values[0]) + ' --accept-license';
      end
      else
        ConfigNote := ConfigNote + #13#10 + '⚠️ 没能启动 NapCat 下载脚本。';
    end
    else
      ConfigNote := ConfigNote + #13#10 + '（你选了先不装 NapCat —— 想装时跑：node\tools\install-napcat.mjs --bot-qq ' +
        JsonSafe(PageBasic.Values[0]) + ' --accept-license）';
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  { 在最后一页（准备安装）之前，把配置脚本的结果告诉用户 }
  if (CurPageID = wpFinished) and (ConfigNote <> '') then
    WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10 + ConfigNote;
end;
