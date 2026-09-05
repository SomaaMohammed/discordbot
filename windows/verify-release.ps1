#Requires -Version 7.0

[CmdletBinding()]
param(
    [string]$Executable = "windows/.artifacts/development/SuperiorBot.exe",
    [string]$Updater = "windows/.artifacts/development/Update.exe",
    [string]$OutputDirectory = "windows/.artifacts/development/release",
    [string]$ExpectedPublisher = "",
    [string]$ExpectedSignerThumbprint = "",
    [switch]$AllowUnsignedDevelopment,
    [switch]$RequirePortableArtifact
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "hash-utils.ps1")
. (Join-Path $PSScriptRoot "path-safety.ps1")
. (Join-Path $PSScriptRoot "bun-environment.ps1")

$WindowsDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent $WindowsDirectory
$Package = Get-Content -LiteralPath (Join-Path $RepositoryRoot "tsbot\package.json") -Raw | ConvertFrom-Json
$ExpectedVersion = [string]$Package.version
$ExpectedRootName = "SuperiorBot-$ExpectedVersion-win-x64"
$SupportedBunVersion = "1.4.0"
$ExpectedCompilerPackageSha256 = "fe24ef31a6ffcb7c49383d2fd362763dee291ad9b9d98cc0c19ef80203b99ebc"
$ExpectedReferencePackageSha256 = "8a7e348538e7eb91351696911689f49e3d4f63f8bab517432bbe159b8b1104a2"
if ($ExpectedVersion -notmatch "^\d+\.\d+\.\d+$") {
    throw "Package version must be MAJOR.MINOR.PATCH: $ExpectedVersion"
}

function Resolve-RepositoryPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot $Path))
}

function Get-NormalizedThumbprint {
    param([Parameter(Mandatory = $true)][string]$Thumbprint)

    $Normalized = ($Thumbprint -replace "\s", "").ToUpperInvariant()
    if ($Normalized -notmatch "^[A-F0-9]{40}$") {
        throw "The expected signer thumbprint must be a 40-character SHA-1 hexadecimal value."
    }
    return $Normalized
}

function Assert-ReleaseSignature {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][bool]$SigningRequired
    )

    [void](Assert-PathHasNoReparsePoint -Path $FileName -Description $Description)
    $Signature = Get-AuthenticodeSignature -LiteralPath $FileName
    if (-not $SigningRequired) {
        if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
            throw "$Description is unexpectedly signed in unsigned development mode."
        }
        return
    }
    if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "$Description failed Authenticode verification: $($Signature.Status)."
    }
    if (
        $null -eq $Signature.SignerCertificate -or
        -not [string]::Equals(
            $Signature.SignerCertificate.Subject,
            $ExpectedPublisher,
            [System.StringComparison]::Ordinal
        ) -or
        $Signature.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $NormalizedExpectedThumbprint
    ) {
        throw "$Description signer does not match the independently configured publisher and thumbprint."
    }
    if ($null -eq $Signature.TimeStamperCertificate) {
        throw "$Description has no trusted Authenticode timestamp."
    }
}

function Assert-VersionMetadata {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string]$Description
    )

    [void](Assert-PathHasNoReparsePoint -Path $FileName -Description $Description)
    $VersionInfo = (Get-Item -LiteralPath $FileName).VersionInfo
    if ($VersionInfo.FileVersion -ne "$ExpectedVersion.0") {
        throw "$Description FileVersion is stale. Expected $ExpectedVersion.0; got $($VersionInfo.FileVersion)."
    }
    if ($VersionInfo.ProductVersion -ne $ExpectedVersion) {
        throw "$Description ProductVersion is stale. Expected $ExpectedVersion; got $($VersionInfo.ProductVersion)."
    }
}

function Assert-CommandOutputLine {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$ExpectedLine,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $Output = & $FileName @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE.`n$Output"
    }
    $Lines = @($Output -split "\r?\n" | Where-Object { $_ -ne "" })
    if (-not ($Lines -ccontains $ExpectedLine)) {
        throw "$Description did not emit the exact expected line '$ExpectedLine'.`n$Output"
    }
}

