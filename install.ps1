<#
.SYNOPSIS
  Loom one-line installer for Windows (PowerShell 5.1+ / 7+).

.DESCRIPTION
  Run as a one-liner:

      irm https://raw.githubusercontent.com/DanielC000/loom/main/install.ps1 | iex

  Piping a script to a shell runs unreviewed code; if you'd rather inspect first (or verify its
  SHA-256 checksum), run it from a local checkout instead:

      pwsh -ExecutionPolicy Bypass -File .\install.ps1            # interactive
      pwsh -ExecutionPolicy Bypass -File .\install.ps1 -Service   # also register autostart
      pwsh -ExecutionPolicy Bypass -File .\install.ps1 -NoStart   # install only

  What it does (IDEMPOTENT - safe to re-run; `npm i -g` upgrades in place):
    1. Ensure Node 22+ is on PATH. It DETECTS Node and, if missing/too old, prints a guide and exits
       (it does NOT download or bundle a pinned Node - that is a deferred future enhancement).
    2. `npm i -g loomctl` - installs/upgrades the `loom` command.
    3. Optionally `loom service install` - register a per-user Task Scheduler logon task (prompted, or
       via -Service / env).
    4. Start Loom in the background and open the cockpit (unless -NoStart).

.NOTES
  When piped through `irm | iex` you cannot pass -Switches. Drive those runs with environment variables
  instead:
    $env:LOOM_INSTALL_SERVICE = '1'   # register autostart non-interactively
    $env:LOOM_INSTALL_START   = '0'   # skip launching the daemon
    $env:LOOM_INSTALL_SOURCE  = '.\loomctl-0.2.0.tgz'   # install a local tarball (verification)
    $env:LOOM_PORT            = '4317'
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
  Justification = 'Colored, host-facing progress output for an interactive installer.')]
[CmdletBinding()]
param(
  [switch] $Service,
  [switch] $NoService,
  [switch] $NoStart,
  [string] $Source,
  [int]    $Port
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$NodeMinMajor = 22

# --- helpers ---------------------------------------------------------------------------------------
function Write-Step([string] $msg) { Write-Host "[loom] $msg"        -ForegroundColor Cyan }
function Write-Ok  ([string] $msg) { Write-Host "[loom] $msg"        -ForegroundColor Green }
function Write-Warn([string] $msg) { Write-Host "[loom] $msg"        -ForegroundColor Yellow }
function Write-Fatal([string] $msg) { Write-Host "[loom] error: $msg" -ForegroundColor Red; exit 1 }

function Get-NodeMajor {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $null }
  $v = (& node --version) 2>$null   # e.g. v22.16.0
  if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
  return $null
}

function Show-NodeGuide([string] $reason) {
  Write-Warn "Loom needs Node $NodeMinMajor+ (with npm). $reason"
  Write-Host @"

Install Node $NodeMinMajor+ with one of:
  - winget   : winget install OpenJS.NodeJS.LTS
  - Official : https://nodejs.org/  (download the current LTS)
  - nvm-windows : https://github.com/coreybutler/nvm-windows
  - fnm      : https://github.com/Schniz/fnm

Then re-run this installer.
"@
  exit 1
}

# --- resolve options (params take precedence; env vars drive the `irm | iex` path) -----------------
# WantService: $true | $false | $null (=ask)
$WantService = $null
if     ($Service)   { $WantService = $true }
elseif ($NoService) { $WantService = $false }
elseif ($env:LOOM_INSTALL_SERVICE -in @('1','yes','true'))  { $WantService = $true }
elseif ($env:LOOM_INSTALL_SERVICE -in @('0','no','false'))  { $WantService = $false }

$WantStart = $true
if ($NoStart -or ($env:LOOM_INSTALL_START -in @('0','no','false'))) { $WantStart = $false }

if (-not $Source) { $Source = if ($env:LOOM_INSTALL_SOURCE) { $env:LOOM_INSTALL_SOURCE } else { 'loomctl' } }

if (-not $Port) { $Port = if ($env:LOOM_PORT) { [int]$env:LOOM_PORT } else { 4317 } }
if ($Port -lt 1 -or $Port -gt 65535) { Write-Fatal "invalid port '$Port' (expected 1-65535)" }
$env:LOOM_PORT = "$Port"   # loom + `loom service install` read this for the bound port
$Url = "http://127.0.0.1:$Port"

# --- 1. ensure Node 22+ ----------------------------------------------------------------------------
Write-Step "Checking for Node $NodeMinMajor+ ..."
$major = Get-NodeMajor
if ($null -eq $major) {
  Show-NodeGuide 'Node was not found on your PATH.'
} elseif ($major -lt $NodeMinMajor) {
  Show-NodeGuide "Found Node $(& node --version) - too old."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Show-NodeGuide "Found Node $(& node --version) but no npm alongside it."
}
Write-Ok "Node $(& node --version) with npm $(& npm --version) - good."

# --- 2. install / upgrade loomctl ------------------------------------------------------------------
Write-Step "Installing the Loom CLI (npm i -g $Source) ..."
& npm i -g $Source
if ($LASTEXITCODE -ne 0) {
  Write-Fatal "global install failed (npm exit $LASTEXITCODE). Try a new elevated shell, or set a user-writable npm prefix (npm config set prefix `$env:LOCALAPPDATA\npm)."
}

# Resolve the `loom` command. After a global install the npm bin dir is on PATH for NEW shells; in
# THIS session it may not be, so fall back to `npx loomctl`.
$LoomExe  = $null
$LoomArgs = @()
if (Get-Command loom -ErrorAction SilentlyContinue) {
  $LoomExe = 'loom'
} else {
  Write-Warn "'loom' is not on this session's PATH yet - using 'npx loomctl' for this run."
  Write-Warn "Open a new terminal (or add npm's global bin to PATH) so 'loom' works everywhere."
  $LoomExe  = 'npx'
  $LoomArgs = @('loomctl')
}
function Invoke-Loom { param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Rest)
  & $LoomExe @LoomArgs @Rest
}
$installedVer = (Invoke-Loom --version) 2>$null
Write-Ok "Installed: $installedVer ($Source)"

# --- 3. optional autostart -------------------------------------------------------------------------
if ($null -eq $WantService) {
  if ([Environment]::UserInteractive) {
    $answer = Read-Host '[loom] Register Loom to autostart on login? [y/N]'
    $WantService = ($answer -match '^[Yy]')
  } else {
    $WantService = $false
    Write-Step 'Non-interactive install - skipping autostart. Add it later with: loom service install'
  }
}
if ($WantService) {
  Write-Step 'Registering autostart (loom service install) ...'
  Invoke-Loom service install
  if ($LASTEXITCODE -eq 0) { Write-Ok 'Autostart registered.' }
  else { Write-Warn "Autostart registration failed (exit $LASTEXITCODE) - retry with 'loom service install'." }
}

# --- 4. start ---------------------------------------------------------------------------------------
$started = $false
if ($WantStart) {
  Write-Step 'Starting Loom in the background ...'
  Invoke-Loom start --detach
  if ($LASTEXITCODE -eq 0) { $started = $true }
  else { Write-Warn "Could not start the daemon - start it yourself with 'loom'." }
} else {
  Write-Step 'Skipping launch (-NoStart). Start Loom any time with: loom'
}

# --- final summary ----------------------------------------------------------------------------------
if ($started) {
  Write-Ok "Loom is running at $Url"
} else {
  Write-Ok "Loom installed. Start it with 'loom' - it will run at $Url"
}
Write-Step 'Commands: loom status | loom stop | loom restart | loom open | loom service status'
