#requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackagePath,
    [Parameter(Mandatory)][string]$RepoRoot,
    [string]$EnvPath,
    [Parameter(Mandatory)][string]$NodePath,
    [ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedCandidateSha
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:ManagedProcesses = [System.Collections.Generic.List[object]]::new()
$script:ManagedRecords = [System.Collections.Generic.List[object]]::new()
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:FixedOrigin = 'http://127.0.0.1:3000'
$script:GatewayBind = '127.0.0.1:8080'
$script:WebPort = 3000
$script:GatewayPort = 8080
$script:StartedAtUtc = [DateTime]::UtcNow.ToString('O')
$script:DataRoot = $null
$script:RepositoryRoot = $null
$script:PackageRoot = $null
$script:CandidateSha = $null
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
    $relative = $full.Substring($root.Length)
    foreach ($segment in ($relative -split '[\\/]')) {
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
    if ($MustExist -and -not (Test-Path -LiteralPath $full)) {
        Fail 'A required path does not exist.'
    }
    return $full
}

function Get-PrivateSids {
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [Security.Principal.SecurityIdentifier]::new(
        [Security.Principal.WellKnownSidType]::LocalSystemSid, $null
    )
    return @{ User = $userSid; System = $systemSid }
}

function Set-PrivateAcl([string]$Path, [switch]$Directory) {
    $full = Assert-NoReparsePath -Path $Path -MustExist
    $sids = Get-PrivateSids
    $acl = Get-Acl -LiteralPath $full
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
    $acl.SetOwner($sids.User)
    $inheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    foreach ($sid in @($sids.User, $sids.System)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $full -AclObject $acl
    Assert-PrivateAcl -Path $full -Directory:$Directory
}

function Assert-PrivateAcl([string]$Path, [switch]$Directory) {
    $full = Assert-NoReparsePath -Path $Path -MustExist
    $acl = Get-Acl -LiteralPath $full
    if (-not $acl.AreAccessRulesProtected) { Fail 'A private path has inheritable ACL entries.' }
    $sids = Get-PrivateSids
    $expected = @($sids.User.Value, $sids.System.Value)
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) { Fail 'A private path has unexpected ACL entries.' }
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        if ($sid -notin $expected -or -not $seen.Add($sid)) {
            Fail 'A private path grants access to an unexpected identity.'
        }
        if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
            Fail 'A private path has an unexpected access rule.'
        }
        $rights = [Security.AccessControl.FileSystemRights]$rule.FileSystemRights
        if (($rights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
            [Security.AccessControl.FileSystemRights]::FullControl) {
            Fail 'A private path lacks the required full-control ACL.'
        }
        if ($Directory) {
            $requiredInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                [Security.AccessControl.InheritanceFlags]::ObjectInherit
            if ($rule.InheritanceFlags -ne $requiredInheritance -or
                $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
                Fail 'A private directory does not protect its children.'
            }
        } elseif ($rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None) {
            Fail 'A private file has an unexpected inheritable ACL.'
        }
    }
    if ($seen.Count -ne 2) { Fail 'A private path is missing a required ACL identity.' }
}

function Ensure-PrivateDirectory([string]$Path) {
    $full = Get-CanonicalPath $Path
    $root = [IO.Path]::GetPathRoot($full)
    $current = $root
    foreach ($segment in ($full.Substring($root.Length) -split '[\\/]')) {
        if (-not $segment) { continue }
        $current = Join-Path $current $segment
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (-not $item.PSIsContainer -or
                ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail 'A required data directory is not a real directory.'
            }
        } else {
            [void](New-Item -ItemType Directory -LiteralPath $current)
        }
    }
    Set-PrivateAcl -Path $full -Directory
    return $full
}

function Ensure-PrivateFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail 'A private file is missing.' }
    Set-PrivateAcl -Path $Path
}

