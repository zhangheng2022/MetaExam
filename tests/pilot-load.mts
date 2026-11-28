import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { cpus, totalmem, release } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { grantRuntimeAccess } from '../packages/db/dist/index.js';
import { attemptFixture } from './attempts-fixture.mts';

const sizes = process.env.METAEXAM_PILOT_SIZE
  ? [Number(process.env.METAEXAM_PILOT_SIZE)]
  : [30, 100, 300];
assert.ok(sizes.every((n) => [30, 100, 300].includes(n)));
async function all<T>(jobs: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(jobs);
  const failed = settled.filter((r) => r.status === 'rejected');
  if (failed.length)
    throw new AggregateError(
      failed.map((r) => r.reason),
      'Load phase failed',
    );
  return settled.map((r) => (r as PromiseFulfilledResult<T>).value);
}
const results: object[] = [];
mkdirSync('artifacts/pilot', { recursive: true });
for (const size of sizes) {
  const t = await attemptFixture();
  const role = 'metaexam_test_' + randomUUID().replaceAll('-', ''),
    password = randomUUID();
  let apiChild: ReturnType<typeof spawn> | undefined, worker: ReturnType<typeof spawn> | undefined;
  let apiPort = 0,
    apiMaxRss = 0;
  let createdRole = false;
  const samples: Record<string, number[]> = {};
  let maxRss = 0;
  const memoryTimer = setInterval(() => {
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
  }, 100).unref();
  const cpuStart = process.cpuUsage();
  try {
    const ids = Array.from({ length: size }, () => randomUUID());
    const names = ids.map((_, i) => 'load' + i);
    await t.db.pool.query(
      'INSERT INTO users(id,username,display_name) SELECT * FROM unnest($1::uuid[],$2::text[],$2::text[])',
      [ids, names],
    );
    await t.db.pool.query(
      'INSERT INTO user_credentials(user_id,password_hash) SELECT x.id,c.password_hash FROM unnest($1::uuid[]) x(id) CROSS JOIN user_credentials c WHERE c.user_id=$2',
      [ids, t.people.student!.id],
    );
    await t.db.pool.query(
      "INSERT INTO user_roles SELECT id,'student' FROM unnest($1::uuid[]) x(id)",
      [ids],
    );
    await t.db.pool.query('INSERT INTO class_members SELECT $1,id FROM unnest($2::uuid[]) x(id)', [
      t.classId,
      ids,
    ]);
    await t.activate({ maxConcurrentAttempts: size });
    const exam = await t.create('/exams', { ...t.input, name: size + ' 人负载验证' });
    const pub = await t.request(
      '/exams/' + exam + '/publish',
      'POST',
      { revision: 1 },
      t.people.admin!.cookie,
    );
    assert.equal(pub.statusCode, 200, pub.body);
    const clockClient = await t.db.pool.connect();
    try {
      await clockClient.query('BEGIN');
      await clockClient.query('ALTER TABLE exams DISABLE TRIGGER exams_guard');
      await clockClient.query(
        "UPDATE exams SET starts_at=clock_timestamp()-interval '1 minute',ends_at=clock_timestamp()+interval '2 hours' WHERE id=$1",
        [exam],
      );
      await clockClient.query('ALTER TABLE exams ENABLE TRIGGER exams_guard');
      await clockClient.query('COMMIT');
    } catch (error) {
      await clockClient.query('ROLLBACK');
      throw error;
    } finally {
      clockClient.release();
    }
    await t.db.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    createdRole = true;
    await grantRuntimeAccess(t.db.pool, role, t.config.database.database);
    const config = {
      ...t.config,
      database: { ...t.config.database, user: role, password },
      auth: { accountLimit: 100, ipLimit: 1000 },
    };
    const apiFile = path.join(t.config.home, 'pilot-api.json');
    writeFileSync(apiFile, JSON.stringify(config));
    const startApi = () =>
      new Promise<void>((resolve, reject) => {
        apiChild = spawn(process.execPath, ['tests/fixtures/pilot-api.mjs'], {
          env: { ...process.env, METAEXAM_CONFIG: apiFile },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
        });
        const timeout = setTimeout(() => reject(new Error('API startup timeout')), 30000);
        apiChild.once('error', (e) => {
          clearTimeout(timeout);
          reject(e);
        });
        apiChild.once('exit', (code) => {
          clearTimeout(timeout);
          if (!apiPort) reject(new Error('API startup exit ' + code));
        });
        apiChild.on('message', (message: { port?: number; rss?: number }) => {
          if (message.rss) apiMaxRss = Math.max(apiMaxRss, message.rss);
          if (message.port) {
            apiPort = message.port;
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    await startApi();
    const request = async (
      phase: string,
      url: string,
      method: string,
      body?: object,
      cookie?: string,
    ) => {
      const started = performance.now();
      const response = await fetch('http://127.0.0.1:' + apiPort + '/api/v1' + url, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      }).catch((error: Error) => {
        throw new Error(phase + ': ' + error.message, { cause: error });
      });
      const data = await response.json();
      (samples[phase] ??= []).push(performance.now() - started);
      assert.equal(response.status, 200, JSON.stringify(data));
      return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const cookies: string[] = [];
    // Bounded login clients respect the configured password hashing queue.
    let cursor = 0;
    console.log('START', size, 'login');
    await all(
      Array.from({ length: 8 }, async () => {
        while (cursor < size) {
          const i = cursor++;
          cookies[i] = (
            await request('login', '/auth/login', 'POST', {
              username: names[i],
              password: t.password,
            })
          ).cookie!;
        }
      }),
    );
    console.log('START', size, 'admission');
    const attempts = await all(
      cookies.map(
        async (cookie) =>
          (await request('admission', '/my-exams/' + exam + '/start', 'POST', {}, cookie)).data
            .id as string,
      ),
    );
    assert.equal(new Set(attempts).size, size);
    for (let round = 0; round < 10; round++) {
      console.log('START', size, 'save', round);
      await all(
        attempts.map((id, i) =>
          request(
            'save',
            '/attempts/' + id + '/questions/1',
            'PUT',
            {
              revision: round,
              mutationId: randomUUID(),
              answer: { type: 'boolean', value: true },
            },
            cookies[i],
          ),
        ),
      );
      if (round === 4) {
        const start = performance.now();
        execFileSync('taskkill.exe', ['/PID', String(apiChild!.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        apiPort = 0;
        await startApi();
        (samples.apiRestart ??= []).push(performance.now() - start);
        const stored = await request(
          'recoveryRead',
          '/attempts/' + attempts[0] + '/questions/1',
          'GET',
          undefined,
          cookies[0],
        );
        assert.equal(stored.data.revision, 5);
      }
      if (size === 30 && round === 6) {
        // Only this fixture's temporary runtime role is interrupted. The shared PostgreSQL
        // process and every other database/user remain available.
        await t.db.pool.query('ALTER ROLE ' + role + ' NOLOGIN');
        try {
          await t.db.pool.query(
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND usename=$2',
            [t.config.database.database, role],
          );
          const failed = await fetch(
            'http://127.0.0.1:' + apiPort + '/api/v1/attempts/' + attempts[0],
            { headers: { cookie: cookies[0]! }, signal: AbortSignal.timeout(15000) },
          );
          assert.equal(failed.status, 503);
          await failed.arrayBuffer();
        } finally {
          await t.db.pool.query('ALTER ROLE ' + role + ' LOGIN');
        }
        const restored = await request(
          'databaseRecoveryRead',
          '/attempts/' + attempts[0] + '/questions/1',
          'GET',
          undefined,
          cookies[0],
        );
        assert.equal(restored.data.revision, 7);
      }
      await delay(1000);
    }
    console.log('START', size, 'submit');
    await all(
      attempts.map((id, i) =>
        request('submit', '/attempts/' + id + '/submit', 'POST', { revision: 10 }, cookies[i]),
      ),
    );
    const workerFile = path.join(t.config.home, 'pilot-worker.json');
    writeFileSync(workerFile, JSON.stringify(config));
    const spawnWorker = () =>
      spawn(process.execPath, ['apps/worker/dist/main.js'], {
        env: { ...process.env, METAEXAM_CONFIG: workerFile },
        stdio: 'ignore',
        windowsHide: true,
      });
    worker = spawnWorker();
    await delay(400);
    if (worker.pid && worker.exitCode === null)
      execFileSync('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    worker = spawnWorker();
    const gradingStart = performance.now();
    let count = 0;
    for (let i = 0; i < 600; i++) {
      count = Number(
        (
          await t.db.pool.query(
            'SELECT count(*) FROM attempt_scores s JOIN exam_attempts a ON a.id=s.attempt_id WHERE a.exam_id=$1',
            [exam],
          )
        ).rows[0].count,
      );
      if (count === size * 5) break;
      await delay(100);
    }
    assert.equal(count, size * 5);
    assert.equal(
      (
        await t.db.pool.query(
          "SELECT count(*) FROM exam_attempts WHERE exam_id=$1 AND status<>'submitted'",
          [exam],
        )
      ).rows[0].count,
      '0',
    );
    assert.equal(
      (
        await t.db.pool.query(
          'SELECT count(*) FROM attempt_answers WHERE attempt_id=ANY($1::uuid[]) AND revision=10',
          [attempts],
        )
      ).rows[0].count,
      String(size),
    );
    assert.equal(
      (
        await t.db.pool.query(
          "SELECT count(*) FROM audit_events WHERE event='grading.automatic' AND target_id=ANY($1::text[])",
          [attempts],
        )
      ).rows[0].count,
      String(size),
    );
    const metrics = Object.fromEntries(
      Object.entries(samples).map(([key, values]) => {
        values.sort((a, b) => a - b);
        return [
          key,
          {
            count: values.length,
            p50Ms: Math.round(values[Math.floor(values.length * 0.5)]!),
            p95Ms: Math.round(
              values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]!,
            ),
            maxMs: Math.round(values.at(-1)!),
          },
        ];
      }),
    );
    results.push({
      size,
      rounds: 10,
      loginConcurrency: 8,
      metrics,
      gradingRecoveryMs: Math.round(performance.now() - gradingStart),
      apiMaxRssMiB: Math.round(apiMaxRss / 1048576),
      driverMaxRssMiB: Math.round(maxRss / 1048576),
      driverCpuMicroseconds: process.cpuUsage(cpuStart),
    });
    writeFileSync(
      'artifacts/pilot/load-results.json',
      JSON.stringify(
        {
          environment: {
            system: release(),
            cpu: cpus()[0]?.model,
            logicalCpus: cpus().length,
            memoryGiB: Math.round(totalmem() / 1073741824),
            node: process.version,
          },
          limitations:
            'API, Worker and load driver run in separate processes on the development machine; loopback HTTP, 10 saving rounds, bounded login concurrency; no LAN HTTPS, full-duration exam or Windows-service capacity claim.',
          results,
        },
        null,
        2,
      ),
    );
    console.log('PASS pilot load', size, JSON.stringify(metrics));
  } finally {
    clearInterval(memoryTimer);
    if (worker?.pid && worker.exitCode === null)
      execFileSync('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    if (apiChild?.pid && apiChild.exitCode === null)
      execFileSync('taskkill.exe', ['/PID', String(apiChild.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    if (createdRole) {
      await t.db.pool.query('DROP OWNED BY ' + role);
      await t.db.pool.query('DROP ROLE ' + role);
    }
    await t.close();
  }
}
