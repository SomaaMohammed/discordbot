[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Executable
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ResolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
if ([System.IO.Path]::GetExtension($ResolvedExecutable) -ne ".exe") {
    throw "Standalone artifact must be an EXE file: $ResolvedExecutable"
}
if ((Get-Item -LiteralPath $ResolvedExecutable).Length -ge 100MB) {
    throw "Standalone artifact exceeds GitHub's 100 MiB file limit."
}

$TemporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("SuperiorBot-standalone-test-" + [System.Guid]::NewGuid().ToString("N"))
$EnvironmentNames = @(
    "DB_FILE",
    "DISCORD_TOKEN",
    "ENV_FILE",
    "COMMAND_REGISTRATION_MODE",
    "DEV_GUILD_IDS",
    "SUPERIOR_APPLICATION_ROOT",
    "SUPERIOR_PORTABLE_EXPECT_ENV",
    "SUPERIOR_PORTABLE_EXPECT_ROOT",
    "SUPERIOR_PORTABLE_EXPECT_DB"
)
$SavedEnvironment = @{}
foreach ($Name in $EnvironmentNames) {
    $SavedEnvironment[$Name] = [System.Environment]::GetEnvironmentVariable($Name, "Process")
    [System.Environment]::SetEnvironmentVariable($Name, $null, "Process")
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

    $Package = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) "tsbot\package.json") -Raw | ConvertFrom-Json
    Invoke-AndRequireSuccess -FileName $TestExecutable -Arguments @("--version") -ExpectedText "Superior Bot $($Package.version)"
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
    $DiagnosticsOutput = & $TestExecutable --diagnostics 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "Standalone diagnostics failed:`n$DiagnosticsOutput"
    }
    foreach ($ExpectedDiagnostic in @(
        "executableVersion=$($Package.version)",
        "payloadVersion=$($Package.version)",
        "payloadCache=reused",
        "nodeVersion=v22.12.0",
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
DB_FILE=$SharedDatabaseTarget
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

    # The launcher owns both mutexes, while the bundled Node process is tied to
    # it through a kill-on-close Job Object. Force-killing this synthetic parent
    # must terminate its child before a replacement can acquire the same locks.
    $JobHarness = Join-Path $TemporaryRoot "SuperiorJobSmoke.exe"
    Add-Type `
        -Path @(
            (Join-Path $PSScriptRoot "launcher\LauncherSupport.cs"),
            (Join-Path $PSScriptRoot "launcher\JobSmokeHarness.cs")
        ) `
        -OutputAssembly $JobHarness `
        -OutputType ConsoleApplication
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
    if (Test-Path -LiteralPath (Join-Path $TemporaryRoot "superior.db")) {
        throw "Standalone --check unexpectedly created a database file."
    }
    if (Test-Path -LiteralPath (Join-Path $TemporaryRoot "runtime")) {
        throw "Standalone launcher unexpectedly unpacked its private runtime beside the executable."
    }

    Write-Host "Standalone executable, application-root, database-lock, orphan-child job, and native SQLite smoke checks passed."
}
finally {
    foreach ($Name in $EnvironmentNames) {
        [System.Environment]::SetEnvironmentVariable($Name, $SavedEnvironment[$Name], "Process")
    }
    $ResolvedTemporaryRoot = [System.IO.Path]::GetFullPath($TemporaryRoot)
    $ExpectedPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\") + "\"
    if (
        $ResolvedTemporaryRoot.StartsWith($ExpectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($ResolvedTemporaryRoot).StartsWith("SuperiorBot-standalone-test-") -and
        (Test-Path -LiteralPath $ResolvedTemporaryRoot)
    ) {
        Remove-Item -LiteralPath $ResolvedTemporaryRoot -Recurse -Force
    }
}
