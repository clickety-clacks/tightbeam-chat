// Which Tightbeam releases Chat must be shown to work with: the current release and the one before it.
// Read from the public Tightbeam releases at the time of use, never from a list kept here.
const TAG = /^v(\d+)\.(\d+)\.(\d+)\+(\d+)$/;

const compare = (left, right) => left.map((part, index) => part - right[index]).find(Boolean) ?? 0;

/**
 * The release marked latest, and the newest build of the version numbered below it. The current release
 * is the one marked latest, not the highest number: an older line once published a higher one.
 */
export function supportWindow(releases, latestTag) {
  const builds = releases.filter(release => release.draft === false && release.prerelease === false)
    .map(release => ({ tag: release.tag_name, parts: TAG.exec(release.tag_name ?? '')?.slice(1).map(Number) }))
    .filter(release => release.parts);
  const current = builds.find(release => release.tag === latestTag);
  if (!current) throw new Error(`The latest Tightbeam release ${latestTag} was not among the published releases.`);
  const previous = builds.filter(release => compare(release.parts.slice(0, 3), current.parts.slice(0, 3)) < 0)
    .sort((left, right) => compare(left.parts, right.parts)).at(-1);
  if (!previous) throw new Error(`No published Tightbeam release precedes ${latestTag}.`);
  return [previous, current].map(({ tag, parts }) => ({ version: parts.slice(0, 3).join('.'), tag }));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').at(-1))) {
  const get = async path => {
    const response = await fetch(`https://api.github.com/repos/clickety-clacks/tightbeam/${path}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'tightbeam-chat-release',
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
    });
    if (!response.ok) throw new Error(`Tightbeam releases returned HTTP ${response.status}.`);
    return response.json();
  };
  const [releases, latest] = await Promise.all([get('releases?per_page=100'), get('releases/latest')]);
  process.stdout.write(`${JSON.stringify(supportWindow(releases, latest.tag_name))}\n`);
}
