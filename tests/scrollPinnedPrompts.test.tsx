import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinnedPromptKeyframes } from '../src/pinnedPromptLayout';
import { ScrollPinnedPrompts, type ScrollPinnedPrompt, type ScrollPinnedPromptsHandle } from '../src/ScrollPinnedPrompts';

// A transcript laid out by hand: the viewport is 600px tall at the top of the page and
// the pin line is 10px below it. Prompt A is tall (300px, summary 80px), B is one line.
const layout = {
  A: { top: 100, height: 300, left: 120, width: 240 },
  B: { top: 1000, height: 60, left: 200, width: 160 },
  C: { top: 1300, height: 200, left: 150, width: 210 },
} as const;
const summaryHeight = 80;
const prompts: ScrollPinnedPrompt[] = (['A', 'B', 'C'] as const).map(key => ({
  identity: `send:${key}`, text: key === 'B' ? 'Short prompt' : `Prompt ${key} `.repeat(40),
  scrollKey: key, targetId: `target-${key}`,
}));
const options = { pinLine: 10, fadeDistance: 48, pushGap: 8 };
const geometry = (['A', 'B', 'C'] as const).map(key => ({
  top: layout[key].top, height: layout[key].height,
  summaryHeight: key === 'B' ? layout[key].height : summaryHeight,
}));

let scrollTop = 0;
// The scroller's content is 2400px longer than its 600px viewport.
const SCROLL_HEIGHT = 3000;
// Where things are drawn on screen. Normally the reported scrollTop; WebKit can report a
// scrollTop past the end while drawing the clamped position (rubber-band).
let screenScroll: number | undefined;
const drawnScroll = () => screenScroll ?? scrollTop;
// Extra bottom padding, as the scroll-to-latest control adds at the end of the chat.
let extraHeight = 0;
let root: HTMLElement;
let viewport: HTMLElement;
const rows = new Map<string, HTMLElement>();

function rect(top: number, height: number, left = 0, width = 400): DOMRect {
  return { top, bottom: top + height, left, right: left + width, width, height, x: left, y: top,
    toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  scrollTop = 0;
  screenScroll = undefined;
  extraHeight = 0;
  root = document.createElement('section');
  root.className = 'tb-chat';
  root.style.setProperty('--tb-chat-floating-prompt-top', '10px');
  viewport = document.createElement('div');
  viewport.className = 'tb-chat-viewport';
  const content = document.createElement('div');
  viewport.append(content);
  for (const key of ['A', 'B', 'C']) {
    const row = document.createElement('article');
    row.className = 'tb-chat-bubble tb-chat-bubble-human';
    row.id = `target-${key}`;
    row.dataset.scrollKey = key;
    row.textContent = `Bubble ${key}`;
    content.append(row);
    rows.set(key, row);
  }
  root.append(viewport);
  document.body.append(root);
  Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => scrollTop, set: value => { scrollTop = value; } });
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === viewport || this === root) return rect(0, 600);
    if (this === viewport.firstElementChild) return rect(-drawnScroll(), SCROLL_HEIGHT);
    const key = this.dataset.scrollKey as keyof typeof layout | undefined;
    if (key && rows.get(key) === this) {
      const box = layout[key];
      return rect(box.top - drawnScroll(), box.height, box.left, box.width);
    }
    if (this.classList.contains('tb-chat-pinned-summary-measure')) return rect(0, summaryHeight);
    return rect(0, 0);
  });
  // The summary probe reports three clamped lines; long text is cut, the short prompt is not.
  const isProbeText = (element: HTMLElement) => element.classList.contains('tb-chat-pinned-summary-text') &&
    !!element.parentElement?.classList.contains('tb-chat-pinned-summary-measure');
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this === viewport) return SCROLL_HEIGHT + extraHeight;
    if (!isProbeText(this)) return 0;
    return (this.textContent ?? '').length > 40 ? 400 : summaryHeight;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this === viewport) return 600;
    return isProbeText(this) ? summaryHeight : 0;
  });
});

const originalAnimate = Element.prototype.animate;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Element.prototype.animate = originalAnimate;
  root.remove();
  rows.clear();
  vi.restoreAllMocks();
  delete (globalThis as { ScrollTimeline?: unknown }).ScrollTimeline;
});

