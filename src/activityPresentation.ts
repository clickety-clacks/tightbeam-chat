/** Display treatment for activity lines built from the selected conversation. */
export type ActivityPillTone = 'green' | 'amber' | 'orange' | 'red' | 'blue' | 'purple' | 'indigo' | 'slate';
export type ActivityPillIcon = 'message' | 'attest' | 'assignment' | 'decision' | 'work-item' |
  'decision-answered' | 'hourglass' | 'session' | 'turn' | 'remedy' | 'refused' |
  'alarm' | 'clock' | 'flag' | 'activity' | 'notice' | 'process';

export interface ActivityPillPresentation {
  readonly label: string;
  readonly tone: ActivityPillTone;
  readonly icon: ActivityPillIcon;
  readonly text: string;
  readonly metadata?: string;
  readonly summaryText?: string;
  readonly summaryPrefix?: string;
  readonly attestId?: string;
}

export interface ActivityPillSource {
  readonly kind: 'agent' | 'substrate' | 'rail';
  readonly gist: string;
  readonly content: string;
  readonly sender?: string;
  readonly senderDisplayName?: string;
  readonly source?: string;
  readonly messageType?: string;
  readonly turnSeq?: number;
}

const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
const lines = (value: string): string[] => value.split(/\r?\n/).map(normalize).filter(Boolean);
const transportLine = (line: string): boolean =>
  /^\[from [^\]]+\]$/i.test(line) || /^\[batched notices:\s*\d+\]$/i.test(line) ||
  /^batchId=/i.test(line) || /^release=/i.test(line) || /^\[\d+\]\s*(?:source|sender)=/i.test(line) ||
  /^coalesced by /i.test(line) || /^(?:messageType|source|cause|class|role|sender)=/i.test(line);
const semanticLines = (value: string): string[] => lines(value).filter(line => !transportLine(line));
const wireOnlyLine = (line: string): boolean => transportLine(line) ||
  /^(?:terminal-child-owner-notification|(?:source_kind|source_token|assignment_id|work_item_id|child_session_key|outcome|terminal_at)=)/i.test(line) ||
  /^\[(?:assignment:|woke:|turn failed\])/i.test(line);
const shortenVisibleIds = (value: string): string => value.replace(
  /\b((?:wi|asg|dr|att|s|w|c|tc)_)([a-z0-9]{4})[a-z0-9-]{4,}\b/gi,
  (_match, prefix: string, firstFour: string) => `${prefix}${firstFour}`,
);
function plainText(value: string): string {
  return shortenVisibleIds(lines(value).filter(line => !wireOnlyLine(line))
    .map(line => line.replace(/\[([^\]]*)\]/g, '$1').replace(/[\[\]]/g, '')).join(' '));
}

const idPattern = (prefix: string) => new RegExp(`\\b${prefix}_([a-z0-9][a-z0-9-]*)\\b`, 'i');

function shortId(prefix: string, source: string): string | undefined {
  const match = idPattern(prefix).exec(source);
  return match ? `${prefix}_${match[1].slice(0, 4).toLowerCase()}` : undefined;
}

function field(sourceLines: readonly string[], key: string): string | undefined {
  const line = sourceLines.find(value => value.startsWith(`${key}=`));
  if (!line) return undefined;
  const encoded = line.slice(key.length + 1);
  try {
    const value: unknown = JSON.parse(encoded);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return encoded || undefined;
  }
}

function childFinished(content: string): ActivityPillPresentation | undefined {
  const sourceLines = semanticLines(content);
  if (sourceLines[0] !== 'terminal-child-owner-notification') return undefined;
  const outcome = field(sourceLines.slice(1), 'outcome');
  const childSession = field(sourceLines.slice(1), 'child_session_key');
  const metadata = childSession ? shortId('s', childSession) : shortId('asg', content);
  if (outcome === 'completed') {
    return { label: 'Assignment', tone: 'green', icon: 'flag', text: 'Child finished', metadata };
  }
  if (outcome === 'surrendered') {
    return { label: 'Assignment', tone: 'amber', icon: 'flag', text: 'Child surrendered', metadata };
  }
  if (outcome === 'revoked') {
    return { label: 'Assignment', tone: 'slate', icon: 'flag', text: 'Child assignment revoked', metadata };
  }
  return { label: 'Assignment', tone: 'slate', icon: 'flag', text: 'Child activity ended', metadata };
}

