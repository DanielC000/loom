import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 353f6dc4 (multi-harness epic df1f94b0, Phase 1) — hermetic unit coverage for
// pty/codex-host.ts's PURE decision logic (trust-dialog detect/answer, busy/idle detection, and
// MCP-url→codex-argv translation) — the logic `pty/host.ts`'s REAL, WIRED stateful runtime
// (spawnCodexProcess/submitCodex/enqueueStdinCodex/drainCodexPending) delegates to (see
// codex-host.ts's own header for the current shape). This is NOT a real-spawn/pty test — see
// codex-queue-state-machine.mjs (a scripted fake-pty test) for coverage of the STATEFUL wiring itself.
// Every function under test here is a pure string/object transform, so a hermetic unit test is the
// right-sized check, per this project's own "hermetic, not ambient-host-dependent" testing doctrine.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-host-decisions.mjs

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const {
  isTrustDialogPrompt, trustDialogAnswer, isCodexBusy, isCodexReadyMarkerPresent, isCodexModelLoaded, mcpServersToCodexArgs, unsupportedCodexMcpServers, buildCodexResumeArgs, CodexTrustDialogLock,
  codexAsciiFold, codexCharNeedsAsciiFold, codexNfkcFold,
} = await import("../dist/pty/codex-host.js");
const {
  TRUST_DIALOG_MARKER, BUSY_STATUS_MARKER, CODEX_READY_PLACEHOLDER, CODEX_MODEL_LOADED_RE, stripAnsiCsi, normalizeCodexScreenText, hashConfigBefore, diffConfigAfterSpawn,
} = await import("../dist/pty/codex-doctrine.js");
const fs = await import("node:fs");
const path = await import("node:path");
const { mkdtempManaged } = await import("./_tmp-fixture.mjs");

// --- isTrustDialogPrompt --------------------------------------------------------------------------

check(
  "isTrustDialogPrompt: real marker text present ⇒ true (positive control)",
  isTrustDialogPrompt(`some boot chrome\n${TRUST_DIALOG_MARKER}\n1. Yes, continue\n2. No, quit`) === true,
);
check(
  "isTrustDialogPrompt: ordinary busy/ready screen text ⇒ false (negative control — proves this doesn't fire on everything)",
  isTrustDialogPrompt("Working (3s • esc to interrupt)\n> Ask Codex to do anything") === false,
);
check("isTrustDialogPrompt: empty screen ⇒ false", isTrustDialogPrompt("") === false);
check("trustDialogAnswer(): returns a non-empty keystroke sequence", typeof trustDialogAnswer() === "string" && trustDialogAnswer().length > 0);

// --- Card c0933e57: codex's CSI-cursor-forward-as-space rendering (normalizeCodexScreenText) ---------
// REAL captured bytes — NOT fabricated — extracted verbatim from the archived mechanism-A specimen
// ~/.loom/gate-output-archive/427590d2-mechA-trust-dialog-9c2ecef0.log (byte range confirmed via `od -c`;
// the identical CSI-cursor-forward rendering was also confirmed present, od -c, in the other three
// archived specimens: 7ad449f1, 9bde96e3, b21383f6). Every inter-word space in the dialog's body is
// rendered as `\x1b[1C` (CSI cursor-forward) instead of a literal space byte.
const REAL_CAPTURED_CSI_TRUST_DIALOG_BYTES = "\x1b[3;3HDo\x1b[1Cyou\x1b[1Ctrust\x1b[1Cthe\x1b[1Ccontents\x1b[1Cof\x1b[1Cthis\x1b[1Cdirectory?";
check(
  "RED PROOF (pre-fix behavior, still true of a bare `.includes()`): a raw literal-space match against the real captured bytes reads false — 0 literal-marker hits, matching the card's own measured finding across all four archived specimens",
  REAL_CAPTURED_CSI_TRUST_DIALOG_BYTES.includes(TRUST_DIALOG_MARKER) === false,
);
check(
  "FIX: normalizeCodexScreenText converts each CSI-cursor-forward into a real space, recovering the literal marker text",
  normalizeCodexScreenText(REAL_CAPTURED_CSI_TRUST_DIALOG_BYTES).includes(TRUST_DIALOG_MARKER) === true,
);
check(
  "DoD-1 (RED→GREEN against the REAL captured bytes): isTrustDialogPrompt now correctly detects the trust dialog rendered with CSI cursor-forward",
  isTrustDialogPrompt(REAL_CAPTURED_CSI_TRUST_DIALOG_BYTES) === true,
);
check(
  "DoD-1 (no regression): isTrustDialogPrompt still detects the already-working literal-space form",
  isTrustDialogPrompt(`some boot chrome\n${TRUST_DIALOG_MARKER}\n1. Yes, continue\n2. No, quit`) === true,
);
check(
  "normalizeCodexScreenText: does NOT glue adjacent words together the way a bare stripAnsiCsi would (⛔ the DoD's own explicit anti-pattern) — recovers a real space, not nothing",
  normalizeCodexScreenText("Do\x1b[1Cyou") === "Do you" && stripAnsiCsi("Do\x1b[1Cyou") === "Doyou",
);
check("normalizeCodexScreenText: ESC[C with no explicit count still means one cell forward (ECMA-48 default)", normalizeCodexScreenText("Do\x1b[Cyou") === "Do you");
check("normalizeCodexScreenText: a multi-cell cursor-forward collapses to one space under the whitespace-run rule", normalizeCodexScreenText("Do\x1b[3Cyou") === "Do you");
check("normalizeCodexScreenText: strips an unrelated CSI sequence (color/positioning) with NO replacement — only cursor-forward stands in for a space", normalizeCodexScreenText("\x1b[38;5;6mhello\x1b[m") === "hello");
check("normalizeCodexScreenText: strips an OSC sequence (e.g. the title-bar spinner) with no replacement", normalizeCodexScreenText("\x1b]0;⠠ codex\x07idle") === "idle");
check("normalizeCodexScreenText: plain text with no escapes passes through unchanged", normalizeCodexScreenText("plain text") === "plain text");
check("normalizeCodexScreenText: empty string ⇒ empty string", normalizeCodexScreenText("") === "");

