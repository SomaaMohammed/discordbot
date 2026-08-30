@echo off
setlocal

set "PWSH=%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe"
if not exist "%PWSH%" (
  echo PowerShell 7 was not found at "%PWSH%". 1>&2
  exit /b 1
)

"%PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-and-run.ps1" %*
exit /b %ERRORLEVEL%
