// Simhash fingerprint — ARCHITECTURE.md §6/§12, `dup-doc` detector's signal
// source ("simhash bucket + Jaccard shingles").
//
// Runs during measure/ against the head sample already read for
// tokenization; the detector only ever sees the resulting 32-bit fingerprint,
// never the text. That's the point (§12): "the dedup detector stores
// simhashes, not text. Hashes are one-way and are discarded after the run."

const SHINGLE_SIZE = 5; // words per shingle
const MIN_SHINGLES = 8; // below this, a doc is too short for the fingerprint to mean anything

function shingles(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const result = new Set<string>();
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
    result.add(words.slice(i, i + SHINGLE_SIZE).join(" "));
  }
  return result;
}

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function simhashOf(shingleSet: Set<string>): number {
  const bits = new Array<number>(32).fill(0);
  for (const s of shingleSet) {
    const h = fnv1a32(s);
    for (let b = 0; b < 32; b++) {
      bits[b]! += (h >>> b) & 1 ? 1 : -1;
    }
  }
  let result = 0;
  for (let b = 0; b < 32; b++) {
    if (bits[b]! > 0) result |= 1 << b;
  }
  return result >>> 0;
}

/** 32-bit simhash of `text`'s 5-word shingles, or undefined when there's too little text to fingerprint. */
export function computeSimhash(text: string): number | undefined {
  const s = shingles(text);
  if (s.size < MIN_SHINGLES) return undefined;
  return simhashOf(s);
}

export function hammingDistance(a: number, b: number): number {
  let x = (a ^ b) >>> 0;
  let count = 0;
  while (x) {
    count += x & 1;
    x >>>= 1;
  }
  return count;
}
