// Incremental transcript fetch for the MCP strip (card 79057de9). The first load is the whole
// transcript; later polls ask the daemon only for the tail (`?offset=`) and append it.
import type { TranscriptTurn } from "./api";

export interface TailPage {
  turns: TranscriptTurn[];
  totalTurns: number;
  offset: number;
  nextOffset: number | null;
}

/** How many already-held turns each tail request re-reads: [0] proves the prefix is unchanged, [1] is the (possibly grown) last turn. */
export const TAIL_OVERLAP = 2;

const same = (a: TranscriptTurn, b: TranscriptTurn) => a.role === b.role && a.text === b.text;

/** Where a tail request for a cached transcript of `held` turns should start, or null when a full fetch is needed. */
export function tailOffset(held: number): number | null {
  return held >= TAIL_OVERLAP ? held - TAIL_OVERLAP : null;
}

/**
 * Fold a tail page (fetched at tailOffset(prev.length)) into the cached transcript. Returns null when the
 * cache cannot be trusted and the caller must refetch everything: the transcript shrank, the page does not
 * start where asked, or the overlap sentinel differs (engine-session rotation / rewritten history).
 * The final held turn is replaced rather than compared: a turn still being written may have grown.
 */
export function mergeTranscriptTail(prev: readonly TranscriptTurn[], page: TailPage): TranscriptTurn[] | null {
  const start = tailOffset(prev.length);
  if (start === null || page.offset !== start) return null;
  if (page.totalTurns < prev.length) return null;
  const [sentinel, ...rest] = page.turns;
  if (!sentinel || !same(sentinel, prev[start]!)) return null;
  return [...prev.slice(0, start), sentinel, ...rest];
}

/** Fetch a transcript incrementally from `cached`, falling back to `full()` whenever the merge says so. */
export async function fetchTranscriptIncremental(
  cached: readonly TranscriptTurn[] | undefined,
  tail: (offset: number) => Promise<TailPage>,
  full: () => Promise<TranscriptTurn[]>,
): Promise<TranscriptTurn[]> {
  const start = cached ? tailOffset(cached.length) : null;
  if (!cached || start === null) return full();
  let merged: readonly TranscriptTurn[] = cached;
  let offset = start;
  // The daemon may split a large tail across pages; follow nextOffset (bounded) until it ends.
  for (let i = 0; i < 20; i++) {
    const page = await tail(offset);
    const next = i === 0 ? mergeTranscriptTail(cached, page) : [...merged, ...page.turns];
    if (!next) return full();
    merged = next;
    if (page.nextOffset === null) return [...merged];
    offset = page.nextOffset;
  }
  return full();
}
