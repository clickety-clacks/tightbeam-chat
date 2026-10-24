import { createRoot } from 'react-dom/client';
import { HOST_COMMAND_NAME, HOST_DECLARATION_NAME, type HostComposerCommand, type HostComposerEvent } from '../src/hostComposer';
import type { HostComposerCommandEntry } from '../src/hostComposer';
import { RuntimeEntry } from './RuntimeEntry';
import './site.css';
import './hostComposer.css';

const page = window as unknown as Record<string, unknown>;
const panel = document.querySelector<HTMLElement>('.host-composer-panel')!;
const form = document.querySelector<HTMLFormElement>('#host-composer-form')!;
const input = document.querySelector<HTMLTextAreaElement>('#host-composer-input')!;
const targetLabel = document.querySelector<HTMLElement>('.host-composer-target')!;
const status = document.querySelector<HTMLElement>('.host-composer-status')!;
const retryButton = document.querySelector<HTMLButtonElement>('#host-composer-retry')!;

type ReadyEvent = Extract<HostComposerEvent, { event: 'ready' }>;
interface LocalSubmission { readonly correlationId: string; readonly sessionKey: string; readonly content: string; state: string }
let ready: ReadyEvent | undefined;
let connected = false;
const submissions = new Map<string, LocalSubmission>();
let retrySubmission: LocalSubmission | undefined;

function commandEntry(): HostComposerCommandEntry | undefined {
  const command = page[HOST_COMMAND_NAME];
  return typeof command === 'function' ? command as HostComposerCommandEntry : undefined;
}

function updateRetryButton(): void {
  retrySubmission = [...submissions.values()].reverse().find((submission) =>
    ready?.sessionKey === submission.sessionKey && ['failed', 'uncertain'].includes(submission.state));
  retryButton.hidden = !retrySubmission;
  retryButton.disabled = !connected || !retrySubmission;
}

function send(content: string, retry = false): void {
  if (!ready || !connected || !content.trim()) {
    status.textContent = 'Chat is not ready. Your draft remains here.';
    return;
  }
  const command = commandEntry();
  if (!command) {
    status.textContent = 'This Chat page does not support the host composer. Use its web composer.';
    return;
  }
  const submission = retry && retrySubmission
    ? retrySubmission
    : { correlationId: `c_${crypto.randomUUID()}`, sessionKey: ready.sessionKey, content, state: 'sending' };
  if (!retry) submissions.set(submission.correlationId, submission);
  if (retry) submission.state = 'retrying';
  status.textContent = retry ? 'Retry started by the user.' : 'Sending through Chat…';
  updateRetryButton();
  const request: HostComposerCommand = {
    type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
    correlationId: submission.correlationId, content: submission.content,
    ...(retry ? { retry: true } : {}),
  };
  command(request);
}

function handleEvent(event: HostComposerEvent): void {
  switch (event.event) {
    case 'declined':
      status.textContent = `Host composer unavailable (${event.reason}); use Chat's web composer.`;
      return;
    case 'ready':
      if (ready?.sessionKey !== event.sessionKey && !input.value) {
        const retainedDraft = [...submissions.values()].reverse().find((submission) =>
          submission.sessionKey !== event.sessionKey && ['failed', 'uncertain'].includes(submission.state));
        if (retainedDraft) input.value = retainedDraft.content;
      }
      ready = event;
      connected = true;
      panel.hidden = false;
      document.body.classList.add('host-composer-active');
      targetLabel.textContent = `${event.agentDisplayName || 'Selected agent'} · ${event.sessionKey}`;
      status.textContent = `Chat is ready. Text sending is supported; attachments may be supported in a future version.`;
      form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = false;
      updateRetryButton();
      return;
    case 'unavailable':
      connected = false;
      status.textContent = `Chat is ${event.reason}. Your draft is retained; sending is paused.`;
      form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = true;
      updateRetryButton();
      return;
    case 'lifetime-ended':
      connected = false;
      status.textContent = 'This conversation selection ended. Waiting for the next ready conversation.';
      form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = true;
      updateRetryButton();
      return;
    case 'accepted':
      {
        const submission = submissions.get(event.correlationId);
        if (submission) {
          submission.state = 'accepted';
          if (input.value === submission.content) input.value = '';
        }
      }
      status.textContent = 'Accepted by Chat; checking the conversation history.';
      updateRetryButton();
      return;
    case 'delivered':
      submissions.delete(event.correlationId);
      status.textContent = 'The message appears in conversation history.';
      updateRetryButton();
      return;
    case 'failed':
      {
        const submission = submissions.get(event.correlationId);
        if (submission) submission.state = event.reason === 'retry-unavailable' ? 'unretryable' : 'failed';
      }
      status.textContent = event.reason === 'refused'
        ? `Chat refused this message (${event.detail ?? 'no detail'}).`
        : 'Retry is unavailable for this target.';
      updateRetryButton();
      return;
    case 'uncertain':
      {
        const submission = submissions.get(event.correlationId);
        if (submission) submission.state = 'uncertain';
      }
      status.textContent = event.reason === 'accepted-unreconciled'
        ? 'Chat accepted the post, but it is not confirmed in history yet.'
        : 'This message may not have been posted.';
      updateRetryButton();
      return;
    case 'rejected':
      status.textContent = `Not sent: ${event.reason}. Your draft remains here.`;
      return;
  }
}

const declaration = { versions: [1], onEvent: handleEvent };
page[HOST_DECLARATION_NAME] = declaration;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  send(input.value);
});
retryButton.addEventListener('click', () => {
  if (retrySubmission) send(retrySubmission.content, true);
});

createRoot(document.getElementById('root')!).render(<RuntimeEntry />);
