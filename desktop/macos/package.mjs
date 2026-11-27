import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {appName, bundleId, diskName, notarize, product, receiptName, releaseTag, run, sha256,
    signingIdentity, staple, verifyApp, verifyImage, verifyRelease, version} from './native/release.mjs';

const release = '0.1.0-beta.228';
// Same pinned upstream tarball as install.sh. Never execute code from an
// archive until an independent trusted digest has matched the private copy.
const archiveDigest = 'a43a5bfba1eea70ed213ad401782250cb4193c0e011940b0f592f963fcfdd6d2';
const manifestDigest = 'ecd13a265d568d7cb8bcdf35cf0cbcb9022f3b8097194973873c12d11284e5ae';
const uiAssets = ['index.html', 'app.js', 'styles.css', 'assets/mosaic.svg'];
async function verifyPayload(root, manifest, selected = manifest.files) {
    for (let index = 0; index < selected.length; index += 24) {
        await Promise.all(selected.slice(index, index + 24).map(async record => {
            const file = path.join(root, record.path);
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.mode !== parseInt(record.mode, 8) ||
                stat.size !== record.bytes || await sha256(file) !== record.sha256) {
                throw Error('Portable file failed integrity verification: ' + record.path);
            }
        }));
    }
    if (((await fs.lstat(path.join(root, 'runtime/check-artifact'))).mode & 0o777) !== 0o700) {
        throw Error('The protected check directory must retain its release permissions.');
    }
}

async function fileCopy(src, dest) {
    if (!(await fs.lstat(src)).isFile()) throw Error('Expected a regular source file: ' + src);
    await fs.mkdir(path.dirname(dest), {recursive: true});
    await fs.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
}

async function copyModules(src, dest) {
    for (const item of await fs.readdir(src, {withFileTypes: true})) {
        if (item.name.startsWith('.') || /^(tests?|__tests__|fixtures?)$/.test(item.name)) continue;
        const from = path.join(src, item.name), to = path.join(dest, item.name);
        if (item.isSymbolicLink()) throw Error('Unexpected link in desktop modules: ' + from);
        if (item.isDirectory()) await copyModules(from, to);
        else if (item.name.endsWith('.mjs') && !/\.(test|spec)\.mjs$/.test(item.name)) await fileCopy(from, to);
    }
}

async function resourceManifest(resources, portable) {
    const files = [];
    const visit = async sub => {
        for (const item of await fs.readdir(path.join(resources,sub),{withFileTypes:true})) {
            const relative = path.join(sub,item.name);
            if (item.isDirectory()) { await visit(relative); continue; }
            if (!item.isFile()) throw Error('Unexpected resource type: ' + relative);
            files.push(relative);
        }
    };
    await visit('');
    const records = [];
    files.sort();
    for (let i=0; i<files.length; i+=24) {
        records.push(...await Promise.all(files.slice(i,i+24).map(async relative => {
            const file = path.join(resources,relative);
            const stat = await fs.stat(file);
            return {path:relative, bytes:stat.size, mode:stat.mode.toString(8), sha256:await sha256(file)};
        })));
    }
    return {schema:1, version, releaseTag, bundleId, architecture:'arm64', minimumMacOS:'26.0',
        portable:{version:release, archiveSha256:archiveDigest, manifestSha256:manifestDigest,
            nodeVersion:portable.nodeVersion}, files:records};
}