// --- isCodexBusy -----------------------------------------------------------------------------------

check(
  "isCodexBusy: real busy-status-line marker present ⇒ true (positive control)",
  isCodexBusy("Working (12s • esc to interrupt)") === true,
);
check(
  "isCodexBusy: title-bar spinner glyph present ⇒ true (positive control, the OTHER busy signal)",
  isCodexBusy("\x1b]0;⠠ codex\x07") === true,
);
// The card's own landmine #2: the input placeholder is static chrome present during busy too — it must
// NEVER by itself read as busy (that's not what discriminates busy from idle) nor cause a false anything;
// this asserts isCodexBusy correctly ignores it when no real busy marker is present (idle reading).
check(
  "isCodexBusy: idle screen carrying ONLY the input placeholder (landmine #2) ⇒ false — the placeholder must never be mistaken for a busy signal",
  isCodexBusy("> Ask Codex to do anything") === false,
);
check(
  "isCodexBusy: idle screen carrying the placeholder AND a real busy marker ⇒ true — the marker still fires even alongside the placeholder (proves detection isn't accidentally placeholder-gated)",
  isCodexBusy("> Ask Codex to do anything\nWorking (1s • esc to interrupt)") === true,
);
check("isCodexBusy: empty screen ⇒ false", isCodexBusy("") === false);
check(
  "isCodexBusy regex sanity: BUSY_STATUS_MARKER itself matches the exact literal used above (proves the fixture isn't testing a stale/wrong pattern)",
  BUSY_STATUS_MARKER.test("Working (12s • esc to interrupt)") === true,
);

// --- Card c0933e57 DoD-3: sibling-marker sweep for the same CSI-cursor-forward-as-space exposure -----
// CODEX_READY_PLACEHOLDER and CODEX_MODEL_LOADED_RE: MEASURED NOT exposed in the four archived
// mechanism-A specimens (od -c confirmed literal space bytes) — see
// docs/decisions/c0933e57-codex-csi-cursor-forward-space.md. Deliberately left UNCHANGED (this project's
// own minimal-change discipline: normalize only where a real defect was confirmed). These two checks pin
// that they still work via their ORIGINAL, un-normalized match, proving this fix didn't touch them.
check(
  "DoD-3: isCodexReadyMarkerPresent is UNCHANGED by this fix — still a raw literal-space `.includes()` (measured not exposed in the archived specimens)",
  isCodexReadyMarkerPresent(`codex booted\n> ${CODEX_READY_PLACEHOLDER}\n`) === true,
);
check(
  "DoD-3: isCodexModelLoaded is UNCHANGED by this fix — still tested via stripAnsiCsi alone, not normalizeCodexScreenText (measured not exposed in the archived specimens)",
  isCodexModelLoaded("model: gpt-6-astra medium") === true,
);
// BUSY_STATUS_MARKER: UNMEASURED against a real CSI-cursor-forward rendering — no archived specimen ever
// reaches codex's busy state (mechanism A wedges at the trust dialog before any turn starts). isCodexBusy
// was hardened defensively anyway (normalizeCodexScreenText is a no-op on every already-passing case, see
// this file's own doc comment). The fixture below is SYNTHETIC — disclosed as such, not a captured
// specimen — built by substituting CSI cursor-forward for the marker's own literal inter-word spaces, to
// prove the hardening would actually work if codex ever does render this line the same way.
const SYNTHETIC_CSI_BUSY_MARKER = "Working\x1b[1C(12s\x1b[1C•\x1b[1Cesc\x1b[1Cto\x1b[1Cinterrupt)";
check(
  "DoD-3 (SYNTHETIC fixture, disclosed — no real specimen captures codex's busy state): isCodexBusy detects a busy marker rendered with CSI cursor-forward instead of literal spaces",
  isCodexBusy(SYNTHETIC_CSI_BUSY_MARKER) === true,
);
check("DoD-3 no-regression: isCodexBusy still detects the ordinary literal-space busy marker", isCodexBusy("Working (12s • esc to interrupt)") === true);
// Update-available dialog: no runtime screen-text marker/detector exists for it at all (swept via grep —
// `Update available|update_available|UPDATE_DIALOG` across packages/daemon/src returns only
// CODEX_UPDATE_CHECK_OVERRIDE_ARGS's own doc comment and an unrelated gateway/server.ts hit) — it is
// suppressed entirely via the per-invocation `-c check_for_update_on_startup=false` config override,
// never detected-and-answered from screen text, so this exposure class doesn't apply.

// --- mcpServersToCodexArgs ---------------------------------------------------------------------------

