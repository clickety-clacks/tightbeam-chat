import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkReleaseStatement,
  detectBreakingChanges,
  previousReleaseTag,
  readChatContract,
  releaseStatement,
} from '../scripts/chat-release-contract.mjs';

const root = process.cwd();
const read = file => fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : '';
const sources = () => fs.readdirSync(path.join(root, 'src'), { recursive: true }).map(file => `src/${file}`)
  .filter(file => /\.tsx?$/.test(file));

const contract = {
  supportedVersions: ['0.1.16'],
  envKeys: ['CHAT_PUBLIC_ORIGIN'],
  routes: ['/__chat/version'],
  storageKeys: ['tb-chat.key'],
  storageWrites: ["KEY, '1'"],
};
const entry = fields => [{ version: 'v1.0.1', items: [], ...fields }];
const stated = entry({ compatibleTightbeam: ['0.1.16'], breakingChanges: 'none' });

const temporary = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('release contract', () => {
  // Pinned so that a removed route or key shows up here, and an extractor that stops seeing them does too.
  it('reads the current source', () => {
    const current = readChatContract(read, sources());
    expect(current.supportedVersions).toEqual(['0.1.16']);
    expect(current.routes).toEqual([
      '/__chat/agent/dispatch', '/__chat/gateway/version', '/__chat/summaries', '/__chat/upload',
      '/__chat/version', '/__chat/ws', '/__chat/ws/changes', '/__chat/ws/work-changes',
    ]);
    expect(current.envKeys).toEqual(expect.arrayContaining([
      'CHAT_DEFAULT_GATEWAY_ORIGIN', 'CHAT_GATEWAY_MAP_FILE', 'CHAT_PUBLIC_ORIGIN', 'CHAT_REST_HUMAN_SEND',
      'CHAT_SUMMARY_DATA_DIR',
    ]));
    expect(current.storageKeys).toEqual([
      'tb-chat-work-items-hidden', 'tb-chat:dismissed-prompt:',
      'tightbeam-chat.release-notes.seen-version', 'tightbeam-chat.submitter.display-name',
    ]);
    expect(current.storageWrites.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses to compare when it can no longer find something', () => {
    expect(() => readChatContract(() => '', [])).toThrow('found no supportedVersions');
  });

  it('finds nothing in an unchanged or merely extended contract', () => {
    const extended = Object.fromEntries(Object.entries(contract).map(([name, values]) => [name, [...values]]));
    extended.supportedVersions.push('0.1.17');
    extended.envKeys.push('CHAT_NEW');
    extended.routes.push('/__chat/new');
    expect(detectBreakingChanges(contract, contract)).toEqual([]);
    expect(detectBreakingChanges(contract, extended)).toEqual([]);
  });

  it.each([
    ['supportedVersions', ['0.1.17'], 'oldest supported Tightbeam rises from 0.1.16 to 0.1.17'],
    ['envKeys', ['CHAT_RENAMED'], 'CHAT_PUBLIC_ORIGIN is removed or renamed'],
    ['routes', ['/__chat/renamed'], '/__chat/version is removed or renamed'],
    ['storageKeys', ['tb-chat.renamed'], 'tb-chat.key is removed or renamed'],
    ['storageWrites', ["KEY, JSON.stringify({ hidden: true })"], 'stored browser value'],
  ])('refuses "none" when %s changes incompatibly', (name, values, finding) => {
    const current = { ...contract, [name]: values };
    expect(() => checkReleaseStatement(stated, 'v1.0.1', contract, current)).toThrow(finding);
    const declared = entry({ compatibleTightbeam: ['0.1.16'], breakingChanges: ['Reinstall the setting.'] });
    expect(checkReleaseStatement(declared, 'v1.0.1', contract, current).lines)
      .toEqual(['Compatible with Tightbeam: 0.1.16', '', 'Breaking changes:', '- Reinstall the setting.']);
  });

  it.each([
    [{ breakingChanges: 'none' }, 'compatibleTightbeam'],
    [{ compatibleTightbeam: [], breakingChanges: 'none' }, 'compatibleTightbeam'],
    [{ compatibleTightbeam: ['latest'], breakingChanges: 'none' }, 'compatibleTightbeam'],
    [{ compatibleTightbeam: ['0.1.16'] }, 'breakingChanges'],
    [{ compatibleTightbeam: ['0.1.16'], breakingChanges: [] }, 'breakingChanges'],
    [{ compatibleTightbeam: ['0.1.16'], breakingChanges: ['None'] }, 'breakingChanges'],
  ])('requires both statements (%j)', (fields, missing) => {
    expect(() => releaseStatement(entry(fields), 'v1.0.1')).toThrow(missing);
  });

  it('compares with the newest older release tag', () => {
    expect(previousReleaseTag(['v0.1.9', 'v0.1.10', 'v0.1.11', 'v0.2.0', 'nightly'], 'v0.1.11')).toBe('v0.1.10');
    expect(previousReleaseTag(['v1.0.0'], 'v1.0.0')).toBeUndefined();
  });

  it('fails the tag job without a true statement confirmed for exactly what is released', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-release-contract-'));
    temporary.push(repo);
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    };
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
      { cwd: repo, encoding: 'utf8' }).trim();
    for (const file of ['assert-chat-release-ref.mjs', 'chat-release-notes.mjs', 'chat-release-contract.mjs']) {
      write(`scripts/${file}`, read(`scripts/${file}`));
    }
    write('scripts/package-chat-release.mjs', "const c = { supportedVersions: ['0.1.16'] };\n");
    write('server/chat-server.mjs', "environment.CHAT_PUBLIC_ORIGIN; '/__chat/version'; '/__chat/upload';\n");
    write('src/store.ts', "const SEEN_KEY = 'seen'; localStorage.setItem(SEEN_KEY, value);\n");
    const commit = message => {
      git('add', '-A');
      git('commit', '-qm', message, '--allow-empty');
      return git('rev-parse', 'HEAD');
    };
    // The notes are committed, then the reviewer's confirmation of that commit, then whatever `after` adds.
    const release = (tag, fields, { review = reviewed => ({ reviewer: 'reviewer', commit: reviewed, result: 'confirmed' }),
      after } = {}) => {
      const entry = { version: tag, items: [{ title: 'T', description: 'D' }], ...fields };
      write('src/release-notes.json', JSON.stringify([entry]));
      const reviewed = commit(`${tag} notes`);
      const confirmation = review?.(reviewed);
      if (confirmation) write('src/release-notes.json', JSON.stringify([{ ...entry, breakingChangesReview: confirmation }]));
      commit(`${tag} confirmation`);
      after?.(entry, confirmation);
      git('tag', '-f', tag);
      return spawnSync(process.execPath, ['scripts/assert-chat-release-ref.mjs'], { cwd: repo, encoding: 'utf8', env: {
        ...process.env, GITHUB_REPOSITORY: 'clickety-clacks/tightbeam-chat', GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: tag, GITHUB_REF: `refs/tags/${tag}`, GITHUB_SHA: git('rev-parse', 'HEAD'),
      } });
    };
    git('init', '-q');
    const good = { compatibleTightbeam: ['0.1.16'], breakingChanges: 'none' };
    release('v1.0.0', good);
    expect(release('v1.0.1', good).status).toBe(0);
    expect(release('v1.0.2', {}).stderr).toContain('compatibleTightbeam');
    expect(release('v1.0.2', good, { review: null }).stderr).toContain('needs "breakingChangesReview"');
    expect(release('v1.0.2', good, { review: sha => ({ reviewer: 'reviewer', commit: sha, result: 'changes' }) }).stderr)
      .toContain('needs "breakingChangesReview"');
    expect(release('v1.0.2', good, { review: () => ({ reviewer: 'reviewer', commit: 'f'.repeat(40), result: 'confirmed' }) })
      .stderr).toContain('is not part of v1.0.2');
    const laterCode = release('v1.0.2', good, { after: () => {
      write('src/store.ts', "const SEEN_KEY = 'seen'; localStorage.setItem(SEEN_KEY, value); // later\n");
      commit('later code');
    } });
    expect(laterCode.stderr).toContain('changed after the review');
    expect(laterCode.stderr).toContain('src/store.ts');
    const laterNotes = release('v1.0.2', good, { after: (entry, confirmation) => {
      write('src/release-notes.json', JSON.stringify([{ ...entry, compatibleTightbeam: ['0.1.15'],
        breakingChangesReview: confirmation }]));
      commit('later notes');
    } });
    expect(laterNotes.stderr).toContain('changed after the review');
    write('server/chat-server.mjs', "environment.CHAT_PUBLIC_ORIGIN; '/__chat/version';\n");
    const wrong = release('v1.0.3', good);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('/__chat/upload is removed or renamed');
  });
});
