// Hermetic regression test for card b9b8f8db — "a stranded kickoff is re-driven every 30s and APPENDS
// ~46KB each time — an unbounded composer runaway" (pty/host.ts submit()).
//
// ROOT CAUSE: submit()'s defensive clear-prefix (composerDirtyLen>0 && composerLen===0) backspaced the
// FULL accumulated composerDirtyLen and re-pasted the (~identical, tag-varying) body on EVERY redelivery
// cycle of a give-up'd message — and composerDirtyLen is deliberately never reset except by a genuine
// confirmation (which cannot happen in a truly wedged session), so every cycle backspaced+repasted MORE
// than the last, compounding without bound. A live incident (Platform Lead investigation, daemon-output.log)
// measured a single generation's own physical write growing 45,934 -> 91,908 -> 137,882 -> 184,967 B — 4x
// in about 2.5 minutes — before a manager's worker_stop finally ended it.
//
// THE FIX: a redelivery of an ALREADY-attempted message (`giveUpGen` set — this exact QueuedMessage object
// already failed once and is being requeued) now retries ONLY the Enter, never re-pasting the body. A
// genuinely NEW/different message (a fresh re-mint, or anything unrelated) still gets the full, original
// defensive clear+repaste — the narrowing applies only to the SAME-message redelivery case, never more
// broadly. See pty-giveup-clear.mjs/pty-giveup-clear-single-attempt.mjs/pty-giveup-requeue.mjs/
// pty-giveup-hold-until-confirmed.mjs/pty-healifstuck-clear.mjs/kickoff-giveup-exhausted.mjs/
// kickoff-giveup-remint-purge.mjs for the mechanism-level coverage this card updated; THIS file is the
// end-to-end demonstration the manager asked for directly: DoD-6's two halves, side by side.
//
// This suite proves, against the REAL PtyHost + REAL SessionService (the actual production call graph —
// PtyHost's onKickoffGiveUpExhausted -> SessionService.handleKickoffGiveUpExhausted -> re-mint via this
// SAME host's own enqueueStdin — not a stub), with a fake pty that emits STRAY output shortly after every
// Enter write (provoking GIVE-UP SUPPRESSED, not just GIVE-UP RECOVERY, mirroring the incident's own log
// mix of both branches):
//   (1) A STRANDED WORKER'S COMPOSER STOPS GROWING: over an extended run of reconcile ticks with no
//       confirming hook ever arriving, the largest single-generation physical write is BOUNDED — it never
//       exceeds the size of the largest genuinely-fresh paste (the original, or the one re-mint's own first
//       attempt) plus a small fixed overhead. It never compounds cycle over cycle the way the incident
//       measured.
//   (2) A HEALTHY WORKER'S KICKOFF STILL DELIVERS FIRST TIME: the fix is scoped to a redelivery of an
//       ALREADY-failed message — a session whose Enter confirms normally on the very first attempt is
//       completely untouched by any of this (composerDirtyLen never even becomes >0), and its kickoff lands
//       in exactly one paste, exactly like before this card. This is the branch an over-aggressive gate
//       would silently strangle if it fired on more than a genuine redelivery.
//
// RUN: pnpm build (from packages/daemon) then `node test/pty-composer-runaway-bound.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, timeoutMs = 20_000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    await sleep(10);
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-runaway-bound-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 4; // production default
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1"; // production default
const HOLD_MS = 200; // production 20_000, compressed
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_FIRST_TURN_STALE_MS = "600"; // production 30_000, compressed
process.env.LOOM_MODE_LOG_POLL_MS = "5";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

