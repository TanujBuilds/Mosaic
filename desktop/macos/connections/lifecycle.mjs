import {lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {client} from '../../../src/beta/client.mjs';
import {installedLauncher} from '../../../src/beta/install.mjs';
import {version} from '../core.mjs';
import {fileBytes,hash,jsonFile,locations} from '../../../src/beta/files.mjs';
import {readSettingsSync,readCredentialsSync} from '../../../src/beta/settings.mjs';
import {ConnectionError} from './configuration.mjs';

export function connectionPaths({home,isolated=false}) { return locations(home,isolated); }

export function stableBundle({appPath}) {
  return typeof appPath==='string' && path.isAbsolute(appPath) && appPath.endsWith('.app') &&
    !appPath.startsWith('/Volumes/') && !appPath.includes('/AppTranslocation/');
}

async function generation(file) {
  try {
    const st=await lstat(file,{bigint:true});
    // Portable writers atomically replace each private file. The public token
    // describes filesystem generations only, even on the first read after a
    // terminal credential rotation. No credential-derived digest leaves JS.
    return [st.dev,st.ino,st.ctimeNs,st.mtimeNs].join('-');
  } catch(error) { if(error.code==='ENOENT')return 'missing';throw error; }
}

export async function revision(paths) {
  const ids=await Promise.all([paths.config,paths.credentials].map(generation));
  return createHash('sha256').update(ids.join('/')).digest('hex');
}

export async function snapshot(paths) {
  const before=await revision(paths);
  const settings=readSettingsSync(paths),credentials=readCredentialsSync(paths);
  if(before!==await revision(paths))throw new ConnectionError('Connections changed in Terminal or another window. Reload Connections and try again.');
  return {settings,credentials,revision:before};
}

// Opening Connections inspects the stable install receipt and pinned native
// check identity without installing a release or starting a service.
export async function installationReason(paths,settings) {
  try {
    // Older releases can have different launcher bytes and a different schema.
    // Their version receipt is enough to explain how to keep using that setup.
    const header=await jsonFile(paths.installation,{privateFile:true,max:8192});
    if(header && header.version!==version) {
      const installed=/^0\.1\.0-beta\.\d{1,5}$/.test(header.version)?'Mosaic '+header.version:'another Mosaic release';
      return 'This Mac has '+installed+'. Mosaic Desktop uses '+version+'. Use your current terminal setup, or run the official Terminal installer when you are ready to update.';
    }
    const {receipt,bytes}=await installedLauncher(paths);
    if(!receipt && !bytes && !settings)return '';
    if(receipt && receipt.version!==version)
      return 'This installation uses a different Mosaic release. Use its terminal setup or update Mosaic Desktop.';
    if(!receipt || !bytes)return 'Restore this Mosaic installation with its terminal installer, then reopen Connections.';
    const native=settings?.nativeCheckRuntime;
    if(native) {
      const expected=path.join(paths.versions,version,'runtime','check-artifact','artifact-manifest.json');
      if(expected!==native.artifactManifestPath || hash(await fileBytes(expected,{max:32768}))!==native.artifactManifestSha256)
        return 'This setup uses a different protected-check runtime. Inspect it with mosaic doctor in Terminal.';
    }
    return '';
  } catch {
    return 'The shared Mosaic launcher or runtime needs repair. Run mosaic doctor in Terminal.';
  }
}

export async function installedGeneration(paths) {
  return (await Promise.all([paths.installation,paths.launcher].map(generation))).join('/');
}

export async function online(paths) {
  try { await client(paths,{viewer:true,timeoutMs:700})('tools_list'); return true; }
  catch { return false; }
}
