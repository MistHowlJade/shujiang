@echo off
chcp 65001 >nul
title ShuJiang - AI Novel Studio
cd /d "%~dp0"

rem Dev-only launcher: remove this file when packaging the desktop app.
rem Two servers would write the same data folder, so if ShuJiang is already
rem answering, just open it again instead of starting a second instance.

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

set "PORT=%SHU_PORT%"
if not defined PORT set "PORT=8848"

"%NODE%" -e "fetch('http://127.0.0.1:%PORT%/',{signal:AbortSignal.timeout(1500)}).then(function(r){return r.ok?r.text():Promise.reject()}).then(function(t){process.exit(t.indexOf('shelfGrid')!==-1?0:1)}).catch(function(){process.exit(1)})"
if not errorlevel 1 (
  echo.
  echo   ShuJiang is already running at http://127.0.0.1:%PORT%
  if not "%SHU_NO_OPEN%"=="1" start "" "http://127.0.0.1:%PORT%"
  echo   Close this window; the running server is not affected.
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

echo.
echo   Starting ShuJiang...
echo   Keep this window open. Close it to stop the server.
echo.

"%NODE%" "server\server.js"
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo   [ERROR] Server exited with code %CODE%.
  echo.
  pause
)
