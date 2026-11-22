[CmdletBinding(DefaultParameterSetName = 'Download')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Download')] [Parameter(Mandatory, ParameterSetName = 'Local')]
    [ValidatePattern('^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-beta\.(?:0|[1-9]\d{0,8}))?$')] [string] $Version,
    [Parameter(Mandatory, ParameterSetName = 'Download')] [Parameter(Mandatory, ParameterSetName = 'Local')]
    [ValidatePattern('^[a-f0-9]{64}$')] [string] $ArchiveSha256,
    [Parameter(Mandatory, ParameterSetName = 'Download')] [uri] $ArchiveUri,
    [Parameter(Mandatory, ParameterSetName = 'Local')] [string] $Archive,
    [switch] $NoGuide,
    [Parameter(Mandatory, ParameterSetName = 'Maintenance')] [ValidateSet('verify', 'recover', 'rollback', 'uninstall')] [string] $Maintenance,
    [Parameter(ParameterSetName = 'Maintenance')] [string] $TargetVersion
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object Text.UTF8Encoding($false, $true)
$versionPattern = '^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-beta\.(?:0|[1-9]\d{0,8}))?$'
$hexPattern = '^[a-f0-9]{64}$'
$maxArchive = 536870912
$maxFile = 134217728
$maxManifest = 4194304

function Get-PlainItem([string] $Path, [switch] $Directory) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $null }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -ne $Directory.IsPresent -or
        (-not $Directory -and $item.LinkType -eq 'HardLink')) {
        throw "Unsafe Mosaic path: $Path"
    }
    return $item
}

function Get-PlainDirectory([string] $Path) {
    if ($Maintenance -eq 'verify') {
        if (-not (Get-PlainItem $Path -Directory)) { throw 'A Mosaic installation directory is missing.' }
        Assert-PrivateRoot $Path
        return Get-PlainItem $Path -Directory
    }
    Initialize-Root $Path
    return Get-PlainItem $Path -Directory
}

function Assert-LocalPath([string] $Path) {
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path -match '[\x00-\x1f]') { throw 'Mosaic requires a local Windows drive.' }
    for ($cursor = $Path; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
        if (-not (Get-PlainItem $cursor -Directory)) { throw 'The per-user app data directory is inaccessible.' }
    }
}

function Assert-PrivateRoot([string] $Path) {
    $directory = New-Object IO.DirectoryInfo($Path)
    $acl = if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::GetAccessControl($directory) }
        else { $directory.GetAccessControl() }
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $currentSid.Value) { throw 'Mosaic installation is owned by a different user.' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($owner, 'S-1-5-18', 'S-1-5-32-544')) {
            throw 'Mosaic installation permissions permit another account. Preserve the existing directory and inspect its access rules.'
        }
    }
}

function Initialize-Root([string] $Path) {
    if (-not (Get-PlainItem $Path -Directory)) {
        [IO.Directory]::CreateDirectory($Path) | Out-Null
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetOwner($currentSid)
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in @($currentSid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $acl.AddAccessRule($rule)
        }
        $directory = New-Object IO.DirectoryInfo($Path)
        if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($directory, $acl) }
        else { $directory.SetAccessControl($acl) }
    }
    Assert-PrivateRoot $Path
}

function Write-Atomic([string] $Path, [byte[]] $Bytes) {
    $previous = Get-PlainItem $Path
    $temporary = Join-Path ([IO.Path]::GetDirectoryName($Path)) ('.mosaic-' + [guid]::NewGuid().ToString('N'))
    try {
        $handle = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $handle.Write($Bytes, 0, $Bytes.Length)
            $handle.Flush($true)
        } finally { $handle.Dispose() }
        if ($previous) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if (Get-PlainItem $temporary) { [IO.File]::Delete($temporary) }
    }
}

function Read-JsonFile([string] $Path, [int] $Limit) {
    $item = Get-PlainItem $Path
    if (-not $item) { return $null }
    if ($item.Length -gt $Limit) { throw "Oversized Mosaic record: $Path" }
    return ($utf8.GetString([IO.File]::ReadAllBytes($Path)) | ConvertFrom-Json)
}

