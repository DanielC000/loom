// Card 7114838d — frame-splice detector: LOG-ONLY diagnostic instrumentation, fixes nothing (does not
// close 3ce3fa39). Compares the engine's own report of what was actually submitted (UserPromptSubmit's
// `prompt` field) against `live.lastPrompt` (what the daemon itself intended to write for that turn) —
// the one comparison that can distinguish "written and applied" from "written and dropped/spliced",
// because the two sides come from genuinely independent sources.
//
// POSITIVE-CONTROL (mandatory per the card): a detector never shown going red is not evidence. This file
// proves the detector can FIRE on a synthesized mismatch (and that the log is SELF-CLASSIFYING — a real
// splice's large tails read differently from a benign trailing artifact's tiny ones), stays SILENT on a
// matching pair, is GATED on submitWasOutstanding (so a raw human-typed turn against a stale lastPrompt
// never misfires — the known false-positive class), and is SELF-DIAGNOSING when the engine never sends a
// `prompt` field at all.
//
// ⚠️ WHAT THIS SUITE DOES NOT PROVE: every scenario here SYNTHESIZES the hook payload. It proves the
// detector's comparison/gating/logging logic is correct GIVEN that `hook.prompt` exists and reports the
// engine's literal submitted text — it does NOT and cannot prove Claude Code actually sends that field, or
// that it reports the identical string byte-for-byte (no Ink-side trimming/normalization). That premise is
// answered only by the FIRST REAL hook after deploy: either the mismatch/match log fires as expected, or
// the `UNCONFIRMED` self-diagnostic line (scenario 4) fires instead, and only then is the question settled.
//
// Mirrors pty-owner-attestation.mjs's harness: the REAL PtyHost state machine + a FAKE pty (createPty
// seam) — NO real claude/daemon/network.
// RUN (no daemon needed): node test/pty-prompt-mismatch.mjs  (build first: from packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-prompt-mismatch-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakesById = new Map(); // sessionId -> fake pty ({ writes, ... }) — card 201d0d95's new scenarios need
// to inspect what actually got submitted to a SPECIFIC session's pty, not just whether a console.log fired.
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakesById.set(opts.sessionId, fake);
    return fake;
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Card 1addef27 (fixed-wait-negative-guard) / card 201d0d95 manager review: a bounded POLL on the actual
// completion signal, not a fixed clock — mirrors paste-placeholder-tripwire.mjs's own `waitUntil`. The
// guard's own header names this shape as its documented blind spot ("a locally-reimplemented waitUntil/
// poll-loop... usually safe"), because it IS a genuinely different shape from a blind sleep: it retries
// against an observed condition rather than assuming a fixed duration was enough.
const waitUntil = async (predicate, timeoutMs = 2000, stepMs = 5) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
};
// Whether ANY pending entry for `sid` is the prompt-mismatch notice — reads PtyHost's own queue state
// directly (host.getPendingEntries), not an indirect symptom like pty writes.
const hasPendingMismatchNotice = (sid) => host.getPendingEntries(sid).some((e) => e.text.includes("[loom:prompt-mismatch]"));

function newSession(name) {
  const sid = `sess-${name}`;
  host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sid, { hook_event_name: "SessionStart" });
  return sid;
}

