import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptClamp, resetExpandedPromptsForTests } from '../src/PromptClamp';

// Layout by hand: each wrapped line is 20px; while collapsed the box shows ten lines (200px).
// `wrapWidth` stands in for the bubble's width: narrower means more wrapped lines.
const LINE = 20;
let wrapWidth = 400;
let resizeCallbacks: ResizeObserverCallback[] = [];
let observed: Element[] = [];

function wrappedLines(element: HTMLElement): number {
  return (element.textContent ?? '').split('\n').reduce((lines, paragraph) =>
    lines + Math.max(1, Math.ceil(paragraph.length * 8 / wrapWidth)), 0);
}

beforeEach(() => {
  resetExpandedPromptsForTests();
  wrapWidth = 400;
  resizeCallbacks = [];
  observed = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
    observe(target: Element) { observed.push(target); } unobserve() {} disconnect() {}
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

  it('counts rendered lines, so paragraph spacing does not take a line, and clips just above the eleventh', () => {
    // Line boxes reported by the browser: 20px lines, with a 12px gap between paragraphs.
    const proto = Range.prototype as Range & { getClientRects?: () => DOMRectList };
    const original = proto.getClientRects;
    proto.getClientRects = function (this: Range) {
      const node = this.startContainer as Text;
      const paragraphs = [...document.querySelectorAll('.tb-chat-markdown p')];
      const index = paragraphs.findIndex(paragraph => paragraph.contains(node));
      const before = paragraphs.slice(0, index).reduce((total, paragraph) =>
        total + (paragraph.textContent ?? '').split('\n').length, 0);
      const count = (node.textContent ?? '').split('\n').length;
      return Array.from({ length: count }, (_, line) =>
        ({ top: (before + line) * LINE + index * 12, height: LINE, bottom: 0, left: 0, right: 0, width: 100 })) as unknown as DOMRectList;
    };
    try {
      const paragraphs = (counts: number[]) => render(<PromptClamp conversation="one" identity={`send:${counts.join('-')}`}>
        <div className="tb-chat-markdown">{counts.map((count, index) => <p key={index}>{lines(count)}</p>)}</div>
      </PromptClamp>);
      paragraphs([5, 5]);
      expect(button()).toBeNull();
      cleanup();
      paragraphs([5, 6]);
      expect(button()).not.toBeNull();
      // The eleventh line starts 10 lines and one paragraph gap down.
      expect(document.querySelector<HTMLElement>('.tb-chat-prompt-clamp-content')!.style.maxHeight).toBe(`${10 * LINE + 12}px`);
    } finally {
      if (original) proto.getClientRects = original;
      else delete (proto as { getClientRects?: unknown }).getClientRects;
    }
  });

  it('keeps keyboard focus in the prompt after expanding, instead of dropping it to the page', () => {
    show(lines(40));
    button()!.focus();
    fireEvent.click(button()!);
    expect(document.activeElement).toBe(document.querySelector('.tb-chat-prompt-clamp-content'));
  });

  it('expands when focus moves to a link in the clipped part, so focus is never on hidden text', () => {
    render(<PromptClamp conversation="one" identity="send:link">
      <div className="tb-chat-markdown">{lines(40)}<a href="#late">late link</a></div>
    </PromptClamp>);
    const link = screen.getByRole('link', { name: 'late link' });
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue({ top: 700, bottom: 720, left: 0, right: 50, width: 50, height: 20,
      x: 0, y: 700, toJSON: () => ({}) } as DOMRect);
    expect(button()).not.toBeNull();
    fireEvent.focusIn(link);
    expect(button()).toBeNull();
    expect(document.querySelector('[data-expanded]')).not.toBeNull();
  });

  it('watches the text inside the clip, not the clipped box, so clipping cannot loop the resize observer', () => {
    show(lines(40));
    const content = document.querySelector('.tb-chat-prompt-clamp-content')!;
    expect(observed).toContain(content.firstElementChild);
    expect(observed).not.toContain(content);
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
