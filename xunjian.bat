@echo off
chcp 65001 >nul
title 安全设备一键巡检工具
cd /d "%~dp0"
echo.
echo  正在启动安全设备一键巡检工具...
echo.
node xunjian_tool.js
pause
