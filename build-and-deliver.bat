@echo off
REM build-arm64 then sync exe to the single desktop copy (Desktop\3.ini.exe). ASCII only, CRLF.
setlocal
set SRC_DIR=%~dp0
set TARGET_EXE=%SRC_DIR%src-tauri\target\aarch64-pc-windows-msvc\debug\floral-notepaper.exe
set DESKTOP_EXE=C:\Users\Lenovo\Desktop\3.ini.exe
echo [1/2] Building...
call "%SRC_DIR%build-arm64.bat"
if not exist "%TARGET_EXE%" goto :buildfail
echo [2/2] Syncing to desktop...
copy /y "%TARGET_EXE%" "%DESKTOP_EXE%" >nul
if errorlevel 1 goto :locked
echo Done.
for %%f in ("%DESKTOP_EXE%") do echo   %%~ff  %%~zf bytes
exit /b 0
:buildfail
echo [ERROR] build output missing: %TARGET_EXE%
exit /b 1
:locked
echo [ERROR] desktop exe is in use. Close 3.ini first, then rerun.
exit /b 1
