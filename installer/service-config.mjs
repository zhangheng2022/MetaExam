import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ordinary } from './release.mjs';

const encode = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
export const serviceEntries = (data) => [
  ['MetaExam.Postgres', 'maintenance/postgres-service.mjs', path.join(data, 'logs/postgres')],
  ['MetaExam.Api', 'server/api.cjs', path.join(data, 'logs/api')],
  ['MetaExam.Worker', 'server/worker.cjs', path.join(data, 'logs/worker')],
];
export function serviceXml(app, data, id, entry, log) {
  return (
    '<service><id>' +
    id +
    '</id><name>' +
    id +
    '</name>' +
    '<description>MetaExam internal test service</description><executable>' +
    encode(path.join(app, 'runtime/node.exe')) +
    '</executable><startarguments>--use-system-ca &quot;' +
    encode(path.join(app, entry)) +
    '&quot;</startarguments>' +
    '<workingdirectory>' +
    encode(app) +
    '</workingdirectory>' +
    '<env name="METAEXAM_CONFIG" value="' +
    encode(path.join(data, 'config.json')) +
    '"/>' +
    '<env name="METAEXAM_INSTALL_ROOT" value="' +
    encode(app) +
    '"/>' +
    '<env name="METAEXAM_DATA_ROOT" value="' +
    encode(data) +
    '"/>' +
    '<logpath>' +
    encode(log) +
    '</logpath><log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log>' +
    // WinSW 2.x appends shared arguments to stoparguments, and its custom-stop
    // OnShutdown path calls RequestAdditionalTime outside a pending SCM control.
    // Let WinSW signal the supervisor first; it performs pg_ctl fast shutdown.
    '<stopparentprocessfirst>true</stopparentprocessfirst><stoptimeout>60sec</stoptimeout></service>'
  );
}
export function registerServiceEventSources() {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; foreach($id in @('MetaExam.Postgres','MetaExam.Api','MetaExam.Worker')) { if([Diagnostics.EventLog]::SourceExists($id)) { if([Diagnostics.EventLog]::LogNameFromSourceName($id,'.') -ne 'Application') { throw 'SERVICE_EVENT_SOURCE_OWNERSHIP' } } else { [Diagnostics.EventLog]::CreateEventSource($id,'Application') } }",
    ],
    { windowsHide: true, stdio: 'pipe', timeout: 30000 },
  );
}
export async function refreshServiceConfiguration(app, data) {
  for (const [id, entry, log] of serviceEntries(data)) {
    const file = path.join(app, 'services', id + '.xml');
    if (existsSync(file)) await ordinary(file);
    writeFileSync(file, serviceXml(app, data, id, entry, log));
  }
  registerServiceEventSources();
}
