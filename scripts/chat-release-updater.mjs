import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHAT_RELEASE_REPOSITORY = 'clickety-clacks/tightbeam-chat';
export const CHAT_SERVICE_NAME = 'tightbeam-chat.service';
export const CHAT_SERVICE_PORT = 4178;
export const CHAT_RELEASE_WATCH_SERVICE_NAME = 'tightbeam-chat-release-watch.service';
export const CHAT_RELEASE_WATCH_TIMER_NAME = 'tightbeam-chat-release-watch.timer';

const API_ROOT = `https://api.github.com/repos/${CHAT_RELEASE_REPOSITORY}`;
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
// Preserve the complete lock-verified MIT notice required by the bundled React runtime.
const REACT_MIT_NOTICE_SHA256 = 'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93';

function assetNameFor(tag) {
  return `tightbeam-chat-${tag}.tar.gz`;
}

function validateTag(tag) {
  if (!TAG_PATTERN.test(tag ?? '')) throw new Error('Choose a published Chat release tag in vMAJOR.MINOR.PATCH form.');
}

async function readResponse(response, label) {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  return response;
}

async function fetchJson(fetchImpl, url, label) {
  const response = await readResponse(await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'tightbeam-chat-updater',
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'error',
  }), label);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function findPublishedAsset(release, name, tag) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const matches = assets.filter((asset) => asset?.name === name);
  if (matches.length !== 1) throw new Error(`Published release ${tag} must contain exactly one ${name} asset.`);
  const asset = matches[0];
  const expectedPath = `/${CHAT_RELEASE_REPOSITORY}/releases/download/${tag}/${name}`;
  let downloadUrl;
  try {
    downloadUrl = new URL(asset.browser_download_url);
  } catch {
    throw new Error(`Published release ${tag} has an invalid ${name} URL.`);
  }
  if (downloadUrl.protocol !== 'https:' || downloadUrl.hostname !== 'github.com' ||
      downloadUrl.pathname !== expectedPath || downloadUrl.username || downloadUrl.password ||
      downloadUrl.search || downloadUrl.hash || asset.state !== 'uploaded' ||
      !Number.isSafeInteger(asset.size) || asset.size < 1) {
    throw new Error(`Published release ${tag} has an invalid ${name} asset record.`);
  }
  return { name, size: asset.size, url: downloadUrl.href };
}

