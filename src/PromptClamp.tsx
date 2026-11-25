import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The reader's own sent prompt, shown at most ten lines tall in the conversation, with a
 * button that reveals the rest in place (wi_ef2dbd5b). There is no collapse.
 *
 * The full text stays in the page, clipped only visually, so copy, find-in-page and selection
 * still see all of it, though find-in-page cannot scroll text inside the clip into view (a known
 * limit). "Ten lines" is ten line-heights of the prompt's text at the current width: wrapped
 * lines count, and so does the spacing between paragraphs and around code (the delivery owner's
 * decision: Mike asked for "maybe 10 lines"). The limit follows rotation and pane resizes. Links
 * and controls in the clipped part cannot take focus until the prompt is expanded. Once expanded,
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

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
/** Holds a parked element's own tabindex (empty when it had none). */
const PARKED = 'data-clamp-tabindex';

function unpark(element: HTMLElement) {
  const own = element.getAttribute(PARKED);
  element.removeAttribute(PARKED);
  if (own) element.setAttribute('tabindex', own);
  else element.removeAttribute('tabindex');
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
    // Clipped to ten line-heights by CSS while collapsed; anything beyond is hidden text.
    const next = element.scrollHeight > element.clientHeight + 1;
    setOverflowing(current => current === next ? current : next);
    // Nothing hidden may take focus: park links and controls below the clip until expanded.
    const limit = element.getBoundingClientRect().top + element.clientHeight;
    for (const focusable of element.querySelectorAll<HTMLElement>(FOCUSABLE)) {
      const hidden = next && focusable.getBoundingClientRect().top >= limit - 1;
      const parked = focusable.hasAttribute(PARKED);
      if (hidden && !parked) {
        focusable.setAttribute(PARKED, focusable.getAttribute('tabindex') ?? '');
        focusable.setAttribute('tabindex', '-1');
      } else if (!hidden && parked) unpark(focusable);
    }
  }, []);

  useLayoutEffect(() => {
    if (expanded) return;
    measure();
    const element = content.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    // Width changes rewrap the text; images or code inside the prompt can change its height.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [expanded, measure, children]);

  const expand = () => {
    beforeExpand?.();
    rememberExpanded(conversation, identity);
    for (const parked of content.current?.querySelectorAll<HTMLElement>(`[${PARKED}]`) ?? []) unpark(parked);
    setExpanded(true);
    // The button goes away; keep keyboard focus on the message rather than dropping it to the page.
    content.current?.focus({ preventScroll: true });
  };

  const clamped = !expanded && overflowing;
  return <div className="tb-chat-prompt-clamp" data-expanded={expanded ? 'true' : undefined}
    data-clamped={clamped ? 'true' : undefined}>
    <div ref={content} id={contentId} className="tb-chat-prompt-clamp-content" tabIndex={-1}>{children}</div>
    {clamped && <button type="button" className="tb-chat-prompt-expand" aria-controls={contentId}
      aria-expanded="false" onClick={expand}>Show full message</button>}
  </div>;
}
