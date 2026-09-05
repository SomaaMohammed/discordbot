#Requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [string]$Updater
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "path-safety.ps1")

$ResolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$ResolvedUpdater = if ([string]::IsNullOrWhiteSpace($Updater)) {
    [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ResolvedExecutable) "Update.exe"))
}
else {
    (Resolve-Path -LiteralPath $Updater).Path
}
$Bun = (Get-Command bun.exe -CommandType Application -ErrorAction Stop).Source
$Package = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) "tsbot\package.json") -Raw | ConvertFrom-Json
$ExpectedVersion = [string]$Package.version
$OriginalProcessPath = [System.Environment]::GetEnvironmentVariable("Path", "Process")
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
$LegacyFixtureTool = Join-Path (Split-Path -Parent $PSScriptRoot) "tsbot\tests\helpers\legacy-v10-fixture.ts"
if ([System.IO.Path]::GetExtension($ResolvedExecutable) -ne ".exe") {
    throw "Standalone artifact must be an EXE file: $ResolvedExecutable"
}
if (-not (Test-Path -LiteralPath $ResolvedUpdater -PathType Leaf)) {
    throw "Updater artifact is missing: $ResolvedUpdater"
}
if ((Get-Item -LiteralPath $ResolvedExecutable).Length -ge 100MB) {
    throw "Standalone artifact exceeds GitHub's 100 MiB file limit."
}

$TemporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("Superior Bot standalone test " + [System.Guid]::NewGuid().ToString("N"))
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
    "NODE_OPTIONS"
)
$SavedEnvironment = @{}
foreach ($Name in $EnvironmentNames) {
    $SavedEnvironment[$Name] = [System.Environment]::GetEnvironmentVariable($Name, "Process")
    Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
}

function Invoke-AndRequireSuccess {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$ExpectedText
    )

    $Output = & $FileName @Arguments 2>&1 | Out-String
    $ExitCode = $LASTEXITCODE
    if ($ExitCode -ne 0) {
        throw "Command failed with exit code ${ExitCode}: $FileName $($Arguments -join ' ')`n$Output"
    }
    if (-not $Output.Contains($ExpectedText)) {
        throw "Command output did not contain '$ExpectedText':`n$Output"
    }
}

function Enable-RestrictedPath {
    [System.Environment]::SetEnvironmentVariable("Path", $RestrictedPath, "Process")
}

function Restore-OriginalPath {
    [System.Environment]::SetEnvironmentVariable("Path", $OriginalProcessPath, "Process")
}

function Get-SuperiorMutexName {
    param(
        [Parameter(Mandatory = $true)][string]$Scope,
        [Parameter(Mandatory = $true)][string]$Target
    )

    $CanonicalTarget = [System.IO.Path]::GetFullPath($Target).ToUpperInvariant()
    $CanonicalLockTarget = "$Scope$([char]0)$CanonicalTarget"
    $LockBytes = [System.Text.Encoding]::UTF8.GetBytes($CanonicalLockTarget)
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $LockHash = [System.BitConverter]::ToString($Hasher.ComputeHash($LockBytes)).Replace("-", "")
    }
    finally {
        $Hasher.Dispose()
    }
    return "Global\SuperiorBot-$LockHash"
}

