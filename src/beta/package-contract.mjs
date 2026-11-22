import path from 'node:path';
import {windowsFile} from './windows-files.mjs';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateNativeCheckRuntime} from '../project/check-backends/platform-native-runtime.mjs';

// runtimeRoot is the installed version's runtime/ directory. No saved approval
// or command is relocated by this reader; callers prepare fresh literal argv.
export async function readBundledNativeCheckRuntime(runtimeRoot=fileURLToPath(new URL('../../',import.meta.url))){
 const artifactManifestPath=path.join(runtimeRoot,'check-artifact','artifact-manifest.json');
 const bytes=process.platform==='win32'?await windowsFile('read',artifactManifestPath,{max:128*1024}):await readFile(artifactManifestPath);
 const config={schema:1,artifactManifestPath,artifactManifestSha256:createHash('sha256').update(bytes).digest('hex')};
 validateNativeCheckRuntime(config);
 return config;
}
