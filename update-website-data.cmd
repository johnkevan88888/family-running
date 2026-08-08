@echo off
setlocal
cd /d "%~dp0"

call pnpm run data:update
set "update_exit_code=%ERRORLEVEL%"

echo.
if not "%update_exit_code%"=="0" (
    echo The data update stopped safely. Nothing was merged or deployed.
)
pause
exit /b %update_exit_code%
