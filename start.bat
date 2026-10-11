@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Peppa Pig Player

rem Node.js가 있으면 Node 서버, 없으면 Windows 기본 PowerShell 서버로 실행한다.
where node >nul 2>nul
if %errorlevel%==0 (
  echo Peppa Pig Player를 시작합니다... ^(Node.js^)
  node server.js --open
) else (
  echo Peppa Pig Player를 시작합니다... ^(PowerShell^)
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Open
)

if errorlevel 1 (
  echo.
  echo 실행 중 문제가 발생했습니다. 위 메시지를 확인해 주세요.
  pause
)