async function downloadAsset(fetchImpl, asset, tag) {
  const response = await readResponse(await fetchImpl(asset.url, {
    headers: { accept: 'application/octet-stream', 'user-agent': 'tightbeam-chat-updater' },
    redirect: 'follow',
  }), `Download of ${asset.name} for ${tag}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.size) throw new Error(`Downloaded ${asset.name} size does not match the published asset record.`);
  return bytes;
}

function parseChecksum(checksumBytes, tag, assetName, expectedHash) {
  const lines = checksumBytes.toString('utf8').trimEnd().split(/\r?\n/);
  if (lines.length !== 1 || lines[0] !== `${expectedHash}  ${assetName}`) {
    throw new Error(`Published SHA256SUMS does not name the verified ${assetName} for ${tag}.`);
  }
}

export async function fetchVerifiedChatRelease(tag, { fetchImpl = globalThis.fetch } = {}) {
  validateTag(tag);
  if (typeof fetchImpl !== 'function') throw new Error('A release transport is required.');
  const release = await fetchJson(fetchImpl, `${API_ROOT}/releases/tags/${encodeURIComponent(tag)}`, `Release lookup for ${tag}`);
  if (release.tag_name !== tag || release.draft !== false || typeof release.published_at !== 'string' || !release.published_at) {
    throw new Error(`Chat tag ${tag} has no published release.`);
  }

  const names = [assetNameFor(tag), 'SHA256SUMS', 'release-provenance.json'];
  const assets = names.map((name) => findPublishedAsset(release, name, tag));
  const [archiveBytes, checksumBytes, provenanceBytes] = await Promise.all(
    assets.map((asset) => downloadAsset(fetchImpl, asset, tag)),
  );

  let provenance;
  try {
    provenance = JSON.parse(provenanceBytes.toString('utf8'));
  } catch {
    throw new Error(`Published provenance for ${tag} is invalid JSON.`);
  }
  const archiveName = assetNameFor(tag);
  const actualHash = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  const mismatches = [];
  if (provenance.product !== 'tightbeam-chat') mismatches.push('product');
  if (provenance.schemaVersion !== 1) mismatches.push('schemaVersion');
  if (provenance.tag !== tag) mismatches.push('tag');
  if (provenance.asset !== archiveName) mismatches.push('asset');
  if (provenance.sha256 !== actualHash || !HASH_PATTERN.test(provenance.sha256 ?? '')) {
    mismatches.push('sha256');
  }
  if (!SHA_PATTERN.test(provenance.sourceCommit ?? '')) mismatches.push('sourceCommit');
  if (mismatches.length) {
    throw new Error(`Published provenance for ${tag} does not match the downloaded asset (${mismatches.join(', ')}).`);
  }
  parseChecksum(checksumBytes, tag, archiveName, actualHash);

  const commit = await fetchJson(fetchImpl, `${API_ROOT}/commits/${encodeURIComponent(tag)}`, `Tag source lookup for ${tag}`);
  if (!SHA_PATTERN.test(commit.sha ?? '') || commit.sha !== provenance.sourceCommit) {
    throw new Error(`Published provenance for ${tag} does not match the tagged source commit.`);
  }

  return { archiveBytes, provenance, assets };
}

function runTar(arguments_) {
  try {
    execFileSync('tar', arguments_, { stdio: 'pipe' });
  } catch {
    throw new Error('The verified Chat bundle could not be staged.');
  }
}

function inspectArchive(archivePath) {
  let members;
  try {
    members = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split(/\r?\n/).filter(Boolean);
  } catch {
    throw new Error('The verified Chat bundle is not a readable archive.');
  }
  for (const member of members) {
    const relative = member.replace(/^\.\//, '').replace(/\/+$/, '');
    if (member.startsWith('/') || relative.split('/').includes('..')) {
      throw new Error('The Chat bundle contains a path outside its release directory.');
    }
    const allowed = relative === '' || relative === 'LICENSE' || relative === 'THIRD_PARTY_NOTICES.md' ||
      relative === 'release.json' || relative === 'server' || relative === 'server/chat-server.mjs' ||
      relative === 'public' || relative.startsWith('public/') || relative === 'bin' ||
      /^bin\/[a-z0-9-]+\.mjs$/.test(relative) || relative === 'packaging' ||
      relative === 'packaging/tightbeam-chat.service' ||
      relative === `packaging/${CHAT_RELEASE_WATCH_SERVICE_NAME}` ||
      relative === `packaging/${CHAT_RELEASE_WATCH_TIMER_NAME}`;
    if (!allowed) throw new Error(`The Chat bundle contains an unexpected path: ${relative}.`);
  }
}

async function rejectSymlinks(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const info = await fs.lstat(filename);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error('The Chat bundle contains a non-regular release entry.');
    }
    if (info.isDirectory()) await rejectSymlinks(filename);
  }
}

async function readJson(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch {
    return undefined;
  }
}

async function exists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

async function linkTarget(filename, releasesDir) {
  try {
    const info = await fs.lstat(filename);
    if (!info.isSymbolicLink()) throw new Error('Chat release pointer is not a symlink.');
    const raw = await fs.readlink(filename);
    const target = path.resolve(path.dirname(filename), raw);
    if (!target.startsWith(`${path.resolve(releasesDir)}${path.sep}`)) {
      throw new Error('Chat release pointer leaves its release directory.');
    }
    return target;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicSymlink(filename, target) {
  const temporary = `${filename}.next-${process.pid}`;
  await fs.rm(temporary, { force: true });
  await fs.symlink(path.relative(path.dirname(filename), target), temporary);
  await fs.rename(temporary, filename);
}

async function restoreSymlink(filename, previousTarget) {
  if (previousTarget) await atomicSymlink(filename, previousTarget);
  else await fs.rm(filename, { force: true });
}

async function writeAtomic(filename, content) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.next-${process.pid}`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, filename);
}

