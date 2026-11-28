import { lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  DiagnosticFileState,
  DiagnosticProbe,
  DiagnosticReport,
  DiagnosticResult,
} from '@metaexam/contracts';

type Fetch = (url: string, options: RequestInit) => Promise<Response>;
const version = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,6}(\.\d{1,6})?$/.test(v) ? v : null;
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
function member<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return options.includes(v as T) ? (v as T) : fallback;
}
async function marker(file: string): Promise<DiagnosticFileState> {
  try {
    let current = path.resolve(file);
    const ancestors = [current];
    while (true) {
      const parent = path.dirname(current);
      if (current === parent) break;
      ancestors.push(parent);
      current = parent;
    }
    for (const item of ancestors.reverse())
      if ((await lstat(item)).isSymbolicLink()) return 'unknown';
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
  }
}
async function probe(
  fetcher: Fetch,
  url: string,
): Promise<{ result: DiagnosticProbe; body: Record<string, unknown> }> {
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    response = await fetcher(url, {
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { result: { state: 'http_error', httpStatus: response.status }, body: {} };
    }
    const reader = response.body?.getReader();
    if (!reader)
      return { result: { state: 'invalid_response', httpStatus: response.status }, body: {} };
    let text = '',
      bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 16384) throw new Error('TOO_LARGE');
        text += decoder.decode(part.value, { stream: true });
      }
      const value: unknown = JSON.parse(text + decoder.decode());
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('INVALID_RESPONSE');
      return { result: { state: 'ok', httpStatus: response.status }, body: record(value) };
    } catch {
      return { result: { state: 'invalid_response', httpStatus: response.status }, body: {} };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch {
    return { result: { state: 'unreachable', httpStatus: null }, body: {} };
  } finally {
    clearTimeout(timer);
  }
}
export async function collectDiagnostics(input: {
  endpoint: () => string;
  home: string | undefined;
  fetcher: Fetch;
  managerVersion: string;
  runtime: { platform: string; arch: string; node?: string; electron?: string; chrome?: string };
}): Promise<DiagnosticReport> {
  let endpoint: string | undefined;
  try {
    const url = new URL(input.endpoint());
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('INVALID_ENDPOINT');
    endpoint = url.origin;
  } catch {
    /* partial offline report remains available */
  }
  const missing: { result: DiagnosticProbe; body: Record<string, unknown> } = {
    result: { state: 'unreachable', httpStatus: null } as DiagnosticProbe,
    body: {},
  };
  const [live, ready, system, upgrade, operation] = await Promise.all([
    endpoint ? probe(input.fetcher, endpoint + '/health/live') : missing,
    endpoint ? probe(input.fetcher, endpoint + '/health/ready') : missing,
    endpoint ? probe(input.fetcher, endpoint + '/api/v1/system/status') : missing,
    input.home ? marker(path.join(input.home, '../upgrade-pending.json')) : ('unknown' as const),
    input.home ? marker(path.join(input.home, 'maintenance.json')) : ('unknown' as const),
  ]);
  if (live.result.state === 'ok' && (live.body.status !== 'alive' || !version(live.body.version)))
    live.result.state = 'invalid_response';
  if (
    ready.result.state === 'ok' &&
    (ready.body.status !== 'ready' ||
      !Number.isSafeInteger(ready.body.schemaVersion) ||
      Number(ready.body.schemaVersion) < 1 ||
      Number(ready.body.schemaVersion) >= 10000)
  )
    ready.result.state = 'invalid_response';
  if (
    system.result.state === 'ok' &&
    (system.body.product !== 'MetaExam' || !version(system.body.version))
  )
    system.result.state = 'invalid_response';
  const data: Record<string, unknown> = system.result.state === 'ok' ? system.body : {};
  const connected = data.database === 'ready';
  return {
    format: 1,
    product: 'MetaExam',
    createdAt: new Date().toISOString(),
    managerVersion: version(input.managerVersion),
    runtime: {
      platform: member(input.runtime.platform, ['win32', 'linux', 'darwin', 'unknown'], 'unknown'),
      arch: member(input.runtime.arch, ['x64', 'arm64', 'ia32', 'unknown'], 'unknown'),
      node: version(input.runtime.node),
      electron: version(input.runtime.electron),
      chrome: version(input.runtime.chrome),
    },
    checks: { live: live.result, ready: ready.result, system: system.result },
    system: {
      version: version(data.version),
      database: member(data.database, ['ready', 'unavailable', 'unknown'], 'unknown'),
      worker: connected
        ? member(data.worker, ['online', 'offline', 'unknown'], 'unknown')
        : 'unknown',
      adminInitialized:
        connected && typeof data.adminInitialized === 'boolean' ? data.adminInitialized : null,
      schemaVersion:
        Number.isSafeInteger(data.schemaVersion) &&
        Number(data.schemaVersion) > 0 &&
        Number(data.schemaVersion) < 10000
          ? Number(data.schemaVersion)
          : null,
      license: connected
        ? member(
            record(data.license).state,
            [
              'unactivated',
              'valid',
              'expired',
              'not_yet_valid',
              'invalid',
              'clock_anomaly',
              'unknown',
            ],
            'unknown',
          )
        : 'unknown',
    },
    maintenance: { upgrade, operation },
  };
}

export async function saveDiagnostics(file: string, report: DiagnosticReport, forbidden: string[]) {
  const destination = path.resolve(file);
  if (
    !path.isAbsolute(file) ||
    destination.startsWith('\\\\') ||
    path.extname(destination).toLowerCase() !== '.json'
  )
    throw new Error('UNSAFE_PATH');
  for (const root of forbidden) {
    const relative = path.relative(path.resolve(root), destination);
    if (
      !relative ||
      (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    )
      throw new Error('UNSAFE_PATH');
  }
  let parent = path.dirname(destination);
  while (true) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_PATH');
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const handle = await open(destination, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch (error) {
    await handle.close();
    await unlink(destination).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

export class DiagnosticOperations {
  private busy = false;
  constructor(
    private readonly deps: {
      collect: () => Promise<DiagnosticReport>;
      choose: () => Promise<string | undefined>;
      save: (file: string, report: DiagnosticReport) => Promise<void>;
    },
  ) {}
  private async execute(
    exporting: boolean,
  ): Promise<DiagnosticResult<DiagnosticReport> | { status: 'cancelled' }> {
    if (this.busy) return { status: 'error', code: 'BUSY' };
    this.busy = true;
    try {
      const file = exporting ? await this.deps.choose() : undefined;
      if (exporting && !file) return { status: 'cancelled' };
      const value = await this.deps.collect();
      if (file) await this.deps.save(file, value);
      return { status: 'success', value };
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      return {
        status: 'error',
        code:
          e.code === 'EEXIST'
            ? 'FILE_EXISTS'
            : e.message === 'UNSAFE_PATH'
              ? 'UNSAFE_PATH'
              : exporting
                ? 'SAVE_FAILED'
                : 'CHECK_FAILED',
      };
    } finally {
      this.busy = false;
    }
  }
  async check(): Promise<DiagnosticResult<DiagnosticReport>> {
    return (await this.execute(false)) as DiagnosticResult<DiagnosticReport>;
  }
  export() {
    return this.execute(true);
  }
}
