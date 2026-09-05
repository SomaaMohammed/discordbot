#Requires -Version 7.0

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "path-safety.ps1")

$TemporaryRoot = Join-Path (
    [System.IO.Path]::GetTempPath()
) ("Superior Bot path safety " + [System.Guid]::NewGuid().ToString("N"))
$OwnerRoot = Join-Path $TemporaryRoot "owner"
$OutsideRoot = Join-Path $TemporaryRoot "outside"
$Junction = Join-Path $OwnerRoot "redirect"
$Sentinel = Join-Path $OutsideRoot "victim\sentinel.txt"

try {
    [void](Initialize-SafeDirectory -Path $OwnerRoot -Description "Path-safety owner")
    [void](Initialize-SafeDirectory -Path (Split-Path -Parent $Sentinel) -Description "Outside sentinel directory")
    [System.IO.File]::WriteAllText($Sentinel, "must survive")
    New-Item -ItemType Junction -Path $Junction -Target $OutsideRoot | Out-Null

    $Refused = $false
    try {
        Remove-SafeOwnedTree `
            -Path (Join-Path $Junction "victim") `
            -OwnerDirectory $OwnerRoot `
            -Description "Synthetic redirected work tree"
    }
    catch {
        if (-not $_.Exception.Message.Contains("reparse point")) {
            throw
        }
        $Refused = $true
    }
    if (-not $Refused) {
        throw "Recursive cleanup accepted a path traversing a junction."
    }
    if (-not (Test-Path -LiteralPath $Sentinel -PathType Leaf)) {
        throw "Recursive cleanup escaped its owner and removed the outside sentinel."
    }

    $JunctionItem = Get-Item -LiteralPath $Junction -Force
    if (($JunctionItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw "The synthetic junction is not a reparse point."
    }
    [System.IO.Directory]::Delete($Junction, $false)

    $NormalTree = Join-Path $OwnerRoot "normal\child"
    [void](Initialize-SafeDirectory -Path $NormalTree -Description "Normal owned tree")
    [System.IO.File]::WriteAllText((Join-Path $NormalTree "sentinel.txt"), "delete me")
    Remove-SafeOwnedTree `
        -Path (Join-Path $OwnerRoot "normal") `
        -OwnerDirectory $OwnerRoot `
        -Description "Normal owned tree"
    if (Test-Path -LiteralPath (Join-Path $OwnerRoot "normal")) {
        throw "Verified direct owned-tree cleanup did not remove its target."
    }

    Write-Host "Path containment, junction refusal, outside-sentinel preservation, and direct cleanup checks passed."
}
finally {
    if (Test-Path -LiteralPath $Junction) {
        $JunctionItem = Get-Item -LiteralPath $Junction -Force
        if (($JunctionItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
            throw "Cleanup refused a non-junction synthetic path: $Junction"
        }
        [System.IO.Directory]::Delete($Junction, $false)
    }
    if (Test-Path -LiteralPath $TemporaryRoot) {
        Remove-SafeOwnedTree `
            -Path $TemporaryRoot `
            -OwnerDirectory ([System.IO.Path]::GetTempPath()) `
            -Description "Path-safety test directory"
    }
}
