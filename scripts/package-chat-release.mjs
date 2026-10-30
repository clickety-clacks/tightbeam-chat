import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const SOURCE_PATTERN = /^[a-f0-9]{40}$/;

async function exists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

export async function packageChatRelease({
  rootDir = process.cwd(),
  outputDir = path.resolve(rootDir, 'dist/chat-release'),
  tag,
  sourceCommit,
  builtAt = new Date().toISOString(),
  nodeVersion = process.version,
  npmVersion = 'unknown',
} = {}) {
  if (!TAG_PATTERN.test(tag ?? '')) throw new Error('Release tag must use the vMAJOR.MINOR.PATCH form.');
  if (!SOURCE_PATTERN.test(sourceCommit ?? '')) throw new Error('Release source must be a full commit SHA.');

  const webDir = path.resolve(rootDir, 'dist/chat-server/public');
  const required = [
    path.join(webDir, 'index.html'),
    path.resolve(rootDir, 'server/chat-server.mjs'),
    path.resolve(rootDir, 'server/activity-summaries.mjs'),
    path.resolve(rootDir, 'scripts/update-chat-release.mjs'),
    path.resolve(rootDir, 'scripts/chat-release-updater.mjs'),
    path.resolve(rootDir, 'scripts/chat-release-watch.mjs'),
    path.resolve(rootDir, 'packaging/tightbeam-chat.service'),
    path.resolve(rootDir, 'packaging/tightbeam-chat-release-watch.service'),
    path.resolve(rootDir, 'packaging/tightbeam-chat-release-watch.timer'),
    path.resolve(rootDir, 'LICENSE'),
    path.resolve(rootDir, 'THIRD_PARTY_NOTICES.md'),
  ];
  for (const filename of required) {
    if (!(await exists(filename))) throw new Error(`Required release input is missing: ${path.relative(rootDir, filename)}`);
  }

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tightbeam-chat-release-'));
  try {
    const packageDir = path.join(temporaryDir, 'package');
    await fs.mkdir(packageDir, { recursive: true });
    await fs.mkdir(path.join(packageDir, 'public'), { recursive: true });
    await fs.mkdir(path.join(packageDir, 'server'), { recursive: true });
    await fs.mkdir(path.join(packageDir, 'bin'), { recursive: true });
    await fs.mkdir(path.join(packageDir, 'packaging'), { recursive: true });

    for (const item of await fs.readdir(webDir)) {
      await fs.cp(path.join(webDir, item), path.join(packageDir, 'public', item), { recursive: true });
    }
    await fs.copyFile(path.resolve(rootDir, 'server/chat-server.mjs'), path.join(packageDir, 'server/chat-server.mjs'));
    await fs.copyFile(path.resolve(rootDir, 'server/activity-summaries.mjs'), path.join(packageDir, 'server/activity-summaries.mjs'));
    await fs.copyFile(path.resolve(rootDir, 'scripts/update-chat-release.mjs'), path.join(packageDir, 'bin/update-chat-release.mjs'));
    await fs.copyFile(path.resolve(rootDir, 'scripts/chat-release-updater.mjs'), path.join(packageDir, 'bin/chat-release-updater.mjs'));
    await fs.copyFile(path.resolve(rootDir, 'scripts/chat-release-watch.mjs'), path.join(packageDir, 'bin/chat-release-watch.mjs'));
    await fs.copyFile(path.resolve(rootDir, 'packaging/tightbeam-chat.service'), path.join(packageDir, 'packaging/tightbeam-chat.service'));
    await fs.copyFile(path.resolve(rootDir, 'packaging/tightbeam-chat-release-watch.service'), path.join(packageDir, 'packaging/tightbeam-chat-release-watch.service'));
    await fs.copyFile(path.resolve(rootDir, 'packaging/tightbeam-chat-release-watch.timer'), path.join(packageDir, 'packaging/tightbeam-chat-release-watch.timer'));
    await fs.copyFile(path.resolve(rootDir, 'LICENSE'), path.join(packageDir, 'LICENSE'));
    await fs.copyFile(path.resolve(rootDir, 'THIRD_PARTY_NOTICES.md'), path.join(packageDir, 'THIRD_PARTY_NOTICES.md'));

    await fs.writeFile(path.join(packageDir, 'release.json'), `${JSON.stringify({
      product: 'tightbeam-chat',
      tag,
      sourceCommit,
      nodeVersion,
    }, null, 2)}\n`);

    const assetName = `tightbeam-chat-${tag}.tar.gz`;
    const assetPath = path.join(outputDir, assetName);
    execFileSync('tar', ['-czf', assetPath, '-C', packageDir, '.'], { stdio: 'inherit' });
    const assetSha256 = crypto.createHash('sha256').update(await fs.readFile(assetPath)).digest('hex');
    const provenance = {
      product: 'tightbeam-chat',
      schemaVersion: 1,
      tag,
      sourceCommit,
      builtAt,
      nodeVersion,
      npmVersion,
      asset: assetName,
      sha256: assetSha256,
    };
    await fs.writeFile(path.join(outputDir, 'SHA256SUMS'), `${assetSha256}  ${assetName}\n`);
    await fs.writeFile(path.join(outputDir, 'release-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
    await fs.writeFile(path.join(outputDir, 'release-notes.md'), [
      `Tightbeam Chat ${tag}`,
      '',
      'This release contains the deployable Chat server, browser assets, and a user-level timer that checks hourly for a newer published stable release.',
      `Source commit: ${sourceCommit}`,
      `Package: ${assetName}`,
      `SHA-256: ${assetSha256}`,
      '',
      'Use the included updater to verify the published asset checksum before staging it.',
      '',
    ].join('\n'));

    return { assetPath, assetName, assetSha256, provenance, outputDir };
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await packageChatRelease({
      tag: process.env.CHAT_RELEASE_TAG ?? process.env.GITHUB_REF_NAME,
      sourceCommit: process.env.GITHUB_SHA,
      npmVersion: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    });
    process.stdout.write(`${JSON.stringify({ asset: result.assetName, sha256: result.assetSha256, provenance: 'release-provenance.json' })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Release packaging failed.'}\n`);
    process.exitCode = 1;
  }
}
