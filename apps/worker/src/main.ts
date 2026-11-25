import {
  createDatabase,
  processOne,
  readiness,
  finishExpiredAttempts,
  gradeNextAttempt,
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
