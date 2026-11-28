import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageAttachments } from '../src/MessageAttachments';
import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinnedPromptFrameAt } from '../src/pinnedPromptLayout';
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
let paneWidth = 800;
let responsiveSummary = false;
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
  paneWidth = 800;
  responsiveSummary = false;
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
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, get: () => paneWidth });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === viewport || this === root) return rect(0, 600);
    if (this === viewport.firstElementChild) return rect(-drawnScroll(), SCROLL_HEIGHT);
    const key = this.dataset.scrollKey as keyof typeof layout | undefined;
    if (key && rows.get(key) === this) {
      const box = layout[key];
      return rect(box.top - drawnScroll(), box.height, box.left, box.width);
    }
    if (this.classList.contains('tb-chat-pinned-summary-measure')) {
      const narrow = this.parentElement?.style.getPropertyValue('--tb-chat-pinned-summary-lines') === '1';
      return rect(0, responsiveSummary && narrow ? 60 : summaryHeight);
    }
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
  it.each(['', 'Text alongside the photo'])('keeps a prompt photo available in the settled summary (%j)', text => {
    const photo = { filename: 'sample.png', mimeType: 'image/png', data: 'YQ==' };
    render(<MessageAttachments attachments={[photo]} />, { container: rows.get('A')! });
    mount({}, prompts.map(prompt => prompt.scrollKey === 'A' ? { ...prompt, text } : prompt));
    scrollTo(500);
    const strip = slotFor('A')!.querySelector<HTMLElement>('.tb-chat-pinned-photos')!;
    const thumbnail = strip.querySelector('button')!;
    expect(thumbnail.getAttribute('aria-label')).toBe('Enlarge Image: sample.png');
    expect(thumbnail.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,YQ==');
    expect(strip.hasAttribute('inert')).toBe(false);
    fireEvent.click(thumbnail);
    expect(screen.getByRole('dialog', { name: 'Image: sample.png' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close image preview' }));
    expect(document.activeElement).toBe(thumbnail);
    scrollTo(90);
    expect(strip.hasAttribute('inert')).toBe(true);
  });

  it('reuses a delayed authorized photo without changing the measured summary', async () => {
    let resolve!: (blob: Blob) => void;
    const read = vi.fn(() => new Promise<Blob>(done => { resolve = done; }));
    vi.stubGlobal('URL', Object.assign(class extends URL {}, {
      createObjectURL: () => 'blob:pinned-photo', revokeObjectURL: vi.fn(),
    }));
    render(<MessageAttachments attachments={[
      { filename: 'ready.png', mimeType: 'image/png', data: 'YQ==' },
      { assetId: 'photo', filename: 'sample.png', mimeType: 'image/png', size: 1 },
    ]} readAttachment={read} />, { container: rows.get('A')! });
    const handle = createRef<ScrollPinnedPromptsHandle>();
    render(<ScrollPinnedPrompts ref={handle} prompts={prompts} viewport={{ current: viewport }}
      getRow={key => rows.get(key)} onJump={() => {}} onDismiss={() => {}} />, { container: root });
    scrollTo(500);
    const strip = slotFor('A')!.querySelector<HTMLElement>('.tb-chat-pinned-photos')!;
    expect(strip.hidden).toBe(false);
    expect(strip.querySelectorAll('button')).toHaveLength(1);
    const readyThumbnail = strip.querySelector('button')!;
    fireEvent.click(readyThumbnail);
    expect(screen.getByRole('dialog', { name: 'Image: ready.png' })).toBeTruthy();
    const settled = handle.current?.settledBottom('A');
    await act(async () => { await Promise.resolve(); resolve(new Blob(['x'], { type: 'image/png' })); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(strip.querySelectorAll('img')[1]?.getAttribute('src')).toBe('blob:pinned-photo');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(strip.querySelector('button')).toBe(readyThumbnail);
    expect(document.activeElement).toBe(readyThumbnail);
    expect(handle.current?.settledBottom('A')).toBe(settled);
  });

  it('remeasures compressed text when the pane crosses the line-cap breakpoint', () => {
    responsiveSummary = true;
    observeResizes();
    const handle = createRef<ScrollPinnedPromptsHandle>();
    render(<ScrollPinnedPrompts ref={handle} prompts={prompts} viewport={{ current: viewport }}
      getRow={key => rows.get(key)} onJump={() => {}} onDismiss={() => {}} />, { container: root });
    const layer = root.querySelector<HTMLElement>('.tb-chat-pinned-layer')!;
    scrollTo(500);
    const scrollBody = slotFor('A')!.querySelector<HTMLElement>('.tb-chat-pinned-body');
    const check = (lines: string, height: number) => {
      expect(layer.style.getPropertyValue('--tb-chat-pinned-summary-lines')).toBe(lines);
      expect(handle.current!.settledBottom('A')).toBe(10 + height);
      expect(translate(scrollBody)).toBe(-(layout.A.height - height));
      expect(slotFor('A')!.style.width).toBe('240px');
    };
    check('2', 80);
    for (const [width, lines, height] of [[540, '1', 60], [541, '2', 80]] as const) {
      paneWidth = width;
      const observers = (globalThis as { __pinTestObservers?: ResizeObserverCallback[] }).__pinTestObservers;
      act(() => observers?.forEach(observer => observer([], {} as ResizeObserver)));
      check(lines, height);
    }
  });

  it('leaves prompts in their natural place until the top reaches the pin line', () => {
    mount();
    scrollTo(90);
    expect(slotFor('A')?.hasAttribute('data-pinned')).toBe(false);
    expect(slotFor('A')?.getAttribute('aria-hidden')).toBe('true');
    expect(rows.get('A')!.hasAttribute('data-pinned-original')).toBe(false);
  });

  it('draws a copy at the bubble position and width, shortening with the scroll, and hides the original', () => {
    mount();
    scrollTo(190);
    const slot = slotFor('A')!;
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
    expect(slotFor('A')!.hasAttribute('data-pinned')).toBe(false);
    expect(rows.get('A')!.hasAttribute('data-pinned-original')).toBe(false);
    expect(slotFor('B')!.hasAttribute('data-pinned')).toBe(true);
  });

  it('lands in the state of the position after a jump, either way', () => {
    mount();
    scrollTo(1400);
    expect(slotFor('C')!.hasAttribute('data-pinned')).toBe(true);
    expect(slotFor('A')).toBeNull();
    scrollTo(200);
    expect(slotFor('C')?.hasAttribute('data-pinned') ?? false).toBe(false);
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

  it('routes a tap through the pinned copy and leaves drags and keyboard clicks to the transcript', () => {
    const onJump = vi.fn();
    mount({ onJump });
    root.append(viewport);
    scrollTo(500);
    const reply = document.createElement('button');
    viewport.firstElementChild!.append(reply);
    const replyClicked = vi.fn();
    reply.addEventListener('click', replyClicked);
    const pointer = (type: string, x: number, y: number) => {
      fireEvent(reply, new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
    };
    const click = (x: number, y: number, detail = 1) => fireEvent.click(reply, { clientX: x, clientY: y, button: 0, detail });

    // The summary spans x 120–360 and y 10–90. Preserve a drag that enters it,
    // including one that crosses it and comes back to the press position.
    pointer('pointerdown', 200, 120);
    pointer('pointermove', 200, 50);
    click(200, 50);
    pointer('pointerdown', 200, 50);
    pointer('pointermove', 243, 50);
    pointer('pointermove', 200, 50);
    click(200, 50);
    pointer('pointerdown', 200, 50);
    pointer('pointercancel', 200, 50);
    click(200, 50);
    click(200, 50, 0);
    expect(onJump).not.toHaveBeenCalled();
    expect(replyClicked).toHaveBeenCalledTimes(4);

    pointer('pointerdown', 200, 50);
    click(200, 50);
    expect(onJump).toHaveBeenCalledWith(prompts[0]);
    expect(replyClicked).toHaveBeenCalledTimes(4);
  });

  it('keeps the copied bubble and summary text out of reach of focus and screen readers while pinned', () => {
    rows.get('A')!.innerHTML = 'See <a href="#x">this link</a> <button type="button">Retry</button>';
    mount();
    scrollTo(200);
    const slot = slotFor('A')!;
    expect(slot.hasAttribute('data-pinned')).toBe(true);
    expect(slot.hasAttribute('inert')).toBe(false);
    for (const layer of ['.tb-chat-pinned-full', '.tb-chat-pinned-summary-text']) {
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

  it('measures a row in its place in the flow while its arrival slide is running', () => {
    observeResizes();
    mount();
    scrollTo(950);
    expect(translate(slotFor('A'))).toBe(1000 - 950 - 8 - 80);
    // B is mid-slide: drawn 18px below its place, with a running animation.
    const b = rows.get('B')!;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    const drawn = spy.getMockImplementation()!;
    spy.mockImplementation(function (this: HTMLElement) {
      const r = drawn.call(this);
      return this === b ? rect(r.top + 18, r.height, r.left, r.width) : r;
    });
    b.style.transform = 'translateY(18px)';
    (b as HTMLElement & { getAnimations: () => Animation[] }).getAnimations = () =>
      [{ playState: 'running', finished: new Promise(() => {}) } as unknown as Animation];
    if (typeof (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly !== 'function') {
      vi.stubGlobal('DOMMatrixReadOnly', class { m42: number; constructor(value: string) {
        this.m42 = Number.parseFloat(value.match(/translateY\((-?[\d.]+)px\)/)?.[1] ?? value.split(',')[5] ?? '0'); } });
    }
    measureNow();
    act(() => { fireEvent.scroll(viewport); });
    // A is pushed by B's place in the flow, not where the slide currently draws it.
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
    expect(slotFor('A')?.hasAttribute('data-pinned') ?? false).toBe(false);
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
    expect(slotFor('B')!.hasAttribute('data-pinned')).toBe(true);
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
    const rowCall = lastCall(call => call.element === rows.get('A'))!;
    expect(slotCall.options.timeline).toBeInstanceOf(FakeScrollTimeline);
    // One range for every animation, far beyond the conversation, so the timeline never
    // reaches an animation's end (WebKit shows the last keyframe there).
    expect(slotCall.options).toMatchObject({ rangeStart: '0px', rangeEnd: '10000000px' });
    expect(slotCall.options.fill).toBeUndefined();
    // Evaluate the keyframes as a browser would at a scroll position (linear between stops,
    // the later stop winning where two share an offset).
    const sample = (keyframes: Keyframe[], property: 'top' | 'filter', scrollTop: number) => {
      const at = scrollTop / 1e7;
      let index = keyframes.length - 1;
      for (let i = 0; i < keyframes.length; i++) if ((keyframes[i].offset as number) > at) { index = i; break; }
      const to = keyframes[index];
      const from = keyframes[Math.max(0, index - 1)];
      const value = (frame: Keyframe) => property === 'filter' ? Number.parseFloat(String(frame.filter).match(/opacity\(([\d.]+)\)/)![1])
        : Number.parseFloat(String(frame.top));
      if ((to.offset as number) <= at || from === to) return value(to);
      const t = (at - (from.offset as number)) / ((to.offset as number) - (from.offset as number));
      return value(from) + (value(to) - value(from)) * t;
    };
    // 90 is exactly A's pin point, where the model still has it in its natural place.
    for (const scrollTop of [0, 89, 90, 90.5, 150, 330, 600, 950, 991, 1500, 2400]) {
      const frame = pinnedPromptFrameAt(scrollTop, geometry, 0, options);
      expect(sample(rowCall.keyframes, 'filter', scrollTop)).toBeCloseTo(frame ? 0 : 1, 6);
      if (frame) expect(sample(slotCall.keyframes, 'top', scrollTop)).toBeCloseTo(frame.top, 4);
    }
    // Whether the copy is seen is never animated. WebKit can leave a scroll-driven opacity
    // unpainted during wheel scrolling (the prompt vanished), and a discrete property could
    // switch a hair before the pin point (the copy and its dismiss button showed while the
    // original still owned the pin line). It follows the pin state instead (next test).
    for (const call of calls.filter(call => call.element === slot)) {
      expect(call.keyframes.every(frame => frame.opacity === undefined && frame.visibility === undefined)).toBe(true);
    }
    // Hiding the original never touches its opacity, which Chat animates for its arrival fade.
    expect(rowCall.keyframes.every((frame: Keyframe) => frame.opacity === undefined)).toBe(true);
    // At the very end of the scroll range the earlier prompt's original is back in view.
    expect(sample(rowCall.keyframes, 'filter', 1e7)).toBe(1);
    // The absolute position is animated by the browser. A scroll-driven compositor
    // transform can be painted behind the incoming prompt's actual scroll position.
    expect(slotCall.keyframes.every(frame => frame.transform === undefined)).toBe(true);
    expect(slot.style.top).toBe('');
    expect(slot.style.transform).toBe('');
    const before = calls.length;
    scrollTo(520);
    expect(calls.length).toBe(before);
    // The latest prompt holds its pinned state from its last keyframe on.
    scrollTo(1400);
    // The latest prompt holds its pinned position to the end of the range.
    const latest = lastCall(call => call.element === slotFor('C'))!;
    expect(latest.keyframes.at(-1)!.offset).toBe(1);
  });

  it('shows the copy exactly while the model has the prompt pinned, as when it can be pressed', () => {
    class FakeScrollTimeline { constructor(readonly options: unknown) {} }
    (globalThis as { ScrollTimeline?: unknown }).ScrollTimeline = FakeScrollTimeline;
    Element.prototype.animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation) as unknown as Element['animate'];
    mount();
    // Fractional positions either side of A's pin point (90) and push-off (992), where a
    // scroll-driven switch would land on either side depending on the browser's rounding.
    for (const position of [0, 89.99, 90, 90.001, 90.4, 500, 991.99, 992, 992.01, 600, 90.001, 90, 13]) {
      scrollTo(position);
      const pinned = !!pinnedPromptFrameAt(position, geometry, 0, options);
      const slot = slotFor('A');
      expect(slot?.hasAttribute('data-pinned') ?? false, `copy at ${position}`).toBe(pinned);
      if (slot) expect(slot.hasAttribute('inert'), `inert at ${position}`).toBe(!pinned);
    }
  });
});

describe('scroll-pinned prompt styles', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/style.css'), 'utf8');
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  };

  it('shows a copy only while pinned, and nothing inside a waiting copy', () => {
    expect(rule('.tb-chat-pinned-slot')).toMatch(/visibility:\s*hidden/);
    expect(rule('.tb-chat-pinned-slot')).not.toMatch(/opacity/);
    expect(rule('.tb-chat-pinned-slot[data-pinned]')).toMatch(/visibility:\s*visible/);
    // A copied message can set its own visibility, on an element or a generated ::after box
    // (a host's renderMessage, for one); a waiting copy must paint none of it. Opacity on the
    // copy as a whole covers both, where a descendant visibility rule cannot reach pseudo-elements.
    expect(rule('.tb-chat-pinned-slot:not([data-pinned])')).toMatch(/opacity:\s*0\s*;/);
    expect(css).not.toMatch(/\.tb-chat-pinned-slot:not\(\[data-pinned\]\)\s+\*/);
    // Never animated: the copy's own keyframes carry position only (see above).
    expect(rule('.tb-chat-pinned-slot[data-pinned]')).not.toMatch(/opacity/);
    expect(rule('.tb-chat-bubble[data-pinned-original]')).toMatch(/filter:\s*opacity\(0\)/);
  });
});
