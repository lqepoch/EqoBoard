#requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:Phase = 'preflight'

function Fail([string]$Message) {
    throw [InvalidOperationException]::new($Message)
}

function Get-CanonicalPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { Fail 'A required path is empty.' }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\', [StringComparison]::Ordinal)) {
        Fail 'UNC paths are not accepted by the native local launcher.'
    }
    return $full.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-NoReparsePath([string]$Path, [switch]$MustExist) {
    $full = Get-CanonicalPath $Path
    $root = [IO.Path]::GetPathRoot($full)
    if (-not $root -or $root.StartsWith('\\', [StringComparison]::Ordinal)) {
        Fail 'Only local Windows paths are accepted.'
    }
    $current = $root
    foreach ($segment in ($full.Substring($root.Length) -split '[\\/]')) {
        if (-not $segment) { continue }
        $current = Join-Path $current $segment
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail 'A path component is a reparse point; refusing to follow it.'
            }
        } elseif ($MustExist) {
            Fail 'A required path does not exist.'
        }
    }
    if ($MustExist -and -not (Test-Path -LiteralPath $full)) { Fail 'A required path does not exist.' }
    return $full
}

function Get-PrivateSids {
    return @{
        User = [Security.Principal.WindowsIdentity]::GetCurrent().User
        System = [Security.Principal.SecurityIdentifier]::new(
            [Security.Principal.WellKnownSidType]::LocalSystemSid, $null
        )
    }
}

function Assert-PrivateAcl([string]$Path, [switch]$Directory) {
    $full = Assert-NoReparsePath -Path $Path -MustExist
    $acl = Get-Acl -LiteralPath $full
    if (-not $acl.AreAccessRulesProtected) { Fail 'Native local state has inherited ACL entries.' }
    $sids = Get-PrivateSids
    $expected = @($sids.User.Value, $sids.System.Value)
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) { Fail 'Native local state has unexpected ACL entries.' }
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        if ($sid -notin $expected -or -not $seen.Add($sid)) { Fail 'Native local state grants unexpected access.' }
        if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
            Fail 'Native local state has an unexpected access rule.'
        }
        $rights = [Security.AccessControl.FileSystemRights]$rule.FileSystemRights
        if (($rights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
            [Security.AccessControl.FileSystemRights]::FullControl) {
            Fail 'Native local state is missing a required full-control ACL.'
        }
        if ($Directory) {
            $required = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                [Security.AccessControl.InheritanceFlags]::ObjectInherit
            if ($rule.InheritanceFlags -ne $required -or
                $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
                Fail 'Native local state does not protect child paths.'
            }
        } elseif ($rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None) {
            Fail 'Native local state file has an unexpected inheritable ACL.'
        }
    }
    if ($seen.Count -ne 2) { Fail 'Native local state is missing a required ACL identity.' }
}

function Read-PrivateJson([string]$Path) {
    Assert-PrivateAcl -Path $Path
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Normalize-Record($Record, [string]$ExpectedRole, [string]$CandidateSha, [string]$PackageRoot, [string]$DataRoot) {
    $processId = 0
    if ($Record.role -cne $ExpectedRole -or
        -not [int]::TryParse([string]$Record.processId, [ref]$processId) -or $processId -lt 1 -or
        $Record.startTimeUtcTicks -cnotmatch '^[0-9]+$' -or
        $Record.candidateSha -cne $CandidateSha -or
        [string]::IsNullOrWhiteSpace([string]$Record.executablePath) -or
        [string]::IsNullOrWhiteSpace([string]$Record.workingDirectory)) {
        Fail 'A native local process record is invalid.'
    }
    $executable = Assert-NoReparsePath -Path ([string]$Record.executablePath) -MustExist
    $working = Assert-NoReparsePath -Path ([string]$Record.workingDirectory) -MustExist
    $expectedWorking = if ($ExpectedRole -ceq 'gateway') {
        Join-Path $PackageRoot 'gateway'
    } else {
        Join-Path $PackageRoot 'web'
    }
    if ($working -cne [IO.Path]::GetFullPath($expectedWorking)) {
        Fail 'A native local process record points outside its runtime working directory.'
    }
    if ($ExpectedRole -ceq 'gateway') {
        $expectedExecutable = Join-Path $PackageRoot 'gateway/eqo-gateway.exe'
        if ($executable -cne [IO.Path]::GetFullPath($expectedExecutable)) {
            Fail 'Gateway process identity does not match the recorded runtime package.'
        }
    } elseif ([IO.Path]::GetFileName($executable) -cne 'node.exe') {
        Fail 'Web process identity is not the validated Node executable.'
    }
    foreach ($logName in @('stdoutLog', 'stderrLog')) {
        $logPath = Assert-NoReparsePath -Path ([string]$Record.$logName) -MustExist
        $prefix = $DataRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $logPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetExtension($logPath) -cne '.log') {
            Fail 'A process log record points outside the private native-local directory.'
        }
        Assert-PrivateAcl -Path $logPath
    }
    return [pscustomobject]@{
        role = $ExpectedRole
        processId = $processId
        startTimeUtcTicks = [string]$Record.startTimeUtcTicks
        executablePath = $executable
        workingDirectory = $working
        candidateSha = [string]$Record.candidateSha
        stdoutLog = [string]$Record.stdoutLog
        stderrLog = [string]$Record.stderrLog
    }
}

