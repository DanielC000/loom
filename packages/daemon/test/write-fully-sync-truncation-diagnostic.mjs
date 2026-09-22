// Card e61deaab (split from 805f04cd): scripts/test-daemon.mjs's writeFullySync used to drop an
// unwritten tail SILENTLY on deadline — the gate's own FAILURES: epilogue flusher losing evidence with no
// trace it happened. `describeWriteFullySyncTruncation` is the pure function that now builds the
// diagnostic writeFullySync emits (via a single best-effort synchronous fs.writeSync to fd 2, never
// console.warn/error — see writeFullySync's own comment for why) when it gives up before writing every
// byte. Tested directly against synthetic inputs, independent of ever actually reproducing a real
// deadline-hit (this project's own gate host doesn't hit that branch — see writeFullySync's own doc) —
// same pattern this file already uses for boundMessageList/buildFailureEntryLines/classifyFailureDetail.
//
// Deliberately asserts on WHAT THE STRING REPORTS (bytes written/total, elapsed, deadline, retries, forced
// chunk size), never on a claimed CAUSE — the function only describes what writeFullySync observed.
import { describeWriteFullySyncTruncation } from "../scripts/test-daemon.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// [THE TEST] the core shape: every observed field appears in the rendered diagnostic.
{
  const msg = describeWriteFullySyncTruncation({
    fd: 1, writtenBytes: 6789, totalBytes: 9012, elapsedMs: 5001, deadlineMs: 5000, retries: 42, forcedChunkBytes: undefined,
  });
  check("[THE TEST] reports bytes written/total", msg.includes("6789/9012 bytes"));
  check("[THE TEST] reports which fd", msg.includes("fd 1"));
  check("[THE TEST] reports elapsed vs deadline", msg.includes("after 5001ms") && msg.includes("deadline 5000ms"));
  check("[THE TEST] reports the retry count", msg.includes("42 EAGAIN/zero-byte retries"));
  check("[THE TEST] names itself as writeFullySync's own diagnostic", msg.includes("[writeFullySync] TRUNCATED"));
  check("[THE TEST] never asserts a cause — no mention of contention/load/race", !/contention|load|race/i.test(msg));
}

// singular "retry" vs plural "retries" — a small wording detail, but a wrong count reads as a bug in the
// diagnostic itself, undermining trust in the rest of it.
{
  const singular = describeWriteFullySyncTruncation({
    fd: 2, writtenBytes: 0, totalBytes: 10, elapsedMs: 5000, deadlineMs: 5000, retries: 1, forcedChunkBytes: undefined,
  });
  check("[wording] retries:1 renders singular 'retry'", singular.includes("1 EAGAIN/zero-byte retry") && !singular.includes("1 EAGAIN/zero-byte retries"));
}

// retries:0 is a real, reportable case — a deadline hit with zero EAGAIN/zero-byte events at all would
// point AWAY FROM the currently-coded loss path entirely (a genuinely different, unaccounted-for defect),
// which is exactly the kind of signal this diagnostic exists to surface rather than hide.
{
  const zero = describeWriteFullySyncTruncation({
    fd: 1, writtenBytes: 100, totalBytes: 200, elapsedMs: 5000, deadlineMs: 5000, retries: 0, forcedChunkBytes: undefined,
  });
  check("[wording] retries:0 renders plural 'retries' and the real count", zero.includes("0 EAGAIN/zero-byte retries"));
}

// forcedChunkBytes present vs absent — the forced-chunk-size test knob (LOOM_TEST_FORCE_WRITE_CHUNK_BYTES)
// is exactly the variable this card's own inversion puzzle turns on, so it must show up when set...
{
  const forced = describeWriteFullySyncTruncation({
    fd: 1, writtenBytes: 1, totalBytes: 2, elapsedMs: 5000, deadlineMs: 5000, retries: 3, forcedChunkBytes: 7,
  });
  check("[chunk] forcedChunkBytes present: names the forced chunk size", forced.includes("forced write chunk=7B"));
}
// ...and never appear (not even an empty/undefined artifact) on a real, unforced production write.
{
  const unforced = describeWriteFullySyncTruncation({
    fd: 1, writtenBytes: 1, totalBytes: 2, elapsedMs: 5000, deadlineMs: 5000, retries: 3, forcedChunkBytes: undefined,
  });
  check("[chunk] forcedChunkBytes absent: no 'forced write chunk' text at all", !unforced.includes("forced write chunk"));
}

// [negative control] the matcher itself must be able to fail: text this function does not produce must be
// correctly reported absent, so every "includes" check above isn't silently vacuous.
{
  const msg = describeWriteFullySyncTruncation({
    fd: 1, writtenBytes: 1, totalBytes: 2, elapsedMs: 1, deadlineMs: 5000, retries: 0, forcedChunkBytes: undefined,
  });
  check("[negative control] a string this function never emits is correctly reported absent", !msg.includes("MARKER-NEVER-EMITTED-XYZ"));
}

console.log(`\n${failures === 0 ? "✅" : "❌"} write-fully-sync-truncation-diagnostic: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
