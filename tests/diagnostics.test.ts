import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectDiagnostics,
  DiagnosticOperations,
  saveDiagnostics,
} from '../apps/desktop/src/diagnostics';

const secret = 'NEVER_EXPORT_PASSWORD_COOKIE_TOKEN_QUESTION';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'MetaExam-diagnostic-test-'));
  const home = path.join(root, 'data/runtime');
  await mkdir(home, { recursive: true });
  const input = {
    home,
    endpoint: () => 'http://127.0.0.1:3000',
    managerVersion: '0.1.1',
    runtime: {
      platform: 'win32',
      arch: 'x64',
      node: '24.22.3',
      electron: '45.5.0',
      chrome: '140.0.1234.56',
    },
    fetcher: async (url: string, options: RequestInit) => {
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal);
      assert.equal(options.headers, undefined);
      const body = url.endsWith('/live')
        ? { status: 'alive', version: '0.1.1' }
        : url.endsWith('/ready')
          ? { status: 'ready', schemaVersion: 10 }
          : {
              product: 'MetaExam',
              version: '0.1.1',
              database: 'ready',
              worker: 'online',
              adminInitialized: true,
              schemaVersion: 10,
              license: { state: 'valid', raw: secret, customerId: secret },
              password: secret,
              cookie: secret,
              path: secret,
            };
      return Response.json(body);
    },
  };
  return {
    root,
    input,
    close: async () => {
      if (
        path.dirname(root) !== path.resolve(tmpdir()) ||
        !path.basename(root).startsWith('MetaExam-diagnostic-test-')
      )
        throw new Error('Unsafe cleanup');
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('diagnostic report uses explicit safe fields and does not infer unknown states', async () => {
  const t = await fixture();
  try {
    await writeFile(path.join(t.input.home, 'maintenance.json'), secret);
    await writeFile(path.join(t.input.home, '../upgrade-pending.json'), secret);
    const report = await collectDiagnostics(t.input);
    assert.equal(report.checks.live.state, 'ok');
    assert.equal(report.checks.ready.state, 'ok');
    assert.equal(report.system.license, 'valid');
    assert.equal(report.system.adminInitialized, true);
    assert.equal(report.maintenance.operation, 'present');
    assert.equal(report.maintenance.upgrade, 'present');
    assert.equal(report.runtime.chrome, '140.0.1234.56');
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.ok(!JSON.stringify(report).includes(t.root));
    const offline = await collectDiagnostics({
      ...t.input,
      fetcher: async () => {
        throw new Error(secret);
      },
    });
    assert.equal(offline.system.license, 'unknown');
    assert.equal(offline.system.adminInitialized, null);
    assert.equal(offline.checks.live.state, 'unreachable');
    const unknownHome = await collectDiagnostics({ ...t.input, home: undefined });
    assert.deepEqual(unknownHome.maintenance, { upgrade: 'unknown', operation: 'unknown' });
    const unavailable = await collectDiagnostics({
      ...t.input,
      fetcher: async () =>
        Response.json({
          product: 'MetaExam',
          version: '0.1.1',
          database: 'unavailable',
          worker: 'offline',
          adminInitialized: false,
          license: { state: 'invalid' },
        }),
    });
    assert.equal(unavailable.system.license, 'unknown');
    assert.equal(unavailable.system.worker, 'unknown');
    assert.equal(unavailable.system.adminInitialized, null);
  } finally {
    await t.close();
  }
});

test('diagnostics rejects remote destinations, malformed and oversized responses and cancels a hanging response', async () => {
  const t = await fixture();
  try {
    for (const endpoint of [
      'https://example.com',
      'https://127.0.0.1:3000',
      'http://127.0.0.1:3000@evil.example',
      'http://127.0.0.1:3000/path',
      'file:///etc/hosts',
    ]) {
      const report = await collectDiagnostics({
        ...t.input,
        endpoint: () => endpoint,
        fetcher: async () => {
          assert.fail('remote request');
        },
      });
      assert.equal(report.checks.system.state, 'unreachable');
    }
    for (const body of [
      'not-json',
      '[]',
      'null',
      JSON.stringify({ unknown: secret }),
      JSON.stringify({ tooLarge: 'x'.repeat(20000) }),
    ]) {
      const report = await collectDiagnostics({
        ...t.input,
        fetcher: async () => new Response(body),
      });
      assert.equal(report.checks.system.state, 'invalid_response');
      assert.equal(report.system.license, 'unknown');
      assert.ok(!JSON.stringify(report).includes(secret));
    }
    const denied = await collectDiagnostics({
      ...t.input,
      fetcher: async () => new Response(secret, { status: 503 }),
    });
    assert.equal(denied.checks.system.httpStatus, 503);
    assert.ok(!JSON.stringify(denied).includes(secret));
    const since = Date.now();
    const timed = await collectDiagnostics({
      ...t.input,
      fetcher: (_url, opts) =>
        new Promise((_resolve, reject) =>
          opts.signal!.addEventListener('abort', () => reject(new Error(secret))),
        ),
    });
    assert.equal(timed.checks.live.state, 'unreachable');
    assert.ok(Date.now() - since < 8000);
  } finally {
    await t.close();
  }
});

test('diagnostics export is exclusive, cannot overwrite files or write through protected/linked paths', async () => {
  const t = await fixture();
  try {
    const report = await collectDiagnostics(t.input);
    const file = path.join(t.root, 'report.json');
    await saveDiagnostics(file, report, [path.join(t.root, 'data')]);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), report);
    await assert.rejects(saveDiagnostics(file, report, []), { code: 'EEXIST' });
    await assert.rejects(
      saveDiagnostics(path.join(t.input.home, 'config.json'), report, [path.join(t.root, 'data')]),
      /UNSAFE_PATH/,
    );
    await assert.rejects(
      saveDiagnostics(path.join(t.root, 'report.exe'), report, []),
      /UNSAFE_PATH/,
    );
    await symlink(t.input.home, path.join(t.root, 'linked'), 'junction');
    await assert.rejects(
      saveDiagnostics(path.join(t.root, 'linked/report.json'), report, []),
      /UNSAFE_PATH/,
    );
    const unknown = await collectDiagnostics({ ...t.input, home: path.join(t.root, 'linked') });
    // A linked ancestor is unknown even when the leaf marker does not exist.
    await writeFile(path.join(t.input.home, 'maintenance.json'), secret);
    assert.equal(
      (await collectDiagnostics({ ...t.input, home: path.join(t.root, 'linked') })).maintenance
        .operation,
      'unknown',
    );
    assert.equal(unknown.maintenance.operation, 'unknown');
    let release!: (value: typeof report) => void;
    const ops = new DiagnosticOperations({
      collect: () =>
        new Promise((r) => {
          release = r;
        }),
      choose: async () => file,
      save: async () => {
        throw new Error(secret);
      },
    });
    const check = ops.check();
    assert.deepEqual(await ops.export(), { status: 'error', code: 'BUSY' });
    release(report);
    assert.equal((await check).status, 'success');
    const cancelled = new DiagnosticOperations({
      collect: async () => {
        assert.fail('cancel must not collect');
      },
      choose: async () => undefined,
      save: async () => {
        assert.fail('cancel must not save');
      },
    });
    assert.deepEqual(await cancelled.export(), { status: 'cancelled' });
    const failure = new DiagnosticOperations({
      collect: async () => report,
      choose: async () => file,
      save: async () => {
        throw new Error(secret);
      },
    });
    assert.deepEqual(await failure.export(), { status: 'error', code: 'SAVE_FAILED' });
  } finally {
    await t.close();
  }
});
