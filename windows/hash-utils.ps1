#Requires -Version 7.0

function Get-Sha256Hex {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $ResolvedPath = [System.IO.Path]::GetFullPath($LiteralPath)
    $Stream = [System.IO.File]::Open(
        $ResolvedPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        $Hasher = [System.Security.Cryptography.SHA256]::Create()
        try {
            $Bytes = $Hasher.ComputeHash($Stream)
        }
        finally {
            $Hasher.Dispose()
        }
    }
    finally {
        $Stream.Dispose()
    }

    return [System.BitConverter]::ToString($Bytes).Replace("-", "").ToLowerInvariant()
}
