[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Artifact
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "hash-utils.ps1")

$ResolvedArtifact = (Resolve-Path -LiteralPath $Artifact).Path
if ([System.IO.Path]::GetExtension($ResolvedArtifact) -ne ".zip") {
    throw "Portable artifact must be a ZIP file: $ResolvedArtifact"
}
$ChecksumPath = "$ResolvedArtifact.sha256"
if (Test-Path -LiteralPath $ChecksumPath -PathType Leaf) {
    $ChecksumLine = (Get-Content -LiteralPath $ChecksumPath -Raw).Trim()
    if ($ChecksumLine -notmatch "^([a-f0-9]{64})  (.+\.zip)$") {
        throw "Invalid artifact checksum file: $ChecksumPath"
    }
    if ($Matches[2] -ne [System.IO.Path]::GetFileName($ResolvedArtifact)) {
        throw "Artifact checksum names a different ZIP: $($Matches[2])"
    }
    $ArchiveHash = Get-Sha256Hex -LiteralPath $ResolvedArtifact
    if ($ArchiveHash -ne $Matches[1]) {
        throw "Artifact ZIP SHA-256 mismatch."
    }
}

$TemporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("SuperiorBot-portable-test-" + [System.Guid]::NewGuid().ToString("N"))
$SavedEnvironment = @{}
$EnvironmentNames = @(
    "DB_FILE",
    "DISCORD_TOKEN",
    "ENV_FILE",
    "COMMAND_REGISTRATION_MODE",
    "DEV_GUILD_IDS",
    "SUPERIOR_PORTABLE_EXPECT_ENV",
    "SUPERIOR_PORTABLE_EXPECT_ROOT",
    "SUPERIOR_PORTABLE_EXPECT_DB"
)
foreach ($Name in $EnvironmentNames) {
    $SavedEnvironment[$Name] = [System.Environment]::GetEnvironmentVariable($Name, "Process")
}

function Invoke-AndRequireSuccess {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$ExpectedText
    )

    $Output = & $Executable @Arguments 2>&1 | Out-String
    $ExitCode = $LASTEXITCODE
    if ($ExitCode -ne 0) {
        throw "Command failed with exit code ${ExitCode}: $Executable $($Arguments -join ' ')`n$Output"
    }
    if (-not $Output.Contains($ExpectedText)) {
        throw "Command output did not contain '$ExpectedText':`n$Output"
    }
}

