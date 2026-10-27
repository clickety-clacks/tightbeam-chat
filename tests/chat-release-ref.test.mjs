import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const releaseRefScript = path.resolve(process.cwd(), 'scripts/assert-chat-release-ref.mjs');
const repository = 'clickety-clacks/tightbeam-chat';
const fixtures = [];

async function taggedFixture(tag) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-release-ref-'));
  fixtures.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'chat-release-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Chat Release Test'], { cwd: root });
  await fs.writeFile(path.join(root, 'source.txt'), 'release source\n');
  execFileSync('git', ['add', 'source.txt'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'Create release source'], { cwd: root });
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('git', ['tag', tag], { cwd: root });
  return { root, sourceCommit, tag };
}

function runReleaseCheck({ root, sourceCommit, tag, repositoryName = repository, sha = sourceCommit }) {
  return spawnSync(process.execPath, [releaseRefScript], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: root,
      GITHUB_REPOSITORY: repositoryName,
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF: `refs/tags/${tag}`,
      GITHUB_REF_NAME: tag,
      GITHUB_SHA: sha,
    },
  });
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fs.rm(fixture, { recursive: true, force: true });
});

describe('release tag validation', () => {
  it('warns and continues when the release has no user-facing note entry', async () => {
    const fixture = await taggedFixture('v99.99.99');

    const result = runReleaseCheck(fixture);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Verified Chat release ${fixture.tag} at ${fixture.sourceCommit}.`);
    expect(result.stderr).toContain('Warning: no user-facing release note entry exists');
    expect(result.stderr).toContain("What's New will not appear.");
  });

  it('continues to reject a tag whose source commit differs from the workflow commit', async () => {
    const fixture = await taggedFixture('v99.99.99');

    const result = runReleaseCheck({ ...fixture, sha: '0'.repeat(40) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('The release tag and workflow source commit differ.');
    expect(result.stderr).not.toContain('Warning: no user-facing release note entry exists');
  });
});