// Captures console.log lines matching the detector's [prompt-mismatch] tag for the duration of a block.
// The detector logs via console.log (stdout) deliberately — same stream as [pty-write]/[submit-write]/
// [stdin-write], so line order in the combined log stays meaningful alongside those records; see the
// comment above the detector in host.ts.
function captureMismatchWarnings(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (msg) => { if (typeof msg === "string" && msg.includes("[prompt-mismatch]")) lines.push(msg); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

const SIDS = [];

try {
  // ===== 1. POSITIVE CONTROL: a synthesized mismatch (reported = stranded + intended) FIRES, and the log
  // names WHERE the divergence starts, not just that one exists =====
  {
    const sid = newSession("A"); SIDS.push(sid);
    const stranded = "leftover text from a prior turn";
    const intended = "the new message the user actually typed";
    host.enqueueStdin(sid, intended); // submit() outstanding -> live.lastPrompt = intended, enterConfirmed=false
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: stranded + intended });
    });
    check("1: a synthesized splice (reported = stranded+intended) FIRES the detector", warnings.length === 1);
    check("1: the log names the divergence POINT (a char offset), not just a bare true/false", /divergesAtChar=\d+/.test(warnings[0] ?? ""));
    check("1: the log shows an excerpt around the divergence on BOTH sides", /reportedAround=/.test(warnings[0] ?? "") && /intendedAround=/.test(warnings[0] ?? ""));
    check("1: divergesAtChar is 0 — the specimens splice from the very start (stranded prefix precedes everything)", /divergesAtChar=0\b/.test(warnings[0] ?? ""));
    // Self-classifying fields (manager review): a real splice has a LARGE tail on both sides at the
    // divergence point (the rest of two genuinely different messages), unlike a trailing/normalization
    // artifact which would diverge near the very end with tiny tails on both sides.
    check("1: lenDelta + both tail lengths are present so the reader can tell a real splice from a benign trailing/normalization artifact without doing arithmetic",
      /lenDelta=-?\d+/.test(warnings[0] ?? "") && /tailReportedLen=\d+/.test(warnings[0] ?? "") && /tailIntendedLen=\d+/.test(warnings[0] ?? ""));
    {
      const tailReported = Number((/tailReportedLen=(\d+)/.exec(warnings[0] ?? "") ?? [])[1]);
      const tailIntended = Number((/tailIntendedLen=(\d+)/.exec(warnings[0] ?? "") ?? [])[1]);
      check("1: this specimen's tails are LARGE on both sides (a real splice shape, not a trailing artifact)",
        Number.isFinite(tailReported) && Number.isFinite(tailIntended) && tailReported > 20 && tailIntended > 20);
    }
  }

  // ===== 2. NEGATIVE: a matching pair (reported === intended) does NOT fire =====
  {
    const sid = newSession("B"); SIDS.push(sid);
    const text = "a perfectly normal message";
    host.enqueueStdin(sid, text);
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: text });
    });
    check("2: a matching (non-spliced) turn stays SILENT", warnings.length === 0);
  }

  // ===== 3. GATING (known false-positive class): a raw human-typed turn — submitWasOutstanding===false —
  // must NEVER misfire against a stale lastPrompt left over from an earlier Loom-originated turn =====
  {
    const sid = newSession("C"); SIDS.push(sid);
    // Turn 1: a Loom-originated submit sets live.lastPrompt, then completes (Stop) — enterConfirmed=true,
    // no submit outstanding afterward. lastPrompt is left stale (the field is never cleared at Stop).
    host.enqueueStdin(sid, "[loom:reminder] an earlier, unrelated Loom turn");
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(sid, { hook_event_name: "Stop" });
    // Turn 2: a genuine raw-terminal Enter-submit (writeStdin), completely different text, with NO
    // submit() outstanding — enterConfirmed is already true, so submitWasOutstanding is false.
    const rawLine = "something the human typed directly into the raw terminal";
    host.writeStdin(sid, `${rawLine}\r`);
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: rawLine });
    });
    check("3: a raw-terminal turn (submitWasOutstanding=false) never compares against a stale lastPrompt", warnings.length === 0);
  }

  // ===== 4. SELF-DIAGNOSING: the engine never sends a usable 'prompt' field at all — must log this
  // explicitly, once, rather than silently comparing undefined and never firing =====
  {
    const sid = newSession("D"); SIDS.push(sid);
    host.enqueueStdin(sid, "some outstanding turn"); // submit() outstanding
    const warnings1 = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // NO prompt field at all
    });
    check("4: an absent prompt field is logged EXPLICITLY (not silently ignored)", warnings1.length === 1);
    check("4: the absent-field log names the premise as unconfirmed", /UNCONFIRMED/.test(warnings1[0] ?? ""));
    host.deliverHook(sid, { hook_event_name: "Stop" });
    // A SECOND turn on the same session, still missing the field, must NOT re-log — "once" per session.
    host.enqueueStdin(sid, "a second outstanding turn");
    const warnings2 = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    });
    check("4: a repeat absence on the SAME session does not re-log (latched once, not once-per-turn)", warnings2.length === 0);
  }

  // ===== 5. A fresh session's own startup-prompt hook never fires the detector (no submit() is
  // outstanding for the CLI-arg startup turn — enterConfirmed is seeded true) =====
  {
    const sid = "sess-E";
    host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, startupPrompt: "kickoff text" });
    SIDS.push(sid);
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "SessionStart" });
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: "kickoff text" });
    });
    check("5: the fresh-spawn startup-prompt hook (no submit outstanding) never fires the detector", warnings.length === 0);
  }

  // ===== 6. CONTRAST (manager review): a benign trailing-artifact-shaped mismatch (e.g. a lone trailing
  // character) reads DIFFERENTLY in the log than scenario 1's real-splice shape — small tails on both
  // sides at the divergence point, instead of scenario 1's large tails. This is what would let a reader
  // tell a systematic benign mismatch (framing/normalization) apart from an actual splice at a glance,
  // without the detector itself having to guess which one it is. =====
  {
    const sid = newSession("F"); SIDS.push(sid);
    const intended = "a normal short message";
    host.enqueueStdin(sid, intended);
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: `${intended} ` }); // one trailing char
    });
    check("6: a single trailing-char difference still FIRES (it is a real, if small, mismatch)", warnings.length === 1);
    check("6: divergesAtChar sits at the END of the shorter string (near both lengths), not at 0", new RegExp(`divergesAtChar=${intended.length}\\b`).test(warnings[0] ?? ""));
    check("6: BOTH tails are tiny here (0 and 1) — visibly different from scenario 1's large-tail splice shape", /tailReportedLen=1\b/.test(warnings[0] ?? "") && /tailIntendedLen=0\b/.test(warnings[0] ?? ""));
  }

  // ===== 7. Card 201d0d95 Q1 — POSITIVE: a mismatch must now SURFACE to the affected session itself, not
  // just to daemon-output.log. Reproduces the real incident's shape (session 363002b9, 2026-08-04): an
  // EARLIER generation's own already-confirmed text reappears, byte-for-byte, as what the engine reports
  // submitting for a LATER, unrelated generation. Must land as the notice's OWN pty submission (never
  // appended to the mismatched turn's own payload), naming BOTH the possible loss (intended text did not
  // reach the engine) and the possible duplicate (the submitted content matches an earlier generation) —
  // and must identify WHICH earlier generation, since `live.recentWrittenTurns` still holds it. =====
  {
    const sid = newSession("G"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const genAText = "[loom:worker-report] worker AAAA — generation A's own real report";
    const genBText = "[loom:worker-report] worker BBBB — generation B's own real report, never actually delivered";

    // Generation A: an ordinary, cleanly-confirmed turn — establishes the entry in recentWrittenTurns that
    // generation B's replay will later match.
    host.enqueueStdin(sid, genAText);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: genAText }); // byteIdentical=true, gen=1
    host.deliverHook(sid, { hook_event_name: "Stop" }); // completes turn A cleanly, queue empty

    // Generation B: Loom writes genBText, but the engine reports back genAText verbatim — the exact-replay
    // shape from the real incident (reportedHash equals a PRIOR generation's writtenHash, not this one's).
    host.enqueueStdin(sid, genBText); // gen=2, live.lastPrompt = genBText
    const writesBeforeMismatch = fake.writes.length;
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: genAText }); // byteIdentical=false
    // Manager review, card 201d0d95 (fixed-wait-negative-guard caught the ORIGINAL fixed-duration wait
    // here): a BARRIER, not a delay — poll for the REAL positive event the deferred setTimeout(0) produces
    // (the notice actually landing in host.getPendingEntries), rather than waiting a guessed duration and
    // hoping it landed in time. The negative check right below runs the INSTANT that poll observes it.
    const enqueued7 = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("7: the deferred notice actually enqueues (a real observed event, not assumed)", enqueued7);
    check("7: the deferred notice does not write DURING the mismatched turn itself (queued, not appended to it)",
      fake.writes.length === writesBeforeMismatch);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // completes the mismatched (genA-content) turn, drains the queued notice as its OWN new turn
    const noticeWrite = fake.writes.slice(writesBeforeMismatch).join("");
    check("7: a mismatch now produces a corrective turn on the pty (previously LOG-ONLY, card 201d0d95 Q1)",
      noticeWrite.includes("[loom:prompt-mismatch]"));
    check("7: the notice names the LOSS half (Loom's intended text may not have reached the engine)",
      /may not have reached you/.test(noticeWrite) && new RegExp(`${genBText.length} chars`).test(noticeWrite));
    check("7: the notice names the DUPLICATE half AND identifies the specific earlier generation replayed",
      /DUPLICATE/.test(noticeWrite) && /gen=1\b/.test(noticeWrite));
    check("7: the notice reports OBSERVED FIELDS (both hashes present) and asserts no CLI-internal cause",
      /writtenHash=\w+/.test(noticeWrite) && /reportedHash=\w+/.test(noticeWrite) && !/\bthe (cli|CLI) (did|dropped|collapsed)\b/i.test(noticeWrite));
    // Manager correction 2026-08-05: a Platform sweep measured this exact shape 15 times (14 sessions) and
    // found it is ALWAYS a replay of the IMMEDIATELY PRECEDING recorded generation — the notice should now
    // say so (a reader can go straight to "the message just before this one"), stated as an observed
    // REGULARITY, never as a claimed mechanism.
    check("7: since the matched entry IS the immediately preceding generation, the notice says so explicitly",
      /IMMEDIATELY PRECEDING/.test(noticeWrite));
    check("7: the regularity is framed as MEASURED/OBSERVED, never as an asserted cause",
      /measured|shown so far/i.test(noticeWrite) && !/\bbecause\b/i.test(noticeWrite));
  }

  // ===== 7b. Card 201d0d95 Q1 — the FALLBACK wording when no exact match is found in recentWrittenTurns
  // (e.g. the replayed content isn't from this session's own recent writes at all, or fell outside the
  // ring's window) still gives the reader the same measured guidance — check the immediately preceding
  // message — rather than a bare "unknown". =====
  {
    const sid = newSession("G2"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const genText = "[loom:worker-report] worker CCCC — this session's own only real report";
    const unrelatedReported = "content that never came from anything this session itself wrote";
    host.enqueueStdin(sid, genText); // gen=1
    const writesBeforeMismatch = fake.writes.length;
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: unrelatedReported }); // byteIdentical=false, no ring match
    // Same barrier as scenario 7 above (not flagged by the guard's own 5-line window here, but the SAME
    // shape/risk — fixed for real consistency, not just to satisfy the scanner).
    const enqueued7b = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("7b: the deferred notice actually enqueues (a real observed event, not assumed)", enqueued7b);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeWrite = fake.writes.slice(writesBeforeMismatch).join("");
    check("7b: an unmatched replay still fires the notice", noticeWrite.includes("[loom:prompt-mismatch]"));
    check("7b: the fallback still points at the IMMEDIATELY PRECEDING submission as the measured pattern",
      /IMMEDIATELY PRECEDING/.test(noticeWrite) && /could not be matched directly/.test(noticeWrite));
    check("7b: the fallback never asserts a cause either", !/\bbecause\b/i.test(noticeWrite));
  }

  // ===== 7c. Card 201d0d95 Q1 — manager review: `findLast`, not `find`. Loom's own `warning`-kind nudges
  // re-send byte-identical text by construction, so the SAME text can legitimately appear at more than one
  // generation in `recentWrittenTurns`. Identical text at a NON-ADJACENT earlier generation (gen 1) and the
  // immediately-preceding one (gen 3), then a replay of gen 3's text at gen 4: `find` would return the
  // OLDEST match (gen 1) and wrongly take the "unusual shape" branch; `findLast` must return gen 3 and take
  // the "IMMEDIATELY PRECEDING" branch — the correct, actual replay generation. =====
  {
    const sid = newSession("G3"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const repeated = "[loom:idle] this session appears idle — checking in"; // realistic repeated-nudge shape
    const distinct = "[loom:worker-report] worker DDDD — unrelated distinct content";
    const genFourText = "[loom:worker-report] worker EEEE — generation 4's own real report, never delivered";

    host.enqueueStdin(sid, repeated); // gen=1: repeated text, first occurrence
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: repeated });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, distinct); // gen=2: unrelated, sits between the two repeated occurrences
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: distinct });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, repeated); // gen=3: repeated text AGAIN — this is the true "immediately preceding" occurrence
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: repeated });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, genFourText); // gen=4: Loom writes genFourText, but the engine replays gen=3's text
    const writesBeforeMismatch = fake.writes.length;
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: repeated }); // byteIdentical=false
    // Same barrier as scenario 7 (manager review, card 201d0d95 — fixed-wait-negative-guard caught this
    // site's ORIGINAL fixed-duration wait too): poll for the real enqueue event, don't guess a duration.
    const enqueued7c = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("7c: the deferred notice actually enqueues (a real observed event, not assumed)", enqueued7c);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeWrite = fake.writes.slice(writesBeforeMismatch).join("");
    check("7c: findLast picks the MOST RECENT match (gen=3), not the oldest (gen=1)", /gen=3\b/.test(noticeWrite));
    check("7c: correctly takes the IMMEDIATELY PRECEDING branch, not the misleading 'unusual shape' one",
      /IMMEDIATELY PRECEDING/.test(noticeWrite) && !/not the immediately preceding one/.test(noticeWrite));
    check("7c: does NOT manufacture false counter-evidence by citing the stale gen=1 match", !/gen=1\b/.test(noticeWrite));
  }

  // ===== 8. Card 201d0d95 Q1 — NEGATIVE (positive control's other direction, mandatory per this project's
  // own standing rule): an ORDINARY, byteIdentical=true turn must produce NO notice at all — proving the
  // new surfacing logic doesn't fire on every turn regardless of correctness. This is the half most likely
  // to break while building the first (per the kickoff's own warning), since it's easy to accidentally hang
  // the new code off a broader condition than "mismatch only". =====
  {
    const sid = newSession("H"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const text = "an entirely ordinary, correctly-delivered turn";
    host.enqueueStdin(sid, text);
    const writesBeforeTurn = fake.writes.length;
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: text }); // byteIdentical=true — the mismatch-scheduling branch in host.ts is never entered
    // Manager review, card 201d0d95: this is the "coin that lands heads" case flagged by fixed-wait-negative-
    // guard — there is no POSITIVE event to poll for here, since we're proving the ABSENCE of exactly that
    // event, so a `waitUntil` barrier (as used in scenarios 7/7b/7c above) doesn't apply. Instead of guessing
    // a duration, wait for a PROVEN-sufficient, deterministic ordering fact: the ONLY thing that could
    // produce a false positive is the SAME `setTimeout(fn, 0)` the real notice uses (host.ts, scheduled
    // synchronously inside THIS hook's own handling if it were ever wrongly called) — by the time a
    // LATER-registered `setTimeout(_, 0)` resolves, any such callback is GUARANTEED to have already run,
    // since macrotasks execute FIFO. One tick is not a guess; it's the exact bound this mechanism can ever
    // need. The check reads host.getPendingEntries SYNCHRONOUSLY right after, with no further await in
    // between — the same "observe, then assert instantly" shape as the barrier above, just anchored to a
    // proven tick-count instead of an observed flag.
    // TIMING-GUARD-SAFE: sync-probe-no-macrotask — waits only for the KNOWN-required single macrotask tick
    // (see the paragraph above for why exactly one tick is provably sufficient, not assumed); the negative
    // check below runs synchronously immediately after, with no further await in between.
    await new Promise((r) => setTimeout(r, 0));
    check("8: NEGATIVE CONTROL — an ordinary byteIdentical=true turn never enqueues a prompt-mismatch notice",
      !hasPendingMismatchNotice(sid));
    host.deliverHook(sid, { hook_event_name: "Stop" }); // completes the turn and drains — queue already proven empty of any notice
    const afterTurn = fake.writes.slice(writesBeforeTurn).join("");
    check("8: and correspondingly nothing resembling the notice ever reached the pty either",
      !afterTurn.includes("[loom:prompt-mismatch]"));
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the frame-splice detector (card 7114838d) FIRES on a synthesized mismatch and names the divergence point (self-classifying via lenDelta + both tail lengths — a real splice's large tails read differently from a benign trailing artifact's tiny ones), stays SILENT on a matching pair, is correctly GATED on submitWasOutstanding (never misfires a raw human-typed turn against a stale lastPrompt), and is SELF-DIAGNOSING when the engine sends no usable prompt field (logs once per session, not once per turn). Card 201d0d95 Q1: a mismatch now SURFACES as its own pty submission to the affected session (previously LOG-ONLY) naming both the possible LOSS and the possible DUPLICATE (identifying the specific earlier generation when `recentWrittenTurns` still holds it) — and, the positive control's other, easier-to-break direction, an ordinary byteIdentical=true turn schedules no such notice at all. NOTE: this suite synthesizes every hook payload — it proves the detector's own logic, not that Claude Code actually sends `prompt` or reports it byte-identical; only the first real hook after deploy answers that."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
