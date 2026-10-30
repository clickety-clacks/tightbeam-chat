const provenanceTag = '<engram-src id="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"/>';
const provenanceTagRun = new RegExp(`\\s*(?:${provenanceTag}\\s*)+`, 'g');

export function stripProvenanceMarkup(value: string): string {
  if (!value.match(provenanceTagRun)) return value;
  return value.replace(provenanceTagRun, (removed, offset: number, source: string) => {
    const before = source.slice(0, offset);
    const after = source.slice(offset + removed.length);
    if (!before.trim() || !after.trim()) return '';
    return /[\r\n]/.test(removed) ? '\n' : /\s/.test(removed) ? ' ' : '';
  });
}
