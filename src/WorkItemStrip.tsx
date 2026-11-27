import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { formatVisibleIds } from './activityPresentation';
import { stripProvenanceMarkup } from './displayText';
import {
  AgentNames, foundState, readWorkItemSheet, type ChainStep, type WorkItemSheetData, type WorkItemSheetTransport,
} from './workItemChain';
import { workItemBaseState, type WorkItemPill, type WorkItemPills, type WorkItemPillState } from './workItemPills';
import type { WorkItemCloseReason, WorkItemSummary } from './types';
import { agoText, clockText, untilText } from './workItemTime';
import './workItemPills.css';

type ShownState = WorkItemPillState | 'waiting' | 'you';

const words: Readonly<Record<ShownState, string>> = {
  'not-started': 'Not started', held: 'Held', working: 'Working now', 'between-hands': 'Between hands', done: 'Closed',
  failed: 'Failed', shelved: 'Shelved', waiting: 'Waiting', you: 'Waiting on you',
};

const paths = {
  'not-started': <path d="M12 5v14M5 12h14" />,
  held: <><path d="M5 20c0-3.6 3-6 7-6s7 2.4 7 6" /><circle cx="12" cy="8.5" r="3.5" /></>,
  working: <path d="M8.5 5.5v13l10.5-6.5z" />,
  'between-hands': <path d="M4 8.5h13M13.5 5l3.5 3.5-3.5 3.5M20 15.5H7M10.5 12 7 15.5l3.5 3.5" />,
  done: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  failed: <path d="M6 6l12 12M18 6 6 18" />,
  shelved: <path d="M9 6v12M15 6v12" />,
  waiting: <path d="M7 3.5h10M7 20.5h10M8 3.5c0 5 8 5 8 8.5s-8 3.5-8 8.5M16 3.5c0 5-8 5-8 8.5s8 3.5 8 8.5" />,
  you: <path d="M20.5 11.5a8.5 8.5 0 0 1-12.4 7.5L3.5 20.5l1.5-4.6a8.5 8.5 0 1 1 15.5-4.4z" />,
  unknown: <path d="M9 9.2a3 3 0 1 1 4.6 2.5c-1 .7-1.6 1.2-1.6 2.5M12 17.6v.2" />,
  loop: <path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L20 9.4M20 4.5v4.9h-4.9M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4 14.6M4 19.5v-4.9h4.9" />,
  layers: <><path d="M12 3.5 3 8.5l9 5 9-5z" /><path d="M3 13.5l9 5 9-5" /></>,
} as const;

const Icon = ({ name }: { readonly name: keyof typeof paths }) =>
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;

const plain = (value: string): string => formatVisibleIds(stripProvenanceMarkup(value)).replace(/\s+/g, ' ').trim();

/** Titles usually open with their product; the pill keeps the part that differs. */
export function pillTitle(title: string): string {
  const text = plain(title);
  const rest = /^[^:]{2,40}:\s+(.{4,})$/.exec(text)?.[1];
  return rest ?? text;
}

const closeWords: Readonly<Record<WorkItemCloseReason, string>> = {
  completed: 'Completed', canceled: 'Canceled', superseded: 'Superseded',
};

function stateText(state: ShownState, stale: boolean, item?: WorkItemSummary): string {
  const reason = state === 'done' && item?.state === 'closed' ? item.closeReason : undefined;
  const word = (reason && closeWords[reason]) || words[state];
  return stale ? `Was ${word.toLowerCase()}` : word;
}

