/**
 * Where a pinned user prompt is drawn, as a pure function of the scroll position.
 *
 * The rules (wi_181ae343):
 * 1. A prompt scrolls normally until its top reaches the pin line.
 * 2. A prompt no taller than its summary pins at once and does not shrink.
 * 3. A taller prompt keeps its top at the pin line while its bottom moves with the
 *    scroll, so it gets shorter; its full text keeps scrolling up inside, clipped at
 *    the top edge.
 * 4. It stops shrinking at its summary height, then the full text fades into the summary.
 * 5. Width never changes (nothing here describes width).
 * 6. The next prompt pushes a pinned prompt up and off, exactly with the scroll.
 * 7. Scrolling back is the mirror image.
 * 8. However the surface scrolls, or jumps, the prompt is in the state these rules give
 *    for the position.
 *
 * Rules 7 and 8 hold because every output depends only on the scroll position and the
 * geometry, never on the direction or history of scrolling.
 *
 * Coordinates: a prompt's `top` is its natural top in scroll-content coordinates, so its
 * natural top inside the scrollport is `top - scrollTop`. Frame values are in scrollport
 * coordinates (0 is the scrollport's top edge).
 */

export interface PinnedPromptGeometry {
  /** Natural top of the bubble in scroll-content coordinates. */
  readonly top: number;
  /** Full natural height of the bubble. */
  readonly height: number;
  /**
   * Height of the bubble showing its summary (one to three lines plus padding).
   * Values above `height` are treated as `height`: such a prompt is already at
   * pinned size.
   */
  readonly summaryHeight: number;
}

export interface PinnedPromptOptions {
  /** The pin line, in scrollport coordinates. */
  readonly pinLine: number;
  /** Scroll distance over which the full text fades into the summary. */
  readonly fadeDistance: number;
  /**
   * Space kept between a pinned prompt's bottom and the next prompt's top while the
   * next prompt pushes it. Never more than the natural space between them.
   */
  readonly pushGap: number;
}

export type PinnedPromptPhase =
  /** Top at the pin line, getting shorter as the scroll moves. */
  | 'shrinking'
  /** At summary height; the full text is fading into the summary. */
  | 'fading'
  /** At summary height and showing the summary (or a short prompt at its own height). */
  | 'pinned'
  /** Being pushed up by the next prompt. */
  | 'pushed';

export interface PinnedPromptFrame {
  /** Index of the prompt in the list passed in. */
  readonly index: number;
  readonly phase: PinnedPromptPhase;
  /** Top of the visible bubble, in scrollport coordinates. */
  readonly top: number;
  /** Height of the visible bubble. */
  readonly height: number;
  /**
   * Position of the full text's top relative to the visible bubble's top. Zero or
   * negative: the text above the bubble's top edge is clipped away.
   */
  readonly innerOffset: number;
  /** 0 shows the full text, 1 shows the summary. */
  readonly fade: number;
}

