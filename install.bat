@echo off
rem Note Tiger one-click installer for Windows.
setlocal
cd /d "%~dp0"
title Note Tiger installer
echo ==============================================
echo   Note Tiger installer
echo ==============================================
echo.

rem ---- 1. Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Installing it now...
  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  echo.
  echo Node.js is installed. Please CLOSE this window and double-click install.bat again.
  pause
  exit /b 0
)
for /f "delims=" %%v in ('node -v') do echo Found Node.js %%v

rem ---- 2. Packages ----
echo.
echo Installing the bot's packages...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo.
  echo npm install failed. Scroll up to see why.
  pause
  exit /b 1
)
if not exist ".env" copy ".env.example" ".env" >nul

rem ---- 3. Recap AI ----
echo.
echo Which AI should write the session recaps?
echo   1 = Free, runs on this PC (Ollama, about a 6.5 GB download)
echo   2 = Claude (smarter, needs a paid API key - you'll paste it in the control panel)
set "CHOICE=1"
set /p "CHOICE=Type 1 or 2 and press Enter [1]: "
if "%CHOICE%"=="2" goto speech
call setup-local-ai.bat nopause

:speech
rem ---- 4. Speech model ----
echo.
echo Downloading and testing the speech-to-text model...
call npm run test-speech

echo.
echo ==============================================
echo   All done!
echo   Double-click start-bot.bat. The control panel opens in
echo   your browser - paste your Discord token there.
echo ==============================================
pause
exit /b 0
