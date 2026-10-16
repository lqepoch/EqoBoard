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
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $inheritance = if (Test-Path -LiteralPath $Path -PathType Container) {
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($identity in @($owner, 'NT AUTHORITY\SYSTEM')) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $identity, 'FullControl', $inheritance, 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
Set-SmokePrivateAcl $fixtureRoot
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
    & (Join-Path $repo 'tools/start-native-local.ps1') -PackagePath $PackagePath -RepoRoot $fixtureRoot -EnvPath $envPath -NodePath (Get-Command node).Source -ExpectedCandidateSha $CandidateSha
    if ($LASTEXITCODE) { throw 'Packaged runtime startup failed' }
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
