import { build as bundle } from 'esbuild';
import {
  existsSync,
  mkdirSync,
  cpSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..'),
  artifacts = path.join(root, 'artifacts'),
  payload = path.join(artifacts, 'payload');
const pnpm = path.join(root, '.tools/pnpm/node_modules/pnpm/bin/pnpm.cjs');
function run(args) {
  execFileSync(process.execPath, [pnpm, ...args], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
}
function safeReset(target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(artifacts + path.sep) || resolved === artifacts)
    throw new Error('Unsafe build cleanup target');
  if (existsSync(resolved)) rmSync(resolved, { recursive: true, force: true });
  mkdirSync(resolved, { recursive: true });
}
const lock = JSON.parse(readFileSync(path.join(root, 'toolchain.lock.json'), 'utf8'));
for (const item of lock.files) {
  const file = path.join(root, item.file);
  if (
    !existsSync(file) ||
    createHash('sha256').update(readFileSync(file)).digest('hex') !== item.sha256
  )
    throw new Error('VENDOR_CHECKSUM_MISMATCH: ' + item.file);
}
run(['build']);
safeReset(payload);
for (const d of [
  'runtime',
  'server',
  'services',
  'web',
  'manager',
  'maintenance',
  'vendor',
  'postgres',
  'licenses',
])
  mkdirSync(path.join(payload, d), { recursive: true });
// Optional Nest integrations are deliberately unused in this phase.
const externals = [
  'pg-native',
  '@nestjs/microservices',
  '@nestjs/websockets',
  '@nestjs/platform-express',
  'class-transformer',
  'class-validator',
  '@fastify/view',
  '@fastify/multipart',
];
const entries = {
  api: 'apps/api/dist/main.js',
  worker: 'apps/worker/dist/main.js',
  cli: 'apps/worker/dist/cli.js',
  db: 'packages/db/dist/index.js',
};
const dependencyDirs = new Set();
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
for (const name of ['react', 'react-dom'])
  dependencyDirs.add(path.dirname(webRequire.resolve(name + '/package.json')));
const reactDomRequire = createRequire(webRequire.resolve('react-dom/package.json'));
dependencyDirs.add(path.dirname(reactDomRequire.resolve('scheduler/package.json')));
for (const [name, entry] of Object.entries(entries)) {
  const result = await bundle({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(payload, 'server', name + '.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: externals,
    metafile: true,
    sourcemap: false,
    legalComments: 'eof',
  });
  writeFileSync(
    path.join(artifacts, name + '-bundle-manifest.json'),
    JSON.stringify(result.metafile),
  );
  for (const file of Object.keys(result.metafile.inputs)) {
    if (!file.includes('node_modules')) continue;
    let dir = path.dirname(path.resolve(root, file));
    while (dir !== root && !existsSync(path.join(dir, 'package.json'))) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (existsSync(path.join(dir, 'package.json'))) dependencyDirs.add(dir);
  }
}
const notices = [],
  noticed = new Set();
for (let dir of dependencyDirs) {
  let pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  while (!pkg.name) {
    dir = path.dirname(dir);
    if (dir === path.dirname(dir)) throw new Error('PACKAGE_LICENSE_ROOT_MISSING');
    if (existsSync(path.join(dir, 'package.json')))
      pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  }
  if (noticed.has(pkg.name + '@' + pkg.version)) continue;
  noticed.add(pkg.name + '@' + pkg.version);
  const dest = path.join(
    payload,
    'licenses/npm',
    pkg.name.replaceAll('/', '_') + '-' + pkg.version,
  );
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(dir))
    if (/^(licen[cs]e|copying|notice)/i.test(name) && statSync(path.join(dir, name)).isFile())
      copyFileSync(path.join(dir, name), path.join(dest, name));
  notices.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? 'see upstream notice',
  });
}
writeFileSync(
  path.join(payload, 'licenses/backend-dependencies.json'),
  JSON.stringify(notices, null, 2),
);
run(['exec', 'electron-builder', '--projectDir', 'apps/desktop', '--win', '--x64', '--dir']);
cpSync(path.join(artifacts, 'desktop/win-unpacked'), path.join(payload, 'manager'), {
  recursive: true,
});
cpSync(path.join(root, 'apps/web/dist'), path.join(payload, 'web'), { recursive: true });
copyFileSync(path.join(root, '.tools/node/node.exe'), path.join(payload, 'runtime/node.exe'));
copyFileSync(
  path.join(root, '.tools/node/LICENSE'),
  path.join(payload, 'licenses/Node-LICENSE.txt'),
);
copyFileSync(
  path.join(root, '.tools/inno/license.txt'),
  path.join(payload, 'licenses/Inno-Setup-LICENSE.txt'),
);
for (const dir of ['bin', 'lib', 'share'])
  cpSync(path.join(root, '.tools/pgsql', dir), path.join(payload, 'postgres', dir), {
    recursive: true,
  });
