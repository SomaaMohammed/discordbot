[CmdletBinding()]
param(
    [string]$OutputDirectory = "release",
    [string]$StandaloneOutput = "SuperiorBot.exe"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "hash-utils.ps1")

$WindowsDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent $WindowsDirectory
$BuildScript = Join-Path $WindowsDirectory "build-portable.ps1"
$PackagePath = Join-Path $RepositoryRoot "tsbot\package.json"
$Package = Get-Content -LiteralPath $PackagePath -Raw | ConvertFrom-Json
$ArtifactName = "SuperiorBot-$($Package.version)-win-x64.zip"
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

Write-Host "Building the first portable artifact..."
& $BuildScript -OutputDirectory $OutputDirectory -StandaloneOutput $StandaloneArtifact
$FirstHash = Get-Sha256Hex -LiteralPath $Artifact
$FirstStandaloneHash = Get-Sha256Hex -LiteralPath $StandaloneArtifact

Write-Host "Rebuilding from clean staging to verify byte-for-byte reproducibility..."
& $BuildScript -OutputDirectory $OutputDirectory -StandaloneOutput $StandaloneArtifact
$SecondHash = Get-Sha256Hex -LiteralPath $Artifact
$SecondStandaloneHash = Get-Sha256Hex -LiteralPath $StandaloneArtifact

if ($FirstHash -ne $SecondHash) {
    throw "Portable rebuild was not byte-for-byte reproducible: $FirstHash != $SecondHash"
}
if ($FirstStandaloneHash -ne $SecondStandaloneHash) {
    throw "Standalone rebuild was not byte-for-byte reproducible: $FirstStandaloneHash != $SecondStandaloneHash"
}

Write-Host "Reproducible portable SHA-256: $SecondHash"
Write-Host "Reproducible standalone SHA-256: $SecondStandaloneHash"
