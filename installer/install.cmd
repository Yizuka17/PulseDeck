@echo off
setlocal

set "PULSEDECK_TARGET=%LOCALAPPDATA%\Programs\PulseDeck"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$target = [Environment]::ExpandEnvironmentVariables('%PULSEDECK_TARGET%');" ^
  "New-Item -ItemType Directory -Force -Path $target | Out-Null;" ^
  "Expand-Archive -LiteralPath '%~dp0PulseDeck.zip' -DestinationPath $target -Force;" ^
  "$shell = New-Object -ComObject WScript.Shell;" ^
  "$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Pulse Deck.lnk'));" ^
  "$shortcut.TargetPath = Join-Path $target 'PulseDeck.exe';" ^
  "$shortcut.WorkingDirectory = $target;" ^
  "$shortcut.IconLocation = Join-Path $target 'tray-icon.ico';" ^
  "$shortcut.Save();"

if errorlevel 1 (
  echo Pulse Deck installation failed.
  pause
  exit /b 1
)

start "" "%PULSEDECK_TARGET%\PulseDeck.exe"
exit /b 0
