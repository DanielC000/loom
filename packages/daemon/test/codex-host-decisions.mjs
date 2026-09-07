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
  isTrustDialogPrompt, trustDialogAnswer, isCodexBusy, isCodexReadyMarkerPresent, mcpServersToCodexArgs, CodexTrustDialogLock,
} = await import("../dist/pty/codex-host.js");
const {
  TRUST_DIALOG_MARKER, BUSY_STATUS_MARKER, CODEX_READY_PLACEHOLDER, hashConfigBefore, diffConfigAfterSpawn,
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

console.log(failures === 0
  ? "\n✅ ALL PASS — codex-host.ts's trust-dialog/busy-idle/ready-marker/MCP-arg decision logic is proven both ways (real markers fire, ordinary/malformed input doesn't), the MCP-arg translation stays consistent with the REAL buildMcpServers routing table, the trust-dialog lock serializes FIFO and survives a rejecting holder, and diffConfigAfterSpawn's residual disclosure (Code Review M7) correctly fires even when the expected trust-block AND something else both changed. See codex-queue-state-machine.mjs for coverage of the real stateful wiring this logic is delegated to from."
  : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
