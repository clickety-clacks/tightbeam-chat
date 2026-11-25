import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptClamp, resetExpandedPromptsForTests } from '../src/PromptClamp';

// Layout by hand: each wrapped line is 20px; while collapsed the box shows ten lines (200px).
// `wrapWidth` stands in for the bubble's width: narrower means more wrapped lines.
const LINE = 20;
let wrapWidth = 400;
let resizeCallbacks: ResizeObserverCallback[] = [];

function wrappedLines(element: HTMLElement): number {
  return (element.textContent ?? '').split('\n').reduce((lines, paragraph) =>
    lines + Math.max(1, Math.ceil(paragraph.length * 8 / wrapWidth)), 0);
}

beforeEach(() => {
  resetExpandedPromptsForTests();
  wrapWidth = 400;
  resizeCallbacks = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
    observe() {} unobserve() {} disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('tb-chat-prompt-clamp-content') ? wrappedLines(this) * LINE : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('tb-chat-prompt-clamp-content')) return 0;
    const full = wrappedLines(this) * LINE;
    return this.parentElement?.dataset.expanded ? full : Math.min(full, 10 * LINE);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const lines = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join('\n');
const button = () => screen.queryByRole('button', { name: 'Show full message' });

function show(text: string, identity = 'send:a', conversation = 'one', beforeExpand?: () => void) {
  return render(<PromptClamp conversation={conversation} identity={identity} beforeExpand={beforeExpand}>
    <div className="tb-chat-markdown">{text}</div>
  </PromptClamp>);
}

describe('long sent prompts', () => {
  it('shows a short prompt in full, with no button', () => {
    show(lines(3));
    expect(button()).toBeNull();
    expect(document.querySelector('[data-clamped]')).toBeNull();
  });

  it('shows a prompt of exactly ten lines in full, with no button', () => {
    show(lines(10));
    expect(button()).toBeNull();
  });

  it('clips an eleven-line prompt to ten lines and offers to expand it', () => {
    show(lines(11));
    expect(button()).not.toBeNull();
    expect(document.querySelector('.tb-chat-prompt-clamp')!.getAttribute('data-clamped')).toBe('true');
    expect(button()!.getAttribute('aria-controls')).toBe(document.querySelector('.tb-chat-prompt-clamp-content')!.id);
  });

  it('counts wrapped lines, not newlines, and re-evaluates when the width changes', () => {
    const paragraph = 'word '.repeat(80); // 400 characters: 8 lines at 400px, 16 at 200px
    show(paragraph);
    expect(button()).toBeNull();
    wrapWidth = 200;
    act(() => { for (const callback of resizeCallbacks) callback([], {} as ResizeObserver); });
    expect(button()).not.toBeNull();
    wrapWidth = 400;
    act(() => { for (const callback of resizeCallbacks) callback([], {} as ResizeObserver); });
    expect(button()).toBeNull();
  });

  it('keeps all of a very long prompt in the page for copy, find and selection', () => {
    const text = lines(500);
    show(text);
    expect(button()).not.toBeNull();
    const content = document.querySelector('.tb-chat-prompt-clamp-content')!;
    expect(content.textContent).toBe(text);
    expect(content.textContent).toContain('Line 500');
  });

  it('expands in place with no way back, keeping the reading position first', () => {
    const beforeExpand = vi.fn();
    show(lines(40), 'send:a', 'one', beforeExpand);
    fireEvent.click(button()!);
    expect(beforeExpand).toHaveBeenCalledTimes(1);
    expect(button()).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('.tb-chat-prompt-clamp')!.getAttribute('data-expanded')).toBe('true');
  });

  it('stays expanded across re-renders, rebuilds and a delivered record replacing the local send', () => {
    const first = show(lines(40));
    fireEvent.click(button()!);
    first.unmount();
    // The same prompt rendered again (a live update, a reconnect, the delivered record).
    show(lines(40));
    expect(button()).toBeNull();
    expect(document.querySelector('[data-expanded]')).not.toBeNull();
  });

  it('remembers expansion per conversation and prompt', () => {
    const first = show(lines(40), 'send:a', 'one');
    fireEvent.click(button()!);
    first.unmount();
    show(lines(40), 'send:b', 'one');
    expect(button()).not.toBeNull();
    cleanup();
    show(lines(40), 'send:a', 'two');
    expect(button()).not.toBeNull();
  });
});