/** Scroll positions where a prompt's frame changes from one straight-line segment to the next. */
export interface PinnedPromptBreakpoints {
  /** At and before this scroll position the prompt is in its natural place. */
  readonly pin: number;
  /** Shrinking ends here. Equal to `pin` for a prompt no taller than its summary. */
  readonly shrinkEnd: number;
  /** The fade is complete here. Equal to `shrinkEnd` when there is nothing to fade. */
  readonly fadeEnd: number;
  /** The next prompt starts pushing here; Infinity when there is no next prompt. */
  readonly pushStart: number;
  /** From here on the prompt is entirely above the scrollport; Infinity when there is no next prompt. */
  readonly gone: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The summary height actually used: at least 0, never more than the full height. */
export function effectiveSummaryHeight(prompt: PinnedPromptGeometry): number {
  const height = Math.max(0, finiteOr(prompt.height, 0));
  return clamp(finiteOr(prompt.summaryHeight, height), 0, height);
}

/**
 * The pin line this prompt uses. A prompt whose natural top is already above the pin
 * line at scroll position 0 pins at its natural top instead, so nothing is ever drawn
 * below its natural place.
 */
function promptPinLine(prompt: PinnedPromptGeometry, options: PinnedPromptOptions): number {
  return Math.min(options.pinLine, prompt.top);
}

function pushGapBefore(prompt: PinnedPromptGeometry, next: PinnedPromptGeometry, options: PinnedPromptOptions): number {
  const naturalGap = next.top - (prompt.top + prompt.height);
  return clamp(Math.min(options.pushGap, naturalGap), 0, Math.max(0, options.pushGap));
}

export function pinnedPromptBreakpoints(prompts: readonly PinnedPromptGeometry[], index: number,
  options: PinnedPromptOptions): PinnedPromptBreakpoints {
  const prompt = prompts[index];
  const height = Math.max(0, prompt.height);
  const summary = effectiveSummaryHeight(prompt);
  const line = promptPinLine(prompt, options);
  const pin = prompt.top - line;
  const shrinkEnd = pin + (height - summary);
  const fadeEnd = height > summary ? shrinkEnd + Math.max(0, options.fadeDistance) : shrinkEnd;
  const next = prompts[index + 1];
  if (!next) return { pin, shrinkEnd, fadeEnd, pushStart: Infinity, gone: Infinity };
  const gap = pushGapBefore(prompt, next, options);
  // Pushing starts when the next prompt's top, less the gap, reaches the pinned bottom.
  // Before shrinking ends the bottom is the natural bottom, which is never closer than
  // the natural gap, so pushing can only start once the prompt is at summary height.
  const pushStart = Math.max(shrinkEnd, next.top - gap - line - summary);
  // Once pushed, the bottom is the next prompt's top less the gap; it is gone at 0.
  const gone = Math.max(pushStart, next.top - gap);
  return { pin, shrinkEnd, fadeEnd, pushStart, gone };
}

type FrameValues = Omit<PinnedPromptFrame, 'phase' | 'index'>;

/** The frame values at `scrollTop`, without checking whether the prompt is pinned there. */
function frameValues(scrollTop: number, prompts: readonly PinnedPromptGeometry[], index: number,
  options: PinnedPromptOptions, points: PinnedPromptBreakpoints): FrameValues {
  const prompt = prompts[index];
  const height = Math.max(0, prompt.height);
  const summary = effectiveSummaryHeight(prompt);
  const line = promptPinLine(prompt, options);
  const visibleHeight = height - clamp(scrollTop - points.pin, 0, height - summary);
  const next = prompts[index + 1];
  const top = next
    ? Math.min(line, next.top - scrollTop - pushGapBefore(prompt, next, options) - visibleHeight)
    : line;
  // A prompt no taller than its summary shows the same text either way: nothing to fade.
  const fade = height <= summary ? 0
    : points.fadeEnd > points.shrinkEnd
      ? clamp((scrollTop - points.shrinkEnd) / (points.fadeEnd - points.shrinkEnd), 0, 1)
      : scrollTop >= points.shrinkEnd ? 1 : 0;
  return { top, height: visibleHeight, innerOffset: visibleHeight - height, fade };
}

/**
 * The prompt's frame at `scrollTop`, or undefined while it is in its natural place or
 * after it has been pushed entirely above the scrollport.
 */
export function pinnedPromptFrameAt(scrollTop: number, prompts: readonly PinnedPromptGeometry[], index: number,
  options: PinnedPromptOptions): PinnedPromptFrame | undefined {
  const prompt = prompts[index];
  if (!prompt || !Number.isFinite(scrollTop)) return undefined;
  const points = pinnedPromptBreakpoints(prompts, index, options);
  if (scrollTop <= points.pin || scrollTop >= points.gone) return undefined;
  const values = frameValues(scrollTop, prompts, index, options, points);
  const phase: PinnedPromptPhase = values.top < promptPinLine(prompt, options) ? 'pushed'
    : scrollTop < points.shrinkEnd ? 'shrinking'
      : values.fade > 0 && values.fade < 1 ? 'fading' : 'pinned';
  return { index, phase, ...values };
}

/**
 * Every prompt drawn away from its natural place at `scrollTop`, oldest first. At most
 * one of them is at the pin line; any others are being pushed off above it.
 */
export function pinnedPromptFrames(scrollTop: number, prompts: readonly PinnedPromptGeometry[],
  options: PinnedPromptOptions): PinnedPromptFrame[] {
  if (!Number.isFinite(scrollTop) || prompts.length === 0) return [];
  // Prompts are in transcript order, so their pin positions only increase. Find the
  // last prompt that has started pinning, then walk back over any still being pushed off.
  let low = 0;
  let high = prompts.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (pinnedPromptBreakpoints(prompts, middle, options).pin < scrollTop) low = middle + 1;
    else high = middle;
  }
  const frames: PinnedPromptFrame[] = [];
  for (let index = low - 1; index >= 0; index--) {
    const frame = pinnedPromptFrameAt(scrollTop, prompts, index, options);
    if (!frame) break;
    frames.unshift(frame);
  }
  return frames;
}

/**
 * The frame values at each breakpoint, in scroll order. Between two consecutive entries
 * every value changes linearly with the scroll position, so interpolating them
 * reproduces `pinnedPromptFrameAt` exactly. A renderer can hand these to the browser as
 * scroll-driven keyframes. The first entry is the natural place (where the prompt starts
 * pinning) and the last is where it leaves the scrollport; infinite breakpoints are
 * omitted, so for the latest prompt the last entry holds from then on.
 */
export function pinnedPromptKeyframes(prompts: readonly PinnedPromptGeometry[], index: number,
  options: PinnedPromptOptions): Array<{ readonly scrollTop: number; readonly frame: FrameValues }> {
  const points = pinnedPromptBreakpoints(prompts, index, options);
  const positions = [...new Set([points.pin, points.shrinkEnd, points.fadeEnd, points.pushStart, points.gone]
    .filter(Number.isFinite))].sort((a, b) => a - b);
  return positions.map(scrollTop => ({ scrollTop, frame: frameValues(scrollTop, prompts, index, options, points) }));
}
