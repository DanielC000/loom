import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Mid-turn context sampler (card c5b234aa) — closes the gap where `ctxInputTokens` was only ever
// refreshed at Stop, so a long single turn (the incident: worker 09e8c9f1 exhausted mid-turn while Loom
// kept showing ctxPct 70 from the PREVIOUS turn) was invisible until it ended. HERMETIC + CLAUDE-FREE +
// NETWORK-FREE: pure file IO — hand-writes fake transcript JSONL on disk (mirrors usage-sampler.mjs's own
// harness exactly), points DB session rows at it, and drives `IncrementalContextStatsReader`/
// `MidTurnContextSampler` directly. No real claude, no model call, no agent turn.
//
// Covers the card's DoD:
//   • a fixture transcript that GROWS mid-turn (no Stop) ⇒ the live ctxInputTokens reading advances.
//   • a bounded-read proof: the SECOND read only requests bytes past the file's PREVIOUS size, never a
//     full re-read from 0 (a byte-range spy on the underlying fs.promises.open/fh.read calls).
//   • the Stop-hook race: a plain `setContextCounters` ("Stop fires") landing DURING the sampler's async
//     read must survive — the sampler's own, now-stale write must be skipped, never overwrite it.
//   • rotation: the session's engineSessionId changes (fork/recycle) ⇒ the reader's cache resets and
//     reads the NEW file from 0, both at the raw-reader level and through a live sampler tick.
//   • a codex-harness (no context telemetry) busy session is NEVER sampled, even with a populated,
//     correctly-shaped transcript sitting at its own file — proven against a PARALLEL claude session in
//     the SAME tick that DOES get sampled (positive control: the skip is the harness gate, not a missing
//     file or a broken reader).
// Run: 1) build (turbo builds shared first), 2) node test/mid-turn-context-sampler.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME + sandboxed HOME set BEFORE importing dist (the transcript path is derived from
// os.homedir(), so HOME/USERPROFILE must point into the sandbox before any dist module that calls it).
const tmpHome = path.join(os.tmpdir(), `loom-mtcs-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45405";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { Db } = await import("../dist/db.js");
const { MidTurnContextSampler } = await import("../dist/sessions/mid-turn-context-sampler.js");
const { IncrementalContextStatsReader, readContextStats } = await import("../dist/sessions/context.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

const nowIso = new Date().toISOString();
const MODEL = "claude-opus-4-8";

// One raw assistant JSONL line, same shape the engine writes — last-wins semantics mean NO message.id
// dedup is needed (unlike the cumulative usage-sampler reader): writing the same usage twice is a no-op
// by construction, so there is no straddling-duplicate over-count risk to test here.
const turnLine = (id, u, model = MODEL) => JSON.stringify({
  type: "assistant",
  message: { id, model, usage: { input_tokens: u.in, output_tokens: u.out, cache_creation_input_tokens: u.cc, cache_read_input_tokens: u.cr } },
});
const inputTokensOf = (u) => u.in + u.cc + u.cr; // mirrors readContextStats's own formula
const fileFor = (cwd, engineId) => { const f = engineTranscriptPath(cwd, engineId); fs.mkdirSync(path.dirname(f), { recursive: true }); return f; };

const mkProject = (db, id, cwd) => db.insertProject({ id, name: id, repoPath: cwd, vaultPath: cwd, config: {}, createdAt: nowIso, archivedAt: null });
const mkAgent = (db, id, projectId) => db.insertAgent({ id, projectId, name: id, startupPrompt: "doctrine", position: 0 });
const mkSession = (db, s) => db.insertSession({
  title: null, processState: "live", resumability: "resumable", busy: true,
  createdAt: nowIso, lastActivity: nowIso, lastError: null, role: "worker", ...s,
});

try {
  // ===================================================================================================
  // PART 1 — IncrementalContextStatsReader property tests (mirrors usage-sampler.mjs's own 14a/c/d/e,
  // last-wins instead of summed).
  // ===================================================================================================
  const cwd1 = path.join(tmpHome, "repo1");

  // -- (a) incremental over several appended chunks == a full readContextStats parse at each stage -----
  {
    const reader = new IncrementalContextStatsReader();
    const eng = "engP-1"; const f = fileFor(cwd1, eng);
    const u0 = { in: 1000, out: 10, cc: 0, cr: 0 };
    const u1 = { in: 2000, out: 10, cc: 500, cr: 0 };
    const u2 = { in: 3000, out: 10, cc: 0, cr: 700 };
    fs.writeFileSync(f, turnLine(`${eng}-m0`, u0) + "\n");
    let inc = await reader.read("sP", cwd1, eng);
    check("1a after chunk 1: inputTokens == last (and only) turn's own total, turns 1",
      inc.inputTokens === inputTokensOf(u0) && inc.turns === 1);
    fs.appendFileSync(f, turnLine(`${eng}-m1`, u1) + "\n");
    inc = await reader.read("sP", cwd1, eng);
    check("1a after chunk 2: LAST-WINS to the newest turn's total, turns 2 (never summed with chunk 1)",
      inc.inputTokens === inputTokensOf(u1) && inc.turns === 2);
    fs.appendFileSync(f, turnLine(`${eng}-m2`, u2) + "\n");
    inc = await reader.read("sP", cwd1, eng);
    const full = readContextStats(cwd1, eng);
    check("1a after chunk 3: == a full readContextStats parse (inputTokens + turns + model)",
      inc.inputTokens === full.inputTokens && inc.turns === full.turns && inc.model === full.model);
    check("1a chunk 3's own value (in 3000+cr700=3700), turns 3", inc.inputTokens === inputTokensOf(u2) && inc.turns === 3);
  }

  // -- (b) PARTIAL LINE: a tick ending mid-line (no trailing \n) buffers the remainder; completing it on
  //        the next read counts it exactly once (not lost, not double). --------------------------------
  {
    const reader = new IncrementalContextStatsReader();
    const eng = "engB-1"; const f = fileFor(cwd1, eng);
    const L0 = turnLine("b-m0", { in: 100, out: 10, cc: 0, cr: 0 });
    const L1 = turnLine("b-m1", { in: 900, out: 10, cc: 0, cr: 0 });
    fs.writeFileSync(f, L0 + "\n");
    let inc = await reader.read("sB", cwd1, eng);
    check("1b after the first complete line: in 100, turns 1", inc.inputTokens === 100 && inc.turns === 1);
    const half = Math.floor(L1.length / 2);
    fs.appendFileSync(f, L1.slice(0, half)); // append HALF of L1 — no newline yet
    inc = await reader.read("sB", cwd1, eng);
    check("1b a mid-line partial is buffered, NOT folded in — read() returns null (nothing NEW to report)", inc === null);
    fs.appendFileSync(f, L1.slice(half) + "\n"); // complete the line
    inc = await reader.read("sB", cwd1, eng);
    check("1b completing the line counts it once (in 900, turns 2) == full parse",
      inc.inputTokens === 900 && inc.turns === 2 && inc.inputTokens === readContextStats(cwd1, eng).inputTokens);
  }

  // -- (c) ROTATION: the engineSessionId changes (fork/recycle) ⇒ the cache RESETS and the NEW file is
  //        read from 0 — card 8a5bd0d0 (the daemon follows the CURRENT transcript file, never a stale one).
  //        Code Review round 2 (card c5b234aa): the post-rotation file must be LARGER than the
  //        pre-rotation cached offset — a SMALLER one lets the separate truncation-reset branch
  //        (`size < lastReadEnd`) mask a disabled rotation-reset check (both branches reset the cache
  //        the same way), so a mutant that disables rotation-reset alone would still pass this test.
  // -----------------------------------------------------------------------------------------------------
  {
    const reader = new IncrementalContextStatsReader();
    const eng1 = "engC-1"; const f1 = fileFor(cwd1, eng1);
    fs.writeFileSync(f1, turnLine("c1-m0", { in: 5000, out: 10, cc: 0, cr: 0 }) + "\n");
    let inc = await reader.read("sC", cwd1, eng1);
    check("1c pre-rotation reading (in 5000)", inc.inputTokens === 5000 && inc.turns === 1);
    const preRotationOffset = fs.statSync(f1).size;

    const eng2 = "engC-2"; const f2 = fileFor(cwd1, eng2); // SAME loom session id, NEW engine id
    fs.writeFileSync(f2, [
      turnLine("c2-m0", { in: 111, out: 10, cc: 0, cr: 0 }),
      turnLine("c2-m1", { in: 222, out: 10, cc: 0, cr: 0 }),
      turnLine("c2-m2", { in: 150, out: 10, cc: 0, cr: 0 }),
    ].join("\n") + "\n");
    check("1c sanity: the post-rotation file is LARGER than the pre-rotation cached offset (the exact gap above)",
      fs.statSync(f2).size > preRotationOffset);

    inc = await reader.read("sC", cwd1, eng2);
    check("1c rotation resets the cache → the NEW file counted from 0 (in 150, turns 3 — not stale/garbage)",
      inc.inputTokens === 150 && inc.turns === 3);
  }

  // -- (d) TRUNCATION/shrink: size < the cached offset ⇒ the cache resets and the (smaller) file is
  //        re-read from 0. -------------------------------------------------------------------------------
  {
    const reader = new IncrementalContextStatsReader();
    const eng = "engD-1"; const f = fileFor(cwd1, eng);
    fs.writeFileSync(f, [turnLine("d-m0", { in: 100, out: 10, cc: 0, cr: 0 }), turnLine("d-m1", { in: 200, out: 10, cc: 0, cr: 0 })].join("\n") + "\n");
    let inc = await reader.read("sD", cwd1, eng);
    check("1d pre-truncation reading (in 200, turns 2)", inc.inputTokens === 200 && inc.turns === 2);
    fs.writeFileSync(f, turnLine("d-m2", { in: 50, out: 10, cc: 0, cr: 0 }) + "\n"); // shrink to a smaller file
    inc = await reader.read("sD", cwd1, eng);
    check("1d truncation (size < offset) resets + full re-reads (in 50, turns 1 — not from the old offset)",
      inc.inputTokens === 50 && inc.turns === 1);
  }

  // -- (e) no usage-bearing line yet ⇒ null (never a measured 0) -----------------------------------------
  {
    const reader = new IncrementalContextStatsReader();
    const eng = "engE-1"; const f = fileFor(cwd1, eng);
    fs.writeFileSync(f, JSON.stringify({ type: "assistant", message: { model: MODEL } }) + "\n"); // no usage field
    const inc = await reader.read("sE", cwd1, eng);
    check("1e an assistant line with no usage ⇒ null (not a measured 0), but turns still counted via a later read",
      inc === null);
  }

  // -- (f) Code Review round 2: a batch of new complete lines that carries NO fresh usage reading must
  //        return null EVEN WHEN a PRIOR call already set lastInputTokens — the bug was returning that
  //        stale cached value as if it were fresh (a false ctxMidTurn:true, and churn with no new data).
  //        (f1) a user-only append after an established reading. ----------------------------------------
  {
    const reader = new IncrementalContextStatsReader();
    const eng = "engF1-1"; const f = fileFor(cwd1, eng);
    fs.writeFileSync(f, turnLine("f1-m0", { in: 400_000, out: 10, cc: 0, cr: 0 }) + "\n");
    let inc = await reader.read("sF1", cwd1, eng);
    check("1f1 an established reading exists (in 400000)", inc.inputTokens === 400_000);
    fs.appendFileSync(f, JSON.stringify({ type: "user", message: { content: "a plain human/tool turn, no assistant usage" } }) + "\n");
    inc = await reader.read("sF1", cwd1, eng);
    check("1f1 a user-only append ⇒ null, NEVER the stale 400000 re-reported as fresh", inc === null);
  }
  // (f2) a tool_result-only append after an established reading. --------------------------------------
  {
    const reader = new IncrementalContextStatsReader();
    const eng = "engF2-1"; const f = fileFor(cwd1, eng);
    fs.writeFileSync(f, turnLine("f2-m0", { in: 500_000, out: 10, cc: 0, cr: 0 }) + "\n");
    let inc = await reader.read("sF2", cwd1, eng);
    check("1f2 an established reading exists (in 500000)", inc.inputTokens === 500_000);
    fs.appendFileSync(f, JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }) + "\n");
    inc = await reader.read("sF2", cwd1, eng);
    check("1f2 a tool_result-only append ⇒ null, NEVER the stale 500000 re-reported as fresh", inc === null);
  }
  // (f3) an isApiErrorMessage-only append after an established reading — AND never a 0% write (the
  //      synthetic line's own usage object is all-zero, which `foldContextLine` must still skip
  //      entirely, not fold in as a genuine zero reading). ---------------------------------------------
  {
    const reader = new IncrementalContextStatsReader();
    const eng = "engF3-1"; const f = fileFor(cwd1, eng);
    fs.writeFileSync(f, turnLine("f3-m0", { in: 600_000, out: 10, cc: 0, cr: 0 }) + "\n");
    let inc = await reader.read("sF3", cwd1, eng);
    check("1f3 an established reading exists (in 600000)", inc.inputTokens === 600_000);
    fs.appendFileSync(f, JSON.stringify({
      type: "assistant", isApiErrorMessage: true,
      message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    }) + "\n");
    inc = await reader.read("sF3", cwd1, eng);
    check("1f3 an isApiErrorMessage-only append ⇒ null, NEVER the stale 600000 AND NEVER a false 0%", inc === null);
  }

  // -- (g) card f10a6f40 two-path asymmetry: the bare engineTranscriptPath misses (a dir-encoding drift)
  //        ⇒ falls back to resolveTranscriptFile's scan ONCE, caches the winning path, and every LATER
  //        call for the SAME session uses that cached path directly (no repeated readdir). ------------
  {
    const reader = new IncrementalContextStatsReader();
    const eng = `engG-drift-${Date.now()}-${process.pid}`; // globally-unique per card 7d70b27b
    // Write the transcript under a DRIFTED dir name — NOT what encodeProjectDir(cwd1) would compute —
    // so the BARE path misses but resolveTranscriptFile's scan-by-id (anywhere under ~/.claude/projects)
    // still finds it, exactly like a real dir-encoding-drift session (card f10a6f40).
    const claudeProjectsRoot = path.join(process.env.HOME || process.env.USERPROFILE, ".claude", "projects");
    const driftedDir = path.join(claudeProjectsRoot, "drifted-encoding-dir-not-matching-cwd1");
    fs.mkdirSync(driftedDir, { recursive: true });
    const driftedFile = path.join(driftedDir, `${eng}.jsonl`);
    fs.writeFileSync(driftedFile, turnLine("g-m0", { in: 321_000, out: 10, cc: 0, cr: 0 }) + "\n");
    const bareFile = engineTranscriptPath(cwd1, eng);
    check("1g sanity: the bare computed path genuinely does NOT exist (the drift this test exercises)", !fs.existsSync(bareFile));

    const inc = await reader.read("sG", cwd1, eng);
    check("1g bare path misses ⇒ falls back to the scan and still finds the real reading (in 321000)",
      inc && inc.inputTokens === 321_000);

    // A SECOND read, after the drifted file grows, must use the CACHED resolved path directly — proven
    // by spying on fs.promises.open and confirming it opens the DRIFTED file (never the bare, nonexistent
    // one) with no further readdir needed (readdirSync spy: exactly one call total, from the FIRST read's
    // fallback — not a second one on this read).
    let readdirCalls = 0;
    const realReaddirSync = fs.readdirSync;
    fs.readdirSync = (...a) => { readdirCalls++; return realReaddirSync(...a); };
    let openedPaths = [];
    const realOpen = fs.promises.open;
    fs.promises.open = async (p, ...rest) => { openedPaths.push(p); return realOpen(p, ...rest); };
    try {
      fs.appendFileSync(driftedFile, turnLine("g-m1", { in: 322_000, out: 10, cc: 0, cr: 0 }) + "\n");
      const inc2 = await reader.read("sG", cwd1, eng);
      check("1g second read (after growth) uses the CACHED resolved path directly (in 322000)", inc2 && inc2.inputTokens === 322_000);
      check("1g second read opened the DRIFTED file (not the bare, nonexistent computed path)",
        openedPaths.length === 1 && path.resolve(openedPaths[0]) === path.resolve(driftedFile));
      check("1g second read triggered NO further readdir — the resolved path was served from cache, not re-scanned",
        readdirCalls === 0);
    } finally {
      fs.readdirSync = realReaddirSync;
      fs.promises.open = realOpen;
    }
  }

  // -- (h) NEGATIVE-CACHE: a genuinely missing transcript suppresses resolveTranscriptFile's own SYNC
  //        readdir scan on a repeated call within the TTL, and resumes scanning once the TTL elapses
  //        (card c5b234aa, Code Review round 3, item 2) — the SAME readdirSync spy (g) already uses,
  //        now proving the scan itself (not just the null outcome) is suppressed while cached. ----------
  {
    const reader = new IncrementalContextStatsReader();
    const eng = `engH-missing-${Date.now()}-${process.pid}`; // globally unique, genuinely never written anywhere
    let readdirCalls = 0;
    const realReaddirSync = fs.readdirSync;
    fs.readdirSync = (...a) => { readdirCalls++; return realReaddirSync(...a); };
    const realNow = Date.now;
    try {
      const inc1 = await reader.read("sH", cwd1, eng);
      check("1h first read on a genuinely missing transcript ⇒ null", inc1 === null);
      check("1h first read DID scan (resolveTranscriptFile's own readdir — the cost this cache bounds)", readdirCalls >= 1);

      readdirCalls = 0;
      const inc2 = await reader.read("sH", cwd1, eng);
      check("1h second read, within the TTL ⇒ STILL null", inc2 === null);
      check("1h second read did NOT scan again — the miss is negative-cached", readdirCalls === 0);

      // Simulate the TTL elapsing (mock Date.now — never a real sleep; fixed-wait-witness-guard has no
      // quarrel with this, since nothing here waits on a timer — it's a pure logical clock substitution).
      Date.now = () => realNow() + 4 * 60_000; // comfortably past the 3-minute negative-cache TTL
      readdirCalls = 0;
      const inc3 = await reader.read("sH", cwd1, eng);
      check("1h third read, AFTER the TTL ⇒ still null (still genuinely missing)", inc3 === null);
      check("1h third read DID re-scan once the TTL elapsed — a transcript appearing later is still found",
        readdirCalls >= 1);
    } finally {
      fs.readdirSync = realReaddirSync;
      Date.now = realNow;
    }
  }

  // -- (i) PATH CHANGE: when the resolved path moves to a DIFFERENT file for the SAME engineSessionId
  //        (the bare path vanishes and resolveTranscriptFile's drift scan finds the transcript somewhere
  //        new), the cached offset/partialBytes — relative to the OLD file — must be discarded and the
  //        NEW file read fresh from 0, never sliced at the old file's byte offset (card c5b234aa, Code
  //        Review round 3, item 3). The cached offset is driven STRICTLY INSIDE the new file's second
  //        line (never at a line boundary) — a byte-sliced read starting there can only ever produce
  //        unparseable garbage or null, never 333 by coincidence; a boundary-aligned offset could. -------
  {
    const reader = new IncrementalContextStatsReader();
    const eng = `engI-pathchange-${Date.now()}-${process.pid}`;
    const bareFile = fileFor(cwd1, eng);
    fs.writeFileSync(bareFile, turnLine("i-bare-m0", { in: 111, out: 10, cc: 0, cr: 0 }) + "\n");
    let inc = await reader.read("sI", cwd1, eng);
    check("1i pre-switch reading off the bare path (in 111)", inc.inputTokens === 111 && inc.turns === 1);

    const claudeProjectsRoot = path.join(process.env.HOME || process.env.USERPROFILE, ".claude", "projects");
    const driftedDir = path.join(claudeProjectsRoot, "drifted-pathchange-dir");
    fs.mkdirSync(driftedDir, { recursive: true });
    const driftedFile = path.join(driftedDir, `${eng}.jsonl`);
    const driftedLine0 = turnLine("i-drift-m0", { in: 222, out: 10, cc: 0, cr: 0 }) + "\n";
    const driftedLine1 = turnLine("i-drift-m1", { in: 333, out: 10, cc: 0, cr: 0 }) + "\n";
    fs.writeFileSync(driftedFile, driftedLine0 + driftedLine1);
    const drift0Len = Buffer.byteLength(driftedLine0);
    const totalDriftLen = drift0Len + Buffer.byteLength(driftedLine1);

    // Pad the BARE file's cache with an UNTERMINATED trailing fragment (no trailing \n — buffered as
    // `partialBytes`, which `lastReadEnd` also counts) so the cached offset lands STRICTLY inside the
    // drifted file's SECOND line once the path switches, comfortably clear of either line boundary.
    const target = drift0Len + 20;
    check("1i sanity: the target offset lands strictly inside the drifted file's second line (test construction)",
      target > drift0Len + 5 && target < totalDriftLen - 5);
    const bareLen = fs.statSync(bareFile).size;
    if (target > bareLen) fs.appendFileSync(bareFile, "x".repeat(target - bareLen));
    const padded = await reader.read("sI", cwd1, eng); // absorbed into partialBytes; nothing complete to report
    check("1i padding has no complete line yet ⇒ null", padded === null);

    fs.rmSync(bareFile); // the bare path vanishes
    inc = await reader.read("sI", cwd1, eng);
    check("1i post-switch: resets and re-reads the NEW file from 0 (in 333, turns 2 — a FULL fresh parse, not a stale-offset slice)",
      inc && inc.inputTokens === 333 && inc.turns === 2);
  }

  // -- (j) NEGATIVE-CACHE ROTATION HOLE (card c5b234aa, Code Review round 4): a session whose transcript
  //        is NEVER found under its FIRST engineSessionId keeps no `cache` entry at all (that only gets
  //        created once a file is actually located) — so the rotation-clear at the top of read(), which
  //        keys off an EXISTING cache entry's engineSessionId, can never fire for this session. Without
  //        storing WHICH engineSessionId a miss was recorded under, a rotation (fork/recycle) to a NEW
  //        engineSessionId would stay suppressed by the stale miss for the rest of the TTL window, even
  //        though the new id's transcript is real and findable. ----------------------------------------
  {
    const reader = new IncrementalContextStatsReader();
    const sessionId = "sJ";
    const engOld = `engJ-old-${Date.now()}-${process.pid}`; // genuinely never written anywhere
    let readdirCalls = 0;
    const realReaddirSync = fs.readdirSync;
    fs.readdirSync = (...a) => { readdirCalls++; return realReaddirSync(...a); };
    try {
      const incMiss1 = await reader.read(sessionId, cwd1, engOld);
      check("1j first read on the OLD engine id (genuinely missing) ⇒ null", incMiss1 === null);
      check("1j first read scanned once (nothing cached yet)", readdirCalls >= 1);

      readdirCalls = 0;
      const incMiss2 = await reader.read(sessionId, cwd1, engOld);
      check("1j second read, SAME engine id within the TTL ⇒ still null", incMiss2 === null);
      check("1j second read did NOT re-scan — negative-cached for this engine id", readdirCalls === 0);

      // ROTATION: a new engineSessionId for the SAME Loom session id (card 8a5bd0d0), still within the
      // old miss's TTL window. This session never had a `cache` entry (the old id was never found), so
      // the entry-keyed rotation-clear at the top of read() cannot have run — the per-engineSessionId
      // check inside the miss-cache lookup itself must be what prevents a stale suppression.
      const engNew = `engJ-new-${Date.now()}-${process.pid}`;
      const claudeProjectsRoot = path.join(process.env.HOME || process.env.USERPROFILE, ".claude", "projects");
      const driftedDir = path.join(claudeProjectsRoot, "drifted-rotation-hole-dir");
      fs.mkdirSync(driftedDir, { recursive: true });
      const driftedFile = path.join(driftedDir, `${engNew}.jsonl`);
      fs.writeFileSync(driftedFile, turnLine("j-new-m0", { in: 444_000, out: 10, cc: 0, cr: 0 }) + "\n");

      readdirCalls = 0;
      const incNew = await reader.read(sessionId, cwd1, engNew);
      check("1j RED/GREEN: rotating to a NEW engine id re-scans despite the old id's miss still being within TTL",
        readdirCalls >= 1);
      check("1j rotation finds the NEW engine id's real transcript (in 444000) — not wrongly suppressed by the OLD id's negative cache",
        incNew && incNew.inputTokens === 444_000);
    } finally {
      fs.readdirSync = realReaddirSync;
    }
  }

  // ===================================================================================================
  // PART 2 — BOUNDED READ: the second call, after the file grows, must request ONLY the newly-appended
  // byte range — never re-reading from offset 0. A byte-range spy on fs.promises.open/fh.read proves it.
  // ===================================================================================================
  {
    const reader = new IncrementalContextStatsReader();
    const eng = "engBR-1"; const f = fileFor(cwd1, eng);
    const requestedPositions = [];
    const realOpen = fs.promises.open;
    fs.promises.open = async (...a) => {
      const fh = await realOpen(...a);
      const realRead = fh.read.bind(fh);
      fh.read = (buf, off, length, pos) => { requestedPositions.push({ pos, length }); return realRead(buf, off, length, pos); };
      return fh;
    };
    try {
      fs.writeFileSync(f, turnLine("br-m0", { in: 100, out: 10, cc: 0, cr: 0 }) + "\n");
      const sizeAfterFirst = fs.statSync(f).size;
      await reader.read("sBR", cwd1, eng);
      check("2 first read requests starting at byte 0 (nothing cached yet)",
        requestedPositions.length === 1 && requestedPositions[0].pos === 0);

      requestedPositions.length = 0;
      fs.appendFileSync(f, turnLine("br-m1", { in: 200, out: 10, cc: 0, cr: 0 }) + "\n");
      await reader.read("sBR", cwd1, eng);
      check("2 second read (after growth) requests starting at the PREVIOUS file size, not 0 — never a full re-read",
        requestedPositions.length === 1 && requestedPositions[0].pos === sizeAfterFirst);
      check("2 second read's requested length == only the APPENDED bytes (not the whole new file size)",
        requestedPositions[0].length === fs.statSync(f).size - sizeAfterFirst);

      // No new bytes at all ⇒ no read call whatsoever (not even a zero-length one).
      requestedPositions.length = 0;
      await reader.read("sBR", cwd1, eng);
      check("2 a third read with NO new bytes issues no fh.read call at all", requestedPositions.length === 0);
    } finally {
      fs.promises.open = realOpen;
    }
  }

  // ===================================================================================================
  // PART 3 — GROWING FIXTURE through a live sampler: a BUSY session's transcript grows mid-turn (no Stop
  // anywhere in this flow) ⇒ MidTurnContextSampler.tick() advances ctxInputTokens/ctxTurns/ctxUpdatedAt
  // in the DB on its own.
  // ===================================================================================================
  const db3 = new Db(path.join(tmpHome, "mtcs3.db"));
  const cwd3 = path.join(tmpHome, "repo3");
  mkProject(db3, "p3", cwd3);
  mkAgent(db3, "a3", "p3");
  const eng3 = "eng3-1";
  mkSession(db3, { id: "w3", projectId: "p3", agentId: "a3", engineSessionId: eng3, cwd: cwd3, harness: "claude", busy: true });
  const f3 = fileFor(cwd3, eng3);
  fs.writeFileSync(f3, turnLine("w3-m0", { in: 10_000, out: 10, cc: 0, cr: 0 }) + "\n");

  const sampler3 = new MidTurnContextSampler({ db: db3, intervalMs: 3_600_000 });
  await sampler3.tick();
  let row3 = db3.getSession("w3");
  check("3 after tick #1 (still busy, never a Stop): ctxInputTokens advances from null to the transcript's reading",
    row3.ctxInputTokens === 10_000 && row3.ctxTurns === 1 && row3.ctxUpdatedAt != null);
  const measuredAt1 = row3.ctxUpdatedAt;

  fs.appendFileSync(f3, turnLine("w3-m1", { in: 85_000, out: 10, cc: 0, cr: 0 }) + "\n"); // grew mid-turn
  await sampler3.tick();
  row3 = db3.getSession("w3");
  check("3 after tick #2 (STILL no Stop): ctxInputTokens advances AGAIN, tracking the growing transcript",
    row3.ctxInputTokens === 85_000 && row3.ctxTurns === 2);
  check("3 ctxUpdatedAt itself advanced too (a reader can tell this is a fresh mid-turn sample, not a stale one)",
    row3.ctxUpdatedAt !== measuredAt1 && row3.ctxUpdatedAt >= row3.lastActivity);
  check("3 the worker is STILL busy — this never looked like, or waited for, a turn boundary", row3.busy === true);

  // A tick with no appended bytes since the last read is a genuine no-op (no write at all, no churn on
  // ctxUpdatedAt) — re-confirm the reader's own "no new bytes -> no call" property holds through the
  // sampler too, not just the raw reader in Part 2.
  const measuredAt2 = row3.ctxUpdatedAt;
  await sampler3.tick();
  check("3 a tick with nothing new to read leaves ctxUpdatedAt untouched", db3.getSession("w3").ctxUpdatedAt === measuredAt2);

  db3.close();

  // ===================================================================================================
  // PART 4 — THE STOP-HOOK RACE: the sampler reads, awaits, then writes. If the turn ENDS (Stop fires)
  // during that await, the Stop handler's unconditional write is authoritative and must survive —the
  // sampler's own, now-stale mid-turn write must be skipped, never overwrite it.
  // ===================================================================================================
  const db4 = new Db(path.join(tmpHome, "mtcs4.db"));
  const cwd4 = path.join(tmpHome, "repo4");
  mkProject(db4, "p4", cwd4);
  mkAgent(db4, "a4", "p4");
  const eng4 = "eng4-1";
  mkSession(db4, { id: "w4", projectId: "p4", agentId: "a4", engineSessionId: eng4, cwd: cwd4, harness: "claude", busy: true });
  fs.writeFileSync(fileFor(cwd4, eng4), turnLine("w4-m0", { in: 40_000, out: 10, cc: 0, cr: 0 }) + "\n");

  const sampler4 = new MidTurnContextSampler({ db: db4, intervalMs: 3_600_000 });
  // Monkey-patch the sampler's OWN reader instance (mirrors usage-sampler.mjs's `sampler7.incrementalReader`
  // race rig exactly): after the real read resolves (the sampler now holds a 40_000 mid-turn snapshot and
  // is about to write it), simulate the turn ENDING — a Stop hook firing its OWN unconditional write with
  // a DIFFERENT, authoritative value — before control ever returns to the sampler's own write.
  const realRead4 = sampler4.reader.read.bind(sampler4.reader);
  sampler4.reader.read = async (...a) => {
    const r = await realRead4(...a);
    // "Stop fires here" — unconditional, exactly like pty/host.ts's real handler. Also ends the turn.
    db4.setContextCounters("w4", { ctxInputTokens: 123_456, ctxTurns: 99, model: MODEL });
    db4.setBusy("w4", false);
    return r;
  };
  await sampler4.tick();
  const row4 = db4.getSession("w4");
  check("4 the Stop-hook's write survives: ctxInputTokens is the Stop's authoritative value, not the sampler's",
    row4.ctxInputTokens === 123_456 && row4.ctxTurns === 99);
  check("4 the sampler's compare-and-set correctly detected the race and skipped (never 40_000)",
    row4.ctxInputTokens !== 40_000);
  check("4 the session is idle, exactly as the simulated Stop left it", row4.busy === false);

  // POSITIVE CONTROL: with NO interleaving Stop, the sampler's own write DOES land — proving part 4's
  // skip above is the race guard actually firing, not some unrelated reason the write never happens.
  const db4b = new Db(path.join(tmpHome, "mtcs4b.db"));
  mkProject(db4b, "p4b", cwd4);
  mkAgent(db4b, "a4b", "p4b");
  mkSession(db4b, { id: "w4b", projectId: "p4b", agentId: "a4b", engineSessionId: eng4, cwd: cwd4, harness: "claude", busy: true });
  const sampler4b = new MidTurnContextSampler({ db: db4b, intervalMs: 3_600_000 });
  await sampler4b.tick();
  check("4 (control) with no race, the sampler's own mid-turn write DOES land normally",
    db4b.getSession("w4b").ctxInputTokens === 40_000);
  db4b.close();

  db4.close();

  // ===================================================================================================
  // PART 5 — ROTATION through a live sampler tick: the session's engineSessionId changes between ticks
  // (fork/recycle, card 8a5bd0d0) ⇒ the sampler follows the CURRENT transcript, never the abandoned one.
  // ===================================================================================================
  const db5 = new Db(path.join(tmpHome, "mtcs5.db"));
  const cwd5 = path.join(tmpHome, "repo5");
  mkProject(db5, "p5", cwd5);
  mkAgent(db5, "a5", "p5");
  const eng5a = "eng5-1";
  mkSession(db5, { id: "w5", projectId: "p5", agentId: "a5", engineSessionId: eng5a, cwd: cwd5, harness: "claude", busy: true });
  fs.writeFileSync(fileFor(cwd5, eng5a), turnLine("w5a-m0", { in: 60_000, out: 10, cc: 0, cr: 0 }) + "\n");
  const sampler5 = new MidTurnContextSampler({ db: db5, intervalMs: 3_600_000 });
  await sampler5.tick();
  check("5 pre-rotation mid-turn reading (in 60_000)", db5.getSession("w5").ctxInputTokens === 60_000);

  const eng5b = "eng5-2"; // a NEW engine session id — same Loom session row (rotation, not a fresh spawn)
  db5.setEngineSessionId("w5", eng5b);
  fs.writeFileSync(fileFor(cwd5, eng5b), turnLine("w5b-m0", { in: 777, out: 10, cc: 0, cr: 0 }) + "\n");
  await sampler5.tick();
  check("5 post-rotation: the sampler follows the NEW transcript from 0 (in 777 — not stale 60_000, not summed)",
    db5.getSession("w5").ctxInputTokens === 777 && db5.getSession("w5").ctxTurns === 1);
  db5.close();

  // ===================================================================================================
  // PART 6 — a codex-harness (no context telemetry) busy session is NEVER sampled, even with a populated,
  // correctly-shaped transcript file sitting right at its own path — proven against a PARALLEL claude
  // session in the SAME tick that DOES get sampled (so the skip is provably the harness gate, not a
  // missing file, a broken reader, or some other unrelated reason).
  // ===================================================================================================
  const db6 = new Db(path.join(tmpHome, "mtcs6.db"));
  const cwd6 = path.join(tmpHome, "repo6");
  mkProject(db6, "p6", cwd6);
  mkAgent(db6, "a6", "p6");
  const engCodex = "eng6-codex"; const engClaude = "eng6-claude";
  mkSession(db6, { id: "w6-codex", projectId: "p6", agentId: "a6", engineSessionId: engCodex, cwd: cwd6, harness: "codex", busy: true });
  mkSession(db6, { id: "w6-claude", projectId: "p6", agentId: "a6", engineSessionId: engClaude, cwd: cwd6, harness: "claude", busy: true });
  fs.writeFileSync(fileFor(cwd6, engCodex), turnLine("w6c-m0", { in: 99_000, out: 10, cc: 0, cr: 0 }) + "\n");
  fs.writeFileSync(fileFor(cwd6, engClaude), turnLine("w6k-m0", { in: 44_000, out: 10, cc: 0, cr: 0 }) + "\n");

  const sampler6 = new MidTurnContextSampler({ db: db6, intervalMs: 3_600_000 });
  await sampler6.tick();
  check("6 the codex-harness session is NEVER sampled (ctxInputTokens stays null, not a measured 0)",
    db6.getSession("w6-codex").ctxInputTokens === null);
  check("6 (control) the SAME tick's claude session, with an equally-shaped transcript, IS sampled",
    db6.getSession("w6-claude").ctxInputTokens === 44_000);
  db6.close();
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — mid-turn context sampler: incremental reader (chunk-boundary == full parse, partial-" +
    "line buffering, rotation/truncation reset, no-usage-yet null, a missing transcript's scan is " +
    "negative-cached then retried past its TTL, a resolved-path CHANGE resets rather than byte-slicing " +
    "the wrong file, and (round 4) a rotation to a NEW engine id is never suppressed by a stale negative " +
    "cache recorded under an ABANDONED one) + bounded-read proof (never re-reads from 0) + growing-" +
    "fixture live-tick advance with no Stop + Stop-hook race guard (with a no-race positive control) + " +
    "sampler-level rotation + codex/no-telemetry skip (with a claude positive control)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
