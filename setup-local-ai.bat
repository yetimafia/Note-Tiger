@echo off
rem Installs Ollama (free local AI) and downloads the model the bot uses.
rem Run it on its own any time, or let install.bat run it for you.
cd /d "%~dp0"
echo.
echo === Note Tiger: local AI setup ===
set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"

if exist "%OLLAMA_EXE%" (
  echo Ollama is already installed.
) else (
  echo Installing Ollama... ^(about 1.5 GB^)
  winget install --id Ollama.Ollama -e --accept-package-agreements --accept-source-agreements
  if not exist "%OLLAMA_EXE%" (
    echo.
    echo Could not install Ollama automatically.
    echo Download it from https://ollama.com/download, install it, then run this file again.
    if /i not "%~1"=="nopause" pause
    exit /b 1
  )
)

echo.
echo Starting Ollama...
start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
timeout /t 8 /nobreak >nul

echo.
echo Downloading the AI model ^(about 5 GB, this can take a while^)...
"%OLLAMA_EXE%" pull llama3.1:8b
if errorlevel 1 (
  echo.
  echo The model download failed. Check your internet and run setup-local-ai.bat again.
  if /i not "%~1"=="nopause" pause
  exit /b 1
)
echo Local AI is ready.
if /i not "%~1"=="nopause" pause
exit /b 0
