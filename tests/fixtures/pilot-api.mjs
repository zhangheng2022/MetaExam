import { createApp } from '../../apps/api/dist/app.js';
import { loadConfig } from '../../packages/db/dist/index.js';
const app = await createApp(loadConfig());
await app.listen(0, '127.0.0.1');
const timer = setInterval(
  () => process.send?.({ rss: process.memoryUsage().rss, cpu: process.cpuUsage() }),
  100,
).unref();
process.send?.({ port: app.getHttpServer().address().port });
process.on('message', async (message) => {
  if (message === 'stop') {
    clearInterval(timer);
    await app.close();
    process.disconnect();
  }
});
