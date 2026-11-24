# Updates the Job Board extension in place (Windows: Chrome, Edge, Brave).
#
#   irm https://job-two-xi.vercel.app/update-extension.ps1 | iex
#
# Finds the folder your browser loads the extension from (its "Load
# unpacked" folder, recorded in the browser profile), downloads the latest
# version from the job board and copies it over. Version 1.16 and later
# reload themselves within a minute; older copies need one browser restart.
# Nothing else is changed, and nothing is sent anywhere.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$site = if ($env:JOB_BOARD_SITE) { $env:JOB_BOARD_SITE } else { 'https://job-two-xi.vercel.app' }
$id = 'deleknoaeibijjmfngfobapnpbekhcel'
$name = 'Job Board Capture'

$roots = if ($env:JOB_BOARD_PROFILES) { @($env:JOB_BOARD_PROFILES) } else { @(
  "$env:LOCALAPPDATA\Google\Chrome\User Data",
  "$env:LOCALAPPDATA\Google\Chrome Beta\User Data",
  "$env:LOCALAPPDATA\Microsoft\Edge\User Data",
  "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data",
  "$env:LOCALAPPDATA\Chromium\User Data"
) }

# Unpacked extensions (location 4) that are this one: by its ID, or (older
# copies with another ID) by the name in the folder's manifest.
$found = @()
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  $files = Get-ChildItem $root -Recurse -Depth 1 -Include 'Preferences', 'Secure Preferences' -File -ErrorAction SilentlyContinue
  foreach ($file in $files) {
    try { $json = Get-Content $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
    $settings = $json.extensions.settings
    if (-not $settings) { continue }
    foreach ($entry in $settings.PSObject.Properties) {
      $path = $entry.Value.path
      # 4 = "Load unpacked"; 8 = loaded with --load-extension.
      if (-not $path -or @(4, 8) -notcontains $entry.Value.location) { continue }
      $manifestPath = Join-Path $path 'manifest.json'
      if (-not (Test-Path $manifestPath)) { continue }
      try { $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
      if ($entry.Name -eq $id -or $manifest.name -eq $name) {
        $found += [pscustomobject]@{ Path = (Resolve-Path $path).Path; Version = $manifest.version }
      }
    }
  }
}
$found = $found | Sort-Object Path -Unique

if (-not $found) {
  Write-Host "Couldn't find the extension in Chrome, Edge or Brave." -ForegroundColor Yellow
  Write-Host "Install it once from $site/autofill (Load unpacked), then run this again."
  return
}

$tmp = Join-Path $env:TEMP ('job-board-extension-' + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'extension.zip'
  Invoke-WebRequest "$site/downloads/job-board-extension.zip" -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath $tmp -Force
  $src = Join-Path $tmp 'job-board-extension'
  $latest = (Get-Content (Join-Path $src 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $needsRestart = $false
  $newId = $false
  foreach ($target in $found) {
    Copy-Item -Path (Join-Path $src '*') -Destination $target.Path -Recurse -Force
    Write-Host ("Updated {0}: {1} -> {2}" -f $target.Path, $target.Version, $latest) -ForegroundColor Green
    # Older than 1.16: no self-reload yet. Older than 1.12: no fixed ID yet.
    if ([version]$target.Version -lt [version]'1.16.0') { $needsRestart = $true }
    if ([version]$target.Version -lt [version]'1.12.0') { $newId = $true }
  }
  if ($needsRestart) {
    Write-Host ''
    Write-Host 'Restart your browser once (or click Reload on the extension in chrome://extensions).' -ForegroundColor Yellow
    if ($newId) {
      Write-Host "This copy was older than 1.12, so it gets a new ID this one time: connect it again with a token from $site/autofill." -ForegroundColor Yellow
    }
    Write-Host 'Future updates reload by themselves.' -ForegroundColor Yellow
  } else {
    Write-Host 'The extension reloads itself within a minute. Nothing else to do.'
    Write-Host '(If the extension still shows the old version after that, restart your browser once.)'
  }
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