async function build(sourceRoot, archive, output, signer) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Package on an Apple silicon Mac.');
    const source = path.join(sourceRoot, 'desktop/macos');
    const native = path.join(source, 'native');
    await fs.mkdir(output, {recursive: true});
    const app = path.join(output, appName), dmg = path.join(output, diskName), receipt = path.join(output,receiptName);
    // A single publisher per output folder. Keep previously published files intact.
    const lock = path.join(output, '.mosaic-desktop-build.lock');
    await fs.mkdir(lock, {mode: 0o700});
    let stage;
    try {
        for (const target of [app, dmg, receipt]) {
            const exists = await fs.lstat(target).then(() => true, err => {
                if (err.code === 'ENOENT') return false;
                throw err;
            });
            if (exists) throw Error('Output already exists. Select a new output directory: ' + target);
        }
        stage = await fs.mkdtemp(path.join(output, '.mosaic-desktop-'));
        const copy = path.join(stage, 'portable.tar.gz');
        await fileCopy(archive, copy);
        if (await sha256(copy) !== archiveDigest) throw Error('Portable archive does not match the pinned release checksum.');
        const releasePath = 'mosaic-beta-' + release + '-darwin-arm64/payload';
        await run('/usr/bin/tar', ['-xpf', copy, '-C', stage, releasePath]);
        const payload = path.join(stage, releasePath);
        const manifestFile = path.join(payload, 'package-manifest.json');
        if (await sha256(manifestFile) !== manifestDigest) throw Error('Portable manifest checksum differs from the release.');
        const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
        if (manifest.fixture || !manifest.dependenciesInstalled || manifest.version !== release) throw Error('Unexpected runtime release.');
        await verifyPayload(payload, manifest);

        const volume = path.join(stage, 'volume'), bundle = path.join(volume, appName);
        const contents = path.join(bundle, 'Contents'), resources = path.join(contents, 'Resources');
        const macOS = path.join(contents, 'MacOS');
        await fs.mkdir(macOS, {recursive: true});
        await fs.mkdir(resources);
        // The signed GUI only needs Node and JS. The separately verified portable
        // installer owns the CLI, MCP server, and private check sandbox binaries.
        await fs.rm(path.join(payload,'runtime/check-artifact'), {recursive:true});
        for (const name of ['playwright','playwright-core']) {
            await fs.rm(path.join(payload,'runtime/node_modules',name), {recursive:true,force:true});
        }
        for (const file of ['runtime','LICENSE']) await fs.rename(path.join(payload,file),path.join(resources,file));
        const modules = path.join(resources, 'runtime/desktop/macos');
        for (const file of ['bridge.mjs', 'board.mjs', 'core.mjs']) await fileCopy(path.join(source,file),path.join(modules,file));
        for (const group of ['observation','connections']) await copyModules(path.join(source,group),path.join(modules,group));
        await fs.access(path.join(modules,'connections/index.mjs'));
        const setup = 'src/beta/portable-setup.mjs';
        await fs.unlink(path.join(resources,'runtime',setup));
        await fileCopy(path.join(sourceRoot,setup),path.join(resources,'runtime',setup));
        for (const file of uiAssets) await fileCopy(path.join(source, 'ui', file), path.join(resources, 'ui', file));

        const xcrun = (...args) => run('/usr/bin/xcrun', args);
        const sources = ['Mosaic', 'CodexRecent', 'Policy', 'Runner'].map(name => path.join(native, name + '.swift'));
        await xcrun('swiftc', '-target', 'arm64-apple-macos26.0', '-swift-version', '5', '-O',
            ...sources, '-o', path.join(macOS, product));
        const iconTool = path.join(stage, 'make-icon'), iconSet = path.join(stage, 'Mosaic.iconset');
        await xcrun('swiftc', '-parse-as-library', '-O', path.join(native, 'Icon.swift'), '-o', iconTool);
        await run(iconTool, [iconSet, path.join(resources, 'ui/assets/mosaic.svg')]);
        await run('/usr/bin/iconutil', ['-c', 'icns', iconSet, '-o', path.join(resources, 'Mosaic.icns')]);
        await fileCopy(path.join(native, 'Info.plist'), path.join(contents, 'Info.plist'));
        await run('/usr/bin/plutil', ['-lint', path.join(contents, 'Info.plist')]);
        const node = path.join(resources, 'runtime/bin/node');
        if ((await run(node, ['--version'])).stdout.trim() !== 'v' + manifest.nodeVersion) throw Error('Bundled Node version mismatch.');
        const inventory = await resourceManifest(resources,manifest);
        await fs.writeFile(path.join(resources,'desktop-manifest.json'),JSON.stringify(inventory,null,2)+'\n');
        const signing = signer ? ['--sign',signer.hash,'--timestamp','--options','runtime'] : ['--sign','-','--timestamp=none'];
        await run('/usr/bin/codesign',['--force',...signing,bundle]);
        await verifyApp(bundle,null);
        let notarization = null;
        if (signer) {
            // Staple the standalone app first so a Finder drag also carries an
            // offline-verifiable ticket. The final signed DMG gets its own ticket.
            const zip = path.join(stage,'desktop.zip');
            await run('/usr/bin/ditto',['-c','-k','--keepParent',bundle,zip]);
            const appSubmissionId = await notarize(zip,signer.profile);
            await staple(bundle);
            await verifyApp(bundle,signer.teamId);
            notarization = {appSubmissionId};
        }
        await fs.symlink('/Applications', path.join(volume,'Applications'));
        const stagedDMG = path.join(stage,diskName), stagedReceipt = path.join(stage,receiptName);
        await run('/usr/bin/hdiutil',['create','-quiet','-fs','HFS+','-format','UDZO','-volname',product,'-srcfolder',volume,stagedDMG]);
        if (signer) {
            await run('/usr/bin/codesign',['--sign',signer.hash,'--timestamp','--identifier',bundleId + '.dmg',stagedDMG]);
            notarization.dmgSubmissionId = await notarize(stagedDMG,signer.profile);
            await staple(stagedDMG);
        }
        await verifyImage(stagedDMG,signer?.teamId);
        const record = {schema:1,mode:signer?'public':'local',publishable:Boolean(signer),version,releaseTag,bundleId,
            architecture:'arm64',minimumMacOS:'26.0',teamId:signer?.teamId ?? null,notarization,
            portable:inventory.portable,resourceManifestSha256:await sha256(path.join(resources,'desktop-manifest.json')),
            dmg:{file:diskName,bytes:(await fs.stat(stagedDMG)).size,sha256:await sha256(stagedDMG)}};
        await fs.writeFile(stagedReceipt,JSON.stringify(record,null,2)+'\n');
        await fs.rename(bundle,app);
        try {
            await fs.link(stagedDMG,dmg);
            try { await fs.link(stagedReceipt,receipt); }
            catch (error) { await fs.unlink(dmg); throw error; }
        } catch (error) { await fs.rename(app,bundle); throw error; }
        console.log([app,dmg,receipt].join('\n'));
    } finally {
        if (stage) await fs.rm(stage, {recursive: true, force: true});
        await fs.rmdir(lock);
    }
}

