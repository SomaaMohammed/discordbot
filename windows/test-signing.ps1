#Requires -Version 7.0

[CmdletBinding()]
param(
    [string]$TimestampUrl = "https://timestamp.digicert.com",
    [string]$SignToolPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "hash-utils.ps1")
. (Join-Path $PSScriptRoot "path-safety.ps1")
. (Join-Path $PSScriptRoot "signing.ps1")

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Package = Get-Content -LiteralPath (Join-Path $RepositoryRoot "tsbot\package.json") -Raw | ConvertFrom-Json
$CurrentVersion = [string]$Package.version
if ($CurrentVersion -notmatch "^\d+\.\d+\.\d+$") {
    throw "Package version must be MAJOR.MINOR.PATCH: $CurrentVersion"
}
$CurrentAssemblyVersion = "$CurrentVersion.0"
$TemporaryParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$TemporaryRoot = Join-Path $TemporaryParent ("superior-signing-" + [System.Guid]::NewGuid().ToString("N"))
$Publisher = "CN=Superior Bot Ephemeral Signing Test " + [System.Guid]::NewGuid().ToString("N")
$SigningCertificate = $null
$SameSubjectCertificate = $null
$ExpiredCertificate = $null
$UntrustedCertificate = $null
$TrustedRootPath = $null
$SameSubjectTrustedRootPath = $null
$ExpiredTrustedRootPath = $null
$SigningContext = $null

function Compile-TestExecutable {
    param(
        [Parameter(Mandatory = $true)][string[]]$Sources,
        [Parameter(Mandatory = $true)][string]$OutputAssembly
    )

    $SourceFiles = @()
    for ($Index = 0; $Index -lt $Sources.Count; $Index += 1) {
        $SourceFile = Join-Path $TemporaryRoot "$([System.IO.Path]::GetFileNameWithoutExtension($OutputAssembly))-source-$Index.cs"
        [System.IO.File]::WriteAllText($SourceFile, $Sources[$Index])
        $SourceFiles += $SourceFile
    }
    Add-Type `
        -Path $SourceFiles `
        -ReferencedAssemblies ([System.Security.Cryptography.Pkcs.SignedCms].Assembly.Location) `
        -OutputType ConsoleApplication `
        -OutputAssembly $OutputAssembly
    if (-not (Test-Path -LiteralPath $OutputAssembly -PathType Leaf)) {
        throw "The signing test compiler did not create $OutputAssembly"
    }
}

function Invoke-ExpectedExitCode {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][int]$ExpectedExitCode
    )

    & $Executable @Arguments
    if ($LASTEXITCODE -ne $ExpectedExitCode) {
        throw "Expected $Executable to exit $ExpectedExitCode; got $LASTEXITCODE."
    }
}

function Remove-TestCertificate {
    param([object]$Certificate, [string]$StoreRoot)

    if ($null -eq $Certificate) {
        return
    }
    $CertificatePath = "$StoreRoot\$($Certificate.Thumbprint)"
    if (Test-Path -LiteralPath $CertificatePath) {
        Remove-Item -LiteralPath $CertificatePath -Force
    }
}

[void](Initialize-SafeDirectory -Path $TemporaryRoot -Description "Signing test directory")
try {
    $SigningCertificate = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $Publisher `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -KeyExportPolicy Exportable `
        -NotAfter ([System.DateTime]::UtcNow.AddDays(2))
    $CertificateFile = Join-Path $TemporaryRoot "ephemeral-test-signer.cer"
    Export-Certificate -Cert $SigningCertificate -FilePath $CertificateFile | Out-Null
    $TrustedRoot = Import-Certificate -FilePath $CertificateFile -CertStoreLocation "Cert:\CurrentUser\Root"
    $TrustedRootPath = "Cert:\CurrentUser\Root\$($TrustedRoot.Thumbprint)"

    $SigningContext = Initialize-ReleaseSigning `
        -CertificateThumbprint $SigningCertificate.Thumbprint `
        -ExpectedPublisher $Publisher `
        -TimestampUrl $TimestampUrl `
        -SignToolPath $SignToolPath

    $CandidateSource = @"
using System;
using System.Reflection;
[assembly: AssemblyVersion("$CurrentAssemblyVersion")]
[assembly: AssemblyFileVersion("$CurrentAssemblyVersion")]
[assembly: AssemblyInformationalVersion("$CurrentVersion")]
internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--version")
        {
            Console.WriteLine("Superior Bot $CurrentVersion");
            return 0;
        }
        if (args.Length == 1 && args[0] == "--check")
        {
            return 7;
        }
        return 0;
    }
}
"@
    $OldTargetSource = $CandidateSource.Replace($CurrentAssemblyVersion, "7.2.8.0").Replace("Superior Bot $CurrentVersion", "Superior Bot 7.2.8").Replace("return 7;", "return 0;")
    $Unsigned = Join-Path $TemporaryRoot "unsigned.exe"
    $Signed = Join-Path $TemporaryRoot "signed.exe"
    $OldTarget = Join-Path $TemporaryRoot "old-target.exe"
    Compile-TestExecutable -Sources @($CandidateSource) -OutputAssembly $Unsigned
    Copy-Item -LiteralPath $Unsigned -Destination $Signed
    Compile-TestExecutable -Sources @($OldTargetSource) -OutputAssembly $OldTarget
    Invoke-ReleaseSignature -Context $SigningContext -FilePath $Signed
    Invoke-ReleaseSignature -Context $SigningContext -FilePath $OldTarget

    $AuthenticodeSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot "launcher\AuthenticodeSupport.cs") -Raw
    $VerifierSource = @"
