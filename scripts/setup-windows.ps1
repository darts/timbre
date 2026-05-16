#requires -Version 5.1
# One-command Windows dev setup. Parity with `direnv allow` on Unix:
# installs the full toolchain via winget configure, then bootstraps the
# project (pnpm install + verify).
$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $root
try {
  Write-Host "==> Installing system toolchain via winget configure"
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget not found. Install 'App Installer' from the Microsoft Store, then re-run."
  }
  winget configure --file scripts\windows-deps.winget --accept-configuration-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget configure failed (exit $LASTEXITCODE)" }

  # Refresh PATH so the rest of the script sees newly-installed binaries
  # without requiring a reboot or a new shell.
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path","User")

  Write-Host "==> rustup default stable-x86_64-pc-windows-msvc"
  rustup default stable-x86_64-pc-windows-msvc
  if ($LASTEXITCODE -ne 0) { throw "rustup default failed" }

  Write-Host "==> corepack prepare pnpm@10.33.2 --activate"
  corepack enable
  corepack prepare pnpm@10.33.2 --activate
  if ($LASTEXITCODE -ne 0) { throw "corepack prepare failed" }

  Write-Host "==> pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

  Write-Host "==> Verifying environment"
  & "$PSScriptRoot\verify-build-env.ps1"
  if ($LASTEXITCODE -ne 0) { throw "verify-build-env.ps1 reported failures" }

  $rustVer = (rustc --version) -split ' '
  Write-Host ""
  Write-Host "Timbre Windows dev shell ready:"
  Write-Host "  rust   $($rustVer[1])"
  Write-Host "  node   $(node --version)"
  Write-Host "  pnpm   $(pnpm --version)"
  Write-Host ""
  Write-Host "Next: pnpm tauri:dev     (or)     pnpm tauri:build --bundles msi,nsis"
} finally {
  Pop-Location
}
