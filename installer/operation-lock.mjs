import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ordinary } from './release.mjs';
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
export async function lockInstallation(data) {
  const file = path.join(data, 'install-repair.lock');
  if (existsSync(file)) {
    await ordinary(file);
    const previous = await json(file);
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1)
      throw new Error('REPAIR_LOCK_INVALID');
    let active = true;
    try {
      process.kill(previous.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') active = false;
    }
    if (active) throw new Error('REPAIR_ALREADY_RUNNING');
    await rename(file, file + '.abandoned-' + randomUUID());
  }
  const handle = await open(file, 'wx');
  await handle.writeFile(JSON.stringify({ pid: process.pid }));
  return async () => {
    await handle.close();
    await unlink(file);
  };
}
