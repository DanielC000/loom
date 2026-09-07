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
 * The static input-box placeholder. The probe's findings.md documents this text sitting in TWO DISTINCT
 * traps — a reader (and, once, this codebase) can correctly defend against one and still walk straight
 * into the other:
 *   - **State 4 ("landmine #2")**: the placeholder is present DURING BUSY too — it is static chrome, not
 *     an idle signal. ⛔ NEVER use its presence to conclude CURRENT idle state (see `BUSY_STATUS_MARKER`'s
 *     own doc for the reliable busy/idle signal). This codebase HAS always defended against this one: the
 *     placeholder is used ONLY as a one-time "has codex rendered its main TUI at least once since boot"
 *     latch (checked ONCE, never re-evaluated as an ongoing state, by `codex-host.ts#isCodexReadyMarkerPresent`
 *     — busy/idle detection reads `BUSY_STATUS_MARKER`/`BUSY_TITLE_SPINNER_RE` exclusively and never this
 *     text at all).
 *   - **State 1, card 448f1b4a**: the placeholder ALSO renders in the VERY FIRST boot frame, ALONGSIDE the
 *     header still reading `model: loading` — BEFORE the model/profile has actually finished resolving
 *     (see `CODEX_MODEL_LOADED_RE`'s own doc for the full specimen). Being a one-time latch defends against
 *     State 4, but says NOTHING about State 1: "has this rendered at least once" is true the instant the
 *     boot skeleton first paints, which can be well before the model is actually loaded. A real merge gate
 *     (op 43cd9ec1) captured exactly this: the placeholder alone read as "ready," and a submit landed on it.
 * ⚠️ **This constant's own presence being latched-not-ongoing is NOT evidence the question "is codex ready"
 * was fully considered — it only answers "has codex passed whatever comes before the ready box," which is
 * a WEAKER question than boot-readiness.** `codex-host.ts#isCodexReadyMarkerPresent` (built on this
 * constant) is therefore combined with `codex-host.ts#isCodexModelLoaded` (built on `CODEX_MODEL_LOADED_RE`)
 * — the composite is what `pty/host.ts`'s `live.bootReady` gates on, never this text alone.
 */
export const CODEX_READY_PLACEHOLDER = "Ask Codex to do anything";

/**
 * Card 448f1b4a: the header's `model:` line while codex is still resolving its configured model/profile —
 * rendered in the VERY FIRST boot frame, ALONGSIDE {@link CODEX_READY_PLACEHOLDER}, before the trust
 * dialog (if any) and before the real ready state. Probe findings.md State 1 documented this exact trap
 * at spec time: "the very first frame renders a boxed header... and an input placeholder line... before
 * the model/profile has even finished loading (header shows `model: loading` at this point). This is a
 * real trap for a naive 'wait for the ready-looking text, then submit' adapter" — a trap that was never
 * wired into `codex-host.ts#isCodexReadyMarkerPresent`, and a real merge gate (op 43cd9ec1) later captured
 * exactly this: the ready placeholder rendered while this text was still on screen, and the harness
 * submitted into it. State 3 documents the real-ready form as `model: gpt-6-astra medium` (not "loading").
 *
 * ⛔ This is intentionally a POSITIVE match ("model:" followed by something that is NOT "loading"), never
 * the NEGATION of a "model: loading" match. `codex-host.ts#isCodexReadyMarkerPresent`'s own doc explains
 * why: the caller evaluates this against an ACCUMULATING scan buffer that never removes old bytes (only
 * trims from the front once capped), so a negated check ("loading" is absent) would go permanently true
 * the instant "loading" first scrolls out of the cap window even if the model NEVER actually finished
 * resolving — the same landmine `BUSY_STATUS_MARKER`'s own doc warns against for busy/idle. A POSITIVE
 * match is safe against that same buffer for the same reason `CODEX_READY_PLACEHOLDER` is: the real model
 * name, once rendered even once, never reverts to "loading" later in the session, so "has this ever
 * appeared" is a sound one-time question here too.
 *
 * 🔴 MUST BE TESTED AGAINST {@link stripAnsiCsi}'S OUTPUT, NEVER THE RAW `screenScan` BUFFER DIRECTLY.
 * Confirmed against gate `43cd9ec1`'s own raw captured bytes (`~/.loom/gate-output/43cd9ec1-*.log`,
 * `od -c` verified real `\x1b` bytes, not a log-rendering artifact): the real frame is `model:` + spaces +
 * `\x1b[3m` (italic-on) + `loading` + `\x1b[23m` (italic-off) — codex styles the VALUE token with its own
 * CSI span, separate from the label. Tested raw (no strip), `\s+` consumes the plain spaces and lands
 * EXACTLY on the `\x1b` byte; `(?!loading\b)` then succeeds (the literal text "loading" does NOT start at
 * an ESC byte), and `\S+` (ESC is not whitespace) happily swallows `\x1b[3mloading\x1b[23m` as its match —
 * so the UNSTRIPPED regex returns TRUE while the model is still genuinely loading, reintroducing this
 * card's own defect through the fix meant to close it. `codex-host.ts#isCodexModelLoaded` strips ANSI CSI
 * sequences (mirrors `pty/host.ts`'s own `ANSI_CSI`/`collapseBoot`, kept LOCAL here rather than imported —
 * see `stripAnsiCsi`'s own doc for why) before testing this pattern, which is the ONLY reason this stays
 * correct against the real byte stream. ⚠️ The real-ready form (`model: gpt-6-astra medium`, State 3) was
 * NOT similarly byte-verified — no raw capture of it was available at fix time (disclosed gap, not
 * assumed-safe); `stripAnsiCsi` is a defensive, unconditional strip specifically so this doesn't depend on
 * that byte shape being known.
 */
export const CODEX_MODEL_LOADED_RE = /model:\s+(?!loading\b)\S+/;

/**
 * Strip ANSI CSI escape sequences (mirrors `pty/host.ts`'s own private `ANSI_CSI`/`collapseBoot` — same
 * technique, same underlying problem: codex's real TUI styles individual tokens on the SAME line with
 * separate CSI spans, so a plain-text regex tested against raw bytes can mismatch, or — the actually-
 * observed failure — silently match the WRONG thing by swallowing the escape sequence itself as part of a
 * `\S+` token; see {@link CODEX_MODEL_LOADED_RE}'s own doc for the confirmed real specimen). Kept as a
 * LOCAL copy rather than importing `pty/host.ts`'s `ANSI_CSI` — this module (`codex-doctrine.ts` →
 * `codex-host.ts`) is deliberately the LOWER layer `pty/host.ts` imports FROM (see this file's own header),
 * so importing back from `pty/host.ts` would invert that layering for one regex. Deliberately does NOT also
 * collapse whitespace the way `collapseBoot` does — `CODEX_MODEL_LOADED_RE`'s own `\s+` needs real
 * whitespace to still be present between "model:" and its value after stripping.
 */
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsiCsi(s: string): string {
  return s.replace(ANSI_CSI_RE, "");
}

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

/**
 * Card 887e10b8 Item 1 (multi-harness epic df1f94b0 Phase 1): codex's doctrine-injection mechanism
 * (`HarnessAdapter.capabilities.doctrineInjection`). Codex has no `.claude/skills`-style directory
 * convention and no Skill-invocation tool — its OWN native project-instructions file is `AGENTS.md` (a
 * single file, read at process start, the codex analogue of CLAUDE.md), so a doctrine-skill body (like
 * `/worker`'s SKILL.md) cannot be pointed at by name the way it is for claude — the essential rules are
 * inlined here directly instead.
 */
export const CODEX_DOCTRINE_FILE = "AGENTS.md";

/** Whether `p` (a git-status-relative path, forward-slash form) is the codex doctrine file — mirrors
 *  `claude-doctrine.ts#isDoctrineArtifactPath`'s role for `git/worktrees.ts#uncommittedWorkFiles`. A fresh
 *  worktree checkout never carries an untracked root file on its own (see this repo's own CLAUDE.md:
 *  "A fresh worktree does NOT carry gitignored files"), so an untracked `AGENTS.md` appearing in a
 *  worker's worktree can only be something this injection wrote — safe to treat as doctrine noise, never
 *  the project's own real (already-tracked) AGENTS.md, which would show a DIFFERENT git status ("M", not
 *  "??") and is never touched by {@link injectCodexDoctrine} in the first place. */
export function isCodexDoctrinePath(p: string): boolean {
  return p === CODEX_DOCTRINE_FILE;
}

function codexDoctrineFile(cwd: string): string {
  return path.join(cwd, CODEX_DOCTRINE_FILE);
}

const CODEX_DOCTRINE_BEGIN = "<!-- LOOM:CODEX-DOCTRINE:BEGIN (managed by Loom — regenerated every spawn; do not edit by hand) -->";
const CODEX_DOCTRINE_END = "<!-- LOOM:CODEX-DOCTRINE:END -->";

/** The condensed, harness-agnostic worker doctrine a claude worker gets via its `/worker` skill body —
 *  inlined here (not pointed at) because codex has no skill-invocation tool to follow such a pointer.
 *  Deliberately narrow: only the three rules card `887e10b8` names as load-bearing for a doctrine-blind
 *  worker (the targeted-test default, the no-speculative-full-gate rule, and the escalate-up rule), plus a
 *  pointer to the project's own CLAUDE.md for everything project-specific — this is NOT a full transcription
 *  of `/worker`'s much larger doctrine, which assumes tools (Skill, a Task-list UI) codex does not have. */
function codexWorkerDoctrineBody(): string {
  return [
    "# Loom worker doctrine (condensed for Codex)",
    "",
    "You are a Loom-dispatched WORKER session running on the Codex CLI, assigned ONE task on an isolated",
    "git worktree and branch. This file is Codex's own project-instructions convention (`AGENTS.md`),",
    "carrying a condensed version of the doctrine a Claude Code worker gets from its `/worker` skill —",
    "Codex has no skill-invocation tool, so the load-bearing rules are inlined here directly rather than",
    "pointed at by name.",
    "",
    "## Read this project's own CLAUDE.md at the repository root FIRST",
    "It is the authoritative source for this project's conventions, commit-message rules, and build/test",
    "(DoD) gate command. This file carries only the cross-project worker rules below; it never overrides",
    "or restates project specifics.",
    "",
    "## The three load-bearing rules",
    "1. Targeted-test default. Default to running the SPECIFIC test file(s) your task affects, directly —",
    "   not the project's full build/test gate. Only run a full gate when your task's own instructions",
    "   explicitly call for it, or the change is genuinely load-bearing/fleet-wide in a way no specific",
    "   test file can cover.",
    "2. Never speculatively run a shared/full gate. A full build/test gate (if this project exposes one as",
    "   a tool) is a shared, capped resource other work may already be queued behind. Never fire it on your",
    "   own judgment call — report up and ask first, and wait for the answer, unless your kickoff already",
    "   told you which check to run.",
    "3. Escalate up, never sideways, never to a human directly. On a decision, ambiguity, or blocker beyond",
    "   your assigned task's clear scope: STOP. Report the blocker rather than guessing, and never silently",
    "   expand scope or contact a human yourself — only your manager does that.",
    "",
    "## Reporting",
    "Report your status (done / blocked / progress) through the daemon's own reporting tool for your",
    "session — a plain reply in the conversation is not seen by your manager and does not end your",
    "assignment. Commit your verified work to your assigned branch before reporting done; never commit to",
    "the project's mainline.",
  ].join("\n");
}

/** The full injected block, including the ID line a real-spawn test can ask codex to read back verbatim
 *  to prove RECEPTION (not merely delivery) — see `test/codex-doctrine-real-spawn.mjs`. The id is derived
 *  from the body content itself (not a random per-run value), so it changes only when the doctrine wording
 *  changes and stays stable across repeated spawns/resumes of the SAME doctrine version. */
function codexDoctrineBlock(): string {
  const body = codexWorkerDoctrineBody();
  const id = md5(body).slice(0, 8);
  return `${CODEX_DOCTRINE_BEGIN}\n<!-- LOOM-DOCTRINE-ID: ${id} -->\n${body}\n${CODEX_DOCTRINE_END}\n`;
}

/**
 * Resolve the git dir `info/exclude` actually lives in for `cwd` — duplicated from
 * `skills/inject.ts#resolveGitCommonDir` (small + self-contained; kept local rather than cross-imported so
 * this file's git-hygiene concern doesn't create a new pty↔skills coupling for one helper). See that
 * function's own doc for the full worktree-indirection reasoning.
 */
function resolveGitCommonDirForDoctrine(cwd: string): string | null {
  const gitPath = path.join(cwd, ".git");
  let stat: fs.Stats;
  try { stat = fs.statSync(gitPath); } catch { return null; }
  if (stat.isDirectory()) return gitPath;
  let pointer: string;
  try { pointer = fs.readFileSync(gitPath, "utf8"); } catch { return null; }
  const m = pointer.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m || !m[1]) return null;
  const privateDir = path.resolve(cwd, m[1]);
  let commondirRaw: string;
  try { commondirRaw = fs.readFileSync(path.join(privateDir, "commondir"), "utf8").trim(); }
  catch { return null; }
  return path.resolve(privateDir, commondirRaw);
}

