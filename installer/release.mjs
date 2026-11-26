import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const programParts = ['server', 'web', 'manager', 'maintenance', 'licenses'];
export async function ordinary(file) {
  let at = path.resolve(file);
  while (true) {
    if ((await lstat(at)).isSymbolicLink()) throw new Error('UPGRADE_UNSAFE_PATH');
    const parent = path.dirname(at);
    if (at === parent) return;
    at = parent;
  }
}
export async function hashFile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error('UPGRADE_UNSAFE_PATH');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function inventory(root) {
  const files = {};
  async function walk(directory) {
    await ordinary(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile())
        files[path.relative(root, file).replaceAll('\\', '/')] = await hashFile(file);
      else throw new Error('UPGRADE_UNSAFE_PATH');
    }
  }
  await walk(root);
  delete files['release.json'];
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
export function buildId(release) {
  const body = { ...release };
  delete body.buildId;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
export function compareVersions(a, b) {
  if (![a, b].every((v) => /^\d+\.\d+\.\d+$/.test(v))) throw new Error('UPGRADE_VERSION_INVALID');
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}
export async function readRelease(root, verify = true) {
  await ordinary(root);
  const file = path.join(root, 'release.json');
  await ordinary(file);
  if ((await lstat(file)).size > 4 * 1024 * 1024) throw new Error('UPGRADE_MANIFEST_INVALID');
  const r = JSON.parse(await readFile(file, 'utf8'));
  if (
    r.format !== 1 ||
    r.product !== 'MetaExam' ||
    r.arch !== 'x64' ||
    r.postgresMajor !== 18 ||
    r.buildId !== buildId(r) ||
    !Number.isInteger(r.schemaVersion) ||
    !Array.isArray(r.migrations) ||
    r.migrations.length !== r.schemaVersion ||
    !r.files ||
    typeof r.files !== 'object'
  )
    throw new Error('UPGRADE_MANIFEST_INVALID');
  compareVersions(r.version, r.minimumVersion);
  if (r.migrations.some((m, i) => m.version !== i + 1 || !/^[a-f0-9]{64}$/.test(m.checksum)))
    throw new Error('UPGRADE_MANIFEST_INVALID');
  for (const part of programParts)
    if (!Object.keys(r.files).some((name) => name.startsWith(part + '/')))
      throw new Error('UPGRADE_MANIFEST_INVALID');
  for (const [name, digest] of Object.entries(r.files))
    if (
      !name ||
      /[\\:]|(^|\/)\.\.?($|\/)/.test(name) ||
      path.isAbsolute(name) ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw new Error('UPGRADE_MANIFEST_INVALID');
  if (verify && JSON.stringify(await inventory(root)) !== JSON.stringify(r.files))
    throw new Error('UPGRADE_PAYLOAD_CHANGED');
  return r;
}
