// Emit a local Git patch after the packaging verifier authenticates the image.
// The release owner publishes the checked asset before applying this patch on main.
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const version = '0.1.2';
const releaseTag = 'v' + version + '-desktop';
const asset = 'Mosaic-Desktop-arm64.dmg';
const receiptName = 'Mosaic-Desktop-release.json';
const link = 'https://github.com/TanujBuilds/Mosaic/releases/download/' + releaseTag + '/' + asset;
const marker = '<!-- mosaic-desktop-release -->';
const download = '**[Download Mosaic Desktop for Apple Silicon](' + link + ')** (' + version
    + ', macOS 26 or later). Open the disk image, drag Mosaic Desktop to Applications, then open the app.';
const choice = 'The Terminal command below also offers a choice of the desktop app or the guided Terminal setup.';

async function main() {
    const { values } = parseArgs({ options: {
        dmg: { type: 'string' }, receipt: { type: 'string' }, 'team-id': { type: 'string' }, help: { type: 'boolean' }
    } });
    const usage = 'node distribution/desktop/promote.mjs --dmg <Mosaic-Desktop-arm64.dmg> --receipt <Mosaic-Desktop-release.json> --team-id <Apple Team ID>';
    if (values.help) { console.log(usage); return; }
    const team = values['team-id'];
    if (!values.dmg || !values.receipt || !/^[A-Z0-9]{10}$/.test(team ?? '')) throw Error(usage);
    if (path.basename(values.dmg) !== asset || path.basename(values.receipt) !== receiptName) throw Error(usage);
    for (const input of [values.dmg, values.receipt]) {
        if (!(await lstat(input)).isFile()) throw Error('Expected a regular file at ' + input);
    }
    const temp = await mkdtemp(path.join(tmpdir(), 'mosaic-desktop-promotion-'));
    try {
        // Bind validation and pin generation to the same private snapshot.
        const image = path.join(temp, asset), receipt = path.join(temp, receiptName);
        await copyFile(values.dmg, image);
        await copyFile(values.receipt, receipt);
        const r = JSON.parse(await readFile(receipt, 'utf8'));
        if (r.schema !== 1 || r.mode !== 'public' || r.publishable !== true || r.releaseTag !== releaseTag
            || r.bundleId !== 'dev.mosaic.desktop' || r.version !== version || r.teamId !== team
            || r.dmg?.file !== asset || !Number.isSafeInteger(r.dmg.bytes) || r.dmg.bytes <= 0
            || !/^[0-9a-f]{64}$/.test(r.dmg.sha256) || r.dmg.bytes !== (await lstat(image)).size) {
            throw Error('The receipt does not describe the expected public desktop release.');
        }
        const verify = path.join(root, 'desktop/macos/package.mjs');
        await run(process.execPath, [verify, '--verify-dmg', image, '--receipt', receipt, '--team-id', team]);

        const pin = "my $desktop_release = { version => '" + version + "', team => '" + team
            + "', bytes => " + r.dmg.bytes + ", sha256 => '" + r.dmg.sha256 + "' };";
        const before = {}, after = {};
        before['install.sh'] = await readFile(path.join(root, 'install.sh'), 'utf8');
        const declarations = before['install.sh'].match(/^my \$desktop_release = .*;$/gm);
        if (declarations?.length !== 1 || !['my $desktop_release = undef;', pin].includes(declarations[0])) {
            throw Error('Installer pins conflict with this release. Published release pins are immutable.');
        }
        after['install.sh'] = before['install.sh'].replace(declarations[0], () => pin);
        before['README.md'] = await readFile(path.join(root, 'README.md'), 'utf8');
        const paragraph = [download, choice, marker].join('\n\n');
        if (before['README.md'].split(marker).length !== 2) throw Error('Missing or duplicate desktop release marker in README.');
        after['README.md'] = before['README.md'].includes(paragraph)
            ? before['README.md'] : before['README.md'].replace(marker, () => paragraph);

        for (const [dir, files] of [['a', before], ['b', after]]) {
            await mkdir(path.join(temp, dir));
            for (const [file, body] of Object.entries(files)) await writeFile(path.join(temp, dir, file), body, {mode:file === 'install.sh' ? 0o755 : 0o644});
        }
        try {
            await run('git', ['diff', '--no-index', '--no-prefix', '--no-color', '--no-ext-diff', '--', 'a', 'b'], { cwd: temp });
            console.error('Release pins and download link already match.');
        } catch (error) {
            if (error.code !== 1 || !error.stdout.startsWith('diff --git ')) throw error;
            process.stdout.write(error.stdout);
        }
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.stderr?.trim() || error.message);
    process.exitCode = 1;
});