check(
  "mcpServersToCodexArgs: single http server ⇒ one -c pair with the exact url",
  JSON.stringify(mcpServersToCodexArgs({ "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/abc" } }))
    === JSON.stringify(["-c", "mcp_servers.loom-tasks.url=http://127.0.0.1:4317/mcp/abc"]),
);
check(
  "mcpServersToCodexArgs: multiple servers ⇒ one -c pair PER server, in Object.entries order",
  JSON.stringify(mcpServersToCodexArgs({
    "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/abc" },
    "loom-orchestration": { type: "http", url: "http://127.0.0.1:4317/mcp-orch/abc" },
  })) === JSON.stringify([
    "-c", "mcp_servers.loom-tasks.url=http://127.0.0.1:4317/mcp/abc",
    "-c", "mcp_servers.loom-orchestration.url=http://127.0.0.1:4317/mcp-orch/abc",
  ]),
);
check(
  "mcpServersToCodexArgs: a non-http entry (e.g. a future stdio-shaped server) is SKIPPED, never thrown or mistranslated (negative control)",
  JSON.stringify(mcpServersToCodexArgs({ "some-stdio-server": { type: "stdio", command: "foo" } })) === "[]",
);
check("mcpServersToCodexArgs: empty map ⇒ empty args", JSON.stringify(mcpServersToCodexArgs({})) === "[]");
check(
  "mcpServersToCodexArgs: malformed entry (missing url) is SKIPPED rather than emitting 'url=undefined'",
  JSON.stringify(mcpServersToCodexArgs({ broken: { type: "http" } })) === "[]",
);

// --- unsupportedCodexMcpServers (card b987f086) — companion to mcpServersToCodexArgs above: WHICH
// entries get dropped, so a real caller can report it instead of leaving the console.warn as the only
// signal. Run against the EXACT SAME inputs as the mcpServersToCodexArgs block above, so a reader can see
// the two functions agree on what "dropped" means without re-deriving it. -----------------------------

check(
  "unsupportedCodexMcpServers: single http server (nothing dropped) ⇒ empty (negative control, known-mountable input)",
  JSON.stringify(unsupportedCodexMcpServers({ "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/abc" } })) === "[]",
);
check(
  "unsupportedCodexMcpServers: a non-http entry IS reported, naming its id and real type (positive control — proves this doesn't just always return empty)",
  JSON.stringify(unsupportedCodexMcpServers({ "some-stdio-server": { type: "stdio", command: "foo" } }))
    === JSON.stringify([{ id: "some-stdio-server", type: "stdio" }]),
);
check("unsupportedCodexMcpServers: empty map ⇒ empty", JSON.stringify(unsupportedCodexMcpServers({})) === "[]");
check(
  "unsupportedCodexMcpServers: malformed entry (missing url) IS reported as dropped, type reflects what was present",
  JSON.stringify(unsupportedCodexMcpServers({ broken: { type: "http" } })) === JSON.stringify([{ id: "broken", type: "http" }]),
);
check(
  "unsupportedCodexMcpServers: mixed map ⇒ reports ONLY the non-mountable entries, not the mountable ones",
  JSON.stringify(unsupportedCodexMcpServers({
    "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/abc" },
    "playwright": { type: "stdio", command: "npx" },
    "markitdown": { type: "stdio", command: "markitdown-mcp" },
  })) === JSON.stringify([{ id: "playwright", type: "stdio" }, { id: "markitdown", type: "stdio" }]),
);

// Real integration with the SAME buildMcpServers this project's claude spawn path already uses — proves
// this translation stays byte-consistent with claude's own routing table rather than a hand-copied one.
const { buildMcpServers } = await import("../dist/pty/host.js");
const workerServers = buildMcpServers({ sessionId: "sess-1", port: 4317, role: "worker" });
const workerArgs = mcpServersToCodexArgs(workerServers);
check(
  "mcpServersToCodexArgs against a REAL buildMcpServers(role:'worker') result: mounts loom-tasks",
  workerArgs.includes("mcp_servers.loom-tasks.url=http://127.0.0.1:4317/mcp/sess-1"),
);
check(
  "mcpServersToCodexArgs against a REAL buildMcpServers(role:'worker') result: mounts loom-orchestration too (worker gets both, exactly as claude's --mcp-config does)",
  workerArgs.includes("mcp_servers.loom-orchestration.url=http://127.0.0.1:4317/mcp-orch/sess-1"),
);

// --- buildCodexResumeArgs (card c6ce2804 DoD-1) — the constructed-argv coverage that replaces the
// real-spawn regression test relocated to docs/investigations/c6ce2804-codex-resume-rollout-timing/
// after it could not observe its own claim against a real install (see that dir's findings.md). This is
// the exact deterministic surface the wiring introduced: no real spawn, no timing dependency. -----------

check(
  "buildCodexResumeArgs: resumeId set, no fork ⇒ leads with the resume subcommand + the exact id",
  JSON.stringify(buildCodexResumeArgs({ resumeId: "abc-123" })) === JSON.stringify(["resume", "abc-123"]),
);
check(
  "buildCodexResumeArgs: no resumeId ⇒ a fresh spawn (empty prefix) — negative control",
  JSON.stringify(buildCodexResumeArgs({})) === "[]",
);
check(
  "buildCodexResumeArgs: resumeId present but fork:true ⇒ STILL a fresh spawn (empty prefix) — codex has no --fork-session equivalent, so a fork must never reuse resume (see this function's own doc for why: two ptys racing writes into one rollout file)",
  JSON.stringify(buildCodexResumeArgs({ resumeId: "abc-123", fork: true })) === "[]",
);
check(
  "buildCodexResumeArgs: fork:false with a resumeId behaves exactly like fork omitted (explicit-false isn't a different case)",
  JSON.stringify(buildCodexResumeArgs({ resumeId: "abc-123", fork: false })) === JSON.stringify(["resume", "abc-123"]),
);

// --- CodexTrustDialogLock ----------------------------------------------------------------------------

