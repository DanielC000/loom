// Regression guard for card 49b382d9 (SECURITY): submitted text used to reach the pty with NO ESC/C0/C1
// stripping at all (only `sanitizeLoneSurrogates`, gated to `kind:"warning"`) before being wrapped in
// Claude's bracketed paste (`\x1b[200~ … \x1b[201~`). A message containing a literal `\x1b[201~` ended
// the paste early and the remainder landed as raw keystrokes in the recipient's TUI — exactly the class
// of host access `@decision 710a34fa`'s loopback-only host-shell rule exists to deny.
//
// Round 1 of this fix stripped at the top of the PUBLIC `enqueueStdin` only. Code Review caught a
// CRITICAL false negative: a fresh session's KICKOFF (`live.startupPrompt`) is delivered by
// `scheduleKickoffGuarantee` via a DIRECT `submit()` call that never goes through `enqueueStdin` at all —
// and since kickoff text includes project memory ANY agent can write via `memory_write`, an unstripped
// kickoff is a privilege-escalation vector (a restricted worker planting keystrokes that run in the next
// manager's kickoff). The SAME gap reaches rate-limit replay (`resumeAfterRateLimit`, direct `submit()`
// of `live.lastPrompt`) and give-up requeue (a re-queued origin entry's own `.text`, never re-stripped).
//
// THE FIX (round 2): the strip moved INTO `submit()`/`submitCodex()` themselves — the one place EVERY
// write path converges (immediate, drainPending, kickoff, rate-limit replay, give-up requeue) — plus a
// defense-in-depth strip of `opts.startupPrompt` at `spawn()`, before it ever seeds
// `live.lastPrompt`/`live.startupPrompt`. `enqueueStdin`'s own top-level strip was REMOVED (redundant now
// that `submit()` is authoritative) — ONE helper (`stripEscapeAndControlChars`), not two competing copies.
//
// PROVES:
//  (A) `host.enqueueStdin` called directly with `kind:"agent"` (the vulnerable kind) strips ESC/C0/C1 from
//      the text that actually reaches the pty, while `\t \n \r` survive untouched.
//  (B) same for `kind:"warning"`.
//  (C) the REAL worker-report production funnel (`SessionService.workerReport` → `enqueueDurableMessage`
//      → `enqueueStdin`) delivers a manager-bound report with its `needs` field stripped — this is the
//      literal "worker→manager reports" path the card names.
//  (D) the composer-shaped call (`source:"human", kind:"agent"`, mirroring `POST /api/sessions/:id/input`)
//      is stripped identically.
//  (E) `/ws/term`'s raw path (`host.writeStdin`) is a DIFFERENT, non-`enqueueStdin` method and is NOT
//      touched by this fix — a human's real raw keystrokes (including a real ESC) still land byte-for-byte.
//  (F) the strip covers the codex dispatch too — a codex-harness session's inbound text is stripped
//      identically, not just claude's.
//  (G) THE CRITICAL FINDING: a fresh spawn's malicious `startupPrompt` — the kickoff — is stripped by the
//      time `scheduleKickoffGuarantee`'s direct `submit()` call actually writes it, even though this path
//      never touches `enqueueStdin`.
//  (H) rate-limit replay (`resumeAfterRateLimit`, direct `submit()` of `live.lastPrompt`) strips a
//      maliciously-set `live.lastPrompt`, even though this path never touches `enqueueStdin` either.
//  (I) give-up requeue: a `QueuedMessage` sitting in `live.pending` with a raw malicious `.text` (exactly
//      what a requeued give-up origin entry looks like) is stripped once `drainPending` actually submits
//      it — proving `submit()` strips regardless of how the entry arrived in the queue.
//
// RUN (no daemon needed): node test/pty-submit-esc-c0-strip.mjs
//   Requires the daemon built first (reads ../dist/{db,pty/host,sessions/service,orchestration/control}.js):
//   from packages/daemon run `pnpm build`.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-escstrip-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Fast footer/mode polling for scenario (G)'s kickoff delivery — this fake pty never renders a real
// footer, so shrink the poll interval (module-load-time constants — must be set BEFORE importing
// host.js) rather than waiting out the ~4s default ceiling. Mirrors worker-kickoff-guarantee.mjs's own
// choices.
process.env.LOOM_MODE_LOG_POLL_MS = "10";
process.env.LOOM_RESUME_MODE_POLL_MS = "10";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
const fakeCodexPtys = new Map();
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
  // Mirrors codex-submit-chunked-write.mjs's own fully-scripted fake codex pty (no real process): a lone
  // `write()`-tracking pty with `push()` for the test to drive `onData`.
  createCodexPty(opts) {
    let onDataCb = null;
    let onExitCb = null;
    const writes = [];
    const fake = {
      pid: 7171, write: (d) => { writes.push(d); },
      onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
      onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
      kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
      resize() {}, push: (text) => onDataCb?.(text), writes,
    };
    fakeCodexPtys.set(opts.sessionId, fake);
    return fake;
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// ---- malicious payload construction: one instance of every stripped byte class, plus the three that
// must survive (\t \n \r), plus the exact attack shape (a literal bracketed-paste terminator embedded
// mid-body) ----
const ESC = "\x1b", BEL = "\x07", NUL = "\x00", VT = "\x0b", FF = "\x0c", US = "\x1f";
const C1_LOW = "\u0080", C1_HIGH = "\u009f";
const TAB = "\t", NL = "\n", CR = "\r";
function buildMalicious(tag) {
  return `A${tag}${ESC}[201~ESCAPED${BEL}B${NUL}C${VT}D${FF}E${US}F${C1_LOW}G${C1_HIGH}H${TAB}I${NL}J${CR}K`;
}
function expectedClean(tag) {
  return `A${tag}[201~ESCAPEDBCDEFGH${TAB}I${NL}J${CR}K`;
}
function containsRawEscOrC0C1(s) {
  // Same byte classes the fix strips (excluding \t\n\r) — used to assert NONE of them reached the pty.
  return /[\x00-\x08\x0B\x0C\x0E-\x1F\x80-\x9F]/.test(s);
}

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const db = new Db();
const proj = `escstrip-proj-${sfx}`, agent = `escstrip-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null,
});

const sessions = new SessionService(db, host, new OrchestrationControl());

function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { written: () => fake.writes.join(""), fake };
}

// Extracts the payload written between the LAST bracket-start and the FOLLOWING bracket-end `write()`
// CALL — operating on the fake's own per-call `writes` ARRAY, never a joined/`indexOf`-scanned string.
// This is load-bearing, not cosmetic: `writeChunked` issues the paste markers and the submitted text as
// SEPARATE, discrete `pty.write()` calls, so a structural marker is an array entry that EXACTLY EQUALS
// PASTE_START/PASTE_END — never a substring match. Pre-fix (unsanitized text), the malicious payload's
// OWN embedded `\x1b[201~` lands inside the content call, never as its own call, so it can never spoof a
// structural marker here — unlike a naive `joined.indexOf(PASTE_END, ...)` scan, which would find that
// EMBEDDED literal terminator instead of the real one and silently under-report the truncation this test
// exists to catch (measured: the naive scan falsely PASSED a "no raw ESC/C0/C1 in payload" check pre-fix,
// because it happened to stop scanning exactly at the embedded fake terminator).
function extractLastPastePayload(writes) {
  const startAt = writes.lastIndexOf(PASTE_START);
  if (startAt === -1) return null;
  const endAt = writes.indexOf(PASTE_END, startAt + 1);
  if (endAt === -1) return null;
  return writes.slice(startAt + 1, endAt).join("");
}

try {
  // ===================== (A) direct enqueueStdin, kind:"agent" =====================
  {
    const recipient = `escstrip-a-recip-${sfx}`;
    mkSession({ id: recipient, role: "worker" });
    const { fake } = spawnReady(recipient);
    await sleep(150);

    const malicious = buildMalicious("agentkind");
    const r = host.enqueueStdin(recipient, malicious, "system", undefined, undefined, "agent");
    check("(A) setup: delivered immediately (idle session)", r.delivered === true);
    // No wait needed: writeChunked's first (and, for this short payload, only) chunk writes SYNCHRONOUSLY
    // inside the enqueueStdin() call above — the bracket-start/chunk/bracket-end writes are already in
    // `fake.writes` by the time enqueueStdin returns (verified against the actual write-log ordering).

    const payload = extractLastPastePayload(fake.writes);
    check("(A) setup: a paste payload was actually captured", payload !== null);
    check("(A) the delivered payload is stripped to the expected clean text", payload === expectedClean("agentkind"));
    check("(A) no raw ESC/C0/C1 byte anywhere in the delivered payload", !containsRawEscOrC0C1(payload ?? "\x1b"));
    check("(A) \\t \\n \\r survived the strip", payload != null && payload.includes(`H${TAB}I`) && payload.includes(`I${NL}J`) && payload.includes(`J${CR}K`));
  }

  // ===================== (B) direct enqueueStdin, kind:"warning" =====================
  {
    const recipient = `escstrip-b-recip-${sfx}`;
    mkSession({ id: recipient, role: "manager" });
    const { fake } = spawnReady(recipient);
    await sleep(150);

    const malicious = `[loom:test-warning] ${buildMalicious("warnkind")}`;
    const r = host.enqueueStdin(recipient, malicious, "system", undefined, undefined, "warning");
    check("(B) setup: delivered immediately (idle session)", r.delivered === true);
    // Synchronous write, same as (A) — no wait needed before reading fake.writes.

    const payload = extractLastPastePayload(fake.writes);
    check("(B) setup: a paste payload was actually captured", payload !== null);
    check("(B) the delivered warning-kind payload is ALSO stripped, same as agent-kind", payload === `[loom:test-warning] ${expectedClean("warnkind")}`);
  }

  // ===================== (C) the REAL worker→manager report funnel (SessionService.workerReport) =====================
  {
    const mgr = `escstrip-c-mgr-${sfx}`, wkr = `escstrip-c-wkr-${sfx}`, tk = `escstrip-c-tk-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: tk });
    const { fake } = spawnReady(mgr);
    await sleep(150);

    const maliciousNeeds = buildMalicious("workerreport");
    const res = await sessions.workerReport(wkr, { status: "blocked", summary: "blocked on a decision", needs: maliciousNeeds });
    check("(C) setup: the report was delivered to the manager", res.deliveryStatus === "delivered-live" || res.deliveryStatus === "queued");
    // workerReport's own manager-bound enqueueDurableMessage->enqueueStdin call already completed
    // (and wrote synchronously, same as (A)) by the time the awaited `workerReport` promise resolves.

    const payload = extractLastPastePayload(fake.writes);
    check("(C) setup: a paste payload was actually captured", payload !== null);
    check("(C) setup: the manager's pty received a paste containing the report", (payload ?? "").includes("blocked on a decision"));
    check("(C) no raw ESC/C0/C1 byte reached the manager's pty from the worker's `needs` field", !containsRawEscOrC0C1(payload ?? "\x1b"));
    check("(C) the report's stripped `needs` text (bracketed-paste terminator neutralized to literal text) landed", (payload ?? "").includes(expectedClean("workerreport")));
  }

  // ===================== (D) composer-shaped call (source:"human", mirrors POST /api/sessions/:id/input) =====================
  {
    const recipient = `escstrip-d-recip-${sfx}`;
    mkSession({ id: recipient, role: "manager" });
    const { fake } = spawnReady(recipient);
    await sleep(150);

    const malicious = buildMalicious("composer");
    const r = host.enqueueStdin(recipient, malicious, "human", undefined, undefined, "agent", undefined, malicious, undefined, "composer-sentinel");
    check("(D) setup: delivered immediately (idle session)", r.delivered === true);
    // Synchronous write, same as (A) — no wait needed before reading fake.writes.

    const payload = extractLastPastePayload(fake.writes);
    check("(D) the composer-shaped inbound payload is stripped", payload === expectedClean("composer"));
  }

  // ===================== (E) /ws/term's raw path (writeStdin) is a DIFFERENT method and is untouched =====================
  {
    const recipient = `escstrip-e-recip-${sfx}`;
    mkSession({ id: recipient, role: "manager" });
    const { fake } = spawnReady(recipient);
    await sleep(150);

    const before = fake.writes.length;
    const rawKeystrokes = `hello${ESC}[1;5C world`; // a real Ctrl-Right arrow-key escape, typed raw
    host.writeStdin(recipient, rawKeystrokes);
    const newWrites = fake.writes.slice(before).join("");
    check("(E) writeStdin (/ws/term) passes raw bytes through UNTOUCHED — ESC survives", newWrites.includes(`hello${ESC}[1;5C world`));
  }

  // ===================== (F) codex-harness session: the strip runs BEFORE the codex dispatch too =====================
  {
    const recipient = `escstrip-f-recip-${sfx}`;
    mkSession({ id: recipient, role: "worker" });
    host.spawn({
      sessionId: recipient, cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex",
    });
    const fakeCodex = fakeCodexPtys.get(recipient);
    fakeCodex.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
    await waitUntil(() => host.liveCodex.get(recipient)?.bootReady === true, { label: "(F) codex boot readiness latched" });

    const malicious = buildMalicious("codex");
    const r = host.enqueueStdin(recipient, malicious, "system", undefined, undefined, "agent");
    check("(F) setup: delivered immediately (codex idle at enqueue time)", r.delivered === true);
    await waitUntil(() => host.liveCodex.get(recipient)?.enterPending === false, { label: "(F) codex turn's own Enter write happened" });

    const codexPayload = fakeCodex.writes.filter((w) => w !== "\r").join("");
    check("(F) the codex-dispatched payload is stripped identically to the claude path", codexPayload === expectedClean("codex"));
    check("(F) no raw ESC/C0/C1 byte reached the codex pty", !containsRawEscOrC0C1(codexPayload));
  }

  // ===================== (G) THE CRITICAL FINDING: a fresh spawn's malicious startupPrompt (kickoff) =====================
  // scheduleKickoffGuarantee delivers live.startupPrompt via a DIRECT submit() call that never touches
  // enqueueStdin — this is the exact gap Code Review found round 1 of this fix missed.
  {
    const recipient = `escstrip-g-recip-${sfx}`;
    mkSession({ id: recipient, role: "worker" });
    const malicious = buildMalicious("kickoff");
    host.spawn({
      sessionId: recipient, cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {}, startupPrompt: malicious,
    });
    const fake = fakes[fakes.length - 1];
    host.deliverHook(recipient, { hook_event_name: "SessionStart" });

    await waitUntil(() => extractLastPastePayload(fake.writes) !== null, { label: "(G) kickoff paste payload captured", timeoutMs: 10_000 });
    const payload = extractLastPastePayload(fake.writes);
    check("(G) the kickoff payload is stripped to the expected clean text", payload === expectedClean("kickoff"));
    check("(G) no raw ESC/C0/C1 byte anywhere in the delivered kickoff", !containsRawEscOrC0C1(payload ?? "\x1b"));
  }

  // ===================== (H) rate-limit replay strips a maliciously-set live.lastPrompt =====================
  // resumeAfterRateLimit replays live.lastPrompt via a DIRECT submit() call — also never touches
  // enqueueStdin. Sets live.lastPrompt directly (simulating a stored, pre-strip-shaped value) to prove
  // submit() strips regardless of what was already stored, not just what a caller happens to pass fresh.
  {
    const recipient = `escstrip-h-recip-${sfx}`;
    mkSession({ id: recipient, role: "manager" });
    const { fake } = spawnReady(recipient);
    await sleep(150);

    const malicious = buildMalicious("ratelimit");
    const live = host.live.get(recipient);
    live.lastPrompt = malicious;
    live.rateLimited = true;
    live.busy = false;
    live.stopping = false;
    live.drainHeld = false;

    const resumed = host.resumeAfterRateLimit(recipient);
    check("(H) setup: resumeAfterRateLimit reports it resumed", resumed === true);

    const payload = extractLastPastePayload(fake.writes);
    check("(H) setup: a paste payload was actually captured", payload !== null);
    check("(H) the rate-limit replay payload is stripped", payload === expectedClean("ratelimit"));
  }

  // ===================== (I) give-up requeue: a pending entry's raw .text is stripped when drained =====================
  // requeueGiveUpOrigin puts the ORIGINAL QueuedMessage(s) back onto live.pending, unstripped — this
  // simulates exactly that shape (bypassing the give-up timing machinery, which is covered elsewhere)
  // and proves drainPending -> submit() strips it regardless of how it arrived in the queue.
  {
    const recipient = `escstrip-i-recip-${sfx}`;
    mkSession({ id: recipient, role: "worker" });
    const { fake } = spawnReady(recipient);
    await sleep(150);

    const malicious = buildMalicious("giveuprequeue");
    const live = host.live.get(recipient);
    const id = "escstrip-i-msgid";
    live.pending.push({ id, text: malicious, source: "system", kind: "agent", logicalId: id, giveUpGen: 1, giveUpRequeues: 1 });
    check("(I) setup: the malicious entry sits in live.pending, unstripped", live.pending[0].text === malicious);

    host.reconcile();
    await waitUntil(() => extractLastPastePayload(fake.writes) !== null, { label: "(I) requeued paste payload captured", timeoutMs: 10_000 });
    const payload = extractLastPastePayload(fake.writes);
    // `.includes()`, not exact equality: a giveUpGen-tagged entry drains through joinSubmittedText's own
    // age-annotation framing (same reason scenario (C) above also uses `.includes()`) — the assertion that
    // matters is that the CLEANED body text survives intact inside whatever framing wraps it.
    check("(I) the drained give-up-requeue-shaped payload is stripped", (payload ?? "").includes(expectedClean("giveuprequeue")));
    check("(I) no raw ESC/C0/C1 byte anywhere in the drained payload", !containsRawEscOrC0C1(payload ?? "\x1b"));
  }

  db.close();
} finally {
  for (const fake of fakes) { try { fake.kill(); } catch { /* ignore */ } }
  for (const fake of fakeCodexPtys.values()) { try { fake.kill(); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — submit()/submitCodex() strip ESC/C0/C1 once, at the single point EVERY write path converges on (enqueueStdin's immediate/drain paths, the kickoff's direct submit(), rate-limit replay's direct submit(), and give-up requeue), while /ws/term's raw writeStdin path stays untouched (card 49b382d9)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