try {
    New-Item -ItemType Directory -Path $TemporaryRoot | Out-Null
    $TestExecutable = Join-Path $TemporaryRoot "SuperiorBot.exe"
    Copy-Item -LiteralPath $ResolvedExecutable -Destination $TestExecutable

    Invoke-AndRequireSuccess -FileName $TestExecutable -Arguments @("--version") -ExpectedText "Superior Bot $ExpectedVersion"
    $VersionInfo = (Get-Item -LiteralPath $TestExecutable).VersionInfo
    if ($VersionInfo.FileVersion -ne "$($Package.version).0") {
        throw "Standalone FileVersion is stale: $($VersionInfo.FileVersion)"
    }
    if ($VersionInfo.ProductVersion -ne [string]$Package.version) {
        throw "Standalone ProductVersion is stale: $($VersionInfo.ProductVersion)"
    }

    $EnvironmentText = @"
DISCORD_TOKEN=standalone-smoke-test-token
DB_FILE=superior.db
COMMAND_REGISTRATION_MODE=global
DEV_GUILD_IDS=
"@
    [System.IO.File]::WriteAllText(
        (Join-Path $TemporaryRoot ".env"),
        $EnvironmentText,
        (New-Object System.Text.UTF8Encoding($false))
    )
    $env:SUPERIOR_PORTABLE_EXPECT_DB = Join-Path $TemporaryRoot "superior.db"

    Invoke-AndRequireSuccess -FileName $TestExecutable -Arguments @("--check") -ExpectedText "no Discord login was attempted"
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
    Enable-RestrictedPath
    $DiagnosticsOutput = & $TestExecutable --diagnostics 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "Standalone diagnostics failed:`n$DiagnosticsOutput"
    }
    foreach ($ExpectedDiagnostic in @(
        "executableVersion=$($Package.version)",
        "payloadVersion=$($Package.version)",
        "payloadCache=reused",
        "bunVersion=1.4.0",
        "sqliteBackend=bun:sqlite",
        "commandRegistrationMode=global",
        "completed without Discord login"
    )) {
        if (-not $DiagnosticsOutput.Contains($ExpectedDiagnostic)) {
            throw "Standalone diagnostics omitted '$ExpectedDiagnostic':`n$DiagnosticsOutput"
        }
    }
    if ($DiagnosticsOutput.Contains("standalone-smoke-test-token")) {
        throw "Standalone diagnostics exposed the Discord token."
    }
    if (Test-Path -LiteralPath $PoisonSentinel) {
        throw "Standalone launcher allowed inherited Bun/Node control variables to execute a preload."
    }
    foreach ($Name in @("SUPERIOR_POISON_SENTINEL", "BUN_BE_BUN", "BUN_OPTIONS", "NODE_OPTIONS")) {
        Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
    }
    $PayloadRootMatch = [regex]::Match($DiagnosticsOutput, "(?m)^\[diagnostics\] payloadRoot=(.+?)\r?$")
    if (-not $PayloadRootMatch.Success) {
        throw "Standalone diagnostics omitted the extracted payload root:`n$DiagnosticsOutput"
    }
    $PayloadRoot = $PayloadRootMatch.Groups[1].Value.Trim()
    $CompiledRuntime = Join-Path $PayloadRoot "app\SuperiorBot.Runtime.exe"
    if (-not (Test-Path -LiteralPath $CompiledRuntime -PathType Leaf)) {
        throw "Standalone payload omitted the compiled Bun runtime: $CompiledRuntime"
    }
    if (Test-Path -LiteralPath (Join-Path $TemporaryRoot "superior.db")) {
        throw "Standalone --check unexpectedly created a database file."
    }

    # If the synthetic mutex name ever drifts from the launcher algorithm, an
    # invalid database target still makes the child fail before Discord login.
    $LockTestEnvironment = @"
DISCORD_TOKEN=standalone-lock-test-token
DB_FILE=.
COMMAND_REGISTRATION_MODE=global
DEV_GUILD_IDS=
"@
    [System.IO.File]::WriteAllText(
        (Join-Path $TemporaryRoot ".env"),
        $LockTestEnvironment,
        (New-Object System.Text.UTF8Encoding($false))
    )
    $InstanceMutexName = Get-SuperiorMutexName -Scope "application root" -Target $TemporaryRoot
    $InstanceMutex = New-Object System.Threading.Mutex($false, $InstanceMutexName)
    $OwnsInstanceMutex = $false
    try {
        $OwnsInstanceMutex = $InstanceMutex.WaitOne(0, $false)
        if (-not $OwnsInstanceMutex) {
            throw "Could not acquire the synthetic single-instance test mutex."
        }
        $PriorErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            $SecondOutput = & $TestExecutable 2>&1 | Out-String
            $SecondExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $PriorErrorActionPreference
        }
        if ($SecondExitCode -eq 0 -or -not $SecondOutput.Contains("Another Superior Bot instance")) {
            throw "Standalone launcher did not reject a concurrent instance:`n$SecondOutput"
        }
    }
    finally {
        if ($OwnsInstanceMutex) {
            $InstanceMutex.ReleaseMutex()
        }
        $InstanceMutex.Dispose()
    }

    # A copied executable has a different application-root lock, but must still
    # be rejected when it points at the same SQLite database as another process.
    $SecondApplicationRoot = Join-Path $TemporaryRoot "second-application-root"
    $SharedDatabaseTarget = Join-Path $TemporaryRoot "shared-database-target"
    New-Item -ItemType Directory -Path $SecondApplicationRoot | Out-Null
    New-Item -ItemType Directory -Path $SharedDatabaseTarget | Out-Null
    $SecondExecutable = Join-Path $SecondApplicationRoot "SuperiorBot.exe"
    Copy-Item -LiteralPath $ResolvedExecutable -Destination $SecondExecutable
    $DatabaseLockEnvironment = @"
