@echo off
title SafeSpend – Local Server
echo.
echo  ========================================
echo    SafeSpend - Starting Local Server
echo  ========================================
echo.

:: Try Node/npx first (faster)
where npx >nul 2>&1
if %errorlevel%==0 (
    echo  Starting with Node.js (npx serve)...
    echo  Open your browser at: http://localhost:3000
    echo  Press Ctrl+C to stop the server.
    echo.
    start "" http://localhost:3000
    npx serve . -l 3000
    goto :end
)

:: Fall back to Python 3
where python >nul 2>&1
if %errorlevel%==0 (
    echo  Starting with Python 3...
    echo  Open your browser at: http://localhost:8080
    echo  Press Ctrl+C to stop the server.
    echo.
    start "" http://localhost:8080
    python -m http.server 8080
    goto :end
)

:: Fall back to Python 2
where python2 >nul 2>&1
if %errorlevel%==0 (
    echo  Starting with Python 2...
    echo  Open your browser at: http://localhost:8080
    echo  Press Ctrl+C to stop the server.
    echo.
    start "" http://localhost:8080
    python2 -m SimpleHTTPServer 8080
    goto :end
)

echo  ERROR: Neither Node.js nor Python is installed.
echo.
echo  Please install one of:
echo    - Node.js:  https://nodejs.org
echo    - Python:   https://python.org
echo.
pause
:end
