#Requires -Version 7.0

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$WindowsDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$Directories = New-Object System.Collections.Generic.Stack[string]
$Directories.Push($WindowsDirectory)
$PowerShellFiles = New-Object System.Collections.Generic.List[System.IO.FileInfo]
while ($Directories.Count -gt 0) {
    $Directory = $Directories.Pop()
    foreach ($File in Get-ChildItem -LiteralPath $Directory -Filter "*.ps1" -File) {
        $PowerShellFiles.Add($File)
    }
    foreach ($Child in Get-ChildItem -LiteralPath $Directory -Directory) {
        if (
            $Directory -eq $WindowsDirectory -and
            $Child.Name -in @(".cache", ".work")
        ) {
            continue
        }
        if (($Child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "PowerShell source traversal refuses a reparse point: $($Child.FullName)"
        }
        $Directories.Push($Child.FullName)
    }
}
$PowerShellFiles = @($PowerShellFiles | Sort-Object -Property FullName)
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
