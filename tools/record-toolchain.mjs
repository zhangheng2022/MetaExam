import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sources = [
  [
    '.tools/node-official.zip',
    'https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip',
    '24.22.3',
    'Official SHASUMS256.txt verified',
  ],
  [
    '.tools/postgres.zip',
    'https://get.enterprisedb.com/postgresql/postgresql-18.7-1-windows-x64-binaries.zip',
    '18.7-1',
    'HTTPS download; locally pinned SHA256',
  ],
  [
    '.tools/innosetup.exe',
    'https://github.com/jrsoftware/issrc/releases/download/is-6_7_4/innosetup-6.7.4.exe',
    '6.7.4',
    'Authenticode publisher verified',
  ],
  [
    '.tools/WinSW.NET462.exe',
    'https://github.com/winsw/winsw/releases/download/v2.14.0/WinSW.NET462.exe',
    '2.14.0',
    'HTTPS GitHub release; locally pinned SHA256',
  ],
  [
    '.tools/vc_redist.x64.exe',
    'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    'downloaded build pinned by SHA256',
    'Microsoft Authenticode publisher verified',
  ],
];
writeFileSync(
  'toolchain.lock.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      files: sources.map(([file, url, version, verification]) => ({
        file,
        url,
        version,
        verification,
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      })),
    },
    null,
    2,
  ) + '\n',
);
for (const file of ['apps/web/package.json', 'apps/desktop/package.json']) {
  const p = JSON.parse(readFileSync(file, 'utf8')),
    installed = JSON.parse(
      readFileSync(
        file.replace('package.json', 'node_modules/@vitejs/plugin-react/package.json'),
        'utf8',
      ),
    );
  p.devDependencies['@vitejs/plugin-react'] = installed.version;
  writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
}
