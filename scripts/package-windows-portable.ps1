#requires -Version 5.1
<#
.SYNOPSIS
  Package the built Windows release binary as a portable ZIP.

.DESCRIPTION
  Run after `pnpm tauri:build` on Windows. The ZIP contains Timbre.exe and
  the resource folders that Tauri resolves next to the executable on Windows.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$srcTauri = Join-Path $root 'src-tauri'
$releaseDir = Join-Path $srcTauri 'target\release'
$bundleDir = Join-Path $releaseDir 'bundle'
$stagingParent = Join-Path $releaseDir 'portable-staging'

function Fail([string]$message) {
  Write-Host ""
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

function Resolve-RequiredPath([string]$path, [string]$description) {
  if (-not (Test-Path $path)) {
    Fail "$description not found: $path"
  }
  return (Resolve-Path $path).Path
}

function Copy-Directory([string]$source, [string]$target) {
  if (Test-Path $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
}

function Copy-ResourceMap([object]$tauriConfig, [string]$stageDir) {
  $resources = $tauriConfig.bundle.resources
  if (-not $resources) {
    Fail 'tauri.conf.json bundle.resources is empty'
  }

  foreach ($entry in $resources.PSObject.Properties) {
    $sourcePattern = Join-Path $srcTauri $entry.Name
    $targetRelative = [string]$entry.Value
    $matches = @(Get-ChildItem -Path $sourcePattern -File -ErrorAction SilentlyContinue)

    if ($matches.Count -eq 0) {
      Fail "resource pattern matched no files: $($entry.Name)"
    }

    foreach ($match in $matches) {
      if ($targetRelative.EndsWith('/') -or $targetRelative.EndsWith('\')) {
        $targetDir = Join-Path $stageDir $targetRelative
        New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
        Copy-Item -LiteralPath $match.FullName -Destination (Join-Path $targetDir $match.Name) -Force
      } else {
        $targetPath = Join-Path $stageDir $targetRelative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
        Copy-Item -LiteralPath $match.FullName -Destination $targetPath -Force
      }
    }
  }
}

Push-Location $root
try {
  $tauriConfigPath = Resolve-RequiredPath (Join-Path $srcTauri 'tauri.conf.json') 'Tauri config'
  $tauriConfig = Get-Content -Raw -LiteralPath $tauriConfigPath | ConvertFrom-Json
  $productName = [string]$tauriConfig.productName
  $version = [string]$tauriConfig.version

  if (-not $productName) { Fail 'productName missing in tauri.conf.json' }
  if (-not $version) { Fail 'version missing in tauri.conf.json' }

  Resolve-RequiredPath $releaseDir 'Windows release output directory' | Out-Null
  New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null

  $exeCandidates = @(
    (Join-Path $releaseDir "$productName.exe"),
    (Join-Path $releaseDir "$($productName.ToLowerInvariant()).exe"),
    (Join-Path $releaseDir 'timbre.exe')
  )
  $sourceExe = $exeCandidates | Where-Object { Test-Path $_ -PathType Leaf } | Select-Object -First 1
  if (-not $sourceExe) {
    $sourceExe = Get-ChildItem -Path $releaseDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notmatch '(?i)(setup|installer)' } |
      Select-Object -ExpandProperty FullName -First 1
  }
  if (-not $sourceExe) {
    Fail "release EXE not found under $releaseDir; run pnpm tauri:build first"
  }

  $artifactBaseName = "$productName-$version-windows-x86_64-portable"
  $stageDir = Join-Path $stagingParent $artifactBaseName
  $zipPath = Join-Path $bundleDir "$artifactBaseName.zip"

  if (Test-Path $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

  Copy-Item -LiteralPath $sourceExe -Destination (Join-Path $stageDir "$productName.exe") -Force

  $builtPy = Join-Path $releaseDir 'py'
  $builtResources = Join-Path $releaseDir 'resources'
  if ((Test-Path $builtPy -PathType Container) -and (Test-Path $builtResources -PathType Container)) {
    Copy-Directory $builtPy (Join-Path $stageDir 'py')
    Copy-Directory $builtResources (Join-Path $stageDir 'resources')
  } else {
    Write-Host 'Built resource folders were not found next to the EXE; copying resources from tauri.conf.json.'
    Copy-ResourceMap $tauriConfig $stageDir
  }

  $readme = @"
Timbre portable build $version

How to run:
1. Extract this ZIP.
2. Run Timbre.exe.

Requirements:
- Windows 10/11 x64.
- Microsoft Edge WebView2 Runtime must be installed. Most current Windows 10/11 systems already include it.
- First-run backend setup downloads Python, uv, and model dependencies into %APPDATA%\timbre and caches data under %LOCALAPPDATA%\timbre.

This portable package does not install Start Menu shortcuts, register an uninstaller, or require administrator privileges.
"@
  Set-Content -LiteralPath (Join-Path $stageDir 'README.txt') -Value $readme -Encoding ASCII

  $requiredFiles = @(
    "$productName.exe",
    'README.txt',
    'py\pyproject.toml',
    'py\timbre\__main__.py',
    'py\timbre\adapters\__init__.py',
    'py\requirements\base.txt',
    'resources\models.manifest.json',
    'resources\python-build-standalone.urls.json'
  )
  foreach ($relative in $requiredFiles) {
    $path = Join-Path $stageDir $relative
    if (-not (Test-Path $path -PathType Leaf)) {
      Fail "portable package is missing required file: $relative"
    }
  }

  if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  Compress-Archive -LiteralPath $stageDir -DestinationPath $zipPath -Force

  Write-Host "Wrote $zipPath"
} finally {
  Pop-Location
}