function validateReactRuntimeNotice(noticeText) {
  for (const name of ['react', 'react-dom', 'scheduler']) {
    const row = new RegExp(`\\| ${name} \\| [^|]+ \\| [^|]+ \\| MIT \\|`);
    if (!row.test(noticeText)) throw new Error('The Chat bundle is missing a required React runtime notice.');
  }

  const start = noticeText.indexOf('MIT License\n\n');
  const ending = start < 0 ? -1 : noticeText.indexOf('SOFTWARE.\n', start);
  if (start < 0 || ending < 0) throw new Error('The Chat bundle is missing the complete React runtime license notice.');
  const license = noticeText.slice(start, ending + 'SOFTWARE.\n'.length);
  const hash = crypto.createHash('sha256').update(license).digest('hex');
  if (hash !== REACT_MIT_NOTICE_SHA256) {
    throw new Error('The Chat bundle contains an incomplete React runtime license notice.');
  }
}

async function validateStagedBundle(directory, provenance) {
  const release = await readJson(path.join(directory, 'release.json'));
  if (release?.product !== 'tightbeam-chat' || release.tag !== provenance.tag ||
      release.sourceCommit !== provenance.sourceCommit) {
    throw new Error(`The Chat bundle identity does not match published provenance for ${provenance.tag}.`);
  }
  const requiredFiles = [
    'public/index.html',
    'server/chat-server.mjs',
    'bin/update-chat-release.mjs',
    'bin/chat-release-updater.mjs',
    'bin/chat-release-watch.mjs',
    'packaging/tightbeam-chat.service',
    `packaging/${CHAT_RELEASE_WATCH_SERVICE_NAME}`,
    `packaging/${CHAT_RELEASE_WATCH_TIMER_NAME}`,
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ];
  for (const relative of requiredFiles) {
    if (!(await exists(path.join(directory, relative)))) {
      throw new Error(`The Chat bundle is missing ${relative}.`);
    }
  }
  validateReactRuntimeNotice(await fs.readFile(path.join(directory, 'THIRD_PARTY_NOTICES.md'), 'utf8'));
}

function systemctl(args) {
  try {
    return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    throw new Error(`Chat service command failed: systemctl --user ${args.join(' ')} (${error.status ?? 'unavailable'}).`);
  }
}

