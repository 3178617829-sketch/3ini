@echo off
REM HuaJian ARM64 build script.
REM Reason: cargo started from a plain terminal has no VS env vars
REM (VCINSTALLDIR / INCLUDE / LIB are all empty), so ring's build script
REM cannot find clang and fails.
REM Fix: call vcvarsarm64.bat first to put the native ARM64 toolchain on PATH.
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
echo [INFO] building for aarch64-pc-windows-msvc with custom-protocol ...
cargo build --target aarch64-pc-windows-msvc --features custom-protocol %*
exit /b %errorlevel%