# Activate a locally downloaded, digest-pinned coding-core archive in Windows PowerShell 5.1 or 7.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string] $Archive, [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string] $Sha256)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$root = Join-Path $env:LOCALAPPDATA 'Mosaic'
$versions = Join-Path $root 'versions'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function PrivateDirectory([string] $Path) {
    if (![IO.Directory]::Exists($Path)) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetOwner($sid)
        $acl.SetAccessRuleProtection($true, $false)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
        $dir = New-Object IO.DirectoryInfo($Path)
        if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::Create($dir,$acl) }
        else { $dir.Create($acl) }
    }
    $dir = New-Object IO.DirectoryInfo($Path)
    if ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected core directory redirection' }
    if ($PSVersionTable.PSEdition -eq 'Core') { $acl = [IO.FileSystemAclExtensions]::GetAccessControl($dir) }
    else { $acl = $dir.GetAccessControl() }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Existing core directory has a different owner' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')) { throw 'Existing core directory is shared with another account' }
    }
}
function PlainFiles([string] $Directory) {
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Directory)
    while ($pending.Count) {
        foreach ($item in [IO.Directory]::EnumerateFileSystemEntries($pending.Pop())) {
            $attrs = [IO.File]::GetAttributes($item)
            if ($attrs -band [IO.FileAttributes]::ReparsePoint) { throw 'Retained core contains a reparse point' }
            if ($attrs -band [IO.FileAttributes]::Directory) { $pending.Push($item) } else { $item }
        }
    }
}
PrivateDirectory $root
PrivateDirectory $versions
$blob = [IO.File]::Open([IO.Path]::GetFullPath($Archive),'Open','Read','Read')
$hasher = [Security.Cryptography.SHA256]::Create()
$stage = Join-Path $versions ('.incoming-' + [guid]::NewGuid().ToString('N'))
try {
    $actual = [BitConverter]::ToString($hasher.ComputeHash($blob)).Replace('-','').ToLowerInvariant()
    if ($actual -ine $Sha256) { throw 'Core archive SHA-256 mismatch' }
    $blob.Position = 0
    $zip = New-Object IO.Compression.ZipArchive($blob, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        PrivateDirectory $stage
        foreach ($entry in $zip.Entries) {
            $parts = $entry.FullName.Split('/')
            foreach ($part in $parts) {
                if ($part -notmatch '^[a-zA-Z0-9._@+-]{1,100}$' -or $part.EndsWith('.') -or $part -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)') { throw 'Unsupported core archive path' }
            }
            $to = Join-Path $stage $entry.FullName
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))
            $out = [IO.File]::Open($to,'CreateNew','Write','None')
            try { $inputStream=$entry.Open(); try { $inputStream.CopyTo($out) } finally { $inputStream.Dispose() } } finally { $out.Dispose() }
        }
    } finally { $zip.Dispose() }
    $final = Join-Path $versions $actual
    $locator = Join-Path $root 'active-core.json'
    $utf8 = New-Object Text.UTF8Encoding($false)
    # Retained versions never replace existing files. Verify existing bytes before reselecting them.
    if ([IO.Directory]::Exists($final)) {
        PrivateDirectory $final
        $sourceFiles = @(PlainFiles $stage)
        if (@(PlainFiles $final).Count -ne $sourceFiles.Count) { throw 'Retained core inventory differs' }
        foreach ($source in $sourceFiles) {
            $other = $final + $source.Substring($stage.Length)
            $original = [IO.File]::OpenRead($source)
            try { $expected = [BitConverter]::ToString($hasher.ComputeHash($original)) } finally { $original.Dispose() }
            $copy = [IO.File]::OpenRead($other)
            try { if ($expected -cne [BitConverter]::ToString($hasher.ComputeHash($copy))) { throw 'Retained core version changed' } } finally { $copy.Dispose() }
        }
    } else { [IO.Directory]::Move($stage,$final) }
    $stable = Join-Path $root 'mosaic-core.ps1'
    $template = Join-Path $final 'distribution/windows-core/mosaic-core.ps1'
    if ([IO.File]::Exists($stable)) {
        if (([IO.File]::GetAttributes($stable) -band [IO.FileAttributes]::ReparsePoint) -or
            [Convert]::ToBase64String([IO.File]::ReadAllBytes($stable)) -cne [Convert]::ToBase64String([IO.File]::ReadAllBytes($template))) { throw 'Existing core launcher differs. Preserve the existing binding.' }
    } else { [IO.File]::Copy($template,$stable,$false) }
    $pointer = Join-Path $root ('.pointer-' + [guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($pointer,(ConvertTo-Json @{archiveSha256=$actual}),$utf8)
    if ([IO.File]::Exists($locator)) { [IO.File]::Replace($pointer,$locator,$null) } else { [IO.File]::Move($pointer,$locator) }
    Write-Output "Core installed at $final"
    Write-Output "Core launcher: $stable"
    Write-Output "Coding-app skills directory: $final\skills"
} finally {
    $hasher.Dispose()
    $blob.Dispose()
    if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage,$true) }
}
