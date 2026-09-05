#Requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Updater,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "hash-utils.ps1")
. (Join-Path $PSScriptRoot "path-safety.ps1")

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Package = Get-Content -LiteralPath (Join-Path $RepositoryRoot "tsbot\package.json") -Raw | ConvertFrom-Json
$Version = [string]$Package.version
$ArtifactName = "SuperiorBot-$Version-win-x64"
$ResolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$ResolvedUpdater = (Resolve-Path -LiteralPath $Updater).Path
$ResolvedOutput = (Resolve-Path -LiteralPath $OutputDirectory).Path
$BaselineArchive = Join-Path $ResolvedOutput "$ArtifactName.zip"
$BaselineChecksum = "$BaselineArchive.sha256"
$Verifier = Join-Path $PSScriptRoot "verify-release.ps1"
$ZipWriter = Join-Path $PSScriptRoot "write-deterministic-zip.mjs"
$Bun = (Get-Command bun.exe -CommandType Application -ErrorAction Stop).Source
$TemporaryParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$TemporaryRoot = Join-Path $TemporaryParent ("Superior Bot verifier tests " + [guid]::NewGuid().ToString("N"))
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

foreach ($Required in @($ResolvedExecutable, $ResolvedUpdater, $BaselineArchive, $BaselineChecksum)) {
    [void](Assert-PathHasNoReparsePoint -Path $Required -Description "Verifier-test input")
    if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) {
        throw "Verifier-test input is missing: $Required"
    }
}

function New-CaseFixture {
    param([Parameter(Mandatory = $true)][string]$Name)

    $Root = Join-Path $TemporaryRoot $Name
    $Release = Join-Path $Root "release"
    [void](Initialize-SafeDirectory -Path $Release -Description "Verifier negative fixture")
    [System.IO.File]::Copy($ResolvedExecutable, (Join-Path $Root "SuperiorBot.exe"), $false)
    [System.IO.File]::Copy($ResolvedUpdater, (Join-Path $Root "Update.exe"), $false)
    [System.IO.File]::Copy($BaselineArchive, (Join-Path $Release "$ArtifactName.zip"), $false)
    [System.IO.File]::Copy($BaselineChecksum, (Join-Path $Release "$ArtifactName.zip.sha256"), $false)
    return [pscustomobject]@{
        Root = $Root
        Release = $Release
        Executable = (Join-Path $Root "SuperiorBot.exe")
        Updater = (Join-Path $Root "Update.exe")
        Archive = (Join-Path $Release "$ArtifactName.zip")
        Checksum = (Join-Path $Release "$ArtifactName.zip.sha256")
    }
}

function Invoke-ExpectedVerifierFailure {
    param(
        [Parameter(Mandatory = $true)]$Fixture,
        [Parameter(Mandatory = $true)][string]$ExpectedText
    )

    $PriorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $Output = & pwsh `
            -NoLogo `
            -NoProfile `
            -NonInteractive `
            -ExecutionPolicy Bypass `
            -File $Verifier `
            -Executable $Fixture.Executable `
            -Updater $Fixture.Updater `
            -OutputDirectory $Fixture.Release `
            -RequirePortableArtifact `
            -AllowUnsignedDevelopment 2>&1 | Out-String
        $ExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PriorPreference
    }
    $ComparableOutput = (
        $Output -replace "$([char]27)\[[0-?]*[ -/]*[@-~]", ""
    ) -replace "\s+", " "
    $ComparableExpected = $ExpectedText -replace "\s+", " "
    if ($ExitCode -eq 0 -or -not $ComparableOutput.Contains($ComparableExpected)) {
        throw "Verifier negative fixture did not fail with '$ExpectedText'. Exit=$ExitCode`n$Output"
    }
}

function Invoke-ExpectedVerifierSuccess {
    $Output = & pwsh `
        -NoLogo `
        -NoProfile `
        -NonInteractive `
        -ExecutionPolicy Bypass `
        -File $Verifier `
        -Executable $ResolvedExecutable `
        -Updater $ResolvedUpdater `
        -OutputDirectory $ResolvedOutput `
        -RequirePortableArtifact `
        -AllowUnsignedDevelopment 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "Release-verifier baseline fixture failed unexpectedly.`n$Output"
    }
}

function Expand-CaseArchive {
    param([Parameter(Mandatory = $true)]$Fixture)

    $Stage = Join-Path $Fixture.Root "stage"
    [void](Initialize-SafeDirectory -Path $Stage -Description "Verifier fixture staging")
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Fixture.Archive, $Stage)
    [void](Assert-PathTreeHasNoReparsePoint -Path $Stage -Description "Verifier fixture staging")
    return [pscustomobject]@{
        Stage = $Stage
        PortableRoot = (Join-Path $Stage $ArtifactName)
    }
}

