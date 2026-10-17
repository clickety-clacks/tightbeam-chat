import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_URL = 'https://api.github.com/repos/clickety-clacks/tightbeam-chat/releases/latest';
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const RESTORED_PRIOR_RELEASE = 'The prior Chat version was restored.';

function failedTagPath(homeDir) {
  return path.join(homeDir, '.local/share/tightbeam-chat/automatic-update-failed-tag');
}

function invokeUpdater(executable, arguments_) {
  const result = spawnSync(executable, arguments_, {
    encoding: 'utf8',
    stdio: ['inherit', 'inherit', 'pipe'],
  });
  if (result.error) throw result.error;

  const stderr = String(result.stderr ?? '');
  if (result.status === 0) {
    if (stderr) process.stderr.write(stderr);
    return;
  }
  const message = stderr.trim() || `Chat release updater failed (${result.signal ?? result.status ?? 'unknown status'}).`;
  const error = new Error(message);
  error.recoveredPriorRelease = stderr.includes(RESTORED_PRIOR_RELEASE);
  throw error;
}

async function readFailedTag(homeDir) {
  let value;
  try {
    value = await fs.readFile(failedTagPath(homeDir), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  const tag = value.endsWith('\n') ? value.slice(0, -1) : value;
  if (!TAG_PATTERN.test(tag)) {
    throw new Error('The automatic Chat update failure record is invalid; no update was attempted.');
  }
  parseVersion(tag);
  return tag;
}

async function writeFailedTag(homeDir, tag) {
  const filename = failedTagPath(homeDir);
  const directory = path.dirname(filename);
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, `${tag}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function reportsRecoveredPriorRelease(error) {
  return error?.recoveredPriorRelease === true ||
    (typeof error?.message === 'string' && error.message.includes(RESTORED_PRIOR_RELEASE));
}

function parseVersion(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? '');
  if (!match) throw new Error('GitHub latest Chat release did not have a valid version tag.');
  const version = match.slice(1).map(Number);
  if (version.some((part) => !Number.isSafeInteger(part))) {
    throw new Error('GitHub latest Chat release version was outside the supported range.');
  }
  return version;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

async function fetchLatestRelease(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new Error('A Chat release lookup transport is required.');
  const response = await fetchImpl(API_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'tightbeam-chat-release-watch',
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Latest Chat release lookup returned HTTP ${response.status}.`);

  let release;
  try {
    release = await response.json();
  } catch {
    throw new Error('Latest Chat release lookup returned invalid JSON.');
  }
  if (release?.draft !== false || release?.prerelease !== false ||
      typeof release?.published_at !== 'string' || !release.published_at) {
    throw new Error('Latest Chat release is not a published stable release.');
  }
  parseVersion(release.tag_name);
  return release.tag_name;
}

async function readInstalledTag(homeDir) {
  const identityPath = path.join(homeDir, '.local/share/tightbeam-chat/current/installed.json');
  let identity;
  try {
    identity = JSON.parse(await fs.readFile(identityPath, 'utf8'));
  } catch {
    throw new Error('The installed Chat release identity is unavailable; no automatic update was attempted.');
  }
  if (!TAG_PATTERN.test(identity?.tag ?? '')) {
    throw new Error('The installed Chat release identity is invalid; no automatic update was attempted.');
  }
  parseVersion(identity.tag);
  return identity.tag;
}

async function readPreviousTag(homeDir) {
  const previousPath = path.join(homeDir, '.local/share/tightbeam-chat/previous');
  let info;
  try {
    info = await fs.lstat(previousPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isSymbolicLink()) throw new Error('The previous Chat release pointer is invalid; no automatic update was attempted.');
  let identity;
  try {
    identity = JSON.parse(await fs.readFile(path.join(previousPath, 'installed.json'), 'utf8'));
  } catch {
    throw new Error('The previous Chat release identity is unavailable; no automatic update was attempted.');
  }
  if (!TAG_PATTERN.test(identity?.tag ?? '')) {
    throw new Error('The previous Chat release identity is invalid; no automatic update was attempted.');
  }
  parseVersion(identity.tag);
  return identity.tag;
}

export async function updateToLatestChatRelease({
  fetchImpl = globalThis.fetch,
  homeDir = os.homedir(),
  runUpdater = invokeUpdater,
  retryFailed = false,
} = {}) {
  const latestTag = await fetchLatestRelease(fetchImpl);
  const installedTag = await readInstalledTag(homeDir);
  const previousTag = await readPreviousTag(homeDir);
  const comparison = compareVersions(latestTag, installedTag);
  if (comparison === 0) return { action: 'already-current', installedTag, latestTag };
  if (comparison > 0 && latestTag === previousTag) {
    return { action: 'rollback-preserved', installedTag, latestTag };
  }
  if (comparison < 0) return { action: 'installed-newer-than-latest', installedTag, latestTag };

  const failedTag = await readFailedTag(homeDir);
  if (!retryFailed && failedTag === latestTag) {
    return { action: 'failed-release-held', installedTag, latestTag };
  }

  const updaterPath = path.join(homeDir, '.local/share/tightbeam-chat/current/bin/update-chat-release.mjs');
  try {
    await runUpdater(process.execPath, [updaterPath, 'install', latestTag]);
  } catch (error) {
    if (reportsRecoveredPriorRelease(error)) {
      try {
        await writeFailedTag(homeDir, latestTag);
      } catch (recordError) {
        const detail = recordError instanceof Error ? recordError.message : 'unknown state-write failure';
        throw new Error(`Chat restored its prior release, but could not record the failed tag to stop automatic retries: ${detail}`, { cause: error });
      }
    }
    throw error;
  }
  return { action: 'updated', installedTag, latestTag };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== '--retry-failed') || args.length > 1) {
    throw new Error('Usage: chat-release-watch.mjs [--retry-failed]');
  }
  const result = await updateToLatestChatRelease({ retryFailed: args.includes('--retry-failed') });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function isInvokedAsMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedAsMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Chat automatic update failed.'}\n`);
    process.exitCode = 1;
  });
}
