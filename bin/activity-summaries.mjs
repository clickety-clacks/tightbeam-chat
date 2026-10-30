import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const normalizeSource = text => text.replace(/\r\n?/g, '\n').trim();
export function sourceIdentity(lineId, sourceText) {
  const textDigest = crypto.createHash('sha256').update(normalizeSource(sourceText)).digest('hex');
  return { lineId, textDigest, key: crypto.createHash('sha256').update(JSON.stringify([lineId, textDigest])).digest('hex') };
}

export function normalizeSummary(text) {
  return text.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<analysis\b[^>]*>[\s\S]*?(?:<\/analysis>|$)/gi, '')
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/!?(?:\[([^\]]+)\])\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '').replace(/^\s*(?:[-*+#>]\s*|\d+[.)]\s+)/gm, '')
    .replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '').trim();
}

export function summaryConfiguration(environment) {
  return {
    directory: environment.CHAT_SUMMARY_DATA_DIR || path.join(environment.XDG_DATA_HOME ||
      path.join(environment.HOME || os.homedir(), '.local', 'share'), 'tightbeam-chat', 'summaries'),
    endpoint: environment.CHAT_SUMMARY_ENDPOINT || 'http://127.0.0.1:8080/v1/chat/completions',
    model: environment.CHAT_SUMMARY_MODEL || undefined,
    timeoutMs: Number(environment.CHAT_SUMMARY_TIMEOUT_MS) > 0 ? Number(environment.CHAT_SUMMARY_TIMEOUT_MS) : 60_000,
    credentialFile: environment.CHAT_SUMMARY_CREDENTIAL_FILE || undefined,
  };
}

export function modelCaller(config) {
  return async (sourceText, signal) => {
    const headers = { 'content-type': 'application/json' };
    if (config.credentialFile) headers.authorization = `Bearer ${fs.readFileSync(config.credentialFile, 'utf8').trim()}`;
    const response = await fetch(config.endpoint, { method: 'POST', headers, signal,
      body: JSON.stringify({ ...(config.model ? { model: config.model } : {}), stream: false,
        messages: [{ role: 'system', content: 'Summarize what happened in one short plain-text sentence, about 12 words or fewer. Lead with the outcome. No greeting, preamble, markdown, quotations or reasoning. Example: Changes requested on PR158: seven blockers, led by missing recovery.' },
          { role: 'user', content: sourceText }] }) });
    if (!response.ok) throw new Error('Summary model request failed.');
    const body = await response.json();
    return typeof body.choices?.[0]?.message?.content === 'string' ? body.choices[0].message.content : '';
  };
}

/** One serving process owns this directory. Atomic per-key replacement removes
 * terminal source text rather than retaining it in an append-only journal. */
export class ActivitySummaryStore {
  entries = new Map();
  listeners = new Map();
  timers = new Map();
  controllers = new Set();
  closed = false;
  constructor(config, { call = modelCaller(config), now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
    Object.assign(this, { config, call, now, schedule, cancel });
    if (fs.existsSync(config.directory)) {
      for (const name of fs.readdirSync(config.directory)) {
        // A crash before rename leaves only a temporary file; the last committed
        // record is still intact. Do not retain those abandoned source copies.
        if (name.endsWith('.tmp')) { fs.unlinkSync(path.join(config.directory, name)); continue; }
        if (!name.endsWith('.json')) continue;
        const entry = JSON.parse(fs.readFileSync(path.join(config.directory, name), 'utf8'));
        this.entries.set(entry.key, entry);
      }
    }
    for (const entry of this.entries.values()) {
      if (entry.state === 'started') this.fail(entry);
      else if (entry.state === 'waiting') this.arm(entry);
    }
  }
  save(entry) {
    fs.mkdirSync(this.config.directory, { recursive: true });
    const filename = path.join(this.config.directory, `${entry.key}.json`);
    const temporary = `${filename}.tmp`;
    const descriptor = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(entry)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, filename);
    const directory = fs.openSync(this.config.directory, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    this.entries.set(entry.key, entry);
    for (const listener of this.listeners.get(entry.key) ?? []) listener(this.publicState(entry));
  }
  publicState(entry) {
    return { lineId: entry.lineId, textDigest: entry.textDigest,
      state: entry.state === 'started' ? entry.attempts === 1 ? 'pending' : 'waiting' : entry.state,
      ...(entry.summary ? { summary: entry.summary } : {}) };
  }
  watch(lineId, sourceText, listener) {
    const identity = sourceIdentity(lineId, sourceText);
    let entry = this.entries.get(identity.key);
    if (!entry) {
      // No await between existence check and durable reservation.
      entry = { ...identity, state: 'started', attempts: 1, sourceText: normalizeSource(sourceText),
        changedAt: this.now(), model: this.config.model ?? null };
      this.save(entry);
      void this.run(entry);
    }
    const listeners = this.listeners.get(identity.key) ?? new Set();
    this.listeners.set(identity.key, listeners);
    listeners.add(listener);
    listener(this.publicState(entry));
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(identity.key); };
  }
  arm(entry) {
    const timer = this.schedule(() => {
      this.timers.delete(entry.key);
      if (this.closed) return;
      const started = { ...entry, state: 'started', attempts: entry.attempts + 1,
        nextAttemptAt: undefined, changedAt: this.now(), model: this.config.model ?? null };
      try { this.save(started); void this.run(started); } catch { /* No durable reservation, no model request. */ }
    }, Math.max(0, entry.nextAttemptAt - this.now()));
    timer?.unref?.();
    this.timers.set(entry.key, timer);
  }
  fail(entry) {
    const { sourceText, nextAttemptAt: _next, ...retained } = entry;
    const failed = entry.attempts >= 3
      ? { ...retained, state: 'unsummarized', changedAt: this.now() }
      : { ...retained, sourceText, state: 'waiting', changedAt: this.now(),
        nextAttemptAt: this.now() + (entry.attempts === 1 ? 5 * 60_000 : 60 * 60_000) };
    this.save(failed);
    if (failed.state === 'waiting') this.arm(failed);
  }
  async run(entry) {
    const controller = new AbortController();
    this.controllers.add(controller);
    let timeout;
    try {
      const expired = new Promise((_, reject) => {
        timeout = this.schedule(() => { controller.abort(); reject(new Error('Summary timed out.')); }, this.config.timeoutMs);
        timeout?.unref?.();
      });
      const text = await Promise.race([this.call(entry.sourceText, controller.signal), expired]);
      if (this.closed) return;
      const summary = normalizeSummary(text);
      if (!summary) throw new Error('Empty summary.');
      const { sourceText: _source, nextAttemptAt: _next, ...retained } = entry;
      this.save({ ...retained, state: 'summary', summary, changedAt: this.now() });
    } catch {
      if (!this.closed) {
        try { this.fail(entry); } catch { /* Keep the last durable state for startup recovery. */ }
      }
    } finally { this.cancel(timeout); this.controllers.delete(controller); }
  }
  close() {
    this.closed = true;
    for (const timer of this.timers.values()) this.cancel(timer);
    for (const controller of this.controllers) controller.abort();
    this.listeners.clear();
  }
}

export async function serveSummaries(request, response, store) {
  if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }).end(); return; }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const sources = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(sources) || sources.some(source => !source || typeof source.lineId !== 'string' ||
        !source.lineId || typeof source.sourceText !== 'string' || !normalizeSource(source.sourceText))) {
      response.writeHead(400).end(); return;
    }
    response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    response.flushHeaders();
    const terminal = new Set();
    const unwatch = [];
    const cleanup = () => { for (const stop of unwatch) stop(); };
    response.on('close', cleanup);
    for (const [index, source] of sources.entries()) {
      unwatch.push(store.watch(source.lineId, source.sourceText, state => {
        if (response.destroyed || response.writableEnded) return;
        response.write(`${JSON.stringify({ index, ...state })}\n`);
        if (state.state === 'summary' || state.state === 'unsummarized') terminal.add(index);
        if (terminal.size === sources.length) response.end();
      }));
    }
    if (!sources.length) response.end();
    if (response.writableEnded || response.destroyed) cleanup();
  } catch {
    if (!response.headersSent) response.writeHead(503);
    response.end();
  }
}
