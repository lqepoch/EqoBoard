param(
    [Parameter(Mandatory)][string]$OutputPath,
    [Parameter(Mandatory)][string]$MdpRuntimePath,
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
function Copy-Tree([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Source)) { throw "Missing package input: $Source" }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Destination -Recurse -Force
}

function Assert-MdpRuntime([string]$Path, [string]$RepoRoot) {
    $pinPath = Join-Path $RepoRoot 'third_party/mdp-runtime.json'
    $pin = Get-Content -LiteralPath $pinPath -Raw | ConvertFrom-Json
    if ($pin.schemaVersion -ne 1 -or
        $pin.repository -cne 'lqepoch/market-data-platform' -or
        $pin.revision -cnotmatch '^[0-9a-f]{40}$' -or
        $pin.sourceManifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $pin.rustVersion -cne '1.99.0' -or
        $pin.target -cne 'x86_64-pc-windows-msvc' -or
        $pin.license -cne 'MIT' -or
        $pin.acceptance -cne 'LOCAL_EVALUATION_ONLY') {
        throw 'The pinned MDP runtime identity is invalid.'
    }

    $root = (Resolve-Path -LiteralPath $Path).Path
    $rootItem = Get-Item -LiteralPath $root -Force
    if (-not $rootItem.PSIsContainer -or
        ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The MDP runtime must be a real directory.'
    }
    $expectedFiles = @('LICENSE', 'NOTICE.txt', 'mdp.exe', 'runtime.json', 'SHA256SUMS')
    $items = @(Get-ChildItem -LiteralPath $root -Force)
    if ($items.Count -ne $expectedFiles.Count -or
        @($items | Where-Object { $_.PSIsContainer -or
            ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0 -or
        @($items.Name | Where-Object { $_ -cnotin $expectedFiles }).Count -ne 0 -or
        @($expectedFiles | Where-Object { $_ -cnotin $items.Name }).Count -ne 0) {
        throw 'The MDP runtime file set is incomplete or contains unexpected files.'
    }

    $metadataPath = Join-Path $root 'runtime.json'
    $checksumPath = Join-Path $root 'SHA256SUMS'
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $expectedMetadata = @{
        schemaVersion = 1
        releaseAcceptance = 'LOCAL_EVALUATION_ONLY'
        arch = 'x86_64'
        candidateSha = $pin.revision
        packageName = 'market-data-platform'
        packageVersion = '0.1.0'
        platform = 'win32'
        rustVersion = '1.99.0'
        nasmVersion = '2.16.03'
        sourceManifestSha256 = $pin.sourceManifestSha256
        target = 'x86_64-pc-windows-msvc'
    }
    foreach ($name in $expectedMetadata.Keys) {
        if ($metadata.$name -cne $expectedMetadata[$name]) {
            throw 'The MDP runtime metadata does not match its pinned candidate.'
        }
    }
    $metadataNames = @($metadata.PSObject.Properties.Name)
    $expectedMetadataNames = @($expectedMetadata.Keys) + @('binary')
    if ($metadataNames.Count -ne $expectedMetadataNames.Count -or
        @($metadataNames | Where-Object { $_ -cnotin $expectedMetadataNames }).Count -ne 0 -or
        @($expectedMetadataNames | Where-Object { $_ -cnotin $metadataNames }).Count -ne 0) {
        throw 'The MDP runtime metadata contains missing or unexpected fields.'
    }

    $binary = Get-Item -LiteralPath (Join-Path $root 'mdp.exe') -Force
    $binaryMetadata = $metadata.binary
    $binaryMetadataNames = @($binaryMetadata.PSObject.Properties.Name)
    if ($binaryMetadataNames.Count -ne 3 -or
        @($binaryMetadataNames | Where-Object { $_ -cnotin @('name', 'sha256', 'sizeBytes') }).Count -ne 0 -or
        @(@('name', 'sha256', 'sizeBytes') | Where-Object { $_ -cnotin $binaryMetadataNames }).Count -ne 0 -or
        $binaryMetadata.name -cne 'mdp.exe' -or
        $binaryMetadata.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $binaryMetadata.sha256 -cne (Get-FileHash -LiteralPath $binary.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -or
        [long]$binaryMetadata.sizeBytes -ne $binary.Length) {
        throw 'The MDP executable metadata does not match the runtime binary.'
    }

    $listed = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
    foreach ($line in [IO.File]::ReadAllLines($checksumPath, [Text.Encoding]::ASCII)) {
        if ($line -notmatch '^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$') {
            throw 'The MDP runtime checksum manifest is malformed.'
        }
        $digest = $Matches[1]
        $relative = $Matches[2]
        if ($relative -ceq 'SHA256SUMS' -or $listed.ContainsKey($relative)) {
            throw 'The MDP runtime checksum manifest has an invalid file set.'
        }
        $target = Join-Path $root $relative
        if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or
            (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $digest) {
            throw 'An MDP runtime checksum does not match.'
        }
        $listed.Add($relative, $digest)
    }
    if ($listed.Count -ne ($expectedFiles.Count - 1) -or
        @($expectedFiles | Where-Object { $_ -cne 'SHA256SUMS' -and -not $listed.ContainsKey($_) }).Count -ne 0) {
        throw 'The MDP runtime checksum manifest does not cover the exact file set.'
    }

    return [pscustomobject]@{
        Root = $root
        SourceSha = [string]$pin.revision
        SourceManifestSha256 = [string]$pin.sourceManifestSha256
        ManifestSha256 = (Get-FileHash -LiteralPath $checksumPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

$mdpRuntime = Assert-MdpRuntime -Path $MdpRuntimePath -RepoRoot $repo
New-Item -ItemType Directory -Path $package -Force | Out-Null
$app = Join-Path $repo 'apps/eqoboard-web'
Copy-Tree (Join-Path $app '.next/standalone') (Join-Path $package 'web')
Copy-Tree (Join-Path $app '.next/static') (Join-Path $package 'web/.next/static')
New-Item -ItemType Directory -Path (Join-Path $package 'web/public') -Force | Out-Null
if (Test-Path (Join-Path $app 'public')) { Copy-Tree (Join-Path $app 'public') (Join-Path $package 'web/public') }
New-Item -ItemType Directory -Path (Join-Path $package 'gateway/empty') -Force | Out-Null
Copy-Item (Join-Path $repo 'target/release/eqo-gateway.exe') (Join-Path $package 'gateway/eqo-gateway.exe')
Copy-Tree $mdpRuntime.Root (Join-Path $package 'mdp')
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
    mdpSourceSha = $mdpRuntime.SourceSha
    mdpSourceManifestSha256 = $mdpRuntime.SourceManifestSha256
    mdpManifestSha256 = $mdpRuntime.ManifestSha256
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
