# Updates the Job Board extension in place (Windows: Chrome, Edge, Brave).
#
#   irm https://job-two-xi.vercel.app/update-extension.ps1 | iex
#
# Finds the folder your browser loads the extension from (its "Load
# unpacked" folder, recorded in the browser profile), downloads the latest
# version from the job board and copies it over. Version 1.16 and later
# reload themselves within a minute. Older copies need one browser restart:
# the script offers to do it (your tabs reopen). Set JOB_BOARD_RESTART=1 to
# restart without asking, or 0 to never restart.
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
        $found += [pscustomobject]@{ Path = (Resolve-Path $path).Path; Version = $manifest.version; Root = $root }
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

# Browser restart (only for copies too old to reload themselves)
function Get-BrowserLabel($root) {
  switch -Wildcard ($root) {
    '*\Chrome Beta\*' { 'Chrome Beta'; break }
    '*\Google\Chrome\*' { 'Chrome'; break }
    '*\Microsoft\Edge\*' { 'Edge'; break }
    '*\Brave-Browser\*' { 'Brave'; break }
    '*\Chromium\*' { 'Chromium'; break }
    default { 'your browser' }
  }
}

# The profile folder a browser uses when started without --user-data-dir.
function Get-DefaultUserData($exe) {
  switch -Wildcard ($exe) {
    '*\Google\Chrome Beta\*' { "$env:LOCALAPPDATA\Google\Chrome Beta\User Data"; break }
    '*\Google\Chrome\*' { "$env:LOCALAPPDATA\Google\Chrome\User Data"; break }
    '*\Microsoft\Edge\*' { "$env:LOCALAPPDATA\Microsoft\Edge\User Data"; break }
    '*\BraveSoftware\Brave-Browser\*' { "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data"; break }
    '*\Chromium\*' { "$env:LOCALAPPDATA\Chromium\User Data"; break }
    default { $null }
  }
}

# Main (non-child) browser processes running the profile folder $root.
function Get-BrowserMain($root) {
  $want = $root.TrimEnd('\')
  @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $cmd = $_.CommandLine
    if (-not $cmd -or $cmd -match '--type=') { return $false }
    $dir = if ($cmd -match '--user-data-dir=(?:"([^"]+)"|(\S+))') { if ($matches[1]) { $matches[1] } else { $matches[2] } } else { Get-DefaultUserData $_.ExecutablePath }
    $dir -and ($dir.TrimEnd('\') -ieq $want)
  })
}

function Restart-Browsers($roots) {
  $running = @()
  foreach ($root in $roots) {
    # @() again: one process comes back unwrapped, and a lone CimInstance has no Count.
    $main = @(Get-BrowserMain $root)
    if ($main.Count) { $running += [pscustomobject]@{ Label = (Get-BrowserLabel $root); Procs = $main } }
  }
  if (-not $running) {
    Write-Host 'Your browser is closed: the new version loads the next time you open it.' -ForegroundColor Green
    return
  }
  $labels = ($running | ForEach-Object { $_.Label } | Sort-Object -Unique) -join ' and '
  $answer = $env:JOB_BOARD_RESTART
  if (-not $answer) {
    Write-Host ''
    try { $answer = Read-Host "Restart $labels now to finish the update? Your tabs reopen; anything typed into a page and not saved is lost. [Y/n]" } catch { $answer = 'n' }
    if ($null -eq $answer) { $answer = 'n' }
    if ($answer -eq '') { $answer = 'y' }
  }
  if ($answer -notmatch '^(y|yes|1)$') {
    Write-Host "Restart $labels yourself once (or click Reload on the extension in chrome://extensions)." -ForegroundColor Yellow
    return
  }
  foreach ($b in $running) {
    foreach ($p in $b.Procs) {
      $exe = $p.ExecutablePath
      # Keep the arguments it was started with (profile folder and so on).
      $cmd = $p.CommandLine.Trim()
      $rest = if ($cmd.StartsWith('"')) { $cmd.Substring($cmd.IndexOf('"', 1) + 1) } else { ($cmd -split '\s+', 2)[1] }
      $rest = ("$rest" -replace '--restore-last-session', '').Trim()
      & taskkill.exe /PID $p.ProcessId /T /F *> $null
      try { Wait-Process -Id $p.ProcessId -Timeout 15 -ErrorAction Stop } catch {}
      Start-Sleep -Milliseconds 500
      $argList = @($rest, '--restore-last-session') | Where-Object { $_ }
      Start-Process -FilePath $exe -ArgumentList ($argList -join ' ')
    }
    Write-Host ("Restarted {0}: the extension is on the new version and your tabs are back." -f $b.Label) -ForegroundColor Green
  }
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
    if ($newId) {
      Write-Host ''
      Write-Host "This copy was older than 1.12, so it gets a new ID this one time: connect it again with a token from $site/autofill." -ForegroundColor Yellow
    }
    # Copies older than 1.16 can't reload themselves: restart the browsers
    # that load them. Only the browser process for that profile is touched.
    $restartRoots = @($found | Where-Object { [version]$_.Version -lt [version]'1.16.0' } | ForEach-Object { $_.Root } | Sort-Object -Unique)
    Restart-Browsers $restartRoots
    Write-Host 'Future updates reload by themselves.'
  } else {
    Write-Host 'The extension reloads itself within a minute. Nothing else to do.'
    Write-Host '(If the extension still shows the old version after that, restart your browser once.)'
  }
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
