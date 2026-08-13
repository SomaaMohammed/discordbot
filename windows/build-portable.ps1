[CmdletBinding()]
param(
    [string]$OutputDirectory = "release",
    [string]$NodeVersion = "22.12.0",
    [string]$NodeArchiveSha256 = "2b8f2256382f97ad51e29ff71f702961af466c4616393f767455501e6aece9b8",
    [string]$CompilerToolsetVersion = "4.12.0",
    [string]$CompilerToolsetPackageSha256 = "fe24ef31a6ffcb7c49383d2fd362763dee291ad9b9d98cc0c19ef80203b99ebc",
    [string]$ReferenceAssembliesVersion = "1.0.3",
    [string]$ReferenceAssembliesPackageSha256 = "8a7e348538e7eb91351696911689f49e3d4f63f8bab517432bbe159b8b1104a2",
    [string]$BetterSqlite3BinarySha256 = "8c041ef57dd1bb55b0032306594310625b7a7a374bc48956e0858645f56919c4",
    [string]$StandaloneOutput = "",
    [switch]$KeepStaging
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "The portable x64 artifact must be built on Windows."
}

$WindowsDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent $WindowsDirectory
$TsbotRoot = Join-Path $RepositoryRoot "tsbot"
$WorkRoot = Join-Path $WindowsDirectory ".work"
$CacheRoot = Join-Path $WindowsDirectory ".cache"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    Push-Location $WorkingDirectory
    try {
        & $Executable @Arguments
        $ExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($ExitCode -ne 0) {
        throw "Command failed with exit code ${ExitCode}: $Executable $($Arguments -join ' ')"
    }
}

