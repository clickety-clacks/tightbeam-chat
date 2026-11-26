import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkReleaseStatement,
  detectBreakingChanges,
  previousReleaseTag,
  readChatContract,
  releaseStatement,
} from '../scripts/chat-release-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
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

  it('fails the tag job for a missing statement or a wrong "none", and passes a true one', () => {
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
    const release = (tag, fields) => {
      write('src/release-notes.json', JSON.stringify([{ version: tag, items: [{ title: 'T', description: 'D' }], ...fields }]));
      git('add', '-A');
      git('commit', '-qm', tag, '--allow-empty');
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
    write('server/chat-server.mjs', "environment.CHAT_PUBLIC_ORIGIN; '/__chat/version';\n");
    const wrong = release('v1.0.3', good);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('/__chat/upload is removed or renamed');
  });
});
