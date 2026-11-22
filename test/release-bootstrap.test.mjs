import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const source = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
const version = '0.1.0-beta.228';
const stem = `mosaic-beta-${version}-darwin-arm64`;
const sha = data => createHash('sha256').update(data).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

const terminal = String.raw`
import errno, os, pty, select, sys, time
pid, fd = pty.fork()
if not pid:
    os.chdir(sys.argv[2])
    os.execv('/bin/sh', ['/bin/sh', '-c', '/bin/cat "$1" | /bin/sh', 'pipeline', sys.argv[1]])
output = bytearray()
answered = False
start = time.monotonic()
while time.monotonic() - start < 30:
    if select.select([fd], [], [], .05)[0]:
        try:
            data = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO: raise
            break
        if not data: break
        output.extend(data)
        if not answered and b'Guide input?' in output:
            os.write(fd, b'from terminal\n')
            answered = True
else:
    os.kill(pid, 9)
    raise RuntimeError('bootstrap did not finish')
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))
`;

// Only the fixture copy has substitute constants, a local transport and a
// temporary staging root. The public script accepts no test flags or URLs.
function replaceOnce(text, before, after) {
    assert.ok(text.includes(before), String(before));
    return text.replace(before, () => after);
}
function replacePin(text, name, value) {
    const pattern = new RegExp("my \\$" + name + " = '[^']+';");
    assert.match(text, pattern);
    return text.replace(pattern, () => `my $${name} = '${value}';`);
}
async function fixture(t) {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'Mosaic bootstrap ')));
    t.after(() => rm(dir, {recursive:true, force:true}));
    const home = path.join(dir, "owner's home");
    const work = path.join(dir, 'my project');
    const stage = path.join(dir, 'staging');
    const bundle = path.join(dir, stem);
    const sourceVersion = path.join(bundle, 'version');
    for (const dirPath of [home, work, stage, sourceVersion]) await mkdir(dirPath, {recursive:true, mode:0o700});
    const root = path.join(home, 'Library', 'Application Support', 'Mosaic Beta');
    const receiptFile = path.join(root, 'config', 'installation.json');
    const launcherFile = path.join(home, '.local', 'bin', 'mosaic');
    const versionDir = (v = version) => path.join(root, 'versions', v);
    const launcher = v => {
        const runtime = path.join(versionDir(v), 'runtime');
        return '#!/bin/sh\n# Mosaic Beta managed launcher v1\nPATH=' + quote(path.join(runtime, 'bin')) + ':' +
            quote(path.dirname(launcherFile)) + ':"$PATH"\nexport PATH\nexec ' + quote(path.join(runtime, 'bin', 'node')) +
            ' ' + quote(path.join(runtime, 'src/beta/cli.mjs')) + ' "$@"\n';
    };
    const file = {path:'runtime/bin/node', bytes:8, mode:'100755', sha256:sha('fixture\n')};
    const contentHash = sha(JSON.stringify([file]));
    const manifest = v => JSON.stringify({schema:1, layout:'terminal-beta-v2', version:v, contentHash, files:[file]});
    const receipt = v => JSON.stringify({schema:1, version:v, launcherHash:sha(launcher(v)), contentHash});
    await mkdir(path.join(sourceVersion, 'runtime', 'bin'), {recursive:true});
    await writeFile(path.join(sourceVersion, file.path), 'fixture\n', {mode:0o755});
    await writeFile(path.join(sourceVersion, 'package-manifest.json'), manifest(version));
    await writeFile(path.join(bundle, 'launcher'), launcher(version), {mode:0o755});
    await writeFile(path.join(bundle, 'receipt'), receipt(version), {mode:0o600});
    await writeFile(path.join(bundle, 'install'), `#!/bin/sh
set -eu
test "$#" -eq 0
test -t 0
cd -- "${'$'}{0%/*}"
root="$HOME/Library/Application Support/Mosaic Beta"
mkdir -p "$root/config" "$root/versions" "$HOME/.local/bin"
/bin/rm -f "$root/config/install-transaction.json"
if [ ! -d "$root/versions/${version}" ]; then /bin/cp -Rp version "$root/versions/${version}"; fi
/bin/cp -p receipt "$root/config/installation.json"
/bin/cp -p launcher "$HOME/.local/bin/mosaic"
printf 'ORIGINAL INSTALLER\\n'
`, {mode:0o755});
    const archive = path.join(dir, 'archive');
    await exec('/usr/bin/tar', ['-czf', archive, '-C', dir, stem]);
    const bytes = await readFile(archive);
    const guide = `#!/bin/sh
set -eu
test -t 0 && test -t 1
test -f "${'$'}{0%/*}/host.mjs"
test "$PWD" = ${quote(work)}
test "$HOME" = ${quote(home)}
test -z "${'$'}{NODE_OPTIONS:-}"
printf 'Guide input? '
IFS= read -r answer
printf 'guide saw %s\\n' "$answer"
exit "$(cat ${quote(path.join(dir, 'guide-exit'))})"
`;
    await writeFile(path.join(dir, 'guide.sh'), guide);
    await writeFile(path.join(dir, 'host.mjs'), 'fixture helper\n');
    await writeFile(path.join(dir, 'guide-exit'), '0');
    const curl = path.join(dir, 'fixture-curl');
    await writeFile(curl, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name)+1];