function wakePresentation(content: string): ActivityPillPresentation | undefined {
  const sourceLines = semanticLines(content);
  const first = sourceLines[0] ?? '';
  if (/^\[woke:/i.test(first)) {
    const detail = sourceLines.find(line => !/^\[woke:/i.test(line));
    const header = /^\[woke:\s*([^\]]+)\]/i.exec(first)?.[1] ?? '';
    const fact = /^fact\s+(.+)\/(dr_[a-z0-9-]+)$/i.exec(header);
    const factStatus = fact && /(?:^|-)(ruled|answered|returned|expired|cancelled|canceled)$/i.exec(fact[1])?.[1];
    const status = /\bfallback\b/i.test(header) ? 'fallback'
      : fact ? factStatus ? `${factStatus} ${shortId('dr', fact[2])}` : 'condition met'
        : /^fact\b/i.test(header) ? 'condition met'
          : /^wait\b/i.test(header) ? 'resumed' : 'sent';
    return { label: 'Wake', tone: 'purple', icon: 'alarm',
      text: detail ?? 'A wake was delivered',
      summaryText: detail ? content.replace(/^\s*\[from [^\]]+\]\s*/i, '').replace(/^\s*\[woke:[^\n]*\]\s*/i, '').trim() : undefined,
      metadata: fact ? factStatus ? status : shortId('dr', fact[2]) ?? status
        : shortId('w', header) ?? shortId('asg', header) ?? shortId('dr', header) ?? status };
  }
  if (/^Wait finished on its assignment\b/i.test(first)) {
    return { label: 'Wake', tone: 'purple', icon: 'alarm', text: 'Wait finished on its assignment',
      metadata: shortId('w', content) ?? shortId('asg', content) };
  }
  return undefined;
}

function reminderPresentation(content: string): ActivityPillPresentation | undefined {
  const first = semanticLines(content)[0] ?? '';
  const quiet = /^Quiet for (\d+\s+(?:s(?:ec(?:ond)?s?)?|min(?:ute)?s?|h(?:r|our)?s?|d(?:ay)?s?))\s*[·•]/i.exec(first);
  if (quiet) {
    return { label: 'Assignment', tone: 'amber', icon: 'clock', text: first,
      metadata: shortId('asg', content) ?? shortId('wi', content) };
  }
  if (/^Assignment\b[^\r\n]*\bhas had no recorded activity since\b/i.test(first)) {
    const title = /^Assignment\s+asg_[a-z0-9-]+\s+\(([^)]+)\)/i.exec(first)?.[1];
    return { label: 'Assignment', tone: 'amber', icon: 'clock',
      text: title ? `No recent activity · ${title}` : 'No recorded activity', metadata: shortId('asg', content) };
  }
  return undefined;
}

function sourceKind(value?: string): string | undefined {
  const kind = value?.split(':', 1)[0]?.trim().toLowerCase();
  return kind || undefined;
}

function substrateTypePresentation(source: ActivityPillSource): ActivityPillPresentation | undefined {
  const messageType = source.messageType?.trim().toLowerCase().replace(/[_.\s]+/g, '-');
  const text = plainText(source.gist) || plainText(source.content) || 'Activity received';
  const metadata = shortId('asg', source.content) ?? shortId('wi', source.content) ??
    shortId('dr', source.content) ?? shortId('att', source.content) ?? shortId('s', source.content);
  const originKind = sourceKind(source.source) ?? sourceKind(source.sender);
  if (originKind === 'agent' || originKind === 'session' || messageType === 'agent') {
    return { label: 'Message', tone: 'indigo', icon: 'message', text, metadata };
  }
  if (originKind === 'remedy') return { label: 'Remedy', tone: 'orange', icon: 'remedy', text, metadata };
  if (messageType === 'process') return { label: 'System', tone: 'purple', icon: 'process', text, metadata };
  if (messageType === 'substrate') return { label: 'Notice', tone: 'blue', icon: 'notice', text, metadata };
  if (originKind === 'process') {
    return { label: 'System', tone: 'purple', icon: 'process', text, metadata };
  }
  return undefined;
}

