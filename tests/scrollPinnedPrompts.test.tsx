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
let root: HTMLElement;
let viewport: HTMLElement;
const rows = new Map<string, HTMLElement>();

function rect(top: number, height: number, left = 0, width = 400): DOMRect {
  return { top, bottom: top + height, left, right: left + width, width, height, x: left, y: top,
    toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  scrollTop = 0;
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
    const key = this.dataset.scrollKey as keyof typeof layout | undefined;
    if (key && rows.get(key) === this) {
      const box = layout[key];
      return rect(box.top - scrollTop, box.height, box.left, box.width);
    }
    if (this.classList.contains('tb-chat-pinned-summary-measure')) return rect(0, summaryHeight);
    return rect(0, 0);
  });
  // The summary probe reports three clamped lines; long text is cut, the short prompt is not.
  const isProbeText = (element: HTMLElement) => element.classList.contains('tb-chat-pinned-summary-text') &&
    !!element.parentElement?.classList.contains('tb-chat-pinned-summary-measure');
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
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
  Element.prototype.animate = originalAnimate;
  root.remove();
  rows.clear();
  vi.restoreAllMocks();
  delete (globalThis as { ScrollTimeline?: unknown }).ScrollTimeline;
});

function mount(handlers: { onJump?: (prompt: ScrollPinnedPrompt) => void; onDismiss?: () => void } = {}) {
  const viewportRef = { current: viewport };
  const result = render(<ScrollPinnedPrompts prompts={prompts} viewport={viewportRef}
    getRow={key => rows.get(key)} onJump={handlers.onJump ?? (() => {})} onDismiss={handlers.onDismiss ?? (() => {})} />,
  { container: root });
  return result;
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
    expect(rows.get('A')!.style.opacity).toBe('');
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
    expect(rows.get('A')!.style.opacity).toBe('0');
    expect(slot.hasAttribute('data-pinned')).toBe(true);
    expect(slot.hasAttribute('aria-hidden')).toBe(false);
    expect(slot.querySelector('.tb-chat-pinned-full')!.textContent).toBe('Bubble A');
    expect(slot.querySelector('.tb-chat-pinned-full [id]')).toBeNull();
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
    expect(slotFor('A')).toBeNull();
    expect(rows.get('A')!.style.opacity).toBe('');
    expect(slotFor('B')!.style.opacity).toBe('1');
  });

  it('lands in the state of the position after a jump, either way', () => {
    mount();
    scrollTo(1400);
    expect(slotFor('C')!.style.opacity).toBe('1');
    expect(slotFor('A')).toBeNull();
    scrollTo(200);
    expect(slotFor('C')?.style.opacity ?? '0').toBe('0');
    expect(rows.get('C')!.style.opacity).toBe('');
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

  it('gives the original back when it unmounts', () => {
    const result = mount();
    scrollTo(500);
    expect(rows.get('A')!.style.opacity).toBe('0');
    result.unmount();
    expect(rows.get('A')!.style.opacity).toBe('');
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
