import { command } from '../../src/project/command.mjs';
import { gitInvocation } from '../../src/project/git.mjs';

// This Git query lists variable names and needs no repository. Use the same
// isolated invocation policy as repository commands without reading metadata.
export async function assertNoGitRepositoryOverride(action) {
  const { executable, args, env } = gitInvocation(['rev-parse', '--local-env-vars'], { discover: false });
  const result = await command([executable, ...args], { cwd: '/', env, timeoutMs: 3000, maxBuffer: 8192 });
  if (result.stopped || result.code !== 0) throw Error('Could not inspect Git repository environment variables');
  const override = result.stdout.trim().split('\n').find(name => Object.hasOwn(process.env, name));
  if (override) throw Error('Clear Git repository override before running the ' + action + ': ' + override);
}
