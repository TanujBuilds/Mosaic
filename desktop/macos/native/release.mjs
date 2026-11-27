import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

export const run = promisify(execFile);
export const product = 'Mosaic Desktop';
export const appName = product + '.app';
export const version = '0.1.2';
export const releaseTag = 'v' + version + '-desktop';
export const bundleId = 'dev.mosaic.desktop';
export const diskName = 'Mosaic-Desktop-arm64.dmg';
export const receiptName = 'Mosaic-Desktop-release.json';
const nodeTeam = 'HX7739G8FX';
const nodeDigest = 'ba7073582822078d8c90bca3facacc46690bc5366fab4b815aeef9148cd6e854';
const teamPattern = /^[A-Z0-9]{10}$/;
const submissionPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function sha256(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

export async function signingIdentity(identity, profile) {
    const {stdout} = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
    const valid = [...stdout.matchAll(/^\s*\d+\) ([\dA-F]{40}) "(Developer ID Application: .+ \(([A-Z\d]{10})\))"\s*$/gmi)];
    if (!valid.length) throw Error('Public release requires a valid Developer ID Application signing identity with its private key. None found in the keychain.');
    const match = valid.filter(([,hash,name]) => hash === identity || name === identity);
    if (match.length !== 1 || !profile) throw Error('Select one valid Developer ID Application identity with --identity and a stored --notary-profile.');
    return {hash:match[0][1], teamId:match[0][3], profile};
}

export async function notarize(file, profile) {
    const {stdout} = await run('/usr/bin/xcrun', ['notarytool', 'submit', file, '--keychain-profile', profile,
        '--wait', '--output-format', 'json', '--timeout', '2h']);
    const {status, id} = JSON.parse(stdout);
    if (status !== 'Accepted' || !submissionPattern.test(id)) throw Error('Apple notarization did not accept ' + path.basename(file) + ' (' + id + ', ' + status + ').');
    return id;
}

export async function staple(file) {
    await run('/usr/bin/xcrun', ['stapler', 'staple', file]);
    await run('/usr/bin/xcrun', ['stapler', 'validate', file]);
}

async function verifyDeveloperId(file, teamId, id, hardened) {
    if (!teamPattern.test(teamId)) throw Error('Expected an Apple developer team ID.');
    const requirement = 'anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' +
        ' and certificate leaf[subject.OU] = "' + teamId + '" and identifier "' + id + '"';
    await run('/usr/bin/codesign', ['--verify', '--strict', '-R=' + requirement, file]);
    const {stderr} = await run('/usr/bin/codesign', ['--display', '--verbose=4', file]);
    if (!/^Timestamp=.+/m.test(stderr) || (hardened && !/^CodeDirectory .*flags=\S*\([^)]*\bruntime\b[^)]*\)/m.test(stderr))) {
        throw Error('Missing secure timestamp or hardened runtime on ' + path.basename(file));
    }
}

const nativeMagic = new Set(['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca','7f454c46']);
async function nativeFiles(root) {
    const files = [];
    const visit = async sub => {
        for (const item of await fs.readdir(path.join(root,sub), {withFileTypes:true})) {
            const rel = path.join(sub,item.name);
            if (item.isDirectory()) { await visit(rel); continue; }
            if (!item.isFile()) throw Error('Unexpected link or special file in app: ' + rel);
            const fd = await fs.open(path.join(root,rel), 'r');
            let head;
            try {
                const buffer = Buffer.alloc(4);
                const {bytesRead} = await fd.read(buffer,0,4,0);
                head = buffer.subarray(0, bytesRead).toString('hex');
            } finally { await fd.close(); }
            if (nativeMagic.has(head) || head.startsWith('4d5a')) files.push(rel);
        }
    };
    await visit('');
    return files.sort();
}

export async function verifyApp(bundle, teamId) {
    if (!(await fs.lstat(bundle)).isDirectory()) throw Error('Expected a desktop app bundle directory.');
    const contents = path.join(bundle,'Contents');
    const {stdout} = await run('/usr/bin/plutil',['-convert','json','-o','-',path.join(contents,'Info.plist')]);
    const info = JSON.parse(stdout);
    if (info.CFBundleIdentifier !== bundleId || info.CFBundleShortVersionString !== version ||
        info.CFBundleExecutable !== product || info.LSMinimumSystemVersion !== '26.0') throw Error('Unexpected desktop app metadata.');
    const main = 'MacOS/' + product, node = 'Resources/runtime/bin/node';
    if (JSON.stringify(await nativeFiles(contents)) !== JSON.stringify([main,node])) throw Error('Unexpected embedded native executable inventory.');
    for (const item of [main,node]) {
        if ((await run('/usr/bin/lipo',['-archs',path.join(contents,item)])).stdout.trim() !== 'arm64') throw Error('Unexpected architecture: ' + item);
    }
    await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
    if (await sha256(path.join(contents,node)) !== nodeDigest) throw Error('Unexpected bundled Node digest.');
    await verifyDeveloperId(path.join(contents,node), nodeTeam, 'node', true);
    if (teamId) {
        await verifyDeveloperId(bundle,teamId,bundleId,true);
        await run('/usr/bin/xcrun',['stapler','validate',bundle]);
        await run('/usr/sbin/spctl',['--assess','--type','execute','--verbose=4',bundle]);
    }
    return sha256(path.join(contents,'Resources/desktop-manifest.json'));
}

export async function verifyImage(dmg, teamId) {
    await run('/usr/bin/hdiutil',['verify','-quiet',dmg]);
    if (teamId) {
        await verifyDeveloperId(dmg,teamId,bundleId + '.dmg',false);
        await run('/usr/bin/xcrun',['stapler','validate',dmg]);
        await run('/usr/sbin/spctl',['--assess','--type','open','--context','context:primary-signature','--verbose=4',dmg]);
    }
    const mount = await fs.mkdtemp(path.join(tmpdir(),'mosaic-desktop-volume-'));
    let mounted = false;
    try {
        await run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,dmg]);
        mounted = true;
        if (await fs.readlink(path.join(mount,'Applications')) !== '/Applications') throw Error('Missing Applications link.');
        return await verifyApp(path.join(mount,appName),teamId);
    } finally {
        if (mounted) await run('/usr/bin/hdiutil',['detach',mount]);
        await fs.rmdir(mount);
    }
}

export async function verifyRelease(dmg, receipt, expectedTeam) {
    const record = JSON.parse(await fs.readFile(receipt,'utf8'));
    if (record.schema !== 1 || record.mode !== 'public' || record.publishable !== true ||
        record.releaseTag !== releaseTag || record.version !== version || record.bundleId !== bundleId ||
        !teamPattern.test(expectedTeam) || record.teamId !== expectedTeam || record.dmg?.file !== diskName ||
        path.basename(dmg) !== diskName || !submissionPattern.test(record.notarization?.appSubmissionId) ||
        !submissionPattern.test(record.notarization?.dmgSubmissionId)) throw Error('A public release receipt for this desktop version and expected team is required.');
    const stat = await fs.lstat(dmg);
    if (!stat.isFile() || stat.size !== record.dmg.bytes || await sha256(dmg) !== record.dmg.sha256) throw Error('Desktop image differs from the release receipt.');
    if (await verifyImage(dmg,expectedTeam) !== record.resourceManifestSha256) throw Error('Mounted resource inventory differs from the release receipt.');
}
