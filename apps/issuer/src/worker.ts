import { createInterface } from 'node:readline';
import { IssuerService } from './service';
import { z } from 'zod';

const service = new IssuerService(process.argv[2]!);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
const request = z
  .object({ id: z.number().int(), method: z.string(), args: z.array(z.unknown()).max(5) })
  .strict();
async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  const text = (n: number) => z.string().parse(args[n]);
  switch (method) {
    case 'status':
      return { initialized: service.initialized };
    case 'unlock':
      return service.unlock(text(0));
    case 'snapshot':
      return service.snapshot();
    case 'saveCustomer':
      return service.saveCustomer(args[0]);
    case 'createKey':
      return service.createKey(args[0]);
    case 'importTestKey':
      return service.importTestKey(text(0), text(1));
    case 'disableKey':
      return service.disableKey(text(0));
    case 'exportTrust':
      return service.exportTrust(text(0), text(1));
    case 'importTrust':
      return service.importTrust(text(0));
    case 'importLegacyTrust':
      return service.importLegacyTrust(text(0), text(1));
    case 'importRequest':
      return service.importRequest(text(0), text(1));
    case 'setFloor':
      return service.setFloor(
        text(0),
        z.number().parse(args[1]),
        text(2),
        z.boolean().parse(args[3]),
      );
    case 'importHistory':
      return service.importHistory(text(0));
    case 'preview':
      return service.preview(args[0]);
    case 'confirm':
      return service.confirm(text(0), text(1));
    case 'cancelPreview':
      return service.cancelPreview();
    case 'license':
      return service.license(text(0));
    case 'exported':
      service.snapshot();
      return service.store.event('license.exported', text(0));
    case 'changePassword':
      return service.changePassword(text(0));
    case 'completeReview':
      return service.completeReview(text(0));
    case 'backup':
      return service.backup(text(0));
    case 'restore':
      return service.restore(text(0), text(1));
    default:
      throw new Error('METHOD_NOT_ALLOWED');
  }
}
input.on('line', (line) => {
  if (Buffer.byteLength(line) > 190_000_000) {
    process.exit(1);
  }
  queue = queue.then(async () => {
    let id = 0;
    try {
      const msg = request.parse(JSON.parse(line));
      id = msg.id;
      const value = await dispatch(msg.method, msg.args);
      process.stdout.write(JSON.stringify({ id, ok: true, value: value ?? null }) + '\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code = /^[A-Z_]{3,64}$/.test(message) ? message : 'INVALID_OPERATION';
      process.stdout.write(JSON.stringify({ id, ok: false, code }) + '\n');
    }
  });
});
input.on('close', () => {
  void queue.finally(() => {
    service.close();
    process.exit(0);
  });
});
