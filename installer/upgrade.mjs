import path from 'node:path';
import { appendFile, readFile, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { upgrade } from './upgrade-engine.mjs';
import { windowsPlatform } from './upgrade-windows.mjs';
import { ordinary } from './release.mjs';
import { repair } from './repair-engine.mjs';
import { repairWindows } from './repair-windows.mjs';

const [action, appDir, dataDir] = process.argv.slice(2);
if (!['apply', 'resume'].includes(action) || !appDir || !dataDir)
  throw new Error('UPGRADE_ARGUMENTS');
const options = {
  app: path.resolve(appDir),
  data: path.resolve(dataDir),
  source: path.resolve(import.meta.dirname, '..'),
};
try {
  await ordinary(options.app);
  await ordinary(options.data);
  await ordinary(path.join(options.data, 'installation.json'));
  const record = JSON.parse(await readFile(path.join(options.data, 'installation.json'), 'utf8'));
  if (
    path.resolve(record.app).toLowerCase() !== options.app.toLowerCase() ||
    path.resolve(record.data).toLowerCase() !== options.data.toLowerCase()
  )
    throw new Error('UPGRADE_OWNERSHIP');
  const pendingFile = path.join(options.data, 'upgrade-pending.json');
  let pending;
  if (existsSync(pendingFile)) {
    await ordinary(pendingFile);
    pending = JSON.parse(await readFile(pendingFile, 'utf8'));
  }
  const result =
    record.phase === 'configuring' || pending?.kind === 'install-repair'
      ? await repair(options, repairWindows(options))
      : await upgrade(options, await windowsPlatform(options));
  console.log(JSON.stringify(result));
} catch (error) {
  const code =
    error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'UPGRADE_FAILED';
  console.error(code);
  // Only the already-owned, checked data directory is eligible for a local diagnostic.
  try {
    await ordinary(options.data);
    const marker = JSON.parse(await readFile(path.join(options.data, 'installation.json'), 'utf8'));
    if (
      path.resolve(marker.app).toLowerCase() === options.app.toLowerCase() &&
      path.resolve(marker.data).toLowerCase() === options.data.toLowerCase()
    ) {
      const log = path.join(options.data, 'upgrade.log');
      if (existsSync(log)) {
        await ordinary(log);
        const info = await lstat(log);
        if (!info.isFile() || info.nlink !== 1)
          throw new Error('UPGRADE_UNSAFE_PATH', { cause: error });
      }
      await appendFile(log, new Date().toISOString() + ' ' + code + '\n');
    }
  } catch {
    /* no logging through an untrusted path */
  }
  process.exitCode = 1;
}
