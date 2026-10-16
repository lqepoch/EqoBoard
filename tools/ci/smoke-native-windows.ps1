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
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
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

function Assert-RecordedGatewayProcess(
    [int]$ProcessId,
    [string]$ExpectedStartTicks,
    [string]$ExpectedExecutablePath
) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process -or $process.HasExited) { throw 'The recorded Gateway process exited.' }
    $startTicks = $process.StartTime.ToUniversalTime().Ticks.ToString(
        [Globalization.CultureInfo]::InvariantCulture
    )
    $executablePath = [IO.Path]::GetFullPath($process.MainModule.FileName)
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
        [void](Assert-RecordedGatewayProcess -ProcessId $gatewayProcessId `
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
        [void](Assert-RecordedGatewayProcess -ProcessId $gatewayProcessId `
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
    "EQO_GATEWAY_JWT_SECRET=$(New-TestSecret)"
    "EQO_RESEARCH_JWT_SECRET=$(New-TestSecret)"
    "NEXTAUTH_SECRET=$(New-TestSecret)"
) | Set-Content -LiteralPath $envPath -Encoding utf8NoBOM
Set-SmokePrivateAcl $envPath
$priorAlpacaKey = $env:ALPACA_KEY
$priorAlpacaSecret = $env:ALPACA_SECRET
$priorResearchSecret = $env:EQO_RESEARCH_JWT_SECRET
try {
    # Inherited provider/research secrets must not reach the terminal Web.
    $env:ALPACA_KEY = 'NATIVE_LOCAL_PARENT_SECRET_SENTINEL_KEY'
    $env:ALPACA_SECRET = 'NATIVE_LOCAL_PARENT_SECRET_SENTINEL_SECRET'
    $env:EQO_RESEARCH_JWT_SECRET = 'NATIVE_LOCAL_PARENT_SECRET_SENTINEL_RESEARCH'
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    & (Join-Path $repo 'tools/start-native-local.ps1') -PackagePath $PackagePath -RepoRoot $fixtureRoot -EnvPath $envPath -NodePath $nodePath -ExpectedCandidateSha $CandidateSha
    if ($LASTEXITCODE) { throw 'Packaged runtime startup failed' }
    Assert-FutuWorkerSurvivesStartup -FixtureRoot $fixtureRoot `
        -PackagePath $PackagePath -ExpectedNodePath $nodePath -CandidateSha $CandidateSha
    $env:E2E_LOCAL_ORIGIN = 'http://127.0.0.1:3000'
    Push-Location (Join-Path $repo 'apps/eqoboard-web')
    try {
        npx playwright test --config playwright.local.config.ts
        if ($LASTEXITCODE) { throw 'Packaged workstation browser acceptance failed' }
    } finally { Pop-Location }
} finally {
    try {
        & (Join-Path $repo 'tools/stop-native-local.ps1') -RepoRoot $fixtureRoot
    } finally {
        $env:ALPACA_KEY = $priorAlpacaKey
        $env:ALPACA_SECRET = $priorAlpacaSecret
        $env:EQO_RESEARCH_JWT_SECRET = $priorResearchSecret
    }
}