{
  // No real elapsed-time wait here — the first holder's release is gated on a manually-resolved promise
  // (`releaseFirst`), so "the second holder hasn't started yet" is observed by CHECKING `order` at a
  // precise, deterministic point (right after queueing both, before releasing the first), never by racing
  // a timer against the lock's own scheduling.
  const lock = new CodexTrustDialogLock();
  const order = [];
  let releaseFirst;
  const gate = new Promise((r) => { releaseFirst = r; });
  const p1 = lock.withLock(async () => {
    order.push("1-start");
    await gate;
    order.push("1-end");
    return "r1";
  });
  const p2 = lock.withLock(async () => {
    order.push("2-start");
    return "r2";
  });
  // Let the microtask queue settle so both withLock calls have run their synchronous prefix (the "1-start"
  // push) — this awaits a REAL, already-scheduled microtask, not a fixed clock-time wait.
  await Promise.resolve();
  await Promise.resolve();
  check("CodexTrustDialogLock: the second holder has NOT started while the first is still held (observed BEFORE releasing the first, not inferred from a timer)", JSON.stringify(order) === JSON.stringify(["1-start"]));
  releaseFirst();
  const [r1, r2] = await Promise.all([p1, p2]);
  check("CodexTrustDialogLock: second holder starts only AFTER the first releases (FIFO serialization)", JSON.stringify(order) === JSON.stringify(["1-start", "1-end", "2-start"]));
  check("CodexTrustDialogLock: each withLock call returns its OWN fn's result, not a shared/mixed one", r1 === "r1" && r2 === "r2");
}
{
  // A rejecting holder must not permanently wedge the lock for a later queued caller.
  const lock = new CodexTrustDialogLock();
  let threw = false;
  try {
    await lock.withLock(async () => { throw new Error("boom"); });
  } catch { threw = true; }
  const after = await lock.withLock(async () => "still-works");
  check("CodexTrustDialogLock: a rejected holder propagates its own error to its own caller", threw === true);
  check("CodexTrustDialogLock: a rejected holder does NOT wedge the lock — a later caller still runs (negative control on the deadlock risk)", after === "still-works");
}

// --- isCodexReadyMarkerPresent (Code Review C1 fix) ------------------------------------------------

check(
  "isCodexReadyMarkerPresent: the real placeholder text present ⇒ true (positive control)",
  isCodexReadyMarkerPresent(`codex booted\n> ${CODEX_READY_PLACEHOLDER}\n`) === true,
);
check("isCodexReadyMarkerPresent: ordinary boot chrome with no placeholder ⇒ false (negative control)", isCodexReadyMarkerPresent("still booting...\n") === false);
check("isCodexReadyMarkerPresent: empty screen ⇒ false", isCodexReadyMarkerPresent("") === false);

// --- isCodexModelLoaded (card 448f1b4a fix) ---------------------------------------------------------
// DoD-5's REQUIRED fixture, BYTE-EXACT — not the card body's quoted markdown rendering (which is ANSI-
// stripped by whatever logged/rendered it into the card), but the RAW bytes from the actual gate-output
// capture (`~/.loom/gate-output/43cd9ec1-*.log`, line 1078), extracted via `JSON.stringify` on the parsed
// line and cross-checked with `od -c` against the log file directly. This distinction is load-bearing: a
// manager review caught that the earlier ANSI-free version of this fixture could not have exercised the
// real defect at all (see below) — a synthetic/rendered approximation is not evidence the predicate is
// correct against what it actually reads (`live.screenScan`, raw pty bytes, ANSI included).
const REAL_CAPTURED_FALSE_READY_RAW_BYTES = "      │ model:     [3mloading[23m   [38;5;6m[22m/model[m[2m to change                   │[22m[K[2m\r      ›[22m [2mAsk Codex to do anything[22m[K\r";
check(
  "DoD-5 REQUIRED NEGATIVE CONTROL (byte-exact): the REAL captured raw bytes (op 43cd9ec1) — isCodexReadyMarkerPresent ALONE reads true...",
  isCodexReadyMarkerPresent(REAL_CAPTURED_FALSE_READY_RAW_BYTES) === true,
);
// 🔴 THE BUG THIS FILE CAUGHT (manager review, pre-merge): codex styles the "model:" line's VALUE with its
// own CSI span, separate from the label (`model:` + spaces + `\x1b[3m` + `loading` + `\x1b[23m`). Tested
// RAW (no ANSI strip), CODEX_MODEL_LOADED_RE's `\s+` consumes the plain spaces and lands exactly on the
// `\x1b` byte; the `(?!loading\b)` lookahead then SUCCEEDS (the literal text "loading" does not start at
// an ESC byte), and `\S+` (ESC is not whitespace) swallows the escape sequence itself as its match. This
// assertion proves that failure directly — a RED proof of why stripAnsiCsi is required, not decorative.
check(
  "RED PROOF: CODEX_MODEL_LOADED_RE tested RAW (no ANSI strip) against the real bytes WRONGLY reads true — the ESC-wrapped 'loading' token satisfies \\S+ via the escape sequence itself, not real content",
  CODEX_MODEL_LOADED_RE.test(REAL_CAPTURED_FALSE_READY_RAW_BYTES) === true,
);
check(
  "FIX: stripAnsiCsi's output no longer contains the value-wrapping escapes, so the SAME pattern now correctly reads false",
  CODEX_MODEL_LOADED_RE.test(stripAnsiCsi(REAL_CAPTURED_FALSE_READY_RAW_BYTES)) === false,
);
check(
  "DoD-5: isCodexModelLoaded (the real production function, ANSI-strip included) correctly reads false against the byte-exact real specimen — proving the marker alone is NOT a readiness signal (the defect this card fixes), against what the predicate ACTUALLY reads, not a rendering of it",
  isCodexModelLoaded(REAL_CAPTURED_FALSE_READY_RAW_BYTES) === false,
);
// The probe's own documented State-3 real-ready text (findings.md:81) — the header once the model has
// actually finished resolving. ⚠️ No raw byte capture of this state was available at fix time (disclosed
// gap — the real-codex window that produced it was already closed): this is the probe's own quoted prose,
// not a byte-verified specimen the way the false-ready fixture above is. isCodexModelLoaded's ANSI strip is
// unconditional specifically so correctness here does not depend on this byte shape being known.
const PROBE_STATE_3_REAL_READY = "model: gpt-6-astra medium\n• Starting MCP servers (1/1): cua_repl (2s • esc to interrupt)\n› Ask Codex to do anything";
check(
  "isCodexModelLoaded: the probe's own documented real-ready text (State 3, model actually resolved) ⇒ true (positive control)",
  isCodexModelLoaded(PROBE_STATE_3_REAL_READY) === true,
);
check(
  "isCodexModelLoaded: ordinary boot chrome with no 'model:' line at all ⇒ false (negative control — proves this doesn't fire on everything)",
  isCodexModelLoaded("still booting...\n") === false,
);
check("isCodexModelLoaded: empty screen ⇒ false", isCodexModelLoaded("") === false);
// Accumulation-safety (this function's own doc): once the "loading" text is in the buffer and a REAL model
// name is later appended too (the shape spawnCodexProcess's own accumulating screenScan actually produces
// — old bytes are never removed, only trimmed from the front once capped), the function must correctly
// read true — a stale "loading" fragment earlier in the buffer must never suppress a real, later positive
// match (unlike a NEGATED "loading is absent" check would — see this constant's own doc for why that shape
// was rejected). Uses the byte-exact false-ready specimen, so this also proves accumulation-safety holds
// with real ANSI bytes present, not just a stripped approximation.
check(
  "isCodexModelLoaded: a buffer carrying BOTH the earlier (byte-exact, ANSI-laden) 'loading' text AND a later real model name ⇒ true (accumulation-safety — the POSITIVE-match design doesn't get suppressed by stale 'loading' bytes still sitting earlier in the same buffer)",
  isCodexModelLoaded(`${REAL_CAPTURED_FALSE_READY_RAW_BYTES}\n${PROBE_STATE_3_REAL_READY}`) === true,
);
check(
  "CODEX_MODEL_LOADED_RE regex sanity: matches the exact literal used above (proves the fixture isn't testing a stale/wrong pattern)",
  CODEX_MODEL_LOADED_RE.test(PROBE_STATE_3_REAL_READY) === true,
);
check(
  "stripAnsiCsi sanity: strips a real CSI sequence but leaves plain text untouched (positive + negative control on the helper itself)",
  stripAnsiCsi("\x1b[3mloading\x1b[23m") === "loading" && stripAnsiCsi("plain text, no escapes") === "plain text, no escapes",
);

