; Note Tiger installer (NSIS). Built by installer/build.sh.
; Per-user install: no admin rights needed.
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "1.0.0"
!endif
!define APPNAME "Note Tiger"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NoteTiger"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Note Tiger"
InstallDirRegKey HKCU "Software\NoteTiger" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "Note Tiger ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "Note Tiger installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "yetimafia"
VIAddVersionKey "LegalCopyright" "yetimafia"

!define MUI_ICON "..\launcher\tiger.ico"
!define MUI_UNICON "..\launcher\tiger.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Welcome to Note Tiger"
!define MUI_WELCOMEPAGE_TEXT "Note Tiger listens to your tabletop RPG sessions on Discord, writes the recap for you, and answers questions about your campaign.$\r$\n$\r$\nEverything runs on this PC. No admin rights needed.$\r$\n$\r$\nClick Next to continue."
!define MUI_COMPONENTSPAGE_SMALLDESC
!define MUI_FINISHPAGE_RUN "$INSTDIR\Note Tiger.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Note Tiger now"
!define MUI_FINISHPAGE_TEXT "Note Tiger is installed.$\r$\n$\r$\nWhen it starts, a tiger icon appears by the clock and the control panel opens in your browser. Paste your Discord bot token in Settings and you're ready.$\r$\n$\r$\nThe first start downloads the speech model (a few hundred MB)."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Ask a running copy to shut down cleanly (it saves any recording in progress).
!macro StopRunningCopy
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3080/api/stop -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null; Start-Sleep -Seconds 4 } catch {}"`
  Pop $0
  nsExec::Exec `taskkill /F /IM "Note Tiger.exe"`
  Pop $0
!macroend

Section "Note Tiger (required)" SecMain
  SectionIn RO
  !insertmacro StopRunningCopy

  SetOutPath "$INSTDIR"
  File "..\launcher\tiger.ico"
  File "${STAGE}\Note Tiger.exe"

  SetOutPath "$INSTDIR\runtime"
  File "${STAGE}\runtime\node.exe"

  ; Replace the app code but keep the user's settings (.env), sessions (data\) and downloaded models.
  RMDir /r "$INSTDIR\app\node_modules"
  SetOutPath "$INSTDIR\app"
  File /r "${STAGE}\app\*.*"

  ; Start menu + uninstall entry
  CreateDirectory "$SMPROGRAMS\Note Tiger"
  CreateShortcut "$SMPROGRAMS\Note Tiger\Note Tiger.lnk" "$INSTDIR\Note Tiger.exe" "" "$INSTDIR\tiger.ico"
  CreateShortcut "$SMPROGRAMS\Note Tiger\Uninstall Note Tiger.lnk" "$INSTDIR\Uninstall.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\NoteTiger" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Note Tiger"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "yetimafia"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\tiger.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Desktop shortcut" SecDesktop
  CreateShortcut "$DESKTOP\Note Tiger.lnk" "$INSTDIR\Note Tiger.exe" "" "$INSTDIR\tiger.ico"
SectionEnd

Section /o "Start with Windows" SecStartup
  CreateShortcut "$SMSTARTUP\Note Tiger.lnk" "$INSTDIR\Note Tiger.exe" "" "$INSTDIR\tiger.ico"
SectionEnd

Section "Free local AI for recaps (Ollama, ~6.5 GB download)" SecOllama
  DetailPrint "Setting up the free local AI. A window will show the download progress..."
  ExecWait `"$SYSDIR\cmd.exe" /c ""$INSTDIR\app\setup-local-ai.bat" nopause"` $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "The local AI setup didn't finish.$\r$\n$\r$\nYou can try again later from the Note Tiger control panel (Dashboard → Install free local AI), or use Claude instead in Settings." /SD IDOK
  ${EndIf}
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "The bot, its control panel, and everything it needs to run."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Put a Note Tiger icon on your desktop."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartup} "Start Note Tiger automatically when you log in to Windows."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecOllama} "Installs Ollama and a free AI model so recaps cost nothing and never leave your PC. Skip this if you'll use a Claude API key instead, or if it's already installed."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  !insertmacro StopRunningCopy
  Delete "$DESKTOP\Note Tiger.lnk"
  Delete "$SMSTARTUP\Note Tiger.lnk"
  RMDir /r "$SMPROGRAMS\Note Tiger"

  Delete "$INSTDIR\Note Tiger.exe"
  Delete "$INSTDIR\tiger.ico"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\app\node_modules"
  RMDir /r "$INSTDIR\app\models"
  RMDir /r "$INSTDIR\app\logs"
  Delete "$INSTDIR\app\*.js"
  Delete "$INSTDIR\app\*.html"
  Delete "$INSTDIR\app\*.json"
  Delete "$INSTDIR\app\*.bat"
  Delete "$INSTDIR\app\.env.example"

  MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your settings and all recorded sessions (transcripts and recaps)?$\r$\n$\r$\nChoose No to keep them for a future install." /SD IDNO IDNO keepData
    RMDir /r "$INSTDIR\app\data"
    Delete "$INSTDIR\app\.env"
  keepData:
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR\app"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\NoteTiger"
  MessageBox MB_OK "Note Tiger was removed. Ollama (the local AI) is a separate program; uninstall it from Windows Settings → Apps if you don't need it." /SD IDOK
SectionEnd