function genericActivity(source: ActivityPillSource): ActivityPillPresentation {
  const metadata = shortId('asg', source.content) ?? shortId('wi', source.content) ??
    shortId('dr', source.content) ?? shortId('att', source.content) ?? shortId('s', source.content);
  return { label: 'Activity', tone: 'slate', icon: 'activity',
    text: plainText(source.gist) || plainText(source.content) || 'Activity received', metadata };
}

function decisionPresentation(content: string): ActivityPillPresentation | undefined {
  const sourceLines = semanticLines(content);
  const first = sourceLines[0] ?? '';
  let id: string | undefined;
  let tone: ActivityPillTone = 'blue';
  let text: string | undefined;
  let summaryText: string | undefined;
  let summaryPrefix = '';
  const raw = content.replace(/^\s*\[from [^\]]+\]\s*/i, '').trim();
  const afterHeader = raw.slice(raw.indexOf('\n') + 1).trim();

  let match = /^Question\s+(dr_[a-z0-9-]+)\s+from session:/i.exec(first);
  if (match) {
    id = match[1];
    text = sourceLines[1] ? `Needs a response · ${sourceLines[1]}` : 'Needs a response';
  } else if ((match = /^Question\s+(dr_[a-z0-9-]+)\s+was answered by\b/i.exec(first))) {
    id = match[1];
    tone = 'green';
    const question = sourceLines.find(line => /^You asked:\s*/i.test(line))?.replace(/^You asked:\s*/i, '');
    text = question ? `Answered · ${question}` : 'Answered';
  } else if ((match = /^Question\s+(dr_[a-z0-9-]+)\s+was returned by\b/i.exec(first))) {
    id = match[1];
    tone = 'slate';
    const question = sourceLines.find(line => /^You asked:\s*/i.test(line))?.replace(/^You asked:\s*/i, '');
    text = question ? `Returned · ${question}` : 'Returned for more information';
  } else if ((match = /^Decision\s+(dr_[a-z0-9-]+)\s+pending on\b/i.exec(first))) {
    id = match[1];
    text = sourceLines[1] ? `Pending · ${sourceLines[1]}` : 'Pending';
  } else if ((match = /^Decision\s+(dr_[a-z0-9-]+):\s*(.*)$/i.exec(first))) {
    id = match[1];
    text = match[2] || sourceLines[1];
  } else if ((match = /^Decision request\s+(dr_[a-z0-9-]+)\s+was ruled\b/i.exec(first))) {
    id = match[1];
    tone = 'green';
    text = 'Ruled';
  } else if ((match = /^Decision request\s+(dr_[a-z0-9-]+)\s+(?:expired|timed out)\b/i.exec(first))) {
    id = match[1];
    tone = 'slate';
    text = 'Expired';
  }

  if (text?.includes(' · ')) {
    summaryPrefix = text.slice(0, text.indexOf(' · ') + 3);
    summaryText = /^(Answered|Returned)/.test(text)
      ? /(?:^|\n)You asked:\s*([\s\S]*?)(?=\n(?:Answer|Response|Returned):|$)/i.exec(raw)?.[1]?.trim()
      : raw.includes('\n') ? afterHeader : undefined;
  } else if (/^Decision\s+dr_[a-z0-9-]+:/i.test(first)) {
    summaryText = raw.replace(/^Decision\s+dr_[a-z0-9-]+:\s*/i, '').trim();
  }
  const answered = tone === 'green';
  const expired = tone === 'slate';
  return id && text ? { label: 'Decision', tone, summaryText, summaryPrefix, icon: answered ? 'decision-answered' : expired ? 'hourglass' : 'decision', text,
    metadata: shortId('dr', id) } : undefined;
}

