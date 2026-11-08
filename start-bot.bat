@echo off
cd /d "%~dp0"
title Note Tiger
if not exist node_modules (
  echo The bot isn't installed yet. Double-click install.bat first.
  pause
  exit /b 1
)
:run
echo Starting Note Tiger... (close this window to stop the bot)
echo Control panel: http://localhost:3080
echo.
node index.js
if "%errorlevel%"=="75" goto restart
echo.
echo The bot stopped.
pause
exit /b 0
:restart
set "NT_RESTARTED=1"
echo.
echo Restarting with new settings...
goto run
