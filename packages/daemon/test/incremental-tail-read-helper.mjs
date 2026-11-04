// Unit test for `readIncrementalTail` (sessions/context.ts, card 22072f12) — the shared byte-offset /
// partial-line tail-read helper `IncrementalRunUsageReader` and `IncrementalContextStatsReader` both now
// delegate to, instead of each carrying its own copy. HERMETIC + pure file IO: no daemon, no real claude.
//
// Covers the cases the extracting card calls out specifically:
//   • a partial trailing line (no `\n` yet) is buffered, not returned as a complete line.
//   • file truncation/rotation (shrink) resets to a fresh read from offset 0.
//   • CRLF lines round-trip through the split/JSON.parse pipeline unharmed.
//   • a read error (open/read throws after a successful stat) is reported via `readFailed`, leaving
//     offset/partialBytes safe to apply verbatim (unchanged on an ordinary failure; already reset to
//     0/empty when the SAME tick was also a truncation — the two call sites' reset-before-attempt order).
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/incremental-tail-read-helper.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readIncrementalTail } from "../dist/sessions/context.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// `complete.toString("utf8").split("\n")` always yields a TRAILING EMPTY STRING when `complete` itself
// ends in "\n" (e.g. "a\n".split("\n") === ["a",""]) — the same artifact `readContextStats`'s own
// whole-file `raw.split("\n")` produces, which every real fold (`accumulateUsageLine`/`foldContextLine`)
// already tolerates via its own `if (!line.trim()) return/continue`. `readIncrementalTail` deliberately
// does NOT filter it out itself (it hands back raw split lines, nothing more) — `nonBlank` mirrors what
// a real fold already does, so these assertions check the REAL per-JSONL-record count, not raw array length.
const nonBlank = (lines) => lines.filter((l) => l.trim().length > 0);

