// Hermetic unit test for the MCP strip's incremental transcript merge — src/lib/transcriptTail.ts, card 79057de9.
// Run it with: node --experimental-strip-types packages/web/test/transcript-tail.mjs
import assert from "node:assert/strict";

const { mergeTranscriptTail, tailOffset, fetchTranscriptIncremental, TAIL_OVERLAP } = await import("../src/lib/transcriptTail.ts");

const turn = (i, text = `t${i}`) => ({ role: i % 2 ? "assistant" : "user", text });
const mk = (n) => Array.from({ length: n }, (_, i) => turn(i));

// A fake daemon: serves `server` as the full array or as a tail page, and counts calls.
function fake(server, pageSize = Infinity) {
  const calls = { full: 0, tail: [] };
  return {
    calls,
    full: async () => { calls.full++; return server.slice(); },
    tail: async (offset) => {
      calls.tail.push(offset);
      const start = Math.min(offset, server.length);
      const turns = server.slice(start, start + pageSize);
      const end = start + turns.length;
      return { turns, totalTurns: server.length, offset: start, nextOffset: end < server.length ? end : null };
    },
  };
}

assert.equal(TAIL_OVERLAP, 2);
assert.equal(tailOffset(0), null);
assert.equal(tailOffset(1), null);
assert.equal(tailOffset(2), 0);
assert.equal(tailOffset(300), 298);

// First load (nothing cached) is a full fetch.
{
  const f = fake(mk(5));
  const out = await fetchTranscriptIncremental(undefined, f.tail, f.full);
  assert.deepEqual(out, mk(5));
  assert.equal(f.calls.full, 1); assert.equal(f.calls.tail.length, 0);
}

// Appended turns: only the tail is requested, and the result equals the server's full transcript.
{
  const f = fake(mk(8));
  const out = await fetchTranscriptIncremental(mk(5), f.tail, f.full);
  assert.deepEqual(out, mk(8));
  assert.deepEqual(f.calls.tail, [3]); // held 5 - overlap 2
  assert.equal(f.calls.full, 0);
}

// Nothing new: still a tail request, result unchanged.
{
  const f = fake(mk(5));
  assert.deepEqual(await fetchTranscriptIncremental(mk(5), f.tail, f.full), mk(5));
  assert.equal(f.calls.full, 0);
}

// The last held turn grew while being written: it is replaced, not treated as rotation.
{
  const server = mk(6); server[4] = turn(4, "t4 + more text");
  const f = fake(server);
  const out = await fetchTranscriptIncremental(mk(5), f.tail, f.full);
  assert.deepEqual(out, server);
  assert.equal(f.calls.full, 0);
}

// A tail split across several pages is followed through nextOffset.
{
  const f = fake(mk(12), 3);
  const out = await fetchTranscriptIncremental(mk(5), f.tail, f.full);
  assert.deepEqual(out, mk(12));
  assert.deepEqual(f.calls.tail, [3, 6, 9]);
  assert.equal(f.calls.full, 0);
}

// ROTATION / rewrite: same length or longer, but the overlap sentinel differs -> full refetch.
{
  const rotated = Array.from({ length: 9 }, (_, i) => turn(i, `new-session ${i}`));
  const f = fake(rotated);
  const out = await fetchTranscriptIncremental(mk(5), f.tail, f.full);
  assert.deepEqual(out, rotated);
  assert.equal(f.calls.full, 1);
}

// SHRINK: the server now holds fewer turns than the cache -> full refetch (never a stale longer cache).
{
  const f = fake(mk(3));
  const out = await fetchTranscriptIncremental(mk(7), f.tail, f.full);
  assert.deepEqual(out, mk(3));
  assert.equal(f.calls.full, 1);
}

// Empty rotation: the new transcript is empty -> full refetch returns [].
{
  const f = fake([]);
  assert.deepEqual(await fetchTranscriptIncremental(mk(4), f.tail, f.full), []);
  assert.equal(f.calls.full, 1);
}

// mergeTranscriptTail refuses a page that does not start where it was asked.
assert.equal(mergeTranscriptTail(mk(5), { turns: mk(8).slice(4), totalTurns: 8, offset: 4, nextOffset: null }), null);
// ...and a cache too short to carry a sentinel.
assert.equal(mergeTranscriptTail(mk(1), { turns: mk(3), totalTurns: 3, offset: 0, nextOffset: null }), null);

console.log("transcript-tail: all assertions passed");
