import { describe, expect, it } from 'vitest';
import {
  pinnedPromptBreakpoints, pinnedPromptFrameAt, pinnedPromptFrames, pinnedPromptKeyframes,
  type PinnedPromptFrame, type PinnedPromptGeometry, type PinnedPromptOptions,
} from '../src/pinnedPromptLayout';

const options: PinnedPromptOptions = { pinLine: 10, fadeDistance: 40, pushGap: 8 };

// A: a tall prompt (300px, 80px summary). B: a short one-line prompt, already at its
// summary size. C: another tall prompt. Agent replies fill the space between them.
const tall: PinnedPromptGeometry = { top: 100, height: 300, summaryHeight: 80 };
const short: PinnedPromptGeometry = { top: 1000, height: 60, summaryHeight: 80 };
const later: PinnedPromptGeometry = { top: 1300, height: 200, summaryHeight: 80 };
const prompts = [tall, short, later];

const frameAt = (scrollTop: number, index: number) => pinnedPromptFrameAt(scrollTop, prompts, index, options);
const naturalTop = (prompt: PinnedPromptGeometry, scrollTop: number) => prompt.top - scrollTop;
const bottom = (frame: PinnedPromptFrame) => frame.top + frame.height;

describe('pinned prompt layout', () => {
  it('rule 1: a prompt scrolls normally until its top reaches the pin line', () => {
    for (const scrollTop of [0, 40, 89.5, 90]) {
      expect(frameAt(scrollTop, 0)).toBeUndefined();
      expect(pinnedPromptFrames(scrollTop, prompts, options)).toEqual([]);
    }
    expect(naturalTop(tall, 90)).toBe(options.pinLine);
    const justPinned = frameAt(91, 0)!;
    expect(justPinned.top).toBe(options.pinLine);
    expect(justPinned.height).toBe(299);
  });

  it('rule 2: a prompt no taller than its summary pins at once and never shrinks or fades', () => {
    const { pin, shrinkEnd, fadeEnd } = pinnedPromptBreakpoints(prompts, 1, options);
    expect(pin).toBe(990);
    expect(shrinkEnd).toBe(pin);
    expect(fadeEnd).toBe(pin);
    for (const scrollTop of [991, 1000, 1100, 1200]) {
      const frame = frameAt(scrollTop, 1)!;
      expect(frame).toMatchObject({ phase: 'pinned', top: 10, height: 60, innerOffset: 0, fade: 0 });
    }
  });

  it('rule 3: a taller prompt keeps its top at the pin line while its bottom and text move with the scroll', () => {
    let previous: PinnedPromptFrame | undefined;
    for (let scrollTop = 91; scrollTop < 310; scrollTop += 7) {
      const frame = frameAt(scrollTop, 0)!;
      expect(frame.phase).toBe('shrinking');
      expect(frame.top).toBe(options.pinLine);
      // The bottom is the prompt's natural bottom.
      expect(bottom(frame)).toBeCloseTo(tall.top + tall.height - scrollTop, 9);
      // The full text sits where it naturally would, clipped above the bubble's top.
      expect(frame.top + frame.innerOffset).toBeCloseTo(naturalTop(tall, scrollTop), 9);
      expect(frame.innerOffset).toBeLessThanOrEqual(0);
      expect(frame.fade).toBe(0);
      if (previous) expect(frame.height).toBeLessThan(previous.height);
      previous = frame;
    }
  });

  it('rule 4: it stops at summary height, then the full text fades into the summary', () => {
    const { shrinkEnd, fadeEnd } = pinnedPromptBreakpoints(prompts, 0, options);
    expect(shrinkEnd).toBe(310);
    expect(fadeEnd).toBe(350);
    expect(frameAt(shrinkEnd, 0)).toMatchObject({ height: 80, innerOffset: -220, fade: 0 });
    expect(frameAt(330, 0)).toMatchObject({ phase: 'fading', top: 10, height: 80, innerOffset: -220, fade: .5 });
    expect(frameAt(fadeEnd, 0)).toMatchObject({ phase: 'pinned', height: 80, fade: 1 });
    for (const scrollTop of [400, 600, 900]) {
      expect(frameAt(scrollTop, 0)).toMatchObject({ phase: 'pinned', top: 10, height: 80, innerOffset: -220, fade: 1 });
    }
  });

  it('rule 5: frames describe height and position only; width is never part of the result', () => {
    const frame = frameAt(200, 0)!;
    expect(Object.keys(frame).sort()).toEqual(['fade', 'height', 'index', 'innerOffset', 'phase', 'top']);
  });

  it('rule 6: the next prompt pushes the pinned one up and off exactly with the scroll', () => {
    const { pushStart, gone } = pinnedPromptBreakpoints(prompts, 0, options);
    // Pushing starts when the next prompt's top is the gap below the pinned bottom.
    expect(pushStart).toBe(short.top - options.pushGap - options.pinLine - 80);
    expect(frameAt(pushStart, 0)!.top).toBe(options.pinLine);
    for (let scrollTop = pushStart + 1; scrollTop < gone; scrollTop += 5) {
      const frame = frameAt(scrollTop, 0)!;
      expect(frame.phase).toBe('pushed');
      expect(frame.height).toBe(80);
      // Exactly with the scroll: a 1px scroll moves it 1px, and it stays the gap above the next prompt.
      expect(frame.top - frameAt(scrollTop - 1, 0)!.top).toBeCloseTo(-1, 9);
      expect(bottom(frame)).toBeCloseTo(naturalTop(short, scrollTop) - options.pushGap, 9);
    }
    expect(frameAt(gone, 0)).toBeUndefined();
    expect(bottom(frameAt(gone - .5, 0)!)).toBeCloseTo(.5, 9);
  });

  it('rule 6: while the next prompt pins, the old one is above the pin line; only one prompt is ever at it', () => {
    const frames = pinnedPromptFrames(991, prompts, options);
    expect(frames.map(frame => frame.index)).toEqual([0, 1]);
    expect(frames[0].phase).toBe('pushed');
    expect(bottom(frames[0])).toBeLessThanOrEqual(frames[1].top);
    expect(frames[1]).toMatchObject({ phase: 'pinned', top: 10 });
    for (let scrollTop = 0; scrollTop < 2000; scrollTop += 3) {
      const atLine = pinnedPromptFrames(scrollTop, prompts, options).filter(frame => frame.phase !== 'pushed');
      expect(atLine.length).toBeLessThanOrEqual(1);
    }
  });

  it('rule 6: when the next prompt arrives during the fade, it pushes and the fade continues with the scroll', () => {
    const close = [tall, { top: 435, height: 60, summaryHeight: 80 }];
    const points = pinnedPromptBreakpoints(close, 0, options);
    expect(points.pushStart).toBeLessThan(points.fadeEnd);
    const frame = pinnedPromptFrameAt(points.pushStart + 10, close, 0, options)!;
    expect(frame.phase).toBe('pushed');
    expect(frame.fade).toBeGreaterThan(0);
    expect(frame.fade).toBeLessThan(1);
  });

  it('rule 7 (determinism): frames depend only on the position, so scrolling back passes the same states in reverse', () => {
    const positions = Array.from({ length: 401 }, (_, step) => step * 5);
    const down = positions.map(scrollTop => pinnedPromptFrames(scrollTop, prompts, options));
    const up = [...positions].reverse().map(scrollTop => pinnedPromptFrames(scrollTop, prompts, options)).reverse();
    expect(up).toEqual(down);
    // Coming back, the bubble grows, the summary fades back to the full text, and then
    // it rejoins its natural place with nothing left over.
    expect(frameAt(340, 0)!.fade).toBeGreaterThan(frameAt(320, 0)!.fade);
    expect(frameAt(250, 0)!.height).toBeGreaterThan(frameAt(300, 0)!.height);
    expect(frameAt(90.001, 0)).toMatchObject({ top: 10 });
    expect(frameAt(90.001, 0)!.height).toBeCloseTo(tall.height, 2);
    expect(frameAt(90, 0)).toBeUndefined();
  });

  it('rules 7 and 8: every value is continuous across each breakpoint, so nothing jumps either way', () => {
    for (const index of [0, 1, 2]) {
      const points = pinnedPromptBreakpoints(prompts, index, options);
      for (const point of [points.shrinkEnd, points.fadeEnd, points.pushStart]) {
        if (!Number.isFinite(point) || point <= points.pin) continue;
        const before = pinnedPromptFrameAt(point - 1e-6, prompts, index, options)!;
        const after = pinnedPromptFrameAt(point + 1e-6, prompts, index, options)!;
        expect(after.top).toBeCloseTo(before.top, 4);
        expect(after.height).toBeCloseTo(before.height, 4);
        expect(after.innerOffset).toBeCloseTo(before.innerOffset, 4);
        expect(after.fade).toBeCloseTo(before.fade, 4);
      }
      // Leaving the natural place: the frame starts exactly where the prompt naturally is.
      const entering = pinnedPromptFrameAt(points.pin + 1e-6, prompts, index, options)!;
      expect(entering.top).toBeCloseTo(naturalTop(prompts[index], points.pin), 4);
      expect(entering.height).toBeCloseTo(prompts[index].height, 4);
      expect(entering.innerOffset).toBeCloseTo(0, 4);
    }
  });

  it('rule 8 (determinism): a jump gives the same frames as walking there one pixel at a time', () => {
    // Walk there 1px at a time, as a drag would, and compare with jumping straight there.
    const targets = [0, 95, 200, 333, 640, 950, 991, 1150, 1290, 1400, 1700, 120, 5];
    for (const target of targets) {
      let walked: PinnedPromptFrame[] = [];
      for (let scrollTop = 0; scrollTop <= target; scrollTop++) walked = pinnedPromptFrames(scrollTop, prompts, options);
      expect(pinnedPromptFrames(target, prompts, options)).toEqual(walked);
    }
    // Jumping back and forth between distant positions never carries anything across.
    expect(pinnedPromptFrames(1400, prompts, options)).toEqual(pinnedPromptFrames(1400, prompts, options));
    expect(pinnedPromptFrames(95, prompts, options).map(frame => frame.index)).toEqual([0]);
    expect(pinnedPromptFrames(1400, prompts, options).map(frame => frame.index)).toEqual([2]);
  });

  it('rule 6: a prompt pushed the moment it stops shrinking moves continuously across that point', () => {
    // The next prompt sits right under a tall one, closer than the push gap, so pushing
    // starts exactly where shrinking ends.
    const tight = [{ top: 100, height: 300, summaryHeight: 80 }, { top: 404, height: 60, summaryHeight: 60 }];
    const points = pinnedPromptBreakpoints(tight, 0, options);
    expect(points.pushStart).toBe(points.shrinkEnd);
    const before = pinnedPromptFrameAt(points.pushStart - 1e-6, tight, 0, options)!;
    const after = pinnedPromptFrameAt(points.pushStart + 1e-6, tight, 0, options)!;
    expect(before.phase).toBe('shrinking');
    expect(after.phase).toBe('pushed');
    for (const key of ['top', 'height', 'innerOffset', 'fade'] as const) expect(after[key]).toBeCloseTo(before[key], 4);
    // From there it moves exactly with the scroll, touching the next prompt.
    const later = pinnedPromptFrameAt(points.pushStart + 30, tight, 0, options)!;
    expect(later.top).toBeCloseTo(after.top - 30, 4);
    expect(bottom(later)).toBeCloseTo(naturalTop(tight[1], points.pushStart + 30) - 4, 4);
  });

  it('rule 6: a pushed prompt is dropped only once it is entirely above the scrollport, never while visible', () => {
    for (const index of [0, 1]) {
      const { pushStart, gone } = pinnedPromptBreakpoints(prompts, index, options);
      for (let scrollTop = pushStart; scrollTop < gone + 5; scrollTop += .25) {
        const frame = frameAt(scrollTop, index);
        if (frame) expect(bottom(frame)).toBeGreaterThan(0);
        else expect(scrollTop).toBeGreaterThanOrEqual(gone);
      }
      expect(bottom(frameAt(gone - .25, index)!)).toBeCloseTo(.25, 6);
    }
    // After the next prompt pins, the old one keeps moving with the scroll (the gap between
    // them grows by the scroll distance) until it is off.
    const atPin = pinnedPromptFrames(991, prompts, options);
    const later = pinnedPromptFrames(992 - .5, prompts, options);
    expect(later[0].top - atPin[0].top).toBeCloseTo(-.5, 6);
    expect(later[1].top).toBe(atPin[1].top);
  });

  it('rule 4: a summary is never smaller than one line plus padding, nor larger than the prompt', () => {
    const withMinimum = { ...options, minSummaryHeight: 52 };
    for (const summaryHeight of [0, -10, 20, Number.NaN]) {
      const prompt = [{ top: 100, height: 300, summaryHeight }];
      const { shrinkEnd, pin } = pinnedPromptBreakpoints(prompt, 0, withMinimum);
      const fallback = Number.isNaN(summaryHeight) ? 300 : 52;
      expect(shrinkEnd - pin).toBe(300 - fallback);
      expect(pinnedPromptFrameAt(shrinkEnd + 100, prompt, 0, withMinimum)!.height).toBe(fallback);
    }
    // A prompt shorter than the minimum keeps its own height.
    const tiny = [{ top: 100, height: 40, summaryHeight: 10 }];
    expect(pinnedPromptFrameAt(200, tiny, 0, withMinimum)).toMatchObject({ height: 40, innerOffset: 0, fade: 0 });
  });

  it('rule 2: a prompt exactly as tall as its summary pins at full height with nothing to fade', () => {
    const exact = [{ top: 100, height: 80, summaryHeight: 80 }];
    const points = pinnedPromptBreakpoints(exact, 0, options);
    expect(points.shrinkEnd).toBe(points.pin);
    expect(points.fadeEnd).toBe(points.pin);
    for (const scrollTop of [90.5, 120, 500]) {
      expect(pinnedPromptFrameAt(scrollTop, exact, 0, options))
        .toMatchObject({ phase: 'pinned', top: 10, height: 80, innerOffset: 0, fade: 0 });
    }
  });

  it('never pins a prompt without a real box, and never returns non-finite values', () => {
    const broken = [
      { top: Number.NaN, height: 300, summaryHeight: 80 },
      { top: 500, height: Number.POSITIVE_INFINITY, summaryHeight: 80 },
      { top: 600, height: 0, summaryHeight: 0 },
      { top: 700, height: -5, summaryHeight: 0 },
    ];
    for (let index = 0; index < broken.length; index++) {
      expect(pinnedPromptBreakpoints(broken, index, options).pin).toBe(Infinity);
      expect(pinnedPromptKeyframes(broken, index, options)).toEqual([]);
      for (const scrollTop of [0, 600, 1e6]) expect(pinnedPromptFrameAt(scrollTop, broken, index, options)).toBeUndefined();
    }
    // A broken prompt between two good ones is skipped: the later good one still pushes.
    const mixed = [tall, { top: 700, height: Number.NaN, summaryHeight: 0 }, short];
    expect(pinnedPromptBreakpoints(mixed, 0, options).gone).toBe(short.top - options.pushGap);
    expect(pinnedPromptFrames(991, mixed, options).map(frame => frame.index)).toEqual([0, 2]);
    // Non-finite options fall back to zero, and every value stays finite.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const odd = { pinLine: bad, fadeDistance: bad, pushGap: bad, minSummaryHeight: bad };
      for (let scrollTop = 0; scrollTop < 2000; scrollTop += 37) {
        for (const frame of pinnedPromptFrames(scrollTop, prompts, odd)) {
          for (const value of [frame.top, frame.height, frame.innerOffset, frame.fade]) expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
    expect(pinnedPromptFrames(Number.NaN, prompts, options)).toEqual([]);
  });

  it('keeps the latest prompt pinned however far the reader scrolls past it', () => {
    expect(pinnedPromptBreakpoints(prompts, 2, options).gone).toBe(Infinity);
    expect(frameAt(1e6, 2)).toMatchObject({ phase: 'pinned', top: 10, height: 80, fade: 1 });
  });

  it('never draws a prompt below its natural place when it starts above the pin line', () => {
    const first = [{ top: 4, height: 200, summaryHeight: 50 }];
    expect(pinnedPromptFrameAt(0, first, 0, options)).toBeUndefined();
    const frame = pinnedPromptFrameAt(20, first, 0, options)!;
    expect(frame.top).toBe(4);
    expect(frame.top + frame.innerOffset).toBe(4 - 20);
  });

  it('uses the natural space as the push gap when two prompts sit closer than the gap', () => {
    const adjacent = [{ top: 100, height: 60, summaryHeight: 60 }, { top: 164, height: 60, summaryHeight: 60 }];
    const points = pinnedPromptBreakpoints(adjacent, 0, options);
    // Pushing starts the moment it pins: they touch exactly as they do in the transcript.
    expect(points.pushStart).toBe(points.pin);
    const frame = pinnedPromptFrameAt(points.pin + 10, adjacent, 0, options)!;
    expect(bottom(frame)).toBe(naturalTop(adjacent[1], points.pin + 10) - 4);
  });

  it('switches to the summary at once when there is no fade distance', () => {
    const instant = { ...options, fadeDistance: 0 };
    expect(pinnedPromptFrameAt(309, prompts, 0, instant)!.fade).toBe(0);
    expect(pinnedPromptFrameAt(310, prompts, 0, instant)!.fade).toBe(1);
  });

  it('keyframes reproduce every frame by straight-line interpolation', () => {
    for (const index of [0, 1, 2]) {
      const keyframes = pinnedPromptKeyframes(prompts, index, options);
      const points = pinnedPromptBreakpoints(prompts, index, options);
      expect(keyframes[0].scrollTop).toBe(points.pin);
      for (let scrollTop = points.pin + .25; scrollTop < Math.min(points.gone, 2500); scrollTop += 3.5) {
        const frame = pinnedPromptFrameAt(scrollTop, prompts, index, options)!;
        const after = keyframes.findIndex(keyframe => keyframe.scrollTop >= scrollTop);
        const interpolated = after < 0 ? keyframes.at(-1)!.frame : (() => {
          const from = keyframes[after - 1];
          const to = keyframes[after];
          const t = (scrollTop - from.scrollTop) / (to.scrollTop - from.scrollTop);
          const mix = (a: number, b: number) => a + (b - a) * t;
          return { top: mix(from.frame.top, to.frame.top), height: mix(from.frame.height, to.frame.height),
            innerOffset: mix(from.frame.innerOffset, to.frame.innerOffset), fade: mix(from.frame.fade, to.frame.fade) };
        })();
        expect(interpolated.top).toBeCloseTo(frame.top, 6);
        expect(interpolated.height).toBeCloseTo(frame.height, 6);
        expect(interpolated.innerOffset).toBeCloseTo(frame.innerOffset, 6);
        expect(interpolated.fade).toBeCloseTo(frame.fade, 6);
      }
    }
  });

  it('finds the pinned prompts in a long conversation without walking every prompt', () => {
    const many = Array.from({ length: 2000 }, (_, index) =>
      ({ top: 100 + index * 500, height: index % 3 === 0 ? 400 : 60, summaryHeight: 80 }));
    const frames = pinnedPromptFrames(100 + 1234 * 500 + 50, many, options);
    expect(frames.map(frame => frame.index)).toEqual([1234]);
  });
});
