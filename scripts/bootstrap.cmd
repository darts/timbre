@echo off
rem -------------------------------------------------------------------------
rem  Timbre - zero-prereq Windows bootstrap.
rem
rem  Use this from a fresh clone when you don't yet have pnpm/Node/Rust.
rem
rem  Right-click -> "Run as administrator" if VS Build Tools or WebView2
rem  Runtime are not already installed. The PowerShell script will check
rem  and bail with instructions if not elevated.
rem
rem  Prefers pwsh.exe (PowerShell 7+) when available; falls back to the
rem  built-in PowerShell 5.1 (powershell.exe) which ships on every Win10/11.
rem
rem  Forwards extra args to setup-windows.ps1 (e.g. -SkipToolchain).
rem -------------------------------------------------------------------------
setlocal

set "SCRIPT_DIR=%~dp0"
set "SETUP=%SCRIPT_DIR%setup-windows.ps1"

if not exist "%SETUP%" (
  echo ERROR: cannot find %SETUP%
  echo Make sure you ran this from a checkout of the Timbre repo.
  pause
  exit /b 1
)

where pwsh.exe >nul 2>&1
if %ERRORLEVEL%==0 (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%SETUP%" %*
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SETUP%" %*
)
set "RC=%ERRORLEVEL%"

rem Pause on error so a double-click invocation doesn't close the window
rem before the user can read the message. Success is silent so this is
rem still usable from CI or scripts.
if not "%RC%"=="0" (
  echo.
  echo Setup exited with code %RC%.
  pause
)

endlocal & exit /b %RC%
