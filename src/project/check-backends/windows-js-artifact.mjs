import {createHash} from 'node:crypto';
import path from 'node:path';
import {windowsFileSync} from '../../beta/windows-files.mjs';

export const windowsJavaScriptBackend = Object.freeze({id:'windows-isolated-js', revision:1});
export const javascriptArtifactManifest = 'javascript-artifact.json';
const quickJsRoot = 'node_modules/quickjs-wasi/';
export const quickJsPackageFiles = Object.freeze([
  'LICENSE','package.json','quickjs.wasm','dist/index.js','dist/extensions.js','dist/version.js','dist/wasi-shim.js',
]);
export const javascriptBootstrapFiles = Object.freeze([
  'isolated-js-program.mjs','isolated-js.mjs','isolated-js-child.mjs',
]);
export const javascriptArtifactFiles = Object.freeze([
  'node.exe','mosaic-windows-supervisor.exe',...javascriptBootstrapFiles,...quickJsPackageFiles.map(file => quickJsRoot + file),
]);
const sha = /^[0-9a-f]{64}$/u;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateWindowsJavaScriptArtifact(config) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('The isolated JavaScript artifact requires Windows x64');
  if (config?.schema !== 1 || !sha.test(config.artifactManifestSha256) ||
      !path.isAbsolute(config.artifactManifestPath) ||
      path.basename(config.artifactManifestPath) !== javascriptArtifactManifest)
    throw new Error('Invalid isolated JavaScript artifact identity');
  const root = path.dirname(config.artifactManifestPath);
  const manifest = windowsFileSync('read', config.artifactManifestPath, {max:32 * 1024});
  if (digest(manifest) !== config.artifactManifestSha256)
    throw new Error('Isolated JavaScript artifact manifest changed');
  const {schema, platform, arch, backend, nodeVersion, files} = JSON.parse(manifest);
  if (schema !== 1 || platform !== 'win32' || arch !== 'x64' || nodeVersion !== '24.22.3' ||
      backend?.id !== windowsJavaScriptBackend.id || backend.revision !== windowsJavaScriptBackend.revision ||
      !Array.isArray(files) || files.length !== javascriptArtifactFiles.length)
    throw new Error('Unexpected isolated JavaScript artifact schema');
  for (const [index, name] of javascriptArtifactFiles.entries()) {
    const entry = files[index];
    if (entry?.path !== name || !sha.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 1 || entry.bytes > 128 * 1024 * 1024)
      throw new Error('Invalid isolated JavaScript artifact inventory');
    const bytes = windowsFileSync('read', path.join(root,name), {max:entry.bytes});
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)
      throw new Error('Isolated JavaScript artifact file changed: ' + name);
  }
  return {root, fingerprint:config.artifactManifestSha256, backend, nodeVersion, files};
}