function Write-JsonFile([string] $Path, $Value) {
    Write-Atomic $Path ($utf8.GetBytes(($Value | ConvertTo-Json -Depth 8 -Compress) + [char]10))
}

function Get-StreamSha256([IO.Stream] $Stream) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-Sha256([string] $Path) {
    $handle = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { return Get-StreamSha256 $handle }
    finally { $handle.Dispose() }
}

function Get-Archive([string] $Path, [uri] $Uri, [string] $Expected) {
    if (-not $Uri.IsAbsoluteUri -or $Uri.Scheme -ne 'https' -or $Uri.UserInfo -or $Uri.Fragment) {
        throw 'Mosaic downloads require HTTPS without URL credentials or a fragment.'
    }
    $curl = Join-Path ([Environment]::SystemDirectory) 'curl.exe'
    $common = @('-q', '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
        '--max-redirs', '3', '--connect-timeout', '15', '--max-time', '240', '--max-filesize', "$maxArchive", '--output', $Path)
    $partial = Get-PlainItem $Path
    if ($partial -and $partial.Length -gt $maxArchive) {
        [IO.File]::Delete($Path)
        $partial = $null
    }
    if ($partial -and (Get-Sha256 $Path) -ceq $Expected) { return }
    if ($partial -and $partial.Length -gt 0) {
        Write-Host 'Resuming the Mosaic download...'
        & $curl @common --continue-at - -- $Uri.AbsoluteUri
        $resume = $LASTEXITCODE
        if ($resume -eq 0 -and (Get-Sha256 $Path) -ceq $Expected) { return }
        if ($resume -notin @(0, 22, 33, 36)) { throw 'Mosaic download interrupted. Rerun the same command to resume.' }
        [IO.File]::Delete($Path)
    }
    Write-Host 'Downloading Mosaic...'
    & $curl @common -- $Uri.AbsoluteUri
    if ($LASTEXITCODE -ne 0) { throw 'Mosaic download interrupted. Rerun the same command to resume.' }
    if (-not (Get-PlainItem $Path) -or (Get-Sha256 $Path) -cne $Expected) {
        if (Get-PlainItem $Path) { [IO.File]::Delete($Path) }
        throw 'Mosaic archive checksum mismatch.'
    }
}

function Read-ZipEntry($Entry, [long] $Limit, [IO.Stream] $Output) {
    if ($Entry.Length -gt $Limit) { throw 'A Mosaic archive entry exceeds its size limit.' }
    $reader = $Entry.Open()
    try {
        $bytes = New-Object byte[] 65536
        [long] $length = 0
        while (($count = $reader.Read($bytes, 0, $bytes.Length)) -gt 0) {
            $length += $count
            if ($length -gt $Limit -or $length -gt $Entry.Length) { throw 'A Mosaic archive entry expanded beyond its declared size.' }
            $Output.Write($bytes, 0, $count)
        }
        if ($length -ne $Entry.Length) { throw 'A Mosaic archive entry is incomplete.' }
    } finally { $reader.Dispose() }
}

