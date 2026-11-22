[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $VersionDirectory,
    [Parameter(Mandatory)] [string] $Launcher
)

$ErrorActionPreference = 'Stop'
$node = Join-Path $VersionDirectory 'runtime\bin\node.exe'
$lifecycle = Join-Path $VersionDirectory 'distribution\windows\lifecycle.mjs'
$hostGuide = Join-Path $VersionDirectory 'distribution\onboarding\windows-host.mjs'
$local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$user = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)

function Invoke-GuideStep([string] $Executable, [string[]] $Arguments, [int[]] $Allowed = @(0)) {
    & $Executable @Arguments | Out-Host
    if ($LASTEXITCODE -notin $Allowed) { throw 'Mosaic onboarding stopped. Rerun the same install command to resume.' }
    return $LASTEXITCODE
}

function Invoke-InteractiveStep([string] $Executable, [string[]] $Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Mosaic onboarding stopped. Rerun the same install command to resume.' }
}

function Get-GitConfigHash([string] $Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)) }
    finally { $stream.Dispose(); $sha.Dispose() }
}

function Get-Git {
    $candidates = @((Join-Path $local 'Programs\Git\cmd\git.exe'))
    foreach ($root in @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))) {
        if ($root) { $candidates += Join-Path $root 'Git\cmd\git.exe' }
    }
    foreach ($candidate in $candidates) {
        $item = Get-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
        if ($item -and -not $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            $reply = & $item.FullName --version 2>$null
            if ($LASTEXITCODE -eq 0 -and $reply -match '^git version \d') { return $item.FullName }
        }
    }
    return $null
}

