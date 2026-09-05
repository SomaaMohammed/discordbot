#Requires -Version 7.0

[CmdletBinding()]
param(
    [string]$OutputDirectory = "",
    [string]$StandaloneOutput = "",
    [string]$UpdaterOutput = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "hash-utils.ps1")
. (Join-Path $PSScriptRoot "path-safety.ps1")

$WindowsDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent $WindowsDirectory
$BuildScript = Join-Path $WindowsDirectory "build-portable.ps1"
$PackagePath = Join-Path $RepositoryRoot "tsbot\package.json"
$Package = Get-Content -LiteralPath $PackagePath -Raw | ConvertFrom-Json
$ArtifactName = "SuperiorBot-$($Package.version)-win-x64.zip"
$TemporaryParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$OwnedTemporaryRoot = $null
$AllOutputsOmitted = @(
    @($OutputDirectory, $StandaloneOutput, $UpdaterOutput) |
        Where-Object { [string]::IsNullOrWhiteSpace($_) }
)
if ($AllOutputsOmitted.Count -eq 3) {
    $OwnedTemporaryRoot = Join-Path $TemporaryParent (
        "Superior Bot reproducibility test " + [System.Guid]::NewGuid().ToString("N")
    )
    [void](Initialize-SafeDirectory -Path $OwnedTemporaryRoot -Description "Reproducibility test directory")
    $OutputDirectory = Join-Path $OwnedTemporaryRoot "release"
    $StandaloneOutput = Join-Path $OwnedTemporaryRoot "SuperiorBot.exe"
    $UpdaterOutput = Join-Path $OwnedTemporaryRoot "Update.exe"
}
elseif ($AllOutputsOmitted.Count -ne 0) {
    throw "Specify all reproducibility output paths together, or omit all three for isolated temporary validation."
}
$OutputRoot = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot $OutputDirectory))
}
$Artifact = Join-Path $OutputRoot $ArtifactName
$StandaloneArtifact = if ([System.IO.Path]::IsPathRooted($StandaloneOutput)) {
    [System.IO.Path]::GetFullPath($StandaloneOutput)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot $StandaloneOutput))
}
$UpdaterArtifact = if ([System.IO.Path]::IsPathRooted($UpdaterOutput)) {
    [System.IO.Path]::GetFullPath($UpdaterOutput)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot $UpdaterOutput))
}

try {
    Write-Host "Building the first portable artifact..."
    & $BuildScript -OutputDirectory $OutputDirectory -StandaloneOutput $StandaloneArtifact -UpdaterOutput $UpdaterArtifact -AllowUnsignedDevelopment
    $FirstHash = Get-Sha256Hex -LiteralPath $Artifact
    $FirstStandaloneHash = Get-Sha256Hex -LiteralPath $StandaloneArtifact
    $FirstUpdaterHash = Get-Sha256Hex -LiteralPath $UpdaterArtifact

    Write-Host "Rebuilding from clean staging to verify byte-for-byte reproducibility..."
    & $BuildScript -OutputDirectory $OutputDirectory -StandaloneOutput $StandaloneArtifact -UpdaterOutput $UpdaterArtifact -AllowUnsignedDevelopment
    $SecondHash = Get-Sha256Hex -LiteralPath $Artifact
    $SecondStandaloneHash = Get-Sha256Hex -LiteralPath $StandaloneArtifact
    $SecondUpdaterHash = Get-Sha256Hex -LiteralPath $UpdaterArtifact

    if ($FirstHash -ne $SecondHash) {
        throw "Portable rebuild was not byte-for-byte reproducible: $FirstHash != $SecondHash"
    }
    if ($FirstStandaloneHash -ne $SecondStandaloneHash) {
        throw "Standalone rebuild was not byte-for-byte reproducible: $FirstStandaloneHash != $SecondStandaloneHash"
    }
    if ($FirstUpdaterHash -ne $SecondUpdaterHash) {
        throw "Updater rebuild was not byte-for-byte reproducible: $FirstUpdaterHash != $SecondUpdaterHash"
    }

    Write-Host "Reproducible portable SHA-256: $SecondHash"
    Write-Host "Reproducible standalone SHA-256: $SecondStandaloneHash"
    Write-Host "Reproducible updater SHA-256: $SecondUpdaterHash"
}
finally {
    if ($null -ne $OwnedTemporaryRoot) {
        if (Test-Path -LiteralPath $OwnedTemporaryRoot) {
            Remove-SafeOwnedTree `
                -Path $OwnedTemporaryRoot `
                -OwnerDirectory $TemporaryParent `
                -Description "Reproducibility test directory"
        }
    }
}
