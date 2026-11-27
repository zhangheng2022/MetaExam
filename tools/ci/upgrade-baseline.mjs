import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSourceRun } from './release.mjs';
import { readRelease, compareVersions } from '../../installer/release.mjs';

export function validateBaseline(artifacts, previous, current, now = Date.now()) {
  const candidates = artifacts.filter((a) => a.name === 'customer-payload');
  if (
    candidates.length !== 1 ||
    candidates[0].expired ||
    !Number.isFinite(Date.parse(candidates[0].expires_at)) ||
    Date.parse(candidates[0].expires_at) <= now
  )
    throw new Error('UPGRADE_BASELINE_UNAVAILABLE');
  if (!/^\d+\.\d+\.\d+$/.test(previous) || compareVersions(previous, current) >= 0)
    throw new Error('UPGRADE_BASELINE_NOT_OLDER');
}
async function main() {
  const id = process.env.UPGRADE_BASELINE_RUN_ID;
  if (!/^[1-9]\d*$/.test(id ?? '')) throw new Error('UPGRADE_BASELINE_RUN_REQUIRED');
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
  const artifacts = JSON.parse(
    gh([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repository}/actions/runs/${id}/artifacts?per_page=100`,
    ]),
  ).flatMap((page) => page.artifacts);
  const source = api(`contents/package.json?ref=${run.head_sha}`);
  const previous = JSON.parse(Buffer.from(source.content, 'base64').toString('utf8')).version;
  const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
  validateBaseline(artifacts, previous, current);
  console.log(`UPGRADE_BASELINE_AVAILABLE: run=${id} version=${previous} commit=${run.head_sha}`);
  if (process.argv.includes('--check')) return;
  const archive = path.resolve('artifacts/upgrade-baseline-archive');
  const target = path.resolve('artifacts/upgrade-baseline');
  // Never overwrite or synthesize historical payloads from current source.
  mkdirSync(archive);
  gh(['run', 'download', id, '--repo', repository, '--name', 'customer-payload', '--dir', archive]);
  mkdirSync(target);
  execFileSync('tar.exe', ['-xzf', path.join(archive, 'customer-payload.tgz'), '-C', target], {
    windowsHide: true,
  });
  const baseline = await readRelease(target);
  if (baseline.version !== previous) throw new Error('UPGRADE_BASELINE_SOURCE_MISMATCH');
  console.log(
    `UPGRADE_BASELINE_VERIFIED: run=${id} version=${baseline.version} buildId=${baseline.buildId}`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
