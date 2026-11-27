// The compatibility line is what passed, not what was typed: every version in the support window must
// have passed, and the notes and the package must claim exactly those.
import fs from 'node:fs';
import path from 'node:path';
import { releaseStatement } from '../chat-release-contract.mjs';

export function readLatestCompatibilityResults(resultsDir) {
  const latest = new Map();
  for (const entry of fs.readdirSync(resultsDir, { withFileTypes: true })) {
    const match = /^compat-(\d+\.\d+\.\d+)-run-attempt-([1-9]\d*)$/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const [, version, attemptText] = match;
    const attempt = Number(attemptText);
    if (attempt > (latest.get(version)?.attempt ?? 0)) {
      latest.set(version, { attempt, directory: entry.name });
    }
  }
  return [...latest].map(([version, { directory }]) => {
    const result = JSON.parse(fs.readFileSync(path.join(resultsDir, directory, 'result.json'), 'utf8'));
    if (result.version !== version) throw new Error(`Compatibility artifact version mismatch: ${directory}.`);
    return result;
  });
}

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
  const results = readLatestCompatibilityResults(resultsDir);
  const supportedVersions = JSON.parse(fs.readFileSync(path.join(releaseDir, 'release.json'), 'utf8'))
    .gatewayCompatibility.supportedVersions;
  const line = verifyCompatibility({ window: JSON.parse(process.env.SUPPORT_WINDOW), results, tag, supportedVersions,
    entries: JSON.parse(fs.readFileSync('src/release-notes.json', 'utf8')) });
  process.stdout.write(`${line}\n`);
}
