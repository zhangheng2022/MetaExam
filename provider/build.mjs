import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  copyFileSync,
  constants,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..'),
  artifacts = path.join(root, 'artifacts');
const version = JSON.parse(
  readFileSync(path.join(root, 'apps/issuer/package.json'), 'utf8'),
).version;
const file = path.join(artifacts, `MetaExam-Issuer-Setup-${version}-win-x64-internal.exe`);
if (existsSync(file) || existsSync(file + '.sha256')) throw new Error('RELEASE_ALREADY_EXISTS');
mkdirSync(artifacts, { recursive: true });
const lock = path.join(artifacts, '.issuer-package.lock');
writeFileSync(lock, JSON.stringify({ pid: process.pid, version }), { flag: 'wx' });
process.once('exit', () => {
  try {
    if (JSON.parse(readFileSync(lock, 'utf8')).pid === process.pid) unlinkSync(lock);
  } catch {
    /* preserve unknown owner */
  }
});
const pnpm = path.join(root, '.tools/pnpm/node_modules/pnpm/bin/pnpm.cjs');
const run = (args) =>
  execFileSync(process.execPath, [pnpm, ...args], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
const reset = (directory) => {
  if (path.dirname(directory) !== artifacts || !path.basename(directory).startsWith('issuer-'))
    throw new Error('UNSAFE_PATH');
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
};
const vendor = JSON.parse(readFileSync(path.join(root, 'toolchain.lock.json'), 'utf8'));
for (const item of vendor.files.filter((item) => /node-official|innosetup/.test(item.file)))
  if (
    createHash('sha256')
      .update(readFileSync(path.join(root, item.file)))
      .digest('hex') !== item.sha256
  )
    throw new Error('VENDOR_CHECKSUM_MISMATCH');
run(['--filter', '@metaexam/issuer...', 'build']);
const electronDist = path.join(root, 'apps/desktop/node_modules/electron/dist');
const electronVersion = JSON.parse(
  readFileSync(path.join(root, 'apps/issuer/package.json'), 'utf8'),
).devDependencies.electron;
if (readFileSync(path.join(electronDist, 'version'), 'utf8').trim() !== electronVersion)
  throw new Error('ELECTRON_VERSION_MISMATCH');
run([
  'exec',
  'electron-builder',
  '--projectDir',
  'apps/issuer',
  '--win',
  '--x64',
  '--dir',
  '--config.electronDist=' + electronDist,
]);
const payload = path.join(artifacts, 'issuer-payload');
reset(payload);
cpSync(path.join(artifacts, 'issuer-desktop/win-unpacked'), payload, { recursive: true });
mkdirSync(path.join(payload, 'runtime'));
mkdirSync(path.join(payload, 'service'));
copyFileSync(path.join(root, '.tools/node/node.exe'), path.join(payload, 'runtime/node.exe'));
copyFileSync(path.join(root, '.tools/node/LICENSE'), path.join(payload, 'runtime/LICENSE.txt'));
await build({
  entryPoints: [path.join(root, 'apps/issuer/dist/worker.js')],
  outfile: path.join(payload, 'service/worker.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: false,
});
copyFileSync(path.join(root, 'docs/provider-issuer.md'), path.join(payload, 'README.md'));
copyFileSync(path.join(root, 'pnpm-lock.yaml'), path.join(payload, 'pnpm-lock.yaml'));
const builderRequire = createRequire(createRequire(import.meta.url).resolve('electron-builder'));
const asar = createRequire(builderRequire.resolve('app-builder-lib'))('@electron/asar');
const archive = path.join(payload, 'resources/app.asar'),
  entries = asar.listPackage(archive);
const denied = /private\.pem|\.sqlite(?:-wal|-shm)?$|\.missuer$|\.mlic$|WinSW|postgres/i;
const secret = /-----BEGIN (?:ENCRYPTED |RSA |EC )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=]{30}/;
for (const entry of entries) {
  const name = entry.replaceAll('\\', '/').replace(/^\//, '');
  if (denied.test(name)) throw new Error('PRIVATE_DATA_IN_PACKAGE');
  if (
    /\.(?:js|json|pem)$/.test(name) &&
    secret.test(asar.extractFile(archive, path.normalize(name)).toString('utf8'))
  )
    throw new Error('PRIVATE_KEY_IN_PACKAGE');
}
let count = 0;
function scan(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) scan(file);
    else {
      count++;
      if (denied.test(file)) throw new Error('PRIVATE_DATA_IN_PACKAGE');
      if (/\.(?:js|cjs|json|pem)$/.test(name) && secret.test(readFileSync(file, 'utf8')))
        throw new Error('PRIVATE_KEY_IN_PACKAGE');
    }
  }
}
scan(payload);
writeFileSync(
  path.join(artifacts, 'issuer-payload-scan.json'),
  JSON.stringify(
    {
      version,
      files: count,
      archiveEntries: entries.length,
      privateKeys: 0,
      ledgers: 0,
      databaseServices: 0,
    },
    null,
    2,
  ),
);
const staging = path.join(artifacts, 'issuer-staging');
reset(staging);
execFileSync(
  path.join(root, '.tools/inno/ISCC.exe'),
  ['/Qp', '/O' + staging, '/DIssuerVersion=' + version, path.join(root, 'installer/Issuer.iss')],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
copyFileSync(path.join(staging, path.basename(file)), file, constants.COPYFILE_EXCL);
writeFileSync(
  file + '.sha256',
  createHash('sha256').update(readFileSync(file)).digest('hex') + '  ' + path.basename(file) + '\n',
  { flag: 'wx' },
);
console.log('ISSUER_PACKAGE_READY ' + file);
