import { readFileSync, writeFileSync } from 'node:fs';
import {
  createDatabase,
  migrate,
  ensureInstance,
  licenseRequest,
  checkLicenseFile,
  importLicense,
  licenseStatus,
  loadConfig,
  issueBootstrapFile,
} from '@metaexam/db';
import { LicenseError } from '@metaexam/domain';
async function main() {
  const [command, file] = process.argv.slice(2);
  if (command === 'stop-api') {
    const c = loadConfig(),
      protocol = c.api.tlsCert ? 'https' : 'http';
    const response = await fetch(
      protocol + '://127.0.0.1:' + c.api.port + '/api/v1/maintenance/stop',
      { method: 'POST', headers: { authorization: 'Bearer ' + c.api.managementToken } },
    );
    if (!response.ok) throw new Error('STOP_FAILED');
    return;
  }
  const db = createDatabase();
  try {
    switch (command) {
      case 'setup-token':
        await issueBootstrapFile(db);
        console.log('SETUP_TOKEN_READY');
        break;
      case 'migrate':
        await migrate(db);
        await ensureInstance(db);
        console.log('SCHEMA_READY');
        break;
      case 'license-request': {
        if (!file) throw new Error('OUTPUT_PATH_REQUIRED');
        const request = await licenseRequest(db);
        writeFileSync(file, JSON.stringify(request, null, 2), { flag: 'wx' });
        console.log('REQUEST_EXPORTED');
        break;
      }
      case 'license-verify':
      case 'license-import': {
        if (!file) throw new Error('FILE_REQUIRED');
        const raw = readFileSync(file, 'utf8');
        const v =
          command === 'license-import'
            ? await importLicense(db, raw)
            : await checkLicenseFile(db, raw);
        console.log(JSON.stringify({ status: 'valid', sequence: v.payload.sequence }));
        break;
      }
      case 'license-status':
        console.log(JSON.stringify(await licenseStatus(db)));
        break;
      default:
        throw new Error('UNKNOWN_COMMAND');
    }
  } finally {
    await db.pool.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof LicenseError
      ? error.code
      : error instanceof Error
        ? error.message
        : 'OPERATION_FAILED',
  );
  process.exitCode = 1;
});
