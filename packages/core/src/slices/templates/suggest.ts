// "Did you mean" for misspelt field names, words and ids.

/** The closest candidate to `input`, or undefined when none is close enough to be a typo. */
export function closest(input: string, candidates: Iterable<string>): string | undefined {
  const limit = Math.max(1, Math.floor(input.length / 3));
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= limit && best !== input ? best : undefined;
}

/** ` Did you mean "x"?`, or an empty string. */
export function didYouMean(input: string, candidates: Iterable<string>): string {
  const match = closest(input, candidates);
  return match === undefined ? "" : ` Did you mean "${match}"?`;
}

// Optimal string alignment distance: insertions, deletions, substitutions and swaps of two
// neighbouring letters each cost 1.
function editDistance(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = value;
    }
  }
  return rows[a.length]![b.length]!;
}
