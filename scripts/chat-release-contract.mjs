// What a Chat release states about itself, and the checks that stop it stating the wrong thing.
//
// Each tagged version carries two fields in src/release-notes.json:
//   "compatibleTightbeam": ["0.1.16"]   the Tightbeam versions actually verified
//   "breakingChanges": "none"           or a list of sentences
// The tag job compares the tagged source with the previous release tag. A change that can break an
// installation or lose a reader's browser state refuses "none".
//
// The reviewer then confirms the section in a commit of their own, adding to the same entry:
//   "breakingChangesReview": {"reviewer": "...", "commit": "<full sha reviewed>", "result": "confirmed"}
// The confirmation covers exactly that commit: the tag may differ from it only by this field.

import ts from 'typescript';

const VERSION = /^\d+\.\d+\.\d+$/;
const TAG = /^v\d+\.\d+\.\d+$/;

const ENV_SOURCES = ['server/chat-server.mjs', 'bin/activity-summaries.mjs', 'scripts/pair-marker-device.mjs'];
const ROUTE_SOURCE = 'server/chat-server.mjs';
const VERSION_SOURCE = 'scripts/package-chat-release.mjs';

const STORAGE_CONTRACT = 'scripts/chat-storage-contract.json';
// What readers' browsers hold from v0.1.114, the last release without a storage contract of its own. A
// release compared with such a tag is compared with this, so a format cannot change unseen on adoption.
// Frozen: it records a past release and never follows the contract file.
export const STORED_VALUES_THROUGH_V0_1_114 = Object.freeze([
  { key: 'tightbeam-chat.submitter.display-name', value: 'Ada Lovelace' },
  { key: 'tightbeam-chat.release-notes.seen-version', value: 'v0.1.114' },
  { key: 'tb-chat-work-items-hidden', value: '1' },
  { key: 'tb-chat:dismissed-prompt:agent%3Aexample%3Amain', value: 'true' },
]);

const unique = values => [...new Set(values)].sort();
const matches = (text, pattern) => [...text.matchAll(pattern)].map(match => match[1]);
// Commented-out code must not count. The TypeScript printer drops every comment and leaves strings alone.
const printer = ts.createPrinter({ removeComments: true });
const uncommented = (file, text) => printer.printFile(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false,
  file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS));

/**
 * Read the contract of one source tree. `read(path)` returns a file's text, or '' when the tree lacks it;
 * `sourceFiles` lists the tree's browser sources under src/.
 */
