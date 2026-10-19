@echo off
chcp 65001 >nul
title ShuJiang - AI Novel Studio
cd /d "%~dp0"

set "NODE=tools\node\node.exe"
if not exist "%NODE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   [ERROR] Node runtime not found.
    echo.
    echo   Option 1: unzip a portable Node.js build into:  tools\node\
    echo             ^(so that tools\node\node.exe exists^)
    echo   Option 2: install Node 18 or newer, then run this file again.
    echo.
    pause
    exit /b 1
  )
  set "NODE=node"
)

"%NODE%" "server\server.js"
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo   [ERROR] Server exited with code %CODE%.
  echo.
  pause
)
