import {
  createDatabase,
  processOne,
  readiness,
  finishExpiredAttempts,
  gradeNextAttempt,
  upgradePending,
} from '@metaexam/db';
import { setTimeout } from 'node:timers/promises';
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stopping = true;
  });
async function main() {
  const db = createDatabase();
  try {
    if (!(await readiness(db))) throw new Error('DATABASE_NOT_READY');
    console.log(JSON.stringify({ event: 'worker_started' }));
    let lastExpiration = 0;
    while (!stopping) {
      try {
        if (upgradePending(db.config.home)) {
          await db.pool.query(
            'INSERT INTO worker_heartbeat(id,seen_at) VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET seen_at=now()',
          );
          await setTimeout(500);
          continue;
        }
        if (Date.now() - lastExpiration >= 1000) {
          await finishExpiredAttempts(db);
          lastExpiration = Date.now();
        }
        const graded = await gradeNextAttempt(db);
        if (!(await processOne(db)) && !graded) await setTimeout(500);
      } catch {
        console.error(JSON.stringify({ event: 'worker_retry' }));
        await setTimeout(2000);
      }
    }
  } finally {
    await db.pool.end();
  }
}
main().catch(() => {
  console.error('WORKER_START_FAILED');
  process.exitCode = 1;
});