function Install-GitForWindows {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Write-Host 'Open PowerShell as your normal user for automatic Git installation.'
            return $false
        }
    } finally { $identity.Dispose() }

    $url = 'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/Git-2.56.1-64-bit.exe'
    $sha256 = 'c330c72e10b408cc39994bfefdb63542b0d93d21699325c3e0bd874af8a5a559'
    $stage = Join-Path (Join-Path $local 'Mosaic Beta') ('git-setup-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $stage | Out-Null
        $installer = Join-Path $stage 'Git-for-Windows.exe'
        $destination = Join-Path $local 'Programs\Git'
        $curl = Join-Path ([Environment]::SystemDirectory) 'curl.exe'
        Write-Host 'Downloading the Git for Windows installer…'
        $download = @('-q', '--fail', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
            '--connect-timeout', '20', '--max-time', '900', '--max-filesize', '66870448', '--output', $installer, '--', $url)
        & $curl @download | Out-Host
        if ($LASTEXITCODE -ne 0) { return $false }
        if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $sha256) {
            Write-Host 'Git for Windows installer checksum did not match.'
            return $false
        }
        Write-Host 'Installing Git for Windows for this user…'
        $process = Start-Process -FilePath $installer -WorkingDirectory $stage -Wait -PassThru -ArgumentList @(
            '/SILENT', '/SP-', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCLOSEAPPLICATIONS', ('/DIR="' + $destination + '"')
        )
        return $process.ExitCode -eq 0
    } catch {
        return $false
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Require-Git {
    $installed = Get-Git
    if ($installed) { return $installed }
    Write-Host 'Mosaic uses Git for Windows to prepare a project and verify its changes.'
    do {
        $answer = (Read-Host 'Install Git for Windows for this user now? [y/N]').Trim()
    } until ($answer -match '^(y(es)?|n(o)?)?$')
    if ($answer -match '^y(es)?$') {
        if (Install-GitForWindows) {
            $installed = Get-Git
            if ($installed) { return $installed }
        }
        Write-Host 'Automatic Git installation did not finish. You can install Git manually.'
    }
    Write-Host 'Git for Windows manual install: https://git-scm.com/install/windows'
    while ($true) {
        $answer = (Read-Host 'After installing Git, recheck here or continue setup without Git [recheck/later]').Trim()
        if ($answer -eq 'later') { return $null }
        if ($answer -eq 'recheck') {
            $installed = Get-Git
            if ($installed) { return $installed }
            Write-Host 'Git is still missing. Choose the default installation folder in the Git installer.'
        }
    }
}

function Copy-PublicRepository([string] $Git, [string] $Uri, [string] $Destination) {
    $overrides = @{}
    foreach ($entry in Get-ChildItem Env:) {
        if ($entry.Name -match '^GIT_') {
            $overrides[$entry.Name] = $entry.Value
            [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
        }
    }
    try {
        $env:GIT_CONFIG_NOSYSTEM = '1'
        $env:GIT_CONFIG_GLOBAL = 'NUL'
        $env:GIT_TERMINAL_PROMPT = '0'
        $arguments = @('-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'credential.helper=',
            '-c', 'http.followRedirects=false', 'clone', '--template=', '--no-recurse-submodules', '--', $Uri, $Destination)
        & $Git @arguments | Out-Host
        return $LASTEXITCODE -eq 0
    } finally {
        foreach ($name in @('GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT')) {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
        foreach ($name in $overrides.Keys) { [Environment]::SetEnvironmentVariable($name, $overrides[$name], 'Process') }
    }
}

function Select-Repository([string] $Git, [string] $OriginalDirectory) {
    while ($true) {
        $project = (Read-Host 'Git project folder or public GitHub HTTPS URL (Enter uses this folder, q exits)').Trim()
        if ($project -eq 'q') { return $null }
        if (-not $project) { $project = $OriginalDirectory }
        if ($project -match '^https://github\.com/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+/?$') {
            $repoName = $project.TrimEnd('/').Split('/')[-1] -replace '\.git$', ''
            if ($repoName -in @('', '.', '..') -or $repoName.EndsWith('.')) { Write-Host 'Enter a public GitHub repository URL.'; continue }
            $destination = Join-Path $OriginalDirectory $repoName
            $suggested = (Read-Host "Clone into $destination? [y/N]").Trim()
            if ($suggested -notmatch '^y(es)?$') { continue }
            if (Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue) { Write-Host 'That clone destination already exists.'; continue }
            if (-not (Copy-PublicRepository $Git $project $destination)) {
                Write-Host 'The clone did not complete. Check the URL or choose an existing checkout.'
                continue
            }
            $project = $destination
        }
        $folder = Get-Item -LiteralPath $project -ErrorAction SilentlyContinue
        if (-not $folder -or -not $folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Write-Host 'Choose an accessible folder inside a committed Git repository.'
            continue
        }
        $repo = & $Git -C $folder.FullName -c core.fsmonitor=false rev-parse --show-toplevel 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Host 'Choose a Git repository with at least one commit.'; continue }
        & $Git -C $repo -c core.fsmonitor=false rev-parse --verify 'HEAD^{commit}' 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Host 'Choose a Git repository with at least one commit.'; continue }
        return [IO.Path]::GetFullPath($repo)
    }
}

function Save-GitIdentity([string] $Git, [string] $Repo, $Values) {
    $common = & $Git -C $Repo -c core.fsmonitor=false rev-parse --path-format=absolute --git-common-dir
    if ($LASTEXITCODE -ne 0 -or -not [IO.Path]::IsPathRooted($common)) { throw 'Git metadata is unavailable.' }
    for ($directory = [IO.Path]::GetFullPath($common); $directory; $directory = [IO.Path]::GetDirectoryName($directory)) {
        $item = Get-Item -LiteralPath $directory -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Use Git directly to configure author identity for this checkout.'
        }
    }
    $config = Join-Path $common 'config'
    $lockPath = $config + '.lock'
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $committed = $false
    try {
        $item = Get-Item -LiteralPath $config -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.LinkType -eq 'HardLink' -or $item.Length -gt 1048576) { throw 'Unsafe Git config; set the author fields using Git.' }
        $before = Get-GitConfigHash $config
        $valuesToWrite = [ordered]@{}
        foreach ($key in @('user.name', 'user.email')) {
            if (-not $Values.ContainsKey($key)) { continue }
            $existing = & $Git -C $Repo -c core.fsmonitor=false config --no-includes --get $key
            if ($LASTEXITCODE -eq 0 -and $existing) { continue }
            if ($LASTEXITCODE -ne 1) { throw 'The project Git configuration changed. Review it before resuming.' }
            $valuesToWrite[$key] = $Values[$key]
        }
        if ($valuesToWrite.Count -eq 0) { return }
        $prior = [IO.File]::ReadAllBytes($config)
        $extra = [string][char]10 + '[user]' + [char]10
        foreach ($key in $valuesToWrite.Keys) {
            $value = $valuesToWrite[$key].Replace('\', '\\').Replace('"', '\"')
            $extra += '    ' + $key.Substring(5) + ' = "' + $value + '"' + [char]10
        }
        $bytes = [Text.Encoding]::UTF8.GetBytes($extra)
        $lock.Write($prior, 0, $prior.Length)
        $lock.Write($bytes, 0, $bytes.Length)
        $lock.Flush($true)
        $lock.Dispose()
        foreach ($key in $valuesToWrite.Keys) {
            $saved = & $Git config --file $lockPath --no-includes --get $key
            if ($LASTEXITCODE -ne 0 -or $saved -cne $valuesToWrite[$key]) { throw 'Could not verify the proposed Git author value.' }
        }
        if ((Get-GitConfigHash $config) -cne $before) { throw 'Git author settings changed during setup.' }
        [IO.File]::Replace($lockPath, $config, [NullString]::Value)
        $committed = $true
    } finally {
        $lock.Dispose()
        if (-not $committed) { [IO.File]::Delete($lockPath) }
    }
}

