@echo off
chcp 65001 >nul
title GitHub Hub - stop Node
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":24524" ^| findstr "LISTENING"') do (
  echo 结束进程 PID=%%a
  taskkill /F /PID %%a >nul 2>nul
)
echo Node 服务已停止。
timeout /t 2 /nobreak >nul
