import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const guide = fileURLToPath(new URL('../distribution/windows/guide.ps1', import.meta.url));
const rehearsal = String.raw`
param([string] $Root, [string] $Guide)
$ErrorActionPreference = 'Stop'
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')

# Import the exact helper functions without running the installation lifecycle
# or changing the checked-in coding hold.
$tokens = $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Guide, [ref] $tokens, [ref] $errors)
if ($errors) { throw ($errors -join '; ') }
$functions = $ast.EndBlock.Statements | Where-Object {
    $_ -is [System.Management.Automation.Language.FunctionDefinitionAst]
} | ForEach-Object { $_.Extent.Text }
. ([ScriptBlock]::Create(($functions -join [char] 10)))

# Capture the hosted Git distribution before isolating this process's discovery
# roots. All subsequent installation copies and configuration stay in $Root.
$local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$installed = Get-Git
if (-not $installed) { throw 'Expected runner Git for Windows at a verified installation location' }
$gitTree = [IO.Directory]::GetParent([IO.Path]::GetDirectoryName($installed)).FullName
$stage = Join-Path $Root 'Staged genuine Git for Windows'
$robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
& $robocopy $gitTree $stage /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8 -or -not [IO.File]::Exists((Join-Path $stage 'cmd\git.exe'))) {
    throw 'Could not stage the hosted Git distribution'
}

$profileRoot = Join-Path $Root 'Clean fixture profile'
$local = Join-Path $profileRoot 'AppData\Local'
$shimDir = Join-Path $local 'Microsoft\WindowsApps'
[IO.Directory]::CreateDirectory($shimDir) | Out-Null
$programRoots = @(
    (Join-Path $Root 'Empty System Programs'),
    (Join-Path $Root 'Empty 32-bit Programs'),
    (Join-Path $Root 'Empty Native Programs')
)
foreach ($folder in $programRoots) { [IO.Directory]::CreateDirectory($folder) | Out-Null }
$env:ProgramFiles = $programRoots[0]
[Environment]::SetEnvironmentVariable('ProgramFiles(x86)', $programRoots[1], 'Process')
$env:ProgramW6432 = $programRoots[2]
$env:LOCALAPPDATA = $local
$processPath = (Join-Path $env:SystemRoot 'System32') + ';' + $env:SystemRoot
$env:Path = $processPath
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = Join-Path $profileRoot '.gitconfig'
$globalText = '[user]' + [char] 10 + '    name = Fixture global author' + [char] 10
[IO.File]::WriteAllText($env:GIT_CONFIG_GLOBAL, $globalText)

# The simulated package manager enforces the production consent command's literal
# arguments, then places the genuine staged Git tree in the per-user location.
$manager = Join-Path $shimDir 'winget.exe'
$target = Join-Path $local 'Programs\Git'
$marker = Join-Path $Root 'package-manager-invocation.txt'
$env:MOSAIC_QA_WIN_GIT_STAGE = $stage
$env:MOSAIC_QA_WIN_GIT_TARGET = $target
$env:MOSAIC_QA_WIN_GIT_MARKER = $marker
Add-Type -OutputAssembly $manager -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;

class FixturePackageManager {
    static int Main(string[] args) {
        string command = string.Join(" ", args);
        if (command != "install --id Git.Git --exact --source winget --scope user") return 64;
        string target = Environment.GetEnvironmentVariable("MOSAIC_QA_WIN_GIT_TARGET");
        Directory.CreateDirectory(Path.GetDirectoryName(target));
        Directory.Move(Environment.GetEnvironmentVariable("MOSAIC_QA_WIN_GIT_STAGE"), target);
        File.WriteAllText(Environment.GetEnvironmentVariable("MOSAIC_QA_WIN_GIT_MARKER"), command);
        return 0;
    }
}
'@

$git = Join-Path $target 'cmd\git.exe'
foreach ($candidate in @($git) + @($programRoots | ForEach-Object { Join-Path $_ 'Git\cmd\git.exe' })) {
    if ([IO.File]::Exists($candidate)) { throw 'Fixture Git discovery path was not empty' }
}
if ((Get-Command git.exe -ErrorAction SilentlyContinue) -or (Get-Git)) { throw 'Git is discoverable before consent' }

$declined = Require-Git
if ($declined -or [IO.File]::Exists($marker) -or [IO.Directory]::Exists($target) -or
    -not [IO.Directory]::Exists($stage) -or $env:Path -cne $processPath -or
    [IO.File]::ReadAllText($env:GIT_CONFIG_GLOBAL) -cne $globalText) {
    throw 'Declining changed the fixture or launched the package manager'
}
Write-Output 'DECLINED WITHOUT GIT CHANGES'

$selected = Require-Git
if ($selected -ine $git -or (Get-Git) -ine $git -or
    [IO.File]::ReadAllText($marker) -cne 'install --id Git.Git --exact --source winget --scope user' -or
    $env:Path -cne $processPath -or (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    throw 'The original PowerShell did not rediscover the installed per-user Git by absolute path'
}
$repo = Join-Path $Root 'Committed project'
[IO.Directory]::CreateDirectory($repo) | Out-Null
& $selected -C $repo init --quiet --template=
if ($LASTEXITCODE -ne 0) { throw 'The discovered Git could not initialize the fixture' }
& $selected -C $repo -c 'user.name=Mosaic Fixture' -c 'user.email=fixture@example.invalid' commit --allow-empty -qm 'Fixture baseline'
if ($LASTEXITCODE -ne 0) { throw 'The discovered Git could not create the fixture commit' }
if ((Select-Repository $selected $repo) -ine $repo) { throw 'Mosaic did not accept the committed project in the same session' }
Write-Output 'SAME POWERSHELL SELECTED GENUINE PER-USER GIT AND COMMITTED PROJECT'

# A plausible known path under a junction is untrusted. Use an empty second
# fixture root for the per-user candidate and leave the accepted install intact.
$local = Join-Path $Root 'Second empty local profile'
[IO.Directory]::CreateDirectory($local) | Out-Null
New-Item -ItemType Junction -Path (Join-Path $programRoots[0] 'Git') -Target $target | Out-Null
if (Get-Git) { throw 'A junction redirected the known installation path' }

if ([Environment]::GetEnvironmentVariable('Path', 'Machine') -cne $machinePath -or
    [Environment]::GetEnvironmentVariable('Path', 'User') -cne $userPath -or
    [IO.File]::ReadAllText($env:GIT_CONFIG_GLOBAL) -cne $globalText) {
    throw 'The rehearsal changed persistent PATH or Git configuration'
}
Write-Output 'PERSISTENT PATH AND GLOBAL GIT CONFIG PRESERVED'
`;