// --- diffConfigAfterSpawn (Code Review M7 fix: residual disclosure was INVERTED) --------------------
// Hermetic via a scratch CODEX_HOME (codexConfigPath/realCodexHome both read process.env.CODEX_HOME
// fresh on every call — see their own doc — so setting it here, never touching the real ~/.codex, is
// genuine isolation, not a workaround).
{
  const scratchHome = mkdtempManaged("loom-codex-cfgdiff-");
  process.env.CODEX_HOME = scratchHome;
  const configPath = path.join(scratchHome, "config.toml");
  const cwd = "/fake/worktree/one";

  // (a) ONLY the expected trust-block was added — the common case. residual must be [].
  fs.writeFileSync(configPath, "[some_other_section]\nfoo = 1\n");
  const before = hashConfigBefore();
  fs.appendFileSync(configPath, `\n[projects.'${cwd}']\ntrust_level = "trusted"\n`);
  const onlyExpected = diffConfigAfterSpawn(before, cwd);
  check("diffConfigAfterSpawn (only expected block added): changed=true", onlyExpected.changed === true);
  check("diffConfigAfterSpawn (only expected block added): removable finds the real block", onlyExpected.removable.length === 1);
  check("diffConfigAfterSpawn (only expected block added): residual is EMPTY (nothing else changed)", onlyExpected.residual.length === 0);

  // (b) RED-PROOF SHAPE (the actual M7 bug): the expected block AND something else both changed. The
  // pre-fix code reported residual:[] here unconditionally whenever removable was non-empty — silently
  // dropping the disclosure obligation. The fix must report a residual.
  fs.writeFileSync(configPath, "[some_other_section]\nfoo = 1\n");
  const before2 = hashConfigBefore();
  fs.appendFileSync(configPath, `\n[projects.'${cwd}']\ntrust_level = "trusted"\n[tui]\nmodel_availability_nux = 3\n`);
  const both = diffConfigAfterSpawn(before2, cwd);
  check("diffConfigAfterSpawn (expected block + an UNRELATED change): changed=true", both.changed === true);
  check("diffConfigAfterSpawn (expected block + an UNRELATED change): removable still finds the real block", both.removable.length === 1);
  check("M7 FIX: diffConfigAfterSpawn (expected block + an UNRELATED change) DISCLOSES the residual instead of silently reporting none", both.residual.length === 1);

  // (c) no matching block at all — a totally different, unexpected change (unaffected by this fix; a
  // pre-existing-and-correct case, checked so the fix didn't regress it).
  fs.writeFileSync(configPath, "[some_other_section]\nfoo = 1\n");
  const before3 = hashConfigBefore();
  fs.appendFileSync(configPath, "\n[projects.'/some/other/path']\ntrust_level = \"trusted\"\n");
  const noMatch = diffConfigAfterSpawn(before3, cwd);
  check("diffConfigAfterSpawn (no matching block, unrelated change only): removable is empty", noMatch.removable.length === 0);
  check("diffConfigAfterSpawn (no matching block, unrelated change only): residual is disclosed", noMatch.residual.length === 1);

  // (d) genuinely unchanged — changed:false, never a false residual.
  const before4 = hashConfigBefore();
  const unchanged = diffConfigAfterSpawn(before4, cwd);
  check("diffConfigAfterSpawn (nothing changed): changed=false with no removable/residual", unchanged.changed === false && unchanged.removable.length === 0 && unchanged.residual.length === 0);

  delete process.env.CODEX_HOME;
}

