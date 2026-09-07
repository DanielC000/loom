import { TRUST_DIALOG_MARKER, TRUST_DIALOG_ANSWER, BUSY_STATUS_MARKER, BUSY_TITLE_SPINNER_RE, CODEX_READY_PLACEHOLDER, CODEX_MODEL_LOADED_RE, stripAnsiCsi } from "./codex-doctrine.js";

/**
 * Multi-harness epic (df1f94b0) Phase 1, card 353f6dc4: the PURE, testable decision logic for the codex
 * stateful runtime — trust-dialog detect/answer, busy/idle detection, kickoff-ready detection, and
 * MCP-url→codex-argv translation.
 *
 * ⚠️ HISTORY, READ BEFORE EXTENDING THIS FILE: lead ruling #3 originally approved wiring this INTO
 * `pty/host.ts` via a `spawnCodexProcess` method that builds a minimal `Live`-shaped entry in the SAME
 * `this.live` map. Building that entry turned out to require either (a) populating ~60 required `Live`
 * fields (composer-drift/give-up/mismatch-detection bookkeeping — Maps, Sets, arrays of structured
 * records, each with real invariants read/written across ~8,000 lines) with sentinel values, or (b)
 * making those fields optional on `Live`, which cascades into every one of the many internal call sites
 * that reads them without an `undefined` guard. BOTH exceeded the card's own cap ("pty/host.ts edits are
 * capped at the minimum dispatch hunk; if that minimum grows beyond a small hunk, STOP and report") — this
 * was reported up rather than built unilaterally. **Lead ruling #5 superseded ruling #3's shape**: a codex
 * session now lives in its OWN, separate `CodexLive`/`liveCodex` map (`pty/host.ts`, see that interface's
 * own doc), and `PtyHost#spawnCodexProcess`/`submitCodex`/`enqueueStdinCodex`/`drainCodexPending`/
 * `stopCodex`/`interruptForRedirectCodex` are the REAL, WIRED stateful runtime — built and real-spawn
 * tested against an actual installed codex CLI. This file ships ONLY the pure decision logic those
 * methods delegate to (proven by direct unit tests, `test/codex-host-decisions.mjs`, plus the scripted
 * fake-pty queue/turn-state-machine test, `test/codex-queue-state-machine.mjs`) — it holds no state of its
 * own and is never itself what a real session's `Live`/`CodexLive` entry points at.
 */

/** True iff `screen` (a raw pty-output frame, or any accumulated buffer of one) contains the literal,
 *  undocumented first-use-per-directory trust dialog (`codex-doctrine.ts#TRUST_DIALOG_MARKER`) — checked
 *  BEFORE ever writing a real prompt, per the card's own landmine #1. */
export function isTrustDialogPrompt(screen: string): boolean {
  return screen.includes(TRUST_DIALOG_MARKER);
}

/** The keystroke sequence to write when {@link isTrustDialogPrompt} is true — accepts the highlighted
 *  "1. Yes, continue" option (see `codex-doctrine.ts#TRUST_DIALOG_ANSWER`'s own doc for why this is Enter
 *  on the default option, not a submitted prompt). */
export function trustDialogAnswer(): string {
  return TRUST_DIALOG_ANSWER;
}

/** True iff `screen` shows codex actively working — the status-line marker OR the title-bar spinner
 *  (`codex-doctrine.ts#BUSY_STATUS_MARKER`/`BUSY_TITLE_SPINNER_RE`). Idle is this function's ABSENCE from
 *  the LATEST frame, never the input-placeholder's presence (card's landmine #2 — the placeholder is
 *  static chrome shown during busy too). Callers must re-evaluate this on every fresh frame, not cache a
 *  stale `true`. */
export function isCodexBusy(screen: string): boolean {
  return BUSY_STATUS_MARKER.test(screen) || BUSY_TITLE_SPINNER_RE.test(screen);
}

/**
 * Code Review C1 fix: has codex rendered its main TUI at least once since boot (past the trust dialog, if
 * any, or straight to ready when the directory was already trusted)? Checked against the SAME rolling,
 * multi-chunk `screen` buffer trust-dialog detection uses (a one-time "has this text appeared at all"
 * question, correctly answered by accumulation — unlike {@link isCodexBusy}, which is an ONGOING
 * true/false state and must never be asked this way, see that function's own doc).
 *
 * ⚠️ CARD 448f1b4a: this function ALONE answers a WEAKER question than "is codex ready for a submit," and
 * being a safe one-time latch does not change that. `CODEX_READY_PLACEHOLDER`'s own doc names the two
 * DISTINCT traps its text sits in — this function is correctly built to be immune to ONE of them (State 4:
 * the placeholder is present during busy too, "landmine #2" — never re-evaluated as an ongoing idle
 * signal, so that trap cannot fire here) but says NOTHING about the OTHER (State 1: the SAME placeholder
 * also renders in the very first boot frame while the header still reads `model: loading`). A real merge
 * gate (op 43cd9ec1) captured exactly that: this function alone returned true while codex was still
 * genuinely loading, and a submit landed on it. See {@link isCodexModelLoaded}'s own doc for the
 * complementary check that closes State 1 — `pty/host.ts#spawnCodexProcess`'s onData handler combines
 * BOTH of these with `!live.trustDialogPending` into the full boot-readiness composite (`live.bootReady`)
 * that gates the one-time kickoff delivery AND every other submit — never this function alone.
 */
