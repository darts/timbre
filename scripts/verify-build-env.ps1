#requires -Version 5.1
# Non-mutating sanity check for the Windows build environment. Used both
# locally (by setup-windows.ps1) and by CI (qa-builds.yml). Exits non-zero
# on any failure so it can gate downstream build steps.
#
# Tests every prerequisite required to run `pnpm tauri:build` end-to-end:
#   * winget >= 1.6 (for `winget configure` reproducibility)
#   * Node 24.x, pnpm 10.33.2, Rust msvc host
#   * VS Build Tools (MSVC v143 + Win SDK) visible to cargo
#   * WebView2 Runtime registered (any of system/wow6432/user)
#   * LongPathsEnabled (cargo target paths exceed MAX_PATH)
#   * pnpm release:validate passes (manifests, requirements, bundle resources)
$ErrorActionPreference = 'Continue'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$fail = 0
$warn = 0

function Check {
  param([string]$Name, [scriptblock]$Probe, [string]$Hint)
  try {
    & $Probe
    Write-Host "[ok]   $Name"
  } catch {
    Write-Host "[fail] $Name" -ForegroundColor Red
    Write-Host "       $($_.Exception.Message)" -ForegroundColor Red
    if ($Hint) { Write-Host "       $Hint" }
    $script:fail++
  }
}

function Warn {
  param([string]$Name, [scriptblock]$Probe, [string]$Hint)
  try {
    & $Probe
    Write-Host "[ok]   $Name"
  } catch {
    Write-Host "[warn] $Name" -ForegroundColor Yellow
    Write-Host "       $($_.Exception.Message)" -ForegroundColor Yellow
    if ($Hint) { Write-Host "       $Hint" }
    $script:warn++
  }
}

Check "winget >= 1.6" {
  $cmd = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "winget not found" }
  $raw = (winget --version) -replace '^v',''
  $clean = ($raw -replace '-.*$','').Trim()
  $ver = [Version]$clean
  if ($ver -lt [Version]'1.6.0') { throw "got $raw (need >= 1.6 for 'winget configure')" }
} "Update 'App Installer' from the Microsoft Store"

Check "node 24.x" {
  $v = (node --version) -replace '^v',''
  if (-not $v.StartsWith('24.')) { throw "got $v" }
} "scripts\bootstrap.cmd installs Node LTS via winget"

Check "pnpm 10.33.2" {
  $v = (pnpm --version).Trim()
  if ($v -ne '10.33.2') { throw "got $v" }
} "corepack prepare pnpm@10.33.2 --activate"

Check "rust host = x86_64-pc-windows-msvc" {
  $host_line = (rustc -vV) | Select-String '^host:'
  if (-not $host_line) { throw "no host line in rustc -vV" }
  if ($host_line -notmatch 'x86_64-pc-windows-msvc') { throw "got $host_line" }
} "rustup default stable-x86_64-pc-windows-msvc"

Check "cargo available" {
  $null = cargo --version
} "Install Rust via rustup (winget install Rustlang.Rustup)"

Check "VS Build Tools (MSVC + Win SDK)" {
  # vswhere ships with the VS installer at a fixed location. Use it
  # rather than scanning Program Files paths, which differ across SKUs.
  $pf86 = ${env:ProgramFiles(x86)}
  if (-not $pf86) { $pf86 = $env:ProgramFiles }
  $vswhere = Join-Path $pf86 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) {
    $vswhere = Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe'
  }
  if (-not (Test-Path $vswhere)) {
    throw "vswhere.exe not found (VS Build Tools not installed?)"
  }
  $out = & $vswhere -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath 2>$null
  if (-not $out) {
    throw "no VS installation with VC.Tools.x86.x64 component found"
  }
  # Find the latest VC\Tools\MSVC\<ver>\bin\Hostx64\x64\link.exe. Scan only
  # the version-dir level (recursive would walk multi-GB include trees).
  $vc = Join-Path $out 'VC\Tools\MSVC'
  if (-not (Test-Path $vc)) { throw "missing $vc" }
  $versions = Get-ChildItem -Path $vc -Directory -ErrorAction SilentlyContinue |
              Sort-Object Name -Descending
  if (-not $versions) { throw "no MSVC version dirs under $vc" }
  $link = Join-Path $versions[0].FullName 'bin\Hostx64\x64\link.exe'
  if (-not (Test-Path $link)) { throw "link.exe missing at $link (workload incomplete)" }
} "Re-run scripts\bootstrap.cmd to install VS 2022 Build Tools"

Check "WebView2 runtime registered" {
  $clientGuid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  $keys = @(
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientGuid",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$clientGuid",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientGuid"
  )
  foreach ($k in $keys) {
    if (Test-Path $k) { return }
  }
  throw "no EdgeUpdate client key matches WebView2 runtime"
} "winget install Microsoft.EdgeWebView2Runtime"

Warn "LongPathsEnabled = 1" {
  $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'
  $val = (Get-ItemProperty -Path $key -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
  if ($val -ne 1) { throw "got $val" }
} "Re-run scripts\bootstrap.cmd as admin to enable. Builds may still succeed if the repo path is short."

Warn "no pending reboot" {
  $rebootKeys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
  )
  foreach ($k in $rebootKeys) {
    if (Test-Path $k) { throw "pending: $k" }
  }
} "Reboot Windows before running pnpm tauri:build (Windows Update flag set)"

Check "pnpm-lock.yaml present" {
  if (-not (Test-Path (Join-Path $root 'pnpm-lock.yaml'))) { throw "missing" }
} "Run from a fresh git clone of the repo"

Check "src-tauri/Cargo.lock present" {
  if (-not (Test-Path (Join-Path $root 'src-tauri\Cargo.lock'))) { throw "missing" }
} "Run from a fresh git clone of the repo"

Check "pnpm release:validate passes" {
  Push-Location $root
  try {
    $out = pnpm release:validate 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($out | Out-String) }
  } finally { Pop-Location }
} "Inspect release manifests under resources/ and py/requirements/"

if ($fail -gt 0) {
  Write-Host ""
  Write-Host "$fail check(s) failed, $warn warning(s)." -ForegroundColor Red
  exit 1
}
if ($warn -gt 0) {
  Write-Host ""
  Write-Host "All checks passed ($warn warning(s) - see above)." -ForegroundColor Yellow
} else {
  Write-Host ""
  Write-Host "All checks passed." -ForegroundColor Green
}
exit 0