try {
    New-Item -ItemType Directory -Path $TemporaryRoot | Out-Null
    Expand-Archive -LiteralPath $ResolvedArtifact -DestinationPath $TemporaryRoot
    $Roots = @(Get-ChildItem -LiteralPath $TemporaryRoot -Directory)
    if ($Roots.Count -ne 1) {
        throw "Expected one top-level portable directory; found $($Roots.Count)."
    }
    $PortableRoot = $Roots[0].FullName

    $RequiredFiles = @(
        "SuperiorBot.exe",
        "Start Superior Bot.cmd",
        ".env.example",
        "README-WINDOWS.txt",
        "BUILD-INFO.txt",
        "VERSION",
        "MANIFEST.sha256",
        "runtime\node.exe",
        "tools\check-portable.mjs",
        "tools\diagnostics.mjs",
        "app\dist\src\index.js",
        "app\dist\src\storage\backup-cli.js",
        "app\dist\src\storage\check-cli.js",
        "app\dist\src\storage\legacy-v2-converter.js",
        "app\dist\src\storage\migrate-cli.js"
    )
    foreach ($Relative in $RequiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $PortableRoot $Relative) -PathType Leaf)) {
            throw "Portable artifact is missing $Relative"
        }
    }
    foreach ($DevelopmentPackage in @("prettier", "tsx", "typescript", "vitest")) {
        if (Test-Path -LiteralPath (Join-Path $PortableRoot "app\node_modules\$DevelopmentPackage")) {
            throw "Portable artifact contains development-only package $DevelopmentPackage."
        }
    }

    $NativeAddons = @(Get-ChildItem -LiteralPath (Join-Path $PortableRoot "app\node_modules\better-sqlite3") -Filter "better_sqlite3.node" -Recurse -File)
    if ($NativeAddons.Count -ne 1) {
        throw "Expected exactly one better-sqlite3 native binary; found $($NativeAddons.Count)."
    }
    $NativeAddonHash = Get-Sha256Hex -LiteralPath $NativeAddons[0].FullName

    $Forbidden = Get-ChildItem -LiteralPath $PortableRoot -Recurse -Force | Where-Object {
        $Relative = $_.FullName.Substring($PortableRoot.Length).TrimStart("\").Replace("\", "/")
        $_.Name -eq ".env" -or
        ($_.Name.StartsWith(".env") -and $_.Name -ne ".env.example") -or
        $_.Name -eq "mudae-watch.private.json" -or
        $_.Name.EndsWith(".private.json") -or
        $_.Extension -in @(".db", ".sqlite", ".sqlite3", ".backup", ".bak", ".log") -or
        $Relative -match "(^|/)(data|backups)(/|$)" -or
        $Relative -match "^app/(dist/)?tests(/|$)"
    }
    if (@($Forbidden).Count -gt 0) {
        throw "Portable artifact contains forbidden files: $(@($Forbidden.FullName) -join ', ')"
    }
    $MigrationCompatibilityFiles = @(
        Get-ChildItem -LiteralPath (Join-Path $PortableRoot "app\dist\src") -Recurse -File |
            Where-Object { $_.Name -like "legacy-*" } |
            ForEach-Object {
                $_.FullName.Substring($PortableRoot.Length).TrimStart("\").Replace("\", "/")
            }
    )
    if (
        $MigrationCompatibilityFiles.Count -ne 1 -or
        $MigrationCompatibilityFiles[0] -ne "app/dist/src/storage/legacy-v2-converter.js"
    ) {
        throw "Portable artifact contains an unexpected migration-compatibility file."
    }

    $ManifestPath = Join-Path $PortableRoot "MANIFEST.sha256"
    $ManifestEntries = @{}
    foreach ($Line in Get-Content -LiteralPath $ManifestPath) {
        if ($Line -notmatch "^([a-f0-9]{64})  (.+)$") {
            throw "Invalid manifest line: $Line"
        }
        $ExpectedHash = $Matches[1]
        $Relative = $Matches[2].Replace("/", "\")
        if ($ManifestEntries.ContainsKey($Relative)) {
            throw "Duplicate manifest entry: $Relative"
        }
        $ManifestEntries[$Relative] = $ExpectedHash
        $ManifestFile = [System.IO.Path]::GetFullPath((Join-Path $PortableRoot $Relative))
        $RootPrefix = [System.IO.Path]::GetFullPath($PortableRoot).TrimEnd("\") + "\"
        if (-not $ManifestFile.StartsWith($RootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Manifest entry escapes the portable directory: $Relative"
        }
        if (-not (Test-Path -LiteralPath $ManifestFile -PathType Leaf)) {
            throw "Manifest entry is missing: $Relative"
        }
        $ActualHash = Get-Sha256Hex -LiteralPath $ManifestFile
        if ($ActualHash -ne $ExpectedHash) {
            throw "Manifest hash mismatch: $Relative"
        }
    }
    $PackagedFiles = Get-ChildItem -LiteralPath $PortableRoot -Recurse -File |
        Where-Object { $_.FullName -ne $ManifestPath } |
        ForEach-Object {
            $_.FullName.Substring($PortableRoot.Length).TrimStart("\")
        } |
        Sort-Object
    $DeclaredFiles = @($ManifestEntries.Keys) | Sort-Object
    $ManifestDifference = @(Compare-Object -ReferenceObject $PackagedFiles -DifferenceObject $DeclaredFiles)
    if ($ManifestDifference.Count -gt 0) {
        throw "Manifest does not exactly cover the portable files: $($ManifestDifference.InputObject -join ', ')"
    }

    $Version = (Get-Content -LiteralPath (Join-Path $PortableRoot "VERSION") -Raw).Trim()
    $BuildInfo = ConvertFrom-StringData (Get-Content -LiteralPath (Join-Path $PortableRoot "BUILD-INFO.txt") -Raw)
    if (
        $BuildInfo.PACKAGE_NAME -ne "superior-discord-bot" -or
        $BuildInfo.PACKAGE_VERSION -ne $Version -or
        $BuildInfo.TARGET -ne "win-x64" -or
        $BuildInfo.NODE_VERSION -ne "22.12.0" -or
        $BuildInfo.NODE_ARCHIVE_SHA256 -ne "2b8f2256382f97ad51e29ff71f702961af466c4616393f767455501e6aece9b8" -or
        $BuildInfo.CSHARP_COMPILER_PACKAGE -ne "Microsoft.Net.Compilers.Toolset" -or
        $BuildInfo.CSHARP_COMPILER_VERSION -ne "4.12.0" -or
        $BuildInfo.CSHARP_COMPILER_PACKAGE_SHA256 -ne "fe24ef31a6ffcb7c49383d2fd362763dee291ad9b9d98cc0c19ef80203b99ebc" -or
        $BuildInfo.REFERENCE_ASSEMBLIES_PACKAGE -ne "Microsoft.NETFramework.ReferenceAssemblies.net48" -or
        $BuildInfo.REFERENCE_ASSEMBLIES_VERSION -ne "1.0.3" -or
        $BuildInfo.REFERENCE_ASSEMBLIES_PACKAGE_SHA256 -ne "8a7e348538e7eb91351696911689f49e3d4f63f8bab517432bbe159b8b1104a2" -or
        $BuildInfo.BETTER_SQLITE3_BINARY_SHA256 -ne "8c041ef57dd1bb55b0032306594310625b7a7a374bc48956e0858645f56919c4" -or
        $BuildInfo.BETTER_SQLITE3_BINARY_SHA256 -ne $NativeAddonHash -or
        $BuildInfo.SOURCE_SHA256 -notmatch "^[a-f0-9]{64}$"
    ) {
        throw "Portable build provenance is incomplete or inconsistent."
    }
    $PackagedLockHash = Get-Sha256Hex -LiteralPath (Join-Path $PortableRoot "app\package-lock.json")
    if ($BuildInfo.PACKAGE_LOCK_SHA256 -ne $PackagedLockHash) {
        throw "Packaged lockfile does not match BUILD-INFO.txt."
    }
    $SourceIdentityTool = Join-Path (Split-Path -Parent $PSScriptRoot) "windows\compute-source-identity.mjs"
    $CurrentSourceIdentity = (& node $SourceIdentityTool).Trim()
    if ($LASTEXITCODE -ne 0 -or $BuildInfo.SOURCE_SHA256 -ne $CurrentSourceIdentity) {
        throw "Portable payload source identity is stale."
    }

    $Launcher = Join-Path $PortableRoot "SuperiorBot.exe"
    $BatchLauncher = Join-Path $PortableRoot "Start Superior Bot.cmd"
    Invoke-AndRequireSuccess -Executable (Join-Path $PortableRoot "runtime\node.exe") -Arguments @("--version") -ExpectedText "v22.12.0"
    Invoke-AndRequireSuccess -Executable $Launcher -Arguments @("--version") -ExpectedText "Superior Bot $Version"
    Invoke-AndRequireSuccess -Executable $BatchLauncher -Arguments @("--version") -ExpectedText "Superior Bot $Version"
    $VersionInfo = (Get-Item -LiteralPath $Launcher).VersionInfo
    if ($VersionInfo.FileVersion -ne "$Version.0") {
        throw "Portable launcher FileVersion is stale: $($VersionInfo.FileVersion)"
    }
    if ($VersionInfo.ProductVersion -ne $Version) {
        throw "Portable launcher ProductVersion is stale: $($VersionInfo.ProductVersion)"
    }

    $EnvironmentText = @"
DISCORD_TOKEN=portable-smoke-test-token
DB_FILE=superior.db
COMMAND_REGISTRATION_MODE=global
DEV_GUILD_IDS=
"@
    [System.IO.File]::WriteAllText(
        (Join-Path $PortableRoot ".env"),
        $EnvironmentText,
        (New-Object System.Text.UTF8Encoding($false))
    )
    Remove-Item Env:\ENV_FILE -ErrorAction SilentlyContinue
    $env:DISCORD_TOKEN = "portable-smoke-test-token"
    $env:DB_FILE = "superior.db"
    $env:COMMAND_REGISTRATION_MODE = "global"
    $env:DEV_GUILD_IDS = ""
    $env:SUPERIOR_PORTABLE_EXPECT_ROOT = $PortableRoot
    $env:SUPERIOR_PORTABLE_EXPECT_DB = Join-Path $PortableRoot "superior.db"

    Invoke-AndRequireSuccess -Executable $Launcher -Arguments @("--check") -ExpectedText "no Discord login was attempted"
    Invoke-AndRequireSuccess -Executable $BatchLauncher -Arguments @("--check") -ExpectedText "no Discord login was attempted"
    $AlternateEnvironment = Join-Path $PortableRoot ".env.validation"
    [System.IO.File]::WriteAllText(
        $AlternateEnvironment,
        $EnvironmentText,
        (New-Object System.Text.UTF8Encoding($false))
    )
    try {
        $env:ENV_FILE = $AlternateEnvironment
        Invoke-AndRequireSuccess -Executable $Launcher -Arguments @("--check") -ExpectedText "no Discord login was attempted"
    }
    finally {
        Remove-Item Env:\ENV_FILE -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $AlternateEnvironment -Force -ErrorAction SilentlyContinue
    }
    $DiagnosticsOutput = & $Launcher --diagnostics 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "Portable diagnostics failed:`n$DiagnosticsOutput"
    }
    foreach ($ExpectedDiagnostic in @(
        "executableVersion=$Version",
        "payloadVersion=$Version",
        "sourceSha256=$CurrentSourceIdentity",
        "nodeVersion=v22.12.0",
        "commandRegistrationMode=global",
        "completed without Discord login"
    )) {
        if (-not $DiagnosticsOutput.Contains($ExpectedDiagnostic)) {
            throw "Portable diagnostics omitted '$ExpectedDiagnostic':`n$DiagnosticsOutput"
        }
    }
    if ($DiagnosticsOutput.Contains("portable-smoke-test-token")) {
        throw "Portable diagnostics exposed the Discord token."
    }
    if (Test-Path -LiteralPath (Join-Path $PortableRoot "superior.db")) {
        throw "Portable --check unexpectedly created a database file."
    }

    # The portable root is operator-writable. Runtime data must not invalidate
    # the signed payload boundary, while undeclared executable payload files do.
    foreach ($MutableRelative in @("superior.db", "superior.db-wal", "operator.log", "operator.backup")) {
        [System.IO.File]::WriteAllText(
            (Join-Path $PortableRoot $MutableRelative),
            "portable mutable-data smoke test",
            (New-Object System.Text.UTF8Encoding($false))
        )
    }
    Invoke-AndRequireSuccess -Executable $Launcher -Arguments @("--version") -ExpectedText "Superior Bot $Version"

    $UndeclaredPayloadFile = Join-Path $PortableRoot "app\undeclared-runtime.js"
    [System.IO.File]::WriteAllText(
        $UndeclaredPayloadFile,
        "// undeclared payload smoke test",
        (New-Object System.Text.UTF8Encoding($false))
    )
    try {
        $PriorErrorActionPreference = $ErrorActionPreference
        try {
            # This invocation must fail and writes its recovery message to
            # stderr. Capture that expected native failure without allowing
            # the script-wide Stop preference to terminate the assertion.
            $ErrorActionPreference = "Continue"
            $UndeclaredOutput = & $Launcher --version 2>&1 | Out-String
            $UndeclaredExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $PriorErrorActionPreference
        }
        if (
            $UndeclaredExitCode -eq 0 -or
            -not $UndeclaredOutput.Contains("application payload contains an undeclared file")
        ) {
            throw "Portable launcher accepted an undeclared executable payload file:`n$UndeclaredOutput"
        }
    }
    finally {
        Remove-Item -LiteralPath $UndeclaredPayloadFile -Force -ErrorAction SilentlyContinue
    }

    Write-Host "Portable launcher, configuration, manifest, and native SQLite smoke checks passed."
}
finally {
    foreach ($Name in $EnvironmentNames) {
        $Value = $SavedEnvironment[$Name]
        [System.Environment]::SetEnvironmentVariable($Name, $Value, "Process")
    }
    $ResolvedTemporaryRoot = [System.IO.Path]::GetFullPath($TemporaryRoot)
    $ExpectedPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\") + "\"
    if (
        $ResolvedTemporaryRoot.StartsWith($ExpectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($ResolvedTemporaryRoot).StartsWith("SuperiorBot-portable-test-") -and
        (Test-Path -LiteralPath $ResolvedTemporaryRoot)
    ) {
        Remove-Item -LiteralPath $ResolvedTemporaryRoot -Recurse -Force
    }
}