function Confirm-GitIdentity([string] $Git, [string] $Repo) {
    $missing = @()
    foreach ($key in @('user.name', 'user.email')) {
        $value = & $Git -C $Repo -c core.fsmonitor=false config --no-includes --get $key
        if ($LASTEXITCODE -eq 1 -or -not $value) { $missing += $key }
        elseif ($LASTEXITCODE -ne 0) { throw 'Mosaic could not read this project Git author configuration.' }
    }
    if (-not $missing) { return }
    if ((Read-Host 'Set only the missing Git author fields for this repository and its linked worktrees? [y/N]') -notmatch '^y(es)?$') {
        throw 'Configure a Git author for this project before starting a coding task.'
    }
    $pending = @{}
    foreach ($key in $missing) {
        $value = (Read-Host "Enter Git $key").Trim()
        if (-not $value -or $value.Length -gt 256 -or $value -match '[\x00-\x1f<>]' -or
            ($key -eq 'user.email' -and $value -notmatch '^[^\s<>@]+@[^\s<>@]+$')) {
            throw 'Enter a valid Git author value.'
        }
        $pending[$key] = $value
    }
    Save-GitIdentity $Git $Repo $pending
}

if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
    throw "Open PowerShell to continue setup, or run & '$Launcher' setup."
}

$originalDirectory = (Get-Location -PSProvider FileSystem).ProviderPath
$oldOptions, $oldNodePath = $env:NODE_OPTIONS, $env:NODE_PATH
try {
    $env:NODE_OPTIONS = $null
    $env:NODE_PATH = $null
    Push-Location -LiteralPath $user
    try {
        Write-Host '1. Set up Mosaic'
        $setupState = Invoke-GuideStep $node @($lifecycle, 'setup-state') @(0, 3, 4)
        if ($setupState -eq 4) { Invoke-InteractiveStep $Launcher @('migrate') }
        if ($setupState -ne 0) { Invoke-InteractiveStep $Launcher @('setup') }
        Invoke-GuideStep $node @($lifecycle, 'ensure-ready') | Out-Null
        $git = $null
        if ((Invoke-GuideStep $node @($lifecycle, 'coding-status') @(0, 3)) -eq 0) {
            $git = Require-Git
        }
        Write-Host '2. Connect your coding app'
        Invoke-InteractiveStep $node @($hostGuide)
    } finally { Pop-Location }

    if (-not $git) { return }
    $gitDirectory = [IO.Path]::GetDirectoryName($git)
    if (($env:Path -split ';') -notcontains $gitDirectory) { $env:Path = $gitDirectory + ';' + $env:Path }
    Write-Host '3. Start a coding task'
    $repo = Select-Repository $git $originalDirectory
    if (-not $repo) { return }
    Confirm-GitIdentity $git $repo
    Invoke-InteractiveStep $Launcher @('first-task', '--repo', $repo)
} finally {
    $env:NODE_OPTIONS = $oldOptions
    $env:NODE_PATH = $oldNodePath
}
