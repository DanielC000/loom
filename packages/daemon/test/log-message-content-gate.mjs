import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 16c93a50 (owner ruling, request 0eb43216): "Opt-in verbosity — content only under an explicit env
// flag, default OFF." This suite proves the mechanism BOTH ways — a broken gate that always redacts, or
// one that always reveals, must fail here — and proves it is actually WIRED into a real diagnostic, not
// just correct in isolation.
//
// SCOPE: this card is about message CONTENT reaching the ROTATED, MULTI-TENANT daemon-output.log (the
// console.* stream scripts/daemon-supervisor.mjs tees). It is NOT about content delivered session-to-
// session (e.g. the [loom:redelivery-parked] notice's own head= — that lands in the SENDER's own engine
// transcript, a different artifact, and is out of scope here; see this card's done-report for the
// verification that test/give-up-exhausted-durable.mjs's existing content assertion is about THAT path,
// not this one, and needs no change).
//
// SITES ENUMERATED (grep `redactedExcerpt(` across src — see done-report for the search + count):
//   pty/host.ts: [prompt-mismatch] reportedAround/intendedAround, [prompt-mismatch-unmatched-remainder]
//     leadingRemainder/trailingRemainder, [pty] sanitized-nudge, [pty] missing-tag, [submit-write] head,
//     [stdin-write] head, [resume-mode] footer= (added after manager review — collapseFooter only strips
//     ANSI/whitespace, it does not isolate a footer region, so this tail is "whatever rendered last").
//   sessions/service.ts: [give-up] … PARKED head.
// Run: 1) build daemon (pnpm build from packages/daemon), 2) node test/log-message-content-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-log-content-gate-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Hermetic: this suite drives the flag itself — start from a clean unset state regardless of the host's
// own environment (a developer's shell with LOOM_LOG_MESSAGE_CONTENT=1 set for real debugging, per the
// card's own owner note, must not flip this test's "default OFF" assertions).
delete process.env.LOOM_LOG_MESSAGE_CONTENT;

const { redactedExcerpt } = await import("../dist/pty/host.js");
const { isLogMessageContentEnabled } = await import("../dist/paths.js");