const Pill = memo(function Pill({ pill, onOpen, register }: {
  readonly pill: WorkItemPill;
  readonly onOpen: (id: string) => void;
  readonly register: (id: string, element: HTMLElement | null) => void;
}) {
  const ref = useCallback((element: HTMLButtonElement | null) => { register(pill.id, element); }, [pill.id, register]);
  const text = stateText(pill.state, pill.stale, pill.summary);
  const full = plain(pill.title);
  return <button type="button" ref={ref} className={`tb-chat-work-pill${pill.stale ? ' tb-chat-work-pill-stale' : ''}`}
    data-state={pill.state} data-work-item={pill.id} title={full}
    aria-label={`${full}. ${text}${pill.stale ? '. Changed, not read again yet' : ''}`} onClick={() => onOpen(pill.id)}>
    <span className={`tb-chat-work-disc${pill.state === 'working' ? ' tb-chat-work-ring' : ''}`}><Icon name={pill.state} /></span>
    <span className="tb-chat-work-pill-text">
      <span className="tb-chat-work-pill-title">{pillTitle(pill.title)}</span>
      <span className="tb-chat-work-pill-state">{text}</span>
    </span>
  </button>;
});

const HIDDEN_KEY = 'tb-chat-work-items-hidden';
export function readHidden(): boolean {
  try { return window.localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
}
export function writeHidden(hidden: boolean): void {
  try {
    if (hidden) window.localStorage.setItem(HIDDEN_KEY, '1');
    else window.localStorage.removeItem(HIDDEN_KEY);
  } catch { /* Storage may be unavailable. */ }
}

/** The strip above the message box. It is absent while there is nothing to show. */
export function WorkItemStrip({ pills, folded, onOpen, onShown }: {
  readonly pills: WorkItemPills;
  /** Too little conversation is left to spend a row on pills. */
  readonly folded: boolean;
  readonly onOpen: (id: string) => void;
  readonly onShown: (shown: boolean) => void;
}) {
  const snapshot = useSyncExternalStore(pills.subscribe, pills.getSnapshot, pills.getSnapshot);
  const [hidden, setHidden] = useState(readHidden);
  const closed = hidden || folded;
  const scroller = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const inView = useRef(new Set<string>());
  const observer = useRef<IntersectionObserver | undefined>(undefined);
  const shown = snapshot.length > 0;

  const report = useCallback(() => {
    pills.setVisible(new Set(inView.current), typeof document === 'undefined' || document.visibilityState === 'visible');
  }, [pills]);
  const register = useCallback((id: string, element: HTMLElement | null) => {
    const previous = elements.current.get(id);
    if (previous) observer.current?.unobserve(previous);
    if (element) {
      elements.current.set(id, element);
      observer.current?.observe(element);
    } else if (elements.current.delete(id) && inView.current.delete(id)) report();
  }, [report]);

  useLayoutEffect(() => { onShown(shown); return () => onShown(false); }, [onShown, shown]);
  useEffect(() => {
    if (closed || !scroller.current || typeof IntersectionObserver === 'undefined') return;
    observer.current = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.workItem!;
        if (entry.intersectionRatio >= 0.5) inView.current.add(id);
        else inView.current.delete(id);
      }
      report();
    }, { root: scroller.current, threshold: 0.5 });
    for (const element of elements.current.values()) observer.current.observe(element);
    return () => {
      observer.current?.disconnect();
      observer.current = undefined;
      inView.current.clear();
      report();
    };
  }, [closed, report, shown]);
  useEffect(() => {
    document.addEventListener('visibilitychange', report);
    return () => document.removeEventListener('visibilitychange', report);
  }, [report]);

  if (!shown) return null;
  const running = snapshot.some((pill) => pill.state === 'working');
  const label = `${closed ? 'Show' : 'Hide'} ${snapshot.length} work ${snapshot.length === 1 ? 'item' : 'items'}`;
  return <div className={`tb-chat-work-items tb-chat-work-strip${closed ? ' tb-chat-work-strip-closed' : ''}`}>
    <button type="button" className="tb-chat-work-toggle" aria-expanded={!closed} aria-label={label} title={label}
      disabled={folded} onClick={() => { setHidden(!hidden); writeHidden(!hidden); }}>
      <Icon name="layers" />
      {closed && <span>{snapshot.length}</span>}
      {closed && running && <span className="tb-chat-work-toggle-running" aria-hidden="true" />}
    </button>
    {!closed && <div ref={scroller} className="tb-chat-work-scroller" role="group" aria-label="Work items, newest first">
      {snapshot.map((pill) => <Pill key={pill.id} pill={pill} onOpen={onOpen} register={register} />)}
    </div>}
  </div>;
}