function Read-LiteralEnv([string]$Path) {
    $values = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in [IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8)) {
        if ($line -match '^\s*(?:#.*)?$') { continue }
        if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            Fail 'The environment file contains an unsupported line.'
        }
        $name = $Matches[1]
        $value = $Matches[2]
        if ($values.ContainsKey($name)) { Fail 'The environment file contains a duplicate key.' }
        if ($value.Length -ge 2 -and
            (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or
                ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        } elseif ($value.StartsWith('"') -or $value.StartsWith("'")) {
            Fail 'The environment file contains unmatched quotes.'
        }
        if ($value.IndexOfAny([char[]]@([char]0, [char]10, [char]13)) -ge 0) {
            Fail 'The environment file contains an invalid value.'
        }
        $values.Add($name, $value)
    }
    return ,$values
}

function Get-EnvValue($Values, [string]$Name, [string]$Default = '') {
    if ($Values.ContainsKey($Name)) { return [string]$Values[$Name] }
    return $Default
}

function Assert-EnvFixed($Values, [string]$Name, [string]$Expected) {
    if (-not $Values.ContainsKey($Name) -or [string]$Values[$Name] -cne $Expected) {
        Fail "The local environment must explicitly set $Name to its fixed loopback value."
    }
}

function Assert-Package([string]$PackageRoot, [string]$ExpectedSha) {
    $full = Assert-NoReparsePath -Path $PackageRoot -MustExist
    $packageItem = Get-Item -LiteralPath $full -Force
    if (-not $packageItem.PSIsContainer) { Fail 'The runtime package root must be a directory.' }
    foreach ($item in Get-ChildItem -LiteralPath $full -Force -Recurse -ErrorAction Stop) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail 'The runtime package contains a reparse point.'
        }
        if (-not $item.PSIsContainer -and $item.Name -like '.env*') {
            Fail 'Environment files are forbidden in the runtime package.'
        }
    }

    $metadataPath = Join-Path $full 'runtime.json'
    $checksumPath = Join-Path $full 'SHA256SUMS'
    foreach ($required in @(
        'web/.next/static', 'web/public', 'gateway/empty',
        'tools/futu-runtime/node_modules', 'legal'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $full $required) -PathType Container)) {
            Fail 'The runtime package is incomplete.'
        }
    }
    foreach ($required in @(
        'web/server.js', 'gateway/eqo-gateway.exe',
        'tools/futu-stdio.mjs', 'tools/futu-history.mjs', 'tools/futu-subscriptions.mjs',
        'tools/futu-runtime/package.json', 'runtime.json', 'SHA256SUMS'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $full $required) -PathType Leaf)) {
            Fail 'The runtime package is incomplete.'
        }
    }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ($metadata.schemaVersion -ne 1 -or
        $metadata.candidateSha -cnotmatch '^[0-9a-f]{40}$' -or
        $metadata.nodeVersion -cne '22.23.3' -or
        $metadata.platform -cne 'win32' -or $metadata.arch -cne 'x64' -or
        $metadata.releaseAcceptance -cne 'LOCAL_EVALUATION_ONLY' -or
        $metadata.execution -cne 'disabled') {
        Fail 'The runtime metadata does not describe an approved local-evaluation package.'
    }
    if ($ExpectedSha -and $metadata.candidateSha -cne $ExpectedSha) {
        Fail 'The runtime candidate SHA does not match the requested candidate.'
    }

    $listed = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in [IO.File]::ReadAllLines($checksumPath, [Text.Encoding]::UTF8)) {
        if ($line -notmatch '^([0-9a-f]{64})  ([A-Za-z0-9@._/+~-]+)$') {
            Fail 'The runtime checksum manifest is malformed.'
        }
        $digest = $Matches[1]
        $relative = $Matches[2]
        $parts = $relative.Split('/')
        if ($relative.StartsWith('/') -or $relative.Contains('\') -or
            $parts -contains '' -or $parts -contains '.' -or $parts -contains '..' -or
            $relative -match '^[A-Za-z]:') {
            Fail 'The runtime checksum manifest contains an unsafe path.'
        }
        if ($listed.ContainsKey($relative)) { Fail 'The runtime checksum manifest contains a duplicate path.' }
        $target = [IO.Path]::GetFullPath((Join-Path $full ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))) )
        $prefix = $full.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $target -PathType Leaf)) {
            Fail 'The runtime checksum manifest references a missing or out-of-package file.'
        }
        $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -cne $digest) { Fail 'A runtime package checksum does not match.' }
        $listed.Add($relative, $digest)
    }
    $actualFiles = @(Get-ChildItem -LiteralPath $full -File -Force -Recurse |
        Where-Object { $_.FullName -cne $checksumPath })
    if ($listed.Count -ne $actualFiles.Count) { Fail 'The runtime checksum manifest does not cover every package file.' }
    foreach ($file in $actualFiles) {
        $relative = [IO.Path]::GetRelativePath($full, $file.FullName).Replace('\', '/')
        if (-not $listed.ContainsKey($relative)) { Fail 'The runtime checksum manifest omits a package file.' }
    }
    return [pscustomobject]@{ Root = $full; Metadata = $metadata }
}