export function readChatContract(read, sourceFiles) {
  const code = file => uncommented(file, read(file));
  const versionList = /supportedVersions:\s*\[([^\]]*)\]/.exec(code(VERSION_SOURCE))?.[1];
  const supportedVersions = unique(matches(versionList ?? '', /['"](\d+\.\d+\.\d+)['"]/g));
  const envKeys = unique(ENV_SOURCES.flatMap(file =>
    matches(code(file), /\b(?:environment|process\.env)(?:\.|\[['"])(CHAT_[A-Z0-9_]+)/g)));
  const routes = unique(matches(code(ROUTE_SOURCE), /['"`](\/__chat\/[a-z0-9/_-]*[a-z0-9])/g));
  const storageKeys = unique(sourceFiles.filter(file => /\.tsx?$/.test(file)).flatMap(file =>
    matches(code(file), /\bconst\s+\w*(?:_KEY|StorageKey|StoragePrefix)\s*=\s*['"]([^'"]+)['"]/g)));
  const contract = { supportedVersions, envKeys, routes, storageKeys };
  // An extractor that finds nothing would pass every comparison, so that is an error.
  for (const [name, values] of Object.entries(contract)) {
    if (!values.length) throw new Error(`The release contract check found no ${name}; the extractor needs updating.`);
  }
  // Stored values the build must still read and write, held true by a test. Undefined when the tree has none.
  const stored = read(STORAGE_CONTRACT);
  return { ...contract, storedValues: stored ? JSON.parse(stored) : undefined };
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

/** Changes from the previous release that must be declared, each with the name the notes must use. */
export function detectBreakingChanges(previous, current) {
  const gone = name => previous[name].filter(value => !current[name].includes(value));
  const found = [];
  const [oldMinimum] = [...previous.supportedVersions].sort(compareVersions);
  const [newMinimum] = [...current.supportedVersions].sort(compareVersions);
  const add = (subject, text) => found.push({ subject, text });
  if (compareVersions(newMinimum, oldMinimum) > 0) {
    add(oldMinimum, `the oldest supported Tightbeam rises from ${oldMinimum} to ${newMinimum}`);
  }
  for (const key of gone('envKeys')) add(key, `the setting ${key} is removed or renamed`);
  for (const route of gone('routes')) add(route, `the route ${route} is removed or renamed`);
  for (const key of gone('storageKeys')) add(key, `the browser storage key ${key} is removed or renamed`);
  for (const { key, value } of previous.storedValues ?? STORED_VALUES_THROUGH_V0_1_114) {
    // A tree being released without the contract file has dropped every promise, not kept them all.
    if (!(current.storedValues ?? []).some(item => item.key === key && item.value === value)) {
      add(key, `the stored browser value under ${key} changed format`);
    }
  }
  return found;
}

/** Whether a sentence names `subject` itself, not merely a longer name that starts with it. */
function names(sentence, subject) {
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_/-])${escaped}(?![A-Za-z0-9_/-]|\\.[0-9])`).test(sentence);
}

/**
 * The two release-body lines for `tag`; throws when the version does not state them, or claims other
 * Tightbeam versions than the package declares it supports.
 */
export function releaseStatement(entries, tag, supportedVersions) {
  const entry = Array.isArray(entries) ? entries.find(candidate => candidate?.version === tag) : undefined;
  const compatible = entry?.compatibleTightbeam;
  if (!Array.isArray(compatible) || !compatible.length || !compatible.every(version => VERSION.test(version))) {
    throw new Error(`src/release-notes.json needs "compatibleTightbeam" for ${tag}: the verified Tightbeam versions.`);
  }
  if (unique(compatible).join() !== unique(supportedVersions).join()) {
    throw new Error(`"compatibleTightbeam" for ${tag} is ${compatible.join(', ')}, but the package declares ` +
      `${supportedVersions.join(', ')}; they must match.`);
  }
  const breaking = entry.breakingChanges;
  const none = breaking === 'none';
  if (!none && !(Array.isArray(breaking) && breaking.length &&
      breaking.every(item => typeof item === 'string' && item.trim() && item.trim().toLowerCase() !== 'none'))) {
    throw new Error(`src/release-notes.json needs "breakingChanges" for ${tag}: "none" or a list of sentences.`);
  }
  return {
    sentences: none ? [] : breaking.map(item => item.trim()),
    lines: [
      `Compatible with Tightbeam: ${compatible.join(', ')}`,
      '',
      ...(none ? ['Breaking changes: none'] : ['Breaking changes:', ...breaking.map(item => `- ${item.trim()}`)]),
    ],
  };
}

/** Throws unless `tag` states both fields and names everything the comparison found. */
export function checkReleaseStatement(entries, tag, previousContract, currentContract) {
  const statement = releaseStatement(entries, tag, currentContract.supportedVersions);
  const missing = detectBreakingChanges(previousContract, currentContract)
    .filter(({ subject }) => !statement.sentences.some(sentence => names(sentence, subject)));
  if (missing.length) {
    throw new Error(`"breakingChanges" for ${tag} does not name what changed since the previous release: ` +
      `${missing.map(({ subject, text }) => `${text} (name ${subject})`).join('; ')}.`);
  }
  return statement;
}

const NOTES = 'src/release-notes.json';

/**
 * Throws unless the reviewer confirmed the section for exactly what `tag` releases. `history` answers
 * for the repository: isAncestor(commit), changedFiles(commit) and entriesAt(commit).
 */
export function checkBreakingChangesReview(entries, tag, history) {
  const entry = entries.find(candidate => candidate?.version === tag);
  const { breakingChangesReview: review, ...released } = entry ?? {};
  if (typeof review?.reviewer !== 'string' || !review.reviewer.trim() ||
      !/^[a-f0-9]{40}$/.test(review.commit ?? '') || review.result !== 'confirmed') {
    throw new Error(`${tag} needs "breakingChangesReview" in ${NOTES}: reviewer, the full reviewed commit, result "confirmed".`);
  }
  if (!history.isAncestor(review.commit)) {
    throw new Error(`The reviewed commit ${review.commit} is not part of ${tag}.`);
  }
  const others = history.changedFiles(review.commit).filter(file => file !== NOTES);
  const reviewedEntries = history.entriesAt(review.commit);
  const expected = entries.map(candidate => candidate === entry ? released : candidate);
  if (others.length || JSON.stringify(reviewedEntries) !== JSON.stringify(expected)) {
    throw new Error(`${tag} changed after the review of ${review.commit} (${[...others, ...(others.length ? [] : [NOTES])]
      .join(', ')}); the Breaking changes section needs a new confirmation.`);
  }
}
