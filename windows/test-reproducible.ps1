[CmdletBinding()]
param(
    [string]$OutputDirectory = "release"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

Write-Host "Building the first portable artifact..."
& $BuildScript -OutputDirectory $OutputDirectory
$FirstHash = (Get-FileHash -LiteralPath $Artifact -Algorithm SHA256).Hash.ToLowerInvariant()

Write-Host "Rebuilding from clean staging to verify byte-for-byte reproducibility..."
& $BuildScript -OutputDirectory $OutputDirectory
$SecondHash = (Get-FileHash -LiteralPath $Artifact -Algorithm SHA256).Hash.ToLowerInvariant()

if ($FirstHash -ne $SecondHash) {
    throw "Portable rebuild was not byte-for-byte reproducible: $FirstHash != $SecondHash"
}

Write-Host "Reproducible portable SHA-256: $SecondHash"
