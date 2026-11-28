import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const run = promisify(execFile);
const desktop = fileURLToPath(new URL('../../', import.meta.url));
const archive = process.argv[2];
if (!archive) throw Error('Pass the pinned Mosaic portable .tar.gz as the only argument.');
const temp = await fs.mkdtemp(path.join(tmpdir(), 'mosaic-desktop-volume-'));
const output = path.join(temp, 'output');
const source = path.join(temp, 'fixture/desktop/macos');
const mount = path.join(temp, 'mount');
const pack = file => run(process.execPath, [path.join(desktop,'package.mjs'), '--archive', file,
    '--output', output, '--source-root', path.join(temp, 'fixture')]);

async function sha(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

let mounted = false;
try {
    await fs.mkdir(source, {recursive: true});
    await fs.cp(path.join(desktop,'native'), path.join(source,'native'), {recursive:true});
    await fs.mkdir(path.join(source, 'ui/assets'), {recursive:true});
    await fs.copyFile(path.join(desktop, 'ui/assets/mosaic.svg'), path.join(source,'ui/assets/mosaic.svg'));
    await fs.mkdir(path.join(source, 'ui/tests'));
    await fs.mkdir(path.join(source, 'observation/fixtures'), {recursive: true});
    await fs.mkdir(path.join(source, 'connections/tests'), {recursive: true});
    const overlay = path.join(temp,'fixture/src/beta/portable-setup.mjs');
    await fs.mkdir(path.dirname(overlay),{recursive:true});
    await fs.writeFile(overlay,'export const fixtureOverlay = true;\n');
    const fixtureFiles = {'core.mjs':'export {};','bridge.mjs':'export {};', 'board.mjs':'export {};', 'observation/status.mjs':'export {};',
        'connections/index.mjs':'export {};', 'ui/index.html':'<!doctype html>',
        'ui/app.js':'void 0;', 'ui/styles.css':'body{}', 'ui/tests/secret.js':'x',
        'observation/fixtures/private.mjs':'x', 'connections/tests/private.mjs':'x', 'connections/disallowed.test.mjs':'x'};
    for (const [name, body] of Object.entries(fixtureFiles)) await fs.writeFile(path.join(source,name), body);
    const forged = path.join(temp,'bad.tar.gz');
    await fs.writeFile(forged, 'fixture: reject before extraction');
    await assert.rejects(pack(forged), /pinned release checksum/);
    await pack(archive);
    await assert.rejects(pack(archive), /Output already exists/);
    const dmg = path.join(output,'Mosaic-Desktop-arm64.dmg');
    const receipt = path.join(output,'Mosaic-Desktop-release.json');
    const record = JSON.parse(await fs.readFile(receipt));
    assert.equal(record.mode,'local');
    assert.equal(record.publishable,false);
    assert.equal(record.releaseTag,'v0.1.2-desktop');
    assert.equal(record.notarization,null);
    assert.equal(record.dmg.sha256,await sha(dmg));
    assert.equal(record.dmg.bytes,(await fs.stat(dmg)).size);
    const verifyPublic = () => run(process.execPath,[path.join(desktop,'package.mjs'),'--verify-dmg',dmg,'--receipt',receipt,'--team-id','A123456789']);
    await assert.rejects(verifyPublic(),/public release receipt/);
    // Editing a JSON receipt cannot promote an ad-hoc image: verify the image signature.
    Object.assign(record,{mode:'public',publishable:true,teamId:'A123456789',notarization:{
        appSubmissionId:'11111111-1111-1111-1111-111111111111',dmgSubmissionId:'22222222-2222-2222-2222-222222222222'}});
    await fs.writeFile(receipt,JSON.stringify(record));
    await assert.rejects(verifyPublic(), /not signed|code object is not signed|code failed to satisfy|invalid signature/i);
    await fs.mkdir(mount);
    await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    mounted = true;
    assert.equal(await fs.readlink(path.join(mount,'Applications')), '/Applications');
    const app = path.join(mount, 'Mosaic Desktop.app');
    await run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
    const contents = path.join(app,'Contents'), resources = path.join(contents,'Resources');
    const info = JSON.parse((await run('/usr/bin/plutil',['-convert','json','-o','-',path.join(contents,'Info.plist')])).stdout);
    assert.equal(info.CFBundleIdentifier, 'dev.mosaic.desktop');
    assert.equal(info.LSMinimumSystemVersion, '26.0');
    assert.equal(info.CFBundleShortVersionString,'0.1.2');
    for (const unwanted of ['Resources/runtime/check-artifact','MacOS/mosaic-preview-mcp']) {
        await assert.rejects(fs.lstat(path.join(contents,unwanted)),{code:'ENOENT'});
    }
    const inventoryFile = path.join(resources,'desktop-manifest.json');
    assert.equal(record.resourceManifestSha256,await sha(inventoryFile));
    const inventory = JSON.parse(await fs.readFile(inventoryFile));
    assert.equal(inventory.portable.archiveSha256,await sha(archive));
    const critical = ['runtime/bin/node','LICENSE','runtime/DEPENDENCY-LICENSES.txt','runtime/THIRD_PARTY_NOTICES.md',
        'runtime/NODE-LICENSE','runtime/src/beta/portable-setup.mjs','runtime/desktop/macos/core.mjs'];
    for (const name of critical) {
        const entry = inventory.files.find(record => record.path === name);
        assert.ok(entry,name);
        const file = path.join(resources,name);
        assert.equal((await fs.stat(file)).mode,parseInt(entry.mode,8),name);
        assert.equal(await sha(file),entry.sha256,name);
    }
    assert.equal(await sha(overlay),await sha(path.join(resources,'runtime/src/beta/portable-setup.mjs')));
    const paths = await fs.readdir(path.join(resources,'runtime/desktop/macos'), {recursive:true});
    assert.deepEqual(paths.filter(x => /private|disallowed|fixtures|tests/.test(x)), []);
    assert.ok(paths.includes('connections/index.mjs'));
    assert.ok(!paths.includes('connections/service.mjs'));
    assert.deepEqual((await fs.readdir(path.join(resources, 'ui'))).sort(), ['app.js','assets','index.html','styles.css']);
    console.log('Verified pinned runtime, mounted desktop app, local release receipt, public promotion rejection, payload inventory and shared setup overlay.');
} finally {
    // If detach fails, leave the mountpoint for inspection; never recursively remove a live mount.
    if (mounted) await run('/usr/bin/hdiutil', ['detach', mount]);
    await fs.rm(temp,{recursive:true,force:true});
}
