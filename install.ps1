# Installs (or updates) romkit for the current user, no admin needed:
#
#   irm https://raw.githubusercontent.com/dartagnancoding/romkit/main/install.ps1 | iex
#
# Downloads romkit.exe from the latest GitHub release into
# %LOCALAPPDATA%\Programs\romkit and adds that folder to the user PATH.
# Also installs aria2c with winget when it is missing (faster downloads; per-user,
# no admin). Then run `romkit init`: it asks for your folders and offers 7-Zip.
#
# For testing: ROMKIT_INSTALL_DIR, ROMKIT_DOWNLOAD_URL, ROMKIT_NO_PATH=1 and
# ROMKIT_NO_ARIA2=1 change the folder, the download, and skip the PATH change
# and the aria2c install.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is much slower with its progress bar

$installDir = if ($env:ROMKIT_INSTALL_DIR) { $env:ROMKIT_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\romkit' }
$downloadUrl = if ($env:ROMKIT_DOWNLOAD_URL) { $env:ROMKIT_DOWNLOAD_URL } else { 'https://github.com/dartagnancoding/romkit/releases/latest/download/romkit.exe' }
$exePath = Join-Path $installDir 'romkit.exe'

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$updating = Test-Path $exePath
Write-Host "Downloading romkit to $installDir ..."
# Download next to the old exe first, so a failed download leaves the old one working.
$tempPath = "$exePath.download"
Invoke-WebRequest -Uri $downloadUrl -OutFile $tempPath -UseBasicParsing
Move-Item -Force -Path $tempPath -Destination $exePath

if ($env:ROMKIT_NO_PATH -ne '1') {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($userPath -split ';' | Where-Object { $_ })
  if ($entries -notcontains $installDir) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $installDir) -join ';'), 'User')
    Write-Host "Added $installDir to your PATH."
  }
  # This window too, so `romkit` works right away.
  if (($env:Path -split ';') -notcontains $installDir) { $env:Path = "$env:Path;$installDir" }
}

# aria2c: several connections per file. romkit finds it on PATH or in winget's folders.
function Test-Aria2c {
  if (Get-Command aria2c -ErrorAction SilentlyContinue) { return $true }
  $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet'
  if (Test-Path (Join-Path $winget 'Links\aria2c.exe')) { return $true }
  return [bool](Get-ChildItem -Path (Join-Path $winget 'Packages\aria2.aria2*\*\aria2c.exe') -ErrorAction SilentlyContinue)
}
if ($env:ROMKIT_NO_ARIA2 -ne '1' -and -not (Test-Aria2c)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Installing aria2c (faster downloads)...'
    winget install --id aria2.aria2 -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
    if (Test-Aria2c) { Write-Host 'aria2c installed.' } else { Write-Host 'aria2c could not be installed; romkit will use its own downloader.' -ForegroundColor Yellow }
  } else {
    Write-Host 'Tip: install aria2c for faster downloads (https://aria2.github.io).' -ForegroundColor Yellow
  }
}

$version = & $exePath --version
if ($updating) {
  Write-Host "Updated: $version" -ForegroundColor Green
} else {
  Write-Host "Installed: $version" -ForegroundColor Green
  Write-Host 'Next step: run  romkit init'
}