export function isCodexReadyMarkerPresent(screen: string): boolean {
  return screen.includes(CODEX_READY_PLACEHOLDER);
}

/**
 * Card 448f1b4a fix: has codex's header finished resolving its model — i.e. is it NOT still showing the
 * transient "model: loading" boot-skeleton text (probe findings.md State 1 vs State 3; see
 * {@link CODEX_MODEL_LOADED_RE}'s own doc for why this must be a POSITIVE match, not a negated one, to
 * stay safe against the accumulating scan buffer both this and {@link isCodexReadyMarkerPresent} read).
 * `isCodexReadyMarkerPresent` ALONE is not a readiness signal — a real merge gate (op 43cd9ec1) captured
 * it rendering true while this function would have returned false, and the harness submitted into that
 * gap. `pty/host.ts#spawnCodexProcess`'s onData handler combines this with `isCodexReadyMarkerPresent` and
 * `!live.trustDialogPending` into the full boot-readiness composite (`live.bootReady`) that
 * `enqueueStdinCodex`/`drainCodexPending` now structurally gate every submit on — see that method's own
 * doc for the full state machine.
 *
 * 🔴 `screen` is stripped via {@link stripAnsiCsi} BEFORE testing — never tested raw. Confirmed against
 * gate `43cd9ec1`'s own real captured bytes (`stripAnsiCsi`'s own doc has the `od -c` verification): codex
 * styles the `model:` line's VALUE token with its own CSI span, separate from the label, and the UNSTRIPPED
 * pattern demonstrably swallows that escape sequence as part of its own `\S+` match — returning TRUE while
 * the model is still genuinely loading, i.e. silently reintroducing this exact card's own defect through
 * the fix meant to close it. This is not a hypothetical: it was reproduced against the real bytes before
 * this strip was added. See `codex-queue-state-machine.mjs`'s own ANSI-bearing fixture for the regression
 * guard.
 */
export function isCodexModelLoaded(screen: string): boolean {
  return CODEX_MODEL_LOADED_RE.test(stripAnsiCsi(screen));
}

/**
 * Translate an already-built `mcpServers` map (the SAME shape `pty/host.ts#buildMcpServers` returns for
 * claude's `--mcp-config`) into codex's per-invocation `-c mcp_servers.<id>.url=<url>` argv pairs —
 * measured TRANSIENT (never touches `config.toml`), see the parity matrix's "MCP wiring" section for the
 * real-pty-driven evidence this shape is reachable. Deliberately takes the ALREADY-RESOLVED map rather
 * than re-deriving role→server routing itself, so there is exactly ONE place (`buildMcpServers`) that
 * decides which servers a given role mounts — this can never drift from claude's own routing table.
 * Only `{type:"http", url}` entries are translated (codex has no stdio-server concept here); any other
 * shape is skipped rather than guessed at. `id` is codex-config-key-safe as long as the caller's server
 * ids are (LOOM_TASKS_SERVER_ID/LOOM_ORCHESTRATION_SERVER_ID/etc. are all plain `[a-z-]+` literals).
 */
export function mcpServersToCodexArgs(mcpServers: Record<string, unknown>): string[] {
  const args: string[] = [];
  for (const [id, entry] of Object.entries(mcpServers)) {
    if (!entry || typeof entry !== "object") continue;
    const { type, url } = entry as { type?: unknown; url?: unknown };
    if (type !== "http" || typeof url !== "string" || !url) continue;
    args.push("-c", `mcp_servers.${id}.url=${url}`);
  }
  return args;
}

/**
 * In-process mutex serializing codex's first-use-per-directory trust-dialog window (parity matrix's
 * "CODEX_HOME" section: every codex worker on a host shares ONE real `~/.codex/config.toml`, so two
 * concurrent fresh spawns answering the dialog at the same instant could race its config write). Bounded
 * to THIS process only — no cross-process/daemon-restart durability, no lockfile protocol; a daemon
 * restart mid-window is not covered (disclosed limitation, not an oversight). A single, module-level
 * instance is intentional: the race is over the ONE shared `config.toml`, not per-session.
 */
export class CodexTrustDialogLock {
  private chain: Promise<void> = Promise.resolve();

  /** Run `fn` once every earlier-queued holder has released — FIFO, never re-entrant (a caller holding
   *  the lock must not call `withLock` again from inside `fn`, or it will deadlock against itself). */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const runAfter = this.chain.then(fn, fn);
    // Keep the chain alive regardless of fn's outcome (a rejection must not permanently wedge the lock
    // for every later queued caller) — swallow here, the real result/error still flows to THIS caller's
    // own returned promise via `runAfter`.
    this.chain = runAfter.then(() => undefined, () => undefined);
    return runAfter;
  }
}

/** The single, process-wide lock instance — see {@link CodexTrustDialogLock}'s own doc for why one shared
 *  instance (not per-session) is correct here. */
export const codexTrustDialogLock = new CodexTrustDialogLock();
