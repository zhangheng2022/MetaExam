import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const repository = 'zhangheng2022/MetaExam';
const directory = path.resolve('artifacts/release');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function validateVersions(customer, issuer, expectedCustomer, expectedIssuer) {
  if (
    !/^\d+\.\d+\.\d+$/.test(customer) ||
    !/^\d+\.\d+\.\d+$/.test(issuer) ||
    customer !== expectedCustomer ||
    issuer !== expectedIssuer
  )
    throw new Error('RELEASE_VERSION_MISMATCH');
}
export function validateDraft(release, sha, tag) {
  if (!release.draft) throw new Error('RELEASE_ALREADY_PUBLISHED');
  if (
    release.tag_name !== tag ||
    release.target_commitish !== sha ||
    !release.body.includes(`<!-- metaexam-commit:${sha} -->`)
  )
    throw new Error('RELEASE_DRAFT_COMMIT_MISMATCH');
}
export function assetNames(customer, issuer) {
  return [
    `MetaExam-Setup-${customer}-win-x64-internal.exe`,
    `MetaExam-Setup-${customer}-win-x64-internal.exe.sha256`,
    `MetaExam-Issuer-Setup-${issuer}-win-x64-internal.exe`,
    `MetaExam-Issuer-Setup-${issuer}-win-x64-internal.exe.sha256`,
    'MetaExam-CodeSigning.cer',
    'CODE-SIGNING.md',
    'RELEASE-NOTES.md',
  ].sort();
}
function context() {
  const customer = json('package.json').version,
    issuer = json('apps/issuer/package.json').version;
  validateVersions(customer, issuer, customer, issuer);
  const sha = process.env.GITHUB_SHA;
  if (
    !/^[a-f0-9]{40}$/.test(sha ?? '') ||
    process.env.GITHUB_REPOSITORY !== repository ||
    process.env.GITHUB_REF !== 'refs/heads/master'
  )
    throw new Error('RELEASE_CONTEXT_INVALID');
  return {
    customer,
    issuer,
    sha,
    tag: `v${customer}`,
    thumbprint: json('installer/signing-certificate.json').thumbprint,
  };
}
function prepare() {
  const c = context();
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length) throw new Error('RELEASE_OUTPUT_NOT_EMPTY');
  for (const name of assetNames(c.customer, c.issuer).filter((n) => n.includes('.exe'))) {
    copyFileSync(path.resolve('artifacts', name), path.join(directory, name));
  }
  copyFileSync(
    'artifacts/payload/licenses/MetaExam-CodeSigning.cer',
    path.join(directory, 'MetaExam-CodeSigning.cer'),
  );
  copyFileSync('docs/code-signing.md', path.join(directory, 'CODE-SIGNING.md'));
  const exes = assetNames(c.customer, c.issuer).filter((n) => n.endsWith('.exe'));
  const rows = exes
    .map((n) => `| ${n} | ${sha256(readFileSync(path.join(directory, n)))} |`)
    .join('\n');
  const notes = `# MetaExam ${c.customer} 预发行\n\n客户 ${c.customer}；供应方签发器 ${c.issuer}。两种安装包均为 Windows x64，使用自签名 Authenticode。\n\n源码提交：${c.sha}\n\n证书指纹：\`${c.thumbprint}\`。首次使用请按 CODE-SIGNING.md 核对并显式信任公开证书；不导入私钥。没有在线时间戳。\n\n客户授权为 internal-test 测试信任配置；软件授权与程序签名相互独立。供应方包不包含密钥和台账。\n\n云端完成类型、Lint、格式、单元、集成、供应方签发、普通权限与成品签名回归。实际服务安装、证书信任、卸载与重启仍需独立环境验收。\n\n| 文件 | SHA256 |\n| --- | --- |\n${rows}\n\n<!-- metaexam-commit:${c.sha} -->\n`;
  writeFileSync(path.join(directory, 'RELEASE-NOTES.md'), notes);
  const files = Object.fromEntries(
    assetNames(c.customer, c.issuer).map((name) => [
      name,
      sha256(readFileSync(path.join(directory, name))),
    ]),
  );
  for (const name of exes) {
    if (
      readFileSync(path.join(directory, name + '.sha256'), 'utf8').trim() !==
      `${files[name]}  ${name}`
    )
      throw new Error('RELEASE_CHECKSUM_MISMATCH');
  }
  writeFileSync(
    path.join(directory, 'release-manifest.json'),
    JSON.stringify({ ...c, files }, null, 2) + '\n',
  );
}
function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
    maxBuffer: 8 * 1024 * 1024,
  });
}
function api(endpoint) {
  return JSON.parse(gh(['api', `repos/${repository}/${endpoint}`]));
}
function optionalApi(endpoint) {
  try {
    return api(endpoint);
  } catch (error) {
    if (error.stderr?.toString().includes('(HTTP 404)')) return null;
    throw error;
  }
}
function publish() {
  const c = context(),
    manifest = json(path.join(directory, 'release-manifest.json'));
  for (const key of ['customer', 'issuer', 'sha', 'tag', 'thumbprint'])
    if (manifest[key] !== c[key]) throw new Error('RELEASE_MANIFEST_MISMATCH');
  const names = assetNames(c.customer, c.issuer);
  if (
    JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(names) ||
    JSON.stringify(readdirSync(directory).sort()) !==
      JSON.stringify([...names, 'release-manifest.json'].sort())
  )
    throw new Error('RELEASE_ASSETS_INVALID');
  for (const name of names)
    if (sha256(readFileSync(path.join(directory, name))) !== manifest.files[name])
      throw new Error('RELEASE_ASSET_TAMPERED');
  const tag = optionalApi(`git/ref/tags/${c.tag}`);
  if (tag && (tag.object.type !== 'commit' || tag.object.sha !== c.sha))
    throw new Error('RELEASE_TAG_COMMIT_MISMATCH');
  let release = optionalApi(`releases/tags/${c.tag}`);
  if (release) validateDraft(release, c.sha, c.tag);
  if (!tag) {
    gh([
      'api',
      '--method',
      'POST',
      `repos/${repository}/git/refs`,
      '-f',
      `ref=refs/tags/${c.tag}`,
      '-f',
      `sha=${c.sha}`,
    ]);
  }
  if (!release) {
    gh([
      'release',
      'create',
      c.tag,
      '--repo',
      repository,
      '--draft',
      '--prerelease',
      '--latest=false',
      '--target',
      c.sha,
      '--title',
      `MetaExam ${c.customer} 预发行`,
      '--notes-file',
      path.join(directory, 'RELEASE-NOTES.md'),
    ]);
    release = api(`releases/tags/${c.tag}`);
    validateDraft(release, c.sha, c.tag);
  }
  const all = [...names, 'release-manifest.json'];
  if (release.assets.some((a) => !all.includes(a.name)))
    throw new Error('RELEASE_UNEXPECTED_REMOTE_ASSET');
  const temporary = mkdtempSync(path.join(tmpdir(), 'metaexam-release-verify-'));
  try {
    for (const name of all) {
      if (!release.assets.some((a) => a.name === name))
        gh(['release', 'upload', c.tag, path.join(directory, name), '--repo', repository]);
      gh([
        'release',
        'download',
        c.tag,
        '--repo',
        repository,
        '--pattern',
        name,
        '--dir',
        temporary,
      ]);
      if (
        sha256(readFileSync(path.join(temporary, name))) !==
        sha256(readFileSync(path.join(directory, name)))
      )
        throw new Error('RELEASE_REMOTE_ASSET_MISMATCH');
    }
    const currentTag = api(`git/ref/tags/${c.tag}`);
    if (currentTag.object.type !== 'commit' || currentTag.object.sha !== c.sha)
      throw new Error('RELEASE_TAG_COMMIT_MISMATCH');
    validateDraft(api(`releases/tags/${c.tag}`), c.sha, c.tag);
    gh([
      'release',
      'edit',
      c.tag,
      '--repo',
      repository,
      '--draft=false',
      '--prerelease',
      '--latest=false',
    ]);
    console.log(`https://github.com/${repository}/releases/tag/${c.tag}`);
  } finally {
    if (
      path.dirname(temporary) === path.resolve(tmpdir()) &&
      path.basename(temporary).startsWith('metaexam-release-verify-')
    )
      rmSync(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === 'prepare') prepare();
  else if (process.argv[2] === 'publish') publish();
  else throw new Error('RELEASE_COMMAND_INVALID');
}
