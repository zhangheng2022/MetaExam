import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serviceEntries, serviceXml } from '../installer/service-config.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'MetaExam-service-config-'));
try {
  const app = path.join(root, 'program & files'),
    data = path.join(root, 'data & files');
  for (const [id, entry, log] of serviceEntries(data)) {
    const file = path.join(root, id + '.xml');
    await writeFile(file, serviceXml(app, data, id, entry, log));
    // Parse using the actual locked WinSW binary, without installing/running services.
    const script =
      "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd() | ConvertFrom-Json; $a=[Reflection.Assembly]::LoadFrom($p.binary); $t=$a.GetType('WinSW.XmlServiceConfig'); $doc=[xml](Get-Content -LiteralPath $p.xml -Raw); $c=[Activator]::CreateInstance($t,@($doc)); [pscustomobject]@{executable=$c.Executable;arguments=$c.Arguments;start=$c.StartArguments;stop=$c.StopArguments;parentFirst=$c.StopParentProcessFirst;timeout=$c.StopTimeout.TotalSeconds} | ConvertTo-Json -Compress";
    const parsed = JSON.parse(
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        input: JSON.stringify({ binary: path.resolve('.tools/WinSW.NET462.exe'), xml: file }),
        windowsHide: true,
        encoding: 'utf8',
        timeout: 15000,
      }),
    );
    assert.equal(parsed.executable, path.join(app, 'runtime/node.exe'));
    assert.equal(parsed.arguments, '');
    assert.equal(parsed.start, '--use-system-ca "' + path.join(app, entry) + '"');
    assert.equal(parsed.stop, null);
    assert.equal(parsed.parentFirst, true);
    assert.equal(parsed.timeout, 60);
  }
  console.log(
    'PASS locked WinSW parses startup-only arguments, supervisor-first stop and no custom-stop shutdown path',
  );
} finally {
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('MetaExam-service-config-'));
  await rm(root, { recursive: true, force: true });
}
