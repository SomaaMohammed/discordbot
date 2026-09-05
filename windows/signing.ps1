#Requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Initialize-ReleaseSigning {
    [CmdletBinding()]
    param(
        [switch]$AllowUnsignedDevelopment,
        [string]$CertificateThumbprint,
        [string]$PfxPath,
        [switch]$MachineCertificateStore,
        [string]$ExpectedPublisher,
        [string]$TimestampUrl,
        [string]$SignToolPath
    )

    if ($AllowUnsignedDevelopment) {
        if (
            -not [string]::IsNullOrWhiteSpace($CertificateThumbprint) -or
            -not [string]::IsNullOrWhiteSpace($PfxPath) -or
            -not [string]::IsNullOrWhiteSpace($ExpectedPublisher)
        ) {
            throw "Unsigned development mode cannot be combined with signing certificate or publisher options."
        }
        return [pscustomobject]@{
            Required = $false
            Mode = "development-unsigned"
            Subject = "(unsigned)"
            Thumbprint = "(none)"
            TimestampStatus = "not-applicable"
            SignatureStatus = "unsigned"
            SignTool = $null
            MachineStore = $false
            ImportedCertificatePaths = @()
        }
    }

    $HasThumbprint = -not [string]::IsNullOrWhiteSpace($CertificateThumbprint)
    $HasPfx = -not [string]::IsNullOrWhiteSpace($PfxPath)
    if ($HasThumbprint -eq $HasPfx) {
        throw "Production signing requires exactly one of -SigningCertificateThumbprint or -SigningPfxPath. Use -AllowUnsignedDevelopment only for a clearly labeled local development build."
    }
    if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
        throw "Production signing requires -ExpectedPublisher."
    }
    $Timestamp = $null
    if (
        [string]::IsNullOrWhiteSpace($TimestampUrl) -or
        -not [System.Uri]::TryCreate($TimestampUrl, [System.UriKind]::Absolute, [ref]$Timestamp) -or
        $Timestamp.Scheme -notin @("http", "https")
    ) {
        throw "Production signing requires an absolute HTTP(S) timestamp URL."
    }

    $ResolvedSignTool = if ([string]::IsNullOrWhiteSpace($SignToolPath)) {
        $Command = Get-Command signtool.exe -CommandType Application -ErrorAction Stop
        [System.IO.Path]::GetFullPath($Command.Source)
    }
    else {
        [System.IO.Path]::GetFullPath($SignToolPath)
    }
    if (-not (Test-Path -LiteralPath $ResolvedSignTool -PathType Leaf)) {
        throw "The configured signtool.exe does not exist."
    }

    $StoreLocation = if ($MachineCertificateStore) { "LocalMachine" } else { "CurrentUser" }
    $StoreRoot = "Cert:\$StoreLocation\My"
    [string[]]$ImportedCertificatePaths = @()
    $Certificate = $null
    try {
        if ($HasPfx) {
            if ($MachineCertificateStore) {
                throw "PFX import is confined to the current-user certificate store. Import a machine certificate externally and select it by thumbprint instead."
            }
            $ResolvedPfx = [System.IO.Path]::GetFullPath($PfxPath)
            if (-not (Test-Path -LiteralPath $ResolvedPfx -PathType Leaf)) {
                throw "The configured signing PFX does not exist."
            }
            $PfxAttributes = [System.IO.File]::GetAttributes($ResolvedPfx)
            if (($PfxAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "The signing PFX must not be a reparse point."
            }
            $PasswordValue = [System.Environment]::GetEnvironmentVariable(
                "SUPERIOR_SIGNING_PFX_PASSWORD",
                "Process"
            )
            if ([string]::IsNullOrEmpty($PasswordValue)) {
                throw "SUPERIOR_SIGNING_PFX_PASSWORD must be supplied through protected external configuration."
            }
            $ExistingThumbprints = @{}
            Get-ChildItem -LiteralPath $StoreRoot | ForEach-Object {
                $ExistingThumbprints[$_.Thumbprint.ToUpperInvariant()] = $true
            }
            $SecurePassword = ConvertTo-SecureString -String $PasswordValue -AsPlainText -Force
            [System.Environment]::SetEnvironmentVariable(
                "SUPERIOR_SIGNING_PFX_PASSWORD",
                $null,
                "Process"
            )
            $PasswordValue = $null
            $PfxData = Get-PfxData -FilePath $ResolvedPfx -Password $SecurePassword
            foreach ($PfxCertificate in @($PfxData.EndEntityCertificates)) {
                if ($ExistingThumbprints.ContainsKey($PfxCertificate.Thumbprint.ToUpperInvariant())) {
                    throw "A certificate from the signing PFX already exists in the current-user personal store. Select that certificate by thumbprint or remove it explicitly before importing the PFX."
                }
            }
            $Imported = @(Import-PfxCertificate -FilePath $ResolvedPfx -CertStoreLocation $StoreRoot -Password $SecurePassword -Exportable:$false)
            $NewCertificates = @(
                $Imported | Where-Object {
                    -not $ExistingThumbprints.ContainsKey($_.Thumbprint.ToUpperInvariant())
                }
            )
            $ImportedCertificatePaths = @(
                $NewCertificates | ForEach-Object {
                    "$StoreRoot\$($_.Thumbprint)"
                }
            )
            $Candidates = @($Imported | Where-Object { $_.HasPrivateKey })
            if ($Candidates.Count -ne 1) {
                throw "The PFX must contain exactly one code-signing certificate with a private key."
            }
            $Certificate = $Candidates[0]
        }
        else {
            $NormalizedThumbprint = ($CertificateThumbprint -replace "\s", "").ToUpperInvariant()
            if ($NormalizedThumbprint -notmatch "^[A-F0-9]{40}$") {
                throw "The signing certificate thumbprint must be a 40-character SHA-1 hexadecimal value."
            }
            $CertificatePath = "$StoreRoot\$NormalizedThumbprint"
            if (-not (Test-Path -LiteralPath $CertificatePath)) {
                throw "The configured signing certificate was not found in $StoreRoot."
            }
            $Certificate = Get-Item -LiteralPath $CertificatePath
        }

        if (-not $Certificate.HasPrivateKey) {
            throw "The configured signing certificate has no accessible private key."
        }
        if (-not [string]::Equals($Certificate.Subject, $ExpectedPublisher, [System.StringComparison]::Ordinal)) {
            throw "The signing certificate subject does not exactly match -ExpectedPublisher."
        }
        $Now = [System.DateTime]::UtcNow
        if ($Now -lt $Certificate.NotBefore.ToUniversalTime() -or $Now -gt $Certificate.NotAfter.ToUniversalTime()) {
            throw "The signing certificate is not currently valid."
        }

        return [pscustomobject]@{
            Required = $true
            Mode = "production-signed"
            Subject = $Certificate.Subject
            Thumbprint = $Certificate.Thumbprint.ToUpperInvariant()
            TimestampUrl = $Timestamp.AbsoluteUri
            TimestampStatus = "required"
            SignatureStatus = "pending"
            SignTool = $ResolvedSignTool
            MachineStore = [bool]$MachineCertificateStore
            ImportedCertificatePaths = $ImportedCertificatePaths
        }
    }
    catch {
        foreach ($CertificatePath in $ImportedCertificatePaths) {
            if (Test-Path -LiteralPath $CertificatePath) {
                Remove-Item -LiteralPath $CertificatePath -Force
            }
        }
        throw
    }
}

