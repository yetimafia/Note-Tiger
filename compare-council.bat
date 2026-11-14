@echo off
rem Compares one AI with the council on a past session (works on a copy; nothing is changed).
rem   compare-council.bat                the latest session
rem   compare-council.bat ^<session id^>   a specific one
rem   add "single" or "council" to run only that half
cd /d "%~dp0"
set "NODE=%~dp0..\runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" compare-council.mjs %*
echo.
echo The report is in logs\council-compare\report.txt
pause
