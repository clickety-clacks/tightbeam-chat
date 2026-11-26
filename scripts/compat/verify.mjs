// The compatibility line is what passed, not what was typed: every version in the support window must
// have passed, and the notes and the package must claim exactly those.
import fs from 'node:fs';
import path from 'node:path';
import { releaseStatement } from '../chat-release-contract.mjs';

export function verifyCompatibility({ window, results, entries, tag, supportedVersions }) {
  const passed = window.filter(({ version }) => results.some(result => result.version === version && result.passed))
    .map(({ version }) => version);
  const failed = window.filter(({ version }) => !passed.includes(version)).map(({ version }) => version);
  if (failed.length) throw new Error(`Chat did not pass against Tightbeam ${failed.join(', ')}.`);
  const statement = releaseStatement(entries, tag, supportedVersions);
  const line = `Compatible with Tightbeam: ${passed.join(', ')}`;
  if (statement.lines[0] !== line) {
    throw new Error(`The notes say "${statement.lines[0]}", but what passed gives "${line}".`);
  }
  return line;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').at(-1))) {
  const [resultsDir, releaseDir, tag] = process.argv.slice(2);
  const results = fs.readdirSync(resultsDir, { recursive: true }).filter(file => file.endsWith('result.json'))
    .map(file => JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8')));
  const supportedVersions = JSON.parse(fs.readFileSync(path.join(releaseDir, 'release.json'), 'utf8'))
    .gatewayCompatibility.supportedVersions;
  const line = verifyCompatibility({ window: JSON.parse(process.env.SUPPORT_WINDOW), results, tag, supportedVersions,
    entries: JSON.parse(fs.readFileSync('src/release-notes.json', 'utf8')) });
  process.stdout.write(`${line}\n`);
}
