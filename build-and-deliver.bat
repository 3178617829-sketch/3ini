@echo off
REM Build frontend, then arm64 Rust, then sync exe to the single desktop copy (Desktop\3.ini.exe).
REM ASCII only, CRLF.
REM Usage:  build-and-deliver.bat            -> debug build
REM         build-and-deliver.bat --release  -> optimized release build
setlocal
set "SRC_DIR=%~dp0"
set "PROFILE=debug"
set "FLAG="
if /I "%~1"=="--release" (
  set "PROFILE=release"
  set "FLAG=--release"
)
set "TARGET_EXE=%SRC_DIR%src-tauri\target\aarch64-pc-windows-msvc\%PROFILE%\floral-notepaper.exe"
set "DESKTOP_EXE=%USERPROFILE%\Desktop\3.ini.exe"

REM The webview assets are embedded at cargo build time, so the frontend MUST be
REM rebuilt first. Skipping this is how a panel.ts change silently ships stale UI.
echo [1/3] Building frontend ...
pushd "%SRC_DIR%"
call npm run build
set "FE_RC=%ERRORLEVEL%"
popd
if not "%FE_RC%"=="0" goto :buildfail

echo [2/3] Building Rust (%PROFILE%) ...
call "%SRC_DIR%build-arm64.bat" %FLAG%
if errorlevel 1 goto :buildfail
if not exist "%TARGET_EXE%" goto :buildfail

echo [3/3] Syncing to desktop ...
copy /y "%TARGET_EXE%" "%DESKTOP_EXE%" >nul
if errorlevel 1 goto :locked
echo Done.
for %%f in ("%DESKTOP_EXE%") do echo   %%~ff  %%~zf bytes
exit /b 0

:buildfail
echo [ERROR] build failed or output missing: %TARGET_EXE%
exit /b 1

:locked
echo [ERROR] desktop exe is in use. Close 3.ini first, then rerun.
exit /b 1