function runPowerShell(file, root) {
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-File', file, '-Root', root, '-Guide', guide], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 110_000,
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', chunk => {
      output = (output + chunk).slice(-32_768);
    });
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => {
      if (code !== 0) reject(Error(`PowerShell Git rehearsal ended with ${code ?? signal}\n${output}`));
      else resolve(output);
    });
    child.stdin.end('n\r\ny\r\n\r\n');
  });
}

// A native Windows Server PowerShell and real Git for Windows, with disposable
// per-user paths and a test-only WinGet substitute. No Store App Installer,
// fresh Windows 11 login, release installation or protected execution is tested.
test('first-run Git decline leaves the profile intact and consent discovers Git in the same PowerShell', {
  skip: process.platform !== 'win32',
  timeout: 135_000,
}, async t => {
  const parent = await realpath(process.env.RUNNER_TEMP ?? tmpdir());
  const root = await realpath(await mkdtemp(path.join(parent, 'Mosaic first-run Git ')));
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 5}));
  const script = path.join(root, 'rehearse.ps1');
  await writeFile(script, rehearsal);
  const output = await runPowerShell(script, root);
  assert.match(output, /Install Git for this user with Windows Package Manager/u);
  assert.match(output, /Install Git for Windows from https:\/\/git-scm\.com\/install\/windows/u);
  assert.match(output, /DECLINED WITHOUT GIT CHANGES/u);
  assert.match(output, /SAME POWERSHELL SELECTED GENUINE PER-USER GIT AND COMMITTED PROJECT/u);
  assert.match(output, /PERSISTENT PATH AND GLOBAL GIT CONFIG PRESERVED/u);
});