function Resolve-Node([string]$Path) {
    $full = Assert-NoReparsePath -Path $Path -MustExist
    if ((Get-Item -LiteralPath $full -Force).PSIsContainer) { $full = Join-Path $full 'node.exe' }
    $full = Assert-NoReparsePath -Path $full -MustExist
    if ([IO.Path]::GetFileName($full) -cne 'node.exe') { Fail 'NodePath must identify node.exe or its directory.' }
    $version = (& $full --version 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -cne 'v22.23.3') { Fail 'NodePath must be the official Node.js 22.23.3 runtime.' }
    return $full
}

function Assert-PortAvailable([int]$Port) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() }
    catch { Fail "Loopback port $Port is already in use; no process was changed." }
    finally { $listener.Stop() }
}

function Assert-OwnedListener([int]$Port, [int]$ProcessId) {
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($connections.Count -eq 0) { return $false }
    foreach ($connection in $connections) {
        if ($connection.LocalAddress -cne '127.0.0.1' -or $connection.OwningProcess -ne $ProcessId) {
            Fail "Port $Port is not exclusively bound by the expected loopback service process."
        }
    }
    return $true
}

function New-ServiceEnvironment([string]$NodeDirectory, [string]$PrivateHome, [hashtable]$Values) {
    $environment = @{}
    foreach ($name in [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Machine).Keys) {
        $environment[[string]$name] = $null
    }
    $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot', [EnvironmentVariableTarget]::Machine)
    if (-not $systemRoot) { $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot') }
    if (-not $systemRoot) { Fail 'Windows SystemRoot is unavailable.' }
    $system32 = Join-Path $systemRoot 'System32'
    $environment['SystemRoot'] = $systemRoot
    $environment['WINDIR'] = $systemRoot
    $environment['Path'] = "$NodeDirectory;$system32"
    $environment['TEMP'] = $PrivateHome
    $environment['TMP'] = $PrivateHome
    $environment['HOME'] = $PrivateHome
    $environment['USERPROFILE'] = $PrivateHome
    $environment['APPDATA'] = Join-Path $PrivateHome 'AppData/Roaming'
    $environment['LOCALAPPDATA'] = Join-Path $PrivateHome 'AppData/Local'
    $environment['COMSPEC'] = Join-Path $system32 'cmd.exe'
    foreach ($name in @('PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) { $environment[$name] = $value }
    }
    foreach ($name in $Values.Keys) { $environment[$name] = [string]$Values[$name] }
    return $environment
}

function Get-ProcessIdentity([int]$ProcessId) {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    $path = $process.MainModule.FileName
    if (-not $path) { Fail 'The started service executable path could not be verified.' }
    return [pscustomobject]@{
        Process = $process
        ProcessId = $ProcessId
        StartTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
        ExecutablePath = [IO.Path]::GetFullPath($path)
    }
}

function Write-PrivateJson([string]$Path, $Value) {
    $full = Get-CanonicalPath $Path
    $parent = Split-Path -Parent $full
    Assert-NoReparsePath -Path $parent -MustExist | Out-Null
    $temporary = "$full.tmp.$([guid]::NewGuid().ToString('N'))"
    try {
        $json = ConvertTo-Json -InputObject $Value -Depth 8
        [IO.File]::WriteAllText($temporary, $json, $script:Utf8NoBom)
        Set-PrivateAcl -Path $temporary
        if (Test-Path -LiteralPath $full) {
            Assert-NoReparsePath -Path $full -MustExist | Out-Null
            Assert-PrivateAcl -Path $full
        }
        Move-Item -LiteralPath $temporary -Destination $full -Force
        Set-PrivateAcl -Path $full
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Write-RunState([string]$Root, [string]$Package, [string]$CandidateSha, [string]$Status) {
    $state = [ordered]@{
        schemaVersion = 1
        status = $Status
        candidateSha = $CandidateSha
        repoRoot = $script:RepositoryRoot
        packagePath = $Package
        startedAtUtc = $script:StartedAtUtc
        processes = @($script:ManagedRecords.ToArray())
    }
    Write-PrivateJson -Path (Join-Path $Root 'state.json') -Value $state
}

function Start-TrackedService(
    [string]$Role,
    [string]$Executable,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [hashtable]$Environment,
    [string]$CandidateSha,
    [string]$Root,
    [string]$Package
) {
    $logToken = "$Role-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $stdout = Join-Path $Root "$logToken.stdout.log"
    $stderr = Join-Path $Root "$logToken.stderr.log"
    $quotedArguments = @($Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' })
    $argumentLine = $quotedArguments -join ' '
    $process = Start-Process -FilePath $Executable -ArgumentList $argumentLine `
        -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
        -Environment $Environment -UseNewEnvironment
    $script:ManagedProcesses.Add($process)
    try {
        $identity = Get-ProcessIdentity -ProcessId $process.Id
        if ([IO.Path]::GetFullPath($identity.ExecutablePath) -cne [IO.Path]::GetFullPath($Executable)) {
            Fail 'The launched service executable did not match the validated path.'
        }
        $record = [ordered]@{
            role = $Role
            processId = $identity.ProcessId
            startTimeUtcTicks = $identity.StartTimeUtcTicks
            executablePath = $identity.ExecutablePath
            workingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
            candidateSha = $CandidateSha
            stdoutLog = $stdout
            stderrLog = $stderr
        }
        $script:ManagedRecords.Add([pscustomobject]$record)
        foreach ($log in @($stdout, $stderr)) { Set-PrivateAcl -Path $log }
        Write-PrivateJson -Path (Join-Path $Root "pid/$Role.json") -Value $record
        Write-RunState -Root $Root -Package $Package -CandidateSha $CandidateSha -Status 'starting'
        return [pscustomobject]@{ Record = $record; Process = $process }
    } catch {
        [void](Stop-StartedProcess $process)
        throw
    }
}

function Wait-HttpJson([string]$Uri, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Uri -Method Get -TimeoutSec 2 -SkipHttpErrorCheck
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
                if ($response.Content) { return ($response.Content | ConvertFrom-Json) }
                return [pscustomobject]@{}
            }
        } catch {
            # Readiness is polled only until its bounded deadline; response details may contain runtime data.
        }
        Start-Sleep -Milliseconds 250
    }
    Fail 'A local service did not become healthy before its startup deadline.'
}

function Stop-StartedProcess($ProcessObject) {
    try {
        if ($ProcessObject -and -not $ProcessObject.HasExited) {
            $ProcessObject.Kill($true)
            return [bool]$ProcessObject.WaitForExit(15000) -and [bool]$ProcessObject.HasExited
        }
        return $true
    } catch { return $false }
}

try {
    if (-not $IsWindows) { Fail 'The native local launcher supports Windows only.' }
    $script:Phase = 'validate-package'
    $repo = Assert-NoReparsePath -Path $RepoRoot -MustExist
    if (-not (Get-Item -LiteralPath $repo).PSIsContainer) { Fail 'RepoRoot must be a directory.' }
    $script:RepositoryRoot = $repo
    if ([string]::IsNullOrWhiteSpace($EnvPath)) { $EnvPath = Join-Path $repo '.env' }
    $package = Assert-Package -PackageRoot $PackagePath -ExpectedSha $ExpectedCandidateSha
    $script:Phase = 'validate-node'
    $node = Resolve-Node -Path $NodePath

    $script:Phase = 'validate-environment'
    $envFile = Assert-NoReparsePath -Path $EnvPath -MustExist
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { Fail 'EnvPath must identify a file.' }
    Assert-PrivateAcl -Path $envFile
    $values = Read-LiteralEnv -Path $envFile
    Assert-EnvFixed $values 'EQO_LOCAL_ACCESS' 'true'
    Assert-EnvFixed $values 'EQO_LOCAL_BIND' '127.0.0.1'
    Assert-EnvFixed $values 'EQO_BFF_MODE' 'terminal'
    Assert-EnvFixed $values 'EQO_PUBLIC_ORIGIN' $script:FixedOrigin
    Assert-EnvFixed $values 'NEXTAUTH_URL' $script:FixedOrigin
    Assert-EnvFixed $values 'EQO_RUST_URL' 'http://127.0.0.1:8080'
    Assert-EnvFixed $values 'EQO_BIND' $script:GatewayBind
    Assert-EnvFixed $values 'EQO_MARKET_DATA_PROVIDER' 'futu'
    if ($values.ContainsKey('EQO_EXECUTION_MODE') -and $values['EQO_EXECUTION_MODE'] -ceq 'live') {
        Fail 'Live execution configuration is rejected by the local launcher.'
    }

    $gatewaySecret = Get-EnvValue $values 'EQO_GATEWAY_JWT_SECRET'
    $researchSecret = Get-EnvValue $values 'EQO_RESEARCH_JWT_SECRET'
    $nextAuthSecret = Get-EnvValue $values 'NEXTAUTH_SECRET'
    foreach ($secret in @($gatewaySecret, $researchSecret)) {
        if ($secret.Length -lt 64 -or $secret -cnotmatch '^[\x21-\x7e]+$') {
            Fail 'Gateway signing secrets must be at least 64 printable ASCII characters.'
        }
    }
    if ($nextAuthSecret.Length -lt 32 -or $nextAuthSecret -cnotmatch '^[\x21-\x7e]+$') {
        Fail 'NEXTAUTH_SECRET must be at least 32 printable ASCII characters.'
    }
    if ($gatewaySecret -ceq $researchSecret -or $gatewaySecret -ceq $nextAuthSecret -or
        $researchSecret -ceq $nextAuthSecret) {
        Fail 'Web, Gateway and Research signing secrets must be independent.'
    }
    $futuHost = Get-EnvValue $values 'FUTU_OPEND_HOST' '127.0.0.1'
    if ($futuHost -cne '127.0.0.1') { Fail 'Futu OpenD must use the IPv4 loopback address.' }
    $futuPortText = Get-EnvValue $values 'FUTU_OPEND_WEBSOCKET_PORT' '33333'
    $futuPort = 0
    if (-not [int]::TryParse($futuPortText, [ref]$futuPort) -or $futuPort -lt 1 -or $futuPort -gt 65535) {
        Fail 'The Futu OpenD WebSocket port is invalid.'
    }
    $futuSsl = Get-EnvValue $values 'FUTU_OPEND_WEBSOCKET_SSL' 'false'
    if ($futuSsl -cnotin @('true', 'false')) { Fail 'The Futu TLS setting must be true or false.' }
    $futuKey = Get-EnvValue $values 'FUTU_OPEND_WEBSOCKET_KEY'
    if ($futuKey.Length -gt 4096 -or $futuKey -match '[\x00-\x1f\x7f]') {
        Fail 'The Futu key has an invalid representation.'
    }

    $script:Phase = 'prepare-private-state'
    $dataRoot = Ensure-PrivateDirectory (Join-Path $repo 'data/native-local')
    $script:DataRoot = $dataRoot
    $workspaceData = Ensure-PrivateDirectory (Join-Path $dataRoot 'workspaces')
    $auditDir = Ensure-PrivateDirectory (Join-Path $dataRoot 'audit')
    $stateDir = Ensure-PrivateDirectory (Join-Path $dataRoot 'state')
    $logsDir = Ensure-PrivateDirectory (Join-Path $dataRoot 'logs')
    $pidDir = Ensure-PrivateDirectory (Join-Path $dataRoot 'pid')
    $homeRoot = Ensure-PrivateDirectory (Join-Path $stateDir 'home')
    foreach ($name in @('web', 'gateway')) {
        $home = Ensure-PrivateDirectory (Join-Path $homeRoot $name)
        [void](Ensure-PrivateDirectory (Join-Path $home 'AppData/Roaming'))
        [void](Ensure-PrivateDirectory (Join-Path $home 'AppData/Local'))
    }
    [void]$auditDir
    [void]$logsDir

    if ((Test-Path -LiteralPath (Join-Path $dataRoot 'state.json')) -or
        (Get-ChildItem -LiteralPath $pidDir -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
        Fail 'Native local state already exists; use stop-native-local.ps1 before starting another instance.'
    }
    $script:Phase = 'validate-loopback-ports'
    Assert-PortAvailable $script:GatewayPort
    Assert-PortAvailable $script:WebPort

    $nodeDirectory = Split-Path -Parent $node
    $gatewayDirectory = Join-Path $package.Root 'gateway'
    $webDirectory = Join-Path $package.Root 'web'
    $script:PackageRoot = $package.Root
    $script:CandidateSha = $package.Metadata.candidateSha
    $gatewayEnvironment = New-ServiceEnvironment -NodeDirectory $nodeDirectory -PrivateHome (Join-Path $homeRoot 'gateway') -Values @{
        EQO_BIND = $script:GatewayBind
        EQO_EXECUTION_MODE = 'disabled'
        EQO_MARKET_DATA_PROVIDER = 'futu'
        EQO_LOCAL_ACCESS = 'true'
        EQO_LOCAL_BIND = '127.0.0.1'
        EQO_GATEWAY_JWT_SECRET = $gatewaySecret
        EQO_RESEARCH_JWT_SECRET = $researchSecret
        EQO_STOCK_SYMBOLS = 'QQQ,SPY'
        EQO_AUDIT_PATH = (Join-Path $auditDir 'order-events.jsonl')
        EQO_WEB_DIST = (Join-Path $gatewayDirectory 'empty')
        EQO_FUTU_SCRIPT = (Join-Path $package.Root 'tools/futu-stdio.mjs')
        FUTU_OPEND_HOST = '127.0.0.1'
        FUTU_OPEND_WEBSOCKET_PORT = [string]$futuPort
        FUTU_OPEND_WEBSOCKET_SSL = $futuSsl
        FUTU_OPEND_WEBSOCKET_KEY = $futuKey
    }
    $webEnvironment = New-ServiceEnvironment -NodeDirectory $nodeDirectory -PrivateHome (Join-Path $homeRoot 'web') -Values @{
        NODE_ENV = 'production'
        HOSTNAME = '127.0.0.1'
        PORT = [string]$script:WebPort
        NEXT_TELEMETRY_DISABLED = '1'
        EQO_LOCAL_ACCESS = 'true'
        EQO_LOCAL_BIND = '127.0.0.1'
        EQO_BFF_MODE = 'terminal'
        EQO_PUBLIC_ORIGIN = $script:FixedOrigin
        NEXTAUTH_URL = $script:FixedOrigin
        NEXTAUTH_SECRET = $nextAuthSecret
        EQO_GATEWAY_JWT_SECRET = $gatewaySecret
        EQO_RUST_URL = 'http://127.0.0.1:8080'
        EQO_EXECUTION_MODE = 'disabled'
        EQOBOARD_DATA_DIR = $workspaceData
    }

    $gatewayExe = Join-Path $gatewayDirectory 'eqo-gateway.exe'
    $script:Phase = 'start-gateway'
    $gatewayStarted = Start-TrackedService -Role 'gateway' -Executable $gatewayExe -Arguments @() `
        -WorkingDirectory $gatewayDirectory -Environment $gatewayEnvironment `
        -CandidateSha $package.Metadata.candidateSha -Root $dataRoot -Package $package.Root
    $script:Phase = 'verify-gateway-readiness'
    $gatewayReady = Wait-HttpJson -Uri 'http://127.0.0.1:8080/readyz' -TimeoutSeconds 30
    if ($gatewayReady.identity_validation_configured -ne $true -or
        $gatewayReady.execution_enabled -ne $false -or
        $gatewayReady.execution_mode -cne 'disabled' -or
        $gatewayReady.market_data_provider -cne 'futu' -or
        $gatewayReady.market_data_configured -ne $true) {
        Fail 'Gateway readiness does not match the local disabled-execution Futu profile.'
    }
    if (-not (Assert-OwnedListener -Port $script:GatewayPort -ProcessId $gatewayStarted.Record.processId)) {
        Fail 'Gateway did not bind its expected loopback listener.'
    }

    $script:Phase = 'start-web'
    $webStarted = Start-TrackedService -Role 'web' -Executable $node -Arguments @((Join-Path $webDirectory 'server.js')) `
        -WorkingDirectory $webDirectory -Environment $webEnvironment `
        -CandidateSha $package.Metadata.candidateSha -Root $dataRoot -Package $package.Root
    $script:Phase = 'verify-web-health'
    [void](Wait-HttpJson -Uri 'http://127.0.0.1:3000/api/healthz' -TimeoutSeconds 45)
    if (-not (Assert-OwnedListener -Port $script:WebPort -ProcessId $webStarted.Record.processId)) {
        Fail 'Web did not bind its expected loopback listener.'
    }
    $script:Phase = 'persist-running-state'
    Write-RunState -Root $dataRoot -Package $package.Root -CandidateSha $package.Metadata.candidateSha -Status 'running'
    Write-Output 'Native local Web and Gateway are running on loopback; execution remains disabled.'
} catch {
    $allStopped = $true
    for ($index = $script:ManagedProcesses.Count - 1; $index -ge 0; $index--) {
        if (-not (Stop-StartedProcess $script:ManagedProcesses[$index])) { $allStopped = $false }
    }
    if ($script:ManagedProcesses.Count -gt 0 -and $script:DataRoot) {
        $rootForCleanup = $script:DataRoot
        if (-not $allStopped -and $script:PackageRoot -and $script:CandidateSha) {
            try { Write-RunState -Root $rootForCleanup -Package $script:PackageRoot -CandidateSha $script:CandidateSha -Status 'cleanup-required' } catch { }
        }
        if ($allStopped) {
            foreach ($record in $script:ManagedRecords) {
                $pidPath = Join-Path $rootForCleanup "pid/$($record.role).json"
                if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force }
            }
            $statePath = Join-Path $rootForCleanup 'state.json'
            if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
        }
    }
    $exceptionType = $_.Exception.GetType().FullName
    $line = $_.InvocationInfo.ScriptLineNumber
    Write-Error "Native local startup failed during '$script:Phase' (type=$exceptionType, line=$line). Review private logs under data/native-local; no unrelated process was stopped."
    exit 1
}