function mount(handlers: { onJump?: (prompt: ScrollPinnedPrompt) => void; onDismiss?: () => void } = {},
  list: ScrollPinnedPrompt[] = prompts) {
  const viewportRef = { current: viewport };
  const result = render(<ScrollPinnedPrompts prompts={list} viewport={viewportRef}
    getRow={key => rows.get(key)} onJump={handlers.onJump ?? (() => {})} onDismiss={handlers.onDismiss ?? (() => {})} />,
  { container: root });
  return result;
}

function observeResizes() {
  const callbacks: ResizeObserverCallback[] = [];
  (globalThis as { __pinTestObservers?: ResizeObserverCallback[] }).__pinTestObservers = callbacks;
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
    observe() {} unobserve() {} disconnect() {} });
}

function scrollTo(position: number) {
  scrollTop = position;
  act(() => { fireEvent.scroll(viewport); });
}

const slotFor = (key: string) => root.querySelector<HTMLElement>(`.tb-chat-pinned-slot[data-prompt-identity="send:${key}"]`);
const translate = (element: HTMLElement | null | undefined) =>
  Number.parseFloat(element?.style.transform.match(/translateY\((-?[\d.e-]+)px\)/)?.[1] ?? 'NaN');

describe('scroll-pinned prompts without scroll timelines', () => {
  it('leaves prompts in their natural place until the top reaches the pin line', () => {
    mount();
    scrollTo(90);
    expect(slotFor('A')?.style.opacity).toBe('0');
    expect(slotFor('A')?.hasAttribute('data-pinned')).toBe(false);
    expect(slotFor('A')?.getAttribute('aria-hidden')).toBe('true');
    expect(rows.get('A')!.hasAttribute('data-pinned-original')).toBe(false);
  });

  it('draws a copy at the bubble position and width, shortening with the scroll, and hides the original', () => {
    mount();
    scrollTo(190);
    const slot = slotFor('A')!;
    expect(slot.style.opacity).toBe('1');
    expect(slot.style.left).toBe('120px');
    expect(slot.style.width).toBe('240px');
    expect(translate(slot)).toBe(10);
    // 100px scrolled past the pin point: the text has moved up 100px inside the bubble.
    expect(translate(slot.querySelector<HTMLElement>('.tb-chat-pinned-body'))).toBe(-100);
    expect(rows.get('A')!.hasAttribute('data-pinned-original')).toBe(true);
    expect(slot.hasAttribute('data-pinned')).toBe(true);
    expect(slot.hasAttribute('aria-hidden')).toBe(false);
    expect(slot.querySelector('.tb-chat-pinned-full')!.textContent).toBe('Bubble A');
    expect(slot.querySelector('.tb-chat-pinned-full [id]')).toBeNull();
  });

  it('shortens by clipping, never by scaling: the text keeps its size and width at every position', () => {
    mount();
    const widths = new Set<string>();
    for (const position of [95, 150, 250, 309, 330, 600, 950, 985]) {
      scrollTo(position);
      const slot = slotFor('A')!;
      const copy = slot.querySelector<HTMLElement>('.tb-chat-pinned-full > .tb-chat-pinned-copy')!;
      for (const element of [slot, slot.querySelector<HTMLElement>('.tb-chat-pinned-body')!, copy]) {
        expect(element.style.transform).not.toMatch(/scale|matrix|rotate|skew/);
        expect(element.style.zoom || '').toBe('');
      }
      expect(slot.style.height).toBe(`${layout.A.height}px`);
      widths.add(`${slot.style.width}|${copy.style.width}`);
    }
    // One width for the whole journey, equal to the bubble's.
    expect([...widths]).toEqual([`${layout.A.width}px|${layout.A.width}px`]);
  });

  it('fades the full text into the summary once at summary height', () => {
    mount();
    scrollTo(310 + 24);
    const slot = slotFor('A')!;
    expect(slot.querySelector<HTMLElement>('.tb-chat-pinned-full')!.style.opacity).toBe('0.5');
    expect(slot.querySelector<HTMLElement>('.tb-chat-pinned-summary')!.style.opacity).toBe('0.5');
    // The summary sits at the bubble's visible top once the bubble is at summary height.
    expect(slot.querySelector<HTMLElement>('.tb-chat-pinned-summary')!.style.top).toBe('220px');
  });

  it('is pushed off by the next prompt and gives the original back when gone', () => {
    mount();
    scrollTo(950);
    expect(translate(slotFor('A'))).toBe(1000 - 950 - 8 - 80);
    scrollTo(1000);
    // Kept ready, unseen, in case the reader scrolls back.
    expect(slotFor('A')!.style.opacity).toBe('0');
    expect(slotFor('A')!.hasAttribute('data-pinned')).toBe(false);
    expect(rows.get('A')!.hasAttribute('data-pinned-original')).toBe(false);
    expect(slotFor('B')!.style.opacity).toBe('1');
  });

  it('lands in the state of the position after a jump, either way', () => {
    mount();
    scrollTo(1400);
    expect(slotFor('C')!.style.opacity).toBe('1');
    expect(slotFor('A')).toBeNull();
    scrollTo(200);
    expect(slotFor('C')?.style.opacity ?? '0').toBe('0');
    expect(rows.get('C')!.hasAttribute('data-pinned-original')).toBe(false);
    expect(translate(slotFor('A')?.querySelector<HTMLElement>('.tb-chat-pinned-body'))).toBe(-110);
  });

  it('jumps to the original and dismisses from the pinned copy', () => {
    const onJump = vi.fn();
    const onDismiss = vi.fn();
    mount({ onJump, onDismiss });
    scrollTo(500);
    const jump = screen.getByRole('button', { name: 'Jump to user prompt' });
    expect(jump.getAttribute('aria-controls')).toBe('target-A');
    fireEvent.click(jump);
    expect(onJump).toHaveBeenCalledWith(prompts[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss user prompt preview' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('says where a prompt settles at summary height, for placing a reply below it', () => {
    const handle = createRef<ScrollPinnedPromptsHandle>();
    render(<ScrollPinnedPrompts ref={handle} prompts={prompts} viewport={{ current: viewport }}
      getRow={key => rows.get(key)} onJump={() => {}} onDismiss={() => {}} />, { container: root });
    expect(handle.current!.settledBottom('A')).toBe(10 + summaryHeight);
    expect(handle.current!.settledBottom('B')).toBe(10 + layout.B.height);
    expect(handle.current!.settledBottom('missing')).toBeUndefined();
  });

  it('lets touches through to the transcript and treats a tap on the visible copy as a jump', () => {
    const onJump = vi.fn();
    mount({ onJump });
    scrollTo(500);
    const reply = document.createElement('a');
    reply.href = '#reply';
    viewport.firstElementChild!.append(reply);
    const replyClicked = vi.fn();
    reply.addEventListener('click', replyClicked);
    // Inside the pinned copy (x 120-360, y 10-90 at summary height): the jump wins.
    fireEvent.click(reply, { clientX: 200, clientY: 50, button: 0 });
    expect(onJump).toHaveBeenCalledWith(prompts[0]);
    expect(replyClicked).not.toHaveBeenCalled();
    // Below the copy, the tap belongs to the transcript.
    fireEvent.click(reply, { clientX: 200, clientY: 120, button: 0 });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(replyClicked).toHaveBeenCalledTimes(1);
  });

  it('keeps the copied bubble and summary out of reach of focus and screen readers while pinned', () => {
    rows.get('A')!.innerHTML = 'See <a href="#x">this link</a> <button type="button">Retry</button>';
    mount();
    scrollTo(200);
    const slot = slotFor('A')!;
    expect(slot.hasAttribute('data-pinned')).toBe(true);
    expect(slot.hasAttribute('inert')).toBe(false);
    for (const layer of ['.tb-chat-pinned-full', '.tb-chat-pinned-summary']) {
      const element = slot.querySelector<HTMLElement>(layer)!;
      expect(element.hasAttribute('inert')).toBe(true);
      expect(element.getAttribute('aria-hidden')).toBe('true');
    }
    expect(slot.querySelector('.tb-chat-pinned-full a')).not.toBeNull();
    // Only the jump and dismiss controls remain reachable.
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label')))
      .toEqual(expect.arrayContaining(['Jump to user prompt', 'Dismiss user prompt preview']));
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'this link' })).toBeNull();
  });

  it('shrinks a prompt with an image to its text summary even when the text is short', () => {
    rows.get('C')!.append(document.createElement('img'));
    const list = prompts.map(prompt => prompt.identity === 'send:C' ? { ...prompt, text: 'Look at this' } : prompt);
    mount({}, list);
    scrollTo(1290 + 50);
    // Taller than its one-line text: the bubble shortens with the scroll, clipping the image.
    expect(translate(slotFor('C')!.querySelector<HTMLElement>('.tb-chat-pinned-body'))).toBe(-50);
    scrollTo(1290 + 500);
    expect(translate(slotFor('C')!.querySelector<HTMLElement>('.tb-chat-pinned-body'))).toBe(-(layout.C.height - summaryHeight));
  });

  it('re-measures within the resize callback, so a push-off point is never a layout behind', () => {
    const callbacks: ResizeObserverCallback[] = [];
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
      observe() {} unobserve() {} disconnect() {} });
    try {
      mount();
      scrollTo(950);
      expect(translate(slotFor('A'))).toBe(1000 - 950 - 8 - 80);
      // The transcript above B grows shorter: B now sits 40px higher and pushes A sooner.
      const moved = layout as unknown as Record<string, { top: number; height: number; left: number; width: number }>;
      const original = moved.B;
      moved.B = { ...original, top: original.top - 40 };
      frames.mockClear();
      act(() => { for (const callback of callbacks) callback([], {} as ResizeObserver); });
      expect(translate(slotFor('A'))).toBe(960 - 950 - 8 - 80);
      expect(frames).not.toHaveBeenCalled();
      moved.B = original;
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('copies the bubble again when an inline style inside it changes, such as the prompt clamp height', async () => {
    const clip = document.createElement('div');
    clip.className = 'tb-chat-prompt-clamp-content';
    clip.style.maxHeight = '200px';
    clip.textContent = 'Clipped text';
    rows.get('A')!.replaceChildren(clip);
    mount();
    scrollTo(200);
    const copied = () => slotFor('A')!.querySelector<HTMLElement>('.tb-chat-pinned-full .tb-chat-prompt-clamp-content')!;
    expect(copied().style.maxHeight).toBe('200px');
    clip.style.maxHeight = '140px';
    await act(async () => { await Promise.resolve(); });
    expect(copied().style.maxHeight).toBe('140px');
  });

  it('keeps the copy at the bubble\'s current width when the bubble is resized and copied again', async () => {
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
      observe() {} unobserve() {} disconnect() {} });
    const clip = document.createElement('div');
    clip.className = 'tb-chat-prompt-clamp-content';
    clip.style.maxHeight = '200px';
    clip.textContent = 'Clipped text';
    rows.get('A')!.replaceChildren(clip);
    const moved = layout as unknown as Record<string, { top: number; height: number; left: number; width: number }>;
    const original = moved.A;
    try {
      mount();
      scrollTo(200);
      const copy = () => slotFor('A')!.querySelector<HTMLElement>('.tb-chat-pinned-full > .tb-chat-pinned-copy')!;
      expect(copy().style.width).toBe('240px');
      // The pane narrows: the bubble is re-measured at 180px...
      moved.A = { ...original, width: 180 };
      act(() => { for (const callback of callbacks) callback([], {} as ResizeObserver); });
      expect(slotFor('A')!.style.width).toBe('180px');
      expect(copy().style.width).toBe('180px');
      // ...and its clamp height changes, so the copy is taken again: still at the new width.
      clip.style.maxHeight = '260px';
      await act(async () => { await Promise.resolve(); });
      expect(copy().style.width).toBe('180px');
      expect(copy().querySelector<HTMLElement>('.tb-chat-prompt-clamp-content')!.style.maxHeight).toBe('260px');
    } finally {
      moved.A = original;
      vi.unstubAllGlobals();
    }
  });

  function measureNow() {
    // A resize anywhere in the transcript makes the layer measure again within the callback.
    act(() => { for (const callback of resizeObserverCallbacks()) callback([], {} as ResizeObserver); });
  }
  function resizeObserverCallbacks(): ResizeObserverCallback[] {
    return (globalThis as { __pinTestObservers?: ResizeObserverCallback[] }).__pinTestObservers ?? [];
  }

  it('measures correctly while scrollTop and the drawn position disagree (stretching past the end)', () => {
    observeResizes();
    mount();
    scrollTo(950);
    expect(translate(slotFor('A'))).toBe(1000 - 950 - 8 - 80);
    // Mid-stretch WebKit reports a scrollTop 150px beyond where the content is drawn, and a
    // resize lands at that moment.
    scrollTop = 1100;
    screenScroll = 950;
    measureNow();
    // The bounce settles where it was drawn; the same slots stay mounted (no re-measure).
    scrollTop = 950;
    screenScroll = undefined;
    act(() => { fireEvent.scroll(viewport); });
    expect(translate(slotFor('A'))).toBe(1000 - 950 - 8 - 80);
  });

  it('treats a position past either end as the end itself', () => {
    observeResizes();
    mount();
    scrollTo(2550);
    // C, the latest prompt, is pinned at its summary exactly as at the end (2400).
    const atEnd = translate(slotFor('C'));
    scrollTo(2400);
    expect(translate(slotFor('C'))).toBe(atEnd);
    scrollTo(-80);
    expect(slotFor('A')?.style.opacity ?? '0').toBe('0');
  });

  it('keeps every prompt in place when the end-of-chat padding toggles while scrolled to the end', () => {
    observeResizes();
    mount();
    scrollTo(950);
    for (const extra of [24, 0, 24, 0]) {
      // The scroll-to-latest control adds and removes bottom padding: the end moves, the prompts do not.
      extraHeight = extra;
      screenScroll = 950 + extra / 2;
      scrollTop = 950 + extra;
      measureNow();
      scrollTo(950);
      screenScroll = undefined;
      act(() => { fireEvent.scroll(viewport); });
      expect(translate(slotFor('A'))).toBe(1000 - 950 - 8 - 80);
    }
  });

  it('does not drift over a long streamed reply, however positions read while it streams', () => {
    observeResizes();
    mount();
    for (let update = 0; update < 60; update++) {
      // Each update resizes the transcript; the reader is mid-scroll, sometimes past the end.
      scrollTop = 900 + (update % 7) * 13 + (update % 5 === 0 ? 1800 : 0);
      screenScroll = Math.min(scrollTop, 2400) - (update % 3) * 4;
      measureNow();
    }
    screenScroll = undefined;
    scrollTo(950);
    expect(translate(slotFor('A'))).toBe(1000 - 950 - 8 - 80);
    scrollTo(991);
    expect(slotFor('B')!.style.opacity).toBe('1');
    expect(translate(slotFor('B'))).toBe(10);
  });

  it('gives the original back when it unmounts', () => {
    const result = mount();
    scrollTo(500);
    expect(rows.get('A')!.hasAttribute('data-pinned-original')).toBe(true);
    result.unmount();
    expect(rows.get('A')!.hasAttribute('data-pinned-original')).toBe(false);
  });
});

