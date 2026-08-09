@echo off
setlocal
cd /d "%~dp0"

set "node_exe="

where node.exe >nul 2>nul
if not errorlevel 1 set "node_exe=node.exe"

if not defined node_exe if exist "%ProgramFiles%\nodejs\node.exe" set "node_exe=%ProgramFiles%\nodejs\node.exe"
if not defined node_exe if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "node_exe=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined node_exe if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "node_exe=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not defined node_exe (
    echo Could not find the Node runtime used by the data updater.
    echo Open Codex and ask it to repair the Family Running data updater.
    set "update_exit_code=1"
    goto update_finished
)

"%node_exe%" "%~dp0scripts\simple-data-update.mjs" %*
set "update_exit_code=%ERRORLEVEL%"

:update_finished
echo.
if not "%update_exit_code%"=="0" (
    echo The data update stopped safely. Nothing was merged or deployed.
)
pause
exit /b %update_exit_code%
