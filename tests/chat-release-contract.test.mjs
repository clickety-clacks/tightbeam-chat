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
  STORED_VALUES_THROUGH_V0_1_114,
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
  storedValues: [{ key: 'tb-chat.key', value: '1' }],
};
const entry = fields => [{ version: 'v1.0.1', items: [], ...fields }];
const stated = entry({ compatibleTightbeam: ['0.1.16'], breakingChanges: 'none' });

const temporary = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('release contract', () => {
  // Pinned so that a removed route or key shows up here, and an extractor that stops seeing them does too.
  it('reads the current source', () => {
    const current = readChatContract(read, sources());
    expect(current.supportedVersions).toEqual(['0.1.15', '0.1.16']);
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
    // Every key the source declares has a stored value held true by the browser storage test.
    for (const key of current.storageKeys) {
      expect(current.storedValues.some(item => item.key.startsWith(key))).toBe(true);
    }
  });

  it('refuses to compare when it can no longer find something', () => {
    expect(() => readChatContract(() => '', [])).toThrow('found no supportedVersions');
  });

  it('ignores names that survive only in comments', () => {
    const files = {
      'scripts/package-chat-release.mjs': "const c = { supportedVersions: ['0.1.16'] };",
      'server/chat-server.mjs': "environment.CHAT_KEPT; '/__chat/kept'; accept: '*/*';\n" +
        "// environment.CHAT_GONE; '/__chat/gone'\n/* '/__chat/also-gone' */\n",
      'src/a.ts': "const A_KEY = 'kept';\n  // const B_KEY = 'gone';\n",
    };
    files['server/chat-server.mjs'] += "run();/* environment.CHAT_INLINE; '/__chat/inline' */";
    expect(readChatContract(file => files[file] ?? '', ['src/a.ts'])).toMatchObject({
      envKeys: ['CHAT_KEPT'], routes: ['/__chat/kept'], storageKeys: ['kept'],
    });
  });

  it('compares the first gated release with the values v0.1.114 left in browsers', () => {
    // A tree that stores what v0.1.114 stored; independent of later, declared changes to the contract file.
    const adopted = { ...readChatContract(read, sources()), storedValues: STORED_VALUES_THROUGH_V0_1_114 };
    const before = readChatContract(file => file === 'scripts/chat-storage-contract.json' ? '' : read(file), sources());
    expect(before.storedValues).toBeUndefined();
    expect(detectBreakingChanges(before, adopted)).toEqual([]);
    // Same key, new encoding, contract file updated to match: still a change for readers who have the old value.
    const reencoded = { ...adopted, storedValues: STORED_VALUES_THROUGH_V0_1_114.map(item =>
      item.key === 'tb-chat-work-items-hidden' ? { ...item, value: 'true' } : item) };
    const notes = entry({ compatibleTightbeam: ['0.1.15', '0.1.16'], breakingChanges: 'none' });
    expect(() => checkReleaseStatement(notes, 'v1.0.1', before, reencoded))
      .toThrow('stored browser value under tb-chat-work-items-hidden changed format');
    expect(detectBreakingChanges(before, { ...adopted, storedValues: undefined }))
      .toHaveLength(STORED_VALUES_THROUGH_V0_1_114.length);
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
    ['supportedVersions', ['0.1.17'], '0.1.16', 'oldest supported Tightbeam rises from 0.1.16 to 0.1.17'],
    ['envKeys', ['CHAT_RENAMED'], 'CHAT_PUBLIC_ORIGIN', 'setting CHAT_PUBLIC_ORIGIN is removed or renamed'],
    ['routes', ['/__chat/version/more'], '/__chat/version', 'route /__chat/version is removed or renamed'],
    ['storageKeys', ['tb-chat.renamed'], 'tb-chat.key', 'storage key tb-chat.key is removed or renamed'],
    ['storedValues', [{ key: 'tb-chat.key', value: '{"hidden":true}' }], 'tb-chat.key', 'changed format'],
  ])('requires the notes to name what changed in %s', (name, values, subject, finding) => {
    const current = { ...contract, [name]: values };
    const claim = current.supportedVersions;
    const notes = breakingChanges => entry({ compatibleTightbeam: claim, breakingChanges });
    for (const wrong of ['none', ['Something unrelated changed.'], [`${subject}-other changed.`]]) {
      expect(() => checkReleaseStatement(notes(wrong), 'v1.0.1', contract, current)).toThrow(finding);
    }
    const sentence = `Update your setup: ${subject} no longer applies.`;
    expect(checkReleaseStatement(notes([sentence]), 'v1.0.1', contract, current).lines)
      .toEqual([`Compatible with Tightbeam: ${claim.join(', ')}`, '', `Breaking changes: ${sentence}`]);
  });

  it.each([[['9.9.9']], [['0.1.16', '9.9.9']]])('refuses a compatibility claim the package does not declare (%j)', claim => {
    expect(() => releaseStatement(entry({ compatibleTightbeam: claim, breakingChanges: 'none' }), 'v1.0.1', ['0.1.16']))
      .toThrow('they must match');
  });

  it.each([
    [{ breakingChanges: 'none' }, 'compatibleTightbeam'],
    [{ compatibleTightbeam: [], breakingChanges: 'none' }, 'compatibleTightbeam'],
    [{ compatibleTightbeam: ['latest'], breakingChanges: 'none' }, 'compatibleTightbeam'],
    [{ compatibleTightbeam: ['0.1.16'] }, 'breakingChanges'],
    [{ compatibleTightbeam: ['0.1.16'], breakingChanges: [] }, 'breakingChanges'],
    [{ compatibleTightbeam: ['0.1.16'], breakingChanges: ['None'] }, 'breakingChanges'],
  ])('requires both statements (%j)', (fields, missing) => {
    expect(() => releaseStatement(entry(fields), 'v1.0.1', ['0.1.16'])).toThrow(missing);
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
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(repo, 'node_modules'));
    write('.gitignore', 'node_modules\n');
    write('scripts/chat-storage-contract.json', read('scripts/chat-storage-contract.json'));
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
      write('src/release-notes.json', JSON.stringify([{ ...entry, items: [{ title: 'T', description: 'Changed' }],
        breakingChangesReview: confirmation }]));
      commit('later notes');
    } });
    expect(laterNotes.stderr).toContain('changed after the review');
    write('server/chat-server.mjs', "environment.CHAT_PUBLIC_ORIGIN; '/__chat/version';\n");
    const wrong = release('v1.0.3', good);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('/__chat/upload is removed or renamed');
    expect(release('v1.0.3', { ...good, breakingChanges: ['The route /__chat/upload is gone.'] }).status).toBe(0);
  });
});