using System;
internal static class BuildIdentity
{
    public static readonly bool SigningRequired = true;
    public static readonly string ExpectedPublisher = Environment.GetEnvironmentVariable("SUPERIOR_TEST_EXPECTED_PUBLISHER") ?? "";
    public static readonly string ExpectedThumbprint = Environment.GetEnvironmentVariable("SUPERIOR_TEST_EXPECTED_THUMBPRINT") ?? "";
}
internal static class SignatureVerifier
{
    private static int Main(string[] args)
    {
        try
        {
            AuthenticodeSupport.VerifyFile(args[0], "Signing test candidate");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name);
            return 1;
        }
    }
}
"@
    $Verifier = Join-Path $TemporaryRoot "signature-verifier.exe"
    Compile-TestExecutable -Sources @($AuthenticodeSource, $VerifierSource) -OutputAssembly $Verifier

    $env:SUPERIOR_TEST_EXPECTED_PUBLISHER = $Publisher
    $env:SUPERIOR_TEST_EXPECTED_THUMBPRINT = $SigningCertificate.Thumbprint
    Invoke-ExpectedExitCode -Executable $Verifier -Arguments @($Signed) -ExpectedExitCode 0
    Invoke-ExpectedExitCode -Executable $Verifier -Arguments @($Unsigned) -ExpectedExitCode 1
    $env:SUPERIOR_TEST_EXPECTED_PUBLISHER = "CN=Wrong Publisher"
    Invoke-ExpectedExitCode -Executable $Verifier -Arguments @($Signed) -ExpectedExitCode 1
    $env:SUPERIOR_TEST_EXPECTED_PUBLISHER = $Publisher

    $Untimestamped = Join-Path $TemporaryRoot "untimestamped.exe"
    Copy-Item -LiteralPath $Unsigned -Destination $Untimestamped
    & ([string]$SigningContext.SignTool) sign /fd SHA256 /sha1 $SigningCertificate.Thumbprint $Untimestamped
    if ($LASTEXITCODE -ne 0) {
        throw "signtool.exe could not create the untimestamped fixture."
    }
    Invoke-ExpectedExitCode -Executable $Verifier -Arguments @($Untimestamped) -ExpectedExitCode 1

    $SameSubjectCertificate = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $Publisher `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -NotAfter ([System.DateTime]::UtcNow.AddDays(2))
    $SameSubjectCertificateFile = Join-Path $TemporaryRoot "same-subject-test-signer.cer"
    Export-Certificate -Cert $SameSubjectCertificate -FilePath $SameSubjectCertificateFile | Out-Null
    $SameSubjectTrustedRoot = Import-Certificate `
        -FilePath $SameSubjectCertificateFile `
        -CertStoreLocation "Cert:\CurrentUser\Root"
    $SameSubjectTrustedRootPath = "Cert:\CurrentUser\Root\$($SameSubjectTrustedRoot.Thumbprint)"
    $SameSubject = Join-Path $TemporaryRoot "same-subject.exe"
    Copy-Item -LiteralPath $Unsigned -Destination $SameSubject
    & ([string]$SigningContext.SignTool) sign /fd SHA256 /td SHA256 /tr $TimestampUrl /sha1 $SameSubjectCertificate.Thumbprint $SameSubject
    if ($LASTEXITCODE -ne 0) {
        throw "signtool.exe could not create the same-subject certificate fixture."
    }
    Invoke-ExpectedExitCode -Executable $Verifier -Arguments @($SameSubject) -ExpectedExitCode 1

    $ExpiredPublisher = "CN=Superior Bot Expired Test " + [System.Guid]::NewGuid().ToString("N")
    $ExpiredCertificate = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $ExpiredPublisher `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -NotBefore ([System.DateTime]::UtcNow.AddDays(-2)) `
        -NotAfter ([System.DateTime]::UtcNow.AddDays(-1))
    $ExpiredCertificateFile = Join-Path $TemporaryRoot "expired-test-signer.cer"
    Export-Certificate -Cert $ExpiredCertificate -FilePath $ExpiredCertificateFile | Out-Null
    $ExpiredTrustedRoot = Import-Certificate `
        -FilePath $ExpiredCertificateFile `
        -CertStoreLocation "Cert:\CurrentUser\Root"
    $ExpiredTrustedRootPath = "Cert:\CurrentUser\Root\$($ExpiredTrustedRoot.Thumbprint)"
    $Expired = Join-Path $TemporaryRoot "expired.exe"
    Copy-Item -LiteralPath $Unsigned -Destination $Expired
    & ([string]$SigningContext.SignTool) sign /fd SHA256 /sha1 $ExpiredCertificate.Thumbprint $Expired
    if ($LASTEXITCODE -eq 0) {
        $env:SUPERIOR_TEST_EXPECTED_PUBLISHER = $ExpiredPublisher
        $env:SUPERIOR_TEST_EXPECTED_THUMBPRINT = $ExpiredCertificate.Thumbprint
        Invoke-ExpectedExitCode -Executable $Verifier -Arguments @($Expired) -ExpectedExitCode 1
        $env:SUPERIOR_TEST_EXPECTED_PUBLISHER = $Publisher
        $env:SUPERIOR_TEST_EXPECTED_THUMBPRINT = $SigningCertificate.Thumbprint
    }

    $Tampered = Join-Path $TemporaryRoot "tampered.exe"
    Copy-Item -LiteralPath $Signed -Destination $Tampered
    $TamperedStream = [System.IO.File]::Open($Tampered, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $TamperedStream.WriteByte(0x41)
        $TamperedStream.Flush($true)
    }
    finally {
        $TamperedStream.Dispose()
    }
    Invoke-ExpectedExitCode -Executable $Verifier -Arguments @($Tampered) -ExpectedExitCode 1

    $UntrustedPublisher = "CN=Superior Bot Untrusted Test " + [System.Guid]::NewGuid().ToString("N")
    $UntrustedCertificate = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $UntrustedPublisher `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -NotAfter ([System.DateTime]::UtcNow.AddDays(2))
    $Untrusted = Join-Path $TemporaryRoot "untrusted.exe"
    Copy-Item -LiteralPath $Unsigned -Destination $Untrusted
    $ResolvedSignTool = $SigningContext.SignTool
    & $ResolvedSignTool sign /fd SHA256 /td SHA256 /tr $TimestampUrl /sha1 $UntrustedCertificate.Thumbprint $Untrusted
    if ($LASTEXITCODE -ne 0) {
        throw "signtool.exe could not create the untrusted-certificate fixture."
    }
    $env:SUPERIOR_TEST_EXPECTED_PUBLISHER = $UntrustedPublisher
    $env:SUPERIOR_TEST_EXPECTED_THUMBPRINT = $UntrustedCertificate.Thumbprint
    Invoke-ExpectedExitCode -Executable $Verifier -Arguments @($Untrusted) -ExpectedExitCode 1
    $env:SUPERIOR_TEST_EXPECTED_PUBLISHER = $Publisher
    $env:SUPERIOR_TEST_EXPECTED_THUMBPRINT = $SigningCertificate.Thumbprint

    $UpdaterBuildIdentity = @"
