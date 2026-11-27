<#
.SYNOPSIS
  UniRoute Windows installer.
.DESCRIPTION
  Detects Bun or Node.js (>= 22.5) first and installs the lightweight gzipped bundle (~1 MB).
  When neither runtime is present, warns the user and recommends installing Bun or Node.js
  before offering to fall back to the ~85 MB standalone binary.
#>
param(
  [string]$Version = "latest",
  [switch]$Binary,
  [switch]$Bundle,
  [switch]$Yes,
  [string]$InstallDir = $(Join-Path $env:LOCALAPPDATA "uniroute")
)

$ErrorActionPreference = "Stop"
$Repo = if ($env:REPO) { $env:REPO } else { "mygcp/uniroute" }
$BinDir = Join-Path $InstallDir "bin"
$AppDir = Join-Path $InstallDir "app"

function Get-ReleaseUrl([string]$AssetName) {
  if ($Version -eq "latest") {
    return "https://github.com/$Repo/releases/latest/download/$AssetName"
  }
  $tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
  return "https://github.com/$Repo/releases/download/$tag/$AssetName"
}

function Download-WithProgress([string]$Url, [string]$DestPath, [string]$Activity) {
  Add-Type -AssemblyName System.Net.Http
  $client = [System.Net.Http.HttpClient]::new()
  $client.DefaultRequestHeaders.Add("User-Agent", "uniroute-installer")
  try {
    $resp = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if (-not $resp.IsSuccessStatusCode) {
      throw "HTTP $([int]$resp.StatusCode) downloading $Url"
    }
    $total = $resp.Content.Headers.ContentLength
    $inStream = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $outStream = [System.IO.File]::Create($DestPath)
    $buf = New-Object byte[] 65536
    [long]$readTotal = 0
    try {
      while (($n = $inStream.Read($buf, 0, $buf.Length)) -gt 0) {
        $outStream.Write($buf, 0, $n)
        $readTotal += $n
        if ($total -and $total -gt 0) {
          $pct = [Math]::Min(100, [int](($readTotal * 100) / $total))
          $mb = [Math]::Round($readTotal / 1MB, 2)
          $totMb = [Math]::Round($total / 1MB, 2)
          Write-Progress -Activity $Activity -Status "$mb / $totMb MB ($pct%)" -PercentComplete $pct
        } else {
          $mb = [Math]::Round($readTotal / 1MB, 2)
          Write-Progress -Activity $Activity -Status "$mb MB downloaded"
        }
      }
      Write-Progress -Activity $Activity -Completed
    } finally {
      $outStream.Dispose()
      $inStream.Dispose()
    }
  } finally {
    $client.Dispose()
  }
}

function Detect-Runtime {
  $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
  if ($bunCmd) {
    $ver = (& bun --version 2>$null)
    return @{ Name = "bun"; Version = "$ver" }
  }
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $raw = (& node -v 2>$null)
    if ($raw -match '^v?(\d+)\.(\d+)') {
      $maj = [int]$Matches[1]
      $min = [int]$Matches[2]
      if ($maj -gt 22 -or ($maj -eq 22 -and $min -ge 5)) {
        return @{ Name = "node"; Version = "$($raw.TrimStart('v'))" }
      }
    }
  }
  return $null
}

function Ensure-UserPath([string]$Dir) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = if ($current) { $current -split ';' | Where-Object { $_ } } else { @() }
  if ($parts -notcontains $Dir) {
    $next = ($parts + $Dir) -join ';'
    [Environment]::SetEnvironmentVariable("Path", $next, "User")
    if ($env:Path -notlike "*$Dir*") {
      $env:Path = "$Dir;$env:Path"
    }
    Write-Host "Added $Dir to your user PATH."
  }
}

