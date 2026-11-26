// What a Chat release states about itself, and the checks that stop it stating the wrong thing.
//
// Each tagged version carries two fields in src/release-notes.json:
//   "compatibleTightbeam": ["0.1.16"]   the Tightbeam versions actually verified
//   "breakingChanges": "none"           or a list of sentences
// The tag job compares the tagged source with the previous release tag. A change that can break an
// installation or lose a reader's browser state refuses "none".

const VERSION = /^\d+\.\d+\.\d+$/;
const TAG = /^v\d+\.\d+\.\d+$/;

const ENV_SOURCES = ['server/chat-server.mjs', 'bin/activity-summaries.mjs', 'scripts/pair-marker-device.mjs'];
const ROUTE_SOURCE = 'server/chat-server.mjs';
const VERSION_SOURCE = 'scripts/package-chat-release.mjs';

const unique = values => [...new Set(values)].sort();
const matches = (text, pattern) => [...text.matchAll(pattern)].map(match => match[1]);

/**
 * Read the contract of one source tree. `read(path)` returns a file's text, or '' when the tree lacks it;
 * `sourceFiles` lists the tree's browser sources under src/.
 */
export function readChatContract(read, sourceFiles) {
  const versionList = /supportedVersions:\s*\[([^\]]*)\]/.exec(read(VERSION_SOURCE))?.[1];
  const supportedVersions = unique(matches(versionList ?? '', /['"](\d+\.\d+\.\d+)['"]/g));
  const envKeys = unique(ENV_SOURCES.flatMap(file =>
    matches(read(file), /\b(?:environment|process\.env)(?:\.|\[['"])(CHAT_[A-Z0-9_]+)/g)));
  const routes = unique(matches(read(ROUTE_SOURCE), /['"`](\/__chat\/[a-z0-9/_-]*[a-z0-9])/g));
  const browser = sourceFiles.filter(file => /\.tsx?$/.test(file)).map(read);
  const storageKeys = unique(browser.flatMap(text =>
    matches(text, /\bconst\s+\w*(?:_KEY|StorageKey|StoragePrefix)\s*=\s*['"]([^'"]+)['"]/g)));
  // What is written under a key is its stored format, so a changed write counts as a changed format.
  const storageWrites = unique(browser.flatMap(text =>
    matches(text, /\.setItem\(([^;]*)\);/g).map(args => args.replace(/\s+/g, ' ').trim())));
  const contract = { supportedVersions, envKeys, routes, storageKeys, storageWrites };
  // An extractor that finds nothing would pass every comparison, so that is an error.
  for (const [name, values] of Object.entries(contract)) {
    if (!values.length) throw new Error(`The release contract check found no ${name}; the extractor needs updating.`);
  }
  return contract;
}

function compareVersions(left, right) {
  const a = left.replace(/^v/, '').split('.').map(Number);
  const b = right.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** The newest release tag older than `tag`. */
export function previousReleaseTag(tags, tag) {
  return tags.filter(candidate => TAG.test(candidate) && compareVersions(candidate, tag) < 0)
    .sort(compareVersions).at(-1);
}

/** Changes from the previous release that must be declared as breaking. */
export function detectBreakingChanges(previous, current) {
  const gone = name => previous[name].filter(value => !current[name].includes(value));
  const found = [];
  const [oldMinimum] = [...previous.supportedVersions].sort(compareVersions);
  const [newMinimum] = [...current.supportedVersions].sort(compareVersions);
  if (compareVersions(newMinimum, oldMinimum) > 0) {
    found.push(`the oldest supported Tightbeam rises from ${oldMinimum} to ${newMinimum}`);
  }
  for (const key of gone('envKeys')) found.push(`the setting ${key} is removed or renamed`);
  for (const route of gone('routes')) found.push(`the route ${route} is removed or renamed`);
  for (const key of gone('storageKeys')) found.push(`the browser storage key ${key} is removed or renamed`);
  for (const write of gone('storageWrites')) found.push(`the stored browser value written as (${write}) changed`);
  return found;
}

/** The two release-body lines for `tag`; throws when the version does not state them. */
export function releaseStatement(entries, tag) {
  const entry = Array.isArray(entries) ? entries.find(candidate => candidate?.version === tag) : undefined;
  const compatible = entry?.compatibleTightbeam;
  if (!Array.isArray(compatible) || !compatible.length || !compatible.every(version => VERSION.test(version))) {
    throw new Error(`src/release-notes.json needs "compatibleTightbeam" for ${tag}: the verified Tightbeam versions.`);
  }
  const breaking = entry.breakingChanges;
  const none = breaking === 'none';
  if (!none && !(Array.isArray(breaking) && breaking.length &&
      breaking.every(item => typeof item === 'string' && item.trim() && item.trim().toLowerCase() !== 'none'))) {
    throw new Error(`src/release-notes.json needs "breakingChanges" for ${tag}: "none" or a list of sentences.`);
  }
  return {
    declaresNoBreakingChange: none,
    lines: [
      `Compatible with Tightbeam: ${compatible.join(', ')}`,
      '',
      ...(none ? ['Breaking changes: none'] : ['Breaking changes:', ...breaking.map(item => `- ${item.trim()}`)]),
    ],
  };
}

/** Throws unless `tag` states both fields and declares what the comparison found. */
export function checkReleaseStatement(entries, tag, previousContract, currentContract) {
  const statement = releaseStatement(entries, tag);
  const found = detectBreakingChanges(previousContract, currentContract);
  if (statement.declaresNoBreakingChange && found.length) {
    throw new Error(`${tag} says "breakingChanges": "none", but compared with the previous release ${found.join('; ')}.`);
  }
  return statement;
}
