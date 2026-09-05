#Requires -Version 7.0

[CmdletBinding()]
param(
    [string]$SigningCertificateThumbprint = "",
    [string]$SigningPfxPath = "",
    [switch]$SigningCertificateInMachineStore,
    [string]$ExpectedPublisher = "",
    [string]$ExpectedSignerThumbprint = "",
    [string]$SigningTimestampUrl = "",
    [string]$SignToolPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "hash-utils.ps1")
. (Join-Path $PSScriptRoot "path-safety.ps1")
. (Join-Path $PSScriptRoot "bun-environment.ps1")

$WindowsDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent $WindowsDirectory
$TsbotRoot = Join-Path $RepositoryRoot "tsbot"
$Bun = (Get-Command bun.exe -CommandType Application -ErrorAction Stop).Source

if ([string]::IsNullOrWhiteSpace($SigningCertificateThumbprint)) {
    $SigningCertificateThumbprint = [string]$env:SUPERIOR_SIGNING_CERTIFICATE_THUMBPRINT
}
if ([string]::IsNullOrWhiteSpace($SigningPfxPath)) {
    $SigningPfxPath = [string]$env:SUPERIOR_SIGNING_PFX_PATH
}
if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    $ExpectedPublisher = [string]$env:SUPERIOR_SIGNING_EXPECTED_PUBLISHER
}
if ([string]::IsNullOrWhiteSpace($ExpectedSignerThumbprint)) {
    $ExpectedSignerThumbprint = [string]$env:SUPERIOR_SIGNING_EXPECTED_THUMBPRINT
}
if ([string]::IsNullOrWhiteSpace($SigningTimestampUrl)) {
    $SigningTimestampUrl = if ([string]::IsNullOrWhiteSpace($env:SUPERIOR_SIGNING_TIMESTAMP_URL)) {
        "https://timestamp.digicert.com"
    }
    else {
        [string]$env:SUPERIOR_SIGNING_TIMESTAMP_URL
    }
}
if ([string]::IsNullOrWhiteSpace($SignToolPath)) {
    $SignToolPath = [string]$env:SUPERIOR_SIGNTOOL_PATH
}
$HasThumbprint = -not [string]::IsNullOrWhiteSpace($SigningCertificateThumbprint)
$HasPfx = -not [string]::IsNullOrWhiteSpace($SigningPfxPath)
if ($HasThumbprint -eq $HasPfx) {
    throw "Production release requires exactly one signing certificate thumbprint or PFX path."
}
if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    throw "Production release requires the exact expected Authenticode publisher."
}
$ExpectedSignerThumbprint = ($ExpectedSignerThumbprint -replace "\s", "").ToUpperInvariant()
if ($ExpectedSignerThumbprint -notmatch "^[A-F0-9]{40}$") {
    throw "Production release requires an independently configured 40-character signer thumbprint."
}
if ([string]::IsNullOrWhiteSpace($SigningTimestampUrl)) {
    throw "Production release requires a trusted RFC 3161 timestamp URL."
}

function Invoke-BunChecked {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $BunEnvironmentSnapshot = Enter-BunBuildEnvironment
    Push-Location $TsbotRoot
    try {
        & $Bun @Arguments
        $ExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
        Exit-BunBuildEnvironment -Snapshot $BunEnvironmentSnapshot
    }
    if ($ExitCode -ne 0) {
        throw "bun $($Arguments -join ' ') failed with exit code $ExitCode. The version was not bumped again; fix the failure and rerun bun run release:build."
    }
}

