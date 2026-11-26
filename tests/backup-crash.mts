import { BackupService } from '../packages/db/dist/index.js';
let raw = '';
for await (const chunk of process.stdin) raw += String(chunk);
const input = JSON.parse(raw);
const service = new BackupService(input.config, {
  bin: input.bin,
  key: Buffer.from(input.key, 'hex'),
  runtimeRole: input.config.database.user,
  secureDirectory: async () => {},
  checkpoint: (point) => {
    if (point === 'database-swapped') process.exit(77);
  },
});
await service.restore(input.folder, input.id);
throw new Error('CRASH_CHECKPOINT_NOT_REACHED');
