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

export async function readBundledJavaScriptCheckRuntime(runtimeRoot, descriptor) {
 if(process.platform!=='win32'||!descriptor) return null;
 const {javascriptArtifactDirectory,javascriptArtifactManifest,windowsJavaScriptBackend}=await import('../project/check-backends/windows-js-artifact.mjs');
 if(descriptor.backend?.id!==windowsJavaScriptBackend.id||descriptor.backend.revision!==windowsJavaScriptBackend.revision||
    !/^[a-f0-9]{64}$/.test(descriptor.fingerprint??''))throw Error('Unexpected installed Windows JavaScript runtime descriptor');
 const config={schema:1,artifactManifestPath:path.join(runtimeRoot,javascriptArtifactDirectory,javascriptArtifactManifest),
  artifactManifestSha256:descriptor.fingerprint};
 validateNativeCheckRuntime(config);
 return config;
}
