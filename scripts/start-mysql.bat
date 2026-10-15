@echo off
chcp 65001 >nul
title GitHub Hub - MySQL
cd /d "%~dp0.."
echo 正在启动 MySQL（127.0.0.1:3306）…
start "GH-Hub MySQL" /min "%~dp0..\runtime\mysql\bin\mysqld.exe" --defaults-file="%~dp0..\runtime\my.ini"
timeout /t 5 /nobreak >nul
netstat -ano | findstr ":3306" | findstr "LISTENING" >nul && (echo MySQL 已启动。) || (echo [警告] 3306 未监听，请查看 runtime\mysql\mysql-error.log)
pause