/** Hide the injected `AGENTS.md` from `git status` via the shared `.git/info/exclude` (local only; never
 *  edits a tracked `.gitignore`) — mirrors `skills/inject.ts#hideFromGit`'s discipline for `.claude/`. */
function hideCodexDoctrineFromGit(cwd: string): void {
  const gitDir = resolveGitCommonDirForDoctrine(cwd);
  if (!gitDir) return;
  const infoDir = path.join(gitDir, "info");
  try { fs.mkdirSync(infoDir, { recursive: true }); } catch { /* ignore */ }
  const excludePath = path.join(infoDir, "exclude");
  let cur = ""; try { cur = fs.readFileSync(excludePath, "utf8"); } catch { /* none */ }
  const entry = `/${CODEX_DOCTRINE_FILE}`;
  if (cur.split(/\r?\n/).includes(entry)) return;
  const prefix = cur === "" || cur.endsWith("\n") ? "" : "\n";
  try { fs.appendFileSync(excludePath, `${prefix}# loom-managed exclusions (injected per session; do not commit)\n${entry}\n`); } catch { /* ignore */ }
}

/**
 * Deliver the condensed worker doctrine into `<cwd>/AGENTS.md` for a codex WORKER session — the codex
 * counterpart of `skills/inject.ts#injectSkills` for claude. Only `role === "worker"` gets doctrine
 * injected for now (a named, disclosed Phase-1 scope limit: no other codex role is dispatched in
 * production yet, so building per-role content nothing exercises would be speculative rather than
 * verified work — mirrors `skills/inject.ts#ROLE_DOCTRINE_SKILL`'s per-role shape for a future pass).
 *
 * Idempotent + non-destructive: writes ONLY when the file doesn't exist yet, or exists and is ENTIRELY a
 * prior Loom-managed block (starts with {@link CODEX_DOCTRINE_BEGIN}) — refreshed to the CURRENT content on
 * every spawn/resume so a doctrine wording update reaches a resumed session too. A file that exists and
 * does NOT start with the marker is the project's own real `AGENTS.md` (or another tool's) — never
 * touched, mirroring `injectSkills`'s "never clobber a repo's own pre-existing" rule. Best-effort: never
 * throws (a failed write is logged, not fatal to the spawn — mirrors the git-exclude helper above).
 */
export function injectCodexDoctrine(cwd: string, role: string | null | undefined): void {
  if (role !== "worker") return;
  const target = codexDoctrineFile(cwd);
  const block = codexDoctrineBlock();
  let existing: string | null = null;
  try { existing = fs.readFileSync(target, "utf8"); } catch { /* no file yet — normal first spawn */ }
  if (existing !== null && !existing.startsWith(CODEX_DOCTRINE_BEGIN)) return; // the repo's own real AGENTS.md
  if (existing === block) { hideCodexDoctrineFromGit(cwd); return; } // already current; still ensure it's excluded
  const tmp = `${target}.loom-tmp`;
  try {
    fs.writeFileSync(tmp, block);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    console.log(`[codex-doctrine] failed to write ${target}: ${(e as Error)?.message ?? String(e)}`);
    return;
  }
  hideCodexDoctrineFromGit(cwd);
}
