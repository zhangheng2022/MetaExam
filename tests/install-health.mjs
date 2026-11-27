import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForHealthy, completeInstallation } from '../installer/install-health.mjs';
import { restartDatabase } from '../installer/restart-database.mjs';

for (const failed of ['api', 'version', 'schema', 'worker', 'service', 'none']) {
  test(
    'installation commits only with ready API, current version/schema, fresh worker and services: ' +
      failed,
    async () => {
      let committed = false;
      const release = { version: '0.1.14', schemaVersion: 10 };
      const work = () =>
        completeInstallation({
          start: async () => {},
          healthy: () =>
            waitForHealthy(
              {
                url: 'http://127.0.0.1:3000',
                release,
                workerReady: async () => failed !== 'worker',
                servicesReady: async () => failed !== 'service',
              },
              {
                attempts: 2,
                pause: async () => {},
                request: async (url, options) => {
                  assert.equal(options.redirect, 'error');
                  return {
                    ok: failed !== 'api',
                    json: async () =>
                      url.endsWith('/live')
                        ? { version: failed === 'version' ? '0.1.13' : release.version }
                        : { schemaVersion: failed === 'schema' ? 9 : release.schemaVersion },
                  };
                },
              },
            ),
          commit: async () => {
            committed = true;
          },
        });
      if (failed === 'none') await work();
      else await assert.rejects(work(), /INSTALL_START_FAILED/);
      assert.equal(committed, failed === 'none');
    },
  );
}

for (const fail of ['stop', 'refresh', 'start', 'reconnect', 'none']) {
  test('database cutover is ordered and stops on failure: ' + fail, async () => {
    const steps = ['disconnect', 'disableRecovery', 'stop', 'refresh', 'start', 'reconnect'];
    const events = [];
    const platform = Object.fromEntries(
      steps.map((step) => [
        step,
        async () => {
          events.push(step);
          if (step === fail) throw new Error('INTERRUPTED');
        },
      ]),
    );
    if (fail === 'none') await restartDatabase(platform);
    else await assert.rejects(restartDatabase(platform), /INTERRUPTED/);
    assert.deepEqual(
      events,
      steps.slice(0, fail === 'none' ? steps.length : steps.indexOf(fail) + 1),
    );
  });
}