function workItemPresentation(content: string): ActivityPillPresentation | undefined {
  const first = semanticLines(content)[0] ?? '';
  let match = /^route it or icebox it\s*[—-]\s*work item\s+(wi_[a-z0-9-]+):\s*(.+)$/i.exec(first);
  if (match) {
    return { label: 'Work item', tone: 'amber', icon: 'work-item',
      text: `Needs routing · ${match[2]}`, metadata: shortId('wi', match[1]) };
  }
  match = /^slate clear on\s+(wi_[a-z0-9-]+):\s*close it, card more work, or rule it failed\.?$/i.exec(first);
  if (match) {
    return { label: 'Work item', tone: 'slate', icon: 'work-item',
      text: 'No open assignments · choose the next step', metadata: shortId('wi', match[1]) };
  }
  const generic = /^work item\s+(wi_[a-z0-9-]+)\s+(.*)$/i.exec(first);
  if (generic && /\b(?:created|opened|closed|failed|reopened|updated|needs|has no)\b/i.test(generic[2])) {
    return { label: 'Work item', tone: 'slate', icon: 'work-item',
      text: normalize(generic[2]), metadata: shortId('wi', generic[1]) };
  }
  return undefined;
}

function assignmentPresentation(content: string): ActivityPillPresentation | undefined {
  const sourceLines = semanticLines(content);
  const first = sourceLines[0] ?? '';
  const match = /^\[assignment:\s*(asg_[a-z0-9-]+)\s*\]$/i.exec(first);
  if (!match) return undefined;
  const subject = sourceLines[1];
  return { label: 'Assignment', tone: 'blue', icon: 'assignment',
    text: subject ? `New · ${subject}` : 'New assignment', metadata: shortId('asg', match[1]) };
}

function noticeStatusText(value: string): string {
  const words = normalize(value.replace(/[-_]+/g, ' ')).toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : 'Recorded';
}

function deliveredNoticePresentation(content: string): ActivityPillPresentation | undefined {
  const first = semanticLines(content)[0] ?? '';
  let match = /^\[verdict filed:\s*([a-z][a-z0-9-]*)\s+on\s+(asg_[a-z0-9-]+)\s*:\s*(.*?)\s*\]$/i.exec(first);
  if (match) {
    const verdict = match[1].toLowerCase();
    const status = noticeStatusText(verdict);
    const detail = plainText(match[3]);
    const clean = new Set(['spirit-approved', 'reviewed-clean', 'verified', 'landed', 'approved']);
    const adverse = new Set([
      'changes-requested', 'verification-failed', 'wait-challenged',
      'failed', 'blocked', 'refused', 'cannot-proceed',
    ]);
    return { label: 'Verdict', tone: clean.has(verdict) ? 'green' : adverse.has(verdict) ? 'red' : 'indigo',
      icon: 'decision', text: detail ? `${status} · ${detail}` : status, metadata: shortId('asg', match[2]) };
  }

  match = /^\[completion filed on\s+(asg_[a-z0-9-]+)\s*:\s*(.*?)\s*\]$/i.exec(first);
  if (match) {
    const detail = plainText(match[2]);
    const text = !detail || /^(?:completed|finished)\b/i.test(detail) ? detail || 'Completed' : `Completed · ${detail}`;
    return { label: 'Completion', tone: 'purple', icon: 'attest', text, metadata: shortId('asg', match[1]) };
  }

  match = /^\[assignment opened:\s*(asg_[a-z0-9-]+)\s*\]$/i.exec(first);
  if (match) {
    return { label: 'Assignment opened', tone: 'blue', icon: 'assignment', text: 'Opened',
      metadata: shortId('asg', match[1]) };
  }

  match = /^\[assignment closed:\s*(asg_[a-z0-9-]+)\s*[—–-]\s*(.*?)\s*\]$/i.exec(first);
  if (match) {
    const rawOutcome = plainText(match[2]);
    const statusLike = /^[a-z][a-z0-9-]*$/i.test(rawOutcome);
    const outcome = statusLike ? noticeStatusText(rawOutcome) : rawOutcome;
    const normalizedOutcome = rawOutcome.toLowerCase().replace(/[-_]+/g, ' ');
    const tone = ['failed', 'revoked', 'refused', 'cannot proceed'].includes(normalizedOutcome) ? 'red'
      : normalizedOutcome === 'surrendered' ? 'amber' : 'slate';
    return { label: 'Assignment closed', tone, icon: 'flag', text: outcome || 'Closed',
      metadata: shortId('asg', match[1]) };
  }
  return undefined;
}

