import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import chokidar, { type FSWatcher } from "chokidar";
import { resolveExecutable } from "./resolve-bin.js";

/**
 * HarnessAdapter seam (multi-harness epic df1f94b0, Phase 1, card 353f6dc4): the codex adapter's
 * ownership of the SMALLER codex-specific literals — the default binary name, the real (NEVER
 * per-worker-overridden — see the trust-dialog note below) `CODEX_HOME`, the first-use-per-directory
 * trust-dialog literal text, and the md5-diff-disclose safety net around the one config-mutating side
 * effect answering that dialog causes. Mirrors `pty/claude-doctrine.ts`'s role for the claude adapter.
 */

export const CODEX_BINARY_NAME = "codex";

/**
 * 🔴 LOAD-BEARING, EMPIRICALLY VERIFIED (not inferred from docs): every Codex spawn uses the REAL,
 * unmodified `~/.codex` — NEVER a per-worker `CODEX_HOME` override. Measured directly on this host:
 * `codex login status` against the real profile reports "Logged in using ChatGPT" (positive control —
 * the check CAN report positive); the SAME command with `CODEX_HOME` pointed at a fresh temp dir reports
 * "Not logged in" and creates no auth material there, PLUS a separate warning that Codex refuses to
 * create helper binaries under a temp-dir `CODEX_HOME` at all. Codex resolves `auth.json` under
 * `CODEX_HOME`, and copying/reading that file is explicitly forbidden by this card — so there is no safe
 * way to isolate a worker's Codex profile the way `browserTesting`'s Playwright or a claude worktree's
 * own `.claude` settings are isolated. This is a genuine, disclosed limitation (see the parity matrix):
 * every concurrent Codex worker on a host shares ONE real `~/.codex/config.toml` + `sessions/` tree.
 */
export function realCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function codexConfigPath(): string {
  return path.join(realCodexHome(), "config.toml");
}

/**
 * The literal, undocumented first-use-per-directory trust confirmation (probe card `a7d74718`,
 * empirically reproduced, NOT optional, fires BEFORE any real prompt can be written). Match this
 * substring against raw pty output BEFORE ever writing real prompt text — a naive submit collides with
 * this menu and can silently select "2. No, quit" (reproduced: the probe's own worst-case finding).
 */
export const TRUST_DIALOG_MARKER = "Do you trust the contents of this directory?";

/** The keystroke sequence that answers the trust dialog with "1. Yes, continue" (menu-selection Enter,
 *  not a submitted prompt — Codex's own TUI treats bare Enter on this screen as accepting the
 *  highlighted/default option, confirmed by the probe: `"1"` then `\r`). */
export const TRUST_DIALOG_ANSWER = "1\r";

/**
 * The real, on-screen busy signal (probe card `a7d74718`, State 4/State 5): the status line
 * `Working (Ns • esc to interrupt)`. ⛔ NEVER key idle detection off the input-placeholder text
 * (`Ask Codex to do anything`) — it is static UI chrome present during busy too (the probe's own
 * false-positive: a naive placeholder-based idle read fired a real mid-turn Ctrl+C interrupt while the
 * model was still genuinely working). Idle = this pattern's ABSENCE from the latest frame, not the
 * placeholder's presence.
 */
export const BUSY_STATUS_MARKER = /Working \(\d+s.*esc to interrupt\)/;

/** The OSC-0 terminal-title spinner glyph the probe found as an alternate, arguably more reliable busy
 *  signal (a single regex-friendly line, independent of screen-content scraping): a braille spinner
 *  character prepended to the title while busy, absent once idle. */
export const BUSY_TITLE_SPINNER_RE = /\x1b\]0;[⠀-⣿]/;

/**
 * The static input-box placeholder (landmine #2's own "false positive" text — ⛔ NEVER use this to
 * conclude CURRENT idle state; it is present during busy too, see `BUSY_STATUS_MARKER`'s own doc).
 * Reused here for a DIFFERENT, narrower, one-time question: "has codex rendered its main TUI at least
 * ONCE since boot" (i.e. boot has passed whatever screen — the trust dialog or straight to ready —
 * comes before it), which the real-spawn test (`test/codex-stateful-runtime-real-spawn.mjs`) already uses
 * as its own boot-complete signal. Checked ONCE (latched, never re-evaluated as an ongoing state) by
 * `codex-host.ts#isCodexReadyMarkerPresent` to gate the one-time kickoff delivery (card 353f6dc4's C1
 * fix) — never used to decide busy/idle on an ongoing basis, which is the one thing landmine #2 forbids.
 */
