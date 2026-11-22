import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {windowsGitProcess} from '../../src/project/windows-git.mjs';

// The legacy QA branches retain their original immutable artifact.
const historical = {
  source:'97b7ae388f3e8d03f4eba132a24c57e3997d62df', tree:'88aef246de25262301203e1be9a60a681a0c201c',
  artifactId:14742128055, archiveSha:'bfcaf46c70228dea09b80746455233b89a6c3667c8e5549b24a8666d0cc4ddaf',
  manifestSha:'ef7e57ef39cb25eb5a56e4b90b52a0c8bc5b1947eb066058ff948a616f2be21e',
  bootstrapSha:'6a1e53c0d9874ce6839cc7e65a2db5e6cd8992b3c6bc07b8757e325e828342e1',
};
export function installedCandidate(host) {
  const env = process.env;
  if (['refs/heads/codex/windows-js-hosts','refs/heads/codex/windows-js-worker-hosts'].includes(env.GITHUB_REF)) {
    assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
    assert.ok(!env.MOSAIC_QA_CANDIDATE && !env.MOSAIC_QA_ARTIFACT_ID);
    if (env.GITHUB_REF === 'refs/heads/codex/windows-js-worker-hosts') return {
      version:'0.1.0-beta.235',source:'784766c5dd98ac8f8046182fa6a359952a9ad006',tree:'bd524ff96f52223ad2a71311e6e4ba3b8c3f70ce',
      artifactId:14767202712,archiveSha:'fb99b8a849d6cd42cd80a7a0ad07871f07b648ba5921a9e5cc5cee7d35c9f53b',
      manifestSha:'ba383c352bce919f73088c98d25a0dcf6249b31f2555eeda63657ecdaf228062', bootstrapSha:'6a1e53c0d9874ce6839cc7e65a2db5e6cd8992b3c6bc07b8757e325e828342e1',
      javascriptFingerprint:'dcc13cfd0085e091f3ae444615c0e14eaee4d7368fdf8f6243b1ebab8337b84c',
    };
    return {
      version:'0.1.0-beta.234',source:'7cf176d1cdb3260182f5e1c1e7ac3a673c93af7b',tree:'17586a60fa4f26b5d7ed23d6314952071eb7be4b',
      artifactId:14766183423,archiveSha:'78f5ef24be34a7cfefd4cc4f0e07e5bda7181b71c5286c20c7606f42886fd311',
      manifestSha:'835a3db94530d8744514bc17ebc11c17ebbab4c533aa25098fe4cb4c34f56e83', bootstrapSha:'6a1e53c0d9874ce6839cc7e65a2db5e6cd8992b3c6bc07b8757e325e828342e1',
      javascriptFingerprint:'dcc13cfd0085e091f3ae444615c0e14eaee4d7368fdf8f6243b1ebab8337b84c',
    };
  }
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  if (env.GITHUB_REF === 'refs/heads/codex/windows-' + host + '-installed') {
    assert.ok(!env.MOSAIC_QA_CANDIDATE && !env.MOSAIC_QA_ARTIFACT_ID);
    return historical;
  }
  assert.ok(['refs/heads/codex/windows-ci-qualification', 'refs/heads/codex/windows-installed-current'].includes(env.GITHUB_REF));
  const pin = JSON.parse(env.MOSAIC_QA_CANDIDATE);
  assert.equal(pin.sourceCommit, env.GITHUB_SHA);
  assert.match(pin.sourceCommit, /^[0-9a-f]{40}$/);
  const git = windowsGitProcess();
  assert.ok(git);
  const tree = execFileSync(git.executable, ['-C', env.GITHUB_WORKSPACE, 'rev-parse', 'HEAD^{tree}'],
    {encoding:'utf8', cwd:git.cwd, env:git.env, windowsHide:true}).trim();
  assert.equal(pin.sourceTree, tree);
  for (const digest of [pin.archiveSha256, pin.packageManifestSha256, pin.bootstrapSha256]) {
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
  assert.match(env.MOSAIC_QA_ARTIFACT_ID, /^[1-9]\d*$/);
  const artifactId = Number(env.MOSAIC_QA_ARTIFACT_ID);
  assert.ok(Number.isSafeInteger(artifactId));
  return {source:pin.sourceCommit, tree, artifactId, archiveSha:pin.archiveSha256,
    manifestSha:pin.packageManifestSha256, bootstrapSha:pin.bootstrapSha256};
}
