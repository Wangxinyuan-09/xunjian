' 会话保活的无窗口启动器
'
' 为什么要它: 计划任务若直接 Exec cmd.exe, 因为 LogonType=InteractiveToken(必须如此, 否则
' launchPopup 拉起的人工输验证码浏览器窗口在桌面看不到), cmd/node 都是控制台程序 →
' 每 10 分钟在桌面上闪一个黑色 cmd 框(2026-09-11 用户反馈"一直弹 cmd 命令框")。
'
' 这里用 wscript.exe(无控制台) 启动, 再把子进程窗口样式设成 0=隐藏, 黑框就不再出现。
' 注意: session_activate 的 launchPopup 拉起的 Chromium 是独立 GUI 进程, 不受影响, 仍会正常弹给人看。
'
' 路径用 WScript.ScriptFullName 取, 避免在 .vbs 里写中文路径(WSH 按 ANSI 解析, 易乱码)

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
' 0 = 隐藏窗口, False = 不等待子进程结束(真正的互斥由 keepalive.lock 负责, 不靠计划任务)
sh.Run "cmd /c chcp 65001 >nul & node session_keepalive.js >> keepalive.log 2>&1", 0, False
