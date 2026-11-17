@echo off
REM HuaJian ARM64 test script.
REM Same env setup as build-arm64.bat: vcvarsarm64 first so ring can find clang.
REM Skips updater::download tests: cancels_download_and_cleans_partial_file
REM hangs forever in this project (pre-existing, unrelated to our changes).
setlocal

set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsarm64.bat"
if not exist "%VCVARS%" (
  echo [ERROR] vcvarsarm64.bat not found
  exit /b 1
)

call "%VCVARS%" >nul
if errorlevel 1 (
  echo [ERROR] vcvarsarm64.bat failed
  exit /b 1
)

cd /d "%~dp0src-tauri"
echo [INFO] cargo test for aarch64-pc-windows-msvc ...
cargo test --target aarch64-pc-windows-msvc --features custom-protocol -- --skip updater::download %*
exit /b %errorlevel%
