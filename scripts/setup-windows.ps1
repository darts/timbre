#requires -Version 5.1
<#
.SYNOPSIS
  One-command Windows dev setup. Parity with `direnv allow` on Unix.

.DESCRIPTION
  Installs the system toolchain via `winget configure` (VS Build Tools,
  Rustup, Node LTS, WebView2 Runtime, Git), then bootstraps the project
  (rustup default + corepack pnpm + pnpm install + verify-build-env).

  Reliably re-runnable: every step is idempotent and individual failures
  surface with actionable hints.

.PARAMETER SkipToolchain
  Skip the `winget configure` step. Use when the system toolchain is
  already present and you only want the project bootstrap (rustup default,
  pnpm install, verify).

.PARAMETER SkipVerify
  Skip the final verify-build-env.ps1 sanity sweep. Used by CI which
  invokes verify separately.

.EXAMPLE
  scripts\bootstrap.cmd
  scripts\setup-windows.ps1
  scripts\setup-windows.ps1 -SkipToolchain
#>
[CmdletBinding()]
param(
  [switch]$SkipToolchain,
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-Info([string]$msg) { Write-Host "    $msg" }
function Write-Warn2([string]$msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Write-OK([string]$msg)   { Write-Host "    $msg" -ForegroundColor Green }

function Fail([string]$msg) {
  Write-Host ""
  Write-Host "ERROR: $msg" -ForegroundColor Red
  exit 1
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = [Security.Principal.WindowsPrincipal]::new($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Admin {
  if (Test-Admin) { return }
  # We deliberately *don't* self-elevate via Start-Process -Verb RunAs: the
  # elevated console closes on exit and the user loses every line of output.
  # Bail with instructions instead - standard Windows admin-tool practice.
  Fail @"
Administrator privileges required.

VS Build Tools, WebView2 Runtime, and the LongPathsEnabled registry tweak
all require an elevated process. Re-launch one of:

  * Right-click scripts\bootstrap.cmd  ->  "Run as administrator"
  * Or open Windows Terminal / cmd elevated, then re-run scripts\bootstrap.cmd
"@
}

function Update-PathFromRegistry {
  $machine = [Environment]::GetEnvironmentVariable('Path','Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path','User')
  $env:Path = "$machine;$user"

  # Belt-and-braces: known toolchain dirs that may have been written to the
  # registry by an installer but not yet propagated into this process.
  $candidates = @(
    "$env:USERPROFILE\.cargo\bin",
    "$env:ProgramFiles\nodejs",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links",
    "$env:ProgramFiles\Git\cmd",
    "$env:ProgramFiles\Git\bin"
  ) | Where-Object { Test-Path $_ }
  if ($candidates) {
    $env:Path = ($candidates -join ';') + ";$env:Path"
  }
}

function Resolve-Tool([string]$name, [string[]]$fallbacks = @()) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in $fallbacks) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Test-PendingReboot {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
  )
  foreach ($k in $keys) {
    if (Test-Path $k) { return $true }
  }
  $sm = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager'
  try {
    $val = Get-ItemProperty -Path $sm -Name PendingFileRenameOperations -ErrorAction Stop
    if ($val.PendingFileRenameOperations) { return $true }
  } catch { }
  return $false
}

function Enable-LongPaths {
  $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'
  $cur = (Get-ItemProperty -Path $key -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
  if ($cur -eq 1) {
    Write-OK "long paths already enabled"
    return
  }
  New-ItemProperty -Path $key -Name LongPathsEnabled -PropertyType DWord -Value 1 -Force | Out-Null
  Write-OK "long paths enabled (takes effect on next process launch)"
}

function Assert-WingetCapable {
  $cmd = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $cmd) {
    Fail @"
winget not found.

Install 'App Installer' from the Microsoft Store, then re-open this shell
and re-run scripts\bootstrap.cmd.
"@
  }
  $raw = (winget --version) -replace '^v',''
  $clean = ($raw -replace '-.*$','').Trim()
  try { $ver = [Version]$clean } catch { $ver = $null }
  if ($ver -and $ver -lt [Version]'1.6.0') {
    Fail @"
winget $raw is too old; need >= 1.6 for 'winget configure'.

Update 'App Installer' via the Microsoft Store and re-run setup.
"@
  }
  # Verify the configure subcommand is wired. `winget configure --help` is
  # zero-cost and prints nothing to stdout on missing-subcommand errors.
  $null = winget configure --help 2>&1
  if ($LASTEXITCODE -ne 0) {
    Fail @"
'winget configure' is unavailable on this winget build.

Update 'App Installer' from the Microsoft Store (need >= 1.6) and re-run.
"@
  }
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

Push-Location $root
try {
  Write-Host "Timbre Windows setup"
  Write-Host "  repo : $root"
  Write-Host "  pwsh : $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
  Write-Host "  os   : $([Environment]::OSVersion.VersionString)"

  if (-not $SkipToolchain) {
    Assert-Admin
    Write-OK "running elevated"

    Write-Step "Sanity checks"
    Assert-WingetCapable
    Write-OK "winget OK"

    if (Test-PendingReboot) {
      Write-Warn2 "pending reboot detected - VS Build Tools install may fail"
      Write-Warn2 "if winget configure errors out, reboot and re-run"
    }

    Write-Step "Enabling long-path support"
    Enable-LongPaths

    Write-Step "Installing system toolchain via winget configure"
    Write-Info "this is idempotent; already-installed packages are skipped"
    # --accept-configuration-agreements: agree to DSC config preamble
    # --disable-interactivity: never block on an interactive prompt
    winget configure --file scripts\windows-deps.winget `
      --accept-configuration-agreements `
      --disable-interactivity
    if ($LASTEXITCODE -ne 0) {
      Fail @"
winget configure failed (exit $LASTEXITCODE).

Common causes:
  * Pending reboot from Windows Update - reboot and retry.
  * Insufficient disk space (VS Build Tools needs ~7 GB on C:).
  * Corporate proxy without HTTPS_PROXY exported.

Re-run scripts\bootstrap.cmd after fixing.
"@
    }
    Write-OK "winget configure succeeded"

    Update-PathFromRegistry
  } else {
    Update-PathFromRegistry
    Write-Step "Skipping toolchain install (-SkipToolchain)"
  }

  Write-Step "rustup default stable-x86_64-pc-windows-msvc"
  $rustup = Resolve-Tool 'rustup' @(
    "$env:USERPROFILE\.cargo\bin\rustup.exe"
  )
  if (-not $rustup) {
    Fail "rustup not found on PATH or under .cargo\bin. Re-run setup without -SkipToolchain."
  }
  # Force the toolchain to be present (no-op if already installed) so a
  # subsequent `rustup default` doesn't get stuck pulling components.
  & $rustup install stable-x86_64-pc-windows-msvc --profile minimal --no-self-update
  if ($LASTEXITCODE -ne 0) { Fail "rustup install failed (exit $LASTEXITCODE)" }
  & $rustup default stable-x86_64-pc-windows-msvc
  if ($LASTEXITCODE -ne 0) { Fail "rustup default failed (exit $LASTEXITCODE)" }
  Update-PathFromRegistry

  Write-Step "corepack prepare pnpm@10.33.2 --activate"
  $corepack = Resolve-Tool 'corepack' @(
    "$env:ProgramFiles\nodejs\corepack.cmd",
    "$env:ProgramFiles\nodejs\corepack.ps1"
  )
  if (-not $corepack) {
    Fail "corepack not found. Node.js install may have failed; re-run without -SkipToolchain."
  }
  & $corepack enable
  if ($LASTEXITCODE -ne 0) { Fail "corepack enable failed (exit $LASTEXITCODE)" }
  & $corepack prepare pnpm@10.33.2 --activate
  if ($LASTEXITCODE -ne 0) { Fail "corepack prepare failed (exit $LASTEXITCODE)" }

  Write-Step "pnpm install --frozen-lockfile"
  $pnpm = Resolve-Tool 'pnpm'
  if (-not $pnpm) {
    Fail "pnpm not on PATH after corepack activate. Open a new shell and retry."
  }
  & $pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed (exit $LASTEXITCODE)" }

  if (-not $SkipVerify) {
    Write-Step "Verifying environment"
    & "$PSScriptRoot\verify-build-env.ps1"
    if ($LASTEXITCODE -ne 0) {
      Fail "verify-build-env.ps1 reported failures (see above)."
    }
  }

  $rustVer = (& $rustup run stable-x86_64-pc-windows-msvc rustc --version) -split ' '
  Write-Host ""
  Write-Host "Timbre Windows dev shell ready:" -ForegroundColor Green
  Write-Host "  rust   $($rustVer[1])"
  Write-Host "  node   $(node --version)"
  Write-Host "  pnpm   $(& $pnpm --version)"
  Write-Host ""
  Write-Host "Next: pnpm tauri:dev     (or)     pnpm tauri:build --bundles msi,nsis"
} finally {
  Pop-Location
}
