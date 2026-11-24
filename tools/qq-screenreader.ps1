# 打开系统的"屏幕阅读器已启用"标志。
# Chromium/Electron 的 a11y 树是按需构建的：它通过 SystemParametersInfo(SPI_GETSCREENREADER)
# 判断"有没有辅助技术在用"，没有就一直不建树（即使带了 --force-renderer-accessibility，
# 某些版本也只是"允许"而非"强制"）。
# 设这个标志 = 告诉系统"有辅助技术在工作"，Chromium 就会把 a11y 树建起来。
param([ValidateSet('on','off','query')][string]$Action = 'query')

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SR{
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref bool pvParam, uint fWinIni);
  public static bool Get(){
    bool v = false;
    SystemParametersInfo(0x0046 /*SPI_GETSCREENREADER*/, 0, ref v, 0);
    return v;
  }
  public static bool Set(bool on){
    bool v = on;
    return SystemParametersInfo(0x0047 /*SPI_SETSCREENREADER*/, on ? 1u : 0u, ref v, 0x01 | 0x02);
  }
}
'@

switch ($Action) {
  'query' { Write-Output ("screenreader=" + [SR]::Get()) }
  'on'    { $ok = [SR]::Set($true);  Start-Sleep -Milliseconds 300; Write-Output ("setOn=" + $ok + " now=" + [SR]::Get()) }
  'off'   { $ok = [SR]::Set($false); Start-Sleep -Milliseconds 300; Write-Output ("setOff=" + $ok + " now=" + [SR]::Get()) }
}