function Remove-WorkItem {
    param([Parameter(Mandatory = $true)][string]$Path)

    $ResolvedWorkRoot = [System.IO.Path]::GetFullPath($WorkRoot).TrimEnd("\") + "\"
    $ResolvedTarget = [System.IO.Path]::GetFullPath($Path)
    if (-not $ResolvedTarget.StartsWith($ResolvedWorkRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside windows/.work: $ResolvedTarget"
    }
    if (Test-Path -LiteralPath $ResolvedTarget) {
        Remove-Item -LiteralPath $ResolvedTarget -Recurse -Force
    }
}

function Get-RelativeFileName {
    param(
        [Parameter(Mandatory = $true)][string]$BaseDirectory,
        [Parameter(Mandatory = $true)][string]$FileName
    )

    $Prefix = [System.IO.Path]::GetFullPath($BaseDirectory).TrimEnd("\") + "\"
    $ResolvedFile = [System.IO.Path]::GetFullPath($FileName)
    if (-not $ResolvedFile.StartsWith($Prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "File is outside the expected directory: $ResolvedFile"
    }
    return $ResolvedFile.Substring($Prefix.Length).Replace("\", "/")
}

function Get-VerifiedDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $Expected = $ExpectedSha256.ToLowerInvariant()
    $Download = "$Destination.download"
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        $CachedHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($CachedHash -ne $Expected) {
            Remove-Item -LiteralPath $Destination -Force
        }
    }
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        return
    }
    if (Test-Path -LiteralPath $Download) {
        Remove-Item -LiteralPath $Download -Force
    }

    Write-Host "Downloading pinned $Description..."
    Invoke-WebRequest -Uri $Uri -OutFile $Download
    $DownloadedHash = (Get-FileHash -LiteralPath $Download -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($DownloadedHash -ne $Expected) {
        Remove-Item -LiteralPath $Download -Force
        throw "$Description SHA-256 mismatch. Expected $Expected; got $DownloadedHash"
    }
    Move-Item -LiteralPath $Download -Destination $Destination
}

function Expand-ZipChecked {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$DestinationDirectory
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $DestinationPrefix = [System.IO.Path]::GetFullPath($DestinationDirectory).TrimEnd("\") + "\"
    $Archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        [long]$TotalUncompressedBytes = 0
        foreach ($Entry in $Archive.Entries) {
            if ($Entry.Length -lt 0 -or $Entry.Length -gt 1GB) {
                throw "Archive contains an oversized entry: $($Entry.FullName)"
            }
            $TotalUncompressedBytes += $Entry.Length
            if ($TotalUncompressedBytes -gt 2GB) {
                throw "Archive exceeds the extraction size limit: $ArchivePath"
            }
            $UnixMode = ($Entry.ExternalAttributes -shr 16) -band 0xF000
            if ($UnixMode -eq 0xA000) {
                throw "Archive contains a symbolic link: $($Entry.FullName)"
            }
            $RelativeName = $Entry.FullName.Replace("/", "\")
            $Destination = [System.IO.Path]::GetFullPath((Join-Path $DestinationDirectory $RelativeName))
            if (-not $Destination.StartsWith($DestinationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Archive entry escapes its extraction directory: $($Entry.FullName)"
            }
        }
    }
    finally {
        $Archive.Dispose()
    }
    [System.IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $DestinationDirectory)
}

function Get-SortedRelativeFileNames {
    param([Parameter(Mandatory = $true)][string]$BaseDirectory)

    [string[]]$RelativeFiles = @(
        Get-ChildItem -LiteralPath $BaseDirectory -Recurse -File | ForEach-Object {
            Get-RelativeFileName -BaseDirectory $BaseDirectory -FileName $_.FullName
        }
    )
    [System.Array]::Sort($RelativeFiles, [System.StringComparer]::Ordinal)
    return $RelativeFiles
}

if (-not (Test-Path -LiteralPath $TsbotRoot -PathType Container)) {
    throw "Cannot find the tsbot project at $TsbotRoot"
}

$Package = Get-Content -LiteralPath (Join-Path $TsbotRoot "package.json") -Raw | ConvertFrom-Json
if ($Package.name -ne "superior-discord-bot") {
    throw "Unexpected package name: $($Package.name)"
}
if ($Package.version -notmatch "^\d+\.\d+\.\d+$") {
    throw "Package version must use semantic versioning: $($Package.version)"
}
$AssemblyVersion = "$($Package.version).0"

$ArtifactName = "SuperiorBot-$($Package.version)-win-x64"
$StageRoot = Join-Path $WorkRoot $ArtifactName
$NodeExtractRoot = Join-Path $WorkRoot "node-$NodeVersion"
$NodeArchiveName = "node-v$NodeVersion-win-x64.zip"
$NodeArchive = Join-Path $CacheRoot $NodeArchiveName
$NodeDownload = "$NodeArchive.download"
$CompilerPackageName = "microsoft.net.compilers.toolset.$CompilerToolsetVersion.nupkg"
$CompilerPackage = Join-Path $CacheRoot $CompilerPackageName
$CompilerPackageDownload = "$CompilerPackage.download"
$CompilerExtractRoot = Join-Path $WorkRoot "compiler-$CompilerToolsetVersion"
$ReferenceAssembliesPackageName = "microsoft.netframework.referenceassemblies.net48.$ReferenceAssembliesVersion.nupkg"
$ReferenceAssembliesPackage = Join-Path $CacheRoot $ReferenceAssembliesPackageName
$ReferenceAssembliesPackageDownload = "$ReferenceAssembliesPackage.download"
$ReferenceAssembliesExtractRoot = Join-Path $WorkRoot "reference-assemblies-net48-$ReferenceAssembliesVersion"
$LauncherSourceRoot = Join-Path $WorkRoot "launcher-source"
$OutputRoot = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot $OutputDirectory))
}
$FinalArchive = Join-Path $OutputRoot "$ArtifactName.zip"
$FinalChecksum = "$FinalArchive.sha256"
$WorkArchive = Join-Path $WorkRoot "$ArtifactName.zip"
$StandaloneWorkOutput = Join-Path $WorkRoot "SuperiorBot-standalone.exe"
$StandaloneTarget = if ([string]::IsNullOrWhiteSpace($StandaloneOutput)) {
    $null
}
elseif ([System.IO.Path]::IsPathRooted($StandaloneOutput)) {
    [System.IO.Path]::GetFullPath($StandaloneOutput)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot $StandaloneOutput))
}