for (const name of ['server_license.txt', 'commandlinetools_3rd_party_licenses.txt'])
  copyFileSync(path.join(root, '.tools/pgsql', name), path.join(payload, 'licenses', name));
for (const name of ['setup.mjs', 'postgres-service.mjs'])
  copyFileSync(path.join(root, 'installer', name), path.join(payload, 'maintenance', name));
for (const name of ['WinSW.NET462.exe', 'vc_redist.x64.exe'])
  copyFileSync(path.join(root, '.tools', name), path.join(payload, 'vendor', name));
copyFileSync(path.join(root, 'pnpm-lock.yaml'), path.join(payload, 'licenses/pnpm-lock.yaml'));
copyFileSync(
  path.join(root, 'toolchain.lock.json'),
  path.join(payload, 'licenses/toolchain.lock.json'),
);
const trust = path.join(root, '.local/provider/public-keys.json');
if (!existsSync(trust))
  throw new Error(
    'Generate isolated internal test keys with tools/provider-test.mjs keygen .local/provider',
  );
const keys = JSON.parse(readFileSync(trust, 'utf8'));
for (const value of Object.values(keys))
  if (typeof value !== 'string' || !value.startsWith('-----BEGIN PUBLIC KEY-----'))
    throw new Error('Invalid public trust');
writeFileSync(path.join(payload, 'public-keys.json'), JSON.stringify(keys, null, 2));
writeFileSync(
  path.join(payload, 'INTERNAL-TEST.txt'),
  'Internal unsigned phase 1 package. No production signing key. Windows service installation and restart acceptance pending. Public test key only; no signing tool included.\n',
);
if (existsSync(path.join(root, 'docs/phase1-acceptance.md')))
  copyFileSync(path.join(root, 'docs/phase1-acceptance.md'), path.join(payload, 'ACCEPTANCE.md'));
const all = [];
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.isFile()) all.push(f);
  }
}
walk(payload);
const denied = [];
const builderRequire = createRequire(createRequire(import.meta.url).resolve('electron-builder'));
const asar = createRequire(builderRequire.resolve('app-builder-lib'))('@electron/asar');
const archive = path.join(payload, 'manager/resources/app.asar');
const archiveEntries = asar.listPackage(archive);
for (const entry of archiveEntries) {
  const name = entry.replaceAll('\\', '/').replace(/^\//, '');
  if (/provider-test|private\.pem|\.mlic$|\.env$/.test(name)) denied.push('app.asar:' + name);
  if (
    /\.(json|js|pem|key)$/.test(name) &&
    /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=]{30}/.test(
      asar.extractFile(archive, path.normalize(name)).toString('utf8'),
    )
  )
    denied.push('app.asar:' + name);
}
for (const file of all) {
  const name = path.relative(payload, file);
  if (
    /provider-test|private\.pem|\.mlic$|\.env$|config\.json$/.test(name) &&
    !name.includes('locales')
  )
    denied.push(name);
  if (
    /\.(json|pem|key|txt|mjs|cjs|js)$/.test(file) &&
    statSync(file).size < 20000000 &&
    /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=]{30}/.test(
      readFileSync(file, 'utf8'),
    )
  )
    denied.push(name);
}
if (denied.length) throw new Error('PRIVATE_MATERIAL_IN_PAYLOAD: ' + denied.join(','));
writeFileSync(
  path.join(artifacts, 'payload-scan.json'),
  JSON.stringify(
    {
      files: all.length,
      electronArchiveEntries: archiveEntries.length,
      privateKeys: 0,
      providerTools: 0,
      trust: 'ephemeral internal-test public key only',
    },
    null,
    2,
  ),
);
execFileSync(
  path.join(root, '.tools/inno/ISCC.exe'),
  ['/Qp', path.join(root, 'installer/MetaExam.iss')],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
const exe = path.join(artifacts, 'MetaExam-Setup-0.1.0-win-x64-internal.exe');
writeFileSync(
  exe + '.sha256',
  createHash('sha256').update(readFileSync(exe)).digest('hex') + '  ' + path.basename(exe) + '\n',
);
console.log('INTERNAL_PACKAGE_READY ' + exe);
