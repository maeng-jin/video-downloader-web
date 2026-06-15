@echo off
REM UTF-8 console so the server's Korean log lines render correctly
chcp 65001 >nul
setlocal enabledelayedexpansion
title video-downloader-web (port 37020)

REM ===== config =====
set "PORT=37020"
REM move to this script's folder (works from any location)
cd /d "%~dp0"

echo ============================================================
echo  video-downloader-web  -  restart  (port %PORT%)
echo ============================================================

REM ----- 1) stop existing server on the port -----
echo [1/2] Stopping existing server on port %PORT% ...
set "KILLED="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    echo        - killing PID %%a
    taskkill /F /PID %%a >nul 2>&1
    set "KILLED=1"
)
if not defined KILLED echo        (no running server found)

REM ----- 2) start server -----
echo [2/2] Starting server ...  (press Ctrl+C to stop)
echo.
node server.js

echo.
echo [!] Server has stopped.
pause