New-Item -ItemType Directory -Path $WorkRoot, $CacheRoot, $OutputRoot -Force | Out-Null
Remove-WorkItem -Path $StageRoot
Remove-WorkItem -Path $NodeExtractRoot
Remove-WorkItem -Path $CompilerExtractRoot
Remove-WorkItem -Path $ReferenceAssembliesExtractRoot
Remove-WorkItem -Path $LauncherSourceRoot
if (Test-Path -LiteralPath $WorkArchive) {
    Remove-Item -LiteralPath $WorkArchive -Force
}
if (Test-Path -LiteralPath $StandaloneWorkOutput) {
    Remove-Item -LiteralPath $StandaloneWorkOutput -Force
}

try {
    Get-VerifiedDownload `
        -Uri "https://nodejs.org/dist/v$NodeVersion/$NodeArchiveName" `
        -Destination $NodeArchive `
        -ExpectedSha256 $NodeArchiveSha256 `
        -Description "Windows Node runtime $NodeVersion"
    Get-VerifiedDownload `
        -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.net.compilers.toolset/$CompilerToolsetVersion/$CompilerPackageName" `
        -Destination $CompilerPackage `
        -ExpectedSha256 $CompilerToolsetPackageSha256 `
        -Description "Microsoft.Net.Compilers.Toolset $CompilerToolsetVersion"
    Get-VerifiedDownload `
        -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.netframework.referenceassemblies.net48/$ReferenceAssembliesVersion/$ReferenceAssembliesPackageName" `
        -Destination $ReferenceAssembliesPackage `
        -ExpectedSha256 $ReferenceAssembliesPackageSha256 `
        -Description "Microsoft .NET Framework 4.8 reference assemblies $ReferenceAssembliesVersion"

    Expand-ZipChecked -ArchivePath $NodeArchive -DestinationDirectory $NodeExtractRoot
    Expand-ZipChecked -ArchivePath $CompilerPackage -DestinationDirectory $CompilerExtractRoot
    Expand-ZipChecked -ArchivePath $ReferenceAssembliesPackage -DestinationDirectory $ReferenceAssembliesExtractRoot
    $ExtractedNodeRoot = Join-Path $NodeExtractRoot "node-v$NodeVersion-win-x64"
    $BundledNode = Join-Path $ExtractedNodeRoot "node.exe"
    if (-not (Test-Path -LiteralPath $BundledNode -PathType Leaf)) {
        throw "The Node archive did not contain node.exe at the expected path."
    }
    $RuntimeVersion = (& $BundledNode --version).TrimStart("v")
    if ($LASTEXITCODE -ne 0 -or $RuntimeVersion -ne $NodeVersion) {
        throw "Bundled Node version check failed; expected $NodeVersion, got $RuntimeVersion"
    }

    Write-Host "Building clean production JavaScript..."
    $NpmCommand = Get-Command npm.cmd -ErrorAction Stop
    Invoke-NativeChecked -Executable $NpmCommand.Source -Arguments @("run", "build") -WorkingDirectory $TsbotRoot
    $DistRoot = Join-Path $TsbotRoot "dist"
    if (-not (Test-Path -LiteralPath (Join-Path $DistRoot "src\index.js") -PathType Leaf)) {
        throw "Production build did not create dist/src/index.js"
    }
    if (Test-Path -LiteralPath (Join-Path $DistRoot "tests")) {
        throw "Production build contains compiled tests."
    }
    $SourceIdentityScript = Join-Path $WindowsDirectory "compute-source-identity.mjs"
    if (-not (Test-Path -LiteralPath $SourceIdentityScript -PathType Leaf)) {
        throw "Cannot find the release source-identity tool: $SourceIdentityScript"
    }
    $SourceIdentity = (& $BundledNode $SourceIdentityScript).Trim()
    if ($LASTEXITCODE -ne 0 -or $SourceIdentity -notmatch "^[a-f0-9]{64}$") {
        throw "Release source identity generation failed."
    }

    $NpmCli = Join-Path $ExtractedNodeRoot "node_modules\npm\bin\npm-cli.js"
    if (-not (Test-Path -LiteralPath $NpmCli -PathType Leaf)) {
        throw "The pinned Node archive did not contain npm-cli.js: $NpmCli"
    }

    $AppRoot = Join-Path $StageRoot "app"
    $RuntimeRoot = Join-Path $StageRoot "runtime"
    $ToolsRoot = Join-Path $StageRoot "tools"
    New-Item -ItemType Directory -Path $AppRoot, $RuntimeRoot, $ToolsRoot -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $TsbotRoot "package.json") -Destination $AppRoot
    Copy-Item -LiteralPath (Join-Path $TsbotRoot "package-lock.json") -Destination $AppRoot

    Write-Host "Installing production dependencies with the bundled Node runtime..."
    $SavedPath = [System.Environment]::GetEnvironmentVariable("PATH", "Process")
    $SavedNode = [System.Environment]::GetEnvironmentVariable("NODE", "Process")
    $SavedNpmNodeExecPath = [System.Environment]::GetEnvironmentVariable("npm_node_execpath", "Process")
    try {
        $env:PATH = "$ExtractedNodeRoot;$SavedPath"
        $env:NODE = $BundledNode
        $env:npm_node_execpath = $BundledNode
        Invoke-NativeChecked -Executable $BundledNode -Arguments @(
            $NpmCli,
            "ci",
            "--omit=dev",
            "--ignore-scripts=false",
            "--no-audit",
            "--no-fund"
        ) -WorkingDirectory $AppRoot
    }
    finally {
        [System.Environment]::SetEnvironmentVariable("PATH", $SavedPath, "Process")
        [System.Environment]::SetEnvironmentVariable("NODE", $SavedNode, "Process")
        [System.Environment]::SetEnvironmentVariable("npm_node_execpath", $SavedNpmNodeExecPath, "Process")
    }
    $UnexpectedDevelopmentPackages = @(
        @("prettier", "tsx", "typescript", "vitest") | Where-Object {
            Test-Path -LiteralPath (Join-Path $AppRoot "node_modules\$_")
        }
    )
    if ($UnexpectedDevelopmentPackages.Count -gt 0) {
        throw "Development-only packages were installed in the portable artifact: $($UnexpectedDevelopmentPackages -join ', ')"
    }
    Invoke-NativeChecked -Executable $BundledNode -Arguments @(
        "-e",
        "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('SELECT 1').get();db.close();"
    ) -WorkingDirectory $AppRoot

    Copy-Item -LiteralPath $DistRoot -Destination (Join-Path $AppRoot "dist") -Recurse
    Copy-Item -LiteralPath $BundledNode -Destination $RuntimeRoot
    Copy-Item -LiteralPath (Join-Path $ExtractedNodeRoot "LICENSE") -Destination (Join-Path $RuntimeRoot "NODE-LICENSE.txt")
    Copy-Item -LiteralPath (Join-Path $WindowsDirectory "check-portable.mjs") -Destination $ToolsRoot
    Copy-Item -LiteralPath (Join-Path $WindowsDirectory "diagnostics.mjs") -Destination $ToolsRoot
    Copy-Item -LiteralPath (Join-Path $WindowsDirectory "templates\Start Superior Bot.cmd") -Destination $StageRoot
    Copy-Item -LiteralPath (Join-Path $WindowsDirectory "PORTABLE-README.txt") -Destination (Join-Path $StageRoot "README-WINDOWS.txt")
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot ".env.example") -Destination $StageRoot
    [System.IO.File]::WriteAllText((Join-Path $StageRoot "VERSION"), "$($Package.version)`n", $Utf8NoBom)
    $PackageLockHash = (Get-FileHash -LiteralPath (Join-Path $TsbotRoot "package-lock.json") -Algorithm SHA256).Hash.ToLowerInvariant()
    $BuildInfo = @(
        "PACKAGE_NAME=$($Package.name)",
        "PACKAGE_VERSION=$($Package.version)",
        "TARGET=win-x64",
        "NODE_VERSION=$NodeVersion",
        "NODE_ARCHIVE_SHA256=$($NodeArchiveSha256.ToLowerInvariant())",
        "CSHARP_COMPILER_PACKAGE=Microsoft.Net.Compilers.Toolset",
        "CSHARP_COMPILER_VERSION=$CompilerToolsetVersion",
        "CSHARP_COMPILER_PACKAGE_SHA256=$($CompilerToolsetPackageSha256.ToLowerInvariant())",
        "REFERENCE_ASSEMBLIES_PACKAGE=Microsoft.NETFramework.ReferenceAssemblies.net48",
        "REFERENCE_ASSEMBLIES_VERSION=$ReferenceAssembliesVersion",
        "REFERENCE_ASSEMBLIES_PACKAGE_SHA256=$($ReferenceAssembliesPackageSha256.ToLowerInvariant())",
        "BETTER_SQLITE3_BINARY_SHA256=$($BetterSqlite3BinarySha256.ToLowerInvariant())",
        "PACKAGE_LOCK_SHA256=$PackageLockHash",
        "SOURCE_SHA256=$SourceIdentity"
    )
    [System.IO.File]::WriteAllLines((Join-Path $StageRoot "BUILD-INFO.txt"), $BuildInfo, $Utf8NoBom)

    $Compiler = Join-Path $CompilerExtractRoot "tasks\net472\csc.exe"
    if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) {
        throw "The pinned compiler package did not contain csc.exe: $Compiler"
    }
    $ReferenceRoot = Join-Path $ReferenceAssembliesExtractRoot "build\.NETFramework\v4.8"
    $CompilerReferences = @(
        (Join-Path $ReferenceRoot "mscorlib.dll"),
        (Join-Path $ReferenceRoot "System.dll"),
        (Join-Path $ReferenceRoot "System.Core.dll"),
        (Join-Path $ReferenceRoot "System.IO.Compression.dll"),
        (Join-Path $ReferenceRoot "System.IO.Compression.FileSystem.dll")
    )
    $MissingCompilerReferences = @(
        $CompilerReferences | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }
    )
    if ($MissingCompilerReferences.Count -gt 0) {
        throw "The pinned reference-assemblies package is incomplete: $($MissingCompilerReferences -join ', ')"
    }

    New-Item -ItemType Directory -Path $LauncherSourceRoot | Out-Null
    $LauncherSource = Join-Path $WindowsDirectory "launcher\Program.cs"
    $CanonicalLauncherSource = Join-Path $LauncherSourceRoot "Program.cs"
    $LauncherText = [System.IO.File]::ReadAllText($LauncherSource)
    $LauncherText = $LauncherText.Replace("`r`n", "`n").Replace("`r", "`n")
    [System.IO.File]::WriteAllText($CanonicalLauncherSource, $LauncherText, $Utf8NoBom)
    $LauncherSupportSource = Join-Path $WindowsDirectory "launcher\LauncherSupport.cs"
    $CanonicalLauncherSupportSource = Join-Path $LauncherSourceRoot "LauncherSupport.cs"
    $LauncherSupportText = [System.IO.File]::ReadAllText($LauncherSupportSource)
    $LauncherSupportText = $LauncherSupportText.Replace("`r`n", "`n").Replace("`r", "`n")
    [System.IO.File]::WriteAllText($CanonicalLauncherSupportSource, $LauncherSupportText, $Utf8NoBom)
    $BuildIdentitySource = Join-Path $LauncherSourceRoot "BuildIdentity.cs"
    $BuildIdentityText = @"