function When({ since, until, untilLabel, strong = false, now }: {
  readonly since: number | null; readonly until: number | null; readonly untilLabel: string;
  readonly strong?: boolean; readonly now: number;
}) {
  if (since === null && until === null) return null;
  return <dl className={`tb-chat-work-when${strong ? ' tb-chat-work-when-strong' : ''}`}>
    {since !== null && <><dt>Since</dt><dd><b>{clockText(since, now)}</b> · {agoText(since, now)}</dd></>}
    {until !== null && <><dt>{untilLabel}</dt><dd className="tb-chat-work-until"><b>{clockText(until, now)}</b> · {untilText(until, now)}</dd></>}
  </dl>;
}

function waitText(step: Extract<ChainStep, { kind: 'wait' }>): ReactNode {
  switch (step.target.kind) {
    case 'item': return <>Waits for a notice about <b>{plain(step.target.title)}</b>.</>;
    case 'notice': return <>Waits for a notice named <b>{plain(step.target.name)}</b>
      {step.target.scope && <> ({plain(step.target.scope)})</>}.</>;
    case 'agent': return <>Cannot go on until <b>{plain(step.target.agent)}</b> answers.</>;
    case 'time': return step.recurring ? 'Is woken again and again on a schedule.'
      : 'Waits until a set time. It may also be waiting for another agent to finish; Tightbeam does not let Chat read that.';
  }
}

const endText: Readonly<Record<string, string>> = { closed: 'is done', failed: 'failed', iceboxed: 'is shelved' };
const unreadable: Readonly<Record<Extract<ChainStep, { kind: 'unreadable' }>['what'], readonly [string, string]>> = {
  notice: ['Can’t tell who will send it', 'The notice names no work item that can be looked up, and Tightbeam does not record who will send it.'],
  time: ['Can’t tell what comes next', 'Nothing Chat can read links this wait to another agent.'],
  item: ['Can’t tell what comes next', 'What this waits on could not be read.'],
  wait: ['This wait could not be read', 'It may just have ended.'],
};

function Step({ step, now }: { readonly step: ChainStep; readonly now: number }) {
  const line = (icon: keyof typeof paths, kind: string, title: string, body: ReactNode, extra?: ReactNode, ring = false) =>
    <li className={`tb-chat-work-step tb-chat-work-step-${kind}`}>
      <span className={`tb-chat-work-node${ring ? ' tb-chat-work-ring' : ''}`}><Icon name={icon} /></span>
      <div><h3>{plain(title)}</h3><p className="tb-chat-work-what">{body}</p>{extra}</div>
    </li>;
  switch (step.kind) {
    case 'wait': return line('waiting', 'wait', step.agent, waitText(step), <>
      <When since={step.since} until={step.recurring && step.target.kind === 'time' ? null : step.until}
        untilLabel={step.target.kind === 'time' ? 'Wakes by' : 'At the latest'} strong={step.target.kind === 'time'} now={now} />
      <p className={`tb-chat-work-why${step.reason ? '' : ' tb-chat-work-why-none'}`}>{step.reason ? plain(step.reason) : 'No reason given'}</p>
      {!step.tied && <p className="tb-chat-work-note">The agent did not tie this wait to this work item. It may be for other work it has.</p>}
      {step.setByOther && <p className="tb-chat-work-note">Someone else set this reminder.</p>}
    </>);
    case 'running': return line('working', 'run', step.agent, step.tied
      ? <>Running a turn on {step.title ? <b>{plain(step.title)}</b> : 'this work'} now.</>
      : 'Running a turn now. It is not tied to this work, so it may be about something else.',
    <When since={step.since} until={null} untilLabel="" now={now} />, true);
    case 'queued': return line('held', 'idle', step.agent, 'Has a message or turn about to start.');
    case 'idle': return line('held', 'idle', step.agent, <>Has {step.title ? <b>{plain(step.title)}</b> : 'this work'}. No turn is running and no wait is set, so nothing is moving.
      {step.endedAt !== null && ` Its last turn ended ${agoText(step.endedAt, now)}.`}</>);
    case 'retired': return line('between-hands', 'idle', step.agent, 'This agent has been retired while still holding the work, so nobody is on it.');
    case 'ended': return line('done', 'idle', step.title, `That work ${endText[step.state] ?? 'has ended'}. The notice has not come.`);
    case 'nobody': return line('between-hands', 'idle', step.title, 'No agent has that work now.');
    case 'loop': return line('loop', 'loop', 'This comes back to where it started', <>It leads back to <b>{plain(step.title)}</b>, so each waits for the other and neither is running.</>);
    case 'limit': return line('unknown', 'unknown', 'Stopped here', 'There is more, but a tap follows only so far.');
    case 'unreadable': return line('unknown', 'unknown', unreadable[step.what][0], unreadable[step.what][1]);
  }
}

