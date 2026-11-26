import { describe, expect, it } from 'vitest';
import { verifyCompatibility } from '../scripts/compat/verify.mjs';
import { supportWindow } from '../scripts/compat/window.mjs';

const release = (tag_name, extra = {}) => ({ tag_name, draft: false, prerelease: false, ...extra });

describe('support window', () => {
  it('takes the release marked latest and the newest build of the version before it', () => {
    expect(supportWindow([
      release('v0.1.16+4304'), release('v0.1.16+4283', { prerelease: true }), release('v0.1.14+3724'),
      release('v0.1.15+4029', { prerelease: true }), release('v0.1.15+4082'), release('v0.1.15+4046'),
      // An older line that published a higher number is not the current release.
      release('v0.2.0+1373'), release('v0.1.17+5501', { prerelease: true }), release('nightly'),
    ], 'v0.1.16+4304')).toEqual([{ version: '0.1.15', tag: 'v0.1.15+4082' }, { version: '0.1.16', tag: 'v0.1.16+4304' }]);
  });

  it('orders versions as numbers', () => {
    expect(supportWindow([release('v0.1.10+2'), release('v0.1.9+9'), release('v0.1.2+99')], 'v0.1.10+2')
      .map(item => item.version)).toEqual(['0.1.9', '0.1.10']);
  });

  it('refuses when there is no latest or earlier release to test', () => {
    expect(() => supportWindow([release('v0.1.16+4304')], 'v0.1.16+4304')).toThrow('precedes');
    expect(() => supportWindow([release('v0.1.16+4304')], 'v0.1.17+1')).toThrow('not among');
  });
});

describe('computed compatibility', () => {
  const window = [{ version: '0.1.15' }, { version: '0.1.16' }];
  const results = [{ version: '0.1.15', passed: true }, { version: '0.1.16', passed: true }];
  const notes = compatibleTightbeam => [{ version: 'v1.0.0', compatibleTightbeam, breakingChanges: 'none' }];
  const check = changes => verifyCompatibility({ window, results, tag: 'v1.0.0', supportedVersions: ['0.1.15', '0.1.16'],
    entries: notes(['0.1.15', '0.1.16']), ...changes });

  it('writes the line from what passed', () => {
    expect(check({})).toBe('Compatible with Tightbeam: 0.1.15, 0.1.16');
  });

  it.each([
    ['a version that failed', { results: [results[0], { version: '0.1.16', passed: false }] }, 'did not pass against Tightbeam 0.1.16'],
    ['a version with no result', { results: [results[1]] }, 'did not pass against Tightbeam 0.1.15'],
    ['notes claiming less than passed', { entries: notes(['0.1.16']) }, 'must match'],
    ['a package declaring less than the window', { supportedVersions: ['0.1.16'], entries: notes(['0.1.16']) }, 'what passed gives'],
  ])('refuses %s', (_label, changes, message) => {
    expect(() => check(changes)).toThrow(message);
  });
});
