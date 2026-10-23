import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TightbeamChat } from '../src/TightbeamChat';
import { createTurnProvenance } from '../src/provenance';
import type { CanonicalMessage, ChatRuntime, RuntimeState } from '../src/types';

class ReadingRuntime implements ChatRuntime {
  listeners = new Set<() => void>();
  state: RuntimeState = { sessionKey: 'reading', generation: 1, status: 'ready', targetLabel: 'Example', records: [],
    provenanceAvailable: false, hasOlder: false, loadingOlder: false, sends: [], agentDisplayName: 'Assistant' };
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  publish(patch: Partial<RuntimeState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  loadOlder = async () => {};
  rebuild = async () => {};
  send = () => null;
  retrySend = async () => {};
  dispose = () => {};
}
const message = (id: number): CanonicalMessage => ({ kind: 'message', id: `message-${id}`, sessionKey: 'reading',
  seq: id, rowVersion: 1, role: 'user', content: `Message ${id}`, raw: {} });
const initialRows = Array.from({ length: 20 }, (_, i) => message(i));
let scrollTop = 0;
let scrollTo: ReturnType<typeof vi.fn>;
let reducedMotion = false;
const resizeCallbacks = new Set<ResizeObserverCallback>();
const rows = () => [...document.querySelectorAll<HTMLElement>('article[data-record-key]')];
const scrollHeight = () => 32 + rows().length * 92 + Number.parseFloat(document.querySelector<HTMLElement>('.tb-chat-viewport')?.style.getPropertyValue('--tb-chat-anchor-space') || '0');
const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 400, width: 400, height, x: 0, y: top, toJSON() {} });
beforeEach(() => {
  scrollTop = 0;
  reducedMotion = false;
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }));
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) { resizeCallbacks.add(callback); }
    observe() {}
    disconnect() { resizeCallbacks.delete(this.callback); }
    unobserve() {}
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('tb-chat-viewport')) return rect(0, 300);
    const index = rows().indexOf(this);
    if (index >= 0) return rect(16 + Number.parseFloat(document.querySelector<HTMLElement>('.tb-chat-viewport')?.style.getPropertyValue('--tb-chat-anchor-space') || '0') + index * 92 - scrollTop, 80);
    return rect(0, 50);
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('tb-chat-viewport') ? scrollHeight() : 40;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => scrollTop);
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(value => { scrollTop = Math.max(0, Math.min(value, scrollHeight() - 300)); });
  scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    // Keep smooth motion pending so intermediate scroll frames can be exercised.
    if (options.behavior !== 'smooth') this.scrollTop = options.top ?? 0;
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resizeCallbacks.clear(); });

function setup() {
  const runtime = new ReadingRuntime();
  runtime.state = { ...runtime.state, records: initialRows };
  render(<TightbeamChat sessionKey="reading" adapter={{ open: () => runtime }} />);
  scrollTo.mockClear();
  return { runtime, box: screen.getByRole('log'), input: screen.getByRole('textbox') as HTMLTextAreaElement };
}
function readAt(box: HTMLElement, position: number) {
  fireEvent.wheel(box, { deltaY: -100 });
  box.scrollTop = position;
  fireEvent.scroll(box);
}

describe('conversation reading position', () => {
  it('keeps the same visible row while content arrives below and exposes a latest-messages control', () => {
    const { runtime, box, input } = setup();
    readAt(box, 600);
    const anchor = screen.getByText('Message 7').closest('article')!;
    const offset = anchor.getBoundingClientRect().top;
    input.focus();
    fireEvent.change(input, { target: { value: 'Draft stays here' } });
    input.setSelectionRange(5, 5);
    act(() => runtime.publish({ records: [...initialRows, message(20)] }));
    expect(box.scrollTop).toBe(600);
    expect(anchor.getBoundingClientRect().top).toBe(offset);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy();
    expect(input.value).toBe('Draft stays here');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(5);
  });

  it.each([0, 40])('smoothly follows new content when previously %i pixels from bottom', gap => {
    const { runtime, box } = setup();
    readAt(box, box.scrollHeight - box.clientHeight - gap);
    act(() => runtime.publish({ records: [...initialRows, message(20), message(21)] }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'smooth' });
    // Animation frames are not mistaken for the user leaving the bottom.
    box.scrollTop += 20;
    fireEvent.scroll(box);
    act(() => runtime.publish({ records: [...runtime.state.records, message(22)] }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'smooth' });
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('lets the reader interrupt following, then uses the button to return to the latest content', () => {
    const { runtime, box } = setup();
    act(() => runtime.publish({ records: [...initialRows, message(20)] }));
    readAt(box, 500);
    scrollTo.mockClear();
    act(() => runtime.publish({ records: [...runtime.state.records, message(21)] }));
    expect(box.scrollTop).toBe(500);
    expect(scrollTo).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Scroll to latest messages' });
    button.focus();
    fireEvent.click(button);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'smooth' });
    expect(document.activeElement).toBe(box);
    box.scrollTop = box.scrollHeight;
    fireEvent.scroll(box);
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('preserves the reader across refresh notices and filtering that replaces row keys above them', () => {
    const { runtime, box, input } = setup();
    readAt(box, 950);
    const offset = screen.getByText('Message 11').closest('article')!.getBoundingClientRect().top;
    fireEvent.change(input, { target: { value: 'Unsent draft' } });
    act(() => runtime.publish({ status: 'stale' }));
    act(() => runtime.publish({ status: 'ready', provenanceAvailable: true,
      provenance: initialRows.slice(5).map(trigger => createTurnProvenance({ seq: trigger.seq, sessionKey: 'reading',
        messageId: trigger.id, origin: 'user:reader', status: 'completed', raw: {} }, trigger)) }));
    expect(screen.getByText('Message 11').closest('article')!.getBoundingClientRect().top).toBe(offset);
    expect(input.value).toBe('Unsent draft');
    expect(runtime.state.records).toHaveLength(20);
  });

  it('preserves a surviving row when the original anchor disappears on an older-page refresh', () => {
    const { runtime, box } = setup();
    readAt(box, 20);
    const offset = screen.getByText('Message 1').closest('article')!.getBoundingClientRect().top;
    act(() => runtime.publish({ records: initialRows.slice(1) }));
    expect(screen.getByText('Message 1').closest('article')!.getBoundingClientRect().top).toBe(offset);
    expect(box.scrollTop).toBe(0);
  });

  it('respects reduced motion when explicitly returning to the bottom', () => {
    reducedMotion = true;
    const { box } = setup();
    readAt(box, 600);
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to latest messages' }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'instant' });
  });
});