function Read-Inventory($Manifest, [string] $ExpectedVersion) {
    if ($Manifest.schema -ne 1 -or $Manifest.platform -cne 'win32' -or $Manifest.arch -cne 'x64' -or
        $Manifest.layout -cne 'windows-beta-v1' -or $Manifest.version -cne $ExpectedVersion -or
        $Manifest.nodeVersion -cne '24.22.3' -or $Manifest.contentHash -cnotmatch $hexPattern -or
        $Manifest.files.Count -lt 1 -or $Manifest.files.Count -gt 9999) { throw 'Invalid Mosaic package manifest.' }
    $files = @{}
    $folders = @{}
    [long] $total = 0
    foreach ($file in $Manifest.files) {
        $name = $file.path
        $parts = $name -split '/'
        if ($name -isnot [string] -or $name.Length -gt 220 -or $name -ieq 'package-manifest.json' -or
            $file.sha256 -cnotmatch $hexPattern -or $file.bytes -isnot [ValueType] -or
            $file.bytes -lt 0 -or $file.bytes -gt $maxFile -or $file.bytes -ne [long]$file.bytes) { throw 'Invalid Mosaic archive inventory record.' }
        $prefix = ''
        for ($i = 0; $i -lt $parts.Count; $i++) {
            $part = $parts[$i]
            if ($part -cnotmatch '^[A-Za-z0-9._+@-]{1,100}$' -or $part.EndsWith('.') -or
                $part -match '^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw "Invalid Mosaic archive path: $name" }
            $prefix = if ($prefix) { $prefix + '/' + $part } else { $part }
            if ($files.ContainsKey($prefix) -or ($folders.ContainsKey($prefix) -and ($folders[$prefix] -cne $prefix -or $i -eq $parts.Count - 1))) {
                throw "Conflicting Mosaic archive path: $name"
            }
            if ($i -lt $parts.Count - 1) { $folders[$prefix] = $prefix }
        }
        $files[$name] = $file
        $total += $file.bytes
        if ($total -gt $maxArchive) { throw 'The Mosaic inventory exceeds its expansion limit.' }
    }
    foreach ($required in @('runtime/bin/node.exe', 'runtime/src/beta/cli.mjs', 'runtime/check-artifact/node.exe',
            'runtime/check-artifact/mosaic-windows-supervisor.exe', 'runtime/check-artifact/artifact-manifest.json',
            'distribution/windows/mosaic.exe', 'distribution/windows/guide.ps1', 'distribution/windows/lifecycle.mjs',
            'distribution/windows/install.ps1', 'distribution/windows/maintenance.mjs',
            'distribution/onboarding/windows-host.mjs')) {
        if (-not $files.ContainsKey($required) -or $files[$required].path -cne $required) { throw 'The Windows release payload is incomplete.' }
    }
    return @{Files = $files; Folders = $folders}
}

function Test-VersionDirectory([string] $Path, [string] $ManifestHash, [string] $ExpectedVersion) {
    if (-not (Get-PlainItem $Path -Directory)) { throw 'The selected Mosaic version directory is missing.' }
    $manifestFile = Join-Path $Path 'package-manifest.json'
    $manifest = Read-JsonFile $manifestFile $maxManifest
    if (-not $manifest -or (Get-Sha256 $manifestFile) -cne $ManifestHash) { throw 'Mosaic package manifest checksum mismatch.' }
    $inventory = Read-Inventory $manifest $ExpectedVersion
    $seen = @{}
    $directories = New-Object 'Collections.Generic.Stack[object]'
    $directories.Push(@{Path = $Path; Relative = ''})
    while ($directories.Count) {
        $directory = $directories.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory.Path -Force) {
            $relative = if ($directory.Relative) { $directory.Relative + '/' + $item.Name } else { $item.Name }
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Unsafe installed Mosaic path: $relative" }
            if ($item.PSIsContainer) {
                if (-not $inventory.Folders.ContainsKey($relative) -or $inventory.Folders[$relative] -cne $relative) { throw "Unexpected Mosaic directory: $relative" }
                $directories.Push(@{Path = $item.FullName; Relative = $relative})
            } elseif ($relative -cne 'package-manifest.json') {
                $record = $inventory.Files[$relative]
                if (-not $record -or $record.path -cne $relative -or $record.bytes -ne $item.Length -or
                    (Get-Sha256 $item.FullName) -cne $record.sha256) { throw "Unverified installed Mosaic file: $relative" }
                $seen[$relative] = $true
            }
        }
    }
    if ($seen.Count -ne $inventory.Files.Count) { throw 'The installed Mosaic version is incomplete.' }
    return $manifest
}

