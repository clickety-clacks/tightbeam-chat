// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ActivitySummaryStore, modelCaller, normalizeSummary, sourceIdentity, summaryConfiguration } from '../bin/activity-summaries.mjs';
import { createChatServer } from '../server/chat-server.mjs';

const roots = [], stores = [], servers = [];
const config = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-summaries-'));
  roots.push(directory);
  return { ...summaryConfiguration({}), directory };
};
const open = (settings, options) => { const store = new ActivitySummaryStore(settings, options); stores.push(store); return store; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const disk = settings => fs.readdirSync(settings.directory).filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(fs.readFileSync(path.join(settings.directory, name), 'utf8')));
const listen = async server => {
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('durable activity summaries', () => {
  it('reserves one attempt for concurrent viewers, retains distinct events and text revisions, and drops terminal sources', async () => {
    const settings = config(), answer = deferred();
    const call = vi.fn(() => answer.promise);
    const store = open(settings, { call });
    const first = [], second = [];
    store.watch('message-a', '  Full\r\nbody  ', state => first.push(state));
    expect(disk(settings)[0]).toMatchObject({ state: 'started', attempts: 1, sourceText: 'Full\nbody' });
    store.watch('message-a', 'Full\nbody', state => second.push(state));
    expect(call).toHaveBeenCalledTimes(1);
    answer.resolve('<think>internal reasoning</think>\n**Completed** the update.');
    await settle();
    expect(first.at(-1)).toMatchObject({ state: 'summary', summary: 'Completed the update.' });
    expect(second.at(-1)).toEqual(first.at(-1));
    expect(disk(settings)[0]).not.toHaveProperty('sourceText');
    store.close();
    const otherModel = vi.fn(async () => 'A new result.');
    const restarted = open({ ...settings, model: 'another-model' }, { call: otherModel });
    restarted.watch('message-a', 'Full\nbody', () => {});
    expect(otherModel).not.toHaveBeenCalled();
    restarted.watch('message-b', 'Full\nbody', () => {});
    restarted.watch('message-a', 'Revised body', () => {});
    await settle();
    expect(otherModel).toHaveBeenCalledTimes(2);
    expect(disk(settings)).toHaveLength(3);
  });

  it('owns the five-minute and sixty-minute retries across restart, ignores viewers, and stops after three failures', async () => {
    vi.useFakeTimers();
    const settings = config();
    const fullSource = 'Complete long source '.repeat(5000);
    const call = vi.fn(async () => { throw new Error('Context too long'); });
    let store = open(settings, { call });
    store.watch('long-message', fullSource, () => {});
    await settle();
    expect(disk(settings)[0]).toMatchObject({ state: 'waiting', attempts: 1 });
    for (let i = 0; i < 5; i++) store.watch('long-message', fullSource, () => {});
    store.close();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    store = open(settings, { call });
    await vi.advanceTimersByTimeAsync(3 * 60_000 - 1);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(call).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls.every(([text]) => text === fullSource.trim())).toBe(true);
    expect(disk(settings)[0]).toMatchObject({ state: 'unsummarized', attempts: 3 });
    expect(disk(settings)[0]).not.toHaveProperty('sourceText');
    store.close();
    store = open(settings, { call });
    store.watch('long-message', fullSource, () => {});
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('recovers an interrupted first or third attempt without sending on discovery, and ignores a torn replacement', async () => {
    vi.useFakeTimers();
    const settings = config(), identity = sourceIdentity('interrupted', 'Body');
    const original = { ...identity, sourceText: 'Body', state: 'started', attempts: 1, model: null, changedAt: Date.now() - 100_000 };
    fs.writeFileSync(path.join(settings.directory, `${identity.key}.json`), JSON.stringify(original));
    fs.writeFileSync(path.join(settings.directory, `${identity.key}.json.tmp`), '{"torn":');
    const call = vi.fn(async () => 'Recovered the update.');
    let store = open(settings, { call });
    expect(call).not.toHaveBeenCalled();
    expect(disk(settings)[0].nextAttemptAt).toBe(Date.now() + 300_000);
    expect(fs.readdirSync(settings.directory).some(name => name.endsWith('.tmp'))).toBe(false);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(call).toHaveBeenCalledTimes(1);
    store.close();
    fs.writeFileSync(path.join(settings.directory, `${identity.key}.json`), JSON.stringify({ ...original, attempts: 3 }));
    store = open(settings, { call });
    expect(disk(settings)[0]).toMatchObject({ state: 'unsummarized', attempts: 3 });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('runs an overdue retry without a viewer and bounds a hung request by timeout', async () => {
    vi.useFakeTimers();
    const settings = { ...config(), timeoutMs: 2000 };
    const identity = sourceIdentity('due', 'Original');
    fs.writeFileSync(path.join(settings.directory, `${identity.key}.json`), JSON.stringify({ ...identity,
      state: 'waiting', attempts: 1, sourceText: 'Original', nextAttemptAt: Date.now() - 1 }));
    const call = vi.fn(() => new Promise(() => {}));
    open(settings, { call });
    await vi.advanceTimersByTimeAsync(0);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(disk(settings)[0]).toMatchObject({ state: 'waiting', attempts: 2, nextAttemptAt: Date.now() + 3_600_000 });
  });

  it('normalizes plain output and treats reasoning-only output as failure', async () => {
    expect(normalizeSummary('<think>secret</think>\n- **Fixed** `paging`.')).toBe('Fixed paging.');
    const settings = config();
    const store = open(settings, { call: async () => '<think>only reasoning</think>' });
    store.watch('empty', 'Whole source', () => {});
    await settle();
    expect(disk(settings)[0]).toMatchObject({ state: 'waiting', attempts: 1 });
  });

  it('uses configured HTTP model and streamed answers, survives replacement, and never exposes the model credential', async () => {
    const settings = config(), requestReceived = deferred(), modelAnswer = deferred(), received = [];
    const credentialFile = path.join(settings.directory, 'model-key');
    fs.writeFileSync(credentialFile, 'controlled-test-key', { mode: 0o600 });
    const modelOrigin = await listen(http.createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      received.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
      requestReceived.resolve();
      await modelAnswer.promise;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: 'Review requested seven corrections.' } }] }));
    }));
    const environment = { CHAT_PUBLIC_ORIGIN: 'https://chat.example', CHAT_SUMMARY_DATA_DIR: settings.directory,
      CHAT_SUMMARY_ENDPOINT: `${modelOrigin}/v1/chat/completions`, CHAT_SUMMARY_MODEL: 'local-test',
      CHAT_SUMMARY_CREDENTIAL_FILE: credentialFile, TIGHTBEAM_BASE_DIR: path.join(settings.directory, 'unused') };
    const server = createChatServer({ releaseInfo: { tag: 'v1.0.0', sourceCommit: 'example' }, environment });
    const origin = await listen(server);
    const sources = [{ lineId: 'note', sourceText: 'Seven corrections are required before this change can proceed.' }];
    const post = () => fetch(`${origin}/__chat/summaries`, { method: 'POST', headers: { origin: 'https://chat.example' }, body: JSON.stringify(sources) });
    const response = await post();
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"state":"pending"');
    await requestReceived.promise;
    expect(received[0]).toMatchObject({ authorization: 'Bearer controlled-test-key', body: { model: 'local-test' } });
    expect(received[0].body.messages[1].content).toBe(sources[0].sourceText);
    const second = await post();
    modelAnswer.resolve();
    let all = ''; while (true) { const part = await reader.read(); if (part.done) break; all += new TextDecoder().decode(part.value); }
    expect(all).toContain('Review requested seven corrections.');
    expect(await second.text()).toContain('Review requested seven corrections.');
    expect(received).toHaveLength(1);
    expect(JSON.stringify(disk(settings))).not.toContain('controlled-test-key');
    expect(all).not.toContain('controlled-test-key');
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const replacement = createChatServer({ releaseInfo: { tag: 'v1.0.1', sourceCommit: 'replacement' }, environment });
    const replacementOrigin = await listen(replacement);
    const stored = await fetch(`${replacementOrigin}/__chat/summaries`, { method: 'POST', headers: { origin: 'https://chat.example' }, body: JSON.stringify(sources) });
    const storedText = await stored.text();
    expect(storedText).toContain('"state":"summary"');
    expect(storedText).not.toContain('pending');
    expect(received).toHaveLength(1);
  });

  it('defaults to the loaded local model without sending a model name', async () => {
    const defaults = summaryConfiguration({ HOME: '/example/home' });
    expect(defaults).toMatchObject({ endpoint: 'http://127.0.0.1:8080/v1/chat/completions', timeoutMs: 60_000,
      directory: '/example/home/.local/share/tightbeam-chat/summaries', model: undefined });
    let body;
    const origin = await listen(http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks));
      res.end(JSON.stringify({ choices: [{ message: { content: 'Completed.' } }] }));
    }));
    await modelCaller({ ...defaults, endpoint: origin })('Source', new AbortController().signal);
    expect(body).not.toHaveProperty('model');
  });
});
