[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "hash-utils.ps1")

$WindowsDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent $WindowsDirectory
$TsbotRoot = Join-Path $RepositoryRoot "tsbot"
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source

function Invoke-NpmChecked {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    Push-Location $TsbotRoot
    try {
        & $Npm @Arguments
        $ExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($ExitCode -ne 0) {
        throw "npm $($Arguments -join ' ') failed with exit code $ExitCode. The version was not bumped again; fix the failure and rerun npm run release:build."
    }
}

Invoke-NpmChecked -Arguments @("run", "version:generate")
Invoke-NpmChecked -Arguments @("run", "version:verify")
Invoke-NpmChecked -Arguments @("run", "docs:links")
Invoke-NpmChecked -Arguments @("run", "powershell:check")
Invoke-NpmChecked -Arguments @("run", "format:check")
Invoke-NpmChecked -Arguments @("run", "typecheck")
Invoke-NpmChecked -Arguments @("test")
Invoke-NpmChecked -Arguments @("run", "security:check")
Invoke-NpmChecked -Arguments @("run", "build")

$CompiledJavaScript = Get-ChildItem -LiteralPath (Join-Path $TsbotRoot "dist\src") -Filter "*.js" -Recurse -File
foreach ($JavaScript in $CompiledJavaScript) {
    & node --check $JavaScript.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "Compiled JavaScript syntax check failed: $($JavaScript.FullName)"
    }
}

Invoke-NpmChecked -Arguments @("run", "package:win:verify")
$Package = Get-Content -LiteralPath (Join-Path $TsbotRoot "package.json") -Raw | ConvertFrom-Json
$Archive = Join-Path $RepositoryRoot "release\SuperiorBot-$($Package.version)-win-x64.zip"
& (Join-Path $WindowsDirectory "test-portable.ps1") -Artifact $Archive
& (Join-Path $WindowsDirectory "test-standalone.ps1") -Executable (Join-Path $RepositoryRoot "SuperiorBot.exe")
& (Join-Path $WindowsDirectory "verify-release.ps1") -RequirePortableArtifact

$Hash = Get-Sha256Hex -LiteralPath (Join-Path $RepositoryRoot "SuperiorBot.exe")
Write-Host "Superior Bot release $($Package.version) is reproducible and verified."
Write-Host "SuperiorBot.exe SHA-256: $Hash"
