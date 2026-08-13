[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$WindowsDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$PowerShellFiles = @(
    Get-ChildItem -LiteralPath $WindowsDirectory -Filter "*.ps1" -Recurse -File |
        Where-Object {
            $Relative = $_.FullName.Substring($WindowsDirectory.Length).TrimStart("\", "/").Replace("\", "/")
            $Relative -notmatch "^(?:\.cache|\.work)(?:/|$)"
        } |
        Sort-Object -Property FullName
)
$Failures = New-Object System.Collections.Generic.List[string]

foreach ($File in $PowerShellFiles) {
    $Tokens = $null
    $ParseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $File.FullName,
        [ref]$Tokens,
        [ref]$ParseErrors
    ) | Out-Null
    foreach ($ParseError in @($ParseErrors)) {
        $Relative = $File.FullName.Substring($WindowsDirectory.Length).TrimStart("\", "/").Replace("\", "/")
        $Failures.Add(
            "${Relative}:$($ParseError.Extent.StartLineNumber):$($ParseError.Extent.StartColumnNumber): $($ParseError.Message)"
        )
    }
}

if ($Failures.Count -gt 0) {
    throw "PowerShell parser failures:`n- $($Failures -join "`n- ")"
}

Write-Host "PowerShell parser check passed for $($PowerShellFiles.Count) release scripts."