try {
    const {values} = parseArgs({options: {
        archive:{type:'string'}, output:{type:'string'}, 'source-root':{type:'string'}, mode:{type:'string',default:'local'},
        identity:{type:'string'}, 'notary-profile':{type:'string'}, 'verify-dmg':{type:'string'}, receipt:{type:'string'},
        'team-id':{type:'string'}, help:{type:'boolean'}
    }});
    const help = [
        'node desktop/macos/package.mjs --archive <pinned portable .tar.gz> --output <new directory> [--source-root <checkout>]',
        '  [--mode public --identity <Developer ID Application identity> --notary-profile <Keychain profile>]',
        'node desktop/macos/package.mjs --verify-dmg <final.dmg> --receipt <release.json> --team-id <expected Apple team ID>'
    ].join('\n');
    if (values.help) console.log(help);
    else if (values['verify-dmg']) {
        if (!values.receipt || !values['team-id']) throw Error(help);
        await verifyRelease(path.resolve(values['verify-dmg']),path.resolve(values.receipt),values['team-id']);
        console.log('Verified public Mosaic Desktop release ' + releaseTag);
    } else {
        if (!values.archive || !values.output || !['public','local'].includes(values.mode) ||
            (values.mode === 'local' && (values.identity || values['notary-profile']))) throw Error(help);
        const signer = values.mode === 'public' ? await signingIdentity(values.identity,values['notary-profile']) : null;
        const root = values['source-root'] ?? fileURLToPath(new URL('../../', import.meta.url));
        await build(path.resolve(root),path.resolve(values.archive),path.resolve(values.output),signer);
    }
} catch (err) {
    console.error(err.message);
    process.exitCode = 1;
}
