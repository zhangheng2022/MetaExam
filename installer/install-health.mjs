import { setTimeout } from 'node:timers/promises';

export async function waitForHealthy(
  { url, release, workerReady, servicesReady },
  { attempts = 60, pause = setTimeout, request = fetch } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const options = () => ({ redirect: 'error', signal: AbortSignal.timeout(2000) });
      const live = await request(url + '/health/live', options());
      const ready = await request(url + '/health/ready', options());
      if (
        live.ok &&
        ready.ok &&
        (await live.json()).version === release.version &&
        (await ready.json()).schemaVersion === release.schemaVersion &&
        (await workerReady()) &&
        (await servicesReady())
      )
        return;
    } catch {
      // A transient probe failure never makes an installation healthy.
    }
    if (attempt + 1 < attempts) await pause(1000);
  }
  throw new Error('INSTALL_START_FAILED');
}

export async function completeInstallation({ start, healthy, commit }) {
  const since = new Date().toISOString();
  await start();
  await healthy(since);
  await commit();
}