function Install-Bundle {
  $url = Get-ReleaseUrl "uni-bundle.tar.gz"
  $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("uniroute-install-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
  $tgz = Join-Path $tmpDir "uni-bundle.tar.gz"
  $extractDir = Join-Path $tmpDir "extract"
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

  try {
    Write-Host "Downloading lightweight bundle: $url"
    Download-WithProgress -Url $url -DestPath $tgz -Activity "Downloading UniRoute bundle"
    & tar -xzf $tgz -C $extractDir
    if ($LASTEXITCODE -ne 0) { throw "tar extraction failed." }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $bakDir = "$AppDir.bak"
    if (Test-Path $bakDir) { Remove-Item -Recurse -Force $bakDir }
    if (Test-Path $AppDir) { Move-Item -Path $AppDir -Destination $bakDir -Force }
    Move-Item -Path $extractDir -Destination $AppDir -Force

    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $launcher = @"
@echo off
setlocal
set "UNIROUTE_INSTALL_MODE=bundle"
set "UNIROUTE_APP_DIR=$AppDir"
where bun >nul 2>nul
if %errorlevel%==0 (
  bun "%UNIROUTE_APP_DIR%\uni.mjs" %*
  exit /b %errorlevel%
)
where node >nul 2>nul
if %errorlevel%==0 (
  node --no-warnings=ExperimentalWarning "%UNIROUTE_APP_DIR%\uni.mjs" %*
  exit /b %errorlevel%
)
echo [uni] Bun or Node.js ^>= 22.5 is required to run the bundle install.
exit /b 1
"@
    Set-Content -Path (Join-Path $BinDir "uni.cmd") -Value $launcher -Encoding ASCII
    Set-Content -Path (Join-Path $BinDir "uniroute.cmd") -Value $launcher -Encoding ASCII
    Ensure-UserPath $BinDir

    Write-Host ""
    Write-Host "Installed UniRoute lightweight bundle to $AppDir"
    Write-Host "Next: uni doctor ; uni start --daemon"
    Write-Host "Update or switch versions anytime: uni update --list"
  } finally {
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue }
  }
}

function Install-Binary {
  $url = Get-ReleaseUrl "uni-windows-x64.exe.zip"
  $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("uniroute-bin-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
  $zip = Join-Path $tmpDir "uni-windows-x64.exe.zip"
  $extractDir = Join-Path $tmpDir "extract"

  try {
    Write-Host "Downloading standalone binary: $url"
    Download-WithProgress -Url $url -DestPath $zip -Activity "Downloading UniRoute binary"
    Expand-Archive -LiteralPath $zip -DestinationPath $extractDir -Force
    $exe = Get-ChildItem -Path $extractDir -Filter "*.exe" -Recurse | Select-Object -First 1
    if (-not $exe) { throw "uni-windows-x64.exe not found in archive." }

    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $targetExe = Join-Path $BinDir "uni.exe"
    Copy-Item -Path $exe.FullName -Destination $targetExe -Force
    $aliasCmd = "@echo off`r`n`"$targetExe`" %*`r`n"
    Set-Content -Path (Join-Path $BinDir "uniroute.cmd") -Value $aliasCmd -Encoding ASCII
    Ensure-UserPath $BinDir

    Write-Host ""
    Write-Host "Installed UniRoute standalone binary to $targetExe"
    Write-Host "Next: uni doctor ; uni start --daemon"
    Write-Host "Update or switch versions anytime: uni update --list"
  } finally {
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue }
  }
}

$rt = Detect-Runtime
if ($rt) {
  if ($Binary) {
    Write-Host "Detected $($rt.Name) $($rt.Version). Installing standalone binary as requested (-Binary)."
    Install-Binary
  } else {
    Write-Host "Detected $($rt.Name) $($rt.Version). Installing lightweight gzipped bundle (~1 MB instead of ~85 MB binary)."
    Install-Bundle
  }
} else {
  if ($Bundle) {
    Write-Error "Bundle mode requested (-Bundle), but neither Bun nor Node.js >= 22.5 was found."
    exit 1
  }

  Write-Host ""
  Write-Warning "Neither Bun nor Node.js (>= 22.5) was found on this system."
  Write-Host "UniRoute's app code is only ~1 MB gzipped, while the standalone binary embeds the full ~85 MB runtime."
  Write-Host ""
  Write-Host "Recommended: install Bun or Node.js 22+ first, then re-run this installer for a ~1 MB install:"
  Write-Host "  Bun:     powershell -c `"irm bun.sh/install.ps1 | iex`""
  Write-Host "  Node.js: winget install OpenJS.NodeJS.LTS"
  Write-Host ""

  if ($Binary -or $Yes) {
    Install-Binary
  } else {
    $ans = Read-Host "Continue installing the ~85 MB standalone binary anyway? [y/N]"
    if ($ans -match '^(y|yes)$') {
      Install-Binary
    } else {
      Write-Host "Aborted. Install Bun or Node.js 22+, then re-run this installer."
    }
  }
}