function Test-Record($Record) {
    if ($Record.schema -ne 1 -or $Record.platform -cne 'win32-x64' -or $Record.version -cnotmatch $versionPattern -or
        $Record.archiveSha256 -cnotmatch $hexPattern -or $Record.manifestSha256 -cnotmatch $hexPattern -or
        $Record.launcherHash -cnotmatch $hexPattern -or $Record.contentHash -cnotmatch $hexPattern) {
        throw 'The Mosaic installation receipt is invalid. Preserve it for inspection.'
    }
}

function Test-SameRecord($First, $Second) {
    if (-not $First -or -not $Second) { return (-not $First -and -not $Second) }
    return ($First.version -ceq $Second.version -and $First.archiveSha256 -ceq $Second.archiveSha256 -and
        $First.manifestSha256 -ceq $Second.manifestSha256 -and $First.launcherHash -ceq $Second.launcherHash -and
        $First.contentHash -ceq $Second.contentHash)
}

function Test-RetainedVersion([string] $Versions, $Record) {
    Test-Record $Record
    $target = Join-Path $Versions $Record.version
    $manifest = Test-VersionDirectory $target $Record.manifestSha256 $Record.version
    if ($manifest.contentHash -cne $Record.contentHash) { throw 'The retained Mosaic version no longer matches its receipt.' }
    return $manifest
}

function Save-VersionReceipt([string] $History, $Record) {
    if (-not $Record) { return }
    Test-Record $Record
    $file = Join-Path $History ($Record.version + '.json')
    $existing = Read-JsonFile $file 8192
    if ($existing) {
        if (-not (Test-SameRecord $existing $Record)) { throw 'A retained Mosaic version has a conflicting receipt.' }
    } else { Write-JsonFile $file $Record }
}

function Complete-Uninstall($Record, [string] $Pointer, [string] $Launcher, [string] $Backup, [string] $Disabled) {
    if (Get-PlainItem $Launcher) {
        if ((Get-Sha256 $Launcher) -cne $Record.launcherHash) { throw 'The stable launcher changed during uninstall.' }
        if (Get-PlainItem $Backup) {
            if ((Get-Sha256 $Backup) -cne $Record.launcherHash) { throw 'The retained launcher backup changed.' }
        } else { Write-Atomic $Backup ([IO.File]::ReadAllBytes($Launcher)) }
    } elseif (-not (Get-PlainItem $Backup) -or (Get-Sha256 $Backup) -cne $Record.launcherHash) {
        throw 'Mosaic could not verify the owned launcher backup.'
    }
    Write-JsonFile $Disabled $Record
    if (Get-PlainItem $Pointer) { [IO.File]::Delete($Pointer) }
    if (Get-PlainItem $Launcher) {
        try { [IO.File]::Delete($Launcher) }
        catch [UnauthorizedAccessException], [IO.IOException] {
            Write-Host 'Windows has the launcher open. It remains inactive and can be removed after closing Mosaic.'
        }
    }
}

