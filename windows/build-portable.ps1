#Requires -Version 7.0

[CmdletBinding()]
param(
    [string]$OutputDirectory = "windows/.artifacts/development/release",
    [string]$BunVersion = "1.4.0",
    [string]$CompilerToolsetVersion = "4.12.0",
    [string]$CompilerToolsetPackageSha256 = "fe24ef31a6ffcb7c49383d2fd362763dee291ad9b9d98cc0c19ef80203b99ebc",
    [string]$ReferenceAssembliesVersion = "1.0.3",
    [string]$ReferenceAssembliesPackageSha256 = "8a7e348538e7eb91351696911689f49e3d4f63f8bab517432bbe159b8b1104a2",
    [string]$StandaloneOutput = "",
    [string]$UpdaterOutput = "windows/.artifacts/development/Update.exe",
    [switch]$AllowUnsignedDevelopment,
    [string]$SigningCertificateThumbprint = "",
    [string]$SigningPfxPath = "",
    [switch]$SigningCertificateInMachineStore,
    [string]$ExpectedPublisher = "",
    [string]$SigningTimestampUrl = "https://timestamp.digicert.com",
    [string]$SignToolPath = "",
    [switch]$KeepStaging
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "hash-utils.ps1")
. (Join-Path $PSScriptRoot "path-safety.ps1")
. (Join-Path $PSScriptRoot "bun-environment.ps1")
. (Join-Path $PSScriptRoot "signing.ps1")

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

    Remove-SafeOwnedTree `
        -Path $Path `
        -OwnerDirectory $WorkRoot `
        -Description "Windows packaging work tree"
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
    [void](Assert-PathInsideDirectory `
        -Path $Destination `
        -OwnerDirectory $CacheRoot `
        -Description "$Description cache file")
    [void](Assert-PathHasNoReparsePoint `
        -Path $Destination `
        -Description "$Description cache file")
    [void](Assert-PathHasNoReparsePoint `
        -Path $Download `
        -Description "$Description temporary download")
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        $CachedHash = Get-Sha256Hex -LiteralPath $Destination
        if ($CachedHash -ne $Expected) {
            Remove-SafeOwnedFile `
                -Path $Destination `
                -OwnerDirectory $CacheRoot `
                -Description "$Description cache file"
        }
    }
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        return
    }
    if (Test-Path -LiteralPath $Download) {
        Remove-SafeOwnedFile `
            -Path $Download `
            -OwnerDirectory $CacheRoot `
            -Description "$Description temporary download"
    }

    Write-Host "Downloading pinned $Description..."
    Invoke-WebRequest -Uri $Uri -OutFile $Download
    $DownloadedHash = Get-Sha256Hex -LiteralPath $Download
    if ($DownloadedHash -ne $Expected) {
        Remove-SafeOwnedFile `
            -Path $Download `
            -OwnerDirectory $CacheRoot `
            -Description "$Description temporary download"
        throw "$Description SHA-256 mismatch. Expected $Expected; got $DownloadedHash"
    }
    [void](Assert-PathHasNoReparsePoint `
        -Path $Destination `
        -Description "$Description cache file")
    [void](Assert-PathHasNoReparsePoint `
        -Path $Download `
        -Description "$Description temporary download")
    Move-Item -LiteralPath $Download -Destination $Destination
    [void](Assert-PathHasNoReparsePoint `
        -Path $Destination `
        -Description "$Description cache file")
}

function Expand-ZipChecked {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$DestinationDirectory
    )

    [void](Assert-PathHasNoReparsePoint -Path $ArchivePath -Description "Pinned package archive")
    [void](Assert-PathInsideDirectory `
        -Path $DestinationDirectory `
        -OwnerDirectory $WorkRoot `
        -Description "Package extraction directory")
    [void](Initialize-SafeDirectory `
        -Path $DestinationDirectory `
        -Description "Package extraction directory")
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
    [void](Assert-PathHasNoReparsePoint `
        -Path $DestinationDirectory `
        -Description "Package extraction directory")
    [System.IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $DestinationDirectory)
    [void](Assert-PathTreeHasNoReparsePoint `
        -Path $DestinationDirectory `
        -Description "Extracted package tree")
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

