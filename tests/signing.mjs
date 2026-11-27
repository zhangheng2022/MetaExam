import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { signingInfo, signExecutable, verifyExecutable } from '../installer/signing.mjs';

const directory = mkdtempSync(path.resolve('.local/signing-test-'));
assert.equal(path.dirname(directory), path.resolve('.local'));
try {
  const source = path.resolve('apps/desktop/node_modules/electron/dist/electron.exe');
  const file = path.join(directory, 'sample.exe');
  copyFileSync(source, file);
  // An upstream signed or unsigned file must not count as our signature.
  assert.throws(() => verifyExecutable(file));
  const info = signingInfo();
  const signed = signExecutable(file);
  assert.equal(signed.thumbprint, info.thumbprint);
  assert.equal(verifyExecutable(file).thumbprint, info.thumbprint);
  const bytes = readFileSync(file);
  // Mutate an actual .text section byte, not excluded PE checksum/certificate fields.
  const pe = bytes.readUInt32LE(0x3c);
  const section = pe + 24 + bytes.readUInt16LE(pe + 20);
  const raw = bytes.readUInt32LE(section + 20);
  bytes[raw + 32] ^= 1;
  writeFileSync(file, bytes);
  assert.throws(() => verifyExecutable(file), /SIGNATURE_VERIFICATION_FAILED/);
  const previous = process.env.METAEXAM_SIGNING_HOME;
  try {
    process.env.METAEXAM_SIGNING_HOME = path.join(directory, 'missing');
    assert.throws(() => signingInfo());
  } finally {
    if (previous === undefined) delete process.env.METAEXAM_SIGNING_HOME;
    else process.env.METAEXAM_SIGNING_HOME = previous;
  }
  if (process.argv.includes('--packages')) {
    const version = JSON.parse(readFileSync('package.json')).version;
    const issuer = JSON.parse(readFileSync('apps/issuer/package.json')).version;
    for (const target of [
      `artifacts/MetaExam-Setup-${version}-win-x64-internal.exe`,
      `artifacts/MetaExam-Issuer-Setup-${issuer}-win-x64-internal.exe`,
      'artifacts/payload/manager/MetaExam.Manager.exe',
      'artifacts/issuer-payload/MetaExam.Issuer.exe',
    ])
      assert.equal(verifyExecutable(target).thumbprint, info.thumbprint);
  }
  console.log('SIGNING_OK: pinned signer, modified image rejected, missing configuration rejected');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
