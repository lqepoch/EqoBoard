param(
    [Parameter(Mandatory)][string]$PackagePath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$CandidateSha
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true') { throw 'Actions-only runtime acceptance' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$fixtureRoot = Join-Path $env:RUNNER_TEMP 'native-local-smoke'
if (Test-Path $fixtureRoot) { throw 'Smoke fixture path already exists' }
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
function Set-SmokePrivateAcl([string]$Path) {
    $sections = [Security.AccessControl.AccessControlSections]::Access
    if (Test-Path -LiteralPath $Path -PathType Container) {
        $item = [IO.DirectoryInfo]::new($Path)
        $acl = [IO.FileSystemAclExtensions]::GetAccessControl($item, $sections)
    } else {
        $item = [IO.FileInfo]::new($Path)
        $acl = [IO.FileSystemAclExtensions]::GetAccessControl($item, $sections)
    }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
        [void]$acl.RemoveAccessRuleSpecific($rule)
    }
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [Security.Principal.SecurityIdentifier]::new(
        [Security.Principal.WellKnownSidType]::LocalSystemSid, $null
    )
    $inheritance = if (Test-Path -LiteralPath $Path -PathType Container) {
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($identity in @($owner, $system)) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $identity,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        ))
    }
    if ($item -is [IO.DirectoryInfo]) {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$item, $acl)
    } else {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]$item, $acl)
    }
}

