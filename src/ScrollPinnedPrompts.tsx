import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import {
  effectiveSummaryHeight, pinnedPromptBreakpoints, pinnedPromptFrameAt, pinnedPromptKeyframes,
  type PinnedPromptGeometry, type PinnedPromptOptions,
} from './pinnedPromptLayout';

/**
 * Pinned user prompts driven directly by the scroll position (wi_181ae343, behind the
 * CHAT_SCROLL_PINNED_PROMPTS flag).
 *
 * Each pinned prompt is drawn in a layer over the transcript at the original bubble's
 * own position and width. Where it is drawn comes from `pinnedPromptLayout`. Where the
 * browser has scroll timelines, every per-frame change (position, height, inner offset,
 * fade, and hiding the original) is a scroll-driven animation of transform or opacity,
 * so the browser applies it in step with its own scrolling and no script runs per
 * frame. Elsewhere a scroll listener writes the same values. Script only reacts to
 * layout changes and to a prompt starting or stopping being pinned (which slots exist,
 * which are interactive).
 */

export interface ScrollPinnedPrompt {
  readonly identity: string;
  /** Plain text of the prompt, shown as its summary. */
  readonly text: string;
  readonly scrollKey: string;
  /** Id of the original bubble, for aria-controls. */
  readonly targetId: string;
}

export interface ScrollPinnedPromptsHandle {
  /** Measure again after something outside the transcript moved the pin line. */
  readonly remeasure: () => void;
  /**
   * Where, in scrollport coordinates, this prompt's natural bottom sits when it has just
   * shrunk to its summary height: everything after it starts below the pinned copy there.
   * Undefined when the prompt is not laid out.
   */
  readonly settledBottom: (scrollKey: string) => number | undefined;
}

interface Props {
  readonly prompts: readonly ScrollPinnedPrompt[];
  readonly viewport: { readonly current: HTMLElement | null };
  readonly getRow: (scrollKey: string) => HTMLElement | undefined;
  readonly onJump: (prompt: ScrollPinnedPrompt) => void;
  readonly onDismiss: () => void;
}

/** Scroll distance over which the full text fades into the summary. */
const FADE_DISTANCE = 48;
/** Space between a pushed prompt and the prompt pushing it. */
const PUSH_GAP = 8;
/** Marks an original bubble hidden while its copy is pinned (scroll-listener path only). */
const HIDDEN_ORIGINAL = 'data-pinned-original';
/** Lines in a summary. */
const SUMMARY_LINES = 3;

interface Measured extends PinnedPromptGeometry {
  readonly identity: string;
  readonly scrollKey: string;
  readonly left: number;
  readonly width: number;
}

interface Layout {
  readonly prompts: readonly Measured[];
  readonly byIdentity: ReadonlyMap<string, number>;
  readonly options: PinnedPromptOptions;
}

interface SlotElements {
  slot?: HTMLDivElement;
  body?: HTMLDivElement;
  full?: HTMLDivElement;
  summary?: HTMLDivElement;
  /** The original row the full layer was copied from. */
  copiedFrom?: HTMLElement;
  copyObserver?: MutationObserver;
  animations?: Animation[];
  animationKey?: string;
  hiddenRow?: HTMLElement;
  pinned?: boolean;
}

type TimelineConstructor = new (options: { source: Element; axis: 'block' }) => AnimationTimeline;

function scrollTimelineConstructor(): TimelineConstructor | undefined {
  const candidate = (globalThis as { ScrollTimeline?: TimelineConstructor }).ScrollTimeline;
  return typeof candidate === 'function' && typeof Element !== 'undefined' &&
    typeof Element.prototype.animate === 'function' ? candidate : undefined;
}

function copyBubble(row: HTMLElement): HTMLElement {
  const copy = row.cloneNode(true) as HTMLElement;
  copy.removeAttribute('id');
  for (const element of copy.querySelectorAll('[id]')) element.removeAttribute('id');
  copy.removeAttribute('data-scroll-key');
  copy.removeAttribute('data-record-key');
  copy.removeAttribute('aria-label');
  copy.classList.add('tb-chat-pinned-copy');
  return copy;
}