using System.Reflection;

[assembly: AssemblyTitle("Superior Bot")]
[assembly: AssemblyProduct("Superior Bot")]
[assembly: AssemblyCompany("Superior")]
[assembly: AssemblyVersion("$AssemblyVersion")]
[assembly: AssemblyFileVersion("$AssemblyVersion")]
[assembly: AssemblyInformationalVersion("$($Package.version)")]

internal static class BuildIdentity
{
    public const string Version = "$($Package.version)";
}
"@
    $BuildIdentityText = $BuildIdentityText.Replace("`r`n", "`n").Replace("`r", "`n")
    [System.IO.File]::WriteAllText($BuildIdentitySource, $BuildIdentityText, $Utf8NoBom)

    Invoke-NativeChecked -Executable $Compiler -Arguments @(
        "/nologo",
        "/noconfig",
        "/nostdlib+",
        "/deterministic+",
        "/debug-",
        "/optimize+",
        "/langversion:7.3",
        "/platform:x64",
        "/target:exe",
        "/pathmap:$LauncherSourceRoot=/_/windows/launcher",
        "/reference:$($CompilerReferences[0])",
        "/reference:$($CompilerReferences[1])",
        "/reference:$($CompilerReferences[2])",
        "/out:$StageRoot\SuperiorBot.exe",
        $CanonicalLauncherSource,
        $CanonicalLauncherSupportSource,
        $BuildIdentitySource
    ) -WorkingDirectory $RepositoryRoot

    $NativeAddon = Get-ChildItem -LiteralPath (Join-Path $AppRoot "node_modules\better-sqlite3") -Filter "better_sqlite3.node" -Recurse -File
    if (@($NativeAddon).Count -ne 1) {
        throw "Expected exactly one packaged better-sqlite3 native binary; found $(@($NativeAddon).Count)."
    }
    $NativeAddonHash = (Get-FileHash -LiteralPath $NativeAddon[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($NativeAddonHash -ne $BetterSqlite3BinarySha256.ToLowerInvariant()) {
        throw "Packaged better-sqlite3 binary SHA-256 mismatch. Expected $BetterSqlite3BinarySha256; got $NativeAddonHash"
    }

    $Forbidden = Get-ChildItem -LiteralPath $StageRoot -Recurse -Force | Where-Object {
        $Relative = Get-RelativeFileName -BaseDirectory $StageRoot -FileName $_.FullName
        $_.Name -eq ".env" -or
        ($_.Name.StartsWith(".env") -and $_.Name -ne ".env.example") -or
        $_.Name -eq "mudae-watch.private.json" -or
        $_.Name.EndsWith(".private.json") -or
        $_.Extension -in @(".db", ".sqlite", ".sqlite3", ".backup", ".bak", ".log") -or
        $Relative -match "(^|/)(data|backups)(/|$)" -or
        $Relative -match "^app/(dist/)?tests(/|$)"
    }
    if (@($Forbidden).Count -gt 0) {
        throw "Portable staging contains forbidden files: $(@($Forbidden.FullName) -join ', ')"
    }
    $ReparsePoints = Get-ChildItem -LiteralPath $StageRoot -Recurse -Force | Where-Object {
        ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    }
    if (@($ReparsePoints).Count -gt 0) {
        throw "Portable staging contains reparse points: $(@($ReparsePoints.FullName) -join ', ')"
    }
    $MigrationCompatibilityFiles = @(
        Get-ChildItem -LiteralPath (Join-Path $AppRoot "dist\src") -Recurse -File |
            Where-Object { $_.Name -like "legacy-*" } |
            ForEach-Object {
                Get-RelativeFileName -BaseDirectory $StageRoot -FileName $_.FullName
            }
    )
    if (
        $MigrationCompatibilityFiles.Count -ne 1 -or
        $MigrationCompatibilityFiles[0] -ne "app/dist/src/storage/legacy-v2-converter.js"
    ) {
        throw "Only the isolated v2 migration converter may use a legacy-prefixed production filename."
    }

    $ManifestFiles = @(Get-SortedRelativeFileNames -BaseDirectory $StageRoot)
    $ManifestLines = foreach ($Relative in $ManifestFiles) {
        $FilePath = Join-Path $StageRoot $Relative.Replace("/", "\")
        $Hash = (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
        "$Hash  $Relative"
    }
    [System.IO.File]::WriteAllLines((Join-Path $StageRoot "MANIFEST.sha256"), $ManifestLines, $Utf8NoBom)

    $ZipWriter = Join-Path $WindowsDirectory "write-deterministic-zip.mjs"
    if (-not (Test-Path -LiteralPath $ZipWriter -PathType Leaf)) {
        throw "Cannot find the deterministic ZIP writer: $ZipWriter"
    }
    Invoke-NativeChecked -Executable $BundledNode -Arguments @(
        $ZipWriter,
        $StageRoot,
        $WorkArchive
    ) -WorkingDirectory $RepositoryRoot
    if (-not (Test-Path -LiteralPath $WorkArchive -PathType Leaf)) {
        throw "The deterministic ZIP writer did not create $WorkArchive"
    }
    if (Test-Path -LiteralPath $FinalArchive) {
        Remove-Item -LiteralPath $FinalArchive -Force
    }
    if (Test-Path -LiteralPath $FinalChecksum) {
        Remove-Item -LiteralPath $FinalChecksum -Force
    }
    Move-Item -LiteralPath $WorkArchive -Destination $FinalArchive
    $ArchiveHash = (Get-FileHash -LiteralPath $FinalArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText(
        $FinalChecksum,
        "$ArchiveHash  $([System.IO.Path]::GetFileName($FinalArchive))`n",
        $Utf8NoBom
    )

    if ($null -ne $StandaloneTarget) {
        $StandaloneSource = Join-Path $WindowsDirectory "standalone\Program.cs"
        if (-not (Test-Path -LiteralPath $StandaloneSource -PathType Leaf)) {
            throw "Cannot find the standalone launcher source: $StandaloneSource"
        }
        $CanonicalStandaloneSource = Join-Path $LauncherSourceRoot "StandaloneProgram.cs"
        $StandaloneText = [System.IO.File]::ReadAllText($StandaloneSource)
        $StandaloneText = $StandaloneText.Replace("`r`n", "`n").Replace("`r", "`n")
        [System.IO.File]::WriteAllText($CanonicalStandaloneSource, $StandaloneText, $Utf8NoBom)

        Invoke-NativeChecked -Executable $Compiler -Arguments @(
            "/nologo",
            "/noconfig",
            "/nostdlib+",
            "/deterministic+",
            "/debug-",
            "/optimize+",
            "/langversion:7.3",
            "/platform:x64",
            "/target:exe",
            "/pathmap:$LauncherSourceRoot=/_/windows/standalone",
            "/reference:$($CompilerReferences[0])",
            "/reference:$($CompilerReferences[1])",
            "/reference:$($CompilerReferences[2])",
            "/reference:$($CompilerReferences[3])",
            "/reference:$($CompilerReferences[4])",
            "/resource:$FinalArchive,SuperiorBot.Payload.zip",
            "/out:$StandaloneWorkOutput",
            $CanonicalStandaloneSource,
            $CanonicalLauncherSupportSource,
            $BuildIdentitySource
        ) -WorkingDirectory $RepositoryRoot

        $StandaloneParent = Split-Path -Parent $StandaloneTarget
        if (-not (Test-Path -LiteralPath $StandaloneParent -PathType Container)) {
            New-Item -ItemType Directory -Path $StandaloneParent -Force | Out-Null
        }
        if (Test-Path -LiteralPath $StandaloneTarget) {
            Remove-Item -LiteralPath $StandaloneTarget -Force
        }
        Move-Item -LiteralPath $StandaloneWorkOutput -Destination $StandaloneTarget
        $StandaloneHash = (Get-FileHash -LiteralPath $StandaloneTarget -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-Host "Standalone executable: $StandaloneTarget"
        Write-Host "Standalone SHA-256: $StandaloneHash"
    }

    Write-Host "Portable artifact: $FinalArchive"
    Write-Host "SHA-256: $ArchiveHash"
}
finally {
    foreach ($Download in @($NodeDownload, $CompilerPackageDownload, $ReferenceAssembliesPackageDownload)) {
        if (Test-Path -LiteralPath $Download) {
            Remove-Item -LiteralPath $Download -Force
        }
    }
    if (-not $KeepStaging) {
        Remove-WorkItem -Path $StageRoot
        Remove-WorkItem -Path $NodeExtractRoot
        Remove-WorkItem -Path $CompilerExtractRoot
        Remove-WorkItem -Path $ReferenceAssembliesExtractRoot
        Remove-WorkItem -Path $LauncherSourceRoot
        if (Test-Path -LiteralPath $WorkArchive) {
            Remove-Item -LiteralPath $WorkArchive -Force
        }
        if (Test-Path -LiteralPath $StandaloneWorkOutput) {
            Remove-Item -LiteralPath $StandaloneWorkOutput -Force
        }
    }
}