using System.Reflection;
[assembly: AssemblyVersion("$CurrentAssemblyVersion")]
[assembly: AssemblyFileVersion("$CurrentAssemblyVersion")]
[assembly: AssemblyInformationalVersion("$CurrentVersion")]
internal static class BuildIdentity
{
    public const string Version = "$CurrentVersion";
    public static readonly bool SigningRequired = true;
    public const string ExpectedPublisher = "$Publisher";
    public const string ExpectedThumbprint = "$($SigningCertificate.Thumbprint)";
}
"@
    $UpdaterSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot "updater\Program.cs") -Raw
    $LauncherSupportSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot "launcher\LauncherSupport.cs") -Raw
    $Updater = Join-Path $TemporaryRoot "Update.exe"
    Compile-TestExecutable -Sources @($UpdaterSource, $LauncherSupportSource, $AuthenticodeSource, $UpdaterBuildIdentity) -OutputAssembly $Updater
    Invoke-ReleaseSignature -Context $SigningContext -FilePath $Updater

    $VerifierOutput = Join-Path $TemporaryRoot "release-verifier"
    [void](Initialize-SafeDirectory -Path $VerifierOutput -Description "Signer-thumbprint verifier fixture")
    [System.IO.File]::WriteAllBytes(
        (Join-Path $VerifierOutput "SuperiorBot-$CurrentVersion-win-x64.zip"),
        [byte[]]@(0x50, 0x4B)
    )
    $PriorErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $FinalVerifierOutput = & pwsh `
            -NoLogo `
            -NoProfile `
            -NonInteractive `
            -ExecutionPolicy Bypass `
            -File (Join-Path $PSScriptRoot "verify-release.ps1") `
            -Executable $Signed `
            -Updater $Updater `
            -OutputDirectory $VerifierOutput `
            -RequirePortableArtifact `
            -ExpectedPublisher $Publisher `
            -ExpectedSignerThumbprint $SameSubjectCertificate.Thumbprint 2>&1 | Out-String
        $FinalVerifierExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PriorErrorActionPreference
    }
    if (
        $FinalVerifierExitCode -eq 0 -or
        -not $FinalVerifierOutput.Contains("signer does not match the independently configured publisher and thumbprint")
    ) {
        throw "Final release verification accepted a same-subject certificate with the wrong thumbprint:`n$FinalVerifierOutput"
    }

    $InstallRoot = Join-Path $TemporaryRoot "installed"
    New-Item -ItemType Directory -Path $InstallRoot | Out-Null
    $Installed = Join-Path $InstallRoot "SuperiorBot.exe"
    Copy-Item -LiteralPath $OldTarget -Destination $Installed
    [System.IO.File]::WriteAllText((Join-Path $InstallRoot ".env"), "DISCORD_TOKEN=ephemeral-test-value`n")
    $OriginalHash = Get-Sha256Hex -LiteralPath $Installed
    $CandidateHash = Get-Sha256Hex -LiteralPath $Signed
    Invoke-ExpectedExitCode `
        -Executable $Updater `
        -Arguments @("--source", $Signed, "--target", $InstallRoot, "--sha256", $CandidateHash, "--no-start") `
        -ExpectedExitCode 1
    if ((Get-Sha256Hex -LiteralPath $Installed) -ne $OriginalHash) {
        throw "The signing-enabled updater did not restore the prior executable after the post-install check failed."
    }

    Write-Host "Authenticode signing tests passed: valid, exact certificate and final-verifier thumbprint, timestamp, wrong publisher, tampered, unsigned, expired, untrusted, and updater rollback."
}
finally {
    Remove-Item Env:\SUPERIOR_TEST_EXPECTED_PUBLISHER -ErrorAction SilentlyContinue
    Remove-Item Env:\SUPERIOR_TEST_EXPECTED_THUMBPRINT -ErrorAction SilentlyContinue
    if ($null -ne $SigningContext) {
        Close-ReleaseSigning -Context $SigningContext
    }
    if ($null -ne $TrustedRootPath -and (Test-Path -LiteralPath $TrustedRootPath)) {
        Remove-Item -LiteralPath $TrustedRootPath -Force
    }
    if ($null -ne $SameSubjectTrustedRootPath -and (Test-Path -LiteralPath $SameSubjectTrustedRootPath)) {
        Remove-Item -LiteralPath $SameSubjectTrustedRootPath -Force
    }
    if ($null -ne $ExpiredTrustedRootPath -and (Test-Path -LiteralPath $ExpiredTrustedRootPath)) {
        Remove-Item -LiteralPath $ExpiredTrustedRootPath -Force
    }
    Remove-TestCertificate -Certificate $SigningCertificate -StoreRoot "Cert:\CurrentUser\My"
    Remove-TestCertificate -Certificate $SameSubjectCertificate -StoreRoot "Cert:\CurrentUser\My"
    Remove-TestCertificate -Certificate $ExpiredCertificate -StoreRoot "Cert:\CurrentUser\My"
    Remove-TestCertificate -Certificate $UntrustedCertificate -StoreRoot "Cert:\CurrentUser\My"
    if (Test-Path -LiteralPath $TemporaryRoot) {
        Remove-SafeOwnedTree `
            -Path $TemporaryRoot `
            -OwnerDirectory $TemporaryParent `
            -Description "Signing test directory"
    }
}
