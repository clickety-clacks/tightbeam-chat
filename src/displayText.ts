const provenancePrefix = '<engram-src id="';
const provenanceSuffix = '"/>';
const uuidLength = 36;
const whitespaceCharacter = /\s/;

interface TextRange {
  start: number;
  end: number;
}

function isHexDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function provenanceTagEnd(value: string, start: number): number | undefined {
  if (!value.startsWith(provenancePrefix, start)) return undefined;
  const uuidStart = start + provenancePrefix.length;
  for (let index = 0; index < uuidLength; index++) {
    const character = value[uuidStart + index];
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (character !== '-') return undefined;
    } else if (!character || !isHexDigit(character)) {
      return undefined;
    }
  }
  const tagEnd = uuidStart + uuidLength + provenanceSuffix.length;
  return value.startsWith(provenanceSuffix, uuidStart + uuidLength) ? tagEnd : undefined;
}

function isWhitespace(character: string): boolean {
  return whitespaceCharacter.test(character);
}

function containsNonWhitespace(value: string, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    if (!isWhitespace(value[index])) return true;
  }
  return false;
}

function expandTagRanges(value: string, tags: readonly TextRange[]): TextRange[] {
  const ranges: TextRange[] = [];
  for (const tag of tags) {
    let start = tag.start;
    while (start > 0 && isWhitespace(value[start - 1])) start--;
    let end = tag.end;
    while (end < value.length && isWhitespace(value[end])) end++;

    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
}

export function stripProvenanceMarkup(value: string): string {
  const tags: TextRange[] = [];
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const start = value.indexOf(provenancePrefix, searchFrom);
    if (start < 0) break;
    const end = provenanceTagEnd(value, start);
    if (end === undefined) searchFrom = start + provenancePrefix.length;
    else {
      tags.push({ start, end });
      searchFrom = end;
    }
  }
  if (tags.length === 0) return value;

  const ranges = expandTagRanges(value, tags);
  let lastNonWhitespace = value.length - 1;
  while (lastNonWhitespace >= 0 && isWhitespace(value[lastNonWhitespace])) lastNonWhitespace--;

  const result: string[] = [];
  let cursor = 0;
  let beforeHasText = false;
  for (const range of ranges) {
    result.push(value.slice(cursor, range.start));
    if (!beforeHasText) beforeHasText = containsNonWhitespace(value, cursor, range.start);

    const hasTextAfter = lastNonWhitespace >= range.end;
    if (beforeHasText && hasTextAfter) {
      const removed = value.slice(range.start, range.end);
      result.push(/[\r\n]/.test(removed) ? '\n' : /\s/.test(removed) ? ' ' : '');
    }
    cursor = range.end;
  }
  result.push(value.slice(cursor));
  return result.join('');
}
