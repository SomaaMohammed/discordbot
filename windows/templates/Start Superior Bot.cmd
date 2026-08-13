@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0SuperiorBot.exe" (
  echo The packaged SuperiorBot.exe launcher is missing. 1>&2
  exit /b 1
)
if not "%~2"=="" goto unknown
if "%~1"=="" goto start
if /I "%~1"=="--version" goto option
if /I "%~1"=="--check" goto option
if /I "%~1"=="--diagnostics" goto option
if /I "%~1"=="--help" goto option
goto unknown

:start
"%~dp0SuperiorBot.exe"
exit /b %ERRORLEVEL%

:option
"%~dp0SuperiorBot.exe" "%~1"
exit /b %ERRORLEVEL%

:unknown
echo Unknown option. Use --help for supported options. 1>&2
exit /b 2