function Expand-Release([string] $File, [string] $Destination) {
    $item = Get-PlainItem $File
    if (-not $item -or $item.Length -gt $maxArchive) { throw 'The Mosaic archive is unavailable or too large.' }
    $archiveHandle = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ((Get-StreamSha256 $archiveHandle) -cne $ArchiveSha256) { throw 'Mosaic archive checksum mismatch.' }
        $archiveHandle.Position = 0
        $zip = New-Object IO.Compression.ZipArchive($archiveHandle, [IO.Compression.ZipArchiveMode]::Read, $true)
        try {
            $meta = $zip.GetEntry('package-manifest.json')
            if (-not $meta -or $zip.Entries.Count -gt 10000) { throw 'Invalid Mosaic archive inventory.' }
            $memory = New-Object IO.MemoryStream
            try {
                Read-ZipEntry $meta $maxManifest $memory
                $manifestBytes = $memory.ToArray()
            } finally { $memory.Dispose() }
            $manifest = $utf8.GetString($manifestBytes) | ConvertFrom-Json
            $inventory = Read-Inventory $manifest $Version
            if ($zip.Entries.Count -ne $inventory.Files.Count + 1) { throw 'Mosaic archive entries differ from the manifest.' }
            if (Get-PlainItem $Destination -Directory) { throw 'The install staging path is already present.' }
            [IO.Directory]::CreateDirectory($Destination) | Out-Null
            $seen = @{}
            foreach ($entry in $zip.Entries) {
                $name = $entry.FullName
                if ($entry.ExternalAttributes -ne 0 -or $seen.ContainsKey($name)) { throw "Invalid Mosaic ZIP member: $name" }
                $seen[$name] = $true
                if ($name -ceq 'package-manifest.json') { continue }
                $record = $inventory.Files[$name]
                if (-not $record -or $name -cne $record.path -or $record.bytes -ne $entry.Length) { throw "Unexpected Mosaic ZIP member: $name" }
                $target = Join-Path $Destination ($name.Replace('/', '\'))
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
                $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { Read-ZipEntry $entry $maxFile $output; $output.Flush($true) }
                finally { $output.Dispose() }
                if ((Get-Sha256 $target) -cne $record.sha256) { throw "Mosaic ZIP member checksum mismatch: $name" }
            }
            $manifestFile = Join-Path $Destination 'package-manifest.json'
            Write-Atomic $manifestFile $manifestBytes
            return @{
                ManifestSha256 = Get-Sha256 $manifestFile
                LauncherSha256 = $inventory.Files['distribution/windows/mosaic.exe'].sha256
                ContentHash = $manifest.contentHash
            }
        } finally { $zip.Dispose() }
    } finally { $archiveHandle.Dispose() }
}

function Compare-Version([string] $One, [string] $Two) {
    $first = $One.Split('-')
    $second = $Two.Split('-')
    $base = ([version]$first[0]).CompareTo([version]$second[0])
    if ($base -ne 0) { return $base }
    if ($first.Count -ne $second.Count) { return $second.Count - $first.Count }
    if ($first.Count -eq 1) { return 0 }
    return ([int]$first[1].Substring(5)).CompareTo([int]$second[1].Substring(5))
}

function Invoke-Lifecycle([string] $Directory, [string] $Action, [int[]] $Allowed) {
    $node = Join-Path $Directory 'runtime\bin\node.exe'
    $command = Join-Path $Directory 'distribution\windows\lifecycle.mjs'
    $oldOptions, $oldPath = $env:NODE_OPTIONS, $env:NODE_PATH
    try {
        $env:NODE_OPTIONS = $null
        $env:NODE_PATH = $null
        & $node $command $Action | Out-Host
        if ($LASTEXITCODE -notin $Allowed) { throw "Mosaic lifecycle command failed: $Action. Rerun the same verified install to recover." }
        return $LASTEXITCODE
    } finally {
        $env:NODE_OPTIONS = $oldOptions
        $env:NODE_PATH = $oldPath
    }
}

if ($env:OS -ne 'Windows_NT' -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or
    -not [Environment]::Is64BitProcess -or [Environment]::OSVersion.Version.Build -lt 22000) {
    throw 'Use native 64-bit PowerShell on Windows 11 x64.'
}
Add-Type -AssemblyName System.IO.Compression
if ($ArchiveSha256) { $ArchiveSha256 = $ArchiveSha256.ToLowerInvariant() }
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
Assert-LocalPath $local
$root = Join-Path $local 'Mosaic Beta'
if ($Maintenance -and -not (Get-PlainItem $root -Directory)) { throw 'Mosaic installation is unavailable.' }
Initialize-Root $root
$lockPath = Join-Path $root 'install.lock'
Get-PlainItem $lockPath | Out-Null

$lockMode = if ($Maintenance -eq 'verify') { [IO.FileMode]::Open } else { [IO.FileMode]::OpenOrCreate }
try { $lock = [IO.File]::Open($lockPath, $lockMode, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
catch { throw 'Mosaic installation or startup is already in progress. Close duplicate installers and retry.' }
try {
    $bin = (Get-PlainDirectory (Join-Path $root 'bin')).FullName
    $versions = (Get-PlainDirectory (Join-Path $root 'versions')).FullName
    $config = (Get-PlainDirectory (Join-Path $root 'config')).FullName
    $cache = (Get-PlainDirectory (Join-Path $root 'downloads')).FullName
    $history = (Get-PlainDirectory (Join-Path $config 'installed-versions')).FullName
    $launcher = Join-Path $bin 'mosaic.exe'
    $receiptPath = Join-Path $config 'installation.json'
    $intentPath = Join-Path $root 'install-intent.json'
    $pointerPath = Join-Path $root 'current-version.txt'
    $disabledPath = Join-Path $config 'installation-disabled.json'
    $backupPath = Join-Path $config 'retained-launcher.exe'
    $receipt = Read-JsonFile $receiptPath 8192
    if ($receipt) { Test-Record $receipt }
    $intent = Read-JsonFile $intentPath 32768
    $disabled = Read-JsonFile $disabledPath 8192
    if ($disabled) { Test-Record $disabled }
    $current = $null
    $pointer = Get-PlainItem $pointerPath
    if ($pointer) {
        if ($pointer.Length -gt 64) { throw 'The Mosaic version pointer is invalid.' }
        $pointerText = $utf8.GetString([IO.File]::ReadAllBytes($pointerPath))
        $current = $pointerText.TrimEnd([char]10)
        if ($current -cnotmatch $versionPattern -or $pointerText -cne ($current + [char]10)) { throw 'The Mosaic version pointer is invalid.' }
    }
    $launcherHash = if (Get-PlainItem $launcher) { Get-Sha256 $launcher } else { $null }
    $inactive = $disabled -and -not $current -and (Test-SameRecord $disabled $receipt) -and
        (-not $launcherHash -or $launcherHash -ceq $receipt.launcherHash)
    $active = $receipt -and $current -ceq $receipt.version -and $launcherHash -ceq $receipt.launcherHash -and -not $disabled

    if ($Maintenance -eq 'verify') {
        if (-not $active -or $intent) { throw 'The active Windows installation is incomplete.' }
        Test-RetainedVersion $versions $receipt | Out-Null
        return
    }
    $resumeUninstall = $intent.operation -eq 'uninstall' -and
        ($Maintenance -eq 'recover' -or (-not $Maintenance -and $Version -ceq $intent.previous.version -and
            $ArchiveSha256 -ceq $intent.previous.archiveSha256))
    if ($Maintenance -eq 'uninstall' -or $resumeUninstall) {
        if ($TargetVersion) { throw 'Uninstall does not take a version.' }
        if (-not $intent) {
            if ($inactive) { Write-Host 'Mosaic is already inactive. Its saved data and releases are retained.'; return }
            if (-not $active) { throw 'Existing Mosaic install bindings are missing or changed.' }
            $intent = [ordered]@{schema = 1; operation = 'uninstall'; previous = $receipt}
            Write-JsonFile $intentPath $intent
        }
        if ($intent.schema -ne 1 -or $intent.operation -cne 'uninstall' -or -not (Test-SameRecord $receipt $intent.previous) -or
            ($current -and $current -cne $intent.previous.version) -or ($disabled -and -not (Test-SameRecord $disabled $receipt)) -or
            ($launcherHash -and $launcherHash -cne $intent.previous.launcherHash)) { throw 'Uninstall recovery bindings have changed.' }
        Test-RetainedVersion $versions $intent.previous | Out-Null
        Save-VersionReceipt $history $intent.previous
        $old = Join-Path $versions $intent.previous.version
        try { Invoke-Lifecycle $old 'prepare-uninstall' @(0) | Out-Null }
        catch {
            if ($active) { [IO.File]::Delete($intentPath) }
            throw
        }
        Complete-Uninstall $intent.previous $pointerPath $launcher $backupPath $disabledPath
        [IO.File]::Delete($intentPath)
        Write-Host 'Mosaic was deactivated for this user. Its saved data and releases are retained.'
        if ($Maintenance) { return }
        $intent = $null
        $current = $null
        $disabled = $receipt
        $inactive = $true
        $active = $false
        $launcherHash = if (Get-PlainItem $launcher) { Get-Sha256 $launcher } else { $null }
    }
    if ($Maintenance -eq 'rollback') {
        if ($TargetVersion -cnotmatch $versionPattern -or -not $active -or $intent -or (Compare-Version $TargetVersion $current) -ge 0) {
            throw 'Choose an older retained version while the current installation is healthy.'
        }
        $oldManifest = Test-RetainedVersion $versions $receipt
        $selected = Read-JsonFile (Join-Path $history ($TargetVersion + '.json')) 8192
        if (-not $selected -or $selected.version -cne $TargetVersion -or $selected.launcherHash -cne $launcherHash) {
            throw 'The requested rollback version has no matching retained receipt.'
        }
        $selectedManifest = Test-RetainedVersion $versions $selected
        if ($oldManifest.nativeCheckArtifact.fingerprint -cne $selectedManifest.nativeCheckArtifact.fingerprint) {
            throw 'Rollback requires a compatible protected-check artifact. The existing installation was preserved.'
        }
        $Version = $selected.version
        $ArchiveSha256 = $selected.archiveSha256
        $intent = [ordered]@{schema = 1; operation = 'rollback'; previous = $receipt; target = $selected}
        Write-JsonFile $intentPath $intent
    }
    if ($Maintenance -eq 'recover') {
        if ($TargetVersion) { throw 'Recovery uses the saved version and takes no version argument.' }
        if ($intent) {
            Test-Record $intent.target
            $Version = $intent.target.version
            $ArchiveSha256 = $intent.target.archiveSha256
        } elseif ($active) {
            $Version = $receipt.version
            $ArchiveSha256 = $receipt.archiveSha256
        } else { throw 'No active release can be recovered. Run its verified install command.' }
    }
    $target = Join-Path $versions $Version

    if ($intent) {
        if ($intent.schema -ne 1 -or $intent.operation -notin @($null, 'install', 'rollback') -or
            $intent.target.version -cne $Version -or $intent.target.archiveSha256 -cne $ArchiveSha256) {
            throw 'Finish the pending Mosaic installation using its original verified command before choosing another version.'
        }
        Test-Record $intent.target
        if ($intent.previous) { Test-Record $intent.previous }
        $pendingReinstall = -not $current -and $disabled -and (Test-SameRecord $disabled $intent.previous)
        if (($current -notin @($intent.previous.version, $Version) -and -not $pendingReinstall) -or
            (-not (Test-SameRecord $receipt $intent.previous) -and -not (Test-SameRecord $receipt $intent.target)) -or
            ($current -and -not $launcherHash) -or
            ($launcherHash -and $launcherHash -notin @($intent.previous.launcherHash, $intent.target.launcherHash))) {
            throw 'Mosaic installation bindings changed while recovery was pending.'
        }
        $manifest = Test-VersionDirectory $target $intent.target.manifestSha256 $Version
        if ($manifest.contentHash -cne $intent.target.contentHash) { throw 'The interrupted install target no longer matches its receipt.' }
    } else {
        if (($receipt -and -not $active -and -not $inactive) -or (-not $receipt -and ($current -or $launcherHash -or $disabled))) {
            throw 'Existing Mosaic install bindings are missing or changed.'
        }
        if ($receipt -and (Compare-Version $Version $receipt.version) -lt 0) { throw 'This command would downgrade Mosaic. Use its supported rollback flow.' }
        if ($current -ceq $Version) {
            if ($receipt.archiveSha256 -cne $ArchiveSha256) { throw 'This installed version has different release bytes. Choose a newer version.' }
            $manifest = Test-VersionDirectory $target $receipt.manifestSha256 $Version
            if ($manifest.contentHash -cne $receipt.contentHash) { throw 'The installed version no longer matches its receipt.' }
        } elseif ($inactive -and $receipt.version -ceq $Version) {
            if ($receipt.archiveSha256 -cne $ArchiveSha256) { throw 'This retained version has different release bytes.' }
            Test-RetainedVersion $versions $receipt | Out-Null
            $intent = [ordered]@{schema = 1; operation = 'install'; previous = $receipt; target = $receipt}
            Write-JsonFile $intentPath $intent
        } else {
            if ($receipt) {
                $old = Join-Path $versions $receipt.version
                $oldManifest = Test-VersionDirectory $old $receipt.manifestSha256 $receipt.version
                if ($oldManifest.contentHash -cne $receipt.contentHash) { throw 'The previous version no longer matches its receipt.' }
            }
            if ($PSCmdlet.ParameterSetName -eq 'Download') {
                $archivePath = Join-Path $cache ($ArchiveSha256 + '.part')
                Get-Archive $archivePath $ArchiveUri $ArchiveSha256
            } else { $archivePath = [IO.Path]::GetFullPath($Archive) }
            $incoming = Join-Path $versions ('.incoming-' + [guid]::NewGuid().ToString('N'))
            try {
                $verification = Expand-Release $archivePath $incoming
                if (Get-PlainItem $target -Directory) { Test-VersionDirectory $target $verification.ManifestSha256 $Version | Out-Null }
                else { [IO.Directory]::Move($incoming, $target) }
            } finally {
                if (Get-PlainItem $incoming -Directory) { [IO.Directory]::Delete($incoming, $true) }
            }
            $newReceipt = [ordered]@{schema = 1; platform = 'win32-x64'; version = $Version; archiveSha256 = $ArchiveSha256;
                manifestSha256 = $verification.ManifestSha256; contentHash = $verification.ContentHash; launcherHash = $verification.LauncherSha256}
            if ($receipt) { $newReceipt.launcherHash = $receipt.launcherHash }
            $intent = [ordered]@{schema = 1; operation = 'install'; previous = $receipt; target = $newReceipt}
            Write-JsonFile $intentPath $intent
        }
    }
    if ($intent) {
        if ($intent.previous -and $current -ceq $intent.previous.version) {
            $old = Join-Path $versions $intent.previous.version
            Test-VersionDirectory $old $intent.previous.manifestSha256 $intent.previous.version | Out-Null
            try { Invoke-Lifecycle $old 'prepare-update' @(0) | Out-Null }
            catch {
                if (Test-SameRecord $receipt $intent.previous) { [IO.File]::Delete($intentPath) }
                throw
            }
        }
        Save-VersionReceipt $history $intent.previous
        Save-VersionReceipt $history $intent.target
        if (-not $launcherHash) {
            $launchSource = if (Get-PlainItem $backupPath) { $backupPath } else { Join-Path $target 'distribution\windows\mosaic.exe' }
            if ((Get-Sha256 $launchSource) -cne $intent.target.launcherHash) { throw 'The retained launcher no longer matches its receipt.' }
            $launcherBytes = [IO.File]::ReadAllBytes($launchSource)
            Write-Atomic $launcher $launcherBytes
        }
        if ((Get-Sha256 $launcher) -cne $intent.target.launcherHash) { throw 'The stable Mosaic launcher does not match its receipt.' }
        Write-JsonFile $receiptPath $intent.target
        Write-Atomic $pointerPath ($utf8.GetBytes($Version + [char]10))
        if (Get-PlainItem $disabledPath) { [IO.File]::Delete($disabledPath) }
        [IO.File]::Delete($intentPath)
    } else { Save-VersionReceipt $history $receipt }
} finally { $lock.Dispose() }

if (($env:Path -split ';') -notcontains $bin) { $env:Path = $bin + ';' + $env:Path }
Write-Host "Mosaic $Version installed for this user."
if ($NoGuide -or $Maintenance) { Invoke-Lifecycle $target 'ensure-ready' @(0, 3) | Out-Null; return }
$guide = Join-Path $target 'distribution\windows\guide.ps1'
& ([ScriptBlock]::Create([IO.File]::ReadAllText($guide))) -VersionDirectory $target -Launcher $launcher