DISCORD_TOKEN=standalone-database-lock-test-token
DB_FILE=unused-first-definition.db
DB_FILE: $SharedDatabaseTarget # dotenv last definition wins
COMMAND_REGISTRATION_MODE=global
DEV_GUILD_IDS=
"@
    [System.IO.File]::WriteAllText(
        (Join-Path $SecondApplicationRoot ".env"),
        $DatabaseLockEnvironment,
        (New-Object System.Text.UTF8Encoding($false))
    )
    $DatabaseMutexName = Get-SuperiorMutexName -Scope "database" -Target $SharedDatabaseTarget
    $DatabaseMutex = New-Object System.Threading.Mutex($false, $DatabaseMutexName)
    $OwnsDatabaseMutex = $false
    try {
        $OwnsDatabaseMutex = $DatabaseMutex.WaitOne(0, $false)
        if (-not $OwnsDatabaseMutex) {
            throw "Could not acquire the synthetic database single-instance test mutex."
        }
        $PriorErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            $DatabaseLockOutput = & $SecondExecutable 2>&1 | Out-String
            $DatabaseLockExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $PriorErrorActionPreference
        }
        if (
            $DatabaseLockExitCode -eq 0 -or
            -not $DatabaseLockOutput.Contains("already using this database")
        ) {
            throw "Standalone launcher did not reject a second application root using the same database:`n$DatabaseLockOutput"
        }
    }
    finally {
        if ($OwnsDatabaseMutex) {
            $DatabaseMutex.ReleaseMutex()
        }
        $DatabaseMutex.Dispose()
    }

    # The launcher owns both mutexes, while the bundled Bun process is tied to
    # it through a kill-on-close Job Object. Force-killing this synthetic parent
    # must terminate its child before a replacement can acquire the same locks.
    $JobHarness = Join-Path $TemporaryRoot "SuperiorJobSmoke.exe"
    $FrameworkCompiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path -LiteralPath $FrameworkCompiler -PathType Leaf)) {
        throw "Cannot find the .NET Framework compiler required by the job-object smoke test."
    }
    $CompilerOutput = & $FrameworkCompiler `
        "/nologo" `
        "/optimize+" `
        "/platform:x64" `
        "/target:exe" `
        "/reference:$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\System.Security.dll" `
        "/out:$JobHarness" `
        (Join-Path $PSScriptRoot "launcher\LauncherSupport.cs") `
        (Join-Path $PSScriptRoot "launcher\AuthenticodeSupport.cs") `
        (Join-Path $PSScriptRoot "launcher\JobSmokeHarness.cs") 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $JobHarness -PathType Leaf)) {
        throw "Could not compile the job-object smoke harness:`n$CompilerOutput"
    }
    $QuoteOutput = & $JobHarness quote 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "Windows child-process argument quoting failed:`n$QuoteOutput"
    }
    $DriveRoot = [System.IO.Path]::GetPathRoot($TemporaryRoot)
    $NormalizedDriveRoot = (& $JobHarness normalize-root $DriveRoot 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $NormalizedDriveRoot -ne $DriveRoot) {
        throw "Drive-root normalization became drive-relative: '$NormalizedDriveRoot'"
    }
    $DotEnvProbe = Join-Path $TemporaryRoot "dotenv-parser.env"
    $DotEnvCases = @(
        @("duplicate", "DB_FILE=first.db`nDB_FILE=second.db`n", "second.db"),
        @("colon", "DB_FILE: colon.db`n", "colon.db"),
        @("inline-comment", "DB_FILE=comment.db#ignored`n", "comment.db"),
    @("quoted-comment", ('DB_FILE="quoted.db" # ignored' + "`n"), "quoted.db"),
    @("backtick", ('DB_FILE=`backtick.db`' + "`n"), "backtick.db"),
        @("tabbed-export", "export`tDB_FILE=exported.db`n", "exported.db")
    )
    foreach ($DotEnvCase in $DotEnvCases) {
        [System.IO.File]::WriteAllText(
            $DotEnvProbe,
            [string]$DotEnvCase[1],
            (New-Object System.Text.UTF8Encoding($false))
        )
        $ResolvedDotEnvDatabase = (& $JobHarness resolve-db $TemporaryRoot $DotEnvProbe 2>&1 | Out-String).Trim()
        $ExpectedDotEnvDatabase = [System.IO.Path]::GetFullPath((Join-Path $TemporaryRoot ([string]$DotEnvCase[2])))
        if ($LASTEXITCODE -ne 0 -or $ResolvedDotEnvDatabase -ne $ExpectedDotEnvDatabase) {
            throw "Launcher dotenv parser failed the $($DotEnvCase[0]) case: '$ResolvedDotEnvDatabase'"
        }
    }
    $LegacyResolverRoot = Join-Path $TemporaryRoot "legacy-database-resolver"
    [void](Initialize-SafeDirectory `
        -Path $LegacyResolverRoot `
        -Description "Legacy database resolver test directory")
    $LegacyResolverEnvironment = Join-Path $LegacyResolverRoot ".env"
    [System.IO.File]::WriteAllText(
        (Join-Path $LegacyResolverRoot "court.db"),
        "synthetic legacy database sentinel",
        (New-Object System.Text.UTF8Encoding($false))
    )
    $PriorErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $LegacyResolverOutput = & $JobHarness `
            resolve-db `
            $LegacyResolverRoot `
            $LegacyResolverEnvironment 2>&1 | Out-String
        $LegacyResolverExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PriorErrorActionPreference
    }
    if (
        $LegacyResolverExitCode -eq 0 -or
        -not $LegacyResolverOutput.Contains("DB_FILE must be set explicitly")
    ) {
        throw "Launcher accepted an implicit superior.db beside legacy court.db:`n$LegacyResolverOutput"
    }
    [System.IO.File]::WriteAllText(
        $LegacyResolverEnvironment,
        "DB_FILE=explicit.db`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
    $ExplicitLegacyDatabase = (& $JobHarness `
        resolve-db `
        $LegacyResolverRoot `
        $LegacyResolverEnvironment 2>&1 | Out-String).Trim()
    $ExpectedExplicitLegacyDatabase = [System.IO.Path]::GetFullPath(
        (Join-Path $LegacyResolverRoot "explicit.db")
    )
    if (
        $LASTEXITCODE -ne 0 -or
        $ExplicitLegacyDatabase -ne $ExpectedExplicitLegacyDatabase
    ) {
        throw "Launcher rejected an explicit database beside legacy court.db: '$ExplicitLegacyDatabase'"
    }
    $JobRoot = Join-Path $TemporaryRoot "job-root"
    $JobDatabase = Join-Path $JobRoot "synthetic.db"
    $JobChildPidFile = Join-Path $JobRoot "child.pid"
    New-Item -ItemType Directory -Path $JobRoot | Out-Null
    $QuotedJobRoot = '"' + $JobRoot.Replace('"', '\"') + '"'
    $QuotedJobDatabase = '"' + $JobDatabase.Replace('"', '\"') + '"'
    $QuotedJobChildPidFile = '"' + $JobChildPidFile.Replace('"', '\"') + '"'
    $JobParent = Start-Process `
        -FilePath $JobHarness `
        -ArgumentList @("hold", $QuotedJobRoot, $QuotedJobDatabase, $QuotedJobChildPidFile) `
        -PassThru `
        -WindowStyle Hidden
    $JobChildId = $null
    try {
        $Deadline = [DateTime]::UtcNow.AddSeconds(10)
        while (-not (Test-Path -LiteralPath $JobChildPidFile -PathType Leaf)) {
            if ($JobParent.HasExited) {
                throw "Synthetic launcher exited before starting its protected child (exit $($JobParent.ExitCode))."
            }
            if ([DateTime]::UtcNow -ge $Deadline) {
                throw "Timed out waiting for the synthetic protected child."
            }
            Start-Sleep -Milliseconds 50
        }
        $JobChildId = [int](Get-Content -LiteralPath $JobChildPidFile -Raw).Trim()
        if (-not (Get-Process -Id $JobChildId -ErrorAction SilentlyContinue)) {
            throw "Synthetic protected child exited before the parent-termination check."
        }

        Stop-Process -Id $JobParent.Id -Force
        $JobParent.WaitForExit()
        $ProbeOutput = & $JobHarness probe $JobRoot $JobDatabase $JobChildId 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            throw "Replacement acquired a lock while the old child was alive, or the lock stayed stale:`n$ProbeOutput"
        }
        if (Get-Process -Id $JobChildId -ErrorAction SilentlyContinue) {
            throw "Kill-on-close Job Object left an orphaned child after replacement lock acquisition."
        }
    }
    finally {
        if (-not $JobParent.HasExited) {
            Stop-Process -Id $JobParent.Id -Force -ErrorAction SilentlyContinue
        }
        if ($null -ne $JobChildId) {
            Stop-Process -Id $JobChildId -Force -ErrorAction SilentlyContinue
        }
        $JobParent.Dispose()
    }

    [System.IO.File]::WriteAllText(
        (Join-Path $TemporaryRoot ".env"),
        $EnvironmentText,
        (New-Object System.Text.UTF8Encoding($false))
    )
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
    foreach ($Run in 1..2) {
        $SignalLog = Join-Path $TemporaryRoot "standalone-offline-$Run.log"
        $SignalOutput = & $SignalHarness `
            $TestExecutable `
            $UnrelatedWorkingDirectory `
            $SignalLog `
            "[offline-smoke] ready" `
            $CompiledRuntime 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            throw "Standalone offline/Ctrl+C smoke run $Run failed:`n$SignalOutput`n$(Get-Content -LiteralPath $SignalLog -Raw -ErrorAction SilentlyContinue)"
        }
        $SignalLogText = Get-Content -LiteralPath $SignalLog -Raw
        $ExpectedDatabaseState = if ($Run -eq 1) { "created" } else { "existing" }
        if (
            -not $SignalLogText.Contains("databaseState=$ExpectedDatabaseState") -or
            -not $SignalLogText.Contains("schema=current-v11") -or
            -not $SignalLogText.Contains("graceful shutdown complete")
        ) {
            throw "Standalone offline run $Run did not persist beside the executable or shut down cleanly:`n$SignalLogText"
        }
    }

    $PackagedMigrationRoot = Join-Path $TemporaryRoot "packaged migration from schema v10"
    New-Item -ItemType Directory -Path $PackagedMigrationRoot | Out-Null
    $PackagedMigrationExecutable = Join-Path $PackagedMigrationRoot "SuperiorBot.exe"
    $PackagedMigrationDatabase = Join-Path $PackagedMigrationRoot "legacy.db"
    $PackagedMigrationEnvironment = Join-Path $PackagedMigrationRoot ".env"
    Copy-Item -LiteralPath $TestExecutable -Destination $PackagedMigrationExecutable
    [System.IO.File]::WriteAllText(
        $PackagedMigrationEnvironment,
        $EnvironmentText.Replace("DB_FILE=superior.db", "DB_FILE=legacy.db"),
        (New-Object System.Text.UTF8Encoding($false))
    )
    Restore-OriginalPath
    & $Bun --no-env-file $LegacyFixtureTool create $PackagedMigrationDatabase
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the schema-v10 packaged-migration fixture."
    }

    Enable-RestrictedPath
    $PreviousExpectedRoot = $env:SUPERIOR_PORTABLE_EXPECT_ROOT
    $PreviousExpectedDatabase = $env:SUPERIOR_PORTABLE_EXPECT_DB
    $PreviousExpectedEnvironment = $env:SUPERIOR_PORTABLE_EXPECT_ENV
    try {
        $env:SUPERIOR_PORTABLE_EXPECT_ROOT = $PackagedMigrationRoot
        $env:SUPERIOR_PORTABLE_EXPECT_DB = $PackagedMigrationDatabase
        $env:SUPERIOR_PORTABLE_EXPECT_ENV = $PackagedMigrationEnvironment
        $PackagedMigrationLog = Join-Path $TemporaryRoot "packaged-migration.log"
        $PackagedMigrationOutput = & $SignalHarness `
            $PackagedMigrationExecutable `
            $UnrelatedWorkingDirectory `
            $PackagedMigrationLog `
            "[offline-smoke] ready" `
            $CompiledRuntime 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            throw "Compiled startup migration from schema v10 failed:`n$PackagedMigrationOutput`n$(Get-Content -LiteralPath $PackagedMigrationLog -Raw -ErrorAction SilentlyContinue)"
        }
        $PackagedMigrationLogText = Get-Content -LiteralPath $PackagedMigrationLog -Raw
        if (
            -not $PackagedMigrationLogText.Contains("databaseState=existing") -or
            -not $PackagedMigrationLogText.Contains("schema=current-v11") -or
            -not $PackagedMigrationLogText.Contains("graceful shutdown complete")
        ) {
            throw "Compiled startup migration omitted its v11/graceful evidence:`n$PackagedMigrationLogText"
        }
    }
    finally {
        $env:SUPERIOR_PORTABLE_EXPECT_ROOT = $PreviousExpectedRoot
        $env:SUPERIOR_PORTABLE_EXPECT_DB = $PreviousExpectedDatabase
        $env:SUPERIOR_PORTABLE_EXPECT_ENV = $PreviousExpectedEnvironment
    }
    Restore-OriginalPath
    & $Bun --no-env-file $LegacyFixtureTool verify $PackagedMigrationDatabase
    if ($LASTEXITCODE -ne 0) {
        throw "Compiled startup migration did not preserve and validate the legacy fixture."
    }
    Enable-RestrictedPath

    $DatabasePath = Join-Path $TemporaryRoot "superior.db"
    if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
        throw "Standalone offline startup did not create the adjacent database."
    }
    $MaintenanceBackupDirectory = Join-Path $TemporaryRoot "backups"
    New-Item -ItemType Directory -Path $MaintenanceBackupDirectory | Out-Null
    Invoke-AndRequireSuccess `
        -FileName $TestExecutable `
        -Arguments @("--doctor", "--json") `
        -ExpectedText '"command":"doctor"'
    Invoke-AndRequireSuccess `
        -FileName $TestExecutable `
        -Arguments @("--doctor", "--write-probes", "--json") `
        -ExpectedText '"id":"backup-hard-link","status":"pass"'
    Invoke-AndRequireSuccess `
        -FileName $TestExecutable `
        -Arguments @("--checkpoint", "--mode", "truncate", "--json") `
        -ExpectedText '"outcome":"completed"'
    Invoke-AndRequireSuccess `
        -FileName $TestExecutable `
        -Arguments @("--backup-rotate", "--retention", "2", "--json") `
        -ExpectedText '"status":"completed"'
    if (
        @(Get-ChildItem -LiteralPath $MaintenanceBackupDirectory -Filter "superior-backup-v11-*.sqlite3" -File).Count -ne 1 -or
        @(Get-ChildItem -LiteralPath $MaintenanceBackupDirectory -Filter "*.backup.json" -File).Count -ne 1
    ) {
        throw "Standalone backup rotation did not publish one validated backup and metadata record."
    }

    # Exercise the real updater across the breaking runtime boundary. The legacy
    # fixture has 7.2.8 Windows version metadata; the v8 source is the compiled
    # standalone executable under test. Mutable adjacent files must survive byte
    # for byte and the installed replacement must report bun:sqlite diagnostics.
    $UpdateRoot = Join-Path $TemporaryRoot "legacy 7.2.8 installation"
    New-Item -ItemType Directory -Path $UpdateRoot | Out-Null
    $LegacyExecutable = Join-Path $UpdateRoot "SuperiorBot.exe"
    $LegacyCompilerOutput = & $FrameworkCompiler `
        "/nologo" `
        "/optimize+" `
        "/platform:x64" `
        "/target:exe" `
        "/out:$LegacyExecutable" `
        (Join-Path $PSScriptRoot "launcher\LegacyUpdateFixture.cs") 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $LegacyExecutable -PathType Leaf)) {
        throw "Could not compile the 7.2.8 updater fixture:`n$LegacyCompilerOutput"
    }
    $LegacyVersionInfo = (Get-Item -LiteralPath $LegacyExecutable).VersionInfo
    if ($LegacyVersionInfo.ProductVersion -ne "7.2.8") {
        throw "Legacy updater fixture ProductVersion is not 7.2.8: $($LegacyVersionInfo.ProductVersion)"
    }
    $LegacyExecutableHashBefore = (Get-FileHash -LiteralPath $LegacyExecutable -Algorithm SHA256).Hash

    $UpdateEnvironment = Join-Path $UpdateRoot ".env"
    $UpdateDatabase = Join-Path $UpdateRoot "superior.db"
    [System.IO.File]::WriteAllText(
        $UpdateEnvironment,
        $EnvironmentText,
        (New-Object System.Text.UTF8Encoding($false))
    )
    Copy-Item -LiteralPath $DatabasePath -Destination $UpdateDatabase
    $OperatorBackup = Join-Path $UpdateRoot "backups\operator-preserved.txt"
    New-Item -ItemType Directory -Path (Split-Path -Parent $OperatorBackup) | Out-Null
    [System.IO.File]::WriteAllText(
        $OperatorBackup,
        "operator backup sentinel",
        (New-Object System.Text.UTF8Encoding($false))
    )
    $EnvironmentHashBefore = (Get-FileHash -LiteralPath $UpdateEnvironment -Algorithm SHA256).Hash
    $DatabaseHashBefore = (Get-FileHash -LiteralPath $UpdateDatabase -Algorithm SHA256).Hash

    $PreviousExpectedRoot = $env:SUPERIOR_PORTABLE_EXPECT_ROOT
    $PreviousExpectedDatabase = $env:SUPERIOR_PORTABLE_EXPECT_DB
    $PreviousExpectedEnvironment = $env:SUPERIOR_PORTABLE_EXPECT_ENV
    try {
        $env:SUPERIOR_PORTABLE_EXPECT_ROOT = $UpdateRoot
        $env:SUPERIOR_PORTABLE_EXPECT_DB = $UpdateDatabase
        $env:SUPERIOR_PORTABLE_EXPECT_ENV = $UpdateEnvironment
        $UpdateOutput = & $ResolvedUpdater `
            --source $ResolvedExecutable `
            --target $UpdateRoot `
            --no-start 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0 -or -not $UpdateOutput.Contains("Updated SuperiorBot.exe to $ExpectedVersion")) {
            throw "The 7.2.8 to $ExpectedVersion updater smoke failed:`n$UpdateOutput"
        }

        $UpdatedExecutable = Join-Path $UpdateRoot "SuperiorBot.exe"
        Invoke-AndRequireSuccess -FileName $UpdatedExecutable -Arguments @("--version") -ExpectedText "Superior Bot $ExpectedVersion"
        $UpdatedDiagnostics = & $UpdatedExecutable --diagnostics 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0 -or -not $UpdatedDiagnostics.Contains("sqliteBackend=bun:sqlite")) {
            throw "The updated standalone executable did not use bun:sqlite:`n$UpdatedDiagnostics"
        }
    }
    finally {
        $env:SUPERIOR_PORTABLE_EXPECT_ROOT = $PreviousExpectedRoot
        $env:SUPERIOR_PORTABLE_EXPECT_DB = $PreviousExpectedDatabase
        $env:SUPERIOR_PORTABLE_EXPECT_ENV = $PreviousExpectedEnvironment
    }

    $EnvironmentHashAfter = (Get-FileHash -LiteralPath $UpdateEnvironment -Algorithm SHA256).Hash
    $DatabaseHashAfter = (Get-FileHash -LiteralPath $UpdateDatabase -Algorithm SHA256).Hash
    if ($EnvironmentHashAfter -ne $EnvironmentHashBefore -or $DatabaseHashAfter -ne $DatabaseHashBefore) {
        throw "Updater modified the adjacent .env or SQLite database."
    }
    if (-not (Test-Path -LiteralPath $OperatorBackup -PathType Leaf)) {
        throw "Updater removed the pre-existing operator backup."
    }
    $ExecutableBackups = @(Get-ChildItem -LiteralPath (Join-Path $UpdateRoot "backups") -Filter "SuperiorBot.exe.*.bak" -File)
    if ($ExecutableBackups.Count -ne 1) {
        throw "Updater did not retain exactly one 7.2.8 executable backup."
    }
    $ExecutableBackupVersion = $ExecutableBackups[0].VersionInfo.ProductVersion
    $ExecutableBackupHash = (Get-FileHash -LiteralPath $ExecutableBackups[0].FullName -Algorithm SHA256).Hash
    if ($ExecutableBackupVersion -ne "7.2.8" -or $ExecutableBackupHash -ne $LegacyExecutableHashBefore) {
        throw "Updater backup is not the exact 7.2.8 executable that was replaced."
    }

    $PostSmokeDiagnostics = & $TestExecutable --diagnostics 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or -not $PostSmokeDiagnostics.Contains("databaseSchema=current-v11")) {
        throw "Standalone persisted database did not pass compiled-runtime diagnostics:`n$PostSmokeDiagnostics"
    }
    if (-not $PostSmokeDiagnostics.Contains("payloadRoot=$PayloadRoot")) {
        throw "Standalone payload cache changed between smoke runs:`n$PostSmokeDiagnostics"
    }
    if (-not (Test-Path -LiteralPath $PayloadRoot -PathType Container)) {
        throw "Standalone diagnostics reported a missing payload root: $PayloadRoot"
    }
    $PayloadDatabases = @(
        Get-ChildItem -LiteralPath $PayloadRoot -Recurse -File | Where-Object {
            $_.Name -like "*.db" -or
            $_.Name -like "*.db-wal" -or
            $_.Name -like "*.db-shm"
        }
    )
    if ($PayloadDatabases.Count -ne 0) {
        throw "Standalone runtime data leaked into the immutable payload cache: $($PayloadDatabases.FullName -join ', ')"
    }
    if (Test-Path -LiteralPath (Join-Path $TemporaryRoot "runtime")) {
        throw "Standalone launcher unexpectedly unpacked its private runtime beside the executable."
    }

    Write-Host "Standalone executable, doctor, checkpoint, backup rotation, application-root, database-lock, orphan-child job, bun:sqlite, persistence, and Ctrl+C smoke checks passed."
}
finally {
    Restore-OriginalPath
    foreach ($Name in $EnvironmentNames) {
        if ($null -eq $SavedEnvironment[$Name]) {
            Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
        }
        else {
            [System.Environment]::SetEnvironmentVariable($Name, $SavedEnvironment[$Name], "Process")
        }
    }
    if (Test-Path -LiteralPath $TemporaryRoot) {
        Remove-SafeOwnedTree `
            -Path $TemporaryRoot `
            -OwnerDirectory ([System.IO.Path]::GetTempPath()) `
            -Description "Standalone test directory"
    }
}
