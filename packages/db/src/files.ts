import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { IdentityError } from './identity';
import type { Database } from './index';
export function storedFile(db: Database, kind: 'imports' | 'images', id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_FILE_ID');
  return path.join(db.config.home, 'files', kind, id + (kind === 'images' ? '.png' : '.xlsx'));
}
export async function writeStoredFile(
  db: Database,
  kind: 'imports' | 'images',
  id: string,
  bytes: Buffer,
) {
  const target = storedFile(db, kind, id);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = target + '.tmp';
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temp, target);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function readStoredFile(db: Database, kind: 'imports' | 'images', id: string) {
  try {
    return await readFile(storedFile(db, kind, id));
  } catch {
    throw new IdentityError('FILE_UNAVAILABLE', 503);
  }
}
export async function removeStoredFile(db: Database, kind: 'imports' | 'images', id: string) {
  await unlink(storedFile(db, kind, id)).catch(() => {});
}
export function processFile<T>(
  kind: 'template' | 'image' | 'workbook',
  data: Buffer = Buffer.alloc(0),
): Promise<T> {
  return new Promise((resolve, reject) => {
    const packed = path.join(__dirname, 'file-processor.cjs');
    const worker = new Worker(
      existsSync(packed) ? packed : path.join(__dirname, 'file-processor.js'),
      {
        workerData: { kind, data },
        resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 },
      },
    );
    let settled = false;
    const finish = (error: Error | null, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(
      () => finish(new IdentityError('FILE_PROCESSING_TIMEOUT', 422)),
      15000,
    );
    worker.on('message', (m: { ok: boolean; result: T; code: string }) =>
      finish(m.ok ? null : new IdentityError(m.code, 400), m.result),
    );
    worker.on('error', () => finish(new IdentityError('FILE_PROCESSING_FAILED', 422)));
    worker.on('exit', () => {
      if (!settled) finish(new IdentityError('FILE_PROCESSING_FAILED', 422));
    });
  });
}