describe('scroll-pinned prompts with scroll timelines', () => {
  it('hands the layout to the browser as scroll-driven keyframes and runs nothing per frame', () => {
    class FakeScrollTimeline { constructor(readonly options: unknown) {} }
    (globalThis as { ScrollTimeline?: unknown }).ScrollTimeline = FakeScrollTimeline;
    const calls: Array<{ element: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions }> = [];
    const animate = vi.fn(function (this: Element, keyframes: Keyframe[], timing: KeyframeAnimationOptions) {
      calls.push({ element: this, keyframes, options: timing });
      return { cancel: vi.fn() } as unknown as Animation;
    });
    Element.prototype.animate = animate as unknown as Element['animate'];
    const lastCall = (match: (call: (typeof calls)[number]) => boolean) => [...calls].reverse().find(match);
    mount();
    scrollTo(500);
    const slot = slotFor('A')!;
    const slotCall = lastCall(call => call.element === slot)!;
    const expected = pinnedPromptKeyframes(geometry, 0, options);
    expect(slotCall.options.timeline).toBeInstanceOf(FakeScrollTimeline);
    expect(slotCall.options).toMatchObject({ rangeStart: `${expected[0].scrollTop}px`,
      rangeEnd: `${expected.at(-1)!.scrollTop}px`, fill: 'none' });
    expect(slotCall.keyframes.map((frame: Keyframe) => frame.transform))
      .toEqual(expected.map(stop => `translateY(${stop.frame.top}px)`));
    const rowCall = lastCall(call => call.element === rows.get('A'))!;
    expect(rowCall.keyframes.every((frame: Keyframe) => frame.opacity === 0)).toBe(true);
    // No style is written on scroll; the browser applies the animations.
    expect(slot.style.transform).toBe('');
    const before = calls.length;
    scrollTo(520);
    expect(calls.length).toBe(before);
    // The latest prompt holds its pinned state from its last keyframe on.
    scrollTo(1400);
    const latest = lastCall(call => call.element === slotFor('C'))!;
    expect(latest.options.fill).toBe('forwards');
  });
});
