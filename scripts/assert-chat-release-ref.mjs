import { execFileSync } from 'node:child_process';

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

process.stdout.write(`Verified Chat release ${tag} at ${sourceCommit}.\n`);
