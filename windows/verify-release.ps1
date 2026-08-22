[CmdletBinding()]
param(
    [string]$Executable = "SuperiorBot.exe",
    [string]$OutputDirectory = "release",
    [switch]$RequirePortableArtifact
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "hash-utils.ps1")

$WindowsDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent $WindowsDirectory
$Package = Get-Content -LiteralPath (Join-Path $RepositoryRoot "tsbot\package.json") -Raw | ConvertFrom-Json
$ExpectedVersion = [string]$Package.version
if ($ExpectedVersion -notmatch "^\d+\.\d+\.\d+$") {
    throw "Package version must be MAJOR.MINOR.PATCH: $ExpectedVersion"
}
$ResolvedExecutable = if ([System.IO.Path]::IsPathRooted($Executable)) {
    [System.IO.Path]::GetFullPath($Executable)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot $Executable))
}
$ResolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot $OutputDirectory))
}
$ExpectedArchive = Join-Path $ResolvedOutput "SuperiorBot-$ExpectedVersion-win-x64.zip"

if (-not (Test-Path -LiteralPath $ResolvedExecutable -PathType Leaf)) {
    throw "Standalone executable is missing: $ResolvedExecutable"
}
if ($RequirePortableArtifact -and -not (Test-Path -LiteralPath $ExpectedArchive -PathType Leaf)) {
    throw "Versioned portable artifact is missing: $ExpectedArchive"
}

$VersionInfo = (Get-Item -LiteralPath $ResolvedExecutable).VersionInfo
if ($VersionInfo.FileVersion -ne "$ExpectedVersion.0") {
    throw "SuperiorBot.exe FileVersion is stale. Expected $ExpectedVersion.0; got $($VersionInfo.FileVersion)."
}
if ($VersionInfo.ProductVersion -ne $ExpectedVersion) {
    throw "SuperiorBot.exe ProductVersion is stale. Expected $ExpectedVersion; got $($VersionInfo.ProductVersion)."
}

$VersionOutput = & $ResolvedExecutable --version 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or -not $VersionOutput.Contains("Superior Bot $ExpectedVersion")) {
    throw "SuperiorBot.exe --version disagrees with package.json:`n$VersionOutput"
}

$SourceIdentityTool = Join-Path $WindowsDirectory "compute-source-identity.mjs"
$CurrentSourceIdentity = (& node $SourceIdentityTool).Trim()
if ($LASTEXITCODE -ne 0 -or $CurrentSourceIdentity -notmatch "^[a-f0-9]{64}$") {
    throw "Could not compute the current release source identity."
}

$TemporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("SuperiorBot-release-verify-" + [System.Guid]::NewGuid().ToString("N"))
$EnvironmentNames = @(
    "COMMAND_REGISTRATION_MODE",
    "DB_FILE",
    "DEV_GUILD_IDS",
    "DISCORD_TOKEN",
    "ENV_FILE",
    "SUPERIOR_APPLICATION_ROOT",
    "SUPERIOR_PORTABLE_EXPECT_ENV",
    "SUPERIOR_DIAGNOSTICS_SKIP_DATABASE"
)
$SavedEnvironment = @{}
foreach ($Name in $EnvironmentNames) {
    $SavedEnvironment[$Name] = [System.Environment]::GetEnvironmentVariable($Name, "Process")
    [System.Environment]::SetEnvironmentVariable($Name, $null, "Process")
}

try {
    New-Item -ItemType Directory -Path $TemporaryRoot | Out-Null
    $TestExecutable = Join-Path $TemporaryRoot "SuperiorBot.exe"
    Copy-Item -LiteralPath $ResolvedExecutable -Destination $TestExecutable
    $env:SUPERIOR_DIAGNOSTICS_SKIP_DATABASE = "1"
    $DiagnosticsOutput = & $TestExecutable --diagnostics 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "SuperiorBot.exe --diagnostics failed:`n$DiagnosticsOutput"
    }
    foreach ($ExpectedLine in @(
        "executableVersion=$ExpectedVersion",
        "payloadVersion=$ExpectedVersion",
        "sourceSha256=$CurrentSourceIdentity",
        "databaseSchema=skipped",
        "completed without Discord login"
    )) {
        if (-not $DiagnosticsOutput.Contains($ExpectedLine)) {
            throw "SuperiorBot.exe diagnostics omitted '$ExpectedLine':`n$DiagnosticsOutput"
        }
    }
}
finally {
    foreach ($Name in $EnvironmentNames) {
        [System.Environment]::SetEnvironmentVariable($Name, $SavedEnvironment[$Name], "Process")
    }
    $ResolvedTemporaryRoot = [System.IO.Path]::GetFullPath($TemporaryRoot)
    $TemporaryPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\") + "\"
    if (
        $ResolvedTemporaryRoot.StartsWith($TemporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($ResolvedTemporaryRoot).StartsWith("SuperiorBot-release-verify-") -and
        (Test-Path -LiteralPath $ResolvedTemporaryRoot)
    ) {
        Remove-Item -LiteralPath $ResolvedTemporaryRoot -Recurse -Force
    }
}

$ExecutableHash = Get-Sha256Hex -LiteralPath $ResolvedExecutable
Write-Host "Release identity verified: $ExpectedVersion"
Write-Host "SuperiorBot.exe SHA-256: $ExecutableHash"
if (Test-Path -LiteralPath $ExpectedArchive -PathType Leaf) {
    $ArchiveHash = Get-Sha256Hex -LiteralPath $ExpectedArchive
    Write-Host "$([System.IO.Path]::GetFileName($ExpectedArchive)) SHA-256: $ArchiveHash"
}
elseif (-not $RequirePortableArtifact) {
    Write-Host "Portable artifact not present; committed standalone identity was checked non-mutating."
}