function Update-ManifestHash {
    param(
        [Parameter(Mandatory = $true)][string]$PortableRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $ManifestPath = Join-Path $PortableRoot "MANIFEST.sha256"
    $NewHash = Get-Sha256Hex -LiteralPath (Join-Path $PortableRoot $RelativePath.Replace("/", "\"))
    $Found = $false
    $Lines = foreach ($Line in [System.IO.File]::ReadAllLines($ManifestPath)) {
        if ($Line.EndsWith("  $RelativePath", [System.StringComparison]::Ordinal)) {
            $Found = $true
            "$NewHash  $RelativePath"
        }
        else {
            $Line
        }
    }
    if (-not $Found) {
        throw "Verifier fixture could not find $RelativePath in MANIFEST.sha256."
    }
    [System.IO.File]::WriteAllLines($ManifestPath, $Lines, $Utf8NoBom)
}

function Publish-CaseArchive {
    param(
        [Parameter(Mandatory = $true)]$Fixture,
        [Parameter(Mandatory = $true)][string]$PortableRoot
    )

    [System.IO.File]::Delete($Fixture.Archive)
    & $Bun --no-env-file $ZipWriter $PortableRoot $Fixture.Archive
    if ($LASTEXITCODE -ne 0) {
        throw "Could not repack a verifier negative fixture."
    }
    $Hash = Get-Sha256Hex -LiteralPath $Fixture.Archive
    [System.IO.File]::WriteAllText(
        $Fixture.Checksum,
        "$Hash  $ArtifactName.zip`n",
        $Utf8NoBom
    )
}

try {
    [void](Initialize-SafeDirectory -Path $TemporaryRoot -Description "Release-verifier test directory")
    Invoke-ExpectedVerifierSuccess

    $MissingSidecar = New-CaseFixture -Name "missing-sidecar"
    [System.IO.File]::Delete($MissingSidecar.Checksum)
    Invoke-ExpectedVerifierFailure -Fixture $MissingSidecar -ExpectedText "checksum is missing"

    $MalformedSidecar = New-CaseFixture -Name "malformed-sidecar"
    [System.IO.File]::AppendAllText($MalformedSidecar.Checksum, "`n", $Utf8NoBom)
    Invoke-ExpectedVerifierFailure -Fixture $MalformedSidecar -ExpectedText "Portable artifact checksum must contain"

    $WrongSidecarName = New-CaseFixture -Name "wrong-sidecar-name"
    $ArchiveHash = Get-Sha256Hex -LiteralPath $WrongSidecarName.Archive
    [System.IO.File]::WriteAllText($WrongSidecarName.Checksum, "$ArchiveHash  other.zip`n", $Utf8NoBom)
    Invoke-ExpectedVerifierFailure -Fixture $WrongSidecarName -ExpectedText "names a different ZIP"

    $WrongSidecarHash = New-CaseFixture -Name "wrong-sidecar-hash"
    [System.IO.File]::WriteAllText(
        $WrongSidecarHash.Checksum,
        "$('0' * 64)  $ArtifactName.zip`n",
        $Utf8NoBom
    )
    Invoke-ExpectedVerifierFailure -Fixture $WrongSidecarHash -ExpectedText "does not match the published ZIP"

    $UnexpectedInventory = New-CaseFixture -Name "unexpected-inventory"
    $UnexpectedStage = Expand-CaseArchive -Fixture $UnexpectedInventory
    [System.IO.File]::WriteAllText(
        (Join-Path $UnexpectedStage.PortableRoot "unexpected.txt"),
        "not part of the release contract",
        $Utf8NoBom
    )
    Publish-CaseArchive -Fixture $UnexpectedInventory -PortableRoot $UnexpectedStage.PortableRoot
    Invoke-ExpectedVerifierFailure -Fixture $UnexpectedInventory -ExpectedText "unexpected entry"

    $WrongRoot = New-CaseFixture -Name "wrong-root"
    $WrongRootStage = Expand-CaseArchive -Fixture $WrongRoot
    $WrongPortableRoot = Join-Path $WrongRootStage.Stage "wrong-$ArtifactName"
    [void](Assert-PathInsideDirectory `
        -Path $WrongRootStage.PortableRoot `
        -OwnerDirectory $WrongRootStage.Stage `
        -Description "Original verifier fixture root")
    [void](Assert-PathTreeHasNoReparsePoint `
        -Path $WrongRootStage.PortableRoot `
        -Description "Original verifier fixture root")
    [void](Assert-PathInsideDirectory `
        -Path $WrongPortableRoot `
        -OwnerDirectory $WrongRootStage.Stage `
        -Description "Wrong-root verifier fixture")
    [void](Assert-PathHasNoReparsePoint `
        -Path $WrongPortableRoot `
        -Description "Wrong-root verifier fixture")
    [System.IO.Directory]::Move($WrongRootStage.PortableRoot, $WrongPortableRoot)
    Publish-CaseArchive -Fixture $WrongRoot -PortableRoot $WrongPortableRoot
    Invoke-ExpectedVerifierFailure -Fixture $WrongRoot -ExpectedText "unexpected entry"

    $MissingInventory = New-CaseFixture -Name "missing-inventory"
    $MissingStage = Expand-CaseArchive -Fixture $MissingInventory
    Remove-SafeOwnedFile `
        -Path (Join-Path $MissingStage.PortableRoot "README-WINDOWS.txt") `
        -OwnerDirectory $MissingStage.PortableRoot `
        -Description "Missing-entry verifier fixture"
    Publish-CaseArchive -Fixture $MissingInventory -PortableRoot $MissingStage.PortableRoot
    Invoke-ExpectedVerifierFailure -Fixture $MissingInventory -ExpectedText "missing required entries"

    $DuplicateBuildInfo = New-CaseFixture -Name "duplicate-build-info"
    $DuplicateStage = Expand-CaseArchive -Fixture $DuplicateBuildInfo
    $DuplicateBuildInfoPath = Join-Path $DuplicateStage.PortableRoot "BUILD-INFO.txt"
    [System.IO.File]::AppendAllText($DuplicateBuildInfoPath, "SOURCE_SHA256=$('0' * 64)`n", $Utf8NoBom)
    Update-ManifestHash -PortableRoot $DuplicateStage.PortableRoot -RelativePath "BUILD-INFO.txt"
    Publish-CaseArchive -Fixture $DuplicateBuildInfo -PortableRoot $DuplicateStage.PortableRoot
    Invoke-ExpectedVerifierFailure -Fixture $DuplicateBuildInfo -ExpectedText "duplicate key: SOURCE_SHA256"

    $MalformedBuildInfo = New-CaseFixture -Name "malformed-build-info"
    $MalformedStage = Expand-CaseArchive -Fixture $MalformedBuildInfo
    $MalformedBuildInfoPath = Join-Path $MalformedStage.PortableRoot "BUILD-INFO.txt"
    [System.IO.File]::AppendAllText($MalformedBuildInfoPath, "MALFORMED_BUILD_INFO_LINE`n", $Utf8NoBom)
    Update-ManifestHash -PortableRoot $MalformedStage.PortableRoot -RelativePath "BUILD-INFO.txt"
    Publish-CaseArchive -Fixture $MalformedBuildInfo -PortableRoot $MalformedStage.PortableRoot
    Invoke-ExpectedVerifierFailure -Fixture $MalformedBuildInfo -ExpectedText "malformed line"

    $DifferentUpdater = New-CaseFixture -Name "different-updater"
    $UpdaterStream = [System.IO.File]::Open(
        $DifferentUpdater.Updater,
        [System.IO.FileMode]::Append,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try {
        $UpdaterStream.WriteByte(0x41)
        $UpdaterStream.Flush($true)
    }
    finally {
        $UpdaterStream.Dispose()
    }
    Invoke-ExpectedVerifierFailure -Fixture $DifferentUpdater -ExpectedText "not byte-identical to the updater"

    $DifferentPayload = New-CaseFixture -Name "different-payload"
    $PayloadStage = Expand-CaseArchive -Fixture $DifferentPayload
    [System.IO.File]::AppendAllText(
        (Join-Path $PayloadStage.PortableRoot ".env.example"),
        "# verifier payload-binding fixture`n",
        $Utf8NoBom
    )
    Update-ManifestHash -PortableRoot $PayloadStage.PortableRoot -RelativePath ".env.example"
    Publish-CaseArchive -Fixture $DifferentPayload -PortableRoot $PayloadStage.PortableRoot
    Invoke-ExpectedVerifierFailure -Fixture $DifferentPayload -ExpectedText "embedded payload does not match"

    Write-Host "Release-verifier baseline and negative tests passed: sidecar, root/inventory, strict BUILD-INFO, updater equality, and embedded-payload binding."
}
finally {
    if (Test-Path -LiteralPath $TemporaryRoot) {
        Remove-SafeOwnedTree `
            -Path $TemporaryRoot `
            -OwnerDirectory $TemporaryParent `
            -Description "Release-verifier test directory"
    }
}
