import type { ToolCallRecord, TurnEventRecord } from './types';

export class TurnEventHistoryUnavailableError extends Error {}

export interface AssistantSegmentGroup {
  readonly kind: 'assistant';
  readonly id: string;
  readonly turnSeq: number;
  readonly turnEventSeq: number;
  readonly lastTurnEventSeq: number;
  readonly messageId: string;
  readonly text: string;
  readonly eventIds: readonly string[];
}

export interface TurnToolCall {
  readonly turnEventSeq: number;
  readonly call: ToolCallRecord;
  readonly eventIds: readonly string[];
}

export interface TurnToolRun {
  readonly kind: 'tools';
  readonly id: string;
  readonly turnSeq: number;
  readonly turnEventSeq: number;
  readonly lastTurnEventSeq: number;
  readonly calls: readonly TurnToolCall[];
}

export type TurnEventEntry = AssistantSegmentGroup | TurnToolRun;

type RawEntry =
  | { kind: 'assistant'; turnSeq: number; turnEventSeq: number; lastTurnEventSeq: number;
      messageId: string; text: string; eventIds: string[] }
  | { kind: 'tool'; turnSeq: number; turnEventSeq: number; call: ToolCallRecord; eventIds: string[] };

function eventText(event: TurnEventRecord): string {
  return typeof event.content?.text === 'string' ? event.content.text : '';
}

/**
 * Projects a complete event set into visible rows. Chunk groups stop at every
 * intervening event; tool lifecycle updates refresh their original call row.
 */
export function projectTurnEvents(events: readonly TurnEventRecord[]): readonly TurnEventEntry[] {
  const ordered = [...events].sort((left, right) => left.turnSeq - right.turnSeq ||
    left.turnEventSeq - right.turnEventSeq || left.id.localeCompare(right.id));
  const rows: RawEntry[] = [];
  const toolRows = new Map<string, number>();

  for (const event of ordered) {
    if (event.kind === 'assistant.segment') {
      const previous = rows.at(-1);
      const text = eventText(event);
      if (previous?.kind === 'assistant' && previous.turnSeq === event.turnSeq &&
          previous.messageId === event.messageId && previous.lastTurnEventSeq + 1 === event.turnEventSeq) {
        previous.text += text;
        previous.lastTurnEventSeq = event.turnEventSeq;
        previous.eventIds.push(event.id);
      } else {
        rows.push({ kind: 'assistant', turnSeq: event.turnSeq, turnEventSeq: event.turnEventSeq,
          lastTurnEventSeq: event.turnEventSeq, messageId: event.messageId!, text,
          eventIds: [event.id] });
      }
      continue;
    }

    const call = event.toolCall!;
    const existingIndex = toolRows.get(call.id);
    if (existingIndex !== undefined) {
      const previous = rows[existingIndex];
      if (previous?.kind === 'tool') {
        previous.call = call;
        previous.eventIds.push(event.id);
      }
    } else {
      toolRows.set(call.id, rows.length);
      rows.push({ kind: 'tool', turnSeq: event.turnSeq, turnEventSeq: event.turnEventSeq,
        call, eventIds: [event.id] });
    }
  }

  const entries: TurnEventEntry[] = [];
  for (let index = 0; index < rows.length;) {
    const row = rows[index];
    if (row.kind === 'assistant') {
      entries.push(Object.freeze({ kind: 'assistant', id: `turn-message:${row.turnSeq}:${row.messageId}:${row.turnEventSeq}`,
        turnSeq: row.turnSeq, turnEventSeq: row.turnEventSeq, lastTurnEventSeq: row.lastTurnEventSeq,
        messageId: row.messageId, text: row.text, eventIds: Object.freeze([...row.eventIds]) }));
      index++;
      continue;
    }

    const calls: TurnToolCall[] = [];
    let end = index;
    while (end < rows.length && rows[end].kind === 'tool' && rows[end].turnSeq === row.turnSeq) {
      const tool = rows[end] as Extract<RawEntry, { kind: 'tool' }>;
      calls.push(Object.freeze({ turnEventSeq: tool.turnEventSeq, call: tool.call,
        eventIds: Object.freeze([...tool.eventIds]) }));
      end++;
    }
    entries.push(Object.freeze({ kind: 'tools', id: `turn-tools:${row.turnSeq}:${calls[0].call.id}`,
      turnSeq: row.turnSeq, turnEventSeq: calls[0].turnEventSeq,
      lastTurnEventSeq: calls[calls.length - 1].turnEventSeq, calls: Object.freeze(calls) }));
    index = end;
  }

  return Object.freeze(entries);
}
