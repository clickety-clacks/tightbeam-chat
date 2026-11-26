import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { hasUserFacingNotesForTag } from './chat-release-notes.mjs';
import {
  checkBreakingChangesReview,
  checkReleaseStatement,
  previousReleaseTag,
  readChatContract,
} from './chat-release-contract.mjs';

const tag = process.env.GITHUB_REF_NAME ?? '';
const sourceCommit = process.env.GITHUB_SHA ?? '';
const repository = process.env.GITHUB_REPOSITORY ?? '';

if (repository !== 'clickety-clacks/tightbeam-chat' || process.env.GITHUB_REF_TYPE !== 'tag' ||
    process.env.GITHUB_REF !== `refs/tags/${tag}` || !/^v\d+\.\d+\.\d+$/.test(tag) ||
    !/^[a-f0-9]{40}$/.test(sourceCommit)) {
  process.stderr.write('This release job requires an exact Chat version tag and full source commit.\n');
  process.exit(1);
}

let taggedCommit;
try {
  taggedCommit = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
} catch {
  process.stderr.write('The release tag does not resolve to a source commit.\n');
  process.exit(1);
}
if (taggedCommit !== sourceCommit) {
  process.stderr.write('The release tag and workflow source commit differ.\n');
  process.exit(1);
}

let releaseNotes;
try {
  releaseNotes = JSON.parse(await fs.readFile(new URL('../src/release-notes.json', import.meta.url), 'utf8'));
} catch {
  process.stderr.write('Chat release notes are missing or invalid.\n');
  process.exit(1);
}
if (!hasUserFacingNotesForTag(releaseNotes, tag)) {
  process.stderr.write('This Chat version needs user-facing release notes before release staging.\n');
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const contractAt = ref => {
  const files = git('ls-tree', '-r', '--name-only', ref).split('\n');
  const present = new Set(files);
  return readChatContract(file => present.has(file) ? git('show', `${ref}:${file}`) : '',
    files.filter(file => file.startsWith('src/')));
};
try {
  const previous = previousReleaseTag(git('tag', '--list', 'v*').split('\n'), tag);
  if (!previous) throw new Error('No previous release tag to compare with.');
  checkReleaseStatement(releaseNotes, tag, contractAt(previous), contractAt(sourceCommit));
  checkBreakingChangesReview(releaseNotes, tag, {
    isAncestor: commit => {
      try { git('merge-base', '--is-ancestor', commit, sourceCommit); return true; } catch { return false; }
    },
    changedFiles: commit => git('diff', '--name-only', commit, sourceCommit).split('\n').filter(Boolean),
    entriesAt: commit => JSON.parse(git('show', `${commit}:src/release-notes.json`)),
  });
  process.stdout.write(`Checked compatibility and breaking-change statements against ${previous}.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Release statement check failed.'}\n`);
  process.exit(1);
}

process.stdout.write(`Verified Chat release ${tag} at ${sourceCommit}.\n`);
