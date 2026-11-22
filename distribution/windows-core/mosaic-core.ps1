$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$locator = Join-Path $root 'active-core.json'
if ([IO.File]::GetAttributes($locator) -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected core locator redirection' }
$hash = ([IO.File]::ReadAllText($locator) | ConvertFrom-Json).archiveSha256
if ($hash -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid installed core pointer' }
$version = Join-Path (Join-Path $root 'versions') $hash
$node = Join-Path $version 'runtime/bin/node.exe'
$cli = Join-Path $version 'distribution/windows-core/core.mjs'
foreach ($file in @($root,(Join-Path $root 'versions'),$version,(Join-Path $version 'runtime'),(Join-Path $version 'runtime/bin'),$node,(Join-Path $version 'distribution'),(Join-Path $version 'distribution/windows-core'),$cli)) {
    if ([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected installed core path redirection' }
}
$options = $env:NODE_OPTIONS
$nodePath = $env:NODE_PATH
try {
    $env:NODE_OPTIONS = $null
    $env:NODE_PATH = $null
    & $node $cli @args
    $code = $LASTEXITCODE
} finally {
    $env:NODE_OPTIONS = $options
    $env:NODE_PATH = $nodePath
}
exit $code
