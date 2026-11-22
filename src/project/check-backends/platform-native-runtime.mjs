import path from 'node:path';
import {isolatedJavaScriptRuntime} from './windows-isolated-js-runner.mjs';
import {javascriptArtifactManifest} from './windows-js-artifact.mjs';
import { Pause, relativePath } from '../contracts.mjs';
import * as darwin from './native-runtime-dispatch.mjs';
import {
  validateWindowsRuntime,
  windowsRelativePath,
  WINDOWS_BACKEND,
} from './windows-appcontainer.mjs';

export const windowsCodingHold = 'Protected coding is in development on Windows. A qualified Windows filesystem boundary is required before Mosaic can run a coding task.';
export const nativeImplementationSources = darwin.nativeImplementationSources;
export function validateNativeCheckRuntime(config, fingerprint) {
  if (process.platform === 'win32' && typeof config?.artifactManifestPath === 'string' &&
      path.basename(config.artifactManifestPath) === javascriptArtifactManifest)
    return isolatedJavaScriptRuntime(config,fingerprint);
  return process.platform === 'win32'
    ? validateWindowsRuntime(config, fingerprint)
    : darwin.validateNativeCheckRuntime(config, fingerprint);
}
export function nativeBackendFactory(configuration) {
  if (configuration.id === WINDOWS_BACKEND.id) {
    if (configuration.revision !== WINDOWS_BACKEND.revision)
      throw new Pause('Unsupported Windows backend revision', 'isolation');
    // Revision 1 failed its external-write qualification on a real Windows host.
    // Native qualification exercises the backend directly with disposable fixtures.
    throw new Pause(windowsCodingHold, 'isolation');
  }
  return darwin.nativeBackendFactory(configuration);
}
export function nativeCheckArgv(config, script, args = []) {
  if (process.platform !== 'win32') return darwin.nativeCheckArgv(config, script, args);
  windowsRelativePath(relativePath(script));
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string' || value.includes('\0')))
    throw new Pause('Native check arguments must be literal strings', 'isolation');
  return [validateWindowsRuntime(config).runtime.executable, script, ...args];
}
