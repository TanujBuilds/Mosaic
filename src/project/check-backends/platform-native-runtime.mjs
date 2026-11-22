import { Pause, relativePath } from '../contracts.mjs';
import * as darwin from './native-runtime-dispatch.mjs';
import {
  createWindowsBackend,
  validateWindowsRuntime,
  windowsRelativePath,
  WINDOWS_BACKEND,
} from './windows-appcontainer.mjs';

export const nativeImplementationSources = darwin.nativeImplementationSources;
export function validateNativeCheckRuntime(config, fingerprint) {
  return process.platform === 'win32'
    ? validateWindowsRuntime(config, fingerprint)
    : darwin.validateNativeCheckRuntime(config, fingerprint);
}
export function nativeBackendFactory(configuration) {
  if (configuration.id === WINDOWS_BACKEND.id) {
    if (configuration.revision !== WINDOWS_BACKEND.revision)
      throw new Pause('Unsupported Windows backend revision', 'isolation');
    return createWindowsBackend(configuration);
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