export const ScrollPinnedPrompts = forwardRef<ScrollPinnedPromptsHandle, Props>(function ScrollPinnedPrompts(
  { prompts, viewport, getRow, onJump, onDismiss }, ref) {
  const layer = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const layout = useRef<Layout>({ prompts: [], byIdentity: new Map(), options: { pinLine: 0, fadeDistance: FADE_DISTANCE, pushGap: PUSH_GAP } });
  const slots = useRef(new Map<string, SlotElements>());
  const timeline = useRef<AnimationTimeline | null | undefined>(undefined);
  const [mounted, setMounted] = useState<readonly string[]>([]);
  const mountedKey = useRef('');
  const scheduleRefresh = useRef<() => void>(() => {});
  const summaries = useRef(new WeakMap<HTMLElement, { key: string; summaryHeight: number; minimum: number }>());
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;
  const promptsByIdentity = useRef(new Map<string, ScrollPinnedPrompt>());
  const promptsRef = useRef(prompts);
  if (promptsRef.current !== prompts || promptsByIdentity.current.size !== prompts.length) {
    promptsRef.current = prompts;
    promptsByIdentity.current = new Map(prompts.map(prompt => [prompt.identity, prompt]));
  }

  const scrollTimeline = useCallback((): AnimationTimeline | null => {
    const box = viewport.current;
    if (timeline.current !== undefined) return timeline.current;
    const Timeline = scrollTimelineConstructor();
    try {
      timeline.current = Timeline && box ? new Timeline({ source: box, axis: 'block' }) : null;
    } catch {
      timeline.current = null;
    }
    return timeline.current;
  }, [viewport]);

  /**
   * Which prompts need a slot: those pinned now, the next two to arrive, and the one just
   * pushed off above, so a copy is ready before it is needed whichever way the reader scrolls.
   */
  const wantedSlots = useCallback((scrollTop: number, extra = 0): string[] => {
    const { prompts: measured, options } = layout.current;
    let low = 0;
    let high = measured.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (pinnedPromptBreakpoints(measured, middle, options).pin < scrollTop) low = middle + 1;
      else high = middle;
    }
    const wanted: string[] = [];
    let index = low - 1;
    for (; index >= 0 && pinnedPromptFrameAt(scrollTop, measured, index, options); index--) {
      wanted.unshift(measured[index].identity);
    }
    for (let above = 0; above <= extra && index - above >= 0; above++) wanted.unshift(measured[index - above].identity);
    for (let index = low; index < Math.min(measured.length, low + 2 + extra); index++) wanted.push(measured[index].identity);
    return wanted;
  }, []);

  /**
   * Reads layout. Runs on layout changes only, never per scroll frame. Every prompt's box
   * is read (one layout pass; the boxes place the pin points), but style, summary and
   * running-animation checks run only for the prompts near the pin line.
   */
  const measureLayout = useCallback(() => {
    const box = viewport.current;
    const overlay = layer.current;
    const root = overlay?.parentElement;
    if (!box || !overlay || !root) return;
    const rootBounds = root.getBoundingClientRect();
    const boxBounds = box.getBoundingClientRect();
    const portTop = boxBounds.top + box.clientTop;
    const portLeft = boxBounds.left + box.clientLeft;
    overlay.style.top = `${portTop - rootBounds.top}px`;
    overlay.style.left = `${portLeft - rootBounds.left}px`;
    overlay.style.width = `${box.clientWidth}px`;
    overlay.style.height = `${box.clientHeight}px`;
    const pinFromRoot = Number.parseFloat(root.style.getPropertyValue('--tb-chat-floating-prompt-top')) || 10;
    const pinLine = pinFromRoot - (portTop - rootBounds.top);
    const scrollTop = box.scrollTop;
    const measured: Measured[] = [];
    const rowsByIndex: HTMLElement[] = [];
    for (const prompt of promptsRef.current) {
      const row = getRow(prompt.scrollKey);
      if (!row) continue;
      const bounds = row.getBoundingClientRect();
      if (!Number.isFinite(bounds.top) || bounds.height <= 0) continue;
      // Prompts are in transcript order; a row that is not laid out yet must not break it.
      const top = bounds.top - portTop + scrollTop;
      if (measured.length && top < measured[measured.length - 1].top) break;
      rowsByIndex.push(row);
      measured.push({ identity: prompt.identity, scrollKey: prompt.scrollKey, top, height: bounds.height,
        // Until measured near the pin line, a summary is taken as the full height: pin
        // points and push-off points do not depend on it.
        summaryHeight: summaries.current.get(row)?.summaryHeight ?? bounds.height,
        left: bounds.left - portLeft, width: bounds.width });
    }
    const previousOptions = layout.current.options;
    layout.current = { prompts: measured, byIdentity: new Map(measured.map((prompt, index) => [prompt.identity, index])),
      options: { pinLine, fadeDistance: FADE_DISTANCE, pushGap: PUSH_GAP,
        minSummaryHeight: previousOptions.minSummaryHeight ?? 0 } };
    const near = new Set(wantedSlots(scrollTop, 1));
    const ownAnimations = new Set([...slots.current.values()].flatMap(slot => slot.animations ?? []));
    let minSummaryHeight = previousOptions.minSummaryHeight ?? 0;
    measured.forEach((prompt, index) => {
      if (!near.has(prompt.identity)) return;
      const row = rowsByIndex[index];
      const text = promptsByIdentity.current.get(prompt.identity)?.text ?? '';
      const summary = summaryFor(row, prompt.width, text);
      if (summary) {
        if (!minSummaryHeight) minSummaryHeight = summary.minimum;
        measured[index] = { ...prompt, summaryHeight: summary.summaryHeight };
      }
      for (const animation of row.getAnimations?.() ?? []) {
        // An arrival slide moves the row while it plays; measure again once it settles.
        if (animation.playState === 'running' && !ownAnimations.has(animation)) {
          void animation.finished.then(() => scheduleRefresh.current(), () => {});
        }
      }
    });
    layout.current = { ...layout.current, options: { ...layout.current.options, minSummaryHeight } };
  }, [getRow, viewport]);

  /**
   * A prompt's summary: its text clamped to three lines. A prompt whose text fits and
   * that holds nothing but text is already at pinned size; one with images, code or a
   * table is taller than its text, so it shrinks to the text summary like a long prompt.
   * Cached per row, width and text.
   */
  const summaryFor = useCallback((row: HTMLElement, width: number, text: string) => {
    const probe = measure.current;
    const style = getComputedStyle(row);
    const padding = `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`;
    const key = `${width}\u0000${padding}\u0000${style.fontSize}\u0000${text}`;
    const cached = summaries.current.get(row);
    if (cached?.key === key) return cached;
    if (!probe) return undefined;
    probe.style.width = `${width}px`;
    probe.style.padding = padding;
    const probeText = probe.firstElementChild as HTMLElement;
    probeText.textContent = text;
    const height = probe.getBoundingClientRect().height;
    const truncated = probeText.scrollHeight > probeText.clientHeight + 1;
    const hasMedia = !!row.querySelector('img, video, pre, table, .tb-chat-attachments, .tb-chat-image-attachments');
    const fontSize = Number.parseFloat(style.fontSize) || 0;
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.5;
    const entry = { key, summaryHeight: truncated || hasMedia ? height : row.getBoundingClientRect().height,
      // Rule 4's floor: one line of prompt text plus the bubble's vertical padding.
      minimum: lineHeight + (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0) };
    summaries.current.set(row, entry);
    return entry;
  }, []);

  // Without scroll timelines the original is hidden by an attribute (styled in style.css),
  // never by inline style, so Chat's own row styles and animations are left alone.
  const releaseRow = (slot: SlotElements) => {
    slot.hiddenRow?.removeAttribute(HIDDEN_ORIGINAL);
    slot.hiddenRow = undefined;
  };

  const cancelAnimations = (slot: SlotElements) => {
    for (const animation of slot.animations ?? []) animation.cancel();
    slot.animations = undefined;
    slot.animationKey = undefined;
  };

  /** Writes the frame for the current scroll position. Used where scroll timelines are missing. */
  const writeFrame = useCallback((identity: string, slot: SlotElements, scrollTop: number) => {
    const { prompts: measured, byIdentity, options } = layout.current;
    const index = byIdentity.get(identity);
    const frame = index === undefined ? undefined : pinnedPromptFrameAt(scrollTop, measured, index, options);
    const row = index === undefined ? undefined : getRow(promptsByIdentity.current.get(identity)?.scrollKey ?? '');
    if (!slot.slot || !slot.body || !slot.full || !slot.summary) return;
    if (!frame || !row) {
      slot.slot.style.opacity = '0';
      releaseRow(slot);
      return;
    }
    slot.slot.style.opacity = '1';
    slot.slot.style.transform = `translateY(${frame.top}px)`;
    slot.body.style.transform = `translateY(${frame.innerOffset}px)`;
    slot.full.style.opacity = String(1 - frame.fade);
    slot.summary.style.opacity = String(frame.fade);
    if (slot.hiddenRow !== row) {
      releaseRow(slot);
      row.setAttribute(HIDDEN_ORIGINAL, '');
      slot.hiddenRow = row;
    }
  }, [getRow]);

  /** Hands the frames to the browser as scroll-driven keyframes. */
  const animate = useCallback((identity: string, slot: SlotElements, source: AnimationTimeline) => {
    const { prompts: measured, byIdentity, options } = layout.current;
    const index = byIdentity.get(identity);
    const row = index === undefined ? undefined : getRow(promptsByIdentity.current.get(identity)?.scrollKey ?? '');
    if (index === undefined || !row || !slot.slot || !slot.body || !slot.full || !slot.summary) {
      cancelAnimations(slot);
      return;
    }
    const keyframes = pinnedPromptKeyframes(measured, index, options);
    const latest = !Number.isFinite(pinnedPromptBreakpoints(measured, index, options).gone);
    const start = keyframes[0].scrollTop;
    const end = Math.max(keyframes.at(-1)!.scrollTop, start + 1);
    const stops = keyframes.length > 1 ? keyframes : [keyframes[0], { ...keyframes[0], scrollTop: end }];
    const key = JSON.stringify([stops, latest, measured[index].left, measured[index].width]);
    if (slot.animationKey === key && slot.hiddenRow === row && slot.animations?.length) return;
    cancelAnimations(slot);
    const offset = (scrollTop: number) => (scrollTop - start) / (end - start);
    const timing = { timeline: source, rangeStart: `${start}px`, rangeEnd: `${end}px`,
      fill: latest ? 'forwards' : 'none' } as KeyframeAnimationOptions;
    slot.animations = [
      slot.slot.animate(stops.map(stop => ({ offset: offset(stop.scrollTop), opacity: 1,
        transform: `translateY(${stop.frame.top}px)` })), timing),
      slot.body.animate(stops.map(stop => ({ offset: offset(stop.scrollTop),
        transform: `translateY(${stop.frame.innerOffset}px)` })), timing),
      slot.full.animate(stops.map(stop => ({ offset: offset(stop.scrollTop), opacity: 1 - stop.frame.fade })), timing),
      slot.summary.animate(stops.map(stop => ({ offset: offset(stop.scrollTop), opacity: stop.frame.fade })), timing),
      // The original stays in the transcript for layout and screen readers, unseen while its copy is pinned.
      row.animate([{ offset: 0, opacity: 0 }, { offset: 1, opacity: 0 }], timing),
    ];
    slot.animationKey = key;
    slot.hiddenRow = row;
  }, [getRow]);

  /** Copies the original bubble into the slot, and again whenever the original changes. */
  const syncCopy = useCallback((identity: string, slot: SlotElements) => {
    const prompt = promptsByIdentity.current.get(identity);
    const row = prompt ? getRow(prompt.scrollKey) : undefined;
    if (!slot.full || !row) return;
    const measured = layout.current.prompts[layout.current.byIdentity.get(identity) ?? -1];
    const place = () => {
      if (!slot.slot || !measured) return;
      slot.slot.style.left = `${measured.left}px`;
      slot.slot.style.width = `${measured.width}px`;
      slot.slot.style.height = `${measured.height}px`;
      const style = getComputedStyle(row);
      slot.slot.style.setProperty('--tb-chat-pinned-radius-top-left', style.borderTopLeftRadius);
      slot.slot.style.setProperty('--tb-chat-pinned-radius-top-right', style.borderTopRightRadius);
      slot.slot.style.setProperty('--tb-chat-pinned-radius-bottom-left', style.borderBottomLeftRadius);
      slot.slot.style.setProperty('--tb-chat-pinned-radius-bottom-right', style.borderBottomRightRadius);
      if (slot.summary) {
        slot.summary.style.top = `${measured.height - measured.summaryHeight}px`;
        slot.summary.style.height = `${measured.summaryHeight}px`;
        slot.summary.style.padding = `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`;
      }
    };
    place();
    if (slot.copiedFrom === row) return;
    slot.copyObserver?.disconnect();
    const copy = () => {
      const bubble = copyBubble(row);
      bubble.style.width = `${measured?.width ?? row.getBoundingClientRect().width}px`;
      slot.full!.replaceChildren(bubble);
    };
    copy();
    slot.copiedFrom = row;
    if (typeof MutationObserver !== 'undefined') {
      slot.copyObserver = new MutationObserver(copy);
      slot.copyObserver.observe(row, { subtree: true, childList: true, characterData: true, attributes: true,
        // 'style' carries the prompt clamp's height, which changes when the bubble is resized.
        attributeFilter: ['class', 'style', 'data-send-state', 'data-message-state', 'src', 'data-expanded', 'data-clamped'] });
    }
  }, [getRow]);

  /** Applies the current layout to every slot. */
  const render = useCallback(() => {
    const box = viewport.current;
    if (!box) return;
    const source = scrollTimeline();
    const scrollTop = box.scrollTop;
    for (const [identity, slot] of slots.current) {
      syncCopy(identity, slot);
      if (source) animate(identity, slot, source);
      else writeFrame(identity, slot, scrollTop);
    }
  }, [animate, scrollTimeline, syncCopy, viewport, writeFrame]);

  /** Runs on scroll: cheap arithmetic, DOM writes only when a prompt starts or stops being pinned. */
  const onScroll = useCallback(() => {
    const box = viewport.current;
    if (!box) return;
    const scrollTop = box.scrollTop;
    const wanted = wantedSlots(scrollTop);
    const key = wanted.join('\u0000');
    if (key !== mountedKey.current) {
      mountedKey.current = key;
      setMounted(wanted);
    }
    const { prompts: measured, byIdentity, options } = layout.current;
    const source = timeline.current;
    for (const [identity, slot] of slots.current) {
      const index = byIdentity.get(identity);
      const pinned = index !== undefined && !!pinnedPromptFrameAt(scrollTop, measured, index, options);
      if (!source) writeFrame(identity, slot, scrollTop);
      if (slot.pinned === pinned || !slot.slot) continue;
      slot.pinned = pinned;
      // Only a pinned copy can be pressed or read; otherwise the original is in view.
      slot.slot.toggleAttribute('data-pinned', pinned);
      slot.slot.toggleAttribute('inert', !pinned);
      if (pinned) slot.slot.removeAttribute('aria-hidden');
      else slot.slot.setAttribute('aria-hidden', 'true');
    }
  }, [viewport, wantedSlots, writeFrame]);

  const refresh = useCallback(() => {
    measureLayout();
    render();
    onScroll();
  }, [measureLayout, onScroll, render]);

  useImperativeHandle(ref, () => ({
    remeasure: refresh,
    settledBottom: (scrollKey: string) => {
      if (!layout.current.prompts.some(prompt => prompt.scrollKey === scrollKey)) measureLayout();
      const { prompts: measured, options } = layout.current;
      const prompt = measured.find(candidate => candidate.scrollKey === scrollKey);
      return prompt ? Math.min(options.pinLine, prompt.top) + effectiveSummaryHeight(prompt, options.minSummaryHeight)
        : undefined;
    },
  }), [measureLayout, refresh]);

  useLayoutEffect(() => {
    refresh();
  }, [refresh, prompts]);

  // Newly mounted slots need their summaries, copy and animations before the next paint.
  useLayoutEffect(() => {
    refresh();
  }, [mounted, refresh]);

  // The copy lets touches through so the transcript scrolls under the finger. A tap that
  // lands inside a pinned copy's visible bubble means "take me to the original".
  const onTranscriptClick = useCallback((event: MouseEvent) => {
    const box = viewport.current;
    if (!box || event.defaultPrevented || event.button !== 0) return;
    const bounds = box.getBoundingClientRect();
    const x = event.clientX - bounds.left - box.clientLeft;
    const y = event.clientY - bounds.top - box.clientTop;
    const { prompts: measured, options } = layout.current;
    for (const identity of mountedKey.current ? mountedKey.current.split('\u0000') : []) {
      const index = layout.current.byIdentity.get(identity);
      const frame = index === undefined ? undefined : pinnedPromptFrameAt(box.scrollTop, measured, index, options);
      const prompt = promptsByIdentity.current.get(identity);
      if (!frame || !prompt || index === undefined) continue;
      const { left, width } = measured[index];
      if (x < left || x > left + width || y < frame.top || y > frame.top + frame.height) continue;
      event.preventDefault();
      event.stopPropagation();
      onJumpRef.current(prompt);
      return;
    }
  }, [viewport]);

  useEffect(() => {
    const box = viewport.current;
    if (!box) return;
    box.addEventListener('scroll', onScroll, { passive: true });
    box.addEventListener('click', onTranscriptClick, { capture: true });
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; refresh(); });
    };
    scheduleRefresh.current = schedule;
    // A transcript resize (a streaming reply, an image loading) is measured in the same frame,
    // before it is drawn: waiting a frame left a pinned copy's geometry, and so its push-off
    // point, one layout behind while content kept changing.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      refresh();
    });
    observer?.observe(box);
    if (box.firstElementChild) observer?.observe(box.firstElementChild);
    window.addEventListener('resize', schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      box.removeEventListener('scroll', onScroll);
      box.removeEventListener('click', onTranscriptClick, { capture: true });
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
      scheduleRefresh.current = () => {};
    };
  }, [onScroll, onTranscriptClick, refresh, viewport]);

  useEffect(() => () => {
    for (const slot of slots.current.values()) {
      cancelAnimations(slot);
      releaseRow(slot);
      slot.copyObserver?.disconnect();
    }
    slots.current.clear();
  }, []);

  // Ref callbacks are kept per slot part so React does not detach and reattach them on every render.
  const slotRefs = useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const slotRef = (identity: string, part: 'slot' | 'body' | 'full' | 'summary') => {
    const cacheKey = `${part}\u0000${identity}`;
    let callback = slotRefs.current.get(cacheKey);
    if (!callback) slotRefs.current.set(cacheKey, callback = attachSlotPart(identity, part));
    return callback;
  };
  const attachSlotPart = (identity: string, part: 'slot' | 'body' | 'full' | 'summary') => (element: HTMLDivElement | null) => {
    let slot = slots.current.get(identity);
    if (!slot) {
      if (!element) return;
      slots.current.set(identity, slot = {});
    }
    if (element) {
      slot[part] = element;
      return;
    }
    if (part === 'slot') {
      cancelAnimations(slot);
      releaseRow(slot);
      slot.copyObserver?.disconnect();
      slots.current.delete(identity);
      for (const name of ['slot', 'body', 'full', 'summary']) slotRefs.current.delete(`${name}\u0000${identity}`);
    } else {
      slot[part] = undefined;
    }
  };

  return <div ref={layer} className="tb-chat-pinned-layer">
    <div ref={measure} className="tb-chat-pinned-summary tb-chat-pinned-summary-measure" aria-hidden="true">
      <div className="tb-chat-pinned-summary-text" style={{ WebkitLineClamp: SUMMARY_LINES }} />
    </div>
    {mounted.map(identity => {
      const prompt = promptsByIdentity.current.get(identity);
      if (!prompt) return null;
      return <div key={identity} ref={slotRef(identity, 'slot')} className="tb-chat-pinned-slot"
        data-prompt-identity={identity} aria-hidden="true" inert>
        <div className="tb-chat-pinned-window">
          <div ref={slotRef(identity, 'body')} className="tb-chat-pinned-body">
            <div ref={slotRef(identity, 'full')} className="tb-chat-pinned-full" aria-hidden="true" inert />
            <div ref={slotRef(identity, 'summary')} className="tb-chat-pinned-summary" aria-hidden="true" inert>
              <div className="tb-chat-pinned-summary-text" style={{ WebkitLineClamp: SUMMARY_LINES }}>{prompt.text}</div>
            </div>
            <button type="button" className="tb-chat-pinned-jump" aria-label="Jump to user prompt"
              aria-controls={prompt.targetId} onClick={() => onJump(prompt)} />
          </div>
        </div>
        <button type="button" className="tb-chat-pinned-dismiss" aria-label="Dismiss user prompt preview"
          onClick={onDismiss}>×</button>
      </div>;
    })}
  </div>;
});
