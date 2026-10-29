/** Display treatment for the lower-volume activity lines with stable source text. */
export type ActivityPillTone = 'green' | 'amber' | 'orange' | 'red' | 'blue' | 'indigo' | 'slate';
export type ActivityPillIcon = 'message' | 'attest' | 'assignment' | 'decision' | 'work-item' |
  'session' | 'turn' | 'remedy' | 'refused';

export interface ActivityPillPresentation {
  readonly label: string;
  readonly tone: ActivityPillTone;
  readonly icon: ActivityPillIcon;
  readonly text: string;
  readonly metadata?: string;
}

export interface ActivityPillSource {
  readonly kind: 'agent' | 'substrate' | 'rail';
  readonly gist: string;
  readonly content: string;
  readonly sender?: string;
  readonly senderDisplayName?: string;
  readonly turnSeq?: number;
}

const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
const lines = (value: string): string[] => value.split(/\r?\n/).map(normalize).filter(Boolean);
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
  const sourceLines = lines(content);
  if (sourceLines[0] !== 'terminal-child-owner-notification') return undefined;
  const outcome = field(sourceLines.slice(1), 'outcome');
  const childSession = field(sourceLines.slice(1), 'child_session_key');
  const metadata = childSession ? shortId('s', childSession) : shortId('asg', content);
  if (outcome === 'completed') {
    return { label: 'Assignment', tone: 'green', icon: 'assignment', text: 'Child finished', metadata };
  }
  if (outcome === 'surrendered') {
    return { label: 'Assignment', tone: 'amber', icon: 'assignment', text: 'Child surrendered', metadata };
  }
  if (outcome === 'revoked') {
    return { label: 'Assignment', tone: 'slate', icon: 'assignment', text: 'Child assignment revoked', metadata };
  }
  return { label: 'Assignment', tone: 'slate', icon: 'assignment', text: 'Child activity ended', metadata };
}

function isExcludedWakeOrReminder(content: string): boolean {
  const first = lines(content)[0] ?? '';
  return /^\[woke:/i.test(first) || /^Wait finished on its assignment\b/i.test(first) ||
    /^Quiet for \d+\s+(?:s(?:ec(?:ond)?s?)?|min(?:ute)?s?|h(?:r|our)?s?|d(?:ay)?s?)\s*[·•]/i.test(first) ||
    /^Assignment\b[^\r\n]*\bhas had no recorded activity since\b/i.test(first);
}

function decisionPresentation(content: string): ActivityPillPresentation | undefined {
  const sourceLines = lines(content);
  const first = sourceLines[0] ?? '';
  let id: string | undefined;
  let tone: ActivityPillTone = 'blue';
  let text: string | undefined;

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
  }

  return id && text ? { label: 'Decision', tone, icon: 'decision', text,
    metadata: shortId('dr', id) } : undefined;
}

function workItemPresentation(content: string): ActivityPillPresentation | undefined {
  const first = lines(content)[0] ?? '';
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
  const sourceLines = lines(content);
  const first = sourceLines[0] ?? '';
  const match = /^\[assignment:\s*(asg_[a-z0-9-]+)\s*\]$/i.exec(first);
  if (!match) return undefined;
  const subject = sourceLines[1];
  return { label: 'Assignment', tone: 'blue', icon: 'assignment',
    text: subject ? `New · ${subject}` : 'New assignment', metadata: shortId('asg', match[1]) };
}

function sessionPresentation(content: string): ActivityPillPresentation | undefined {
  const first = lines(content)[0] ?? '';
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
  const sourceLines = lines(content);
  if (sourceLines[0] !== '[turn failed]') return undefined;
  const detail = sourceLines.find(line => line !== '[turn failed]');
  return { label: 'Turn', tone: 'red', icon: 'turn',
    text: detail ?? 'The agent turn failed', metadata: Number.isSafeInteger(turnSeq) ? `turn ${turnSeq}` : undefined };
}

function attestPresentation(content: string): ActivityPillPresentation | undefined {
  const first = lines(content)[0] ?? '';
  const match = /^Attest\s+(att_[a-z0-9-]+)\s+\(([^)]+)\)\s+was filed on assignment\s+(asg_[a-z0-9-]+)\.?$/i.exec(first);
  if (!match) return undefined;
  return { label: 'Attest', tone: 'amber', icon: 'attest',
    text: `Filed ${match[2]} on assignment ${shortId('asg', match[3])}`,
    metadata: shortId('att', match[1]) };
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
  return { label: 'Refused', tone: 'red', icon: 'refused', text: `${match[1]} refused` };
}

/**
 * Keep the pill treatment limited to stable message shapes. Wakes, inactivity
 * reminders, tools, and unrecognized activity continue through the old renderer.
 */
export function activityPillPresentation(source: ActivityPillSource): ActivityPillPresentation | undefined {
  if (source.kind === 'agent') {
    const separator = source.gist.indexOf(' — ');
    const sender = separator >= 0 ? source.gist.slice(0, separator) : 'Another agent';
    const text = separator >= 0 ? source.gist.slice(separator + 3) : source.gist;
    const displayName = source.senderDisplayName?.trim() || (sender === 'Another agent' ? undefined : sender);
    return { label: 'Message', tone: 'indigo', icon: 'message', text: text || 'Message received', metadata: displayName };
  }
  if (source.kind === 'rail') return remedyPresentation(source.gist, source.content) ?? refusalPresentation(source.gist);
  if (isExcludedWakeOrReminder(source.content)) return undefined;

  return childFinished(source.content) ?? turnFailure(source.content, source.turnSeq) ??
    attestPresentation(source.content) ?? assignmentPresentation(source.content) ??
    decisionPresentation(source.content) ?? workItemPresentation(source.content) ??
    sessionPresentation(source.content) ?? remedyPresentation(source.gist, source.content);
}
