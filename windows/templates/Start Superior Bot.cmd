@echo off
setlocal
cd /d "%~dp0"

if /I "%~1"=="--version" goto version
if /I "%~1"=="--check" goto check
if /I "%~1"=="--help" goto help
if not "%~1"=="" goto unknown

if not exist ".env" (
  echo Missing .env beside this launcher.
  echo Copy .env.example to .env and add your Discord token.
  exit /b 2
)

"%~dp0runtime\node.exe" "%~dp0app\dist\src\index.js"
exit /b %ERRORLEVEL%

:version
set /p SUPERIOR_VERSION=<"%~dp0VERSION"
echo Superior Bot %SUPERIOR_VERSION%
exit /b 0

:check
"%~dp0runtime\node.exe" "%~dp0tools\check-portable.mjs"
exit /b %ERRORLEVEL%

:help
echo Start Superior Bot.cmd [--check ^| --version ^| --help]
echo Run without an option to start the Discord bot.
exit /b 0

:unknown
echo Unknown option. Use --help for supported options. 1>&2
exit /b 2
