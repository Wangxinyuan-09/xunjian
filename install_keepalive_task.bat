@echo off
chcp 65001 >nul
rem 注册 Windows 计划任务: 每 10 分钟跑一次会话保活, 使巡检会话不过期
rem 需以管理员身份运行本脚本一次(或由系统计划任务管理员创建)
rem
rem 2026-09-11 修了两个坑(务必保留):
rem  1) 动作经 keepalive_hidden.vbs 用 wscript 启动, 窗口样式 0=隐藏。
rem     直接 Exec cmd.exe 会因 LogonType=InteractiveToken 每 10 分钟弹一个黑框。
rem  2) /xml 注册时 IdleSettings.StopOnIdleEnd 必须为 false。
rem     默认 true 表示"电脑一离开空闲就终止任务" —— 用户一动鼠标, 保活刚启动几秒就被杀,
rem     留下没过期的 keepalive.lock, 下一轮被判"上一次仍在运行"而跳过, 会话必然过期。
set BASE=%~dp0
set TASK=xunjian_keepalive
set XML=%TEMP%\_xunjian_keepalive.xml

echo 正在注册计划任务 %TASK% (每10分钟, 隐藏窗口)...
powershell -NoProfile -Command ^
  "$x = '<?xml version=\"1.0\" encoding=\"UTF-16\"?><Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"><Settings><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd></IdleSettings></Settings><Triggers><TimeTrigger><StartBoundary>2026-01-01T00:00:00</StartBoundary><Repetition><Interval>PT10M</Interval></Repetition></TimeTrigger></Triggers><Actions Context=\"Author\"><Exec><Command>wscript.exe</Command><Arguments>\"%BASE%keepalive_hidden.vbs\"</Arguments></Exec></Actions></Task>'; [System.IO.File]::WriteAllText('%XML%', $x, [System.Text.Encoding]::Unicode)"
schtasks /create /f /tn "%TASK%" /xml "%XML%"

if %errorlevel%==0 (
  echo.
  echo [OK] 计划任务已创建: %TASK%
  echo      频率: 每10分钟   启动器: keepalive_hidden.vbs ^(无窗口^)
  echo      真正的互斥靠 keepalive.lock, 不靠计划任务的"仅一个实例"
) else (
  echo.
  echo [失败] 创建计划任务失败(可能需要管理员权限), 请右键"以管理员身份运行"。
)
pause