export const CODEX_READY_PLACEHOLDER = "Ask Codex to do anything";

const md5 = (buf: Buffer | string): string => createHash("md5").update(buf).digest("hex");

/**
 * Code Review M7 fix support: collapse runs of blank lines into one before hashing, so a legitimate
 * trust-dialog answer's own block INSERTION — which necessarily leaves a blank-line separator behind once
 * `diffConfigAfterSpawn`'s `blockRe` strips the block itself back out — never registers as a "residual"
 * change on its own. Hashed on BOTH sides (here, and in `diffConfigAfterSpawn`'s `afterHash`/residual
 * comparison) so `before`/`after`/the post-removal residual candidate are always compared apples-to-apples;
 * a REAL content change (a different key, a different value, e.g. the disclosed `[tui.model_availability_
 * nux]` counter) still changes the normalized text and is still caught — this only absorbs pure blank-line
 * churn around the one block this function knows how to remove.
 */
function normalizeConfigText(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\n{2,}/g, "\n");
}

/** Hash `config.toml`'s current bytes (or a stable sentinel if it doesn't exist yet), NORMALIZED (see
 *  {@link normalizeConfigText}). Call BEFORE spawning a Codex pty that might answer the trust dialog for
 *  real — see {@link diffConfigAfterSpawn}. */
export function hashConfigBefore(): string {
  try { return md5(normalizeConfigText(fs.readFileSync(codexConfigPath(), "utf8"))); } catch { return "ENOENT"; }
}

/**
 * The automated form of the probe's manual md5-before/diff-after/disclose discipline (card `a7d74718`'s
 * own remediation) — built into the spawn code itself rather than left as a one-off human/worker
 * checklist item, per this card's own hard constraint ("md5 it before any run, diff after, disclose
 * anything you cannot undo"). Compares the current `config.toml` bytes against `before`; if unchanged,
 * returns `{changed:false}`. If changed, extracts every added `[projects.'<path>']` block whose path
 * exactly matches `expectedProjectPath` (the worktree cwd that spawn just trusted — the ONLY block a
 * legitimate trust-dialog answer for THIS spawn should have added) and reports them as `removable`; any
 * OTHER delta (a different project path, or a change outside `[projects.*]` entirely, e.g. the disclosed
 * `[tui.model_availability_nux]` usage counter) is reported as `residual` — content Loom did not cause
 * and must never attempt to strip (the probe's own disclosed, unremovable residue). Never throws.
 */
export interface ConfigDiffResult {
  changed: boolean;
  /** Line ranges (as raw text blocks) safe to remove — an EXACT `[projects.'<expectedProjectPath>']`
   *  block this spawn's own trust-dialog answer added, and nothing else. */
  removable: string[];
  /** Anything else that changed — must be disclosed, never silently stripped. */
  residual: string[];
}
export function diffConfigAfterSpawn(before: string, expectedProjectPath: string): ConfigDiffResult {
  let after: string;
  try { after = fs.readFileSync(codexConfigPath(), "utf8"); } catch { after = ""; }
  const afterHash = after ? md5(normalizeConfigText(after)) : "ENOENT";
  if (afterHash === before) return { changed: false, removable: [], residual: [] };

  // The caller only holds the BEFORE hash (see hashConfigBefore), not the pre-image text, so a real line
  // diff isn't possible here. Instead, scan
  // the CURRENT file for [projects.'<expectedProjectPath>'] blocks — the shape Codex is confirmed to
  // write on a real trust-dialog answer (probe card a7d74718) — and treat everything else that differs
  // from a byte-identical file as residual-only (nothing removable can be identified without a pre-image).
  const escaped = expectedProjectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`^\\[projects\\.'${escaped}'\\][^\\[]*`, "gmi");
  const removable = after.match(blockRe) ?? [];
  const residualCandidate = removable.length ? after.replace(blockRe, "") : after;
  // Code Review M7: the residual verdict must be driven by whether `residualCandidate` (what's LEFT after
  // removing the expected block) still differs from `before` — NOT by `removable.length` alone. The prior
  // logic unconditionally reported `residual: []` whenever the expected block was found, even if SOMETHING
  // ELSE also changed alongside it (e.g. the disclosed `[tui.model_availability_nux]` counter) — silently
  // dropping exactly the disclosure this function exists to guarantee. Comparing NORMALIZED hashes (never
  // the raw text) matches `before`'s own shape (a hash, not a pre-image) and absorbs the blank-line
  // separator a block insertion necessarily leaves behind once stripped back out (see
  // normalizeConfigText's own doc) — a real content change still differs post-normalization.
  const residualHash = md5(normalizeConfigText(residualCandidate));
  return {
    changed: true,
    removable,
    // residual is reported as a single opaque marker (never the full config, which can carry other
    // projects'/the owner's own real paths) — callers disclose ITS PRESENCE, not its content.
    residual: residualHash === before ? [] : [`config.toml changed beyond the expected [projects.'${expectedProjectPath}'] block — residual delta not auto-classified, disclose verbatim`],
  };
}

