// Which Tightbeam releases Chat must be shown to work with: the current release and the one before it.
// Read from the public Tightbeam releases at the time of use, never from a list kept here.
const TAG = /^v(\d+)\.(\d+)\.(\d+)\+(\d+)$/;

/** The newest build of each of the two newest published versions, oldest first. */
export function supportWindow(releases) {
  const builds = releases.filter(release => release.draft === false && release.prerelease === false)
    .map(release => ({ tag: release.tag_name, parts: TAG.exec(release.tag_name ?? '')?.slice(1).map(Number) }))
    .filter(release => release.parts)
    .sort((left, right) => left.parts.map((part, index) => part - right.parts[index]).find(Boolean) ?? 0);
  const newest = new Map();
  for (const { tag, parts } of builds) newest.set(parts.slice(0, 3).join('.'), tag);
  const window = [...newest].slice(-2).map(([version, tag]) => ({ version, tag }));
  if (window.length !== 2) throw new Error('Fewer than two published Tightbeam versions were found.');
  return window;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').at(-1))) {
  const response = await fetch('https://api.github.com/repos/clickety-clacks/tightbeam/releases?per_page=100', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'tightbeam-chat-release',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
  });
  if (!response.ok) throw new Error(`Tightbeam releases returned HTTP ${response.status}.`);
  process.stdout.write(`${JSON.stringify(supportWindow(await response.json()))}\n`);
}
