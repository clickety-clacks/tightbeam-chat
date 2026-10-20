import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TightbeamChat } from '../src/TightbeamChat';
import type { RenderContext } from '../src/TightbeamChat';
import type { ChatRuntime, RuntimeState, TightbeamAdapter, CanonicalMessage, ConversationRecord } from '../src/types';

afterEach(cleanup);

function row(sessionKey: string, id: string, messageType?: string): CanonicalMessage {
  return { kind: 'message', sessionKey, id, seq: 1, rowVersion: 1, role: 'assistant',
    sender: `sender ${sessionKey}`, content: `<script>plain ${id}</script>`,
    messageType, attachments: [{ name: 'info.txt' }], raw: { custom: 42 } };
}

class FakeRuntime implements ChatRuntime {
  listeners = new Set<() => void>();
  disposed = false;
  sent: string[] = [];
  state: RuntimeState;
  constructor(sessionKey: string) {
    this.state = { sessionKey, generation: 1, status: 'ready',
      records: [row(sessionKey, sessionKey, 'future-kind')],
      hasOlder: true, loadingOlder: false, sends: [], targetLabel: 'TEST FIXTURE' };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  loadOlder = async () => {
    this.state = { ...this.state, hasOlder: false,
      records: [row(this.state.sessionKey, `old-${this.state.sessionKey}`), ...this.state.records] };
    for (const listener of this.listeners) listener();
  };
  send = (text: string) => { this.sent.push(text); return 'c_fixture'; };
  retrySend = async () => {};
  rebuild = async () => {};
  dispose = () => { this.disposed = true; };
}

describe('embedded surface', () => {
  it('renders unknown metadata as text, exposes history/copy, and keeps submitted whitespace intact', async () => {
    const runtime = new FakeRuntime('A');
    const adapter: TightbeamAdapter = { open: () => runtime };
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<TightbeamChat sessionKey="A" adapter={adapter} />);
    expect(await screen.findByText('<script>plain A</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('future-kind')).toBeTruthy();
    expect(screen.getByText('1 attachment metadata item(s)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy sender A text' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('<script>plain A</script>'));
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(await screen.findByText('<script>plain old-A</script>')).toBeTruthy();
    const composer = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(composer, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(composer, { target: { value: '  exact  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(runtime.sent).toEqual(['  exact  ']);
  });

  it('keeps composer focus, caret, and draft while a new message arrives during refresh', () => {
    const runtime = new FakeRuntime('refresh');
    render(<TightbeamChat sessionKey="refresh" adapter={{ open: () => runtime }} />);
    const composer = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    composer.focus();
    fireEvent.change(composer, { target: { value: 'keep this draft' } });
    composer.setSelectionRange(5, 5);

    act(() => {
      runtime.state = { ...runtime.state, status: 'stale', records: [...runtime.state.records, row('refresh', 'new-message')] };
      for (const listener of runtime.listeners) listener();
    });

    expect(screen.getByText('<script>plain new-message</script>')).toBeTruthy();
    expect(composer.disabled).toBe(false);
    expect(composer.value).toBe('keep this draft');
    expect(composer.selectionStart).toBe(5);
    expect(document.activeElement).toBe(composer);
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', true);

    act(() => {
      runtime.state = { ...runtime.state, status: 'ready' };
      for (const listener of runtime.listeners) listener();
    });

    expect(composer.value).toBe('keep this draft');
    expect(composer.selectionStart).toBe(5);
    expect(document.activeElement).toBe(composer);
  });

  it('keeps chronological row order when loading older history', async () => {
    const runtime = new FakeRuntime('order');
    runtime.state = { ...runtime.state,
      records: [row('order', 'earlier'), row('order', 'newest')] };
    render(<TightbeamChat sessionKey="order" adapter={{ open: () => runtime }} />);
    const recordKeys = () => [...document.querySelectorAll('[data-record-key]')].map((element) =>
      element.getAttribute('data-record-key'));
    expect(recordKeys()).toEqual(['earlier', 'newest']);
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText('<script>plain old-order</script>');
    expect(recordKeys()).toEqual(['old-order', 'earlier', 'newest']);
  });

  it('disposes the previous selection, drops its draft, and passes intact metadata to host rendering', async () => {
    const runtimes: FakeRuntime[] = [];
    const adapter: TightbeamAdapter = { open: (key) => {
      const runtime = new FakeRuntime(key);
      runtimes.push(runtime);
      return runtime;
    } };
    const renderMessage = vi.fn((record: ConversationRecord, context: RenderContext) =>
      record.kind === 'message' && context.sessionKey === 'B' ? <em>Host custom B</em> : undefined);
    const view = render(<TightbeamChat sessionKey="A" adapter={adapter} renderMessage={renderMessage} />);
    await screen.findByText('<script>plain A</script>');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'draft A' } });
    view.rerender(<TightbeamChat sessionKey="B" adapter={adapter} renderMessage={renderMessage} />);
    expect(await screen.findByText('Host custom B')).toBeTruthy();
    expect(runtimes[0].disposed).toBe(true);
    expect(runtimes[0].listeners.size).toBe(0);
    expect(screen.getByRole('textbox', { name: 'Message' }).getAttribute('value')).not.toBe('draft A');
    expect(screen.queryByText('<script>plain A</script>')).toBeNull();
    const log = screen.getByRole('log');
    expect(within(log).getByText('Host custom B')).toBeTruthy();
    expect(renderMessage.mock.calls.some(([record, context]) =>
      record.kind === 'message' && record.raw.custom === 42 && context.recordKey === 'B')).toBe(true);
  });

  it('keeps the visible record at the same reading position when older rows are prepended', async () => {
    const runtime = new FakeRuntime('anchor');
    const adapter: TightbeamAdapter = { open: () => runtime };
    render(<TightbeamChat sessionKey="anchor" adapter={adapter} />);
    await screen.findByText('<script>plain anchor</script>');
    const viewport = screen.getByRole('log') as HTMLElement;
    const rect = (top: number, bottom: number): DOMRect => ({
      top, bottom, left: 0, right: 600, width: 600, height: bottom - top,
      x: 0, y: top, toJSON: () => ({}),
    });
    const original = HTMLElement.prototype.getBoundingClientRect;
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === viewport) return rect(100, 200);
      if (this.dataset.recordKey) {
        const rows = [...viewport.querySelectorAll<HTMLElement>('[data-record-key]')];
        const top = 100 + rows.indexOf(this) * 50 - viewport.scrollTop;
        return rect(top, top + 50);
      }
      return original.call(this);
    });
    viewport.scrollTop = 20;
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText('<script>plain old-anchor</script>');
    expect(viewport.scrollTop).toBe(70);
    bounds.mockRestore();
  });

  it('keeps the reading anchor through a live append and respects a later reader scroll', async () => {
    const runtime = new FakeRuntime('pending');
    const gate = deferred<void>();
    const originalLoadOlder = runtime.loadOlder;
    runtime.loadOlder = async () => {
      runtime.state = { ...runtime.state, loadingOlder: true };
      for (const listener of runtime.listeners) listener();
      await gate.promise;
      await originalLoadOlder();
      runtime.state = { ...runtime.state, loadingOlder: false };
      for (const listener of runtime.listeners) listener();
    };
    render(<TightbeamChat sessionKey="pending" adapter={{ open: () => runtime }} />);
    await screen.findByText('<script>plain pending</script>');
    const viewport = screen.getByRole('log') as HTMLElement;
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 500 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 100 });
    const rect = (top: number, bottom: number): DOMRect => ({
      top, bottom, left: 0, right: 600, width: 600, height: bottom - top,
      x: 0, y: top, toJSON: () => ({}),
    });
    const original = HTMLElement.prototype.getBoundingClientRect;
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === viewport) return rect(100, 200);
      if (this.dataset.recordKey) {
        const rows = [...viewport.querySelectorAll<HTMLElement>('[data-record-key]')];
        const top = 100 + rows.indexOf(this) * 50 - viewport.scrollTop;
        return rect(top, top + 50);
      }
      return original.call(this);
    });
    viewport.scrollTop = 20;
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    runtime.state = { ...runtime.state, records: [...runtime.state.records, row('pending', 'new-pending')] };
    for (const listener of runtime.listeners) listener();
    await screen.findByText('<script>plain new-pending</script>');
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    gate.resolve();
    await screen.findByText('<script>plain old-pending</script>');
    await waitFor(() => expect(viewport.scrollTop).toBe(50));
    bounds.mockRestore();
  });

  it('shows recoverable local submissions while an unchanged principal has an unsupported target', async () => {
    const runtime = new FakeRuntime('recovery');
    render(<TightbeamChat sessionKey="recovery" adapter={{ open: () => runtime }} />);
    await screen.findByText('<script>plain recovery</script>');
    runtime.state = { ...runtime.state, status: 'unsupported', records: [], hasOlder: false,
      sends: [
        { sessionKey: 'recovery', deviceId: 'device', clientMessageId: 'accepted-id',
          content: 'accepted visible text', status: 'accepted', reconciled: true },
        { sessionKey: 'recovery', deviceId: 'device', clientMessageId: 'pending-id',
          content: '  exact recoverable text  ', status: 'uncertain', reconciled: false,
          reason: 'Outcome unknown' },
      ] };
    for (const listener of runtime.listeners) listener();
    expect(await screen.findByText('accepted visible text')).toBeTruthy();
    expect(screen.getByText('exact recoverable text').textContent).toBe('  exact recoverable text  ');
    fireEvent.click(screen.getByRole('button', { name: 'Restore to composer' }));
    const composer = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    expect(composer.value).toBe('  exact recoverable text  ');
    expect(composer.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Check and retry this send' })).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