const tmpDir = path.join(os.tmpdir(), `loom-tailhelper-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpDir, { recursive: true });
const f = path.join(tmpDir, "fixture.jsonl");

try {
  // (a) PARTIAL LINE: a tick whose new bytes end mid-line (no trailing \n) buffers everything and
  // reports zero complete lines; the SAME bytes, once a later tick completes the line, surface exactly
  // once (not lost, not duplicated).
  {
    const line0 = JSON.stringify({ n: 0 });
    const line1 = JSON.stringify({ n: 1 });
    fs.writeFileSync(f, line0 + "\n");
    let size = fs.statSync(f).size;
    let r = await readIncrementalTail(f, size, 0, Buffer.alloc(0));
    const nb = nonBlank(r.lines);
    check("a1 first complete line returned, offset advances to the \\n boundary", nb.length === 1 && JSON.parse(nb[0]).n === 0 && r.offset === size && r.partialBytes.length === 0);

    const half = Math.floor(line1.length / 2);
    fs.appendFileSync(f, line1.slice(0, half)); // no trailing \n — a genuine partial
    size = fs.statSync(f).size;
    r = await readIncrementalTail(f, size, r.offset, r.partialBytes);
    check("a2 a mid-line partial tick returns ZERO complete lines", r.lines.length === 0 && !r.truncated && !r.readFailed);
    check("a2 the partial bytes are buffered verbatim (not dropped)", r.partialBytes.toString("utf8") === line1.slice(0, half));
    check("a2 offset does NOT advance past the partial (still the prior \\n boundary)", r.offset === size - line1.slice(0, half).length);

    fs.appendFileSync(f, line1.slice(half) + "\n"); // complete the line
    size = fs.statSync(f).size;
    r = await readIncrementalTail(f, size, r.offset, r.partialBytes);
    const nb2 = nonBlank(r.lines);
    check("a3 completing the line surfaces it exactly once (not lost, not doubled)", nb2.length === 1 && JSON.parse(nb2[0]).n === 1);
    check("a3 offset now sits at the new end-of-file \\n boundary", r.offset === size && r.partialBytes.length === 0);
  }

  // (b) TRUNCATION/ROTATION (shrink ⇒ reset): a prior offset/partialBytes describing a BIGGER file than
  // the file's current size means the old offsets are meaningless — the helper must report `truncated`
  // and re-read the (smaller) CURRENT file from byte 0, not slice from the stale offset.
  {
    fs.writeFileSync(f, JSON.stringify({ n: "pre" }) + "\n" + JSON.stringify({ n: "pre2" }) + "\n");
    const bigSize = fs.statSync(f).size;
    let r = await readIncrementalTail(f, bigSize, 0, Buffer.alloc(0));
    check("b1 pre-shrink baseline read sees both lines", nonBlank(r.lines).length === 2);

    fs.writeFileSync(f, JSON.stringify({ n: "post" }) + "\n"); // shrink to a smaller file
    const smallSize = fs.statSync(f).size;
    check("b sanity: the new file is genuinely smaller than the cached offset", smallSize < r.offset);
    r = await readIncrementalTail(f, smallSize, r.offset, r.partialBytes);
    const nbPost = nonBlank(r.lines);
    check("b2 shrink is reported as truncated", r.truncated === true);
    check("b2 truncation re-reads the WHOLE current (smaller) file from 0, not a stale-offset slice", nbPost.length === 1 && JSON.parse(nbPost[0]).n === "post");
    check("b2 offset after a truncating re-read sits at the new file's own end", r.offset === smallSize && r.partialBytes.length === 0);
  }

  // (c) CRLF LINES: a transcript written with \r\n endings must still split correctly (the trailing \r
  // rides inside the "line" text, same as the two real readers' own full-parse siblings already handle),
  // and the embedded JSON still parses (JSON's own grammar treats \r as whitespace).
  {
    const crlfLine0 = JSON.stringify({ n: "crlf0" });
    const crlfLine1 = JSON.stringify({ n: "crlf1" });
    fs.writeFileSync(f, crlfLine0 + "\r\n" + crlfLine1 + "\r\n");
    const size = fs.statSync(f).size;
    const r = await readIncrementalTail(f, size, 0, Buffer.alloc(0));
    const nb = nonBlank(r.lines);
    check("c both CRLF-terminated lines surface as two complete lines", nb.length === 2);
    check("c JSON.parse tolerates the trailing \\r (JSON whitespace) on each line", JSON.parse(nb[0]).n === "crlf0" && JSON.parse(nb[1]).n === "crlf1");
    check("c offset advances past both \\r\\n-terminated lines fully", r.offset === size && r.partialBytes.length === 0);
  }

  // (d) READ ERROR: `fs.promises.stat` already succeeded (the caller always stats first) but the
  // subsequent open/read throws — e.g. a concurrent delete/EBUSY. Must report `readFailed:true` with
  // ZERO lines, and offset/partialBytes safe to apply verbatim: unchanged from the caller's own prior
  // state on an ORDINARY failure (not a truncation).
  {
    fs.writeFileSync(f, JSON.stringify({ n: "before-read-error" }) + "\n");
    const size = fs.statSync(f).size;
    const realOpen = fs.promises.open;
    fs.promises.open = async () => { throw new Error("simulated EBUSY"); };
    let r;
    try {
      r = await readIncrementalTail(f, size, 0, Buffer.alloc(0));
    } finally {
      fs.promises.open = realOpen;
    }
    check("d1 a read error reports readFailed:true", r.readFailed === true);
    check("d1 a read error returns ZERO lines", r.lines.length === 0);
    check("d1 a read error leaves offset/partialBytes UNCHANGED (not truncated, nothing to reset)", r.offset === 0 && r.partialBytes.length === 0 && r.truncated === false);

    // (d2) the SAME read error, but on a tick that is ALSO a truncation: the reset-before-attempt
    // ordering means offset/partialBytes must already read as the FRESH (0/empty) values even though the
    // chunk read itself then failed — never the stale pre-truncation offset.
    const priorPartial = Buffer.from("stale-partial-from-a-bigger-file");
    const staleOffset = size + 9_999; // guarantees size < staleOffset + priorPartial.length ⇒ truncation
    fs.promises.open = async () => { throw new Error("simulated EBUSY"); };
    try {
      r = await readIncrementalTail(f, size, staleOffset, priorPartial);
    } finally {
      fs.promises.open = realOpen;
    }
    check("d2 truncation + a failing read still reports truncated:true", r.truncated === true);
    check("d2 truncation + a failing read still reports readFailed:true", r.readFailed === true);
    check("d2 offset/partialBytes are ALREADY reset to 0/empty despite the read failure", r.offset === 0 && r.partialBytes.length === 0);
  }

  // (e) NO NEW BYTES: size exactly equal to the caller's own last-read end ⇒ no IO at all, reported as a
  // genuine no-op (empty lines, offset/partialBytes echoed back unchanged).
  {
    fs.writeFileSync(f, JSON.stringify({ n: "steady" }) + "\n");
    const size = fs.statSync(f).size;
    const first = await readIncrementalTail(f, size, 0, Buffer.alloc(0));
    const second = await readIncrementalTail(f, size, first.offset, first.partialBytes);
    check("e a tick with no appended bytes returns zero lines, not truncated, not failed", second.lines.length === 0 && !second.truncated && !second.readFailed);
    check("e offset/partialBytes pass through unchanged on a no-op tick", second.offset === first.offset && second.partialBytes.length === first.partialBytes.length);
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — readIncrementalTail: partial-line buffering, truncation reset, CRLF round-trip, read-error reporting (plain + combined with truncation), no-op ticks."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
