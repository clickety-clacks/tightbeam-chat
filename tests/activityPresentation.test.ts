import { describe, expect, it } from 'vitest';
import { activityPillPresentation, type ActivityPillSource } from '../src/activityPresentation';

const source = (kind: ActivityPillSource['kind'], content: string, gist = content.split('\n')[0] ?? '') =>
  ({ kind, content, gist } satisfies ActivityPillSource);

describe('low-volume activity pill presentation', () => {
  it('uses stable delivered notice shapes and shortens their primary identifiers', () => {
    const cases: Array<[ActivityPillSource, string, string, string | undefined]> = [
      [source('substrate', 'Attest att_12345678-1111-4111-8111-123456789abc (completion) was filed on assignment asg_abcdef12-1111-4111-8111-123456789abc.'),
        'Attest', 'Filed completion on assignment asg_abcd', 'att_1234'],
      [source('substrate', '[assignment: asg_12345678-1111-4111-8111-123456789abc]\nInvestigate the reported behavior'),
        'Assignment', 'New · Investigate the reported behavior', 'asg_1234'],
      [source('substrate', 'Question dr_12345678-1111-4111-8111-123456789abc from session:agent:helper\nCan the change ship?'),
        'Decision', 'Needs a response · Can the change ship?', 'dr_1234'],
      [source('substrate', 'Question dr_12345678-1111-4111-8111-123456789abc was answered by user:person.\nYou asked: Can the change ship?\nAnswer: Yes.'),
        'Decision', 'Answered · Can the change ship?', 'dr_1234'],
      [source('substrate', 'terminal-child-owner-notification\nsource_kind="attest"\nsource_token="att_12345678"\nassignment_id="asg_abcdef12"\nwork_item_id=null\nchild_session_key="agent:helper s_87654321-1111-4111-8111-123456789abc"\noutcome="completed"\nterminal_at=12'),
        'Assignment', 'Child finished', 's_8765'],
      [source('substrate', 'route it or icebox it — work item wi_12345678-1111-4111-8111-123456789abc: Improve the transcript'),
        'Work item', 'Needs routing · Improve the transcript', 'wi_1234'],
      [source('substrate', 'slate clear on wi_12345678-1111-4111-8111-123456789abc: close it, card more work, or rule it failed'),
        'Work item', 'No open assignments · choose the next step', 'wi_1234'],
      [source('substrate', 'Session agent:helper s_12345678-1111-4111-8111-123456789abc was retired'),
        'Session', 'Retired', 's_1234'],
      [source('substrate', '[turn failed]\n\nThe agent could not answer the message above: provider error', '[turn failed]'),
        'Turn', 'The agent could not answer the message above: provider error', undefined],
      [source('rail', 'Review requested changes for asg_abcdef12',
        'Remedy completion-requires-review sent — Review requested changes'),
        'Remedy', 'Review requested changes', 'asg_abcd'],
      [source('rail', 'attest refused by completion-requires-verification'),
        'Refused', 'attest refused', undefined],
    ];

    for (const [input, label, text, metadata] of cases) {
      const presentation = activityPillPresentation(input);
      expect(presentation, input.content).toMatchObject({ label, text });
      expect(presentation?.metadata, input.content).toBe(metadata);
    }
  });

  it('treats agent messages as messages, and leaves wakes, reminders and unclear notices alone', () => {
    expect(activityPillPresentation({ kind: 'agent', gist: 'Review helper — Updated the report', content: 'Updated the report',
      senderDisplayName: 'Review helper' })).toMatchObject({
      label: 'Message', tone: 'indigo', text: 'Updated the report', metadata: 'Review helper',
    });
    expect(activityPillPresentation(source('substrate', '[woke: fallback deadline]\nRead the latest result'))).toBeUndefined();
    expect(activityPillPresentation(source('substrate', 'Quiet for 3 h · Assignment summary'))).toBeUndefined();
    expect(activityPillPresentation(source('substrate', 'A notice whose kind is not known'))).toBeUndefined();
  });
});
