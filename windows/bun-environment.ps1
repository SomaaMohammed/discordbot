#Requires -Version 7.0

function Enter-BunBuildEnvironment {
    $Snapshot = [ordered]@{}
    foreach ($Variable in Get-ChildItem Env:) {
        if (
            $Variable.Name.StartsWith("BUN_", [System.StringComparison]::OrdinalIgnoreCase) -or
            $Variable.Name.Equals("NODE_OPTIONS", [System.StringComparison]::OrdinalIgnoreCase)
        ) {
            $Snapshot[$Variable.Name] = [string]$Variable.Value
            [System.Environment]::SetEnvironmentVariable(
                $Variable.Name,
                $null,
                [System.EnvironmentVariableTarget]::Process
            )
        }
    }
    return $Snapshot
}

function Exit-BunBuildEnvironment {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Snapshot)

    foreach ($Variable in Get-ChildItem Env:) {
        if (
            $Variable.Name.StartsWith("BUN_", [System.StringComparison]::OrdinalIgnoreCase) -or
            $Variable.Name.Equals("NODE_OPTIONS", [System.StringComparison]::OrdinalIgnoreCase)
        ) {
            [System.Environment]::SetEnvironmentVariable(
                $Variable.Name,
                $null,
                [System.EnvironmentVariableTarget]::Process
            )
        }
    }
    foreach ($Entry in $Snapshot.GetEnumerator()) {
        [System.Environment]::SetEnvironmentVariable(
            [string]$Entry.Key,
            [string]$Entry.Value,
            [System.EnvironmentVariableTarget]::Process
        )
    }
}
