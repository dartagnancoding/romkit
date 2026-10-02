@echo off
rem ---------------------------------------------------------------------------
rem  Organizes everything in the inbox folder (Downloads\dump) into the ROM
rem  library. Double-click it: romkit shows the plan and asks before moving.
rem  Organized files leave the folder; anything with a problem stays there.
rem
rem  Extra options are passed through, e.g.:  "Organizar dump.bat" --dry-run
rem ---------------------------------------------------------------------------

rem UTF-8 so game names with accents display correctly.
chcp 65001 >nul

where romkit >nul 2>nul
if errorlevel 1 (
  echo romkit was not found. Open PowerShell in the romkit project folder and run: bun link
  echo.
  pause
  exit /b 1
)

romkit inbox %*
echo.
pause
