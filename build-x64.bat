@echo off
REM HuaJian x64 build script (for Intel/AMD Windows machines).
REM Reason: this machine is ARM64, but the delivered package for friends
REM may need to run on ordinary x64 Windows. Cross-compile with the
REM x86_64 toolchain instead of the native ARM64 one.
setlocal

set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  echo [ERROR] vcvars64.bat not found
  exit /b 1
)

call "%VCVARS%" >nul
if errorlevel 1 (
  echo [ERROR] vcvars64.bat failed
  exit /b 1
)

cd /d "%~dp0src-tauri"
echo [INFO] building for x86_64-pc-windows-msvc with custom-protocol ...
cargo build --target x86_64-pc-windows-msvc --features custom-protocol %*
exit /b %errorlevel%
