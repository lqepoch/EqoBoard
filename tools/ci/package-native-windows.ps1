param(
    [Parameter(Mandatory)][string]$OutputPath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$CandidateSha
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true') {
    throw 'Windows packages must be built in GitHub Actions.'
}
if ((git -C $repo rev-parse HEAD).Trim() -ne $CandidateSha) { throw 'Candidate mismatch' }
if (Test-Path -LiteralPath $OutputPath) { throw 'Output path already exists' }
$package = Join-Path $OutputPath 'runtime'
New-Item -ItemType Directory -Path $package -Force | Out-Null
function Copy-Tree([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Source)) { throw "Missing package input: $Source" }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Destination -Recurse -Force
}
$app = Join-Path $repo 'apps/eqoboard-web'
Copy-Tree (Join-Path $app '.next/standalone') (Join-Path $package 'web')
Copy-Tree (Join-Path $app '.next/static') (Join-Path $package 'web/.next/static')
New-Item -ItemType Directory -Path (Join-Path $package 'web/public') -Force | Out-Null
if (Test-Path (Join-Path $app 'public')) { Copy-Tree (Join-Path $app 'public') (Join-Path $package 'web/public') }
New-Item -ItemType Directory -Path (Join-Path $package 'gateway/empty') -Force | Out-Null
Copy-Item (Join-Path $repo 'target/release/eqo-gateway.exe') (Join-Path $package 'gateway/eqo-gateway.exe')
New-Item -ItemType Directory -Path (Join-Path $package 'tools/futu-runtime') -Force | Out-Null
foreach ($name in @('futu-stdio.mjs', 'futu-history.mjs', 'futu-subscriptions.mjs')) {
    Copy-Item (Join-Path $repo "tools/$name") (Join-Path $package "tools/$name")
}
Copy-Tree (Join-Path $repo 'tools/futu-runtime/node_modules') (Join-Path $package 'tools/futu-runtime/node_modules')
foreach ($name in @('package.json', 'package-lock.json', 'README.md')) {
    Copy-Item (Join-Path $repo "tools/futu-runtime/$name") (Join-Path $package "tools/futu-runtime/$name")
}
Copy-Tree (Join-Path $app 'legal') (Join-Path $package 'legal/native')
Copy-Tree (Join-Path $repo 'third_party/licenses') (Join-Path $package 'legal/third-party')
foreach ($name in @('LICENSE', 'NOTICE')) {
    $source = Join-Path $repo $name
    if (Test-Path $source) { Copy-Item $source (Join-Path $package "legal/$name") }
}
# Keep installed dependency notices even when Next's trace omits their filenames.
foreach ($dependencyRoot in @((Join-Path $app 'node_modules'), (Join-Path $repo 'tools/futu-runtime/node_modules'))) {
    $prefix = if ($dependencyRoot -like '*futu-runtime*') { 'futu' } else { 'web' }
    Get-ChildItem -LiteralPath $dependencyRoot -Recurse -File -Force |
        Where-Object { $_.Name -match '^(LICENSE|NOTICE|COPYING)' } |
        ForEach-Object {
            $relative = [IO.Path]::GetRelativePath($dependencyRoot, $_.FullName)
            $destination = Join-Path $package "legal/dependencies/$prefix/$relative"
            New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $destination
        }
}
$privateFiles = Get-ChildItem $package -Recurse -File -Force | Where-Object { $_.Name -like '.env*' }
if ($privateFiles) { throw 'Environment files must never enter the runtime package' }
$metadata = [ordered]@{
    schemaVersion = 1
    candidateSha = $CandidateSha
    nodeVersion = '22.23.3'
    platform = 'win32'
    arch = 'x64'
    releaseAcceptance = 'LOCAL_EVALUATION_ONLY'
    licenseClosure = 'NOT_CLAIMED'
    execution = 'disabled'
}
$metadata | ConvertTo-Json | Set-Content (Join-Path $package 'runtime.json') -Encoding utf8NoBOM
$checksums = Get-ChildItem $package -File -Recurse -Force | Sort-Object FullName | ForEach-Object {
    $relative = [IO.Path]::GetRelativePath($package, $_.FullName).Replace('\', '/')
    '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
}
$checksums | Set-Content (Join-Path $package 'SHA256SUMS') -Encoding utf8NoBOM
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = Join-Path $OutputPath 'eqoboard-windows-x64.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($package, $archive)
'{0}  eqoboard-windows-x64.zip' -f (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() |
    Set-Content (Join-Path $OutputPath 'ARCHIVE_SHA256SUMS') -Encoding utf8NoBOM
Write-Output "Packaged candidate $CandidateSha for local evaluation; license closure is not claimed."
