import { createApp } from './app';
import { loadConfig } from '@metaexam/db';
async function main() {
  const config = loadConfig(),
    app = await createApp(config);
  await app.listen(config.api.port, config.api.host);
  console.log(JSON.stringify({ event: 'api_started', port: config.api.port }));
}
main().catch(() => {
  console.error('API_START_FAILED: check config, certificate and port availability');
  process.exitCode = 1;
});
