param([Parameter(Mandatory)][ValidateSet('git','codex','claude-code')][string]$Tool)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or $env:USERNAME -ne 'MosaicVendorTrial') {
        throw 'Expected a new standard Windows account'
    }
} finally { $identity.Dispose() }
$local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (-not $local -or $local -notlike '*\MosaicVendorTrial\AppData\Local') { throw 'The disposable user profile was not loaded' }

if ($Tool -eq 'git') {
    $guide = Join-Path $PSScriptRoot 'distribution/windows/guide.ps1'
    $tokens = $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($guide,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw 'Installed guide does not parse' }
    foreach ($name in @('Get-Git','Install-GitForWindows')) {
        $body = $ast.Find({ param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $false)
        . ([scriptblock]::Create($body.Extent.Text))
    }
    $expected = Join-Path $local 'Programs\Git\cmd\git.exe'
    if (Test-Path -LiteralPath $expected) { throw 'The account already has a per-user Git' }
    New-Item -ItemType Directory -Path (Join-Path $local 'Mosaic Beta') | Out-Null
    if (-not (Install-GitForWindows) -or (Get-Git) -ne $expected) { throw 'Git did not install or rediscover in this process' }
    & $expected --version
    if ($LASTEXITCODE -ne 0) { throw 'Git version failed' }
} else {
    $node = Join-Path $PSScriptRoot 'runtime/bin/node.exe'
    $driver = @'
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const fromRoot = relative => import(pathToFileURL(path.join(process.argv[1],relative)));
const {installCli} = await fromRoot('distribution/onboarding/test-expose-installer.mjs');
const {windowsHostExecutable} = await fromRoot('runtime/src/beta/hosts/detection.mjs');
const id = process.argv[2], options = {home: os.homedir(), isolated: false};
if (await windowsHostExecutable(id, options)) throw Error('CLI already detected');
const url = id === 'codex' ? 'https://chatgpt.com/codex/install.ps1' : 'https://claude.ai/install.ps1';
if (!installCli(url)) throw Error('Official installer failed');
const executable = await windowsHostExecutable(id, options);
if (!executable) throw Error('Installed CLI was not discovered in the same process');
execFileSync(executable, ['--version'], {stdio:'inherit',timeout:15000});
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($driver))
    & $node --input-type=module -e "await import('data:text/javascript;base64,$encoded')" $PSScriptRoot $Tool
    if ($LASTEXITCODE -ne 0) { throw 'Vendor CLI install result failed' }
}
Write-Output "PASS real per-user installer $Tool"
exit 0
