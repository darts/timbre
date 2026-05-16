#requires -Version 5.1
# Non-mutating sanity check for the Windows build environment. Used both
# locally (by setup-windows.ps1) and by CI (qa-builds.yml). Exits non-zero
# on any failure so it can gate downstream build steps.
$ErrorActionPreference = 'Continue'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$fail = 0

function Check {
  param([string]$Name, [scriptblock]$Probe, [string]$Hint)
  try {
    & $Probe
    Write-Host "[ok]   $Name"
  } catch {
    Write-Host "[fail] $Name"
    if ($Hint) { Write-Host "       $Hint" }
    $script:fail++
  }
}

Check "node 24.x" {
  $v = (node --version) -replace '^v',''
  if (-not $v.StartsWith('24.')) { throw "got $v" }
} "Install Node.js 24 LTS (winget install OpenJS.NodeJS.LTS)"

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

Check "WebView2 runtime registered" {
  $key = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  if (-not (Test-Path $key)) { throw "registry key missing: $key" }
} "winget install Microsoft.EdgeWebView2Runtime"

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
  Write-Host "$fail check(s) failed."
  exit 1
}
exit 0