function Assert-SameIdentity($Left, $Right) {
    if ($Left.processId -ne $Right.processId -or
        $Left.startTimeUtcTicks -cne $Right.startTimeUtcTicks -or
        $Left.executablePath -cne $Right.executablePath -or
        $Left.workingDirectory -cne $Right.workingDirectory -or
        $Left.candidateSha -cne $Right.candidateSha) {
        Fail 'The process and aggregate state records do not agree; refusing to stop anything.'
    }
}

function Stop-VerifiedProcess($Record) {
    $process = $null
    try { $process = [Diagnostics.Process]::GetProcessById($Record.processId) }
    catch [ArgumentException] { return $true }
    if ($process.HasExited) { return $true }

    $actualStart = $process.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    if ($actualStart -cne $Record.startTimeUtcTicks) {
        Fail "PID $($Record.processId) has been reused; refusing to stop it."
    }
    $actualPath = $process.MainModule.FileName
    if (-not $actualPath -or [IO.Path]::GetFullPath($actualPath) -cne $Record.executablePath) {
        Fail "PID $($Record.processId) no longer matches the recorded executable; refusing to stop it."
    }
    $process.Kill($true)
    if (-not $process.WaitForExit(15000)) { Fail "PID $($Record.processId) did not stop within the bounded timeout." }
    return $true
}

try {
    if (-not $IsWindows) { Fail 'The native local launcher supports Windows only.' }
    $script:Phase = 'validate-private-state'
    $repo = Assert-NoReparsePath -Path $RepoRoot -MustExist
    if (-not (Get-Item -LiteralPath $repo).PSIsContainer) { Fail 'RepoRoot must be a directory.' }
    $dataRoot = Join-Path $repo 'data/native-local'
    if (-not (Test-Path -LiteralPath $dataRoot)) {
        Write-Output 'No native local instance state exists.'
        exit 0
    }
    $dataRoot = Assert-NoReparsePath -Path $dataRoot -MustExist
    Assert-PrivateAcl -Path $dataRoot -Directory
    $statePath = Join-Path $dataRoot 'state.json'
    $pidDir = Join-Path $dataRoot 'pid'
    if (Test-Path -LiteralPath $pidDir) { Assert-PrivateAcl -Path $pidDir -Directory }

    $state = $null
    if (Test-Path -LiteralPath $statePath) { $state = Read-PrivateJson $statePath }
    if ($state) {
        if ($state.schemaVersion -ne 1 -or
            $state.repoRoot -cne $repo -or
            $state.candidateSha -cnotmatch '^[0-9a-f]{40}$') {
            Fail 'The native local state file does not belong to this repo root.'
        }
        $packageRoot = Assert-NoReparsePath -Path ([string]$state.packagePath) -MustExist
        if (-not (Get-Item -LiteralPath $packageRoot).PSIsContainer) { Fail 'Recorded runtime package is unavailable.' }
    } else {
        $packageRoot = ''
    }

    $records = @{}
    $script:Phase = 'validate-process-records'
    if ($state) {
        foreach ($raw in @($state.processes)) {
            $role = [string]$raw.role
            if ($role -notin @('gateway', 'web') -or $records.ContainsKey($role)) {
                Fail 'The native local state contains duplicate or unknown process roles.'
            }
            $records[$role] = Normalize-Record -Record $raw -ExpectedRole $role `
                -CandidateSha ([string]$state.candidateSha) -PackageRoot $packageRoot -DataRoot $dataRoot
        }
    }
    if (Test-Path -LiteralPath $pidDir) {
        foreach ($file in Get-ChildItem -LiteralPath $pidDir -Filter '*.json' -File -Force) {
            Assert-PrivateAcl -Path $file.FullName
            $role = [IO.Path]::GetFileNameWithoutExtension($file.Name)
            if ($role -notin @('gateway', 'web')) { Fail 'The native local PID directory contains an unknown record.' }
            if (-not $state) { Fail 'A PID record exists without its aggregate state; refusing automatic recovery.' }
            $raw = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            $pidRecord = Normalize-Record -Record $raw -ExpectedRole $role `
                -CandidateSha ([string]$state.candidateSha) -PackageRoot $packageRoot -DataRoot $dataRoot
            if ($records.ContainsKey($role)) {
                Assert-SameIdentity -Left $records[$role] -Right $pidRecord
            } else {
                $records[$role] = $pidRecord
            }
        }
    }

    $stopFailures = [System.Collections.Generic.List[string]]::new()
    $script:Phase = 'stop-verified-processes'
    foreach ($role in @('gateway', 'web')) {
        if ($records.ContainsKey($role)) {
            try { [void](Stop-VerifiedProcess $records[$role]) }
            catch { $stopFailures.Add($role) }
        }
    }
    if ($stopFailures.Count -gt 0) {
        Fail ('Could not safely stop recorded local process roles: ' + ($stopFailures -join ', ') + '. State files are retained for recovery.')
    }
    $script:Phase = 'remove-stopped-process-records'
    if (Test-Path -LiteralPath $pidDir) {
        foreach ($file in Get-ChildItem -LiteralPath $pidDir -Filter '*.json' -File -Force) {
            Remove-Item -LiteralPath $file.FullName -Force
        }
    }
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
    Write-Output 'Native local Web, Gateway and their owned child processes have stopped; local data and logs were retained.'
} catch {
    $exceptionType = $_.Exception.GetType().FullName
    $line = $_.InvocationInfo.ScriptLineNumber
    Write-Error "Native local stop failed closed during '$script:Phase' (type=$exceptionType, line=$line). Review private state under data/native-local; no unverified process was stopped."
    exit 1
}
