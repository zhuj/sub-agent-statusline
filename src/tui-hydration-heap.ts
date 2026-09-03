type StableMaxHeapEntry<Value> = {
  readonly value: Value;
  readonly sequence: number;
};

export type StableMaxHeap<Value> = {
  readonly length: number;
  readonly push: (value: Value) => void;
  readonly pop: () => Value | undefined;
  readonly clear: () => void;
};

export function createStableMaxHeap<Value>(
  priorityOf: (value: Value) => number,
): StableMaxHeap<Value> {
  const entries: StableMaxHeapEntry<Value>[] = [];
  let nextSequence = 0;

  const hasHigherPriority = (
    left: StableMaxHeapEntry<Value>,
    right: StableMaxHeapEntry<Value>,
  ): boolean => {
    const leftPriority = priorityOf(left.value);
    const rightPriority = priorityOf(right.value);
    if (leftPriority > rightPriority) return true;
    if (leftPriority < rightPriority) return false;
    return left.sequence < right.sequence;
  };

  const push = (value: Value): void => {
    let index = entries.length;
    entries.push({ value, sequence: nextSequence });
    nextSequence += 1;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = entries[parentIndex];
      const current = entries[index];
      if (!parent || !current || !hasHigherPriority(current, parent)) break;
      entries[index] = parent;
      entries[parentIndex] = current;
      index = parentIndex;
    }
  };

  const pop = (): Value | undefined => {
    const first = entries[0];
    if (!first) return undefined;
    const last = entries.pop();
    if (entries.length === 0) return first.value;
    if (!last) return undefined;
    entries[0] = last;
    let index = 0;
    while (true) {
      const current = entries[index];
      if (!current) break;
      const left = entries[index * 2 + 1];
      const right = entries[index * 2 + 2];
      let highest = current;
      let highestIndex = index;
      if (left && hasHigherPriority(left, highest)) {
        highest = left;
        highestIndex = index * 2 + 1;
      }
      if (right && hasHigherPriority(right, highest)) {
        highest = right;
        highestIndex = index * 2 + 2;
      }
      if (highestIndex === index) break;
      entries[index] = highest;
      entries[highestIndex] = current;
      index = highestIndex;
    }
    return first.value;
  };

  return {
    get length(): number {
      return entries.length;
    },
    push,
    pop,
    clear: () => {
      entries.length = 0;
    },
  };
}
