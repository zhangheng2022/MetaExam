import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateVersions, validateDraft, assetNames } from '../tools/ci/release.mjs';
import { loadBuildTrust } from '../installer/trust.mjs';
const sha = 'a'.repeat(40),
  tag = 'v0.1.5';
const draft = {
  draft: true,
  tag_name: tag,
  target_commitish: sha,
  body: `<!-- metaexam-commit:${sha} -->`,
};
validateVersions('0.1.5', '0.1.4', '0.1.5', '0.1.4');
assert.throws(() => validateVersions('0.1.5', '0.1.4', '0.1.4', '0.1.4'), /VERSION_MISMATCH/);
assert.throws(
  () => validateVersions('../secret', '0.1.4', '../secret', '0.1.4'),
  /VERSION_MISMATCH/,
);
validateDraft(draft, sha, tag);
assert.throws(() => validateDraft({ ...draft, draft: false }, sha, tag), /ALREADY_PUBLISHED/);
assert.throws(
  () => validateDraft({ ...draft, target_commitish: 'master' }, sha, tag),
  /COMMIT_MISMATCH/,
);
assert.throws(() => validateDraft({ ...draft, body: '' }, sha, tag), /COMMIT_MISMATCH/);
assert.ok(assetNames('0.1.5', '0.1.4').every((n) => !/[\\/]/.test(n)));
const version = JSON.parse(readFileSync('package.json')).version;
const trust = loadBuildTrust(process.cwd(), version, 'test');
assert.equal(trust.manifest.version, version);
assert.equal(
  trust.manifest.keys[0].fingerprint,
  '463736646e1f97a3118da3568180d10991d3bc63b019bfaa929262426b75786f',
);
assert.throws(
  () => loadBuildTrust(process.cwd(), version, 'production'),
  /PRODUCTION_TRUST_MANIFEST_REQUIRED/,
);
console.log('PASS CI versions, release immutability, draft commit ownership and public test trust');
