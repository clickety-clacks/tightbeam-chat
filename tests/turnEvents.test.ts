import { describe, expect, it } from 'vitest';
import { projectTurnEvents } from '../src/turnEvents';
import type { ToolCallRecord, TurnEventRecord } from '../src/types';

const call = (id: string, status: ToolCallRecord['status'] = 'in_progress', rowVersion = 1): ToolCallRecord => ({
  id, seq: 1, sessionKey: 'session', turnSeq: 7, afterMessageSeq: 10,
  harnessToolCallId: id, title: `Call ${id}`, kind: 'tool', toolName: null,
  status, rawInput: { id }, rawOutput: status === 'completed' ? { done: true } : null,
  content: null, truncated: [], startedAt: 100, endedAt: status === 'completed' ? 200 : null, rowVersion,
});

const segment = (id: string, turnEventSeq: number, messageId: string, text: string): TurnEventRecord => ({
  id, sessionKey: 'session', turnSeq: 7, turnEventSeq, kind: 'assistant.segment',
  messageId, toolCallId: null, content: { type: 'text', text }, toolCall: null, rowVersion: 1,
});

const toolEvent = (id: string, turnEventSeq: number, value: ToolCallRecord): TurnEventRecord => ({
  id, sessionKey: 'session', turnSeq: 7, turnEventSeq,
  kind: value.status === 'completed' ? 'tool.ended' : 'tool.started',
  messageId: null, toolCallId: value.id, content: null, toolCall: value, rowVersion: 1,
});

describe('turn-event display projection', () => {
  it('sorts by the received ordinal, joins only adjacent chunks, and retains the logical message ID across a tool event', () => {
    const entries = projectTurnEvents([
      segment('segment-3', 3, 'message-a', 'after'),
      toolEvent('tool-start', 2, call('call-a')),
      segment('segment-1', 1, 'message-a', 'before'),
    ]);

    expect(entries).toEqual([
      { kind: 'assistant', id: 'turn-message:7:message-a:1', turnSeq: 7, turnEventSeq: 1,
        lastTurnEventSeq: 1, messageId: 'message-a', text: 'before', eventIds: ['segment-1'] },
      { kind: 'tools', id: 'turn-tools:7:call-a', turnSeq: 7, turnEventSeq: 2,
        lastTurnEventSeq: 2, calls: [{ turnEventSeq: 2, call: call('call-a'), eventIds: ['tool-start'] }] },
      { kind: 'assistant', id: 'turn-message:7:message-a:3', turnSeq: 7, turnEventSeq: 3,
        lastTurnEventSeq: 3, messageId: 'message-a', text: 'after', eventIds: ['segment-3'] },
    ]);
  });

  it('keeps adjacent chunks together but applies a later tool result to the call at its start position', () => {
    const started = call('call-a');
    const completed = call('call-a', 'completed', 2);
    const entries = projectTurnEvents([
      segment('segment-1', 1, 'message-a', 'Hello '),
      segment('segment-2', 2, 'message-a', 'world'),
      toolEvent('tool-start', 3, started),
      segment('segment-4', 4, 'message-b', 'Next'),
      toolEvent('tool-end', 5, completed),
    ]);

    expect(entries.map(entry => entry.kind)).toEqual(['assistant', 'tools', 'assistant']);
    expect(entries[0]).toMatchObject({ messageId: 'message-a', text: 'Hello world',
      turnEventSeq: 1, lastTurnEventSeq: 2, eventIds: ['segment-1', 'segment-2'] });
    expect(entries[1]).toMatchObject({ turnEventSeq: 3, calls: [{ turnEventSeq: 3,
      call: completed, eventIds: ['tool-start', 'tool-end'] }] });
    expect(entries[2]).toMatchObject({ messageId: 'message-b', text: 'Next', turnEventSeq: 4 });
  });

  it('folds adjacent tool calls in order while a reply segment separates two runs', () => {
    const entries = projectTurnEvents([
      toolEvent('tool-a', 1, call('call-a')),
      toolEvent('tool-b', 2, call('call-b')),
      segment('segment-3', 3, 'message-a', 'Between'),
      toolEvent('tool-c', 4, call('call-c')),
    ]);

    expect(entries.map(entry => entry.kind)).toEqual(['tools', 'assistant', 'tools']);
    expect(entries[0]).toMatchObject({ kind: 'tools', turnEventSeq: 1, lastTurnEventSeq: 2,
      calls: [{ call: { id: 'call-a' } }, { call: { id: 'call-b' } }] });
    expect(entries[2]).toMatchObject({ kind: 'tools', calls: [{ call: { id: 'call-c' } }] });
  });
});
