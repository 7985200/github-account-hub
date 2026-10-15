@echo off
chcp 65001 >nul
title GitHub Hub - stop MySQL
cd /d "%~dp0.."
echo 正在关闭 MySQL…
"%~dp0..\runtime\mysql\bin\mysqladmin.exe" -h 127.0.0.1 -P 3306 -u root -pRoot@Local2026 shutdown 2>nul
timeout /t 3 /nobreak >nul
netstat -ano | findstr ":3306" | findstr "LISTENING" >nul && (echo [警告] MySQL 仍在运行。) || (echo MySQL 已停止。)
pause
