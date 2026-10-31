import { describe, expect, it } from 'vitest';
import { stripProvenanceMarkup } from '../src/displayText';

const tag = '<engram-src id="123e4567-e89b-42d3-a456-426614174000"/>';

describe('provenance display cleanup', () => {
  it('removes complete markup and keeps adjacent text natural', () => {
    expect(stripProvenanceMarkup(`${tag}\n\n  A message body.`)).toBe('A message body.');
    expect(stripProvenanceMarkup(`Before ${tag} after`)).toBe('Before after');
    expect(stripProvenanceMarkup(`Before\n${tag}\nAfter`)).toBe('Before\nAfter');
    expect(stripProvenanceMarkup(`Before ${tag} ${tag} after`)).toBe('Before after');
  });

  it('leaves malformed tags, literal mentions, and text without markup unchanged', () => {
    const malformed = '<engram-src id="not-a-uuid"/>';
    const nearMatch = '<engram-src id = "123e4567-e89b-42d3-a456-426614174000"/>';
    const plain = '  The name engram-src is just a mention here.  ';
    expect(stripProvenanceMarkup(malformed)).toBe(malformed);
    expect(stripProvenanceMarkup(nearMatch)).toBe(nearMatch);
    expect(stripProvenanceMarkup(plain)).toBe(plain);
  });

  it('preserves long whitespace and malformed-tag input', () => {
    const whitespace = ' '.repeat(30_000);
    const malformed = `${whitespace}<engram-src id="not-a-uuid"/>`;
    expect(stripProvenanceMarkup(whitespace)).toBe(whitespace);
    expect(stripProvenanceMarkup(malformed)).toBe(malformed);
  });
});