function ConvertTo-CSharpStringLiteral {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    return $Value.Replace("\", "\\").Replace('"', '\"').Replace("`r", " ").Replace("`n", " ")
}

function ConvertTo-SafeBuildInfoValue {
    param([Parameter(Mandatory = $true)][string]$Value)

    $Normalized = $Value.Replace("`r", " ").Replace("`n", " ")
    if ($Normalized.Length -gt 4096) {
        throw "Signing metadata exceeds the BUILD-INFO value limit."
    }
    return $Normalized
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
$UpdaterWorkOutput = Join-Path $WorkRoot "SuperiorBot-updater.exe"
if ([string]::IsNullOrWhiteSpace($UpdaterOutput)) {
    throw "Every release must build and package Update.exe."
}
$UpdaterTarget = if ([System.IO.Path]::IsPathRooted($UpdaterOutput)) {
    [System.IO.Path]::GetFullPath($UpdaterOutput)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot $UpdaterOutput))
}

[void](Initialize-SafeDirectory -Path $WorkRoot -Description "Windows packaging work root")
[void](Initialize-SafeDirectory -Path $CacheRoot -Description "Windows packaging cache root")
[void](Initialize-SafeDirectory -Path $OutputRoot -Description "Artifact output directory")
Remove-WorkItem -Path $StageRoot
Remove-WorkItem -Path $CompilerExtractRoot
Remove-WorkItem -Path $ReferenceAssembliesExtractRoot
Remove-WorkItem -Path $LauncherSourceRoot
if (Test-Path -LiteralPath $WorkArchive) {
    Remove-SafeOwnedFile -Path $WorkArchive -OwnerDirectory $WorkRoot -Description "Work archive"
}
if (Test-Path -LiteralPath $StandaloneWorkOutput) {
    Remove-SafeOwnedFile -Path $StandaloneWorkOutput -OwnerDirectory $WorkRoot -Description "Standalone work output"
}
if (Test-Path -LiteralPath $UpdaterWorkOutput) {
    Remove-SafeOwnedFile -Path $UpdaterWorkOutput -OwnerDirectory $WorkRoot -Description "Updater work output"
}