async function readOptionalText(filename) {
  try {
    return await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function inspectReleaseWatcher({ homeDir, releaseDir, serviceManager, allowMissingRelease = false }) {
  const servicePath = path.join(homeDir, '.config/systemd/user', CHAT_RELEASE_WATCH_SERVICE_NAME);
  const timerPath = path.join(homeDir, '.config/systemd/user', CHAT_RELEASE_WATCH_TIMER_NAME);
  const packagedService = releaseDir
    ? await readOptionalText(path.join(releaseDir, 'packaging', CHAT_RELEASE_WATCH_SERVICE_NAME))
    : undefined;
  const packagedTimer = releaseDir
    ? await readOptionalText(path.join(releaseDir, 'packaging', CHAT_RELEASE_WATCH_TIMER_NAME))
    : undefined;
  const priorService = await readOptionalText(servicePath);
  const priorTimer = await readOptionalText(timerPath);
  const timerEnabled = await serviceManager.isWatchTimerEnabled();

  if (packagedService === undefined || packagedTimer === undefined) {
    if (!allowMissingRelease || packagedService !== undefined || packagedTimer !== undefined) {
      throw new Error('The selected Chat release does not contain complete release watcher units.');
    }
    if (priorService !== undefined || priorTimer !== undefined || timerEnabled) {
      throw new Error('Chat watcher units exist but no adjacent verified release supplies their expected contents.');
    }
    return { servicePath, timerPath, installed: false, timerEnabled: false };
  }

  if ((priorService === undefined) !== (priorTimer === undefined)) {
    throw new Error('The Chat release watcher units are only partially installed; no release was staged.');
  }
  if (priorService !== undefined && (priorService !== packagedService || priorTimer !== packagedTimer)) {
    throw new Error('The Chat release watcher units have local changes; no release was staged.');
  }
  if (priorService === undefined && timerEnabled) {
    throw new Error('The Chat release watcher timer is enabled without its managed units; no release was staged.');
  }

  return {
    servicePath,
    timerPath,
    packagedService,
    packagedTimer,
    installed: priorService !== undefined,
    timerEnabled,
  };
}

async function installNewReleaseWatcher(watcher, serviceManager) {
  await writeAtomic(watcher.servicePath, watcher.packagedService);
  await writeAtomic(watcher.timerPath, watcher.packagedTimer);
  await serviceManager.reload();
  await serviceManager.enableWatchTimer();
}

async function removeNewReleaseWatcher(watcher, serviceManager) {
  if (await serviceManager.isWatchTimerEnabled()) await serviceManager.disableWatchTimer();
  if (await exists(watcher.servicePath)) await serviceManager.stopWatchService();
  await fs.rm(watcher.servicePath, { force: true });
  await fs.rm(watcher.timerPath, { force: true });
  await serviceManager.reload();
}

const defaultServiceManager = {
  async reload() { systemctl(['daemon-reload']); },
  async isEnabled() {
    try { return systemctl(['is-enabled', CHAT_SERVICE_NAME]) === 'enabled'; }
    catch { return false; }
  },
  async enable() { systemctl(['enable', CHAT_SERVICE_NAME]); },
  async restart() { systemctl(['restart', CHAT_SERVICE_NAME]); },
  async stopAndDisable() { systemctl(['disable', '--now', CHAT_SERVICE_NAME]); },
  async isWatchTimerEnabled() {
    try { return systemctl(['is-enabled', CHAT_RELEASE_WATCH_TIMER_NAME]) === 'enabled'; }
    catch { return false; }
  },
  async enableWatchTimer() { systemctl(['enable', '--now', CHAT_RELEASE_WATCH_TIMER_NAME]); },
  async disableWatchTimer() { systemctl(['disable', '--now', CHAT_RELEASE_WATCH_TIMER_NAME]); },
  async stopWatchService() { systemctl(['stop', CHAT_RELEASE_WATCH_SERVICE_NAME]); },
};

async function defaultHealthCheck(expected) {
  const endpoint = `http://127.0.0.1:${CHAT_SERVICE_PORT}/__chat/version`;
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(endpoint, { redirect: 'error' });
      if (response.ok) {
        const actual = await response.json();
        if (actual.product === 'tightbeam-chat' && actual.tag === expected.tag &&
            actual.sourceCommit === expected.sourceCommit) return actual;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(lastError ? `Chat did not serve ${expected.tag} after restart.` : `Chat did not serve ${expected.tag} after restart.`);
}

async function rollbackAfterFailedActivation({
  currentLink,
  previousLink,
  priorCurrent,
  priorPrevious,
  unitPath,
  priorUnit,
  serviceManager,
  healthCheck,
  priorIdentity,
}) {
  if (!priorCurrent) {
    await serviceManager.stopAndDisable();
    try {
      await restoreSymlink(currentLink, priorCurrent);
      await restoreSymlink(previousLink, priorPrevious);
      if (priorUnit === undefined) await fs.rm(unitPath, { force: true });
      else await writeAtomic(unitPath, priorUnit);
      await serviceManager.reload();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown cleanup failure';
      throw new Error(`The first-install Chat service was stopped and disabled, but its files could not be fully cleaned up: ${detail}`);
    }
    return;
  }

  await restoreSymlink(currentLink, priorCurrent);
  await restoreSymlink(previousLink, priorPrevious);
  if (priorUnit === undefined) await fs.rm(unitPath, { force: true });
  else await writeAtomic(unitPath, priorUnit);
  try {
    await serviceManager.reload();
    if (priorCurrent) {
      await serviceManager.restart();
      await healthCheck({ tag: priorIdentity.tag, sourceCommit: priorIdentity.sourceCommit });
    }
  } catch {
    throw new Error('Chat activation failed and the prior Chat service could not be restarted.');
  }
}

export async function installChatRelease(tag, {
  homeDir = os.homedir(),
  fetchImpl = globalThis.fetch,
  serviceManager = defaultServiceManager,
  healthCheck = defaultHealthCheck,
} = {}) {
  const verified = await fetchVerifiedChatRelease(tag, { fetchImpl });
  const root = path.join(homeDir, '.local/share/tightbeam-chat');
  const releasesDir = path.join(root, 'releases');
  const currentLink = path.join(root, 'current');
  const previousLink = path.join(root, 'previous');
  const configPath = path.join(homeDir, '.config/tightbeam-chat/server.env');
  const unitPath = path.join(homeDir, '.config/systemd/user/tightbeam-chat.service');
  const packagedUnitPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packaging/tightbeam-chat.service');

  if (!(await exists(configPath))) throw new Error('The Chat server environment file is missing; no release was staged.');
  const packagedUnit = await fs.readFile(packagedUnitPath, 'utf8');
  const priorUnit = await exists(unitPath) ? await fs.readFile(unitPath, 'utf8') : undefined;
  if (priorUnit !== undefined && priorUnit !== packagedUnit) {
    throw new Error('The Chat service unit has local changes; no release was staged.');
  }
  if (priorUnit !== undefined && !(await serviceManager.isEnabled())) {
    throw new Error('The Chat service is not enabled; no release was staged.');
  }

  const priorCurrent = await linkTarget(currentLink, releasesDir);
  const priorPrevious = await linkTarget(previousLink, releasesDir);
  const priorIdentity = priorCurrent ? await readJson(path.join(priorCurrent, 'installed.json')) : undefined;
  if (priorCurrent && (!priorIdentity?.tag || !SHA_PATTERN.test(priorIdentity.sourceCommit ?? '') ||
      !HASH_PATTERN.test(priorIdentity.assetSha256 ?? ''))) {
    throw new Error('The current Chat version identity is missing; no update was attempted.');
  }
  const target = path.join(releasesDir, tag);
  await fs.mkdir(releasesDir, { recursive: true });

  let stagedHere = false;
  if (await exists(target)) {
    const installed = await readJson(path.join(target, 'installed.json'));
    if (installed?.tag !== tag || installed.sourceCommit !== verified.provenance.sourceCommit ||
        installed.assetSha256 !== verified.provenance.sha256) {
      throw new Error(`A different Chat bundle already occupies ${tag}; no current version was changed.`);
    }
    await validateStagedBundle(target, verified.provenance);
  } else {
    const stagingDir = await fs.mkdtemp(path.join(releasesDir, `.stage-${tag}-`));
    try {
      const archivePath = path.join(stagingDir, 'bundle.tar.gz');
      const unpackedDir = path.join(stagingDir, 'unpacked');
      await fs.mkdir(unpackedDir);
      await fs.writeFile(archivePath, verified.archiveBytes, { mode: 0o600 });
      inspectArchive(archivePath);
      runTar(['-xzf', archivePath, '--no-same-owner', '--no-same-permissions', '-C', unpackedDir]);
      await rejectSymlinks(unpackedDir);
      const packageDir = path.join(stagingDir, 'package');
      await fs.rename(unpackedDir, packageDir);
      await validateStagedBundle(packageDir, verified.provenance);
      await fs.writeFile(path.join(packageDir, 'installed.json'), `${JSON.stringify({
        tag,
        sourceCommit: verified.provenance.sourceCommit,
        assetSha256: verified.provenance.sha256,
      }, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(packageDir, target);
      stagedHere = true;
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  }

  const watcher = await inspectReleaseWatcher({ homeDir, releaseDir: target, serviceManager });

  if (priorCurrent === target) {
    if (priorUnit === undefined) throw new Error('The active Chat release has no managed service unit; no update was attempted.');
    await healthCheck({ tag, sourceCommit: verified.provenance.sourceCommit });
    if (!watcher.installed) {
      try {
        await installNewReleaseWatcher(watcher, serviceManager);
      } catch (error) {
        try {
          await removeNewReleaseWatcher(watcher, serviceManager);
        } catch (cleanupError) {
          const detail = cleanupError instanceof Error ? cleanupError.message : 'unknown watcher cleanup failure';
          throw new Error(`Chat is already current, but release watcher setup failed and cleanup was incomplete: ${detail}`);
        }
        throw new Error(`Chat is already current, but release watcher setup failed: ${error instanceof Error ? error.message : 'unknown watcher failure'}`);
      }
    }
    return {
      tag,
      sourceCommit: verified.provenance.sourceCommit,
      assetSha256: verified.provenance.sha256,
      unchanged: true,
      automaticUpdates: watcher.installed ? (watcher.timerEnabled ? 'enabled' : 'disabled') : 'enabled',
    };
  }

  const unitWasPresent = priorUnit !== undefined;
  const watcherWasInstalledHere = !watcher.installed;
  try {
    if (!unitWasPresent) await writeAtomic(unitPath, packagedUnit);
    if (watcherWasInstalledHere) {
      await writeAtomic(watcher.servicePath, watcher.packagedService);
      await writeAtomic(watcher.timerPath, watcher.packagedTimer);
    }
    await serviceManager.reload();
    if (!unitWasPresent) await serviceManager.enable();
    await atomicSymlink(currentLink, target);
    if (priorCurrent) await atomicSymlink(previousLink, priorCurrent);
    await serviceManager.restart();
    await healthCheck({ tag, sourceCommit: verified.provenance.sourceCommit });
    if (watcherWasInstalledHere) await serviceManager.enableWatchTimer();
  } catch (error) {
    let watcherRollbackError;
    if (watcherWasInstalledHere) {
      try {
        await removeNewReleaseWatcher(watcher, serviceManager);
      } catch (cleanupError) {
        watcherRollbackError = cleanupError instanceof Error ? cleanupError.message : 'unknown watcher cleanup failure';
      }
    }
    try {
      await rollbackAfterFailedActivation({
        currentLink,
        previousLink,
        priorCurrent,
        priorPrevious,
        unitPath,
        priorUnit,
        serviceManager,
        healthCheck,
        priorIdentity,
      });
    } catch (rollbackError) {
      const activation = error instanceof Error ? error.message : 'Chat activation failed.';
      const rollback = rollbackError instanceof Error ? rollbackError.message : 'unknown rollback failure';
      const watcherDetail = watcherRollbackError ? ` Release watcher cleanup also failed: ${watcherRollbackError}.` : '';
      if (!priorCurrent) {
        throw new Error(`${activation} No prior Chat release existed; first-install cleanup failed: ${rollback}.${watcherDetail} The candidate may still be running.`);
      }
      throw new Error(`${activation} Chat rollback failed: ${rollback}.${watcherDetail}`);
    }
    const activation = error instanceof Error ? error.message : 'Chat activation failed.';
    if (watcherRollbackError) {
      if (!priorCurrent) {
        throw new Error(`${activation} No prior Chat release existed; the Chat candidate was stopped and disabled, but watcher cleanup failed: ${watcherRollbackError}.`);
      }
      throw new Error(`${activation} The prior Chat version was restored, but release watcher cleanup failed: ${watcherRollbackError}.`);
    }
    if (!priorCurrent) {
      throw new Error(`${activation} No prior Chat release existed; the first-install candidate was stopped and disabled, and its active pointers and service unit were removed.`);
    }
    throw new Error(`${activation} The prior Chat version was restored.`);
  }

  return {
    tag,
    sourceCommit: verified.provenance.sourceCommit,
    assetSha256: verified.provenance.sha256,
    staged: stagedHere,
    unchanged: false,
    automaticUpdates: watcherWasInstalledHere ? 'enabled' : (watcher.timerEnabled ? 'enabled' : 'disabled'),
  };
}

export async function rollbackChatRelease({
  homeDir = os.homedir(),
  serviceManager = defaultServiceManager,
  healthCheck = defaultHealthCheck,
} = {}) {
  const root = path.join(homeDir, '.local/share/tightbeam-chat');
  const releasesDir = path.join(root, 'releases');
  const currentLink = path.join(root, 'current');
  const previousLink = path.join(root, 'previous');
  const unitPath = path.join(homeDir, '.config/systemd/user/tightbeam-chat.service');
  const configPath = path.join(homeDir, '.config/tightbeam-chat/server.env');
  const packagedUnitPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packaging/tightbeam-chat.service');
  const packagedUnit = await fs.readFile(packagedUnitPath, 'utf8');
  if (!(await exists(configPath))) throw new Error('The Chat server environment file is missing; no rollback was attempted.');
  if (!(await exists(unitPath)) || (await fs.readFile(unitPath, 'utf8')) !== packagedUnit || !(await serviceManager.isEnabled())) {
    throw new Error('The Chat service unit is missing or changed; no rollback was attempted.');
  }
  const priorCurrent = await linkTarget(currentLink, releasesDir);
  const priorPrevious = await linkTarget(previousLink, releasesDir);
  if (!priorCurrent || !priorPrevious) throw new Error('No verified prior Chat version is available for rollback.');

  const currentIdentity = await readJson(path.join(priorCurrent, 'installed.json'));
  const previousIdentity = await readJson(path.join(priorPrevious, 'installed.json'));
  if (!currentIdentity?.tag || !SHA_PATTERN.test(currentIdentity.sourceCommit ?? '') ||
      !HASH_PATTERN.test(currentIdentity.assetSha256 ?? '') || !previousIdentity?.tag ||
      !SHA_PATTERN.test(previousIdentity.sourceCommit ?? '') || !HASH_PATTERN.test(previousIdentity.assetSha256 ?? '')) {
    throw new Error('A Chat version identity is missing; no rollback was attempted.');
  }

  const previousHasWatcher = await exists(path.join(priorPrevious, 'bin/chat-release-watch.mjs'));
  const currentHasWatcher = await exists(path.join(priorCurrent, 'bin/chat-release-watch.mjs'));
  const watcherSource = currentHasWatcher ? priorCurrent : previousHasWatcher ? priorPrevious : undefined;
  const watcher = await inspectReleaseWatcher({
    homeDir,
    releaseDir: watcherSource,
    serviceManager,
    allowMissingRelease: true,
  });
  let watcherRemoved = false;
  if (!previousHasWatcher && watcher.installed) {
    try {
      if (watcher.timerEnabled) await serviceManager.disableWatchTimer();
      await serviceManager.stopWatchService();
      await fs.rm(watcher.servicePath, { force: true });
      await fs.rm(watcher.timerPath, { force: true });
      await serviceManager.reload();
      watcherRemoved = true;
    } catch (error) {
      try {
        await writeAtomic(watcher.servicePath, watcher.packagedService);
        await writeAtomic(watcher.timerPath, watcher.packagedTimer);
        await serviceManager.reload();
        if (watcher.timerEnabled) await serviceManager.enableWatchTimer();
      } catch (restoreError) {
        const detail = restoreError instanceof Error ? restoreError.message : 'unknown watcher restoration failure';
        throw new Error(`The release watcher could not be disabled for rollback and its previous state could not be restored: ${detail}`);
      }
      throw new Error(`The release watcher could not be disabled for rollback: ${error instanceof Error ? error.message : 'unknown watcher error'}`);
    }
  }

  let watcherInstalledHere = false;
  try {
    await atomicSymlink(currentLink, priorPrevious);
    await atomicSymlink(previousLink, priorCurrent);
    await serviceManager.reload();
    await serviceManager.restart();
    await healthCheck({ tag: previousIdentity.tag, sourceCommit: previousIdentity.sourceCommit });
    if (previousHasWatcher && !watcher.installed) {
      watcherInstalledHere = true;
      await installNewReleaseWatcher(watcher, serviceManager);
    }
  } catch (error) {
    try {
      await restoreSymlink(currentLink, priorCurrent);
      await restoreSymlink(previousLink, priorPrevious);
    } catch (restoreError) {
      const detail = restoreError instanceof Error ? restoreError.message : 'unknown pointer restoration failure';
      throw new Error(`Chat rollback failed and its active pointers could not be restored: ${detail}`);
    }
    let watcherRestoreError;
    if (watcherInstalledHere) {
      try {
        await removeNewReleaseWatcher(watcher, serviceManager);
      } catch (cleanupError) {
        watcherRestoreError = cleanupError instanceof Error ? cleanupError.message : 'unknown watcher cleanup failure';
      }
    }
    if (watcherRemoved) {
      try {
        await writeAtomic(watcher.servicePath, watcher.packagedService);
        await writeAtomic(watcher.timerPath, watcher.packagedTimer);
        await serviceManager.reload();
        if (watcher.timerEnabled) await serviceManager.enableWatchTimer();
      } catch {
        throw new Error('Chat rollback failed and the release watcher could not be restored.');
      }
    }
    try {
      await serviceManager.restart();
      await healthCheck({ tag: currentIdentity.tag, sourceCommit: currentIdentity.sourceCommit });
    } catch {
      throw new Error('Chat rollback failed and the current Chat service could not be restored.');
    }
    if (watcherRestoreError) {
      throw new Error(`${error instanceof Error ? error.message : 'Chat rollback failed.'} The current Chat version was restored, but watcher cleanup failed: ${watcherRestoreError}.`);
    }
    throw new Error(`${error instanceof Error ? error.message : 'Chat rollback failed.'} The current Chat version was restored.`);
  }
  return {
    tag: previousIdentity.tag,
    sourceCommit: previousIdentity.sourceCommit,
    automaticUpdates: previousHasWatcher && (watcher.installed ? watcher.timerEnabled : true) ? 'enabled' : 'disabled',
  };
}
