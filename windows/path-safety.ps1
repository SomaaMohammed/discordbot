#Requires -Version 7.0

function Get-NormalizedFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $Resolved = [System.IO.Path]::GetFullPath($Path)
    $Root = [System.IO.Path]::GetPathRoot($Resolved)
    if ([string]::IsNullOrEmpty($Root)) {
        throw "Path has no canonical root: $Resolved"
    }
    $Trimmed = $Resolved.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if ($Trimmed -eq $Root.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )) {
        return $Root
    }
    return $Trimmed
}

function Assert-PathHasNoReparsePoint {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Description = "Path"
    )

    $Resolved = Get-NormalizedFullPath -Path $Path
    $Root = [System.IO.Path]::GetPathRoot($Resolved)
    $Current = $Root
    $RootItem = Get-Item -LiteralPath $Root -Force -ErrorAction SilentlyContinue
    if (
        $null -ne $RootItem -and
        ($RootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    ) {
        throw "$Description must not traverse a reparse point: $Root"
    }

    $Relative = $Resolved.Substring($Root.Length)
    $Components = $Relative.Split(
        [char[]]@(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        ),
        [System.StringSplitOptions]::RemoveEmptyEntries
    )
    foreach ($Component in $Components) {
        $Current = Join-Path $Current $Component
        $Item = Get-Item -LiteralPath $Current -Force -ErrorAction SilentlyContinue
        if (
            $null -ne $Item -and
            ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        ) {
            throw "$Description must not traverse a reparse point: $Current"
        }
    }
    return $Resolved
}

function Assert-PathInsideDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$OwnerDirectory,
        [string]$Description = "Path"
    )

    $ResolvedOwner = Get-NormalizedFullPath -Path $OwnerDirectory
    $ResolvedPath = Get-NormalizedFullPath -Path $Path
    $OwnerPrefix = $ResolvedOwner.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $ResolvedPath.StartsWith(
        $OwnerPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "$Description is outside its verified owner directory: $ResolvedPath"
    }
    return $ResolvedPath
}

function Assert-PathTreeHasNoReparsePoint {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Description = "Directory tree"
    )

    $Resolved = Assert-PathHasNoReparsePoint -Path $Path -Description $Description
    if (-not (Test-Path -LiteralPath $Resolved -PathType Container)) {
        return $Resolved
    }
    foreach ($Entry in Get-ChildItem -LiteralPath $Resolved -Force) {
        if (($Entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Description contains a reparse point: $($Entry.FullName)"
        }
        if ($Entry.PSIsContainer) {
            [void](Assert-PathTreeHasNoReparsePoint -Path $Entry.FullName -Description $Description)
        }
    }
    return $Resolved
}

function Initialize-SafeDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Description = "Directory"
    )

    $Resolved = Assert-PathHasNoReparsePoint -Path $Path -Description $Description
    [void][System.IO.Directory]::CreateDirectory($Resolved)
    [void](Assert-PathHasNoReparsePoint -Path $Resolved -Description $Description)
    return $Resolved
}

function Remove-SafeOwnedTree {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$OwnerDirectory,
        [string]$Description = "Private directory tree"
    )

    $ResolvedOwner = Assert-PathHasNoReparsePoint -Path $OwnerDirectory -Description "$Description owner"
    $ResolvedPath = Assert-PathInsideDirectory -Path $Path -OwnerDirectory $ResolvedOwner -Description $Description
    if (-not (Test-Path -LiteralPath $ResolvedPath)) {
        return
    }
    [void](Assert-PathTreeHasNoReparsePoint -Path $ResolvedPath -Description $Description)
    [void](Assert-PathHasNoReparsePoint -Path $ResolvedOwner -Description "$Description owner")
    [void](Assert-PathTreeHasNoReparsePoint -Path $ResolvedPath -Description $Description)
    [System.IO.Directory]::Delete($ResolvedPath, $true)
}

function Remove-SafeOwnedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$OwnerDirectory,
        [string]$Description = "Private file"
    )

    $ResolvedOwner = Assert-PathHasNoReparsePoint -Path $OwnerDirectory -Description "$Description owner"
    $ResolvedPath = Assert-PathInsideDirectory -Path $Path -OwnerDirectory $ResolvedOwner -Description $Description
    if (-not (Test-Path -LiteralPath $ResolvedPath)) {
        return
    }
    [void](Assert-PathHasNoReparsePoint -Path $ResolvedPath -Description $Description)
    [void](Assert-PathHasNoReparsePoint -Path $ResolvedOwner -Description "$Description owner")
    [void](Assert-PathHasNoReparsePoint -Path $ResolvedPath -Description $Description)
    [System.IO.File]::Delete($ResolvedPath)
}
