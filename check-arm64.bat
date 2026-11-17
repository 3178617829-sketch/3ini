@echo off
REM HuaJian ARM64 check script (cargo check only, no build).
REM Same env setup as build-arm64.bat: vcvarsarm64 first so ring can find clang.
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
echo [INFO] cargo check for aarch64-pc-windows-msvc ...
cargo check --target aarch64-pc-windows-msvc --features custom-protocol %*
exit /b %errorlevel%
