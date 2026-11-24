import type { RunningModel, SessionRecord } from './types';

const VENDOR_PREFIX = /^(?:claude|gpt|gemini)[\s-]+/i;

/**
 * Decodes the Gateway's optional `runningModel` session field. This is the only
 * place that knows the field's name and shape. Absent or malformed is unknown.
 */
export function decodeRunningModel(value: unknown): RunningModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const harness = typeof row.harness === 'string' ? row.harness.trim() : '';
  if (!id || !harness) return null;
  const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim() : null;
  return Object.freeze({ id, label, harness });
}

/** Drops a leading vendor word ("Claude Opus 5.5" -> "Opus 5.5") only when a readable name remains. */
function trimVendor(label: string): string {
  const rest = label.replace(VENDOR_PREFIX, '');
  return rest !== label && /[a-z]/i.test(rest) ? rest : label;
}

/** Display text for the running model, or '' when it is unknown. */
export function runningModelText(session: SessionRecord | undefined, sessionKey: string): string {
  const running = session?.runningModel;
  if (!session || session.sessionKey !== sessionKey || !running) return '';
  // A reading from a different harness than the record's is not trustworthy.
  if (session.harness !== undefined && running.harness !== session.harness) return '';
  return running.label ? trimVendor(running.label) : running.id;
}