function Assert-RecordedProcess(
    [int]$ProcessId,
    [string]$ExpectedStartTicks,
    [string]$ExpectedExecutablePath
) {
    $identityDeadline = [DateTime]::UtcNow.AddSeconds(5)
    $process = $null
    $executablePath = $null
    while ([DateTime]::UtcNow -lt $identityDeadline) {
        $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if (-not $process -or $process.HasExited) {
            throw 'The recorded Gateway process exited before its identity could be verified.'
        }
        $module = $process.MainModule
        if ($module) {
            $path = [string]$module.FileName
            if (-not [string]::IsNullOrWhiteSpace($path)) {
                $executablePath = [IO.Path]::GetFullPath($path)
                break
            }
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $executablePath) {
        throw 'Gateway executable identity remained unavailable after the startup deadline.'
    }
    $startTicks = $process.StartTime.ToUniversalTime().Ticks.ToString(
        [Globalization.CultureInfo]::InvariantCulture
    )
    if ($startTicks -cne $ExpectedStartTicks -or
        -not [String]::Equals(
            $executablePath,
            $ExpectedExecutablePath,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'The recorded Gateway process identity changed.'
    }
    return $process
}

function Assert-OwnedLoopbackListener([int]$Port, [int]$ProcessId) {
    $listeners = @(
        Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    )
    if ($listeners.Count -eq 0) { throw "No listener owns expected local port $Port." }
    foreach ($listener in $listeners) {
        if ($listener.LocalAddress -cne '127.0.0.1' -or $listener.OwningProcess -ne $ProcessId) {
            throw "Port $Port is not exclusively bound to its recorded loopback process."
        }
    }
}

function Get-AclFingerprint([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    return [Convert]::ToBase64String($acl.GetSecurityDescriptorBinaryForm())
}

function Assert-FileBytesEqual([string]$Path, [byte[]]$ExpectedBytes) {
    $actual = [IO.File]::ReadAllBytes($Path)
    if ([Convert]::ToBase64String($actual) -cne [Convert]::ToBase64String($ExpectedBytes)) {
        throw 'A smoke-test file was not restored byte-for-byte.'
    }
}

function Invoke-StopNativeLocal([string]$FixtureRoot, [int]$TimeoutMilliseconds) {
    $pwshPath = (Get-Command pwsh -ErrorAction Stop).Source
    $stopPath = Join-Path $repo 'tools/stop-native-local.ps1'
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $pwshPath
    $startInfo.WorkingDirectory = $repo
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $stopPath, '-RepoRoot', $FixtureRoot)) {
        [void]$startInfo.ArgumentList.Add($argument)
    }
    $child = [Diagnostics.Process]::Start($startInfo)
    if (-not $child) { throw 'The isolated stop check could not start.' }
    $stdoutTask = $child.StandardOutput.ReadToEndAsync()
    $stderrTask = $child.StandardError.ReadToEndAsync()
    try {
        if (-not $child.WaitForExit($TimeoutMilliseconds)) {
            $child.Kill($true)
            [void]$child.WaitForExit(5000)
            throw 'The isolated stop check exceeded its bounded deadline.'
        }
        [void]$child.WaitForExit()
        [void]$stdoutTask.GetAwaiter().GetResult()
        [void]$stderrTask.GetAwaiter().GetResult()
        return $child.ExitCode
    } finally {
        if (-not $child.HasExited) {
            $child.Kill($true)
            [void]$child.WaitForExit(5000)
        }
        $child.Dispose()
    }
}

function Assert-OriginalServicesRemainRunning($Identities) {
    foreach ($identity in $Identities) {
        [void](Assert-RecordedProcess -ProcessId $identity.ProcessId `
            -ExpectedStartTicks $identity.StartTimeUtcTicks `
            -ExpectedExecutablePath $identity.ExecutablePath)
        Assert-OwnedLoopbackListener -Port $identity.Port -ProcessId $identity.ProcessId
    }
}

function Assert-OriginalServicesStopped($Identities) {
    foreach ($identity in $Identities) {
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        $originalStillRunning = $false
        while ([DateTime]::UtcNow -lt $deadline) {
            $process = $null
            try { $process = [Diagnostics.Process]::GetProcessById($identity.ProcessId) }
            catch [ArgumentException] { break }
            if ($process.HasExited) { break }
            $startTicks = $process.StartTime.ToUniversalTime().Ticks.ToString(
                [Globalization.CultureInfo]::InvariantCulture
            )
            if ($startTicks -cne $identity.StartTimeUtcTicks) { break }
            $path = $process.MainModule.FileName
            if (-not $path) { throw 'Could not verify a stopped service identity.' }
            $path = [IO.Path]::GetFullPath($path)
            if (-not [String]::Equals(
                $path,
                $identity.ExecutablePath,
                [StringComparison]::OrdinalIgnoreCase
            )) { break }
            $originalStillRunning = $true
            Start-Sleep -Milliseconds 100
        }
        if ($originalStillRunning) {
            $process = Get-Process -Id $identity.ProcessId -ErrorAction SilentlyContinue
            if ($process -and -not $process.HasExited) {
                $actualTicks = $process.StartTime.ToUniversalTime().Ticks.ToString(
                    [Globalization.CultureInfo]::InvariantCulture
                )
                if ($actualTicks -ceq $identity.StartTimeUtcTicks) {
                    $actualPath = [IO.Path]::GetFullPath($process.MainModule.FileName)
                    if ([String]::Equals(
                        $actualPath,
                        $identity.ExecutablePath,
                        [StringComparison]::OrdinalIgnoreCase
                    )) { throw 'An original native service identity remained active after stop.' }
                }
            }
        }
    }
}

function Assert-NativeServicesSurviveStartup(
    [string]$FixtureRoot,
    [string]$PackagePath,
    [string]$CandidateSha,
    [string]$ExpectedNodePath
) {
    $dataRoot = Join-Path $FixtureRoot 'data/native-local'
    $statePath = Join-Path $dataRoot 'state.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw 'The aggregate native-local process state is missing.'
    }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $manifestPath = Join-Path $PackagePath 'SHA256SUMS'
    $expectedPackageManifestSha = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($state.schemaVersion -ne 2 -or
        $state.candidateSha -cne $CandidateSha -or
        $state.packageManifestSha256 -cne $expectedPackageManifestSha) {
        throw 'The aggregate state is not bound to the expected runtime package.'
    }

    $expectedExecutables = @{
        gateway = [IO.Path]::GetFullPath((Join-Path $PackagePath 'gateway/eqo-gateway.exe'))
        mdp = [IO.Path]::GetFullPath((Join-Path $PackagePath 'mdp/mdp.exe'))
        web = [IO.Path]::GetFullPath($ExpectedNodePath)
    }
    $expectedPorts = @{ gateway = 8080; mdp = 8088; web = 3000 }
    $identities = [System.Collections.Generic.List[object]]::new()
    $stateProcesses = @($state.processes)
    $expectedRoles = @('gateway', 'mdp', 'web')
    if ($stateProcesses.Count -ne $expectedRoles.Count -or
        @($stateProcesses.role | Where-Object { $_ -notin $expectedRoles }).Count -ne 0 -or
        @($expectedRoles | Where-Object { $_ -notin $stateProcesses.role }).Count -ne 0) {
        throw 'The aggregate state does not contain exactly the three expected service roles.'
    }

    foreach ($role in $expectedRoles) {
        $pidRecordPath = Join-Path $dataRoot "pid/$role.json"
        if (-not (Test-Path -LiteralPath $pidRecordPath -PathType Leaf)) {
            throw "The recorded $role process identity is missing."
        }
        $record = Get-Content -LiteralPath $pidRecordPath -Raw | ConvertFrom-Json
        $processId = 0
        if ($record.role -cne $role -or
            $record.candidateSha -cne $CandidateSha -or
            $record.packageManifestSha256 -cne $expectedPackageManifestSha -or
            -not [int]::TryParse([string]$record.processId, [ref]$processId) -or
            $processId -lt 1 -or
            $record.startTimeUtcTicks -cnotmatch '^[0-9]+$' -or
            [IO.Path]::GetFullPath([string]$record.executablePath) -cne $expectedExecutables[$role]) {
            throw "The recorded $role process identity does not match this package."
        }
        $stateRecord = @($stateProcesses | Where-Object { $_.role -ceq $role })
        if ($stateRecord.Count -ne 1 -or
            [int]$stateRecord[0].processId -ne $processId -or
            $stateRecord[0].startTimeUtcTicks -cne $record.startTimeUtcTicks -or
            $stateRecord[0].executablePath -cne $record.executablePath -or
            $stateRecord[0].packageManifestSha256 -cne $expectedPackageManifestSha) {
            throw "The $role aggregate and PID records do not agree."
        }
        [void](Assert-RecordedProcess -ProcessId $processId `
            -ExpectedStartTicks ([string]$record.startTimeUtcTicks) `
            -ExpectedExecutablePath $expectedExecutables[$role])
        Assert-OwnedLoopbackListener -Port $expectedPorts[$role] -ProcessId $processId
        $identities.Add([pscustomobject]@{
            Role = $role
            ProcessId = $processId
            StartTimeUtcTicks = [string]$record.startTimeUtcTicks
            ExecutablePath = $expectedExecutables[$role]
            Port = $expectedPorts[$role]
        })
    }

    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8088/healthz' -TimeoutSec 3
    if ($health.status -cne 'alive') { throw 'MDP health did not report alive.' }
    $readiness = Invoke-RestMethod -Uri 'http://127.0.0.1:8088/readyz' -TimeoutSec 3
    if ($readiness.status -cne 'ready' -or
        $readiness.market_ready -ne $false -or
        $readiness.market_calendar_configured -ne $false -or
        $readiness.source_entitlement -cne 'unverified') {
        throw 'MDP readiness did not report the expected fail-closed no-calendar state.'
    }
    return @($identities.ToArray())
}

