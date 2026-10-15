@echo off
chcp 65001 >nul
title GitHub Hub - Node 服务 (127.0.0.1:24524)
cd /d "%~dp0.."
echo ============================================
echo   GitHub 多账号管家
echo   访问地址：http://127.0.0.1:24524
echo   关闭本窗口即停止服务
echo ============================================
echo.
node server\index.js
pause