$BunEnvironmentSnapshot = Enter-BunBuildEnvironment
$SigningContext = $null
try {
    $SigningContext = Initialize-ReleaseSigning `
        -AllowUnsignedDevelopment:$AllowUnsignedDevelopment `
        -CertificateThumbprint $SigningCertificateThumbprint `
        -PfxPath $SigningPfxPath `
        -MachineCertificateStore:$SigningCertificateInMachineStore `
        -ExpectedPublisher $ExpectedPublisher `
        -TimestampUrl $SigningTimestampUrl `
        -SignToolPath $SignToolPath
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

    Expand-ZipChecked -ArchivePath $CompilerPackage -DestinationDirectory $CompilerExtractRoot
    Expand-ZipChecked -ArchivePath $ReferenceAssembliesPackage -DestinationDirectory $ReferenceAssembliesExtractRoot
    $BunCommand = Get-Command bun.exe -CommandType Application -ErrorAction Stop
    $Bun = [System.IO.Path]::GetFullPath($BunCommand.Source)
    if ([System.IO.Path]::GetExtension($Bun) -ne ".exe") {
        throw "Windows packaging requires bun.exe, not a command shim: $Bun"
    }
    $RuntimeVersion = (& $Bun --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $RuntimeVersion -ne $BunVersion) {
        throw "Bun version check failed; expected $BunVersion, got $RuntimeVersion"
    }
    $BunExecutableHash = Get-Sha256Hex -LiteralPath $Bun

    Write-Host "Building clean production JavaScript with Bun..."
    [void](Assert-PathTreeHasNoReparsePoint `
        -Path (Join-Path $TsbotRoot "src") `
        -Description "TypeScript production source tree")
    Invoke-NativeChecked -Executable $Bun -Arguments @(
        "--no-env-file",
        (Join-Path $RepositoryRoot "scripts\version.mjs"),
        "verify"
    ) -WorkingDirectory $TsbotRoot
    Invoke-NativeChecked -Executable $Bun -Arguments @(
        "--no-env-file",
        (Join-Path $WindowsDirectory "clean-dist.mjs")
    ) -WorkingDirectory $TsbotRoot
    Invoke-NativeChecked -Executable $Bun -Arguments @(
        "--no-env-file",
        (Join-Path $TsbotRoot "node_modules\typescript\bin\tsc"),
        "-p",
        (Join-Path $TsbotRoot "tsconfig.build.json")
    ) -WorkingDirectory $TsbotRoot
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
    $SourceIdentity = (& $Bun --no-env-file $SourceIdentityScript).Trim()
    if ($LASTEXITCODE -ne 0 -or $SourceIdentity -notmatch "^[a-f0-9]{64}$") {
        throw "Release source identity generation failed."
    }

    $AppRoot = Join-Path $StageRoot "app"
    [void](Initialize-SafeDirectory -Path $AppRoot -Description "Portable application staging directory")

    $CompiledRuntime = Join-Path $AppRoot "SuperiorBot.Runtime.exe"
    Write-Host "Compiling the self-contained Bun runtime..."
    Invoke-NativeChecked -Executable $Bun -Arguments @(
        "--no-env-file",
        "build",
        "--compile",
        "--target=bun-windows-x64-baseline",
        "--minify",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--outfile",
        $CompiledRuntime,
        (Join-Path $TsbotRoot "src\windows-runtime.ts")
    ) -WorkingDirectory $TsbotRoot
    if (-not (Test-Path -LiteralPath $CompiledRuntime -PathType Leaf)) {
        throw "Bun did not create the compiled Windows runtime: $CompiledRuntime"
    }
    Invoke-ReleaseSignature -Context $SigningContext -FilePath $CompiledRuntime
    $CompiledRuntimeHash = Get-Sha256Hex -LiteralPath $CompiledRuntime
    $SavedApplicationRoot = [System.Environment]::GetEnvironmentVariable(
        "SUPERIOR_APPLICATION_ROOT",
        "Process"
    )
    $SavedDiagnosticsSkip = [System.Environment]::GetEnvironmentVariable(
        "SUPERIOR_DIAGNOSTICS_SKIP_DATABASE",
        "Process"
    )
    try {
        $env:SUPERIOR_APPLICATION_ROOT = $StageRoot
        $env:SUPERIOR_DIAGNOSTICS_SKIP_DATABASE = "1"
        Invoke-NativeChecked -Executable $CompiledRuntime -Arguments @(
            "--diagnostics"
        ) -WorkingDirectory $StageRoot
    }
    finally {
        [System.Environment]::SetEnvironmentVariable(
            "SUPERIOR_APPLICATION_ROOT",
            $SavedApplicationRoot,
            "Process"
        )
        [System.Environment]::SetEnvironmentVariable(
            "SUPERIOR_DIAGNOSTICS_SKIP_DATABASE",
            $SavedDiagnosticsSkip,
            "Process"
        )
    }

    Copy-Item -LiteralPath (Join-Path $WindowsDirectory "templates\Start Superior Bot.cmd") -Destination $StageRoot
    Copy-Item -LiteralPath (Join-Path $WindowsDirectory "PORTABLE-README.txt") -Destination (Join-Path $StageRoot "README-WINDOWS.txt")
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot ".env.example") -Destination $StageRoot
    [System.IO.File]::WriteAllText((Join-Path $StageRoot "VERSION"), "$($Package.version)`n", $Utf8NoBom)
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
        (Join-Path $ReferenceRoot "System.IO.Compression.FileSystem.dll"),
        (Join-Path $ReferenceRoot "System.Security.dll")
    )
    $MissingCompilerReferences = @(
        $CompilerReferences | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }
    )
    if ($MissingCompilerReferences.Count -gt 0) {
        throw "The pinned reference-assemblies package is incomplete: $($MissingCompilerReferences -join ', ')"
    }

    [void](Initialize-SafeDirectory -Path $LauncherSourceRoot -Description "Launcher source work directory")
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
    $AuthenticodeSupportSource = Join-Path $WindowsDirectory "launcher\AuthenticodeSupport.cs"
    if (-not (Test-Path -LiteralPath $AuthenticodeSupportSource -PathType Leaf)) {
        throw "Cannot find the Authenticode verification source: $AuthenticodeSupportSource"
    }
    $CanonicalAuthenticodeSupportSource = Join-Path $LauncherSourceRoot "AuthenticodeSupport.cs"
    $AuthenticodeSupportText = [System.IO.File]::ReadAllText($AuthenticodeSupportSource)
    $AuthenticodeSupportText = $AuthenticodeSupportText.Replace("`r`n", "`n").Replace("`r", "`n")
    [System.IO.File]::WriteAllText($CanonicalAuthenticodeSupportSource, $AuthenticodeSupportText, $Utf8NoBom)
    $BuildIdentitySource = Join-Path $LauncherSourceRoot "BuildIdentity.cs"
    $SigningRequiredLiteral = if ($SigningContext.Required) { "true" } else { "false" }
    $BuildExpectedPublisher = if ($SigningContext.Required) { $SigningContext.Subject } else { "" }
    $BuildExpectedThumbprint = if ($SigningContext.Required) { $SigningContext.Thumbprint } else { "" }
    $ExpectedPublisherLiteral = ConvertTo-CSharpStringLiteral -Value $BuildExpectedPublisher
    $ExpectedThumbprintLiteral = ConvertTo-CSharpStringLiteral -Value $BuildExpectedThumbprint
    $SigningModeLiteral = ConvertTo-CSharpStringLiteral -Value $SigningContext.Mode
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
    public static readonly bool SigningRequired = $SigningRequiredLiteral;
    public const string ExpectedPublisher = "$ExpectedPublisherLiteral";
    public const string ExpectedThumbprint = "$ExpectedThumbprintLiteral";
    public const string SigningMode = "$SigningModeLiteral";
}
"@
    $BuildIdentityText = $BuildIdentityText.Replace("`r`n", "`n").Replace("`r", "`n")
    [System.IO.File]::WriteAllText($BuildIdentitySource, $BuildIdentityText, $Utf8NoBom)

    if ($null -ne $UpdaterTarget) {
        $UpdaterSource = Join-Path $WindowsDirectory "updater\Program.cs"
        if (-not (Test-Path -LiteralPath $UpdaterSource -PathType Leaf)) {
            throw "Cannot find the updater source: $UpdaterSource"
        }
        $CanonicalUpdaterSource = Join-Path $LauncherSourceRoot "UpdaterProgram.cs"
        $UpdaterText = [System.IO.File]::ReadAllText($UpdaterSource)
        $UpdaterText = $UpdaterText.Replace("`r`n", "`n").Replace("`r", "`n")
        [System.IO.File]::WriteAllText($CanonicalUpdaterSource, $UpdaterText, $Utf8NoBom)

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
            "/pathmap:$LauncherSourceRoot=/_/windows/updater",
            "/reference:$($CompilerReferences[0])",
            "/reference:$($CompilerReferences[1])",
            "/reference:$($CompilerReferences[2])",
            "/reference:$($CompilerReferences[5])",
            "/out:$UpdaterWorkOutput",
            $CanonicalUpdaterSource,
            $CanonicalLauncherSupportSource,
            $CanonicalAuthenticodeSupportSource,
            $BuildIdentitySource
        ) -WorkingDirectory $RepositoryRoot
        if (-not (Test-Path -LiteralPath $UpdaterWorkOutput -PathType Leaf)) {
            throw "The updater compiler did not create $UpdaterWorkOutput"
        }
        Invoke-ReleaseSignature -Context $SigningContext -FilePath $UpdaterWorkOutput
        Copy-Item -LiteralPath $UpdaterWorkOutput -Destination (Join-Path $StageRoot "Update.exe")
    }

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
        "/reference:$($CompilerReferences[5])",
        "/out:$StageRoot\SuperiorBot.exe",
        $CanonicalLauncherSource,
        $CanonicalLauncherSupportSource,
        $CanonicalAuthenticodeSupportSource,
        $BuildIdentitySource
    ) -WorkingDirectory $RepositoryRoot

    Invoke-ReleaseSignature -Context $SigningContext -FilePath (Join-Path $StageRoot "SuperiorBot.exe")

    foreach ($SignedReleaseBinary in @(
        $CompiledRuntime,
        (Join-Path $StageRoot "SuperiorBot.exe"),
        (Join-Path $StageRoot "Update.exe")
    )) {
        Confirm-ReleaseSignature -Context $SigningContext -FilePath $SignedReleaseBinary
    }
    $BunLockHash = Get-Sha256Hex -LiteralPath (Join-Path $TsbotRoot "bun.lock")
    $SigningSubject = ConvertTo-SafeBuildInfoValue -Value ([string]$SigningContext.Subject)
    $SigningThumbprint = ConvertTo-SafeBuildInfoValue -Value ([string]$SigningContext.Thumbprint)
    $BuildInfo = @(
        "PACKAGE_NAME=$($Package.name)",
        "PACKAGE_VERSION=$($Package.version)",
        "TARGET=win-x64",
        "BUN_VERSION=$BunVersion",
        "BUN_EXECUTABLE_SHA256=$BunExecutableHash",
        "COMPILED_RUNTIME_SHA256=$CompiledRuntimeHash",
        "CSHARP_COMPILER_PACKAGE=Microsoft.Net.Compilers.Toolset",
        "CSHARP_COMPILER_VERSION=$CompilerToolsetVersion",
        "CSHARP_COMPILER_PACKAGE_SHA256=$($CompilerToolsetPackageSha256.ToLowerInvariant())",
        "REFERENCE_ASSEMBLIES_PACKAGE=Microsoft.NETFramework.ReferenceAssemblies.net48",
        "REFERENCE_ASSEMBLIES_VERSION=$ReferenceAssembliesVersion",
        "REFERENCE_ASSEMBLIES_PACKAGE_SHA256=$($ReferenceAssembliesPackageSha256.ToLowerInvariant())",
        "BUN_LOCK_SHA256=$BunLockHash",
        "SOURCE_SHA256=$SourceIdentity",
        "SIGNING_MODE=$($SigningContext.Mode)",
        "SIGNATURE_STATUS=$($SigningContext.SignatureStatus)",
        "SIGNING_SUBJECT=$SigningSubject",
        "SIGNING_THUMBPRINT=$SigningThumbprint",
        "TIMESTAMP_STATUS=$($SigningContext.TimestampStatus)"
    )
    [System.IO.File]::WriteAllLines((Join-Path $StageRoot "BUILD-INFO.txt"), $BuildInfo, $Utf8NoBom)

    $Forbidden = Get-ChildItem -LiteralPath $StageRoot -Recurse -Force | Where-Object {
        $Relative = Get-RelativeFileName -BaseDirectory $StageRoot -FileName $_.FullName
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
        throw "Portable staging contains forbidden files: $(@($Forbidden.FullName) -join ', ')"
    }
    $ReparsePoints = Get-ChildItem -LiteralPath $StageRoot -Recurse -Force | Where-Object {
        ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    }
    if (@($ReparsePoints).Count -gt 0) {
        throw "Portable staging contains reparse points: $(@($ReparsePoints.FullName) -join ', ')"
    }
    $MigrationCompatibilityFiles = @(
        Get-ChildItem -LiteralPath (Join-Path $DistRoot "src") -Recurse -File |
            Where-Object { $_.Name -like "legacy-*" } |
            ForEach-Object {
                Get-RelativeFileName -BaseDirectory $DistRoot -FileName $_.FullName
            }
    )
    if (
        $MigrationCompatibilityFiles.Count -ne 1 -or
        $MigrationCompatibilityFiles[0] -ne "src/storage/legacy-v2-converter.js"
    ) {
        throw "Only the isolated v2 migration converter may use a legacy-prefixed production filename."
    }

    $ManifestFiles = @(Get-SortedRelativeFileNames -BaseDirectory $StageRoot)
    [string[]]$ExpectedManifestFiles = @(
        ".env.example",
        "app/SuperiorBot.Runtime.exe",
        "BUILD-INFO.txt",
        "README-WINDOWS.txt",
        "Start Superior Bot.cmd",
        "SuperiorBot.exe",
        "Update.exe",
        "VERSION"
    )
    [System.Array]::Sort($ExpectedManifestFiles, [System.StringComparer]::Ordinal)
    $InventoryDifference = @(
        Compare-Object `
            -ReferenceObject $ExpectedManifestFiles `
            -DifferenceObject $ManifestFiles `
            -CaseSensitive
    )
    if ($InventoryDifference.Count -ne 0) {
        throw "Portable staging does not match the exact release inventory: $($InventoryDifference | Out-String)"
    }
    $ManifestLines = foreach ($Relative in $ManifestFiles) {
        $FilePath = Join-Path $StageRoot $Relative.Replace("/", "\")
        $Hash = Get-Sha256Hex -LiteralPath $FilePath
        "$Hash  $Relative"
    }
    [System.IO.File]::WriteAllLines((Join-Path $StageRoot "MANIFEST.sha256"), $ManifestLines, $Utf8NoBom)

    $ZipWriter = Join-Path $WindowsDirectory "write-deterministic-zip.mjs"
    if (-not (Test-Path -LiteralPath $ZipWriter -PathType Leaf)) {
        throw "Cannot find the deterministic ZIP writer: $ZipWriter"
    }
    Invoke-NativeChecked -Executable $Bun -Arguments @(
        "--no-env-file",
        $ZipWriter,
        $StageRoot,
        $WorkArchive
    ) -WorkingDirectory $RepositoryRoot
    if (-not (Test-Path -LiteralPath $WorkArchive -PathType Leaf)) {
        throw "The deterministic ZIP writer did not create $WorkArchive"
    }
    if (Test-Path -LiteralPath $FinalArchive) {
        Remove-SafeOwnedFile -Path $FinalArchive -OwnerDirectory $OutputRoot -Description "Published archive"
    }
    if (Test-Path -LiteralPath $FinalChecksum) {
        Remove-SafeOwnedFile -Path $FinalChecksum -OwnerDirectory $OutputRoot -Description "Published archive checksum"
    }
    [void](Assert-PathHasNoReparsePoint -Path $WorkArchive -Description "Work archive")
    [void](Assert-PathHasNoReparsePoint -Path $FinalArchive -Description "Published archive")
    Move-Item -LiteralPath $WorkArchive -Destination $FinalArchive
    $ArchiveHash = Get-Sha256Hex -LiteralPath $FinalArchive
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
            "/reference:$($CompilerReferences[5])",
            "/resource:$FinalArchive,SuperiorBot.Payload.zip",
            "/out:$StandaloneWorkOutput",
            $CanonicalStandaloneSource,
            $CanonicalLauncherSupportSource,
            $CanonicalAuthenticodeSupportSource,
            $BuildIdentitySource
        ) -WorkingDirectory $RepositoryRoot

        Invoke-ReleaseSignature -Context $SigningContext -FilePath $StandaloneWorkOutput

        $StandaloneParent = Split-Path -Parent $StandaloneTarget
        [void](Initialize-SafeDirectory -Path $StandaloneParent -Description "Standalone output directory")
        if (Test-Path -LiteralPath $StandaloneTarget) {
            Remove-SafeOwnedFile -Path $StandaloneTarget -OwnerDirectory $StandaloneParent -Description "Standalone output"
        }
        [void](Assert-PathHasNoReparsePoint -Path $StandaloneWorkOutput -Description "Standalone work output")
        [void](Assert-PathHasNoReparsePoint -Path $StandaloneTarget -Description "Standalone output")
        Move-Item -LiteralPath $StandaloneWorkOutput -Destination $StandaloneTarget
        Confirm-ReleaseSignature -Context $SigningContext -FilePath $StandaloneTarget
        $StandaloneHash = Get-Sha256Hex -LiteralPath $StandaloneTarget
        Write-Host "Standalone executable: $StandaloneTarget"
        Write-Host "Standalone SHA-256: $StandaloneHash"
    }

    if ($null -ne $UpdaterTarget) {
        $UpdaterParent = Split-Path -Parent $UpdaterTarget
        [void](Initialize-SafeDirectory -Path $UpdaterParent -Description "Updater output directory")
        if (Test-Path -LiteralPath $UpdaterTarget) {
            Remove-SafeOwnedFile -Path $UpdaterTarget -OwnerDirectory $UpdaterParent -Description "Updater output"
        }
        [void](Assert-PathHasNoReparsePoint -Path $UpdaterWorkOutput -Description "Updater work output")
        [void](Assert-PathHasNoReparsePoint -Path $UpdaterTarget -Description "Updater output")
        Move-Item -LiteralPath $UpdaterWorkOutput -Destination $UpdaterTarget
        Confirm-ReleaseSignature -Context $SigningContext -FilePath $UpdaterTarget
        $UpdaterHash = Get-Sha256Hex -LiteralPath $UpdaterTarget
        Write-Host "Updater executable: $UpdaterTarget"
        Write-Host "Updater SHA-256: $UpdaterHash"
    }

    Write-Host "Portable artifact: $FinalArchive"
    Write-Host "SHA-256: $ArchiveHash"
}
finally {
    try {
        if ($null -ne $SigningContext) {
            Close-ReleaseSigning -Context $SigningContext
        }
        foreach ($Download in @($CompilerPackageDownload, $ReferenceAssembliesPackageDownload)) {
            if (Test-Path -LiteralPath $Download) {
                Remove-SafeOwnedFile -Path $Download -OwnerDirectory $CacheRoot -Description "Temporary package download"
            }
        }
        if (-not $KeepStaging) {
            Remove-WorkItem -Path $StageRoot
            Remove-WorkItem -Path $CompilerExtractRoot
            Remove-WorkItem -Path $ReferenceAssembliesExtractRoot
            Remove-WorkItem -Path $LauncherSourceRoot
            if (Test-Path -LiteralPath $WorkArchive) {
                Remove-SafeOwnedFile -Path $WorkArchive -OwnerDirectory $WorkRoot -Description "Work archive"
            }
            if (Test-Path -LiteralPath $StandaloneWorkOutput) {
                Remove-SafeOwnedFile -Path $StandaloneWorkOutput -OwnerDirectory $WorkRoot -Description "Standalone work output"
            }
            if (Test-Path -LiteralPath $UpdaterWorkOutput) {
                Remove-SafeOwnedFile -Path $UpdaterWorkOutput -OwnerDirectory $WorkRoot -Description "Updater work output"
            }
        }
    }
    finally {
        Exit-BunBuildEnvironment -Snapshot $BunEnvironmentSnapshot
    }
}
