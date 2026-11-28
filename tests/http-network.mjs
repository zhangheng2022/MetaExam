import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  migrateHttpNetwork,
  backupConfiguration,
  originalConfigurationHash,
  validateSubnet,
  windowsHttpNetwork,
} from '../installer/http-network.mjs';
import { hashFile } from '../installer/release.mjs';

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
async function fixture(t, tls = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'MetaExam-http-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('MetaExam-http-'));
    await rm(root, { recursive: true, force: true });
  });
  const data = path.join(root, 'data'),
    work = path.join(root, 'work');
  await mkdir(data);
  await mkdir(work);
  const original = {
    home: path.join(data, 'runtime'),
    database: { host: '127.0.0.1', port: 55432, user: 'metaexam_app' },
    passwordDpapi: path.join(data, 'secrets/database.dpapi'),
    trustFile: path.join(root, 'public-keys.json'),
    api: {
      host: tls ? '0.0.0.0' : '127.0.0.1',
      port: 3123,
      managementToken: 'test-token-only',
      ...(tls ? { tlsCert: 'old.crt', tlsKey: 'old.key' } : {}),
    },
    production: tls,
    leaseSeconds: 30,
    ...(tls ? { firewallSubnet: '192.168.20.0/24' } : {}),
  };
  await writeFile(path.join(data, 'config.json'), JSON.stringify(original));
  await writeFile(
    path.join(data, 'public-config.json'),
    JSON.stringify({ api: { port: 3123, ...(tls ? { tlsCert: 'old.crt' } : {}) } }),
  );
  await writeFile(path.join(data, 'installation.json'), '{}');
  let fail,
    firewallCalls = 0;
  const operations = {
    configureFirewall: async (port, subnet) => {
      assert.equal(port, 3123);
      assert.equal(subnet, tls ? '192.168.20.0/24' : 'LocalSubnet');
      firewallCalls++;
    },
    checkpoint: async (phase) => {
      if (phase === fail) throw new Error('INJECTED_FAILURE');
    },
  };
  return {
    data,
    work,
    original,
    operations,
    interrupt: (phase) => {
      fail = phase;
    },
    firewallCalls: () => firewallCalls,
  };
}

for (const tls of [false, true]) {
  for (const phase of ['http-prepared', 'http-config', 'http-public-config', 'http-firewall']) {
    test(`${tls ? 'HTTPS' : 'local HTTP'} conversion resumes after ${phase} without altering credentials`, async (t) => {
      const f = await fixture(t, tls);
      const before = await hashFile(path.join(f.data, 'config.json'));
      f.interrupt(phase);
      await assert.rejects(migrateHttpNetwork(f, f.operations), /INJECTED_FAILURE/);
      assert.equal(await originalConfigurationHash(f.data, f.work), before);
      assert.deepEqual(await json(await backupConfiguration(f.data, f.work)), f.original);
      f.interrupt(undefined);
      await migrateHttpNetwork(f, f.operations);
      const actual = await json(path.join(f.data, 'config.json'));
      assert.deepEqual(actual, {
        ...f.original,
        api: { host: '0.0.0.0', port: 3123, managementToken: 'test-token-only' },
        production: true,
        firewallSubnet: tls ? '192.168.20.0/24' : 'LocalSubnet',
      });
      assert.deepEqual(await json(path.join(f.data, 'public-config.json')), {
        api: { port: 3123 },
      });
      await migrateHttpNetwork(f, f.operations);
      assert.ok(f.firewallCalls() >= 2);
      assert.equal(await originalConfigurationHash(f.data, f.work), before);
    });
  }
}

for (const file of ['config.json', 'public-config.json']) {
  test(`conversion refuses unrelated edits to ${file} on resume`, async (t) => {
    const f = await fixture(t);
    f.interrupt('http-config');
    await assert.rejects(migrateHttpNetwork(f, f.operations), /INJECTED_FAILURE/);
    await writeFile(path.join(f.data, file), JSON.stringify({ unexpected: true }));
    await assert.rejects(migrateHttpNetwork(f, f.operations), /HTTP_CONFIGURATION_CHANGED/);
    await assert.rejects(backupConfiguration(f.data, f.work), /HTTP_CONFIGURATION_CHANGED/);
    assert.equal(f.firewallCalls(), 0);
  });
}