// --- codexCharNeedsAsciiFold / codexAsciiFold (card 0e83c855 round 4) --------------------------------
// Hermetic, hardcoded-expected coverage of the FOLD BOUNDARY itself — the real-spawn test
// (codex-prompt-ascii-fold-real-spawn.mjs) proves the wiring (submitCodex actually calls this, codex
// actually receives the result); this proves the PURE predicate/transform is exactly what it claims,
// against literal expected strings, never self-referentially computed.
{
  // POLARITY 1 — the measured drop class folds (curated + generic fallback + variation-selector elision).
  check("codexCharNeedsAsciiFold: em dash U+2014 (measured-dropping, 3-byte BMP, Pd) ⇒ true", codexCharNeedsAsciiFold(0x2014) === true);
  check("codexCharNeedsAsciiFold: no-entry U+26D4 (measured-dropping, EAW=Wide — falsifies the EAW theory) ⇒ true", codexCharNeedsAsciiFold(0x26d4) === true);
  check("codexCharNeedsAsciiFold: NBSP U+00A0 (measured-dropping, 2-byte, Neutral — falsifies both prior theories) ⇒ true", codexCharNeedsAsciiFold(0x00a0) === true);
  check("codexCharNeedsAsciiFold: plus-minus U+00B1 (measured-dropping, 2-byte — falsifies byte-length theory) ⇒ true", codexCharNeedsAsciiFold(0x00b1) === true);
  check("codexCharNeedsAsciiFold: arabic-indic digit U+0660 (measured-dropping, a NUMBER category, not just punctuation/symbol) ⇒ true", codexCharNeedsAsciiFold(0x0660) === true);
  check("codexAsciiFold: em dash folds to the curated '--'", codexAsciiFold("run — date") === "run -- date");
  check("codexAsciiFold: en dash folds to the curated '-'", codexAsciiFold("p.1–2") === "p.1-2");
  check("codexAsciiFold: warning sign folds to the curated '[!]'", codexAsciiFold("⚠ caution") === "[!] caution");
  check("codexAsciiFold: no-entry folds to the curated '[X]'", codexAsciiFold("stop ⛔ now") === "stop [X] now");
  check("codexAsciiFold: rightwards arrow folds to the curated '->'", codexAsciiFold("a → b") === "a -> b");
  check("codexAsciiFold: warning sign + VS16 (the emoji-presentation pair) folds to '[!]' with NO trailing placeholder for the elided selector", codexAsciiFold("⚠️ caution") === "[!] caution");
  check("codexAsciiFold: an UNMAPPED dropping codepoint (section sign, not in the curated table) falls back to a visible '?', never silently vanishes", codexAsciiFold("a§b") === "a?b");
  check("codexAsciiFold: a run of unmapped dropping codepoints (section/degree/plus-minus — none curated) each get their OWN '?' (never merged/collapsed into one)", codexAsciiFold("§°±") === "???");

  // POLARITY 2 — letters (any script) and astral codepoints survive completely UNTOUCHED, regardless of
  // category or the OLD byte-length/EAW theories' predictions.
  check("codexCharNeedsAsciiFold: e-acute U+00E9 (a LETTER, EAW=Ambiguous — this is the exact case that falsified the EAW theory) ⇒ false", codexCharNeedsAsciiFold(0x00e9) === false);
  check("codexCharNeedsAsciiFold: CJK U+4E2D (a LETTER, 3-byte BMP — falsifies the byte-length theory) ⇒ false", codexCharNeedsAsciiFold(0x4e2d) === false);
  check("codexCharNeedsAsciiFold: Cyrillic U+0430 (a LETTER) ⇒ false", codexCharNeedsAsciiFold(0x0430) === false);
  check("codexCharNeedsAsciiFold: Greek U+03B1 (a LETTER) ⇒ false", codexCharNeedsAsciiFold(0x03b1) === false);
  check("codexCharNeedsAsciiFold: astral emoji U+1F534 (red circle, category So — NOT a letter, but astral always survives) ⇒ false", codexCharNeedsAsciiFold(0x1f534) === false);
  check("codexCharNeedsAsciiFold: ASCII '!' U+0021 (out of scope entirely, never consulted for real ASCII text, but must read false if it were) ⇒ false", codexCharNeedsAsciiFold(0x0021) === false);
  check("codexAsciiFold: Cyrillic text passes through completely byte-identical", codexAsciiFold("привет") === "привет");
  check("codexAsciiFold: CJK text passes through completely byte-identical", codexAsciiFold("中文") === "中文");
  check("codexAsciiFold: astral emoji passes through completely byte-identical (surrogate pair intact, not split)", codexAsciiFold("🔴 red 📌 pin") === "🔴 red 📌 pin");
  check("codexAsciiFold: pure ASCII text is returned byte-identical (the early-return fast path)", codexAsciiFold("plain ascii, nothing to fold (1 2 3)") === "plain ascii, nothing to fold (1 2 3)");

  // MIXED — the realistic case: a real message carries all of dropping-class, letter, and astral
  // codepoints together; only the dropping class changes.
  const MIXED = "⭐⭐ → done ⛔ stop — wait café 🔴 中文";
  const MIXED_EXPECTED = "[*][*] -> done [X] stop -- wait café 🔴 中文";
  check("codexAsciiFold: mixed doctrine-shaped text folds ONLY the dropping-class codepoints, leaving é/astral/CJK untouched", codexAsciiFold(MIXED) === MIXED_EXPECTED);

  // POLARITY 3 — Code Review Major [2]: the `?` fallback is correct for VISIBLE dropping content, wrong
  // for the invisible/whitespace subclass. Every assertion here checks what the codepoint folds TO, not
  // merely that codexCharNeedsAsciiFold reports it as dropping (that alone is how NBSP's missing "folds
  // to a plain space, not '?'" behavior slipped past review the first time).
  check("codexAsciiFold: NBSP U+00A0 folds to a PLAIN SPACE, never '?' — 'see the board' must never become 'see the?board'", codexAsciiFold("see the board") === "see the board");
  check("codexAsciiFold: ideographic space U+3000 also folds to a plain space", codexAsciiFold("a　b") === "a b");
  check("codexAsciiFold: narrow no-break space U+202F folds to a plain space", codexAsciiFold("a b") === "a b");
  check("codexAsciiFold: soft hyphen U+00AD elides to NOTHING (no independent content, not a visible '?')", codexAsciiFold("co­op") === "coop");
  check("codexAsciiFold: ZWSP U+200B elides to NOTHING", codexAsciiFold("a​b") === "ab");
  check("codexAsciiFold: BOM U+FEFF elides to NOTHING", codexAsciiFold("a﻿b") === "ab");
  check("codexAsciiFold: LRM U+200E elides to NOTHING", codexAsciiFold("a‎b") === "ab");
  check("codexAsciiFold: a ZWJ emoji sequence (man+ZWJ+laptop, both halves astral) elides the joiner, joining the two survivors directly — NOT split by a '?'", codexAsciiFold("\u{1F468}‍\u{1F4BB}") === "\u{1F468}\u{1F4BB}");
  check("codexAsciiFold: a longer ZWJ sequence (family emoji, three astral codepoints + two joiners) elides BOTH joiners", codexAsciiFold("\u{1F468}‍\u{1F469}‍\u{1F466}") === "\u{1F468}\u{1F469}\u{1F466}");
  check("codexAsciiFold: rainbow flag (astral flag + VS16 + ZWJ + astral rainbow) elides VS16 AND the joiner, leaving both survivors adjacent", codexAsciiFold("\u{1F3F3}️‍\u{1F308}") === "\u{1F3F3}\u{1F308}");
  check("codexAsciiFold: a BARE combining accent (no letter to attach to) still folds to a visible '?' — Default_Ignorable_Code_Point does NOT catch combining marks (verified false for U+0301 in node)", codexAsciiFold("é") === "e?");
  check("codexAsciiFold: NEGATIVE CONTROL — em dash (real, visible content) must NEVER fold to a plain space", codexAsciiFold("run—date") !== "run date" && codexAsciiFold("run—date") === "run--date");
  check("codexAsciiFold: NEGATIVE CONTROL — a curated symbol immediately after an elided ZWJ/VS16 still shows its OWN substitute, proving elision and curated-fold compose cleanly (not just each in isolation)", codexAsciiFold("⚠️—x") === "[!]--x");

  // Known, disclosed limit (Code Review [2]'s own direction: "state that limit in the doc" — this is the
  // test half of that): an abugida's dependent vowel-sign is a COMBINING MARK, not a \p{L} letter, so it
  // still falls to the generic '?' fallback — deliberately, since it carries real phonetic content the
  // way a bare accent does. Devanagari "कि" (KA + vowel sign I) — the base consonant is \p{L} and
  // survives; the vowel sign is Mn and folds to '?'.
  check("codexAsciiFold: KNOWN LIMIT — a Devanagari base consonant (a LETTER) survives untouched", codexAsciiFold("कि").startsWith("क"));
  check("codexAsciiFold: KNOWN LIMIT — the dependent vowel sign after it (a combining MARK, not a letter) folds to '?', losing the vowel — disclosed in codexCharNeedsAsciiFold's own doc, not silently accepted", codexAsciiFold("कि") === "क?");

  // --- card 7cbb3298: box-drawing curated entries + the NFKC tier -----------------------------------
  // Each assertion checks what the codepoint folds TO, not merely that it needs folding — the same
  // discipline POLARITY 3 above states, restated here because it is exactly the gap ("needsFold===true
  // but nobody checked the output") that let NBSP->'?' slip past review on the parent card.

  // Box-drawing: a `tree`/table/ASCII-diagram specimen folds to a legible ASCII approximation, not a wall
  // of '?'.
  check("codexAsciiFold: a box-drawing tree fragment folds every glyph to a curated ASCII substitute, never '?'", codexAsciiFold("┌─┬─┐\n├─┼─┤\n└─┴─┘") === "+-+-+\n+-+-+\n+-+-+");
  check("codexAsciiFold: bare horizontal/vertical box-drawing lines fold to '-'/'|'", codexAsciiFold("─│") === "-|");

  // NFKC tier, exercised through the full pipeline: an UNCURATED codepoint that NFKC happens to normalize
  // to pure ASCII now recovers real text instead of falling to '?'.
  check("codexAsciiFold: fullwidth digit '１' (uncurated) recovers via NFKC to '1'", codexAsciiFold("１") === "1");
  check("codexAsciiFold: superscript '²' (uncurated) recovers via NFKC to '2'", codexAsciiFold("v²") === "v2");
  check("codexAsciiFold: numero sign '№' (uncurated) recovers via NFKC to the two-character 'No'", codexAsciiFold("№4") === "No4");

  // NFKC tier — the "does not over-reach" positive control the DoD asks for: every specimen that must
  // stay '?' does so because codexNfkcFold ITSELF returns null for it (not merely because the curated map
  // happens to intercept it first — em dash is a separate case, checked next).
  check("codexNfkcFold: section sign '§' does not decompose under NFKC ⇒ null (still falls to '?')", codexNfkcFold("§") === null);
  check("codexNfkcFold: degree sign '°' does not decompose under NFKC ⇒ null (still falls to '?')", codexNfkcFold("°") === null);
  check("codexNfkcFold: em dash '—' does not decompose under NFKC ⇒ null — the curated map handles it FIRST in the real pipeline, but the tier itself must not silently over-reach on it either", codexNfkcFold("—") === null);
  check("codexNfkcFold: less-than-or-equal '≤' does not decompose under NFKC ⇒ null (still falls to '?')", codexNfkcFold("≤") === null);
  check("codexNfkcFold: arabic-indic digit U+0660 does not decompose to an ASCII digit under NFKC ⇒ null (still falls to '?')", codexNfkcFold("٠") === null);
  check("codexAsciiFold: an uncurated codepoint whose NFKC tier returns null (section sign) still falls all the way through to the visible '?', end to end", codexAsciiFold("a§b") === "a?b");

  // MANAGER REVIEW FOLLOW-UP: the guard regex is `+` (one-or-more), not `*` (zero-or-more), so an
  // empty-string `normalize("NFKC")` result is REJECTED (falls through to null/'?') rather than returned
  // as-is — which would otherwise vanish silently past the `??` at the call site (`""` is not nullish).
  // Swept the full reachable population (14,358 BMP codepoints above U+007F, non-letter/ignorable/
  // whitespace) and found none that NFKC-normalizes to "" — so this is currently unreachable in practice —
  // but the regex itself is asserted here directly, by monkey-patching String.prototype.normalize to force
  // exactly that hypothetical, so this is a real regression test of the `+` fix, not just a restatement of
  // the sweep's unreachability finding.
  {
    const originalNormalize = String.prototype.normalize;
    String.prototype.normalize = function () { return ""; };
    let forcedResult;
    try {
      forcedResult = codexNfkcFold("x");
    } finally {
      String.prototype.normalize = originalNormalize;
    }
    check("codexNfkcFold: STRUCTURAL GUARD — an empty NFKC result (forced via a patched normalize()) returns null, never '' — proves the regex is '+' not '*'; under the old '*' this would have returned '' and the caller's '??' would have let it through, silently dropping the character", forcedResult === null);
  }

  // Byte-identical guarantee (DoD-3): none of the above changes anything for text with nothing to fold.
  check("codexAsciiFold: pure ASCII text carrying digits/punctuation the NFKC tier could theoretically touch is still returned byte-identical via the early-return fast path", codexAsciiFold("v2 No4, a=1 (ok)") === "v2 No4, a=1 (ok)");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — codex-host.ts's trust-dialog/busy-idle/ready-marker/model-loaded/MCP-arg decision logic is proven both ways (real markers fire, ordinary/malformed input doesn't); isCodexModelLoaded (card 448f1b4a) correctly reads false against the BYTE-EXACT real false-ready specimen (raw ANSI included, from the actual gate-output capture, not a stripped rendering) even though isCodexReadyMarkerPresent alone reads true against it, stays accumulation-safe against stale 'loading' bytes, and a RED proof confirms CODEX_MODEL_LOADED_RE tested WITHOUT stripAnsiCsi wrongly reads true against those same real bytes (the escape-swallowing bug a manager review caught before merge); the MCP-arg translation stays consistent with the REAL buildMcpServers routing table, the trust-dialog lock serializes FIFO and survives a rejecting holder, and diffConfigAfterSpawn's residual disclosure (Code Review M7) correctly fires even when the expected trust-block AND something else both changed; and (card 0e83c855 round 4, Code Review round 1 Major [2] fix included) codexAsciiFold/codexCharNeedsAsciiFold's measured letter/astral boundary is pinned across THREE polarities, every assertion checking what a codepoint folds TO rather than merely that it needs folding — the visible drop class folds to curated substitutions or a generic '?' fallback; Default_Ignorable_Code_Point codepoints (variation selectors, ZWJ including inside real multi-codepoint emoji sequences, ZWSP, soft hyphen, BOM, LRM) elide to nothing; White_Space codepoints (NBSP and friends) fold to a plain space rather than corrupting running text with a stray '?'; a bare combining mark still folds to '?' as a disclosed, deliberate limit (verified NOT swept into the elision set); and any Unicode letter (Latin/Cyrillic/Greek/CJK) or astral codepoint passes through completely byte-identical, including the exact specimens that falsified the prior byte-length and East-Asian-Width theories. See codex-queue-state-machine.mjs for coverage of the real stateful wiring this logic is delegated to from (including the WIRING assertion itself — that submitCodex actually calls this, not just that the pure function is correct in isolation), and codex-prompt-ascii-fold-real-spawn.mjs for the real-spawn proof that a real codex process actually receives the folded result. Card 7cbb3298 raises the substitution floor above the parent's bare '?': box-drawing (U+2500 block) now folds to a curated ASCII line/corner approximation instead of a wall of '?', and an uncurated drop-class codepoint gets one more chance via an NFKC-normalize-then-require-pure-ASCII tier (codexNfkcFold) before falling to '?' — recovering fullwidth digits, superscripts, and '№' for free while section sign/degree/em dash/<=/arabic-indic digits are proven (both via the isolated tier function and end to end) to correctly keep falling through, since none of them decompose to ASCII under NFKC."
  : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
