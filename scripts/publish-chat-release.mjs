import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'clickety-clacks/tightbeam-chat';
const apiRoot = `https://api.github.com/repos/${repository}`;
const tagPattern = /^v\d+\.\d+\.\d+$/;
const sourcePattern = /^[a-f0-9]{40}$/;

export async function publishChatRelease({
  rootDir = process.cwd(),
  environment = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const tag = environment.GITHUB_REF_NAME ?? '';
  const sourceCommit = environment.GITHUB_SHA ?? '';
  const token = environment.GITHUB_TOKEN;
  async function githubRequest(url, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'tightbeam-chat-release',
        'x-github-api-version': '2022-11-28',
        ...headers,
      },
      body: body === undefined ? undefined
        : Buffer.isBuffer(body) || typeof body === 'string' ? body
          : JSON.stringify(body),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`GitHub release operation returned HTTP ${response.status}.`);
    return response;
  }

  async function uploadAsset(url, filename) {
    const bytes = await fs.readFile(filename);
    const contentType = filename.endsWith('.tar.gz') ? 'application/gzip'
      : filename.endsWith('.json') ? 'application/json'
        : 'text/plain; charset=utf-8';
    const target = new URL(url);
    target.searchParams.set('name', path.basename(filename));
    const response = await githubRequest(target, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: bytes,
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`GitHub did not confirm upload of ${path.basename(filename)}.`); }
    if (result.name !== path.basename(filename) || result.state !== 'uploaded' || result.size !== bytes.length) {
      throw new Error(`GitHub did not confirm upload of ${path.basename(filename)}.`);
    }
  }

  if (environment.GITHUB_REPOSITORY !== repository || environment.GITHUB_EVENT_NAME !== 'push' ||
      environment.GITHUB_REF_TYPE !== 'tag' || environment.GITHUB_REF !== `refs/tags/${tag}` ||
      !tagPattern.test(tag) || !sourcePattern.test(sourceCommit) || !token || typeof fetchImpl !== 'function') {
    throw new Error('This publisher accepts only a tag-triggered Chat release job.');
  }

  const outputDir = path.resolve(rootDir, 'dist/chat-release');
  const assetName = `tightbeam-chat-${tag}.tar.gz`;
  const assetPath = path.join(outputDir, assetName);
  const checksumPath = path.join(outputDir, 'SHA256SUMS');
  const provenancePath = path.join(outputDir, 'release-provenance.json');
  const notesPath = path.join(outputDir, 'release-notes.md');
  const [assetBytes, checksumText, provenanceText, notes] = await Promise.all([
    fs.readFile(assetPath), fs.readFile(checksumPath, 'utf8'), fs.readFile(provenancePath, 'utf8'), fs.readFile(notesPath, 'utf8'),
  ]);
  const hash = crypto.createHash('sha256').update(assetBytes).digest('hex');
  const provenance = JSON.parse(provenanceText);
  if (checksumText !== `${hash}  ${assetName}\n` || provenance.product !== 'tightbeam-chat' ||
      provenance.tag !== tag || provenance.sourceCommit !== sourceCommit ||
      provenance.asset !== assetName || provenance.sha256 !== hash) {
    throw new Error('The packaged Chat release checksum or provenance does not match the tag source.');
  }

  const draftResponse = await githubRequest(`${apiRoot}/releases`, {
    method: 'POST',
    body: {
      tag_name: tag,
      name: `Tightbeam Chat ${tag}`,
      body: notes,
      draft: true,
      prerelease: false,
      generate_release_notes: false,
    },
  });
  let draft;
  try { draft = await draftResponse.json(); }
  catch { throw new Error('GitHub did not return the draft Chat release.'); }
  if (draft.tag_name !== tag || draft.draft !== true || !Number.isSafeInteger(draft.id) || typeof draft.upload_url !== 'string') {
    throw new Error('GitHub returned an unexpected Chat release record.');
  }

  const uploadBase = draft.upload_url.replace(/\{\?name,label\}$/, '');
  const uploadUrl = new URL(uploadBase);
  if (uploadUrl.protocol !== 'https:' || uploadUrl.hostname !== 'uploads.github.com' ||
      uploadUrl.pathname !== `/repos/${repository}/releases/${draft.id}/assets` || uploadUrl.search || uploadUrl.hash) {
    throw new Error('GitHub returned an unexpected Chat asset upload endpoint.');
  }
  for (const filename of [assetPath, checksumPath, provenancePath]) await uploadAsset(uploadUrl.href, filename);

  const publishResponse = await githubRequest(`${apiRoot}/releases/${draft.id}`, {
    method: 'PATCH',
    body: { draft: false },
  });
  let published;
  try { published = await publishResponse.json(); }
  catch { throw new Error('GitHub did not confirm publication of the Chat release.'); }
  if (published.id !== draft.id || published.tag_name !== tag || published.draft !== false || !published.published_at) {
    throw new Error('GitHub did not confirm publication of the complete Chat release.');
  }
  return { tag, sourceCommit, assetName, hash, releaseId: published.id };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await publishChatRelease();
    process.stdout.write(`Published ${result.tag} from ${result.sourceCommit} with ${result.assetName} (${result.hash}).\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Chat release publication failed.'}\n`);
    process.exitCode = 1;
  }
}
