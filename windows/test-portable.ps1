#Requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Artifact
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "hash-utils.ps1")
. (Join-Path $PSScriptRoot "path-safety.ps1")

$ResolvedArtifact = (Resolve-Path -LiteralPath $Artifact).Path
if ([System.IO.Path]::GetExtension($ResolvedArtifact) -ne ".zip") {
    throw "Portable artifact must be a ZIP file: $ResolvedArtifact"
}
$ChecksumPath = "$ResolvedArtifact.sha256"
if (-not (Test-Path -LiteralPath $ChecksumPath -PathType Leaf)) {
    throw "Portable artifact checksum is required: $ChecksumPath"
}
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

$TemporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("Superior Bot portable test " + [System.Guid]::NewGuid().ToString("N"))
$SavedEnvironment = @{}
$EnvironmentNames = @(
    "DB_FILE",
    "DISCORD_TOKEN",
    "ENV_FILE",
    "COMMAND_REGISTRATION_MODE",
    "DEV_GUILD_IDS",
    "SUPERIOR_APPLICATION_ROOT",
    "SUPERIOR_DATABASE_LOCK_HELD",
    "SUPERIOR_DATABASE_LOCK_PATH",
    "SUPERIOR_TEST_MODE",
    "SUPERIOR_PORTABLE_EXPECT_ENV",
    "SUPERIOR_PORTABLE_EXPECT_ROOT",
    "SUPERIOR_PORTABLE_EXPECT_DB",
    "SUPERIOR_POISON_SENTINEL",
    "BUN_BE_BUN",
    "BUN_OPTIONS",
    "NODE_OPTIONS",
    "Path"
)
foreach ($Name in $EnvironmentNames) {
    $SavedEnvironment[$Name] = [System.Environment]::GetEnvironmentVariable($Name, "Process")
    if ($Name -ne "Path") {
        [System.Environment]::SetEnvironmentVariable($Name, $null, "Process")
    }
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
    [void](Initialize-SafeDirectory -Path $TemporaryRoot -Description "Portable test directory")
    Expand-Archive -LiteralPath $ResolvedArtifact -DestinationPath $TemporaryRoot
    $Roots = @(Get-ChildItem -LiteralPath $TemporaryRoot -Directory)
    if ($Roots.Count -ne 1) {
        throw "Expected one top-level portable directory; found $($Roots.Count)."
    }
    $PortableRoot = $Roots[0].FullName

    $RequiredFiles = @(
        "SuperiorBot.exe",
        "Update.exe",
        "Start Superior Bot.cmd",
        ".env.example",
        "README-WINDOWS.txt",
        "BUILD-INFO.txt",
        "VERSION",
        "MANIFEST.sha256",
        "app\SuperiorBot.Runtime.exe"
    )
    foreach ($Relative in $RequiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $PortableRoot $Relative) -PathType Leaf)) {
            throw "Portable artifact is missing $Relative"
        }
    }

    $Forbidden = Get-ChildItem -LiteralPath $PortableRoot -Recurse -Force | Where-Object {
        $Relative = $_.FullName.Substring($PortableRoot.Length).TrimStart("\").Replace("\", "/")
        $_.Name -eq ".env" -or
        ($_.Name.StartsWith(".env") -and $_.Name -ne ".env.example") -or
        $_.Name -eq "mudae-watch.private.json" -or
        $_.Name.EndsWith(".private.json") -or
        $_.Name -in @("node.exe", "bun.exe", "npm.cmd", "npx.cmd", "tsx.cmd") -or
        $_.Extension -eq ".node" -or
        $_.Extension -in @(".db", ".sqlite", ".sqlite3", ".backup", ".bak", ".log") -or
        $Relative -match "(^|/)(data|backups)(/|$)" -or
        $Relative -match "(^|/)(node_modules|better-sqlite3)(/|$)" -or
        $Relative -match "^app/(dist/)?tests(/|$)"
    }
    if (@($Forbidden).Count -gt 0) {
        throw "Portable artifact contains forbidden files: $(@($Forbidden.FullName) -join ', ')"
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
    $ExpectedPackagedFiles = @(
        ".env.example",
        "app\SuperiorBot.Runtime.exe",
        "BUILD-INFO.txt",
        "README-WINDOWS.txt",
        "Start Superior Bot.cmd",
        "SuperiorBot.exe",
        "Update.exe",
        "VERSION"
    ) | Sort-Object
    $InventoryDifference = @(
        Compare-Object `
            -ReferenceObject $ExpectedPackagedFiles `
            -DifferenceObject $PackagedFiles `
            -CaseSensitive
    )
    if ($InventoryDifference.Count -ne 0) {
        throw "Portable artifact does not match the exact release inventory: $($InventoryDifference.InputObject -join ', ')"
    }
    Write-Host "Portable artifact inventory ($($PackagedFiles.Count) files):"
    foreach ($PackagedFile in $PackagedFiles) {
        Write-Host "  $PackagedFile"
    }

    $Version = (Get-Content -LiteralPath (Join-Path $PortableRoot "VERSION") -Raw).Trim()
    $BuildInfo = ConvertFrom-StringData (Get-Content -LiteralPath (Join-Path $PortableRoot "BUILD-INFO.txt") -Raw)
    $CompiledRuntime = Join-Path $PortableRoot "app\SuperiorBot.Runtime.exe"
    $CompiledRuntimeHash = Get-Sha256Hex -LiteralPath $CompiledRuntime
    $LocalBunLockHash = Get-Sha256Hex -LiteralPath (
        Join-Path (Split-Path -Parent $PSScriptRoot) "tsbot\bun.lock"
    )
    if (
        $BuildInfo.PACKAGE_NAME -ne "superior-discord-bot" -or
        $BuildInfo.PACKAGE_VERSION -ne $Version -or
        $BuildInfo.TARGET -ne "win-x64" -or
        $BuildInfo.BUN_VERSION -ne "1.4.0" -or
        $BuildInfo.BUN_EXECUTABLE_SHA256 -notmatch "^[a-f0-9]{64}$" -or
        $BuildInfo.COMPILED_RUNTIME_SHA256 -ne $CompiledRuntimeHash -or
        $BuildInfo.BUN_LOCK_SHA256 -ne $LocalBunLockHash -or
        $BuildInfo.CSHARP_COMPILER_PACKAGE -ne "Microsoft.Net.Compilers.Toolset" -or
        $BuildInfo.CSHARP_COMPILER_VERSION -ne "4.12.0" -or
        $BuildInfo.CSHARP_COMPILER_PACKAGE_SHA256 -ne "fe24ef31a6ffcb7c49383d2fd362763dee291ad9b9d98cc0c19ef80203b99ebc" -or
        $BuildInfo.REFERENCE_ASSEMBLIES_PACKAGE -ne "Microsoft.NETFramework.ReferenceAssemblies.net48" -or
        $BuildInfo.REFERENCE_ASSEMBLIES_VERSION -ne "1.0.3" -or
        $BuildInfo.REFERENCE_ASSEMBLIES_PACKAGE_SHA256 -ne "8a7e348538e7eb91351696911689f49e3d4f63f8bab517432bbe159b8b1104a2" -or
        $BuildInfo.SOURCE_SHA256 -notmatch "^[a-f0-9]{64}$"
    ) {
        throw "Portable build provenance is incomplete or inconsistent."
    }
    $SourceIdentityTool = Join-Path (Split-Path -Parent $PSScriptRoot) "windows\compute-source-identity.mjs"
    $Bun = (Get-Command bun.exe -CommandType Application -ErrorAction Stop).Source
    $CurrentSourceIdentity = (& $Bun --no-env-file $SourceIdentityTool).Trim()
    if ($LASTEXITCODE -ne 0 -or $BuildInfo.SOURCE_SHA256 -ne $CurrentSourceIdentity) {
        throw "Portable payload source identity is stale."
    }

    $Launcher = Join-Path $PortableRoot "SuperiorBot.exe"
    $Updater = Join-Path $PortableRoot "Update.exe"
    $BatchLauncher = Join-Path $PortableRoot "Start Superior Bot.cmd"
    Invoke-AndRequireSuccess -Executable $Launcher -Arguments @("--version") -ExpectedText "Superior Bot $Version"
    Invoke-AndRequireSuccess -Executable $Updater -Arguments @("--version") -ExpectedText "Superior Bot updater $Version"
    Invoke-AndRequireSuccess -Executable $BatchLauncher -Arguments @("--version") -ExpectedText "Superior Bot $Version"
    $VersionInfo = (Get-Item -LiteralPath $Launcher).VersionInfo
    if ($VersionInfo.FileVersion -ne "$Version.0") {
        throw "Portable launcher FileVersion is stale: $($VersionInfo.FileVersion)"
    }
    if ($VersionInfo.ProductVersion -ne $Version) {
        throw "Portable launcher ProductVersion is stale: $($VersionInfo.ProductVersion)"
    }
    $UpdaterVersionInfo = (Get-Item -LiteralPath $Updater).VersionInfo
    if ($UpdaterVersionInfo.FileVersion -ne "$Version.0") {
        throw "Portable updater FileVersion is stale: $($UpdaterVersionInfo.FileVersion)"
    }
    if ($UpdaterVersionInfo.ProductVersion -ne $Version) {
        throw "Portable updater ProductVersion is stale: $($UpdaterVersionInfo.ProductVersion)"
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

    $env:SUPERIOR_APPLICATION_ROOT = $PortableRoot
    $PriorErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $DirectRuntimeOutput = & $CompiledRuntime `
            --checkpoint `
            --json 2>&1 | Out-String
        $DirectRuntimeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PriorErrorActionPreference
        Remove-Item Env:\SUPERIOR_APPLICATION_ROOT -ErrorAction SilentlyContinue
    }
    if (
        $DirectRuntimeExitCode -eq 0 -or
        -not $DirectRuntimeOutput.Contains(
            "packaged Bun runtime requires Windows launcher database-lock attestation"
        )
    ) {
        throw "Direct packaged runtime bypassed the Windows database lock:`n$DirectRuntimeOutput"
    }
    if (Test-Path -LiteralPath (Join-Path $PortableRoot "superior.db")) {
        throw "Direct packaged runtime created a database without the Windows launcher lock."
    }

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
        "bunVersion=1.4.0",
        "sqliteBackend=bun:sqlite",
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

    $FrameworkCompiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path -LiteralPath $FrameworkCompiler -PathType Leaf)) {
        throw "Cannot find the .NET Framework compiler required by the Ctrl+C smoke test."
    }
    $SignalHarness = Join-Path $TemporaryRoot "SuperiorConsoleSignalSmoke.exe"
    $SignalCompilerOutput = & $FrameworkCompiler `
        "/nologo" `
        "/optimize+" `
        "/platform:x64" `
        "/target:exe" `
        "/out:$SignalHarness" `
        (Join-Path $PSScriptRoot "launcher\ConsoleSignalHarness.cs") 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $SignalHarness -PathType Leaf)) {
        throw "Could not compile the Ctrl+C smoke harness:`n$SignalCompilerOutput"
    }
    $env:SUPERIOR_TEST_MODE = "1"
    $env:SUPERIOR_APPLICATION_ROOT = Join-Path $TemporaryRoot "hostile parent application root"
    $UnrelatedWorkingDirectory = Join-Path $TemporaryRoot "unrelated working directory"
    New-Item -ItemType Directory -Path $UnrelatedWorkingDirectory | Out-Null
    $SystemDirectory = [System.Environment]::SystemDirectory
    $SystemRootInfo = if ([string]::IsNullOrWhiteSpace($SystemDirectory)) {
        $null
    }
    else {
        [System.IO.Directory]::GetParent($SystemDirectory)
    }
    if ($null -eq $SystemRootInfo) {
        throw "Cannot resolve the Windows system root for restricted-PATH validation."
    }
    $MachineSystemRoot = $SystemRootInfo.FullName
    $RestrictedPath = @(
        (Join-Path $MachineSystemRoot "System32"),
        $MachineSystemRoot,
        (Join-Path $MachineSystemRoot "System32\Wbem")
    ) -join ";"
    foreach ($ForbiddenExecutable in @("bun.exe", "node.exe")) {
        foreach ($RestrictedDirectory in $RestrictedPath.Split(";")) {
            if (Test-Path -LiteralPath (Join-Path $RestrictedDirectory $ForbiddenExecutable) -PathType Leaf) {
                throw "Restricted PATH unexpectedly contains $ForbiddenExecutable."
            }
        }
    }
    $PoisonPreload = Join-Path $TemporaryRoot "must not preload.ts"
    $PoisonSentinel = Join-Path $TemporaryRoot "bun environment injection sentinel.txt"
    [System.IO.File]::WriteAllText(
        $PoisonPreload,
        'import { appendFileSync } from "node:fs"; appendFileSync(process.env.SUPERIOR_POISON_SENTINEL ?? "", "executed\n");',
        (New-Object System.Text.UTF8Encoding($false))
    )
    $env:SUPERIOR_POISON_SENTINEL = $PoisonSentinel
    $env:BUN_BE_BUN = "1"
    $env:BUN_OPTIONS = "--preload=`"$PoisonPreload`""
    $env:NODE_OPTIONS = "--require=`"$PoisonPreload`""
    $env:Path = $RestrictedPath
    Invoke-AndRequireSuccess `
        -Executable $Launcher `
        -Arguments @("--diagnostics") `
        -ExpectedText "sqliteBackend=bun:sqlite"
    if (Test-Path -LiteralPath $PoisonSentinel) {
        throw "Portable launcher allowed inherited Bun/Node control variables to execute a preload."
    }
    foreach ($Name in @("SUPERIOR_POISON_SENTINEL", "BUN_BE_BUN", "BUN_OPTIONS", "NODE_OPTIONS")) {
        Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
    }
    foreach ($Run in 1..2) {
        $SignalLog = Join-Path $TemporaryRoot "portable-offline-$Run.log"
        $SignalOutput = & $SignalHarness `
            $Launcher `
            $UnrelatedWorkingDirectory `
            $SignalLog `
            "[offline-smoke] ready" `
            $CompiledRuntime 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            throw "Portable offline/Ctrl+C smoke run $Run failed:`n$SignalOutput`n$(Get-Content -LiteralPath $SignalLog -Raw -ErrorAction SilentlyContinue)"
        }
        $SignalLogText = Get-Content -LiteralPath $SignalLog -Raw
        $ExpectedDatabaseState = if ($Run -eq 1) { "created" } else { "existing" }
        if (
            -not $SignalLogText.Contains("databaseState=$ExpectedDatabaseState") -or
            -not $SignalLogText.Contains("schema=current-v11") -or
            -not $SignalLogText.Contains("graceful shutdown complete")
        ) {
            throw "Portable offline run $Run did not persist beside the launcher or shut down cleanly:`n$SignalLogText"
        }
    }
    $DatabasePath = Join-Path $PortableRoot "superior.db"
    if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
        throw "Portable offline startup did not create the adjacent database."
    }
    $PostSmokeDiagnostics = & $Launcher --diagnostics 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or -not $PostSmokeDiagnostics.Contains("databaseSchema=current-v11")) {
        throw "Portable persisted database did not pass compiled-runtime diagnostics:`n$PostSmokeDiagnostics"
    }
    $BackupDirectory = Join-Path $PortableRoot "backups"
    New-Item -ItemType Directory -Path $BackupDirectory | Out-Null
    Invoke-AndRequireSuccess `
        -Executable $Launcher `
        -Arguments @("--doctor", "--json") `
        -ExpectedText '"command":"doctor"'
    Invoke-AndRequireSuccess `
        -Executable $Launcher `
        -Arguments @("--doctor", "--write-probes", "--json") `
        -ExpectedText '"id":"backup-hard-link","status":"pass"'
    Invoke-AndRequireSuccess `
        -Executable $Launcher `
        -Arguments @("--checkpoint", "--mode", "truncate", "--json") `
        -ExpectedText '"outcome":"completed"'
    Invoke-AndRequireSuccess `
        -Executable $Launcher `
        -Arguments @("--backup-rotate", "--retention", "2", "--json") `
        -ExpectedText '"status":"completed"'
    $ManagedBackups = @(Get-ChildItem -LiteralPath $BackupDirectory -Filter "superior-backup-v11-*.sqlite3" -File)
    $ManagedMetadata = @(Get-ChildItem -LiteralPath $BackupDirectory -Filter "*.backup.json" -File)
    if ($ManagedBackups.Count -ne 1 -or $ManagedMetadata.Count -ne 1) {
        throw "Portable backup rotation did not publish one validated backup and metadata record."
    }
    # The portable root is operator-writable. Runtime data must not invalidate
    # the signed payload boundary, while undeclared executable payload files do.
    foreach ($MutableRelative in @("operator.db", "operator.db-wal", "operator.log", "operator.backup")) {
        [System.IO.File]::WriteAllText(
            (Join-Path $PortableRoot $MutableRelative),
            "portable mutable-data smoke test",
            (New-Object System.Text.UTF8Encoding($false))
        )
    }
    Invoke-AndRequireSuccess -Executable $Launcher -Arguments @("--version") -ExpectedText "Superior Bot $Version"

    $DeclaredBun = Join-Path $PortableRoot "bun.exe"
    $OriginalManifest = [System.IO.File]::ReadAllText($ManifestPath)
    [System.IO.File]::WriteAllText(
        $DeclaredBun,
        "synthetic external Bun payload",
        (New-Object System.Text.UTF8Encoding($false))
    )
    $DeclaredBunHash = Get-Sha256Hex -LiteralPath $DeclaredBun
    [System.IO.File]::AppendAllText(
        $ManifestPath,
        "$DeclaredBunHash  bun.exe`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
    try {
        $PriorErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            $DeclaredBunOutput = & $Launcher --version 2>&1 | Out-String
            $DeclaredBunExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $PriorErrorActionPreference
        }
        if (
            $DeclaredBunExitCode -eq 0 -or
            -not $DeclaredBunOutput.Contains("manifest declares an unsupported file")
        ) {
            throw "Portable launcher accepted a declared external Bun executable:`n$DeclaredBunOutput"
        }
    }
    finally {
        [System.IO.File]::WriteAllText(
            $ManifestPath,
            $OriginalManifest,
            (New-Object System.Text.UTF8Encoding($false))
        )
        Remove-Item -LiteralPath $DeclaredBun -Force -ErrorAction SilentlyContinue
    }

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

    Write-Host "Portable launcher, doctor, checkpoint, backup rotation, manifest, bun:sqlite, persistence, and Ctrl+C smoke checks passed."
}
finally {
    foreach ($Name in $EnvironmentNames) {
        $Value = $SavedEnvironment[$Name]
        [System.Environment]::SetEnvironmentVariable($Name, $Value, "Process")
    }
    if (Test-Path -LiteralPath $TemporaryRoot) {
        Remove-SafeOwnedTree `
            -Path $TemporaryRoot `
            -OwnerDirectory ([System.IO.Path]::GetTempPath()) `
            -Description "Portable test directory"
    }
}