function Invoke-ReleaseSignature {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][string]$FilePath
    )

    $ResolvedFile = [System.IO.Path]::GetFullPath($FilePath)
    if (-not (Test-Path -LiteralPath $ResolvedFile -PathType Leaf)) {
        throw "Cannot sign a missing release binary."
    }
    if (-not $Context.Required) {
        $Signature = Get-AuthenticodeSignature -LiteralPath $ResolvedFile
        if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
            throw "Unsigned development mode refuses an unexpectedly signed release binary."
        }
        return
    }

    [string[]]$Arguments = @(
        "sign",
        "/fd", "SHA256",
        "/td", "SHA256",
        "/tr", $Context.TimestampUrl,
        "/sha1", $Context.Thumbprint
    )
    if ($Context.MachineStore) {
        $Arguments += "/sm"
    }
    $Arguments += $ResolvedFile
    & $Context.SignTool @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "signtool.exe failed to sign a release binary with exit code $LASTEXITCODE."
    }
    Confirm-ReleaseSignature -Context $Context -FilePath $ResolvedFile
}

function Confirm-ReleaseSignature {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][string]$FilePath
    )

    $ResolvedFile = [System.IO.Path]::GetFullPath($FilePath)
    $Signature = Get-AuthenticodeSignature -LiteralPath $ResolvedFile
    if (-not $Context.Required) {
        if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
            throw "Unsigned development release verification found an unexpected signature."
        }
        return
    }
    if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Authenticode verification failed with status $($Signature.Status)."
    }
    if ($null -eq $Signature.SignerCertificate) {
        throw "Authenticode verification did not return a signer certificate."
    }
    if (
        -not [string]::Equals(
            $Signature.SignerCertificate.Subject,
            $Context.Subject,
            [System.StringComparison]::Ordinal
        ) -or
        $Signature.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $Context.Thumbprint
    ) {
        throw "The release binary signer does not match the configured signing identity."
    }
    if ($null -eq $Signature.TimeStamperCertificate) {
        throw "The release binary has no trusted Authenticode timestamp."
    }
    & $Context.SignTool verify /pa /all $ResolvedFile
    if ($LASTEXITCODE -ne 0) {
        throw "signtool.exe rejected a signed release binary with exit code $LASTEXITCODE."
    }
    $Context.TimestampStatus = "present-and-valid"
    $Context.SignatureStatus = "valid"
}

function Close-ReleaseSigning {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Context)

    foreach ($CertificatePath in @($Context.ImportedCertificatePaths)) {
        if (Test-Path -LiteralPath $CertificatePath) {
            Remove-Item -LiteralPath $CertificatePath -Force
        }
    }
}
