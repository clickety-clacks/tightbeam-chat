import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { updateToLatestChatRelease } from '../scripts/chat-release-watch.mjs';

const LATEST_URL = 'https://api.github.com/repos/clickety-clacks/tightbeam-chat/releases/latest';

function release(tag, overrides = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: '2026-10-16T00:00:00Z',
    ...overrides,
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function installedHome(tag = 'v0.1.1', previousTag) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-release-watch-'));
  const root = path.join(homeDir, '.local/share/tightbeam-chat');
  const identityPath = path.join(root, 'current/installed.json');
  await fs.mkdir(path.dirname(identityPath), { recursive: true });
  await fs.writeFile(identityPath, JSON.stringify({ tag }));
  if (previousTag) {
    const previousRelease = path.join(root, 'releases', previousTag);
    await fs.mkdir(previousRelease, { recursive: true });
    await fs.writeFile(path.join(previousRelease, 'installed.json'), JSON.stringify({ tag: previousTag }));
    await fs.symlink(path.relative(root, previousRelease), path.join(root, 'previous'));
  }
  return homeDir;
}

test('routes a newer published tag through the existing checksum-verifying updater', async () => {
  const homeDir = await installedHome();
  const requests = [];
  const invocations = [];
  const result = await updateToLatestChatRelease({
    homeDir,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(release('v0.1.2'));
    },
    runUpdater: async (...args) => invocations.push(args),
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, LATEST_URL);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.authorization, undefined);
  assert.deepEqual(invocations, [[
    process.execPath,
    [
      path.join(homeDir, '.local/share/tightbeam-chat/current/bin/update-chat-release.mjs'),
      'install',
      'v0.1.2',
    ],
  ]]);
  assert.deepEqual(result, { action: 'updated', installedTag: 'v0.1.1', latestTag: 'v0.1.2' });
});

test('does not reinstall the current release or downgrade to an older published tag', async () => {
  for (const [tag, action, previousTag] of [
    ['v0.1.1', 'already-current'],
    ['v0.1.2', 'rollback-preserved', 'v0.1.2'],
    ['v0.1.0', 'installed-newer-than-latest'],
  ]) {
    const homeDir = await installedHome('v0.1.1', previousTag);
    let invoked = false;
    const result = await updateToLatestChatRelease({
      homeDir,
      fetchImpl: async () => response(release(tag)),
      runUpdater: async () => { invoked = true; },
    });
    assert.equal(invoked, false);
    assert.equal(result.action, action);
  }
});

test('refuses unpublished, prerelease, malformed, or failed latest-release lookups without invoking the updater', async () => {
  const scenarios = [
    { body: release('v0.1.2', { draft: true }) },
    { body: release('v0.1.2', { prerelease: true }) },
    { body: release('branch-name') },
    { body: release('v0.1.2', { published_at: '' }) },
  ];
  for (const scenario of scenarios) {
    const homeDir = await installedHome();
    let invoked = false;
    await assert.rejects(updateToLatestChatRelease({
      homeDir,
      fetchImpl: async () => response(scenario.body),
      runUpdater: async () => { invoked = true; },
    }));
    assert.equal(invoked, false);
  }

  const homeDir = await installedHome();
  let invoked = false;
  await assert.rejects(updateToLatestChatRelease({
    homeDir,
    fetchImpl: async () => response({}, 503),
    runUpdater: async () => { invoked = true; },
  }), /HTTP 503/);
  assert.equal(invoked, false);
});

test('fails closed if the installed Chat release identity is unavailable or invalid', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-release-watch-missing-'));
  let invoked = false;
  await assert.rejects(updateToLatestChatRelease({
    homeDir,
    fetchImpl: async () => response(release('v0.1.2')),
    runUpdater: async () => { invoked = true; },
  }), /identity is unavailable/);
  assert.equal(invoked, false);

  const invalidHome = await installedHome('latest');
  await assert.rejects(updateToLatestChatRelease({
    homeDir: invalidHome,
    fetchImpl: async () => response(release('v0.1.2')),
    runUpdater: async () => { invoked = true; },
  }), /identity is invalid/);
  assert.equal(invoked, false);
});

