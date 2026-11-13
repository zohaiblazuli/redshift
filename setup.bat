@echo off
rem Redshift - one-click setup for a fresh clone.
rem Installs what is missing (Node.js; Python + numpy/pillow/scipy for the bake tools),
rem rebuilds index.html and launches the local server (same as start.bat).
setlocal
title Redshift setup
cd /d "%~dp0"
echo.
echo === Redshift setup ===
echo.

rem ---- Node.js (required: runs the server and the build) --------------------------------
where node >nul 2>nul
if not errorlevel 1 goto node_ok
echo Node.js not found. Installing Node.js LTS with winget...
where winget >nul 2>nul
if errorlevel 1 goto no_winget
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto node_restart
:node_ok
for /f "delims=" %%v in ('node --version') do echo [ok] Node.js %%v

rem ---- Python (optional: only the bake scripts in tools\ use it) ------------------------
python -c "import sys" >nul 2>nul
if not errorlevel 1 goto py_ok
echo Python not found. Installing Python 3.12 with winget...
where winget >nul 2>nul
if errorlevel 1 goto py_skip
winget install -e --id Python.Python.3.12 --scope user --accept-source-agreements --accept-package-agreements --silent
set "PATH=%LocalAppData%\Programs\Python\Python312;%LocalAppData%\Programs\Python\Python312\Scripts;%PATH%"
python -c "import sys" >nul 2>nul
if errorlevel 1 goto py_skip
:py_ok
for /f "delims=" %%v in ('python --version') do echo [ok] %%v
echo Installing Python packages (numpy, pillow, scipy)...
python -m pip install --disable-pip-version-check -q -r tools\requirements.txt
if errorlevel 1 (echo [warn] pip install failed - the app still runs; only tools\*.py need these.) else (echo [ok] Python packages)
goto build
:py_skip
echo [warn] Python not available - skipped. The app runs without it; only tools\*.py need it.

rem ---- Build and launch --------------------------------------------------------------------
:build
echo.
echo Building index.html...
node build.js
if errorlevel 1 goto build_fail
if not exist tilecache mkdir tilecache
echo.
echo [ok] Setup complete. Next time just run start.bat.
echo Launching Redshift at http://localhost:8080 (close this window to stop the server)...
echo.
call "%~dp0start.bat"
goto :eof

:no_winget
echo [error] winget is not available. Install Node.js LTS from https://nodejs.org, then run setup.bat again.
pause
exit /b 1
:node_restart
echo [error] Node.js was installed but is not on PATH yet. Close this window and run setup.bat again.
pause
exit /b 1
:build_fail
echo [error] Build failed - see the message above.
pause
exit /b 1
