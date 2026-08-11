// Token measurement — ARCHITECTURE.md §5.
//
// Tier 0 files are always read and tokenized in full — they're few and they
// matter most. Everything else is sampled: first 8KB + a middle 8KB slice,
// counted, then the byte→token ratio is extrapolated across the whole file.
// Binary files are flagged and reported as raw bytes, never tokenized.
//
// The Tokenizer is a port on purpose (§5, §10): the default implementation
// below is a dependency-free heuristic, not a real BPE tokenizer. Swapping in
// an exact Claude tokenizer later is a one-file change behind this interface,
// and ranking — not the absolute count — is what every decision here uses.

import { promises as fs } from "node:fs";
import type { FileKind, Tier } from "../types.js";
import type { DiscoveredFile } from "../discover/index.js";
import { isMinifiedPath } from "../classify/index.js";

export interface Tokenizer {
  countTokens(text: string): number;
}

/**
 * Crude approximation of BPE-style tokenization: alnum runs split into
 * ~4-char subword chunks, each punctuation/symbol character is its own
 * token, whitespace is free (it's almost always merged into a neighbor by
 * real tokenizers). Empirically close enough for ranking; not exact.
 */
function heuristicCountTokens(text: string): number {
  if (text.length === 0) return 0;
  const matches = text.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g);
  if (!matches) return 0;
  let count = 0;
  for (const m of matches) {
    count += /^[A-Za-z0-9_]+$/.test(m) ? Math.max(1, Math.ceil(m.length / 4)) : 1;
  }
  return count;
}

export const defaultTokenizer: Tokenizer = { countTokens: heuristicCountTokens };

const SAMPLE_SIZE = 8192;
const HEAD_SAMPLE_CHARS = 4096;

export interface MeasureResult {
  tokens: number;
  estimated: boolean;
  /** first slice of text actually read, for reuse by later signals (e.g. a generated-header sniff) — never the whole file */
  headSample: string;
}

async function readWhole(absPath: string): Promise<string> {
  return fs.readFile(absPath, "utf8");
}

async function readSlice(fd: fs.FileHandle, position: number, length: number): Promise<string> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead).toString("utf8");
}

export async function measureTokens(
  file: DiscoveredFile,
  tier: Tier,
  kind: FileKind,
  tokenizer: Tokenizer = defaultTokenizer,
): Promise<MeasureResult> {
  if (kind === "binary" || isMinifiedPath(file.path)) {
    return { tokens: 0, estimated: true, headSample: "" };
  }

  const exactEligible = tier === 0 || file.bytes <= SAMPLE_SIZE * 2;
  if (exactEligible) {
    try {
      const text = await readWhole(file.absPath);
      return { tokens: tokenizer.countTokens(text), estimated: false, headSample: text.slice(0, HEAD_SAMPLE_CHARS) };
    } catch {
      return { tokens: 0, estimated: true, headSample: "" }; // unreadable — degrade rather than throw
    }
  }

  let fd: fs.FileHandle | undefined;
  try {
    fd = await fs.open(file.absPath, "r");
    const head = await readSlice(fd, 0, SAMPLE_SIZE);
    const midStart = Math.max(SAMPLE_SIZE, Math.floor(file.bytes / 2) - SAMPLE_SIZE / 2);
    const mid = await readSlice(fd, midStart, SAMPLE_SIZE);
    const sampleText = head + mid;
    const sampleBytes = Buffer.byteLength(sampleText, "utf8");
    const sampleTokens = tokenizer.countTokens(sampleText);
    const headSample = head.slice(0, HEAD_SAMPLE_CHARS);
    if (sampleBytes === 0 || sampleTokens === 0) return { tokens: 0, estimated: true, headSample };
    const bytesPerToken = sampleBytes / sampleTokens;
    return { tokens: Math.round(file.bytes / bytesPerToken), estimated: true, headSample };
  } catch {
    return { tokens: 0, estimated: true, headSample: "" };
  } finally {
    await fd?.close().catch(() => {});
  }
}
