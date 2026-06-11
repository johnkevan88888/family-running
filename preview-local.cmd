@echo off
setlocal

cd /d "%~dp0"
set "PORT=8000"
set "URL=http://127.0.0.1:%PORT%/?site=family"

echo Starting local Family Running preview...
echo.
echo Family site:   http://127.0.0.1:%PORT%/?site=family
echo Everyone site: http://127.0.0.1:%PORT%/?site=everyone
echo.
echo Keep this window open while previewing. Press Ctrl+C to stop.
echo.

start "" "%URL%"

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 -m http.server %PORT% --bind 127.0.0.1
    goto :done
)

where python >nul 2>nul
if %errorlevel%==0 (
    python -m http.server %PORT% --bind 127.0.0.1
    goto :done
)

echo Python was not found on PATH.
echo Install Python or run a local static server from this folder.
pause

:done
endlocal