const url = arg('--url');
const mode = JSON.parse(fs.readFileSync(path.join(dir, 'transport.json')));
if (args[0] !== '-q' || arg('--proto') !== '=https' || arg('--proto-redir') !== '=https') process.exit(64);
if (mode.reject && url.includes(mode.reject)) process.exit(22);
if (url.endsWith('/guide.sh') || url.endsWith('/host.mjs')) {
    fs.copyFileSync(path.join(dir, path.basename(url)), arg('--output'));
    process.exit(0);
}
if (url !== 'https://github.com/TanujBuilds/Mosaic/releases/download/v${version}/${stem}.tar.gz') process.exit(64);
const [offset, end] = arg('--range').split('-').map(Number);
fs.appendFileSync(path.join(dir, 'requests'), offset + '\\n');
if (mode.failAt !== undefined && offset >= mode.failAt) process.exit(28);
const archive = fs.readFileSync(path.join(dir, 'archive'));
if (mode.corrupt) archive[0] ^= 255;
const range = offset + '-' + end + '/' + archive.length;
const response = mode.full ? '200 OK' : '206 Partial Content\\r\\nContent-Range: bytes ' + (mode.badRange ? '0-0/1' : range);
fs.writeFileSync(arg('--dump-header'), 'HTTP/1.1 302 Found\\r\\nLocation: elsewhere\\r\\n\\r\\nHTTP/2 ' + response + '\\r\\n\\r\\n');
fs.writeFileSync(arg('--output'), mode.full ? archive : archive.subarray(offset, end + (mode.short ? 0 : 1)));
`, {mode:0o755});
    const mode = v => writeFile(path.join(dir, 'transport.json'), JSON.stringify(v));
    await mode({});
    let script = source;
    for (const [name,value] of Object.entries({
        archive_sha:sha(bytes), manifest_sha:sha(manifest(version)), guide_sha:sha(guide), helper_sha:sha('fixture helper\n'),
        guide_revision:'a'.repeat(40), content_sha:contentHash, curl
    })) script = replacePin(script, name, value);
    script = replaceOnce(script, 'my $archive_bytes = 86315923;', 'my $archive_bytes = ' + bytes.length + ';');
    script = replaceOnce(script, '$offset + 4 * 1024 * 1024 - 1', '$offset + 256 - 1');
    script = replaceOnce(script, "DIR => '/private/tmp'", "DIR => '" + stage + "'");
    script = replaceOnce(script, 'sleep $attempt;', 'sleep 0;');
    // Portable CI also exercises the actual checks and TTY handoff. Only the
    // hardware identity is substituted in this copy, never in the public script.
    script = replaceOnce(script, '`/usr/bin/uname -s` eq "Darwin\\n" && `/usr/bin/uname -m` eq "arm64\\n"', '1');
    script = replaceOnce(script, 'if $< == 0;', 'if 0;');
    script = replaceOnce(script, '`/usr/bin/sw_vers -productVersion`', '$ENV{FIXTURE_PRODUCT_VERSION}');
    script = replaceOnce(script, '(getpwuid($<))[7]', '$ENV{FIXTURE_LOGIN_HOME}');
    const scriptFile = path.join(dir, 'install.sh');
    await writeFile(scriptFile, script);
    const env = {...process.env, HOME:home, FIXTURE_LOGIN_HOME:home, FIXTURE_PRODUCT_VERSION:'26.1', TERM:'dumb', NODE_OPTIONS:'--this-option-must-not-run'};
    const run = async (extraEnv = {}) => {
        try {
            const {stdout} = await exec('python3', ['-c', terminal, scriptFile, work], {env:{...env,...extraEnv}, timeout:35000});
            return {code:0,out:stdout};
        } catch (error) {
            assert.equal(typeof error.code, 'number', String(error));
            return {code:error.code,out:error.stdout + error.stderr};
        }
    };
    const installed = async (v = version) => {
        for (const directory of [path.dirname(launcherFile), path.dirname(receiptFile), path.dirname(versionDir(v))])
            await mkdir(directory, {recursive:true, mode:0o700});
        await cp(sourceVersion, versionDir(v), {recursive:true, preserveTimestamps:true});
        await writeFile(path.join(versionDir(v), 'package-manifest.json'), manifest(v));
        await writeFile(receiptFile, receipt(v), {mode:0o600});
        await writeFile(launcherFile, launcher(v), {mode:0o755});
    };
    return {dir, home, root, work, stage, script, scriptFile, receiptFile, launcherFile, versionDir, run, mode, installed, env, receipt, launcher};
}
test('official installer binds the published archive and immutable onboarding files', async () => {
    assert.match(source, /my \$guide_revision = '[a-f0-9]{40}';/);
    for (const [key, file] of [['guide_sha', 'guide.sh'], ['helper_sha', 'host.mjs']]) {
        const local = await readFile(new URL('../distribution/onboarding/' + file, import.meta.url));
        assert.ok(source.includes(`my $${key} = '${sha(local)}';`), file + ' must match the published pin');
    }
    assert.match(source, /a43a5bfba1eea70ed213ad401782250cb4193c0e011940b0f592f963fcfdd6d2/);
    assert.match(source, /my \$archive_bytes = 86315923;/);
    assert.match(source, /ecd13a265d568d7cb8bcdf35cf0cbcb9022f3b8097194973873c12d11284e5ae/);
    assert.match(source, /my \$resources = "https:\/\/raw\.githubusercontent\.com\/TanujBuilds\/Mosaic\/\$guide_revision\/distribution\/onboarding"/);
});
test('a piped fresh install runs the original package and guide in a terminal; a rerun skips the archive', async t => {
    const f = await fixture(t);
    const first = await f.run();
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /ORIGINAL INSTALLER/);
    assert.match(first.out, /guide saw from terminal/);
    assert.deepEqual(await readdir(f.stage), []);
    await f.mode({reject:'.tar.gz'});
    const next = await f.run();
    assert.equal(next.code, 0, next.out);
    assert.match(next.out, /already installed/);
    assert.doesNotMatch(next.out, /ORIGINAL INSTALLER/);
    assert.match(next.out, /guide saw from terminal/);
});
test('partial downloads retry, then resume from cache on the next invocation', async t => {
    const f = await fixture(t);
    await f.mode({failAt:256});
    const stopped = await f.run();
    assert.notEqual(stopped.code, 0);
    assert.match(stopped.out, /Download interrupted\. Resume with/);
    assert.doesNotMatch(stopped.out, /ORIGINAL INSTALLER|Guide input/);
    const offsets = () => readFile(path.join(f.dir,'requests'),'utf8');
    assert.deepEqual((await offsets()).trim().split('\n'), ['0','256','256','256','256']);
    await f.mode({});
    const resumed = await f.run();
    assert.equal(resumed.code, 0, resumed.out);
    assert.match(resumed.out, /resuming at 256 bytes/);
    assert.equal((await offsets()).trim().split('\n').filter(x=>x==='0').length,1);
    assert.deepEqual(await readdir(path.join(f.home, 'Library/Caches/Mosaic Beta Installer')), []);
});
test('a server returning a complete 200 archive to a range request still installs after verification', async t => {
    const f = await fixture(t);
    await f.mode({full:true});
    const done = await f.run();
    assert.equal(done.code,0,done.out);
    assert.match(done.out,/guide saw from terminal/);
});
test('corrupt bytes, short responses and incorrect ranges never execute archive code', async t => {
    const f = await fixture(t);
    for (const [mode, reason] of [[{short:true}, /interrupted/], [{badRange:true}, /interrupted/], [{corrupt:true}, /checksum failed/]]) {
        await f.mode(mode);
        const result = await f.run();
        assert.notEqual(result.code,0);
        assert.match(result.out, reason);
        assert.doesNotMatch(result.out, /ORIGINAL INSTALLER|Guide input/);
    }
    assert.deepEqual(await readdir(f.stage), []);
});
test('both onboarding resources are verified before installation', async t => {
    const f = await fixture(t);
    for (const resource of ['guide.sh','host.mjs']) {
        const file = path.join(f.dir,resource);
        const original = await readFile(file);
        await writeFile(file,'bad data');
        const result = await f.run();
        assert.notEqual(result.code,0);
        assert.match(result.out,new RegExp('Checksum failed for '+resource));
        assert.doesNotMatch(result.out,/Downloading Mosaic|ORIGINAL INSTALLER|Guide input/);
        await writeFile(file,original);
    }
});
test('older version upgrades through the original package; stable and newer betas never downgrade', async t => {
    const f = await fixture(t);
    await f.installed('0.1.0-beta.36');
    const upgraded = await f.run();
    assert.equal(upgraded.code,0,upgraded.out);
    assert.match(upgraded.out,/ORIGINAL INSTALLER/);
    await f.mode({reject:'https://'});
    for (const v of ['0.1.0','0.1.0-beta.1000','1.0.0-beta.1']) {
        await f.installed(v);
        const next = await f.run();
        assert.equal(next.code,0,next.out);
        assert.match(next.out,/is newer/);
        assert.doesNotMatch(next.out,/ORIGINAL INSTALLER|Guide input/);
        assert.equal(JSON.parse(await readFile(f.receiptFile,'utf8')).version,v);
    }
});
test('modified runtime, launcher, missing receipt and interrupted transaction preserve installed files', async t => {
    const f = await fixture(t);
    await f.installed();
    const node = path.join(f.versionDir(),'runtime/bin/node');
    await writeFile(node,'changed\n');
    const runtime = await f.run();
    assert.notEqual(runtime.code,0); assert.match(runtime.out,/installed runtime contains a changed file/);
    await writeFile(node,'fixture\n');
    await writeFile(path.join(f.root,'config/install-transaction.json'),'{}');
    const pending = await f.run();
    assert.notEqual(pending.code,0); assert.match(pending.out,/unfamiliar owner or target/);
    await rm(path.join(f.root,'config/install-transaction.json'));
    await writeFile(f.launcherFile,'foreign launcher');
    const foreign = await f.run();
    assert.notEqual(foreign.code,0); assert.match(foreign.out,/foreign or modified/);
    assert.equal(await readFile(f.launcherFile,'utf8'),'foreign launcher');
    await rm(f.receiptFile);
    const orphan = await f.run();
    assert.notEqual(orphan.code,0); assert.match(orphan.out,/receipt is missing/);
    for (const result of [runtime,pending,foreign,orphan]) assert.doesNotMatch(result.out,/ORIGINAL INSTALLER|Guide input/);
});
test('uninstalled current and older releases restore the launcher and retain evidence', async t => {
    for (const v of [version,'0.1.0-beta.36']) {
        const f = await fixture(t);
        await f.installed(v);
        await rm(f.launcherFile);
        const evidence = path.join(f.root,'retained-evidence');
        await writeFile(evidence,'keep my history');
        const restored = await f.run();
        assert.equal(restored.code,0,restored.out);
        assert.match(restored.out,/Restoring your launcher/);
        assert.match(restored.out,/guide saw from terminal/);
        assert.equal(await readFile(evidence,'utf8'),'keep my history');
        assert.equal(await readFile(f.launcherFile,'utf8'),f.launcher(version));
    }
});
test('uninstalled newer versions and unowned receipt hashes preserve the empty launcher path', async t => {
    const f = await fixture(t);
    const v = '0.1.0-beta.998';
    await f.installed(v);
    await rm(f.launcherFile);
    const newer = await f.run();
    assert.notEqual(newer.code,0);
    assert.match(newer.out,/retained Mosaic .* is newer/);
    await writeFile(f.receiptFile,JSON.stringify({...JSON.parse(f.receipt(v)),launcherHash:'0'.repeat(64)}));
    const foreign = await f.run();
    assert.notEqual(foreign.code,0);
    assert.match(foreign.out,/does not identify a managed launcher/);
    for (const result of [newer,foreign]) assert.doesNotMatch(result.out,/Downloading Mosaic|ORIGINAL INSTALLER|Guide input/);
    await assert.rejects(stat(f.launcherFile),{code:'ENOENT'});
});
test('a reinstall interrupted after a supported uninstall resumes with its retained prior receipt', async t => {
    const f = await fixture(t);
    await f.installed();
    await rm(f.launcherFile);
    const receipt = JSON.parse(f.receipt(version));
    const tx = {schema:1, phase:'prepared', version, newReceipt:receipt, oldReceipt:receipt, oldLauncher:null};
    await writeFile(path.join(f.root,'config/install-transaction.json'),JSON.stringify(tx),{mode:0o600});
    const resumed = await f.run();
    assert.equal(resumed.code,0,resumed.out);
    assert.match(resumed.out,/Resuming interrupted installation/);
    assert.equal(await readFile(f.launcherFile,'utf8'),f.launcher(version));
});
test('owned pending transaction reaches the original installer across mismatched pointer phases', async t => {
    for (const phase of ['prepared','launcher','receipt']) {
        const f = await fixture(t);
        const txDir = path.join(f.root,'config');
        await mkdir(txDir,{recursive:true,mode:0o700});
        if (phase !== 'prepared') {
            await mkdir(path.dirname(f.launcherFile),{recursive:true,mode:0o700});
            await writeFile(f.launcherFile,f.launcher(version),{mode:0o755});
        }
        if (phase === 'receipt') await writeFile(f.receiptFile,f.receipt(version),{mode:0o600});
        const tx = {schema:1, phase, version, newReceipt:JSON.parse(f.receipt(version)), oldReceipt:null, oldLauncher:null};
        await writeFile(path.join(txDir,'install-transaction.json'),JSON.stringify(tx),{mode:0o600});
        const resumed = await f.run();
        assert.equal(resumed.code,0,resumed.out);
        assert.match(resumed.out,/Resuming interrupted installation/);
        assert.match(resumed.out,/ORIGINAL INSTALLER/);
        assert.match(resumed.out,/guide saw from terminal/);
    }
});
test('a pending transaction belonging to a newer release never downgrades its previous version', async t => {
    const f = await fixture(t);
    const v = '0.1.0-beta.999';
    await f.installed(v);
    const tx = {schema:1, phase:'prepared', version, newReceipt:JSON.parse(f.receipt(version)),
        oldReceipt:JSON.parse(f.receipt(v)), oldLauncher:Buffer.from(f.launcher(v)).toString('base64')};
    await writeFile(path.join(f.root,'config/install-transaction.json'),JSON.stringify(tx),{mode:0o600});
    const conflict = await f.run();
    assert.notEqual(conflict.code,0);
    assert.match(conflict.out,/newer release owns the prior installation/);
    assert.doesNotMatch(conflict.out,/Downloading Mosaic|ORIGINAL INSTALLER|Guide input/);
});
test('release hardware floor refuses old or unrecognized macOS versions before downloading', async t => {
    const f = await fixture(t);
    for (const v of ['15.7.2','25','26preview','']) {
        const checked = await f.run({FIXTURE_PRODUCT_VERSION:v});
        assert.notEqual(checked.code,0);
        assert.match(checked.out,/macOS 26 or newer/);
        assert.doesNotMatch(checked.out,/Downloading Mosaic|ORIGINAL INSTALLER|Guide input/);
    }
});
test('an overridden or writable login home fails before a download or installation', async t => {
    const f = await fixture(t);
    const misdirected = await f.run({FIXTURE_LOGIN_HOME:f.work});
    assert.notEqual(misdirected.code,0);
    assert.match(misdirected.out,/home directory of the current Mac login user/);
    await chmod(f.home,0o777);
    const unsafe = await f.run();
    assert.notEqual(unsafe.code,0);
    assert.match(unsafe.out,/Unexpected directory/);
    for (const check of [misdirected,unsafe]) assert.doesNotMatch(check.out,/Downloading Mosaic|ORIGINAL INSTALLER|Guide input/);
});
test('a HOME alias installs using the account spelling and reruns from the ordinary login', async t => {
    const f = await fixture(t);
    const alias = path.join(f.dir,'home alias');
    await symlink(f.home,alias,'dir');
    const first = await f.run({HOME:alias});
    assert.equal(first.code,0,first.out);
    assert.match(first.out,/ORIGINAL INSTALLER/);
    const normal = await f.run();
    assert.equal(normal.code,0,normal.out);
    assert.match(normal.out,/already installed/);
});
test('cache symlinks and nonprivate cache permissions do not overwrite other files', async t => {
    const f = await fixture(t);
    const cache = path.join(f.home,'Library/Caches/Mosaic Beta Installer');
    await mkdir(cache,{recursive:true,mode:0o700});
    const other = path.join(f.dir,'unrelated');
    await writeFile(other,'keep me');
    await symlink(other,path.join(cache,stem+'.tar.gz.part'));
    const linked = await f.run();
    assert.notEqual(linked.code,0); assert.match(linked.out,/Unexpected download cache entry/);
    await chmod(cache,0o755);
    const shared = await f.run();
    assert.notEqual(shared.code,0); assert.match(shared.out,/cache must be private/);
    assert.equal(await readFile(other,'utf8'),'keep me');
});
test('guide status is preserved; a noninteractive command and truncated stream produce no install', async t => {
    const f = await fixture(t);
    await assert.rejects(exec('/bin/sh',[f.scriptFile],{env:f.env}), error => /Open Terminal/.test(error.stderr));
    await writeFile(f.scriptFile,f.script.slice(0,f.script.indexOf('sub run {')));
    const truncated = await f.run();
    assert.notEqual(truncated.code,0,truncated.out);
    await assert.rejects(stat(f.root), {code:'ENOENT'});
    await assert.rejects(stat(f.launcherFile), {code:'ENOENT'});
    await writeFile(f.scriptFile,f.script);
    await f.installed();
    await writeFile(path.join(f.dir,'guide-exit'),'2');
    const next = await f.run();
    assert.equal(next.code,2,next.out);
    assert.match(next.out,/Resume the guided setup with/);
    assert.ok((await stat(f.launcherFile)).isFile());
});