try {
  // ===== (1) UNIT: default-OFF is the CODE default — unset/absent/garbage all resolve to OFF, never ON ===
  {
    delete process.env.LOOM_LOG_MESSAGE_CONTENT;
    check("(1) unset -> isLogMessageContentEnabled() is false", isLogMessageContentEnabled() === false);
    for (const garbage of ["true", "TRUE", "yes", "0", "on", ""]) {
      process.env.LOOM_LOG_MESSAGE_CONTENT = garbage;
      check(`(1) garbage value ${JSON.stringify(garbage)} -> still OFF (only the literal "1" enables it)`, isLogMessageContentEnabled() === false);
    }
    delete process.env.LOOM_LOG_MESSAGE_CONTENT;
  }

  // ===== (2) UNIT: POSITIVE CONTROL, flag OFF — redactedExcerpt never returns the raw bytes, but DOES =====
  // ===== return a stable len+hash signature (so two occurrences of the same text are still provably ======
  // ===== identical without the daemon ever writing the content itself) =====================================
  {
    delete process.env.LOOM_LOG_MESSAGE_CONTENT;
    const secretA = "the owner's actual message text, never meant for a shared multi-tenant log";
    const secretB = "a completely different payload".padEnd(secretA.length, "!");
    check("(2) fixture sanity: the two secrets are the same length (isolates hash from length as the discriminator)", secretA.length === secretB.length);
    const outA = redactedExcerpt(secretA);
    const outB = redactedExcerpt(secretB);
    check("(2) OFF: the raw content does NOT reach the returned string", !outA.includes(secretA) && !outA.includes("owner's actual message"));
    check("(2) OFF: the redaction is shaped <redacted len=N hash=XXXXXXXX>", /^<redacted len=\d+ hash=[0-9a-f]{8}>$/.test(outA));
    check("(2) OFF: the length is the excerpt's real length (a diagnostic that survives redaction)", outA.includes(`len=${secretA.length}`));
    check("(2) OFF: two DIFFERENT texts of the SAME length produce DIFFERENT hashes — the instrument actually discriminates content, not just length", outA !== outB);
    check("(2) OFF: the SAME text redacted twice is byte-identical (deterministic, so two log lines can be compared)", redactedExcerpt(secretA) === outA);
  }

  // ===== (3) UNIT: POSITIVE CONTROL, flag ON — content DOES reach the returned string, byte-identical to =====
  // ===== the pre-16c93a50 behavior (JSON.stringify(excerpt)) =============================================
  {
    process.env.LOOM_LOG_MESSAGE_CONTENT = "1";
    check("(3) ON: isLogMessageContentEnabled() is true", isLogMessageContentEnabled() === true);
    const secret = "this exact sentence must appear verbatim once the operator opts in";
    const out = redactedExcerpt(secret);
    check("(3) ON: the raw content DOES reach the returned string", out.includes(secret));
    check("(3) ON: byte-identical to the old unconditional JSON.stringify(excerpt)", out === JSON.stringify(secret));
    delete process.env.LOOM_LOG_MESSAGE_CONTENT;
  }

  // ===== (4) COVERAGE CENSUS: every call site this card's own enumeration found actually routes through ===
  // ===== redactedExcerpt — a regression guard against a future content-bearing log line skipping the gate =
  {
    const hostSrc = fs.readFileSync(new URL("../src/pty/host.ts", import.meta.url), "utf8");
    const serviceSrc = fs.readFileSync(new URL("../src/sessions/service.ts", import.meta.url), "utf8");
    const hostCalls = (hostSrc.match(/redactedExcerpt\(/g) ?? []).length - 1; // -1 for the function's own declaration line
    const serviceCalls = (serviceSrc.match(/redactedExcerpt\(/g) ?? []).length;
    // 7 call sites: the shared `around` helper (feeds BOTH reportedAround= and intendedAround=), the shared
    // `excerpt` helper (feeds BOTH leadingRemainder= and trailingRemainder=), sanitized-nudge, missing-tag,
    // submit-write head=, stdin-write head=, resume-mode footer= (added after manager review found
    // collapseFooter does not actually isolate a footer region — see done-report) — see done-report for the
    // enumerating grep + per-site anchors.
    check("(4) pty/host.ts: exactly 7 redactedExcerpt call sites", hostCalls === 7);
    check("(4) sessions/service.ts: exactly 1 redactedExcerpt call site ([give-up] PARKED head)", serviceCalls === 1);
    // Negative control on the census itself: a nonexistent function name must find ZERO call sites, proving
    // this isn't a pattern that matches everything.
    const bogusCalls = (hostSrc.match(/thisFunctionDoesNotExist\(/g) ?? []).length;
    check("(4) NEGATIVE CONTROL: a bogus function name finds 0 call sites in the same file (the census pattern discriminates)", bogusCalls === 0);
  }

  // ===== (5) END-TO-END, real site: the [prompt-mismatch] reportedAround/intendedAround excerpt, exercised =====
  // ===== through the REAL PtyHost state machine (mirrors pty-prompt-mismatch.mjs's own harness) — proves ===
  // ===== the gate is actually WIRED into production code, not just correct as an isolated function =========
  {
    const { PtyHost } = await import("../dist/pty/host.js");
    const { createSeamHost } = await import("./_seam-host-fixture.mjs");
    const host = new (createSeamHost(PtyHost))({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });

    const captureMismatchLines = (fn) => {
      const lines = [];
      const orig = console.log;
      console.log = (msg) => { if (typeof msg === "string" && msg.includes("[prompt-mismatch]")) lines.push(msg); };
      try { fn(); } finally { console.log = orig; }
      return lines;
    };
    const newSession = (name) => {
      const sid = `sess-content-gate-${name}`;
      host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
      host.deliverHook(sid, { hook_event_name: "SessionStart" });
      return sid;
    };
    // Short enough that BOTH land whole inside `around`'s own ±20/+40-char window around divergesAtChar=0
    // (reported = STRANDED+INTENDED diverges from intended = INTENDED at position 0) — this test's job is
    // to prove the GATE, not to also re-derive `around`'s own windowing math, so the fixture avoids the
    // (orthogonal, already-covered-elsewhere) case where the window itself truncates before the gate acts.
    const STRANDED = "STRANDEDSECRET1";
    const INTENDED = "INTENDEDSECRET2";

    // (5a) flag OFF (the shipped default) — the real log line must NOT carry either secret substring.
    delete process.env.LOOM_LOG_MESSAGE_CONTENT;
    const sidOff = newSession("off");
    host.enqueueStdin(sidOff, INTENDED);
    const linesOff = captureMismatchLines(() => {
      host.deliverHook(sidOff, { hook_event_name: "UserPromptSubmit", prompt: STRANDED + INTENDED });
    });
    check("(5a) setup: the mismatch fired at all", linesOff.length === 1);
    check("(5a) OFF (default): the real daemon log line does NOT contain the stranded secret", !linesOff.some((l) => l.includes(STRANDED)));
    check("(5a) OFF (default): the real daemon log line does NOT contain the intended secret", !linesOff.some((l) => l.includes(INTENDED)));
    check("(5a) OFF (default): the log line still carries redacted signatures for both sides", linesOff.some((l) => /reportedAround=<redacted len=\d+ hash=[0-9a-f]{8}>/.test(l) && /intendedAround=<redacted len=\d+ hash=[0-9a-f]{8}>/.test(l)));

    // (5b) flag ON — a FRESH session/generation (the detector's own dedupe would otherwise suppress a
    // byte-identical repeat of the same mismatch) — the real log line MUST carry the content this time.
    process.env.LOOM_LOG_MESSAGE_CONTENT = "1";
    const sidOn = newSession("on");
    host.enqueueStdin(sidOn, INTENDED);
    const linesOn = captureMismatchLines(() => {
      host.deliverHook(sidOn, { hook_event_name: "UserPromptSubmit", prompt: STRANDED + INTENDED });
    });
    check("(5b) setup: the mismatch fired at all", linesOn.length === 1);
    check("(5b) ON: the real daemon log line DOES contain the stranded secret", linesOn.some((l) => l.includes(STRANDED)));
    check("(5b) ON: the real daemon log line DOES contain the intended secret", linesOn.some((l) => l.includes(INTENDED)));
    delete process.env.LOOM_LOG_MESSAGE_CONTENT;
  }

  // ===== (6) END-TO-END, real site: [resume-mode] footer= — the manager-disputed site. `collapseFooter` =====
  // ===== does not isolate a footer region (only strips ANSI + whitespace), so this tail can carry whatever ==
  // ===== rendered just before the footer in the same repaint — proven here with a synthetic secret placed ===
  // ===== immediately before a real footer string, fed through the SAME onData path a real engine uses =======
  {
    const { PtyHost } = await import("../dist/pty/host.js");
    const { createSeamHost } = await import("./_seam-host-fixture.mjs");
    const waitUntil = async (pred, timeoutMs = 5000, intervalMs = 20) => {
      const start = Date.now();
      while (!pred()) {
        if (Date.now() - start > timeoutMs) return false;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return true;
    };

    const fakesFooter = [];
    class FooterTestPtyHost extends createSeamHost(PtyHost) {
      createPty(opts) {
        const base = super.createPty(opts);
        let dataCb = null;
        const fake = { ...base, onData: (cb) => { dataCb = cb; return { dispose() {} }; }, feed: (s) => { if (dataCb) dataCb(s); } };
        fakesFooter.push(fake);
        return fake;
      }
    }
    const hostFooter = new FooterTestPtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
    const ACCEPT_EDITS_FOOTER = "accept edits on (shift+tab to cycle)";
    const spawnNoCycle = (id) => {
      hostFooter.spawn({
        sessionId: id, cwd: tmpHome,
        // startupModeCycles:0 + no resumeModeTarget -> noCyclingConfigured, so no auto-heal Shift+Tab
        // writes complicate this scenario — it only needs ONE [resume-mode] log line to inspect.
        permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
        geometry: { cols: 120, rows: 40 }, sessionEnv: {},
      });
      return fakesFooter[fakesFooter.length - 1];
    };
    const captureResumeModeLines = () => {
      const lines = [];
      const orig = console.log;
      console.log = (...args) => {
        const line = args.map(String).join(" ");
        if (line.includes("[resume-mode]") && line.includes("footer=")) lines.push(line);
        orig(...args);
      };
      return { lines, restore: () => { console.log = orig; } };
    };

    // (6a) flag OFF (the shipped default) — the real log line must NOT carry the secret rendered just
    // before the footer in the same synthetic repaint.
    delete process.env.LOOM_LOG_MESSAGE_CONTENT;
    const SECRET_OFF = "FOOTERPRECEDINGSECRETOFF987";
    const capOff = captureResumeModeLines();
    const fOff = spawnNoCycle("sess-content-gate-footer-off");
    fOff.feed(SECRET_OFF + ACCEPT_EDITS_FOOTER); // painted before SessionStart — realistic boot ordering
    hostFooter.deliverHook("sess-content-gate-footer-off", { hook_event_name: "SessionStart", session_id: "eng-footer-off" });
    const sawOff = await waitUntil(() => capOff.lines.length >= 1);
    capOff.restore();
    check("(6a) setup: a [resume-mode] footer= line was actually captured", sawOff);
    check("(6a) OFF (default): the real daemon log line does NOT contain the secret rendered just before the footer", !capOff.lines.some((l) => l.includes(SECRET_OFF)));
    check("(6a) OFF (default): the log line still carries a redacted footer signature", capOff.lines.some((l) => /footer=<redacted len=\d+ hash=[0-9a-f]{8}>/.test(l)));

    // (6b) flag ON — a fresh session + fresh secret — the real log line MUST carry it.
    process.env.LOOM_LOG_MESSAGE_CONTENT = "1";
    const SECRET_ON = "FOOTERPRECEDINGSECRETON654";
    const capOn = captureResumeModeLines();
    const fOn = spawnNoCycle("sess-content-gate-footer-on");
    fOn.feed(SECRET_ON + ACCEPT_EDITS_FOOTER);
    hostFooter.deliverHook("sess-content-gate-footer-on", { hook_event_name: "SessionStart", session_id: "eng-footer-on" });
    const sawOn = await waitUntil(() => capOn.lines.length >= 1);
    capOn.restore();
    check("(6b) setup: a [resume-mode] footer= line was actually captured", sawOn);
    check("(6b) ON: the real daemon log line DOES contain the secret rendered just before the footer", capOn.lines.some((l) => l.includes(SECRET_ON)));
    delete process.env.LOOM_LOG_MESSAGE_CONTENT;
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — message CONTENT reaching the rotated daemon-output.log is OFF by default (unset/absent/garbage all resolve to OFF), opt-in only via LOOM_LOG_MESSAGE_CONTENT=1, proven both as an isolated function and wired into two real diagnostics ([prompt-mismatch]'s excerpt and [resume-mode]'s footer=), with length/hash signatures preserved either way."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
