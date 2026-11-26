@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Document Index Tools

where python >nul 2>nul
if errorlevel 1 goto NOPYTHON

:MENU
cls
echo ==================================================
echo   Document Index Tools
echo   Workspace: article collection
echo ==================================================
echo.
echo   [1] Full execution - re-parse every document
echo   [2] Incremental execution - new or changed docs only
echo   [3] Check - index + dirty data + duplicates, read-only
echo   [4] Clean dirty data - move junk to Recycle Bin
echo   [0/Q/Esc] Exit
echo.
if defined MSG (
  echo   %MSG%
  set "MSG="
  echo.
)
echo   Press 1-4, or Enter for default [2]. Q / Esc / 0 exits.
set "KEY="
for /f "delims=" %%K in ('powershell -NoProfile -Command "[Console]::ReadKey($true).Key"') do set "KEY=%%K"
if not defined KEY goto TYPED
if /i "%KEY%"=="Enter" goto INC
if /i "%KEY%"=="D1" goto FULL
if /i "%KEY%"=="NumPad1" goto FULL
if /i "%KEY%"=="D2" goto INC
if /i "%KEY%"=="NumPad2" goto INC
if /i "%KEY%"=="D3" goto CHECK
if /i "%KEY%"=="NumPad3" goto CHECK
if /i "%KEY%"=="D4" goto CLEAN
if /i "%KEY%"=="NumPad4" goto CLEAN
if /i "%KEY%"=="Escape" goto END
if /i "%KEY%"=="Q" goto END
if /i "%KEY%"=="D0" goto END
if /i "%KEY%"=="NumPad0" goto END
set "MSG=Invalid key. Press 1-4, Enter for default 2, or Q / Esc / 0 to exit."
goto MENU

:TYPED
echo.
echo   Single-key input unavailable. Type an option and press Enter.
set "SEL="
set /p "SEL=Select an option [2]: "
if not defined SEL set "SEL=2"
if /i "%SEL%"=="q" goto END
if "%SEL%"=="0" goto END
if "%SEL%"=="1" goto FULL
if "%SEL%"=="2" goto INC
if "%SEL%"=="3" goto CHECK
if "%SEL%"=="4" goto CLEAN
set "MSG=Invalid option. Press 1-4, Enter for default 2, or Q / 0 to exit."
goto MENU

:FULL
echo.
echo Running full execution ...
echo.
python "%~dp0build_index.py" --mode full
echo.
pause
goto MENU

:INC
echo.
echo Running incremental execution ...
echo.
python "%~dp0build_index.py" --mode incremental
echo.
pause
goto MENU

:CHECK
echo.
echo Running check (read-only health report) ...
echo.
python "%~dp0build_index.py" --mode check
echo.
pause
goto MENU

:CLEAN
echo.
echo Running dirty data cleanup ...
echo.
python "%~dp0build_index.py" --mode cleanup
echo.
pause
goto MENU

:NOPYTHON
echo.
echo Python was not found in PATH. Install Python 3 and retry.
echo.
pause
goto END

:END
endlocal
exit /b 0
