import { describe, expect, it } from 'vitest';
import { activityPillPresentation, type ActivityPillSource } from '../src/activityPresentation';

const source = (kind: ActivityPillSource['kind'], content: string, gist = content.split('\n')[0] ?? '',
  extra: Partial<ActivityPillSource> = {}) => ({ kind, content, gist, ...extra } satisfies ActivityPillSource);

describe('activity pill presentation', () => {
  it('gives delivered verdict, completion, opened and closed notices distinct plain presentations', () => {
    const assignmentIds = [
      'asg_12345678-1111-4111-8111-123456789abc',
      'asg_23456789-1111-4111-8111-123456789abc',
      'asg_34567890-1111-4111-8111-123456789abc',
      'asg_456789ab-1111-4111-8111-123456789abc',
    ];
    const delivered = (line: string) => source('substrate', line, line, {
      sender: 'system', messageType: 'process',
    });
    const reviewedClean = activityPillPresentation(delivered(
      `[verdict filed: reviewed-clean on ${assignmentIds[0]}: The change is ready]`));
    const spiritApproved = activityPillPresentation(delivered(
      `[verdict filed: spirit-approved on ${assignmentIds[0]}: Retain the change]`));
    const changesRequested = activityPillPresentation(delivered(
      `[verdict filed: changes-requested on ${assignmentIds[0]}: Correct the missing case]`));
    const completion = activityPillPresentation(delivered(
      `[completion filed on ${assignmentIds[1]}: Completed after the focused review]`));
    const opened = activityPillPresentation(delivered(`[assignment opened: ${assignmentIds[2]}]`));
    const closed = activityPillPresentation(delivered(`[assignment closed: ${assignmentIds[3]} — completed]`));

    expect(reviewedClean).toMatchObject({ label: 'Verdict', tone: 'green', icon: 'decision',
      text: 'Reviewed clean · The change is ready', metadata: 'asg_1234' });
    expect(spiritApproved).toMatchObject({ label: 'Verdict', tone: 'green', icon: 'decision',
      text: 'Spirit approved · Retain the change', metadata: 'asg_1234' });
    expect(changesRequested).toMatchObject({ label: 'Verdict', tone: 'red', icon: 'decision',
      text: 'Changes requested · Correct the missing case', metadata: 'asg_1234' });
    expect(completion).toMatchObject({ label: 'Completion', tone: 'purple', icon: 'attest',
      text: 'Completed after the focused review', metadata: 'asg_2345' });
    expect(opened).toMatchObject({ label: 'Assignment opened', tone: 'blue', icon: 'assignment',
      text: 'Opened', metadata: 'asg_3456' });
    expect(closed).toMatchObject({ label: 'Assignment closed', tone: 'slate', icon: 'flag',
      text: 'Completed', metadata: 'asg_4567' });

    for (const presentation of [reviewedClean, spiritApproved, changesRequested, completion, opened, closed]) {
      const copy = `${presentation?.label} ${presentation?.text} ${presentation?.metadata}`;
      expect(copy).not.toMatch(/[\[\]]/);
      expect(copy).not.toMatch(/asg_[a-f0-9]{8}-/i);
    }
  });

  it('classifies the other frequent delivered notices without sending them to the generic pill', () => {
    const assignmentId = 'asg_12345678-1111-4111-8111-123456789abc';
    const cases: Array<[string, { label: string; tone: string; icon: string; text: string }]> = [
      [`[progress filed on ${assignmentId}: Updated the product summary]`,
        { label: 'Progress', tone: 'indigo', icon: 'activity', text: 'Updated the product summary' }],
      [`[cannot-proceed filed on ${assignmentId}: The review could not continue]`,
        { label: 'Action blocked', tone: 'orange', icon: 'refused', text: 'Could not proceed · The review could not continue' }],
      [`[assignment revoked: ${assignmentId}]`,
        { label: 'Assignment revoked', tone: 'red', icon: 'flag', text: 'Revoked' }],
      ['[context compacted]',
        { label: 'Conversation', tone: 'slate', icon: 'notice', text: 'Context shortened' }],
      ['[adapter down]',
        { label: 'Connection', tone: 'amber', icon: 'alarm', text: 'Connection unavailable' }],
      ['[engine swap]',
        { label: 'Model', tone: 'purple', icon: 'process', text: 'Model changed' }],
    ];

    for (const [content, expected] of cases) {
      const presentation = activityPillPresentation(source('substrate', content, content, {
        sender: 'process:events', messageType: 'process',
      }));
      expect(presentation, content).toMatchObject(expected);
      expect(`${presentation?.label} ${presentation?.text} ${presentation?.metadata ?? ''}`).not.toMatch(/[\[\]]/);
    }
    expect(new Set(cases.map(([, expected]) => expected.icon)).size).toBe(cases.length);
  });

  it('classifies the delivered blocker settlement and release envelope', () => {
    const assignmentId = 'asg_12345678-1111-4111-8111-123456789abc';
    const processNotice = (line: string) => source('substrate', `[from process:tightbeam]\n\n${line}`, line, {
      sender: 'process:tightbeam', messageType: 'substrate',
    });
    const settled = activityPillPresentation(processNotice('[cannot-proceed settled by opener answer]'));
    const released = activityPillPresentation(processNotice(
      `[cannot-proceed released: ${assignmentId} by example-kind/example-scope]`));

    expect(settled).toMatchObject({ label: 'Blocker cleared', tone: 'green', icon: 'decision-answered',
      text: 'Cleared by the opener’s answer' });
    expect(settled?.metadata).toBeUndefined();
    expect(released).toMatchObject({ label: 'Blocker released', tone: 'green', icon: 'decision-answered',
      text: 'Released', metadata: 'asg_1234' });
    expect(`${settled?.label} ${settled?.text} ${released?.label} ${released?.text} ${released?.metadata}`)
      .not.toMatch(/[\[\]]/);
  });

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
        'Refused', 'Completion needs a recorded verification first', undefined],
    ];

    for (const [input, label, text, metadata] of cases) {
      const presentation = activityPillPresentation(input);
      expect(presentation, input.content).toMatchObject({ label, text });
      expect(presentation?.metadata, input.content).toBe(metadata);
    }
  });

  it('presents every delivered non-tool activity line, including wakes and reminders', () => {
    expect(activityPillPresentation({ kind: 'agent', gist: 'Review helper — Updated the report', content: 'Updated the report',
      senderDisplayName: 'Review helper' })).toMatchObject({
      label: 'Message', tone: 'indigo', text: 'Updated the report', metadata: 'Review helper',
    });
    expect(activityPillPresentation(source('substrate', '[woke: fact wake_12345678-1111-4111-8111-123456789abc; assignment asg_abcdef12-1111-4111-8111-123456789abc]\nRead the latest result')))
      .toMatchObject({ label: 'Wake', tone: 'purple', icon: 'alarm', text: 'Read the latest result', metadata: 'asg_abcd' });
    expect(activityPillPresentation(source('substrate', '[woke: fallback deadline]\nRead the latest result')))
      .toMatchObject({ label: 'Wake', tone: 'purple', text: 'Read the latest result', metadata: 'fallback' });
    expect(activityPillPresentation(source('substrate', '[woke: fact escalation-ruled/dr_12345678-1111-4111-8111-123456789abc]\nReview complete')))
      .toMatchObject({ label: 'Wake', tone: 'purple', text: 'Review complete', metadata: 'ruled dr_1234' });
    expect(activityPillPresentation(source('substrate', '[woke: fact an-unrecognized-fact/dr_12345678-1111-4111-8111-123456789abc]\nThe condition is ready')))
      .toMatchObject({ label: 'Wake', metadata: 'dr_1234' });
    expect(activityPillPresentation(source('substrate', 'Quiet for 3 h · Assignment summary')))
      .toMatchObject({ label: 'Assignment', tone: 'amber', icon: 'clock', text: 'Quiet for 3 h · Assignment summary' });
    expect(activityPillPresentation(source('substrate', 'Assignment asg_12345678-1111-4111-8111-123456789abc has had no recorded activity since 12')))
      .toMatchObject({ label: 'Assignment', tone: 'amber', text: 'No recorded activity', metadata: 'asg_1234' });
    expect(activityPillPresentation(source('substrate', 'A notice whose kind is not known')))
      .toMatchObject({ label: 'Activity', tone: 'slate', text: 'A notice whose kind is not known' });
    expect(activityPillPresentation(source('rail', 'Unclassified activity')))
      .toMatchObject({ label: 'Activity', tone: 'slate', text: 'Unclassified activity' });
  });

  it('uses the approved color and icon for each recognized activity kind', () => {
    const cases: Array<[ActivityPillSource, { label: string; tone: string; icon: string }]> = [
      [source('agent', 'New detail', 'Review helper — New detail'),
        { label: 'Message', tone: 'indigo', icon: 'message' }],
      [source('substrate', 'Attest att_12345678 (completion) was filed on assignment asg_abcdef12.'),
        { label: 'Attest', tone: 'amber', icon: 'attest' }],
      [source('substrate', '[assignment: asg_12345678]\nCheck the result'),
        { label: 'Assignment', tone: 'blue', icon: 'assignment' }],
      [source('substrate', 'Question dr_12345678 from session:agent:helper\nCan it ship?'),
        { label: 'Decision', tone: 'blue', icon: 'decision' }],
      [source('substrate', 'Question dr_12345678 was answered by user:person.\nYou asked: Can it ship?'),
        { label: 'Decision', tone: 'green', icon: 'decision-answered' }],
      [source('substrate', 'Decision request dr_12345678 expired'),
        { label: 'Decision', tone: 'slate', icon: 'hourglass' }],
      [source('substrate', 'terminal-child-owner-notification\nsource_kind="attest"\nassignment_id="asg_12345678"\nchild_session_key="agent:helper s_87654321"\noutcome="completed"'),
        { label: 'Assignment', tone: 'green', icon: 'flag' }],
      [source('substrate', 'Work item wi_12345678 opened'),
        { label: 'Work item', tone: 'slate', icon: 'work-item' }],
      [source('substrate', 'Session agent:helper s_12345678 was retired'),
        { label: 'Session', tone: 'slate', icon: 'session' }],
      [source('substrate', '[turn failed]\nThe reply failed'),
        { label: 'Turn', tone: 'red', icon: 'turn' }],
      [source('rail', 'Review requested changes', 'Remedy completion-requires-review sent — Review requested changes'),
        { label: 'Remedy', tone: 'orange', icon: 'remedy' }],
      [source('rail', 'attest refused by completion-requires-verification'),
        { label: 'Refused', tone: 'red', icon: 'refused' }],
      [source('substrate', '[woke: fallback deadline]\nRead the result'),
        { label: 'Wake', tone: 'purple', icon: 'alarm' }],
      [source('substrate', 'Quiet for 3 h · Assignment summary'),
        { label: 'Assignment', tone: 'amber', icon: 'clock' }],
    ];

    for (const [input, expected] of cases) {
      expect(activityPillPresentation(input), input.content).toMatchObject(expected);
    }
  });

  it('uses delivered source and substrate message types for distinct fallback pills', () => {
    expect(activityPillPresentation(source('substrate', 'A source update', 'A source update', {
      sender: 'process:events', messageType: 'process',
    }))).toMatchObject({ label: 'System', tone: 'purple', icon: 'process', text: 'A source update' });
    expect(activityPillPresentation(source('substrate', 'A retained notice', 'A retained notice', {
      sender: 'process:events', messageType: 'substrate',
    }))).toMatchObject({ label: 'Notice', tone: 'blue', icon: 'notice', text: 'A retained notice' });
    expect(activityPillPresentation(source('substrate', 'A sourced agent update', 'A sourced agent update', {
      sender: 'process:events', source: 'agent:helper', messageType: 'substrate',
    }))).toMatchObject({ label: 'Message', tone: 'indigo', icon: 'message', text: 'A sourced agent update' });
  });

  it('removes transport framing from pill copy and shortens identifiers everywhere', () => {
    const fullAssignmentId = 'asg_12345678-1111-4111-8111-123456789abc';
    const fullWorkItemId = 'wi_abcdef12-1111-4111-8111-123456789abc';
    const presentation = activityPillPresentation(source('substrate', [
      '[from process:notifications]',
      '',
      `[assignment: ${fullAssignmentId}]`,
      `Review work item ${fullWorkItemId}`,
    ].join('\n'), `[from process:notifications]`, {
      sender: 'process:notifications', messageType: 'substrate',
    }));

    expect(presentation).toMatchObject({
      label: 'Assignment', text: 'New · Review work item wi_abcd', metadata: 'asg_1234',
    });
    const lineCopy = `${presentation?.label} ${presentation?.text} ${presentation?.metadata}`;
    expect(lineCopy).not.toMatch(/[\[\]]/);
    expect(lineCopy).not.toContain(fullAssignmentId);
    expect(lineCopy).not.toContain(fullWorkItemId);

    const framedUnknown = activityPillPresentation(source('substrate', [
      '[from process:notifications]', '', '[batched notices: 1]', 'batchId=example',
      '[8] source=agent:helper sender=agent:helper cause=notice class=fyi',
      `[turn failed]`, `Unavailable for ${fullWorkItemId}`,
    ].join('\n'), '[from process:notifications]', {
      sender: 'process:notifications', messageType: 'process',
    }));
    expect(framedUnknown).toMatchObject({ label: 'Turn', text: 'Unavailable for wi_abcd' });
    expect(`${framedUnknown?.label} ${framedUnknown?.text}`).not.toMatch(/[\[\]]/);
    expect(`${framedUnknown?.label} ${framedUnknown?.text}`).not.toContain(fullWorkItemId);
  });

  it('keeps ordinary lines beginning with Outcome in pill copy', () => {
    const presentation = activityPillPresentation(source('substrate', 'Outcome was recorded after review'));

    expect(presentation?.text).toBe('Outcome was recorded after review');
  });
});
