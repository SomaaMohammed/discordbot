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

try {
    New-Item -ItemType Directory -Path $TemporaryRoot | Out-Null
    $TestExecutable = Join-Path $TemporaryRoot "SuperiorBot.exe"
    Copy-Item -LiteralPath $ResolvedExecutable -Destination $TestExecutable

    $Package = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) "tsbot\package.json") -Raw | ConvertFrom-Json
    Invoke-AndRequireSuccess -FileName $TestExecutable -Arguments @("--version") -ExpectedText "Superior Bot $($Package.version)"

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
    if (Test-Path -LiteralPath (Join-Path $TemporaryRoot "superior.db")) {
        throw "Standalone --check unexpectedly created a database file."
    }
    if (Test-Path -LiteralPath (Join-Path $TemporaryRoot "runtime")) {
        throw "Standalone launcher unexpectedly unpacked its private runtime beside the executable."
    }

    Write-Host "Standalone executable, application-root, and native SQLite smoke checks passed."
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
