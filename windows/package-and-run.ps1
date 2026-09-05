#Requires -Version 7.0

[CmdletBinding()]
param(
    [string]$TargetDirectory = "C:\Desktop\Superior",
    [switch]$SkipPackage,
    [switch]$SkipLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$WindowsDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent $WindowsDirectory
$TsbotRoot = Join-Path $RepositoryRoot "tsbot"
$DevelopmentArtifactRoot = Join-Path $WindowsDirectory ".artifacts\development"
$SourceExecutable = Join-Path $DevelopmentArtifactRoot "SuperiorBot.exe"
$SourceUpdater = Join-Path $DevelopmentArtifactRoot "Update.exe"
$TargetExecutable = Join-Path $TargetDirectory "SuperiorBot.exe"
$TargetUpdater = Join-Path $TargetDirectory "Update.exe"
$Bun = (Get-Command bun.exe -CommandType Application -ErrorAction Stop).Source

function Get-ProductVersion {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $VersionText = (Get-Item -LiteralPath $LiteralPath -ErrorAction Stop).VersionInfo.ProductVersion
    $ParsedVersion = $null
    if (-not [version]::TryParse($VersionText, [ref]$ParsedVersion)) {
        throw "Unable to read a valid ProductVersion from '$LiteralPath': '$VersionText'."
    }
    return $ParsedVersion
}

if (-not $SkipPackage) {
    Push-Location $TsbotRoot
    try {
        & $Bun run package:win
        $PackageExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($PackageExitCode -ne 0) {
        throw "bun run package:win failed with exit code $PackageExitCode."
    }
}

foreach ($Artifact in @($SourceExecutable, $SourceUpdater)) {
    if (-not (Test-Path -LiteralPath $Artifact -PathType Leaf)) {
        throw "Required packaging artifact is missing: $Artifact"
    }
}

New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
$SourceVersion = Get-ProductVersion -LiteralPath $SourceExecutable
$TargetVersion = [version]"0.0.0"
if (Test-Path -LiteralPath $TargetExecutable -PathType Leaf) {
    $TargetVersion = Get-ProductVersion -LiteralPath $TargetExecutable
}

if ($SourceVersion -gt $TargetVersion) {
    Copy-Item -LiteralPath $SourceUpdater -Destination $TargetUpdater -Force
    Push-Location $TargetDirectory
    try {
        & $TargetUpdater --source $SourceExecutable
        $UpdateExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($UpdateExitCode -ne 0) {
        throw "Update.exe failed with exit code $UpdateExitCode."
    }
    Write-Host "Updated Superior Bot from $TargetVersion to $SourceVersion."
    exit 0
}

if ($SkipLaunch) {
    Write-Host "Superior Bot $TargetVersion is already current; launch skipped."
    exit 0
}

Write-Host "Superior Bot $TargetVersion is already current; starting it."
Start-Process -FilePath $TargetExecutable -WorkingDirectory $TargetDirectory