test('reinstall restores the recorded subnet and does not require obsolete certificate files', async (t) => {
  const f = await fixture(t);
  delete f.original.firewallSubnet;
  await writeFile(path.join(f.data, 'config.json'), JSON.stringify(f.original));
  await writeFile(
    path.join(f.data, 'installation.json'),
    JSON.stringify({ reinstall: { subnet: '192.168.20.0/24' } }),
  );
  await migrateHttpNetwork(f, f.operations);
  assert.equal((await json(path.join(f.data, 'config.json'))).firewallSubnet, '192.168.20.0/24');
});

test('subnet validation rejects command syntax, empty scopes and malformed addresses', () => {
  for (const value of [
    '',
    'Any',
    'LocalSubnet";whoami',
    '192.168.0.0/33',
    '::/129',
    'example.com',
    'LocalSubnet,',
  ])
    assert.throws(() => validateSubnet(value), /HTTP_SUBNET_INVALID/);
  for (const value of [
    'LocalSubnet',
    '192.168.0.0/24',
    '10.0.0.1,10.0.0.2',
    'fe80::/64',
    '10.0.0.1-10.0.0.9',
  ])
    assert.equal(validateSubnet(value), value);
});

test('Windows firewall adapter runs fixed scripts and only replaces the owned inbound TCP rule', async () => {
  const app = 'C:\\MetaExam test',
    port = 3123;
  let result;
  const adapter = windowsHttpNetwork(app, async (script, input) => {
    // Execute the production PowerShell script against process-local command doubles.
    // No native firewall cmdlet is invoked and no elevation is needed.
    const doubles = `
      $global:removed=@(); $global:added=$null
      function Get-NetFirewallRule {
        [CmdletBinding()] param()
        foreach($name in @('owned','otherProgram','otherPort','outbound','unrelated')) {
          [pscustomobject]@{Name=$name; DisplayName=$(if($name -eq 'unrelated'){'Unrelated'}else{'MetaExam HTTPS'}); Program=$(if($name -eq 'otherProgram'){'C:\\Other\\node.exe'}else{'C:\\MetaExam test\\runtime\\node.exe'}); Port=$(if($name -eq 'otherPort'){'9999'}else{'3123'}); Protocol='TCP'; Direction=$(if($name -eq 'outbound'){'Outbound'}else{'Inbound'})}
        }
      }
      function Get-NetFirewallApplicationFilter { process { [pscustomobject]@{Program=$_.Program} } }
      function Get-NetFirewallPortFilter { process { [pscustomobject]@{LocalPort=$_.Port; Protocol=$_.Protocol} } }
      function Remove-NetFirewallRule {
        [CmdletBinding()] param([Parameter(ValueFromPipeline=$true)]$InputObject)
        process { $global:removed += $InputObject.Name }
      }
      function New-NetFirewallRule {
        [CmdletBinding()] param($DisplayName,$Direction,$Action,$Protocol,$LocalPort,$RemoteAddress,$Profile,$Program)
        $global:added=@{name=$DisplayName;direction=$Direction;action=$Action;protocol=$Protocol;port=$LocalPort;subnet=$RemoteAddress;profile=$Profile;program=$Program}
      }
    `;
    result = JSON.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          doubles +
            '\n' +
            script +
            '\n@{removed=$global:removed;added=$global:added} | ConvertTo-Json -Compress -Depth 5',
        ],
        { input, encoding: 'utf8', windowsHide: true, timeout: 15000 },
      ),
    );
    return '';
  });
  await adapter.configureFirewall(port, '10.0.0.0/24');
  assert.deepEqual(result.removed, ['owned']);
  assert.deepEqual(result.added, {
    name: 'MetaExam HTTP',
    direction: 'Inbound',
    action: 'Allow',
    protocol: 'TCP',
    port,
    subnet: '10.0.0.0/24',
    profile: ['Private', 'Domain'],
    program: path.join(app, 'runtime/node.exe'),
  });
  await adapter.removeFirewall(port);
  assert.deepEqual(result.removed, ['owned']);
  assert.equal(result.added, null);
});
