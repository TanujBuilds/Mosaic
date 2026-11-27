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
const dmgName = 'Mosaic-Desktop-arm64.dmg';
const desktopURL = 'https://github.com/TanujBuilds/Mosaic/releases/download/v0.1.2-desktop/' + dmgName;
const disk = Buffer.from('verified fixture disk image\n'.repeat(26));
const team = 'FIXTURE123';
const blankPin = 'my $desktop_release = undef;';
const pinPattern = /^my \$desktop_release = [^\n]+;$/m;
const fixturePin = `my $desktop_release = { version => '0.1.2', team => '${team}', bytes => ${disk.length}, sha256 => '${sha(disk)}' };`;
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

const terminal = String.raw`
import errno, os, pty, select, sys, time
pid, fd = pty.fork()
if not pid:
    os.chdir(sys.argv[2])
    os.execv('/bin/sh', ['/bin/sh', '-c', '/bin/cat "$1" | /bin/sh', 'pipeline', sys.argv[1]])
output = bytearray()
answered = False
choices = os.environ.get('FIXTURE_CHOICE', '').split('\n')
choices_sent = 0
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
        if output.count(b'Choice [2]: ') > choices_sent and choices_sent < len(choices):
            choice = choices[choices_sent]
            os.write(fd, b'\x04' if choice == 'EOF' else choice.encode() + b'\n')
            choices_sent += 1
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
async function fixture(t, {desktop = false} = {}) {
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
    await writeFile(path.join(dir, dmgName), disk);
    const curl = path.join(dir, 'fixture-curl');
    await writeFile(curl, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name)+1];
const url = arg('--url');
const mode = JSON.parse(fs.readFileSync(path.join(dir, 'transport.json')));
fs.appendFileSync(path.join(dir, 'urls'), url + '\\n');
if (args[0] !== '-q' || arg('--proto') !== '=https' || arg('--proto-redir') !== '=https') process.exit(64);
if (mode.reject && url.includes(mode.reject)) process.exit(22);
if (url.endsWith('/guide.sh') || url.endsWith('/host.mjs')) {
    fs.copyFileSync(path.join(dir, path.basename(url)), arg('--output'));
    process.exit(0);
}
const desktop = url === ${JSON.stringify(desktopURL)};
if (!desktop && url !== 'https://github.com/TanujBuilds/Mosaic/releases/download/v${version}/${stem}.tar.gz') process.exit(64);
const [offset, end] = arg('--range').split('-').map(Number);
fs.appendFileSync(path.join(dir, 'requests'), offset + '\\n');
if (mode.failAt !== undefined && offset >= mode.failAt) process.exit(28);
const archive = fs.readFileSync(path.join(dir, desktop ? ${JSON.stringify(dmgName)} : 'archive'));
if (mode.corrupt) archive[0] ^= 255;
const range = offset + '-' + end + '/' + archive.length;
const response = mode.full ? '200 OK' : '206 Partial Content\\r\\nContent-Range: bytes ' + (mode.badRange ? '0-0/1' : range);
fs.writeFileSync(arg('--dump-header'), 'HTTP/1.1 302 Found\\r\\nLocation: elsewhere\\r\\n\\r\\nHTTP/2 ' + response + '\\r\\n\\r\\n');
fs.writeFileSync(arg('--output'), mode.full ? archive : archive.subarray(offset, end + (mode.short ? 0 : 1)));
`, {mode:0o755});
    const mode = v => writeFile(path.join(dir, 'transport.json'), JSON.stringify(v));
    await mode({});
    assert.match(source, pinPattern);
    let script = source.replace(pinPattern, () => desktop ? fixturePin : blankPin);
    const systemApps = path.join(dir, 'system-apps');
    script = replaceOnce(script, "($personal, '/Applications')", "($personal, '" + systemApps + "')");
    // Finder, Gatekeeper and the signing tools stay inside the disposable fixture.
    for (const tool of ['/usr/bin/codesign', '/usr/sbin/spctl', '/usr/bin/open', '/usr/bin/xattr', '/usr/bin/plutil']) {
        const name = path.basename(tool);
        const stub = path.join(dir, name);
        script = script.replaceAll("'" + tool + "'", "'" + stub + "'");
        await writeFile(stub, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const dir = ${JSON.stringify(dir)};
const name = ${JSON.stringify(name)};
const args = process.argv.slice(2);
const file = args.at(-1);
const mode = JSON.parse(fs.readFileSync(path.join(dir, 'transport.json')));
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify([name, ...args]) + '\\n');
if (mode.refuse === name) process.exit(2);
if (name === 'plutil') console.log(fs.readFileSync(file, 'utf8'));
if (name === 'codesign' && args.includes('-R') && !args.at(-2).includes('"${team}"')) process.exit(3);
`, {mode:0o755});
    }
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
    return {dir, home, root, work, stage, systemApps, script, scriptFile, receiptFile, launcherFile, versionDir, run, mode, installed, env, receipt, launcher};
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

async function lines(file) {
    try { return (await readFile(file, 'utf8')).trimEnd().split('\n').filter(Boolean); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}
const calls = async f => (await lines(path.join(f.dir, 'calls'))).map(line => JSON.parse(line));
const urls = f => lines(path.join(f.dir, 'urls'));
const chooseDesktop = {FIXTURE_CHOICE:'1'};

test('a pending release offers only Terminal and an active release defaults to the same Terminal guide', async t => {
    for (const desktop of [false, true]) {
        const f = await fixture(t, {desktop});
        const result = await f.run();
        assert.equal(result.code, 0, result.out);
        assert.equal(result.out.includes('Choice [2]'), desktop);
        assert.match(result.out, /guide saw from terminal/);
        assert.ok((await urls(f)).every(url => url !== desktopURL));
        assert.deepEqual(await calls(f), []);
    }
});

test('the desktop choice verifies a pinned disk image, hands it to Finder and skips the Terminal installer and guide', async t => {
    const f = await fixture(t, {desktop:true});
    const result = await f.run({FIXTURE_CHOICE:'bad\ndesktop app'});
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /Enter 1 for the desktop app/);
    assert.match(result.out, /drag Mosaic Desktop to Applications/);
    assert.doesNotMatch(result.out, /ORIGINAL INSTALLER|Guide input/);
    assert.deepEqual(new Set(await urls(f)), new Set([desktopURL]));
    await assert.rejects(stat(f.root), {code:'ENOENT'});
    const tools = await calls(f);
    const image = tools[0].at(-1);
    assert.deepEqual(await readFile(image), disk);
    assert.equal(path.basename(image), dmgName);
    assert.equal(path.basename(path.dirname(image)), 'v0.1.2-desktop');
    assert.deepEqual(tools.map(call => call[0]), ['xattr','spctl','open']);
    assert.deepEqual(tools[0].slice(1,3), ['-w','com.apple.quarantine']);
    assert.deepEqual(tools[1].slice(1), ['--assess','--type','open','--context','context:primary-signature',image]);
    assert.deepEqual(tools[2].slice(1), ['-a','/System/Library/CoreServices/DiskImageMounter.app',image]);
    await f.mode({reject:'https://'});
    assert.equal((await f.run(chooseDesktop)).code, 0);
    const requests = await urls(f);
    await writeFile(image, 'unrelated file');
    const changed = await f.run(chooseDesktop);
    assert.notEqual(changed.code, 0);
    assert.match(changed.out, /cached disk image has changed/);
    assert.equal(await readFile(image, 'utf8'), 'unrelated file');
    assert.deepEqual(await urls(f), requests);
});

test('EOF at the mode choice exits before downloads or setup', async t => {
    const f = await fixture(t, {desktop:true});
    const result = await f.run({FIXTURE_CHOICE:'EOF'});
    assert.notEqual(result.code, 0);
    assert.match(result.out, /ended before a choice/);
    assert.deepEqual(await urls(f), []);
    assert.deepEqual(await calls(f), []);
});

test('interrupted desktop transfer resumes and rejects corrupted or Gatekeeper-rejected disk images', async t => {
    const f = await fixture(t, {desktop:true});
    await f.mode({failAt:256});
    const stopped = await f.run(chooseDesktop);
    assert.notEqual(stopped.code, 0);
    assert.match(stopped.out, /Download interrupted/);
    assert.deepEqual(await calls(f), []);
    await f.mode({corrupt:true});
    // Corrupt the already-downloaded prefix too. Later ranges cannot repair it.
    const partial = path.join(f.home, 'Library/Caches/Mosaic Desktop Installer/v0.1.2-desktop', dmgName + '.part');
    await writeFile(partial, Buffer.alloc(256));
    const corrupt = await f.run(chooseDesktop);
    assert.notEqual(corrupt.code, 0);
    assert.match(corrupt.out, /resuming at 256 bytes/);
    assert.match(corrupt.out, /checksum failed/);
    assert.deepEqual(await calls(f), []);
    await f.mode({refuse:'spctl'});
    const blocked = await f.run(chooseDesktop);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.out, /Gatekeeper could not verify/);
    assert.ok((await calls(f)).every(call => call[0] !== 'open'));
    await f.mode({});
    const resumed = await f.run(chooseDesktop);
    assert.equal(resumed.code, 0, resumed.out);
    assert.match(resumed.out, /drag Mosaic Desktop/);
    assert.ok((await urls(f)).every(url => url === desktopURL));
});

test('installed current and newer apps require the pinned publisher and Gatekeeper before opening; foreign copies stay in place', async t => {
    const f = await fixture(t, {desktop:true});
    const personal = path.join(f.home, 'Applications', 'Mosaic Desktop.app');
    const shared = path.join(f.systemApps, 'Mosaic Desktop.app');
    const plist = app => path.join(app, 'Contents', 'Info.plist');
    for (const [app, v] of [[personal,'0.1.2'], [shared,'0.2.0']]) {
        await mkdir(path.dirname(plist(app)), {recursive:true, mode:0o700});
        await writeFile(plist(app), v);
        const done = await f.run(chooseDesktop);
        assert.equal(done.code, 0, done.out);
        assert.match(done.out, v === '0.1.2' ? /already installed/ : /newer Mosaic Desktop/);
        assert.deepEqual(await urls(f), []);
        const log = await calls(f);
        assert.deepEqual(log.at(-1), ['open',app]);
        assert.ok(log.some(call => call.includes('--deep') && call.includes('--strict')));
        assert.ok(log.some(call => call.includes('-R') && call.some(arg => arg.includes('dev.mosaic.desktop') && arg.includes(team))));
        assert.ok(log.some(call => call.includes('--assess') && call.includes('execute')));
        await f.mode({refuse:'codesign'});
        const changed = await f.run(chooseDesktop);
        assert.notEqual(changed.code, 0);
        assert.match(changed.out, /could not be verified/);
        assert.equal(await readFile(plist(app), 'utf8'), v);
        assert.deepEqual(await urls(f), []);
        assert.equal((await calls(f)).at(-1)[0], 'codesign');
        await f.mode({});
        await rm(app, {recursive:true});
    }
    await symlink(f.work, personal);
    const linked = await f.run(chooseDesktop);
    assert.notEqual(linked.code, 0);
    assert.match(linked.out, /could not be verified/);
    assert.deepEqual(await urls(f), []);
});

test('release promotion requires a public receipt and independent verifier, and emits an applicable immutable pin and download link', async t => {
    const f = await fixture(t);
    const script = path.join(f.work, 'distribution/desktop/promote.mjs');
    const verifier = path.join(f.work, 'desktop/macos/package.mjs');
    await mkdir(path.dirname(script), {recursive:true});
    await mkdir(path.dirname(verifier), {recursive:true});
    await cp(new URL('../distribution/desktop/promote.mjs', import.meta.url), script);
    // Run the real promotion tool against a disposable release-verifier double.
    // The actual Mac verifier has its own packaging tests.
    const record = path.join(f.work, 'signed');
    await writeFile(verifier, `
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [verify, image, receiptFlag, receipt, teamFlag, team] = process.argv.slice(2);
assert.deepEqual([verify, receiptFlag, teamFlag, team], ['--verify-dmg','--receipt','--team-id',${JSON.stringify(team)}]);
assert.equal(readFileSync(${JSON.stringify(record)}, 'utf8'), 'yes');
assert.equal(createHash('sha256').update(readFileSync(image)).digest('hex'), JSON.parse(readFileSync(receipt)).dmg.sha256);
`);
    const installer = path.join(f.work, 'install.sh');
    const readme = path.join(f.work, 'README.md');
    const pending = source.replace(pinPattern, () => blankPin);
    const marker = '<!-- mosaic-desktop-release -->';
    await writeFile(installer, pending, {mode:0o755});
    await writeFile(readme, '# Mosaic\n\n' + marker + '\n');
    const release = {schema:1,version:'0.1.2',releaseTag:'v0.1.2-desktop',bundleId:'dev.mosaic.desktop',
        mode:'public',publishable:true,teamId:team,dmg:{file:dmgName,bytes:disk.length,sha256:sha(disk)}};
    const receipt = path.join(f.dir, 'Mosaic-Desktop-release.json');
    const image = path.join(f.dir, dmgName);
    const run = () => exec(process.execPath, [script,'--dmg',image,'--receipt',receipt,'--team-id',team]);
    for (const invalid of [{mode:'local',publishable:false}, {teamId:'OTHER12345'}, {releaseTag:'rolling'}, {dmg:{...release.dmg, bytes:1}}]) {
        await writeFile(receipt, JSON.stringify({...release,...invalid}));
        await assert.rejects(run(), e => !e.stdout && /expected public desktop release/.test(e.stderr));
    }
    await writeFile(receipt, JSON.stringify(release));
    await assert.rejects(run(), e => !e.stdout && e.stderr.includes('ENOENT'));
    await writeFile(record, 'yes');
    await writeFile(image, Buffer.alloc(disk.length));
    await assert.rejects(run(), e => !e.stdout);
    await writeFile(image, disk);
    const {stdout:patch} = await run();
    assert.ok(patch.includes(fixturePin));
    assert.ok(patch.includes(desktopURL));
    assert.equal(await readFile(installer, 'utf8'), pending);
    assert.ok(!(await readFile(readme, 'utf8')).includes(desktopURL));
    const patchFile = path.join(f.dir, 'release.patch');
    await writeFile(patchFile, patch);
    await exec('git', ['apply','--check',patchFile], {cwd:f.work});
    await exec('git', ['apply',patchFile], {cwd:f.work});
    assert.ok((await readFile(readme, 'utf8')).includes(desktopURL));
    assert.ok((await readFile(installer, 'utf8')).includes(fixturePin));
    assert.equal((await run()).stdout, '');
    await writeFile(installer, pending.replace(blankPin, fixturePin.replace(team, 'OTHER12345')));
    await assert.rejects(run(), e => !e.stdout && /pins conflict/.test(e.stderr));
});

test('an older verified desktop app stays in place while Finder opens the new image', async t => {
    const f = await fixture(t, {desktop:true});
    const app = path.join(f.systemApps, 'Mosaic Desktop.app');
    const info = path.join(app, 'Contents/Info.plist');
    await mkdir(path.dirname(info), {recursive:true});
    await writeFile(info, '0.1.1');
    const updated = await f.run(chooseDesktop);
    assert.equal(updated.code, 0, updated.out);
    assert.match(updated.out, /Mosaic Desktop 0.1.1 is installed/);
    assert.deepEqual(new Set(await urls(f)), new Set([desktopURL]));
    assert.deepEqual((await calls(f)).at(-1).slice(0,3), ['open','-a','/System/Library/CoreServices/DiskImageMounter.app']);
    assert.equal(await readFile(info, 'utf8'), '0.1.1');
});
