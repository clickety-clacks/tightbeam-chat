import { useCallback, useId, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';

/**
 * The reader's own sent prompt, shown at most ten lines tall in the conversation, with a
 * button that reveals the rest in place (wi_ef2dbd5b). There is no collapse.
 *
 * The full text stays in the page, clipped only visually, so copy, find-in-page and selection
 * still see all of it. "Ten lines" is ten rendered lines of text at the current width: wrapped
 * lines count, paragraph and code-block spacing does not, and the limit follows rotation and
 * pane resizes. The clip falls just above the eleventh line. Once expanded,
 * a prompt stays expanded for the life of the page: across live updates, transcript rebuilds and
 * reconnects.
 */

/** Prompts the reader has expanded, by conversation and prompt identity, for this page. */
const expandedPrompts = new Map<string, Set<string>>();

function isExpanded(conversation: string, identity: string): boolean {
  return expandedPrompts.get(conversation)?.has(identity) ?? false;
}

function rememberExpanded(conversation: string, identity: string) {
  let identities = expandedPrompts.get(conversation);
  if (!identities) expandedPrompts.set(conversation, identities = new Set());
  identities.add(identity);
}

/** Lines shown before the rest is clipped. */
const VISIBLE_LINES = 10;

/**
 * Where the clip goes: the distance from the content's top to the top of its eleventh rendered
 * line of text, or undefined when it has ten lines or fewer. Walks text in order and stops at the
 * eleventh line, so a very long prompt costs no more than a short one. Returns null where the
 * browser cannot report line boxes; the caller then falls back to ten line-heights.
 */
function clipHeight(content: HTMLElement): number | undefined | null {
  if (typeof document.createRange !== 'function') return null;
  const range = document.createRange();
  if (typeof range.getClientRects !== 'function') return null;
  const top = content.getBoundingClientRect().top;
  const lineTops: number[] = [];
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let reported = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.height <= 0) continue;
      reported = true;
      // A new line starts when a box begins below every line seen so far.
      if (lineTops.length && rect.top < lineTops[lineTops.length - 1] + rect.height / 2) continue;
      lineTops.push(rect.top);
      if (lineTops.length > VISIBLE_LINES) return lineTops[VISIBLE_LINES] - top;
    }
  }
  return reported ? undefined : null;
}

/** Test hook: forget every expanded prompt. */
export function resetExpandedPromptsForTests() {
  expandedPrompts.clear();
}

export function PromptClamp({ conversation, identity, beforeExpand, children }: {
  /** The conversation the prompt belongs to. */
  readonly conversation: string;
  /** Stable across a local send and its delivered record. */
  readonly identity: string;
  /** Keeps the reading position steady while the prompt grows. */
  readonly beforeExpand?: () => void;
  readonly children: ReactNode;
}) {
  const contentId = useId();
  const content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(() => isExpanded(conversation, identity));
  const [overflowing, setOverflowing] = useState(false);
  // A delivered record replaces its local send under the same identity; keep what the reader chose.
  if (!expanded && isExpanded(conversation, identity)) setExpanded(true);

  const measure = useCallback(() => {
    const element = content.current;
    if (!element) return;
    const clip = clipHeight(element);
    if (clip === null) {
      // No line boxes to read: ten line-heights from CSS, overflow judged by height.
      element.style.removeProperty('max-height');
      const next = element.scrollHeight > element.clientHeight + 1;
      setOverflowing(current => current === next ? current : next);
      return;
    }
    // Write only a change: the clip resizes this element, and a needless write would ask the
    // browser for another resize pass.
    const maxHeight = clip === undefined ? 'none' : `${Math.ceil(clip)}px`;
    if (element.style.getPropertyValue('max-height') !== maxHeight) element.style.setProperty('max-height', maxHeight);
    const next = clip !== undefined;
    setOverflowing(current => current === next ? current : next);
  }, []);

  useLayoutEffect(() => {
    if (expanded) return;
    measure();
    const element = content.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    // Watch the text inside the clip, not the clipped box: its width follows the bubble (rewrapping
    // the text) and its height follows images or code, but setting the clip never resizes it, so
    // measuring cannot set off another resize notification (no ResizeObserver loop).
    const observer = new ResizeObserver(measure);
    observer.observe(element.firstElementChild ?? element);
    return () => observer.disconnect();
  }, [expanded, measure, children]);

  const expand = (focusText: boolean) => {
    beforeExpand?.();
    rememberExpanded(conversation, identity);
    content.current?.style.removeProperty('max-height');
    setExpanded(true);
    // The button goes away; keep keyboard focus in the prompt rather than dropping it to the page.
    if (focusText) content.current?.focus({ preventScroll: true });
  };

  // Tabbing into a link or control in the clipped part reveals the whole prompt, so focus never
  // sits on something the reader cannot see.
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (expanded || !overflowing || event.target === content.current) return;
    const element = content.current;
    if (!element) return;
    const limit = element.getBoundingClientRect().top + element.clientHeight;
    if ((event.target as HTMLElement).getBoundingClientRect().bottom > limit) expand(false);
  };

  const clamped = !expanded && overflowing;
  return <div className="tb-chat-prompt-clamp" data-expanded={expanded ? 'true' : undefined}
    data-clamped={clamped ? 'true' : undefined}>
    <div ref={content} id={contentId} className="tb-chat-prompt-clamp-content" tabIndex={-1}
      onFocus={onFocus}>{children}</div>
    {clamped && <button type="button" className="tb-chat-prompt-expand" aria-controls={contentId}
      aria-expanded="false" onClick={() => expand(true)}>Show full message</button>}
  </div>;
}
