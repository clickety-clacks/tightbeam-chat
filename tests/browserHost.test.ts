import { describe, expect, it } from 'vitest';
import { selection } from '../examples/browserHost';

describe('browser link selection', () => {
  it('decodes a gateway port and full session key without assuming a deployment', () => {
    expect(selection('?gateway=https%3A%2F%2Fchat.example%3A8443&session=agent%3Aexample%2Fchat'))
      .toEqual({ gateway: 'https://chat.example:8443', sessionKey: 'agent:example/chat' });
  });

  it('rejects URL credentials, extra parameters, missing selection, and gateway paths', () => {
    for (const search of [
      '?gateway=https://user:secret@chat.example&session=test',
      '?gateway=https://chat.example&session=test&token=secret',
      '?gateway=https://chat.example/path&session=test',
      '?gateway=https%3A%2F%2Fchat.example%3Ftoken%3Dsecret&session=test',
      '?gateway=file:///tmp/chat&session=test',
      '?gateway=https://chat.example', '',
    ]) expect(() => selection(search)).toThrow();
  });
});
