import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { validateSourceRun } from './release.mjs';
import { readRelease, compareVersions } from '../../installer/release.mjs';

const id = process.env.UPGRADE_BASELINE_RUN_ID;
if (!/^\d+$/.test(id ?? '')) throw new Error('UPGRADE_BASELINE_RUN_REQUIRED');
const repository = 'zhangheng2022/MetaExam';
const gh = (args) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: args[0] === 'run' ? 10 * 60 * 1000 : 60000,
  });
const api = (endpoint) => JSON.parse(gh(['api', `repos/${repository}/${endpoint}`]));
const run = api(`actions/runs/${id}`);
const jobs = api(`actions/runs/${id}/jobs?per_page=100`).jobs;
validateSourceRun(run, jobs, run.head_sha, false);
console.log(`UPGRADE_BASELINE_DOWNLOADING: run=${id} commit=${run.head_sha}`);
const archive = path.resolve('artifacts/upgrade-baseline-archive');
const target = path.resolve('artifacts/upgrade-baseline');
// Existing baselines are not overwritten or synthesized from current source.
mkdirSync(archive);
gh(['run', 'download', id, '--repo', repository, '--name', 'customer-payload', '--dir', archive]);
mkdirSync(target);
console.log('UPGRADE_BASELINE_EXTRACTING');
execFileSync('tar.exe', ['-xzf', path.join(archive, 'customer-payload.tgz'), '-C', target], {
  windowsHide: true,
});
const baseline = await readRelease(target);
const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (compareVersions(baseline.version, current) >= 0) throw new Error('UPGRADE_BASELINE_NOT_OLDER');
console.log(
  `UPGRADE_BASELINE_VERIFIED: run=${id} version=${baseline.version} buildId=${baseline.buildId}`,
);