function Read-StrictBuildInfo {
    param([Parameter(Mandatory = $true)][string]$FileName)

    $ExpectedKeys = @(
        "PACKAGE_NAME", "PACKAGE_VERSION", "TARGET", "BUN_VERSION",
        "BUN_EXECUTABLE_SHA256", "COMPILED_RUNTIME_SHA256",
        "CSHARP_COMPILER_PACKAGE", "CSHARP_COMPILER_VERSION",
        "CSHARP_COMPILER_PACKAGE_SHA256", "REFERENCE_ASSEMBLIES_PACKAGE",
        "REFERENCE_ASSEMBLIES_VERSION", "REFERENCE_ASSEMBLIES_PACKAGE_SHA256",
        "BUN_LOCK_SHA256", "SOURCE_SHA256", "SIGNING_MODE",
        "SIGNATURE_STATUS", "SIGNING_SUBJECT", "SIGNING_THUMBPRINT",
        "TIMESTAMP_STATUS"
    )
    $Allowed = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    foreach ($ExpectedKey in $ExpectedKeys) {
        [void]$Allowed.Add($ExpectedKey)
    }
    $Values = [System.Collections.Generic.Dictionary[string, string]]::new(
        [System.StringComparer]::Ordinal
    )
    foreach ($Line in [System.IO.File]::ReadAllLines($FileName)) {
        if ($Line -notmatch "^([A-Z][A-Z0-9_]*)=(.*)$") {
            throw "BUILD-INFO.txt contains a malformed line."
        }
        $Key = $Matches[1]
        if (-not $Allowed.Contains($Key)) {
            throw "BUILD-INFO.txt contains an unsupported key: $Key"
        }
        if ($Values.ContainsKey($Key)) {
            throw "BUILD-INFO.txt contains a duplicate key: $Key"
        }
        $Values.Add($Key, $Matches[2])
    }
    if ($Values.Count -ne $ExpectedKeys.Count) {
        $Missing = @($ExpectedKeys | Where-Object { -not $Values.ContainsKey($_) })
        throw "BUILD-INFO.txt is missing required keys: $($Missing -join ', ')"
    }
    return $Values
}