function commonNoticePresentation(content: string): ActivityPillPresentation | undefined {
  const first = semanticLines(content)[0] ?? '';
  let match = /^\[progress filed on\s+(asg_[a-z0-9-]+)\s*:\s*(.*?)\s*\]$/i.exec(first);
  if (match) {
    return { label: 'Progress', tone: 'indigo', icon: 'activity',
      text: plainText(match[2]) || 'Progress recorded', metadata: shortId('asg', match[1]) };
  }

  match = /^\[cannot-proceed filed on\s+(asg_[a-z0-9-]+)\s*:\s*(.*?)\s*\]$/i.exec(first);
  if (match) {
    const reason = plainText(match[2]);
    return { label: 'Action blocked', tone: 'orange', icon: 'refused',
      text: reason ? `Could not proceed · ${reason}` : 'Could not proceed', metadata: shortId('asg', match[1]) };
  }

  if (/^\[cannot-proceed settled by opener answer\]$/i.test(first)) {
    return { label: 'Blocker cleared', tone: 'green', icon: 'decision-answered',
      text: 'Cleared by the opener’s answer' };
  }

  match = /^\[cannot-proceed released:\s*(asg_[a-z0-9-]+)\s+by\s+([^/\]]+)\/([^\]]+)\]$/i.exec(first);
  if (match) {
    return { label: 'Blocker released', tone: 'green', icon: 'decision-answered', text: 'Released',
      metadata: shortId('asg', match[1]) };
  }

  match = /^\[assignment revoked:\s*(asg_[a-z0-9-]+)\s*\]$/i.exec(first);
  if (match) {
    return { label: 'Assignment revoked', tone: 'red', icon: 'flag', text: 'Revoked',
      metadata: shortId('asg', match[1]) };
  }

  match = /^\[assignment reopened:\s*(asg_[a-z0-9-]+)(?:\s+by\b[^\]]*)?\]$/i.exec(first);
  if (match) {
    const reason = /^\[assignment reopened:\s*asg_[a-z0-9-]+\s+by\b.*?\s+[—–-]\s*(.*?)\s*\]$/i.exec(first)?.[1];
    return { label: 'Assignment reopened', tone: 'indigo', icon: 'assignment',
      text: reason ? `Reopened · ${plainText(reason)}` : 'Reopened',
      metadata: shortId('asg', match[1]) };
  }

  if (/^\[context compacted\]$/i.test(first)) {
    return { label: 'Conversation', tone: 'slate', icon: 'notice', text: 'Context shortened' };
  }
  if (/^\[adapter down\]$/i.test(first)) {
    return { label: 'Connection', tone: 'amber', icon: 'alarm', text: 'Connection unavailable' };
  }
  if (/^\[engine swap\]$/i.test(first)) {
    return { label: 'Model', tone: 'purple', icon: 'process', text: 'Model changed' };
  }
  return undefined;
}

function sessionPresentation(content: string): ActivityPillPresentation | undefined {
  const first = semanticLines(content)[0] ?? '';
  const id = shortId('s', first);
  if (!id || !/\bsession\b/i.test(first)) return undefined;
  const verb = /\b(retired|archived|restarted|resumed|stopped|created|updated|renamed)\b/i.exec(first)?.[1];
  if (!verb) return undefined;
  const labels: Record<string, string> = {
    retired: 'Retired', archived: 'Archived', restarted: 'Restarted', resumed: 'Resumed',
    stopped: 'Stopped', created: 'Created', updated: 'Updated', renamed: 'Renamed',
  };
  const text = labels[verb.toLowerCase()] ?? 'Session updated';
  return { label: 'Session', tone: verb.toLowerCase() === 'retired' || verb.toLowerCase() === 'archived' ? 'slate' : 'blue',
    icon: 'session', text, metadata: id };
}

