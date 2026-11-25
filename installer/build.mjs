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
  realpathSync,
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
  'exceljs',
  'sharp',
];
const entries = {
  api: 'apps/api/dist/main.js',
  worker: 'apps/worker/dist/main.js',
  cli: 'apps/worker/dist/cli.js',
  db: 'packages/db/dist/index.js',
  'file-processor': 'packages/db/dist/file-processor.js',
};
const dependencyDirs = new Set();
// Keep native image binaries and ExcelJS's runtime resources beside their packages.
// Resolve every edge from its owning package, preserving pnpm's pinned versions.
function packageDir(name, parent) {
  const require = createRequire(path.join(parent, 'package.json'));
  // Native optional packages may export only ./sharp.node, with neither a main
  // entry nor package.json export. Resolve their installed directories directly.
  for (const search of require.resolve.paths(name + '/package.json') ?? []) {
    const dir = path.join(search, name),
      file = path.join(dir, 'package.json');
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === name) return dir;
  }
  throw new Error('RUNTIME_PACKAGE_MISSING: ' + name);
}
function copyRuntime(name, parent, destination) {
  const source = realpathSync(packageDir(name, parent));
  const pkg = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  const server = path.join(payload, 'server');
  // Reuse the nearest installed version exactly as Node will resolve it. Hoist the
  // first version, nesting only conflicts; no junctions point back to the workspace.
  for (let at = destination; at.startsWith(server); at = path.dirname(at)) {
    const existing = path.join(at, 'node_modules', name, 'package.json');
    if (existsSync(existing)) {
      if (JSON.parse(readFileSync(existing, 'utf8')).version === pkg.version) return;
      break;
    }
    if (at === server) break;
  }
  const hoisted = path.join(server, 'node_modules', name);
  const dest = existsSync(hoisted) ? path.join(destination, 'node_modules', name) : hoisted;
  if (existsSync(dest)) throw new Error('RUNTIME_VERSION_CONFLICT: ' + name);
  dependencyDirs.add(source);
  cpSync(source, dest, {
    recursive: true,
    dereference: true,
    filter(file) {
      const relative = path.relative(source, file);
      if (/^tsconfig(?:\.[\w-]+)?\.json$/.test(path.basename(file))) return false;
      return !relative
        .split(path.sep)
        .some((p) =>
          /^(node_modules|test|tests|__tests__|examples|benchmark|benchmarks|coverage|\.git)$/.test(
            p,
          ),
        );
    },
  });
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyRuntime(dep, source, dest);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
    let dir;
    try {
      dir = packageDir(dep, source);
    } catch {
      continue;
    }
    const optional = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (optional.os && !optional.os.includes(process.platform)) continue;
    if (optional.cpu && !optional.cpu.includes(process.arch)) continue;
    copyRuntime(dep, source, dest);
  }
}
for (const name of ['exceljs', 'sharp'])
  copyRuntime(name, path.join(root, 'packages/db'), path.join(payload, 'server'));
const uiRequire = createRequire(path.join(root, 'packages/ui/package.json'));
const visited = new Set();
function collectUiNotices(dir) {
  dir = realpathSync(dir);
  if (visited.has(dir)) return;
  visited.add(dir);
  dependencyDirs.add(dir);
  const packageFile = path.join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8')),
    localRequire = createRequire(packageFile);
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    let packagePath;
    try {
      packagePath = localRequire.resolve(name + '/package.json');
    } catch {
      let candidate = path.dirname(localRequire.resolve(name));
      while (
        !existsSync(path.join(candidate, 'package.json')) ||
        JSON.parse(readFileSync(path.join(candidate, 'package.json'), 'utf8')).name !== name
      ) {
        const parent = path.dirname(candidate);
        if (parent === candidate) throw new Error('DEPENDENCY_NOTICE_NOT_FOUND: ' + name);
        candidate = parent;
      }
      packagePath = path.join(candidate, 'package.json');
    }
    collectUiNotices(path.dirname(packagePath));
  }
}
for (const name of ['antd', '@ant-design/icons'])
  collectUiNotices(path.dirname(uiRequire.resolve(name + '/package.json')));
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
collectUiNotices(path.dirname(webRequire.resolve('react-router/package.json')));
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
// Reuse the runtime prepared by bootstrap; packaging must not redownload Electron.
const electronDist = path.join(root, 'apps/desktop/node_modules/electron/dist');
const electronVersion = JSON.parse(
  readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'),
).devDependencies.electron;
if (
  !existsSync(path.join(electronDist, 'electron.exe')) ||
  readFileSync(path.join(electronDist, 'version'), 'utf8').trim() !== electronVersion
)
  throw new Error('Run tools/bootstrap.ps1 -Packaging to prepare the locked Electron runtime.');
run([
  'exec',
  'electron-builder',
  '--projectDir',
  'apps/desktop',
  '--win',
  '--x64',
  '--dir',
  '--config.electronDist=' + electronDist,
]);
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
    'Generate isolated internal test keys with provider/test-license.mjs keygen .local/provider',
  );
const keys = JSON.parse(readFileSync(trust, 'utf8'));
for (const value of Object.values(keys))
  if (typeof value !== 'string' || !value.startsWith('-----BEGIN PUBLIC KEY-----'))
    throw new Error('Invalid public trust');
writeFileSync(path.join(payload, 'public-keys.json'), JSON.stringify(keys, null, 2));
writeFileSync(
  path.join(payload, 'INTERNAL-TEST.txt'),
  'Internal unsigned M2 exam-publication package. No production signing key. Updated package Windows service installation and restart regression pending. Public test key only; no signing tool included.\n',
);
if (existsSync(path.join(root, 'docs/phase1-acceptance.md')))
  copyFileSync(path.join(root, 'docs/phase1-acceptance.md'), path.join(payload, 'ACCEPTANCE.md'));
copyFileSync(path.join(root, 'docs/m1-acceptance.md'), path.join(payload, 'M1-ACCEPTANCE.md'));
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
  if (/provider-test|test-license|private\.pem|\.mlic$|\.env$/.test(name))
    denied.push('app.asar:' + name);
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
    /provider-test|test-license|private\.pem|\.mlic$|\.env$|config\.json$/.test(name) &&
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