function Publish-ValidatedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $ResolvedSource = [System.IO.Path]::GetFullPath($Source)
    $ResolvedDestination = [System.IO.Path]::GetFullPath($Destination)
    $DestinationParent = Split-Path -Parent $ResolvedDestination
    [void](Assert-PathHasNoReparsePoint -Path $ResolvedSource -Description "Release publication source")
    [void](Initialize-SafeDirectory -Path $DestinationParent -Description "Release publication directory")
    [void](Assert-PathHasNoReparsePoint -Path $ResolvedDestination -Description "Release publication target")
    $Temporary = Join-Path $DestinationParent (
        "." + [System.IO.Path]::GetFileName($ResolvedDestination) + "." +
        [System.Guid]::NewGuid().ToString("N") + ".publish"
    )
    $Rollback = "$Temporary.rollback"
    try {
        [void](Assert-PathHasNoReparsePoint -Path $DestinationParent -Description "Release publication directory")
        [void](Assert-PathHasNoReparsePoint -Path $Temporary -Description "Temporary release publication file")
        Copy-Item -LiteralPath $ResolvedSource -Destination $Temporary
        if ((Get-Sha256Hex -LiteralPath $Temporary) -ne (Get-Sha256Hex -LiteralPath $ResolvedSource)) {
            throw "Release publication copy failed SHA-256 verification."
        }
        if (Test-Path -LiteralPath $ResolvedDestination -PathType Leaf) {
            [void](Assert-PathHasNoReparsePoint -Path $ResolvedDestination -Description "Release publication target")
            [void](Assert-PathHasNoReparsePoint -Path $Temporary -Description "Temporary release publication file")
            [System.IO.File]::Replace($Temporary, $ResolvedDestination, $Rollback, $true)
        }
        else {
            [void](Assert-PathHasNoReparsePoint -Path $ResolvedDestination -Description "Release publication target")
            [void](Assert-PathHasNoReparsePoint -Path $Temporary -Description "Temporary release publication file")
            [System.IO.File]::Move($Temporary, $ResolvedDestination)
        }
    }
    finally {
        foreach ($Artifact in @($Temporary, $Rollback)) {
            if (Test-Path -LiteralPath $Artifact -PathType Leaf) {
                Remove-SafeOwnedFile `
                    -Path $Artifact `
                    -OwnerDirectory $DestinationParent `
                    -Description "Temporary release publication file"
            }
        }
    }
}

Invoke-BunChecked -Arguments @("run", "version:generate")
Invoke-BunChecked -Arguments @("run", "version:verify")
Invoke-BunChecked -Arguments @("run", "docs:links")
Invoke-BunChecked -Arguments @("run", "powershell:check")
Invoke-BunChecked -Arguments @("run", "format:check")
Invoke-BunChecked -Arguments @("run", "runtime:check")
Invoke-BunChecked -Arguments @("run", "test:policy")
Invoke-BunChecked -Arguments @("run", "typecheck")
Invoke-BunChecked -Arguments @("run", "test")
Invoke-BunChecked -Arguments @("run", "test:focused")
Invoke-BunChecked -Arguments @("run", "security:check")
Invoke-BunChecked -Arguments @("run", "build")
Invoke-BunChecked -Arguments @("run", "syntax:check")

& (Join-Path $WindowsDirectory "test-path-safety.ps1")

Invoke-BunChecked -Arguments @("run", "package:win:verify")
$TemporaryParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$TemporaryRoot = Join-Path $TemporaryParent (
    "Superior Bot production release " + [System.Guid]::NewGuid().ToString("N")
)
try {
    [void](Initialize-SafeDirectory -Path $TemporaryRoot -Description "Production release staging directory")
    $SignedOutput = Join-Path $TemporaryRoot "release"
    $SignedExecutable = Join-Path $TemporaryRoot "SuperiorBot.exe"
    $SignedUpdater = Join-Path $TemporaryRoot "Update.exe"
    $BuildArguments = @(
        "-OutputDirectory", $SignedOutput,
        "-StandaloneOutput", $SignedExecutable,
        "-UpdaterOutput", $SignedUpdater,
        "-ExpectedPublisher", $ExpectedPublisher,
        "-SigningTimestampUrl", $SigningTimestampUrl
    )
    if ($HasThumbprint) {
        $BuildArguments += @("-SigningCertificateThumbprint", $SigningCertificateThumbprint)
    }
    if ($HasPfx) {
        $BuildArguments += @("-SigningPfxPath", $SigningPfxPath)
    }
    if ($SigningCertificateInMachineStore) {
        $BuildArguments += "-SigningCertificateInMachineStore"
    }
    if (-not [string]::IsNullOrWhiteSpace($SignToolPath)) {
        $BuildArguments += @("-SignToolPath", $SignToolPath)
    }
    & (Join-Path $WindowsDirectory "build-portable.ps1") @BuildArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Production-signed Windows build failed with exit code $LASTEXITCODE."
    }

    $Package = Get-Content -LiteralPath (Join-Path $TsbotRoot "package.json") -Raw | ConvertFrom-Json
    $ArtifactName = "SuperiorBot-$($Package.version)-win-x64.zip"
    $SignedArchive = Join-Path $SignedOutput $ArtifactName
    & (Join-Path $WindowsDirectory "test-portable.ps1") -Artifact $SignedArchive
    & (Join-Path $WindowsDirectory "test-standalone.ps1") `
        -Executable $SignedExecutable `
        -Updater $SignedUpdater
    & (Join-Path $WindowsDirectory "verify-release.ps1") `
        -Executable $SignedExecutable `
        -Updater $SignedUpdater `
        -OutputDirectory $SignedOutput `
        -RequirePortableArtifact `
        -ExpectedPublisher $ExpectedPublisher `
        -ExpectedSignerThumbprint $ExpectedSignerThumbprint

    $FinalRelease = Join-Path $RepositoryRoot "release"
    Publish-ValidatedFile -Source $SignedExecutable -Destination (Join-Path $RepositoryRoot "SuperiorBot.exe")
    Publish-ValidatedFile -Source $SignedUpdater -Destination (Join-Path $RepositoryRoot "Update.exe")
    Publish-ValidatedFile -Source $SignedArchive -Destination (Join-Path $FinalRelease $ArtifactName)
    Publish-ValidatedFile -Source "$SignedArchive.sha256" -Destination (Join-Path $FinalRelease "$ArtifactName.sha256")

    & (Join-Path $WindowsDirectory "verify-release.ps1") `
        -Executable (Join-Path $RepositoryRoot "SuperiorBot.exe") `
        -Updater (Join-Path $RepositoryRoot "Update.exe") `
        -OutputDirectory $FinalRelease `
        -RequirePortableArtifact `
        -ExpectedPublisher $ExpectedPublisher `
        -ExpectedSignerThumbprint $ExpectedSignerThumbprint
    $Hash = Get-Sha256Hex -LiteralPath (Join-Path $RepositoryRoot "SuperiorBot.exe")
    Write-Host "Superior Bot release $($Package.version) is reproducible and verified."
    Write-Host "SuperiorBot.exe SHA-256: $Hash"
}
finally {
    if (Test-Path -LiteralPath $TemporaryRoot) {
        Remove-SafeOwnedTree `
            -Path $TemporaryRoot `
            -OwnerDirectory $TemporaryParent `
            -Description "Production release staging directory"
    }
}