function Expand-ReleaseArchiveChecked {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$DestinationRoot,
        [Parameter(Mandatory = $true)][string[]]$ExpectedRelativeFiles
    )

    [void](Assert-PathHasNoReparsePoint -Path $ArchivePath -Description "Portable release archive")
    [void](Initialize-SafeDirectory -Path $DestinationRoot -Description "Release verification extraction root")
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $ExpectedEntries = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    foreach ($Relative in $ExpectedRelativeFiles) {
        [void]$ExpectedEntries.Add("$ExpectedRootName/$Relative")
    }
    $Seen = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $DestinationPrefix = (Get-NormalizedFullPath -Path $DestinationRoot).TrimEnd("\") + "\"
    $Archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        [long]$TotalLength = 0
        foreach ($Entry in $Archive.Entries) {
            $Name = $Entry.FullName
            if (
                [string]::IsNullOrWhiteSpace($Name) -or
                $Name.EndsWith("/") -or
                $Name.Contains("\") -or
                -not $ExpectedEntries.Contains($Name)
            ) {
                throw "Portable archive contains an unexpected entry: $Name"
            }
            if (-not $Seen.Add($Name)) {
                throw "Portable archive contains a duplicate path: $Name"
            }
            if ($Entry.Length -lt 0 -or $Entry.Length -gt 150MB) {
                throw "Portable archive contains an oversized entry: $Name"
            }
            $TotalLength += $Entry.Length
            if ($TotalLength -gt 300MB) {
                throw "Portable archive exceeds the extraction size limit."
            }
            $UnixMode = ($Entry.ExternalAttributes -shr 16) -band 0xF000
            if ($UnixMode -eq 0xA000) {
                throw "Portable archive contains a symbolic link: $Name"
            }
            $Destination = [System.IO.Path]::GetFullPath(
                (Join-Path $DestinationRoot $Name.Replace("/", "\"))
            )
            if (-not $Destination.StartsWith($DestinationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Portable archive entry escapes the extraction root: $Name"
            }
            $DestinationParent = Split-Path -Parent $Destination
            [void](Initialize-SafeDirectory -Path $DestinationParent -Description "Portable extraction directory")
            [void](Assert-PathHasNoReparsePoint -Path $Destination -Description "Portable extraction file")
            $Input = $Entry.Open()
            try {
                $Output = [System.IO.FileStream]::new(
                    $Destination,
                    [System.IO.FileMode]::CreateNew,
                    [System.IO.FileAccess]::Write,
                    [System.IO.FileShare]::None
                )
                try {
                    $Input.CopyTo($Output)
                    $Output.Flush($true)
                }
                finally {
                    $Output.Dispose()
                }
            }
            finally {
                $Input.Dispose()
            }
            [void](Assert-PathHasNoReparsePoint -Path $Destination -Description "Portable extraction file")
        }
    }
    finally {
        $Archive.Dispose()
    }
    if ($Seen.Count -ne $ExpectedEntries.Count) {
        $Missing = @($ExpectedEntries | Where-Object { -not $Seen.Contains($_) })
        throw "Portable archive is missing required entries: $($Missing -join ', ')"
    }
    [void](Assert-PathTreeHasNoReparsePoint -Path $DestinationRoot -Description "Extracted portable release")
    return Join-Path $DestinationRoot $ExpectedRootName
}

function Read-StrictDiagnostics {
    param([Parameter(Mandatory = $true)][string]$Output)

    $Values = [System.Collections.Generic.Dictionary[string, string]]::new(
        [System.StringComparer]::Ordinal
    )
    foreach ($Line in $Output -split "\r?\n") {
        if ($Line -match "^\[diagnostics\] ([A-Za-z][A-Za-z0-9]*)=(.*)$") {
            if ($Values.ContainsKey($Matches[1])) {
                throw "Standalone diagnostics emitted a duplicate key: $($Matches[1])"
            }
            $Values.Add($Matches[1], $Matches[2])
        }
    }
    return $Values
}

$ResolvedExecutable = Resolve-RepositoryPath -Path $Executable
$ResolvedUpdater = Resolve-RepositoryPath -Path $Updater
$ResolvedOutput = Resolve-RepositoryPath -Path $OutputDirectory
$ExpectedArchive = Join-Path $ResolvedOutput "$ExpectedRootName.zip"
$ExpectedChecksum = "$ExpectedArchive.sha256"
$SigningRequired = -not $AllowUnsignedDevelopment
$NormalizedExpectedThumbprint = ""
if ($SigningRequired) {
    if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
        throw "Production release verification requires -ExpectedPublisher."
    }
    $NormalizedExpectedThumbprint = Get-NormalizedThumbprint -Thumbprint $ExpectedSignerThumbprint
}
elseif (
    -not [string]::IsNullOrWhiteSpace($ExpectedPublisher) -or
    -not [string]::IsNullOrWhiteSpace($ExpectedSignerThumbprint)
) {
    throw "Unsigned development verification cannot be combined with publisher or signer-thumbprint options."
}

foreach ($RequiredFile in @(
    @{ Path = $ResolvedExecutable; Label = "Standalone SuperiorBot.exe" },
    @{ Path = $ResolvedUpdater; Label = "External Update.exe" }
)) {
    if (-not (Test-Path -LiteralPath $RequiredFile.Path -PathType Leaf)) {
        throw "$($RequiredFile.Label) is missing: $($RequiredFile.Path)"
    }
    [void](Assert-PathHasNoReparsePoint -Path $RequiredFile.Path -Description $RequiredFile.Label)
}
[void](Assert-PathHasNoReparsePoint -Path $ResolvedOutput -Description "Release output directory")
$ArchiveExists = Test-Path -LiteralPath $ExpectedArchive -PathType Leaf
if (($RequirePortableArtifact -or $SigningRequired) -and -not $ArchiveExists) {
    throw "Versioned portable artifact is missing: $ExpectedArchive"
}

Assert-VersionMetadata -FileName $ResolvedExecutable -Description "SuperiorBot.exe"
Assert-VersionMetadata -FileName $ResolvedUpdater -Description "Update.exe"
Assert-ReleaseSignature -FileName $ResolvedExecutable -Description "Standalone SuperiorBot.exe" -SigningRequired $SigningRequired
Assert-ReleaseSignature -FileName $ResolvedUpdater -Description "External Update.exe" -SigningRequired $SigningRequired
Assert-CommandOutputLine -FileName $ResolvedExecutable -Arguments @("--version") -ExpectedLine "Superior Bot $ExpectedVersion" -Description "SuperiorBot.exe --version"
Assert-CommandOutputLine -FileName $ResolvedUpdater -Arguments @("--version") -ExpectedLine "Superior Bot updater $ExpectedVersion" -Description "Update.exe --version"

$SourceIdentityTool = Join-Path $WindowsDirectory "compute-source-identity.mjs"
$Bun = (Get-Command bun.exe -CommandType Application -ErrorAction Stop).Source
$TypeScriptSourceRoot = Join-Path $RepositoryRoot "tsbot\src"
[void](Assert-PathTreeHasNoReparsePoint `
    -Path $TypeScriptSourceRoot `
    -Description "TypeScript production source tree")
$BunEnvironmentSnapshot = Enter-BunBuildEnvironment
try {
    $CurrentSourceIdentity = (& $Bun --no-env-file $SourceIdentityTool).Trim()
    if ($LASTEXITCODE -ne 0 -or $CurrentSourceIdentity -notmatch "^[a-f0-9]{64}$") {
        throw "Could not compute the current release source identity."
    }
}
finally {
    Exit-BunBuildEnvironment -Snapshot $BunEnvironmentSnapshot
}

$ExpectedPortableRelativeFiles = @(
    ".env.example", "app/SuperiorBot.Runtime.exe", "BUILD-INFO.txt",
    "MANIFEST.sha256", "README-WINDOWS.txt", "Start Superior Bot.cmd",
    "SuperiorBot.exe", "Update.exe", "VERSION"
)
$ExpectedManifestRelativeFiles = @(
    ".env.example", "app/SuperiorBot.Runtime.exe", "BUILD-INFO.txt",
    "README-WINDOWS.txt", "Start Superior Bot.cmd", "SuperiorBot.exe",
    "Update.exe", "VERSION"
)
$TemporaryParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$TemporaryRoot = Join-Path $TemporaryParent ("SuperiorBot-release-verify-" + [System.Guid]::NewGuid().ToString("N"))
$EnvironmentNames = @(
    "BUN_BE_BUN", "BUN_OPTIONS", "COMMAND_REGISTRATION_MODE", "DB_FILE",
    "DEV_GUILD_IDS", "DISCORD_TOKEN", "ENV_FILE", "NODE_OPTIONS",
    "SUPERIOR_APPLICATION_ROOT", "SUPERIOR_DATABASE_LOCK_HELD",
    "SUPERIOR_DATABASE_LOCK_PATH", "SUPERIOR_DIAGNOSTICS_SKIP_DATABASE",
    "SUPERIOR_PORTABLE_EXPECT_DB", "SUPERIOR_PORTABLE_EXPECT_ENV",
    "SUPERIOR_PORTABLE_EXPECT_ROOT"
)
$SavedEnvironment = @{}
foreach ($Name in $EnvironmentNames) {
    $SavedEnvironment[$Name] = [System.Environment]::GetEnvironmentVariable($Name, "Process")
    [System.Environment]::SetEnvironmentVariable($Name, $null, "Process")
}

$VerifiedArchiveHash = $null
$VerifiedBunVersion = $SupportedBunVersion
try {
    [void](Initialize-SafeDirectory -Path $TemporaryRoot -Description "Release verification directory")
    if ($ArchiveExists) {
        [void](Assert-PathHasNoReparsePoint -Path $ExpectedArchive -Description "Portable release archive")
        [void](Assert-PathHasNoReparsePoint -Path $ExpectedChecksum -Description "Portable release checksum")
        if (-not (Test-Path -LiteralPath $ExpectedChecksum -PathType Leaf)) {
            throw "Portable artifact checksum is missing: $ExpectedChecksum"
        }
        $ChecksumEncoding = [System.Text.UTF8Encoding]::new($false, $true)
        $ChecksumText = $ChecksumEncoding.GetString([System.IO.File]::ReadAllBytes($ExpectedChecksum))
        if ($ChecksumText -notmatch "\A([a-f0-9]{64})  ([^\r\n]+)(?:\r\n|\n)\z") {
            throw "Portable artifact checksum must contain exactly one lowercase SHA-256 line with a trailing newline."
        }
        $SidecarHash = $Matches[1]
        $SidecarName = $Matches[2]
        if ($SidecarName -cne [System.IO.Path]::GetFileName($ExpectedArchive)) {
            throw "Portable artifact checksum names a different ZIP: $SidecarName"
        }
        $VerifiedArchiveHash = Get-Sha256Hex -LiteralPath $ExpectedArchive
        if ($VerifiedArchiveHash -cne $SidecarHash) {
            throw "Portable artifact checksum does not match the published ZIP."
        }

        $PortableRoot = Expand-ReleaseArchiveChecked `
            -ArchivePath $ExpectedArchive `
            -DestinationRoot (Join-Path $TemporaryRoot "portable") `
            -ExpectedRelativeFiles $ExpectedPortableRelativeFiles
        if ((Split-Path -Leaf $PortableRoot) -cne $ExpectedRootName) {
            throw "Portable archive root name does not match the expected release identity."
        }

        $ManifestPath = Join-Path $PortableRoot "MANIFEST.sha256"
        $Manifest = [System.Collections.Generic.Dictionary[string, string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )
        foreach ($Line in [System.IO.File]::ReadAllLines($ManifestPath)) {
            if ($Line -notmatch "^([a-f0-9]{64})  ([^\\\r\n]+)$") {
                throw "MANIFEST.sha256 contains a malformed line."
            }
            $Hash = $Matches[1]
            $Relative = $Matches[2]
            if ($Relative.StartsWith("/") -or $Relative.Contains("//") -or $Relative.Contains("..")) {
                throw "MANIFEST.sha256 contains an unsafe path: $Relative"
            }
            if ($Manifest.ContainsKey($Relative)) {
                throw "MANIFEST.sha256 contains a duplicate path: $Relative"
            }
            $Manifest.Add($Relative, $Hash)
        }
        $ManifestDifference = @(
            Compare-Object `
                -ReferenceObject ($ExpectedManifestRelativeFiles | Sort-Object) `
                -DifferenceObject (@($Manifest.Keys) | Sort-Object) `
                -CaseSensitive
        )
        if ($ManifestDifference.Count -ne 0) {
            throw "MANIFEST.sha256 does not declare the exact release inventory: $($ManifestDifference.InputObject -join ', ')"
        }
        foreach ($Relative in $ExpectedManifestRelativeFiles) {
            $ManifestFile = Join-Path $PortableRoot $Relative.Replace("/", "\")
            [void](Assert-PathHasNoReparsePoint -Path $ManifestFile -Description "Manifest-declared release file")
            if ((Get-Sha256Hex -LiteralPath $ManifestFile) -cne $Manifest[$Relative]) {
                throw "Manifest hash mismatch: $Relative"
            }
        }

        $VersionText = [System.IO.File]::ReadAllText((Join-Path $PortableRoot "VERSION")).Trim()
        if ($VersionText -cne $ExpectedVersion) {
            throw "Portable VERSION does not match package.json."
        }
        $BuildInfo = Read-StrictBuildInfo -FileName (Join-Path $PortableRoot "BUILD-INFO.txt")
        $PortableRuntime = Join-Path $PortableRoot "app\SuperiorBot.Runtime.exe"
        $PortableLauncher = Join-Path $PortableRoot "SuperiorBot.exe"
        $PortableUpdater = Join-Path $PortableRoot "Update.exe"
        $CurrentBunLockHash = Get-Sha256Hex -LiteralPath (Join-Path $RepositoryRoot "tsbot\bun.lock")
        if (
            $BuildInfo["PACKAGE_NAME"] -cne "superior-discord-bot" -or
            $BuildInfo["PACKAGE_VERSION"] -cne $ExpectedVersion -or
            $BuildInfo["TARGET"] -cne "win-x64" -or
            $BuildInfo["BUN_VERSION"] -cne $SupportedBunVersion -or
            $BuildInfo["BUN_EXECUTABLE_SHA256"] -notmatch "^[a-f0-9]{64}$" -or
            $BuildInfo["COMPILED_RUNTIME_SHA256"] -cne (Get-Sha256Hex -LiteralPath $PortableRuntime) -or
            $BuildInfo["CSHARP_COMPILER_PACKAGE"] -cne "Microsoft.Net.Compilers.Toolset" -or
            $BuildInfo["CSHARP_COMPILER_VERSION"] -cne "4.12.0" -or
            $BuildInfo["CSHARP_COMPILER_PACKAGE_SHA256"] -cne $ExpectedCompilerPackageSha256 -or
            $BuildInfo["REFERENCE_ASSEMBLIES_PACKAGE"] -cne "Microsoft.NETFramework.ReferenceAssemblies.net48" -or
            $BuildInfo["REFERENCE_ASSEMBLIES_VERSION"] -cne "1.0.3" -or
            $BuildInfo["REFERENCE_ASSEMBLIES_PACKAGE_SHA256"] -cne $ExpectedReferencePackageSha256 -or
            $BuildInfo["BUN_LOCK_SHA256"] -cne $CurrentBunLockHash -or
            $BuildInfo["SOURCE_SHA256"] -cne $CurrentSourceIdentity
        ) {
            throw "Portable BUILD-INFO provenance is stale or inconsistent."
        }
        $VerifiedBunVersion = $BuildInfo["BUN_VERSION"]
        if ($SigningRequired) {
            if (
                $BuildInfo["SIGNING_MODE"] -cne "production-signed" -or
                $BuildInfo["SIGNATURE_STATUS"] -cne "valid" -or
                $BuildInfo["TIMESTAMP_STATUS"] -cne "present-and-valid" -or
                -not [string]::Equals($BuildInfo["SIGNING_SUBJECT"], $ExpectedPublisher, [System.StringComparison]::Ordinal) -or
                (Get-NormalizedThumbprint -Thumbprint $BuildInfo["SIGNING_THUMBPRINT"]) -cne $NormalizedExpectedThumbprint
            ) {
                throw "Portable BUILD-INFO signing metadata does not match the independent release trust policy."
            }
        }
        elseif (
            $BuildInfo["SIGNING_MODE"] -cne "development-unsigned" -or
            $BuildInfo["SIGNATURE_STATUS"] -cne "unsigned" -or
            $BuildInfo["SIGNING_SUBJECT"] -cne "(unsigned)" -or
            $BuildInfo["SIGNING_THUMBPRINT"] -cne "(none)" -or
            $BuildInfo["TIMESTAMP_STATUS"] -cne "not-applicable"
        ) {
            throw "Unsigned development BUILD-INFO metadata is not exact."
        }

        foreach ($ReleaseFile in @(
            @{ Path = $PortableLauncher; Label = "Portable SuperiorBot.exe" },
            @{ Path = $PortableUpdater; Label = "Portable Update.exe" },
            @{ Path = $PortableRuntime; Label = "Compiled Bun runtime" }
        )) {
            Assert-ReleaseSignature `
                -FileName $ReleaseFile.Path `
                -Description $ReleaseFile.Label `
                -SigningRequired $SigningRequired
        }
        Assert-VersionMetadata -FileName $PortableLauncher -Description "Portable SuperiorBot.exe"
        Assert-VersionMetadata -FileName $PortableUpdater -Description "Portable Update.exe"
        Assert-CommandOutputLine -FileName $PortableLauncher -Arguments @("--version") -ExpectedLine "Superior Bot $ExpectedVersion" -Description "Portable SuperiorBot.exe --version"
        Assert-CommandOutputLine -FileName $PortableUpdater -Arguments @("--version") -ExpectedLine "Superior Bot updater $ExpectedVersion" -Description "Portable Update.exe --version"
        if ((Get-Sha256Hex -LiteralPath $PortableUpdater) -cne (Get-Sha256Hex -LiteralPath $ResolvedUpdater)) {
            throw "External Update.exe is not byte-identical to the updater in the published portable artifact."
        }
    }

    $TestExecutable = Join-Path $TemporaryRoot "SuperiorBot.exe"
    [void](Assert-PathHasNoReparsePoint -Path $TestExecutable -Description "Standalone diagnostics copy")
    [System.IO.File]::Copy($ResolvedExecutable, $TestExecutable, $false)
    [void](Assert-PathHasNoReparsePoint -Path $TestExecutable -Description "Standalone diagnostics copy")
    $env:SUPERIOR_DIAGNOSTICS_SKIP_DATABASE = "1"
    $DiagnosticsOutput = & $TestExecutable --diagnostics 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "SuperiorBot.exe --diagnostics failed:`n$DiagnosticsOutput"
    }
    $Diagnostics = Read-StrictDiagnostics -Output $DiagnosticsOutput
    $RequiredDiagnosticKeys = @(
        "executableVersion", "payloadVersion", "payloadSha256",
        "sourceSha256", "bunVersion", "sqliteBackend", "databaseSchema"
    )
    $MissingDiagnostics = @($RequiredDiagnosticKeys | Where-Object { -not $Diagnostics.ContainsKey($_) })
    if ($MissingDiagnostics.Count -ne 0) {
        throw "Standalone diagnostics omitted required keys: $($MissingDiagnostics -join ', ')`n$DiagnosticsOutput"
    }
    if (
        $Diagnostics["executableVersion"] -cne $ExpectedVersion -or
        $Diagnostics["payloadVersion"] -cne $ExpectedVersion -or
        $Diagnostics["sourceSha256"] -cne $CurrentSourceIdentity -or
        $Diagnostics["bunVersion"] -cne $VerifiedBunVersion -or
        $Diagnostics["sqliteBackend"] -cne "bun:sqlite" -or
        $Diagnostics["databaseSchema"] -cne "skipped" -or
        $Diagnostics["payloadSha256"] -notmatch "^[a-f0-9]{64}$"
    ) {
        throw "Standalone diagnostics do not match the verified release identity.`n$DiagnosticsOutput"
    }
    if ($null -ne $VerifiedArchiveHash -and $Diagnostics["payloadSha256"] -cne $VerifiedArchiveHash) {
        throw "Standalone embedded payload does not match the published portable ZIP."
    }
    if (-not ($DiagnosticsOutput -split "\r?\n" -ccontains "[diagnostics] completed without Discord login; token and private watcher values were not displayed")) {
        throw "Standalone diagnostics did not prove the offline no-login path.`n$DiagnosticsOutput"
    }
}
finally {
    foreach ($Name in $EnvironmentNames) {
        [System.Environment]::SetEnvironmentVariable($Name, $SavedEnvironment[$Name], "Process")
    }
    if (Test-Path -LiteralPath $TemporaryRoot) {
        Remove-SafeOwnedTree `
            -Path $TemporaryRoot `
            -OwnerDirectory $TemporaryParent `
            -Description "Release verification directory"
    }
}

$ExecutableHash = Get-Sha256Hex -LiteralPath $ResolvedExecutable
$UpdaterHash = Get-Sha256Hex -LiteralPath $ResolvedUpdater
Write-Host "Release identity verified: $ExpectedVersion"
Write-Host "SuperiorBot.exe SHA-256: $ExecutableHash"
Write-Host "Update.exe SHA-256: $UpdaterHash"
if ($null -ne $VerifiedArchiveHash) {
    Write-Host "$([System.IO.Path]::GetFileName($ExpectedArchive)) SHA-256: $VerifiedArchiveHash"
}
elseif (-not $RequirePortableArtifact) {
    Write-Host "Portable artifact not present; unsigned standalone identity was checked non-mutating."
}