const endings: Readonly<Partial<Record<WorkItemPillState, string>>> = {
  'not-started': 'No agent has been given this yet.',
  'between-hands': 'It was started and no agent has it now.',
  failed: 'Ended without being done.', shelved: 'Put aside on purpose.',
};

type SheetState = { readonly status: 'looking' } | { readonly status: 'failed' } | { readonly status: 'gone' }
  | { readonly status: 'ready'; readonly data: WorkItemSheetData } | { readonly status: 'updated' };

/** Everything here is read only because the reader tapped this one pill. */
export function WorkItemSheet({ id, pills, transport, names, onClose }: {
  readonly id: string;
  readonly pills: WorkItemPills;
  readonly transport: WorkItemSheetTransport;
  readonly names: AgentNames;
  readonly onClose: () => void;
}) {
  const snapshot = useSyncExternalStore(pills.subscribe, pills.getSnapshot, pills.getSnapshot);
  const pill = snapshot.find((row) => row.id === id);
  // Finished work that has not changed since its one read needs nothing more. Open
  // work is always read: a question can be open with no agent holding it.
  const settled = pill && !pill.stale && pill.summary.state !== 'open';
  const [state, setState] = useState<SheetState>({ status: 'looking' });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const sheet = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const readNow = useRef(!settled);

  useEffect(() => {
    if (!readNow.current) return;
    const controller = new AbortController();
    setState({ status: 'looking' });
    const seen = pills.changesSeen(id);
    readWorkItemSheet(id, transport, names, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setNow(Date.now());
      setState(data ? { status: 'ready', data } : { status: 'gone' });
      if (data) pills.acceptRead(data.item, seen);
    }, () => { if (!controller.signal.aborted) setState({ status: 'failed' }); });
    return () => controller.abort();
  }, [attempt, id, names, pills, transport]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useLayoutEffect(() => { closeButton.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !sheet.current) return;
      const stops = [...sheet.current.querySelectorAll<HTMLElement>('button, [tabindex="0"]')];
      const index = stops.indexOf(document.activeElement as HTMLElement);
      const next = stops[(index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length];
      event.preventDefault();
      next?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tap = state.status === 'ready' ? state.data : undefined;
  const summary = pill?.summary;
  const item = tap && (!summary || tap.item.rowVersion > summary.rowVersion) ? tap.item : summary;
  // A state or holder change can invalidate the tap's wait chain and questions.
  // Discard those details so a later return to the same state cannot revive them.
  const data = tap && item && tap.item.state === item.state && tap.item.holders.length === item.holders.length
    && tap.item.holders.every(holder => item.holders.includes(holder)) ? tap : undefined;
  useLayoutEffect(() => {
    if (tap && !data) setState({ status: 'updated' });
  }, [tap, data]);
  const base = item && item !== summary ? workItemBaseState(item) : pill?.state ?? 'held';
  const shown: ShownState = (data && foundState(data)) ?? base;
  const ended = base === 'done' ? `${stateText(base, false, item)}.` : item && endings[base];
  const lead = shown === 'you' ? 'The next move is yours.' : shown === 'waiting' ? 'This is what it waits on, step by step.' : undefined;
  return <div className="tb-chat-work-items tb-chat-work-layer">
    <button type="button" className="tb-chat-work-scrim" aria-label="Close work item" tabIndex={-1} onClick={onClose} />
    <section ref={sheet} className="tb-chat-work-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header>
        <div>
          <span className="tb-chat-work-chip" data-state={shown}><Icon name={shown} />
            {stateText(shown, pill?.stale === true && !data, item)}</span>
          <h2 id={titleId}>{item ? plain(item.title) : 'Work item'}</h2>
        </div>
        <button ref={closeButton} type="button" className="tb-chat-modal-close" aria-label="Close work item" onClick={onClose}>×</button>
      </header>
      <div className="tb-chat-work-sheet-body" tabIndex={0} aria-live="polite" aria-busy={state.status === 'looking' && readNow.current}>
        {(settled || state.status === 'updated') && !data && ended && <p className="tb-chat-work-box">{ended}{item?.failReason && ` ${plain(item.failReason)}`}</p>}
        {readNow.current && state.status === 'looking' && <p className="tb-chat-work-note" role="status">Looking…</p>}
        {readNow.current && state.status === 'gone' && <p className="tb-chat-work-box">This work item is no longer available.</p>}
        {readNow.current && state.status === 'failed' && <p className="tb-chat-work-box">This could not be read. <button type="button"
          onClick={() => setAttempt((value) => value + 1)}>Try again</button></p>}
        {data && <>
          {lead && <p>{lead}</p>}
          {data.questions === undefined && <p className="tb-chat-work-note">Your open questions could not be read, so this may also be waiting on you.</p>}
          {data.questions?.map((question) => <div className="tb-chat-work-question" key={question.id}>
            <h3>Waiting on you</h3>
            <p className="tb-chat-work-question-text">{formatVisibleIds(stripProvenanceMarkup(question.question))}</p>
            {question.options.length > 0 && <ul>{question.options.map((option) => <li key={option}>{plain(option)}</li>)}</ul>}
            <When since={question.raisedAt} until={question.deadlineAt} untilLabel="Answer by" now={now} />
            <p className="tb-chat-work-note">Asked by {plain(question.asker)}</p>
          </div>)}
          {data.groups.map((group, index) => <div key={index}>
            {data.groups.length > 1 && <p className="tb-chat-work-group">{plain(group.agent)}</p>}
            <ol className="tb-chat-work-chain">{group.steps.map((step, at) => <Step key={at} step={step} now={now} />)}</ol>
          </div>)}
          {data.moreHolders > 0 && <p className="tb-chat-work-note">{data.moreHolders} more {data.moreHolders === 1 ? 'agent has' : 'agents have'} this work.</p>}
          {data.groups.length === 0 && ended && <p className="tb-chat-work-box">{ended}{item?.failReason && ` ${plain(item.failReason)}`}</p>}
        </>}
      </div>
    </section>
  </div>;
}

/** Strip and sheet together, for one opened conversation. */
export function WorkItems({ pills, transport, folded, onShown, onSheetOpen, sheetSlot }: {
  readonly pills: WorkItemPills;
  readonly transport: WorkItemSheetTransport;
  readonly folded: boolean;
  readonly onShown: (shown: boolean) => void;
  readonly onSheetOpen: (open: boolean) => void;
  /** False while another dialog is open. */
  readonly sheetSlot: boolean;
}) {
  const [open, setOpen] = useState<string>();
  const names = useMemo(() => new AgentNames(), [pills]);
  const opener = useRef<HTMLElement | null>(null);
  const show = useCallback((id: string) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(id);
  }, []);
  const close = useCallback(() => {
    setOpen(undefined);
    opener.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => { if (!sheetSlot) setOpen(undefined); }, [sheetSlot]);
  useLayoutEffect(() => { onSheetOpen(open !== undefined); }, [onSheetOpen, open]);
  return <>
    <WorkItemStrip pills={pills} folded={folded} onOpen={show} onShown={onShown} />
    {open !== undefined && sheetSlot && <WorkItemSheet key={open} id={open} pills={pills} transport={transport} names={names} onClose={close} />}
  </>;
}
