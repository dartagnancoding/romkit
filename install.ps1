# Installs (or updates) romkit for the current user, no admin needed:
#
#   irm https://raw.githubusercontent.com/dartagnancoding/romkit/main/install.ps1 | iex
#
# Downloads romkit.exe from the latest GitHub release into
# %LOCALAPPDATA%\Programs\romkit and adds that folder to the user PATH.
# Then run `romkit init`: it asks for your folders and offers to install 7-Zip
# and aria2c with winget.
#
# For testing: ROMKIT_INSTALL_DIR, ROMKIT_DOWNLOAD_URL and ROMKIT_NO_PATH=1
# change the folder, the download and skip the PATH change.

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

$version = & $exePath --version
if ($updating) {
  Write-Host "Updated: $version" -ForegroundColor Green
} else {
  Write-Host "Installed: $version" -ForegroundColor Green
  Write-Host 'Next step: run  romkit init'
}