/**
 * Remove exactly the `[projects.'<expectedProjectPath>']` block(s) {@link diffConfigAfterSpawn} identified
 * as this spawn's own trust-dialog write — the probe's own manual remediation, automated. Never touches
 * anything else in the file. Best-effort (never throws); returns false if nothing was removed.
 */
export function removeAddedTrustBlocks(removable: string[]): boolean {
  if (removable.length === 0) return false;
  try {
    let text = fs.readFileSync(codexConfigPath(), "utf8");
    for (const block of removable) text = text.split(block).join("");
    fs.writeFileSync(codexConfigPath(), text);
    return true;
  } catch {
    return false;
  }
}

let cachedCodexVersion: string | null = null;
/** Non-blocking read of whatever version is already cached — NEVER triggers the async probe. Mirrors
 *  `orchestration/usage-status.ts#getCachedClaudeVersion`'s spawn-hot-path-safety contract exactly. */
export function getCachedCodexVersion(): string | null {
  return cachedCodexVersion;
}
/** Best-effort, ASYNC warm of the cached codex version. Call once at daemon boot (mirrors
 *  `prewarmClaudeVersionAsync`) — never on the spawn hot path. */
export function prewarmCodexVersionAsync(): void {
  if (cachedCodexVersion) return;
  try {
    const bin = resolveExecutable(process.env.LOOM_CODEX_BIN || CODEX_BINARY_NAME);
    // shell:true on Windows ONLY (real-spawn-caught, card 353f6dc4): an npm-global install of codex
    // resolves to a `.cmd` shim on Windows (confirmed against this host's real install), and plain
    // `execFile` — unlike `execSync`/node-pty's Windows agent, both of which already go through a
    // shell/equivalent — refuses to run a `.cmd` directly, silently swallowed by this function's own
    // best-effort `if (err) return`. A mocked exec could never have caught this; the real-spawn test
    // (test/codex-version-real-spawn.mjs) reproduced it against a real `.cmd`-wrapped child process
    // before this fix (timed out waiting for the cache to populate) and passes after. Args are a static
    // literal (`["--version"]`, no interpolation), so shell:true here carries no injection surface.
    execFile(bin, ["--version"], { timeout: 8000, windowsHide: true, shell: process.platform === "win32" }, (err, stdout) => {
      if (err) return;
      const v = stdout.match(/(\d+\.\d+\.\d+)/)?.[1];
      if (v) cachedCodexVersion = v;
    });
  } catch { /* best-effort — cache simply stays unset */ }
}

const CODEX_SESSIONS_DIR = () => path.join(realCodexHome(), "sessions");

/** Watch `~/.codex/sessions` for a rollout file disappearing (debounced) — the codex mirror of
 *  `pty/claude-doctrine.ts#watchClaudeLiveness`. Same defensive posture: errors are swallowed (logged,
 *  never rethrown) so a watcher failure never crashes the daemon. */
export function watchCodexLiveness(onRemoved: () => void): FSWatcher {
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onRemoved, 1500);
  };
  return chokidar
    .watch(CODEX_SESSIONS_DIR(), { ignoreInitial: true, depth: 3 })
    .on("unlink", (f) => { if (f.endsWith(".jsonl")) schedule(); })
    .on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      console.warn(`[liveness] codex-sessions watcher error (ignored, watcher continues): ${e?.code ?? ""} ${e?.message ?? String(err)}`);
    });
}