function Assert-FutuWorkerSurvivesStartup(
    [string]$FixtureRoot,
    [string]$PackagePath,
    [string]$ExpectedNodePath,
    [string]$CandidateSha
) {
    $gatewayRecordPath = Join-Path $FixtureRoot 'data/native-local/pid/gateway.json'
    if (-not (Test-Path -LiteralPath $gatewayRecordPath -PathType Leaf)) {
        throw 'The packaged Gateway PID record is missing.'
    }
    $record = Get-Content -LiteralPath $gatewayRecordPath -Raw | ConvertFrom-Json
    $gatewayProcessId = 0
    if ($record.role -cne 'gateway' -or
        $record.candidateSha -cne $CandidateSha -or
        -not [int]::TryParse([string]$record.processId, [ref]$gatewayProcessId) -or
        $gatewayProcessId -lt 1) {
        throw 'The packaged Gateway PID record is invalid.'
    }

    $expectedGatewayPath = [IO.Path]::GetFullPath(
        (Join-Path $PackagePath 'gateway/eqo-gateway.exe')
    )
    $expectedNodePath = [IO.Path]::GetFullPath($ExpectedNodePath)
    $expectedStartTicks = [string]$record.startTimeUtcTicks
    $startupDeadline = [DateTime]::UtcNow.AddSeconds(15)
    $workerId = 0

    while ([DateTime]::UtcNow -lt $startupDeadline -and $workerId -eq 0) {
        [void](Assert-RecordedProcess -ProcessId $gatewayProcessId `
            -ExpectedStartTicks $expectedStartTicks `
            -ExpectedExecutablePath $expectedGatewayPath)

        $children = @(
            Get-CimInstance -ClassName Win32_Process `
                -Filter "ParentProcessId = $gatewayProcessId" `
                -Property ProcessId, ParentProcessId, Name, ExecutablePath `
                -ErrorAction Stop |
                Where-Object { $_.Name -ieq 'node.exe' }
        )
        if ($children.Count -gt 1) { throw 'Gateway has multiple Node.js child processes.' }
        if ($children.Count -eq 1) {
            $childPath = [IO.Path]::GetFullPath([string]$children[0].ExecutablePath)
            if (-not [String]::Equals(
                $childPath,
                $expectedNodePath,
                [StringComparison]::OrdinalIgnoreCase
            )) {
                throw 'The Futu worker executable does not match the official Node.js runtime.'
            }
            $workerId = [int]$children[0].ProcessId
        } else {
            Start-Sleep -Milliseconds 250
        }
    }
    if ($workerId -lt 1) { throw 'The Gateway Futu SDK worker did not start.' }

    $stabilityDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $stabilityDeadline) {
        [void](Assert-RecordedProcess -ProcessId $gatewayProcessId `
            -ExpectedStartTicks $expectedStartTicks `
            -ExpectedExecutablePath $expectedGatewayPath)
        $children = @(
            Get-CimInstance -ClassName Win32_Process `
                -Filter "ParentProcessId = $gatewayProcessId" `
                -Property ProcessId, ParentProcessId, Name, ExecutablePath `
                -ErrorAction Stop |
                Where-Object { $_.Name -ieq 'node.exe' }
        )
        if ($children.Count -ne 1 -or [int]$children[0].ProcessId -ne $workerId) {
            throw 'The Gateway Futu SDK worker exited or was replaced during startup.'
        }
        $childPath = [IO.Path]::GetFullPath([string]$children[0].ExecutablePath)
        if (-not [String]::Equals(
            $childPath,
            $expectedNodePath,
            [StringComparison]::OrdinalIgnoreCase
        )) {
            throw 'The Futu worker executable changed during startup.'
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Host 'Futu SDK worker survived startup check; provider connectivity remains unverified.'
}

Set-SmokePrivateAcl $fixtureRoot
if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'SMOKE_TOKEN_CONTEXT=administrator'
} else {
    Write-Host 'SMOKE_TOKEN_CONTEXT=standard-user'
}
function New-TestSecret { [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant() }
$envPath = Join-Path $fixtureRoot '.env'
@(
    'ALPACA_KEY=NATIVE_LOCAL_PROVIDER_SECRET_SENTINEL_KEY'
    'ALPACA_SECRET=NATIVE_LOCAL_PROVIDER_SECRET_SENTINEL_SECRET'
    'APCA_API_BASE_URL=https://paper-api.alpaca.markets'
    'ALPACA_PAPER_ENDPOINT=https://paper-api.alpaca.markets/v2'
    'EQO_EXECUTION_MODE=disabled'
    'EQO_MARKET_DATA_PROVIDER=futu'
    'EQO_STOCK_SYMBOLS=QQQ,SPY'
    'EQO_MAX_STOCK_SUBSCRIPTIONS=32'
    'FUTU_OPEND_HOST=127.0.0.1'
    'FUTU_OPEND_WEBSOCKET_PORT=12345'
    'FUTU_OPEND_WEBSOCKET_SSL=false'
    'FUTU_OPEND_WEBSOCKET_KEY='
    'EQO_BIND=127.0.0.1:8080'
    'EQO_LOCAL_ACCESS=true'
    'EQO_LOCAL_BIND=127.0.0.1'
    'EQO_BFF_MODE=terminal'
    'EQO_PUBLIC_ORIGIN=http://127.0.0.1:3000'
    'NEXTAUTH_URL=http://127.0.0.1:3000'
    'EQO_RUST_URL=http://127.0.0.1:8080'
    'EQO_MDP_URL=http://127.0.0.1:8088'
    'EQO_LOCAL_CORE_BARS=true'
    "MDP_TERMINAL_JWT_SECRET=$(New-TestSecret)"
    "MDP_RESEARCH_JWT_SECRET=$(New-TestSecret)"
    "EQO_GATEWAY_JWT_SECRET=$(New-TestSecret)"
    "EQO_RESEARCH_JWT_SECRET=$(New-TestSecret)"
    "NEXTAUTH_SECRET=$(New-TestSecret)"
) | Set-Content -LiteralPath $envPath -Encoding utf8NoBOM
Set-SmokePrivateAcl $envPath
$priorAlpacaKey = $env:ALPACA_KEY
$priorAlpacaSecret = $env:ALPACA_SECRET
$priorResearchSecret = $env:EQO_RESEARCH_JWT_SECRET
$manifestPath = Join-Path $PackagePath 'SHA256SUMS'
$webPidPath = Join-Path $fixtureRoot 'data/native-local/pid/web.json'
$manifestBackup = $null
$webPidBackup = $null
$webPidAclFingerprint = $null
$serviceIdentities = @()
try {
    # Inherited provider/research secrets must not reach the terminal Web.
    $env:ALPACA_KEY = 'NATIVE_LOCAL_PARENT_SECRET_SENTINEL_KEY'
    $env:ALPACA_SECRET = 'NATIVE_LOCAL_PARENT_SECRET_SENTINEL_SECRET'
    $env:EQO_RESEARCH_JWT_SECRET = 'NATIVE_LOCAL_PARENT_SECRET_SENTINEL_RESEARCH'
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    & (Join-Path $repo 'tools/start-native-local.ps1') -PackagePath $PackagePath -RepoRoot $fixtureRoot -EnvPath $envPath -NodePath $nodePath -ExpectedCandidateSha $CandidateSha
    if ($LASTEXITCODE) { throw 'Packaged runtime startup failed' }
    $serviceIdentities = @(Assert-NativeServicesSurviveStartup -FixtureRoot $fixtureRoot `
        -PackagePath $PackagePath -CandidateSha $CandidateSha -ExpectedNodePath $nodePath
    )
    Assert-FutuWorkerSurvivesStartup -FixtureRoot $fixtureRoot `
        -PackagePath $PackagePath -ExpectedNodePath $nodePath -CandidateSha $CandidateSha
    $env:E2E_LOCAL_ORIGIN = 'http://127.0.0.1:3000'
    Push-Location (Join-Path $repo 'apps/eqoboard-web')
    try {
        npx playwright test --config playwright.local.config.ts
        if ($LASTEXITCODE) { throw 'Packaged workstation browser acceptance failed' }
    } finally { Pop-Location }

    if ($serviceIdentities.Count -ne 3) {
        throw 'The startup smoke did not retain all three service identities.'
    }

    $manifestBackup = [IO.File]::ReadAllBytes($manifestPath)
    try {
        $invalidManifestLine = [Environment]::NewLine + 'invalid-stop-negative-case' + [Environment]::NewLine
        [IO.File]::AppendAllText(
            $manifestPath,
            $invalidManifestLine,
            [Text.UTF8Encoding]::new($false)
        )
        $stopExitCode = Invoke-StopNativeLocal -FixtureRoot $fixtureRoot -TimeoutMilliseconds 15000
        if ($stopExitCode -eq 0) {
            throw 'The manifest-mismatch stop negative case unexpectedly succeeded.'
        }
        Assert-OriginalServicesRemainRunning $serviceIdentities
        Write-Host 'STOP_NEGATIVE_CASE=manifest_mismatch_rejected'
    } finally {
        [IO.File]::WriteAllBytes($manifestPath, $manifestBackup)
        Assert-FileBytesEqual -Path $manifestPath -ExpectedBytes $manifestBackup
    }

    $webPidBackup = [IO.File]::ReadAllBytes($webPidPath)
    $webPidAclFingerprint = Get-AclFingerprint $webPidPath
    try {
        $webPidText = [Text.UTF8Encoding]::new($false).GetString($webPidBackup)
        $ticksPattern = '"startTimeUtcTicks"\s*:\s*"(?<ticks>[0-9]+)"'
        $ticksMatch = [regex]::Match($webPidText, $ticksPattern)
        if (-not $ticksMatch.Success -or
            [regex]::Matches($webPidText, $ticksPattern).Count -ne 1) {
            throw 'The web PID record does not contain one exact start-time field.'
        }
        $originalTicks = [long]::Parse(
            $ticksMatch.Groups['ticks'].Value,
            [Globalization.CultureInfo]::InvariantCulture
        )
        $replacementTicks = if ($originalTicks -lt [long]::MaxValue) {
            ($originalTicks + 1).ToString([Globalization.CultureInfo]::InvariantCulture)
        } else {
            ($originalTicks - 1).ToString([Globalization.CultureInfo]::InvariantCulture)
        }
        $valueGroup = $ticksMatch.Groups['ticks']
        $mutatedWebPidText = $webPidText.Substring(0, $valueGroup.Index) +
            $replacementTicks +
            $webPidText.Substring($valueGroup.Index + $valueGroup.Length)
        [IO.File]::WriteAllText(
            $webPidPath,
            $mutatedWebPidText,
            [Text.UTF8Encoding]::new($false)
        )
        if ((Get-AclFingerprint $webPidPath) -cne $webPidAclFingerprint) {
            throw 'The PID mismatch case changed its private ACL.'
        }
        $stopExitCode = Invoke-StopNativeLocal -FixtureRoot $fixtureRoot -TimeoutMilliseconds 15000
        if ($stopExitCode -eq 0) {
            throw 'The PID-state mismatch stop negative case unexpectedly succeeded.'
        }
        Assert-OriginalServicesRemainRunning $serviceIdentities
        Write-Host 'STOP_NEGATIVE_CASE=pid_state_mismatch_rejected'
    } finally {
        [IO.File]::WriteAllBytes($webPidPath, $webPidBackup)
        Assert-FileBytesEqual -Path $webPidPath -ExpectedBytes $webPidBackup
        if ((Get-AclFingerprint $webPidPath) -cne $webPidAclFingerprint) {
            throw 'Restoring the PID record changed its private ACL.'
        }
    }
} finally {
    try {
        try {
            if ($null -ne $manifestBackup) {
                [IO.File]::WriteAllBytes($manifestPath, $manifestBackup)
                Assert-FileBytesEqual -Path $manifestPath -ExpectedBytes $manifestBackup
            }
            if ($null -ne $webPidBackup) {
                [IO.File]::WriteAllBytes($webPidPath, $webPidBackup)
                Assert-FileBytesEqual -Path $webPidPath -ExpectedBytes $webPidBackup
                if ($null -ne $webPidAclFingerprint -and
                    (Get-AclFingerprint $webPidPath) -cne $webPidAclFingerprint) {
                    throw 'The final PID record restore changed its private ACL.'
                }
            }
        } finally {
            $finalStopExitCode = Invoke-StopNativeLocal -FixtureRoot $fixtureRoot -TimeoutMilliseconds 60000
            if ($finalStopExitCode -ne 0) {
                throw 'The normal final native-local stop did not succeed.'
            }
            if ($serviceIdentities.Count -gt 0) {
                Assert-OriginalServicesStopped $serviceIdentities
                Write-Host 'STOP_FINAL_CASE=original_service_identities_stopped'
            }
        }
    } finally {
        $env:ALPACA_KEY = $priorAlpacaKey
        $env:ALPACA_SECRET = $priorAlpacaSecret
        $env:EQO_RESEARCH_JWT_SECRET = $priorResearchSecret
    }
}
