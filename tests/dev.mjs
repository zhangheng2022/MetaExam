// Exclusive development-workflow regression check. Temporary edits are restored
// only when the file still contains this test's own last write.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { isolatedDatabase } from './database-fixture.mts';
import { createRequire } from 'node:module';
const { migrate } = createRequire(import.meta.url)('../packages/db/dist/index.js');
const root = path.resolve(import.meta.dirname, '..'),
  url = 'http://127.0.0.1:3310',
  web = 'http://127.0.0.1:5180';
const pnpm = path.join(root, '.tools/pnpm/node_modules/pnpm/bin/pnpm.cjs');
const fixture = await isolatedDatabase();
const { config } = fixture;
const conf = path.join(root, '.local/dev-check-config.json');
writeFileSync(conf, JSON.stringify({ ...config, api: { ...config.api, port: 3310 } }));
const saved = new Map(),
  written = new Map(),
  results = [];
let child,
  browser,
  logs = '';
function change(file, before, after) {
  const full = path.join(root, file),
    current = readFileSync(full, 'utf8');
  if (written.has(full))
    assert.equal(current, written.get(full), 'source changed outside this test');
  if (!saved.has(full)) saved.set(full, current);
  assert.ok(current.includes(before), 'probe target exists in ' + file);
  const next = current.replace(before, after);
  writeFileSync(full, next);
  written.set(full, next);
}
async function until(check, reason, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {
      /* service restarting */
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error('Dev exited: ' + logs.slice(-6000));
    await delay(200);
  }
  throw new Error('TIMEOUT: ' + reason + '\n' + logs.slice(-6000));
}
const pass = (label) => {
  results.push(label);
  console.log('PASS ' + label);
};
try {
  await migrate(fixture.db);
  child = spawn(process.execPath, [pnpm, 'dev'], {
    cwd: root,
    env: {
      ...process.env,
      METAEXAM_CONFIG: conf,
      METAEXAM_WEB_PORT: '5180',
      METAEXAM_DESKTOP_SMOKE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (buffer) => {
    logs += buffer;
  });
  child.stderr.on('data', (buffer) => {
    logs += buffer;
  });
  child.on('error', (error) => {
    logs += error.message;
  });
  await until(async () => (await fetch(url + '/health/ready')).ok, 'initial backend build');
  await until(async () => (await fetch(web + '/api/v1/system/status')).ok, 'Vite proxy');
  pass('one dev command starts backend watch, API, Worker and Vite');
  await until(
    async () => logs.includes('DESKTOP_STATUS_READY'),
    'Electron launches and reads status through IPC',
  );
  await until(
    async () => logs.includes('node tools/dev.mjs --desktop exited with code 0'),
    'Electron closes normally',
  );
  assert.equal((await fetch(url + '/health/ready')).status, 200);
  assert.equal((await fetch(web)).status, 200);
  await until(
    async () => (await (await fetch(url + '/api/v1/system/status')).json()).worker === 'online',
    'Worker stays online after closing Electron',
  );
  pass('dev automatically opens Electron with working IPC and default blue theme');
  pass('closing Electron leaves API, Worker and Vite running');
  if (!process.argv.includes('--startup-only')) {
    change(
      'apps/api/src/system/system.module.ts',
      "return { status: 'alive', version: APP_VERSION };",
      "return { status: 'alive', version: APP_VERSION, devProbe: 'reload-ok' };",
    );
    await until(
      async () => (await (await fetch(url + '/health/live')).json()).devProbe === 'reload-ok',
      'API reload',
    );
    pass('API source change automatically compiles and restarts');
    const workerMarker = 'worker_dev_' + randomUUID().replaceAll('-', '');
    change('apps/worker/src/main.ts', "event: 'worker_started'", "event: '" + workerMarker + "'");
    await until(async () => logs.includes('"event":"' + workerMarker + '"'), 'Worker reload');
    pass('Worker source change automatically compiles and restarts');
    change('packages/db/src/index.ts', "APP_VERSION = '0.1.0'", "APP_VERSION = '0.1.1'");
    await until(
      async () => (await (await fetch(url + '/health/live')).json()).version === '0.1.1',
      'shared database package propagation',
    );
    pass('shared backend implementation rebuilds dependent services');
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + config.api.managementToken,
    };
    const businessKey = 'dev-' + randomUUID();
    const submit = () =>
      fetch(url + '/api/v1/diagnostics/jobs', {
        method: 'POST',
        headers,
        body: JSON.stringify({ businessKey, message: 'x'.repeat(501) }),
      });
    assert.equal((await submit()).status, 400);
    change(
      'packages/contracts/src/index.ts',
      'message: z.string().min(1).max(500)',
      'message: z.string().min(1).max(501)',
    );
    await until(async () => (await submit()).status === 202, 'shared contract propagation');
    const job = await (await submit()).json();
    await until(
      async () =>
        (await (await fetch(url + '/api/v1/diagnostics/jobs/' + job.id, { headers })).json())
          .status === 'completed',
      'worker after contract rebuild',
    );
    pass('shared contract changes reach API validation and Worker task execution');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    await page.goto(web + '/status');
    await page.getByRole('heading', { name: '运行概览', exact: true }).waitFor();
    const marker = randomUUID();
    await page.evaluate((value) => {
      window.__hmrProbe = value;
    }, marker);
    change(
      'packages/ui/src/index.tsx',
      '<Title level={1}>运行概览</Title>',
      '<Title level={1}>运行概览（热更新验证）</Title>',
    );
    await page
      .getByRole('heading', { name: '运行概览（热更新验证）', exact: true })
      .waitFor({ timeout: 30000 });
    assert.equal(await page.evaluate(() => window.__hmrProbe), marker);
    pass('shared React UI uses Vite HMR without full page reload');
    const apiFile = 'apps/api/src/system/system.module.ts';
    change(
      apiFile,
      "devProbe: 'reload-ok'",
      "devProbe: 'reload-ok', invalidProbe: (true as never).invalid",
    );
    await until(async () => logs.includes('TS2339'), 'TypeScript error reported');
    const apiPath = path.join(root, apiFile);
    writeFileSync(apiPath, saved.get(apiPath));
    written.set(apiPath, saved.get(apiPath));
    await until(
      async () =>
        (await fetch(url + '/health/ready')).ok &&
        (await (await fetch(url + '/health/live')).json()).devProbe === undefined,
      'automatic recovery',
    );
    pass('compilation errors are visible and corrected source restarts automatically');
  }
  mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(
      root,
      process.argv.includes('--startup-only')
        ? 'artifacts/dev-startup-results.json'
        : 'artifacts/dev-watch-results.json',
    ),
    JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
  );
} finally {
  await browser?.close();
  if (child?.pid && child.exitCode === null)
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      /* exited */
    }
  let conflicted = false;
  for (const [file, original] of saved) {
    if (readFileSync(file, 'utf8') !== written.get(file)) {
      console.error('Concurrent edit retained; restore probe manually: ' + file);
      process.exitCode = 1;
      conflicted = true;
      continue;
    }
    writeFileSync(file, original);
  }
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, '.local/dev-check.log'), logs);
  await fixture.close();
  // Restore generated output as well as source after the probes.
  if (!conflicted)
    execFileSync(process.execPath, [pnpm, 'build'], {
      cwd: root,
      stdio: 'pipe',
      windowsHide: true,
    });
}
