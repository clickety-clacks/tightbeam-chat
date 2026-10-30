/** Persistent ordered index for nonnegative safe-integer record sequences.
 * Fixed bit paths keep both update work and React row identities independent
 * of history length; inserting a row never rotates/reparents existing rows.
 */
export interface RecordIndex<T> {
  readonly zero?: RecordIndex<T>;
  readonly one?: RecordIndex<T>;
  readonly value?: T;
  readonly min: number;
  readonly max: number;
  readonly maxTime: number;
}

export function getIndex<T>(node: RecordIndex<T> | undefined, key: number): T | undefined {
  for (let bit = 52; node && bit >= 0; bit--) {
    node = Math.floor(key / 2 ** bit) % 2 ? node.one : node.zero;
  }
  return node?.value;
}

export function putIndex<T>(node: RecordIndex<T> | undefined, key: number, value: T,
  time = -Infinity, bit = 52): RecordIndex<T> {
  if (bit < 0) return node?.value === value ? node : { value, min: key, max: key, maxTime: time };
  const right = Math.floor(key / 2 ** bit) % 2 !== 0;
  const zero = right ? node?.zero : putIndex(node?.zero, key, value, time, bit - 1);
  const one = right ? putIndex(node?.one, key, value, time, bit - 1) : node?.one;
  if (node && zero === node.zero && one === node.one) return node;
  return { zero, one, min: zero?.min ?? one!.min, max: one?.max ?? zero!.max,
    maxTime: Math.max(zero?.maxTime ?? -Infinity, one?.maxTime ?? -Infinity) };
}

/** Remove one key while keeping the fixed-depth lookup metadata current. */
export function removeIndex<T>(node: RecordIndex<T> | undefined, key: number,
  bit = 52): RecordIndex<T> | undefined {
  if (!node) return undefined;
  if (bit < 0) return undefined;
  const right = Math.floor(key / 2 ** bit) % 2 !== 0;
  const zero = right ? node.zero : removeIndex(node.zero, key, bit - 1);
  const one = right ? removeIndex(node.one, key, bit - 1) : node.one;
  if (zero === node.zero && one === node.one) return node;
  if (!zero && !one) return undefined;
  return { zero, one, min: zero?.min ?? one!.min, max: one?.max ?? zero!.max,
    maxTime: Math.max(zero?.maxTime ?? -Infinity, one?.maxTime ?? -Infinity) };
}

export function trimIndexBelow<T>(node: RecordIndex<T> | undefined, floor: number): RecordIndex<T> | undefined {
  if (!node || node.max < floor) return undefined;
  if (node.min >= floor) return node;
  const zero = trimIndexBelow(node.zero, floor);
  const one = trimIndexBelow(node.one, floor);
  return { zero, one, min: zero?.min ?? one!.min, max: one?.max ?? zero!.max,
    maxTime: Math.max(zero?.maxTime ?? -Infinity, one?.maxTime ?? -Infinity) };
}

/** Find the first sequence whose timestamp is later, without scanning rows. */
export function firstAfterTime<T>(node: RecordIndex<T> | undefined, time: number): T | undefined {
  if (!node || node.maxTime <= time) return undefined;
  if (node.value !== undefined) return node.value;
  return firstAfterTime(node.zero, time) ?? firstAfterTime(node.one, time);
}

export function* indexValues<T>(node: RecordIndex<T> | undefined): Generator<T> {
  if (!node) return;
  if (node.value !== undefined) yield node.value;
  else { yield* indexValues(node.zero); yield* indexValues(node.one); }
}