try {
  // ===================== (1) A STRANDED WORKER'S COMPOSER STOPS GROWING ========================
  {
    const fakes = [];
    const busyLog = {};
    const events = {
      onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
      onContextStats() {}, onRateLimited() {}, onExit() {},
    };
    // Stray output ~120ms after every Enter write — unrelated repaint chatter, never a real confirmation —
    // provoking GIVE-UP SUPPRESSED as well as GIVE-UP RECOVERY, mirroring the incident's own log mix.
    class StrayOutputPtyHost extends createSeamHost(PtyHost) {
      createPty(opts) {
        const base = super.createPty(opts);
        const writes = [];
        let onDataCb = null;
        const fake = {
          ...base,
          write: (d) => {
            writes.push(d);
            if (d === "\r") setTimeout(() => { if (onDataCb) onDataCb("\x1b[2K"); }, 120);
          },
          onData: (cb) => { onDataCb = cb; return { dispose() {} }; },
          writes,
        };
        fakes.push(fake);
        return fake;
      }
    }
    const host = new StrayOutputPtyHost(events);

    const db = new Db();
    const now = new Date().toISOString();
    const sfx = `${Date.now()}`;
    const proj = `rbound-proj-${sfx}`, agent = `rbound-ag-${sfx}`;
    db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
    const mgr = `rbound-mgr-${sfx}`, SID = `rbound-wkr-${sfx}`;
    const mkSession = (o) => db.insertSession({
      id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: tmpHome,
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
      worktreePath: null, branch: null,
    });
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-rbound-${sfx}` });

    // Wire the REAL production chain — the exact call graph index.ts wires, not a stub.
    const sessions = new SessionService(db, host, new OrchestrationControl());
    events.onKickoffGiveUpExhausted = (sessionId, msgId, rootMsgId, kickoffText) =>
      sessions.handleKickoffGiveUpExhausted(sessionId, msgId, rootMsgId, kickoffText);

    const KICKOFF = "orchestrate-task-runaway-bound-" + "z".repeat(2000); // stand-in for a real ~46KB kickoff, shrunk for test speed
    host.spawn({
      sessionId: SID, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.deliverHook(SID, { hook_event_name: "SessionStart" });
    const fake = fakes[fakes.length - 1];

    // Sum, PER GENERATION (the same metric the incident measured), every byte physically written to the
    // pty — matches the card's own "[pty-write] ... gen=N len=..." accounting.
    const writesByGen = new Map();
    let currentGen = 0;
    const origWrite = fake.write;
    fake.write = (d) => {
      // Track generation boundaries the same way the daemon's own log does: a fresh bracket-start with no
      // intervening bracket-end starts a new physical burst. Simplify: just re-derive from PtyHost's own
      // console.log("[pty-write] ... gen=N ...") lines instead of guessing from raw bytes.
      origWrite(d);
    };
    const genSizes = new Map();
    const realLog = console.log.bind(console);
    console.log = (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith(`[pty-write] ${SID} `)) {
        const m = /gen=(\d+) len=(\d+)/.exec(args[0]);
        if (m) {
          const gen = Number(m[1]), len = Number(m[2]);
          genSizes.set(gen, (genSizes.get(gen) ?? 0) + len);
          currentGen = Math.max(currentGen, gen);
        }
      }
      realLog(...args);
    };

    console.log(`\n--- (1) driving a genuinely-stranded worker for 15s of reconcile ticks, no confirming hook ever arrives ---`);
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000) {
      host.reconcile();
      await sleep(200);
    }
    console.log = realLog;

    const sizes = [...genSizes.values()];
    const maxGenBytes = Math.max(0, ...sizes);
    // Ordered by ACTUAL generation number (not Map insertion order, which happens to match here but
    // shouldn't be relied on) — this is the real per-generation series the incident's own growth curve
    // (45,934 -> 91,908 -> 137,882 -> 184,967 B) is shaped like: every cycle strictly bigger than the last.
    const genSeries = [...genSizes.entries()].sort((a, b) => a[0] - b[0]).map(([, len]) => len);
    console.log(`per-generation physical write sizes: ${JSON.stringify([...genSizes.entries()])}`);
    console.log(`largest single-generation write: ${maxGenBytes} B (the ORIGINAL kickoff is ${KICKOFF.length} B)`);

    // THE POSITIVE CONTROL (this check is only meaningful if it CAN fail): assert against the ORIGINAL,
    // still-unbounded formula the incident measured — backspace(priorDirty) + repaste(current), compounding
    // every cycle — to prove this specific run genuinely drove multiple redelivery cycles (not just one).
    //
    // Card 4796f999 CODE REVIEW FINDING: raised from >=3 to >=4. A run truncated to exactly 3 generations
    // (a slow/loaded host losing one cycle to this suite's own 15s wall-clock window) would otherwise PASS
    // this control while the FIX check below ALSO passes on the fully-defective (pre-b9b8f8db) code — see
    // the measured three-tree series in that check's own comment: the pre-b9b8f8db defect's own 3-generation
    // max (6237 B) clears the fix check's bound too, so a truncated run must fail LOUDLY here instead of
    // silently passing with the defect fully present.
    check("(1) POSITIVE CONTROL: this run drove at least 4 distinct generations (multiple redelivery cycles actually happened)",
      genSizes.size >= 4);

    // THE FIX ITSELF (card 9fa4eb45 — SHAPE, not magnitude): the defect (pre-b9b8f8db) is a
    // backspace-full-prior + repaste-current cycle where composerDirtyLen only ever GROWS between
    // redeliveries (it's reset solely by a genuine confirmation, which can't happen while wedged) — so its
    // per-generation series is STRICTLY INCREASING for as long as the run continues, unboundedly. A scaled
    // MAX threshold only detects that once it crosses an arbitrarily-picked multiple (see the now-demoted
    // check below and card 9fa4eb45's own history: 3x -> 4x -> 3.5x, argued over twice, and 4x once landed
    // only 2.3% above the defect's own measured asymptote — a threshold pinned to the defect it's meant to
    // catch). The fix's actual invariant is SHAPE: a give-up redelivery of the SAME already-attempted
    // message now retries Enter-only (near-zero bytes — see `isGiveUpRedelivery` in pty/host.ts submit()),
    // which breaks the compounding chain; only a genuinely NEW message (a fresh re-mint) gets a real
    // clear+repaste, and that's budget-capped to one further generation by the pre-existing, unrelated
    // chainDepth/requeue-budget mechanism (GIVE_UP_REQUEUE_LIMIT=1 at host.ts:584, GIVE_UP_REMINT_LIMIT=1
    // at sessions/service.ts:1703) before the kickoff permanently parks. So a FIXED tree's series always
    // contains at least one DROP (a reset to near-zero) somewhere in the run; the DEFECT's never does.
    //
    // Measured, all three trees, KICKOFF = 2031 B (card 9fa4eb45's own review, reproduced identically
    // across runs). Listed in VALUE ORDER, not by generation number — `submitGeneration` increments by 1
    // per submit() call (host.ts:7567) but only a generation that actually performs a physical write is
    // captured in genSizes, so the numbers that appear are sparse; the shape check below only looks at
    // consecutive VALUES in that sparse series, never at which generation numbers they came from:
    //   POST-4796f999 (this tree) [2083, 52, 4166, 6237]   max 3.07x  — DROP at position 1->2 (2083->52)
    //   PRE-4796f999 (b9b8f8db)   [2083, 52, 4166,   52]   max 2.05x  — DROPs at 1->2 and 3->4
    //   PRE-b9b8f8db (THE DEFECT) [2083, 4166, 6237, 8308] max 4.09x  — NO drop anywhere, strictly ^
    // The card's own legitimate fallback (POST-4796f999's 4166->6237 rise, position 3->4) is real and does
    // not defeat this: it's a SECOND rise, not a second DROP, and the series still contains its one drop
    // earlier (position 1->2) — the shape check only requires at least one drop across the whole run, not
    // that the run be non-increasing throughout, which is exactly why "never increases" would be the wrong
    // assertion (it would fail this correct tree at position 3->4).
    const hasDrop = genSeries.some((v, i) => i > 0 && v < genSeries[i - 1]);
    check(`(1) THE FIX (shape): the per-generation series ${JSON.stringify(genSeries)} contains at least one ` +
      `drop (a reset) — the unbounded defect's signature is a chain that only ever grows for as long as the ` +
      `run continues; a magnitude bound alone can't tell "grew past N" from "grows forever", so this checks ` +
      `the growth SHAPE directly, independent of any threshold`,
      hasDrop);

    // THE MAGNITUDE BOUND — now belt-and-braces only, NOT load-bearing on its own (card 9fa4eb45): the
    // shape check above is what actually discriminates the defect from a fix, at any threshold and at any
    // truncation length. This bound is retained as a coarse sanity ceiling (catches a regression that grows
    // unreasonably large even while still technically containing a drop) but is not trusted alone — see the
    // shape check's own comment for why a scaled max is fragile: 4x once sat only 2.3% above the defect's
    // own measured asymptote, and a wall-clock-truncated run (3 generations) can pass a magnitude bound
    // while fully defective (the defect's own first-3-gens max, 6237 B, clears an 8124 B / 4x bound) —
    // see the truncation positive-control in this card's own verification notes. 3.5x (7108.5 B) gives the
    // legitimate 3.07x fallback 12.3% headroom and the defect's 4.09x 16.9% margin. See this card's own
    // regression suite (pty-enter-only-verifies-composer-trust.mjs scenario 3) for the direct, isolated
    // proof that the single-message-no-intervening-clear case (the scenario b9b8f8db itself targets)
    // remains completely untouched: Enter-only, body written exactly once, zero backspaces.
    check(`(1) THE FIX (magnitude, belt-and-braces): the largest single-generation write (${maxGenBytes} B) stays ` +
      `well under 3.5x the kickoff body (${KICKOFF.length * 3.5} B)`,
      maxGenBytes < KICKOFF.length * 3.5);

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  }

  // ===================== (2) A HEALTHY WORKER'S KICKOFF STILL DELIVERS FIRST TIME ========================
  {
    const fakes = [];
    const busyLog = {};
    const events = {
      onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
      onContextStats() {}, onRateLimited() {}, onExit() {},
    };
    class ConfirmingPtyHost extends createSeamHost(PtyHost) {
      createPty(opts) {
        const base = super.createPty(opts);
        const writes = [];
        const fake = { ...base, write: (d) => { writes.push(d); }, writes };
        fakes.push(fake);
        return fake;
      }
    }
    const host = new ConfirmingPtyHost(events);
    const SID = "sess-healthy-first-time";
    const KICKOFF = "orchestrate-task-healthy-kickoff-" + "y".repeat(2000);
    host.spawn({
      sessionId: SID, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.deliverHook(SID, { hook_event_name: "SessionStart" });
    const fake = fakes[fakes.length - 1];
    const bodyCount = () => fake.writes.join("").split(KICKOFF).length - 1;

    await waitUntil(() => bodyCount() >= 1);
    check("(2) setup: the kickoff was written (a real paste, not just queued)", bodyCount() === 1);
    check("(2) DoD-6, the branch an over-aggressive gate would strangle: composerDirtyLen was never >0 for a "
      + "healthy first attempt — a plain, untouched paste, zero clear-prefix bytes",
      !fake.writes.some((w) => w.includes("\x7f"))); // \x7f === BACKSPACE

    // The Enter confirms IMMEDIATELY, first try — a real UserPromptSubmit/Stop pair, exactly like a healthy
    // engine that actually reads its input.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(2) THE KICKOFF DELIVERED FIRST TIME: the turn confirmed and ended normally on attempt 1",
      busyLog[SID].at(-1) === false);
    check("(2) NEVER RE-DRIVEN: exactly one physical paste of the kickoff body, ever",
      bodyCount() === 1);
    check("(2) NOTHING LEFT PENDING: a confirmed first-attempt kickoff leaves no requeue behind",
      host.getPendingEntries(SID).length === 0);

    // Advance well past every give-up/heal timing window this fix touches — must be a genuine no-op on a
    // session that already finished cleanly.
    await sleep(Math.max(VERIFY_TIMEOUT * MAX_ATTEMPTS, 600) + 200);
    host.reconcile();
    check("(2) sanity: reconcile long after a clean finish changes nothing — still exactly one paste",
      bodyCount() === 1);

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card b9b8f8db, DoD-6 both halves, end to end against the REAL PtyHost + SessionService " +
    "(the actual production call graph, not a stub): (1) a genuinely-stranded worker's composer STOPS " +
    "GROWING — driven through multiple redelivery cycles (positive-controlled: this run is proven to have " +
    "actually exercised several), the largest single-generation physical write stays bounded instead of " +
    "compounding cycle over cycle the way the live incident measured (45,934 -> 184,967 B, 4x, in ~2.5min). " +
    "(2) A healthy worker's kickoff still delivers on the first attempt — a single plain paste, zero " +
    "clear-prefix bytes, nothing left pending, completely untouched by the fix (composerDirtyLen never " +
    "becomes >0 for a session that confirms normally) — proving the narrowing doesn't strangle the branch " +
    "it was never meant to touch."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