test('holds an activation-failed tag on the next poll while leaving a newer release available', async () => {
  const homeDir = await installedHome('v0.1.1', 'v0.1.0');
  const identityPath = path.join(homeDir, '.local/share/tightbeam-chat/current/installed.json');
  const failedTagPath = path.join(homeDir, '.local/share/tightbeam-chat/automatic-update-failed-tag');
  const updaterPath = path.join(homeDir, '.local/share/tightbeam-chat/current/bin/update-chat-release.mjs');
  const attemptsPath = path.join(homeDir, 'updater-attempts.txt');
  let updaterInvocations = 0;
  await fs.mkdir(path.dirname(updaterPath), { recursive: true });
  await fs.writeFile(updaterPath, [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(attemptsPath)}, 'attempt\\n');`,
    "process.stderr.write('The prior Chat version was restored.\\n');",
    'process.exitCode = 1;',
  ].join('\n'));

  await assert.rejects(updateToLatestChatRelease({
    homeDir,
    fetchImpl: async () => response(release('v0.1.2')),
  }), /prior Chat version was restored/);

  assert.equal(await fs.readFile(failedTagPath, 'utf8'), 'v0.1.2\n');
  assert.equal(JSON.parse(await fs.readFile(identityPath, 'utf8')).tag, 'v0.1.1');

  const held = await updateToLatestChatRelease({
    homeDir,
    fetchImpl: async () => response(release('v0.1.2')),
  });
  assert.deepEqual(held, { action: 'failed-release-held', installedTag: 'v0.1.1', latestTag: 'v0.1.2' });
  assert.equal((await fs.readFile(attemptsPath, 'utf8')).trim().split('\n').length, 1);
  assert.equal(JSON.parse(await fs.readFile(identityPath, 'utf8')).tag, 'v0.1.1');

  const newer = await updateToLatestChatRelease({
    homeDir,
    fetchImpl: async () => response(release('v0.1.3')),
    runUpdater: async () => {
      updaterInvocations += 1;
      await fs.writeFile(identityPath, JSON.stringify({ tag: 'v0.1.3' }));
    },
  });
  assert.deepEqual(newer, { action: 'updated', installedTag: 'v0.1.1', latestTag: 'v0.1.3' });
  assert.equal(updaterInvocations, 1);
  assert.equal(JSON.parse(await fs.readFile(identityPath, 'utf8')).tag, 'v0.1.3');
});

test('allows an explicit retry of the held published tag', async () => {
  const homeDir = await installedHome('v0.1.1', 'v0.1.0');
  const identityPath = path.join(homeDir, '.local/share/tightbeam-chat/current/installed.json');
  let updaterInvocations = 0;

  await assert.rejects(updateToLatestChatRelease({
    homeDir,
    fetchImpl: async () => response(release('v0.1.2')),
    runUpdater: async () => {
      updaterInvocations += 1;
      throw new Error('The prior Chat version was restored.');
    },
  }), /prior Chat version was restored/);

  const retried = await updateToLatestChatRelease({
    homeDir,
    fetchImpl: async () => response(release('v0.1.2')),
    retryFailed: true,
    runUpdater: async () => {
      updaterInvocations += 1;
      await fs.writeFile(identityPath, JSON.stringify({ tag: 'v0.1.2' }));
    },
  });
  assert.deepEqual(retried, { action: 'updated', installedTag: 'v0.1.1', latestTag: 'v0.1.2' });
  assert.equal(updaterInvocations, 2);
});

test('does not hold a tag when the updater failure did not restore the prior release', async () => {
  const homeDir = await installedHome('v0.1.1', 'v0.1.0');
  const failedTagPath = path.join(homeDir, '.local/share/tightbeam-chat/automatic-update-failed-tag');
  let updaterInvocations = 0;
  const update = () => updateToLatestChatRelease({
    homeDir,
    fetchImpl: async () => response(release('v0.1.2')),
    runUpdater: async () => {
      updaterInvocations += 1;
      throw new Error('Temporary download failure.');
    },
  });

  await assert.rejects(update(), /Temporary download failure/);
  await assert.rejects(fs.readFile(failedTagPath, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(update(), /Temporary download failure/);
  assert.equal(updaterInvocations, 2);
});

test('runs the watcher when the service starts it through the current-release symlink', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-release-watch-symlink-'));
  try {
    const installRoot = path.join(homeDir, '.local/share/tightbeam-chat');
    const releaseRoot = path.join(installRoot, 'releases/v0.1.2');
    const releaseBin = path.join(releaseRoot, 'bin');
    await fs.mkdir(releaseBin, { recursive: true });
    await fs.writeFile(path.join(releaseRoot, 'installed.json'), JSON.stringify({ tag: 'v0.1.2' }));
    await fs.copyFile(
      fileURLToPath(new URL('../scripts/chat-release-watch.mjs', import.meta.url)),
      path.join(releaseBin, 'chat-release-watch.mjs'),
    );
    await fs.symlink(path.relative(installRoot, releaseRoot), path.join(installRoot, 'current'), 'dir');

    const fetchMarker = path.join(homeDir, 'latest-release-requested.txt');
    const preloadPath = path.join(homeDir, 'mock-latest-release.mjs');
    await fs.writeFile(preloadPath, [
      "import { writeFileSync } from 'node:fs';",
      `globalThis.fetch = async (url) => {`,
      `  if (url !== ${JSON.stringify(LATEST_URL)}) throw new Error('Unexpected release URL.');`,
      `  writeFileSync(${JSON.stringify(fetchMarker)}, String(url));`,
      "  return { ok: true, json: async () => ({ tag_name: 'v0.1.2', draft: false, prerelease: false, published_at: '2026-10-16T00:00:00Z' }) };",
      '};',
    ].join('\n'));

    const invokedPath = path.join(installRoot, 'current/bin/chat-release-watch.mjs');
    const child = spawnSync(process.execPath, ['--import', preloadPath, invokedPath], {
      cwd: homeDir,
      env: { HOME: homeDir, USERPROFILE: homeDir, PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '{"action":"already-current","installedTag":"v0.1.2","latestTag":"v0.1.2"}\n');
    assert.equal(child.stderr, '');
    assert.equal(await fs.readFile(fetchMarker, 'utf8'), LATEST_URL);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