function turnFailure(content: string, turnSeq?: number): ActivityPillPresentation | undefined {
  const sourceLines = semanticLines(content);
  if (sourceLines[0] !== '[turn failed]') return undefined;
  const detail = sourceLines.find(line => line !== '[turn failed]');
  return { label: 'Turn', tone: 'red', icon: 'turn',
    text: detail ?? 'The agent turn failed', metadata: Number.isSafeInteger(turnSeq) ? `turn ${turnSeq}` : undefined };
}

function attestPresentation(content: string): ActivityPillPresentation | undefined {
  const first = semanticLines(content)[0] ?? '';
  const match = /^Attest\s+(att_[a-z0-9-]+)\s+\(([^)]+)\)\s+was filed on assignment\s+(asg_[a-z0-9-]+)\.?$/i.exec(first);
  if (!match) return undefined;
  return { label: 'Attest', tone: 'amber', icon: 'attest',
    text: `Filed ${match[2]} on assignment ${shortId('asg', match[3])}`,
    metadata: shortId('att', match[1]), attestId: match[1] };
}

function remedyPresentation(gist: string, content: string): ActivityPillPresentation | undefined {
  if (!/^Remedy\b/i.test(gist)) return undefined;
  const detail = gist.split(/\s+—\s+/)[1];
  return { label: 'Remedy', tone: 'orange', icon: 'remedy',
    text: detail || 'A rule suggests a change', metadata: shortId('asg', content) };
}

function refusalPresentation(gist: string): ActivityPillPresentation | undefined {
  const match = /^(.+?)\s+refused by\s+(.+)$/i.exec(gist);
  if (!match) return undefined;
  const rule = match[2].toLowerCase();
  const text = rule === 'completion-requires-verification' ? 'Completion needs a recorded verification first'
    : rule === 'completion-requires-review' ? 'Completion needs an independent review first'
      : rule === 'completion-requires-artifact' ? 'Completion needs the required artifact first'
        : `${normalize(match[1])} was not allowed`;
  return { label: 'Refused', tone: 'red', icon: 'refused', text,
    metadata: shortId('asg', gist) };
}

/**
 * Keep source-specific wording limited to recognizable shapes. Unclassified
 * activity stays visible with a neutral pill; tool records use their separate
 * renderer and are intentionally outside this presentation path.
 */
export function activityPillPresentation(source: ActivityPillSource): ActivityPillPresentation | undefined {
  let presentation: ActivityPillPresentation;
  if (source.kind === 'agent') {
    const separator = source.gist.indexOf(' — ');
    const sender = separator >= 0 ? source.gist.slice(0, separator) : 'Another agent';
    const text = separator >= 0 ? source.gist.slice(separator + 3) : source.gist;
    const displayName = source.senderDisplayName?.trim() || (sender === 'Another agent' ? undefined : sender);
    presentation = { label: 'Message', tone: 'indigo', icon: 'message',
      text: plainText(text) || plainText(source.content) || 'Message received', metadata: displayName };
  } else if (source.kind === 'rail') {
    presentation = remedyPresentation(source.gist, source.content) ?? refusalPresentation(source.gist) ?? genericActivity(source);
  } else {
    presentation = wakePresentation(source.content) ?? reminderPresentation(source.content) ??
      childFinished(source.content) ?? turnFailure(source.content, source.turnSeq) ??
      deliveredNoticePresentation(source.content) ?? commonNoticePresentation(source.content) ??
      attestPresentation(source.content) ?? assignmentPresentation(source.content) ??
      decisionPresentation(source.content) ?? workItemPresentation(source.content) ??
      sessionPresentation(source.content) ?? remedyPresentation(source.gist, source.content) ??
      substrateTypePresentation(source) ?? genericActivity(source);
  }
  if (presentation.icon === 'message' || presentation.icon === 'remedy') {
    presentation = { ...presentation, summaryText: source.content };
  }
  return { ...presentation,
    label: plainText(presentation.label) || 'Activity',
    text: plainText(presentation.text) || 'Activity received',
    metadata: presentation.metadata ? plainText(presentation.metadata) || undefined : undefined };
}
