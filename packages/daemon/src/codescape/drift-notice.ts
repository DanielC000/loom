import fs from "node:fs";
import path from "node:path";

/**
 * Card `350bc307` DoD-2: the ADDRESSED signal for a non-empty `codescapeUnclassifiedTools` result — NOT
 * a log line. `CodescapeSupervisor.checkToolDrift` (`supervisor.ts`) persists its latest finding here
 * (a small, best-effort state file under the codescape home dir); `readCodescapeToolDriftNote` below is
 * the ONLY reader, called from `composeResumeDocOperationalNotes` (`sessions/platform-lead-prompt.ts`) —
 * the SAME `[loom:*]` operational-note channel that already carries the resume-doc size/staleness
 * warnings into EVERY Platform Lead spawn's own kickoff prompt. Named actor: the Platform Lead — the
 * standing, human-driven operator whose doctrine already owns "platform-wide concerns" (CLAUDE.md) and
 * already reads `[loom:*]` kickoff nudges as directives, not FYI. When: every Lead spawn (fresh or
 * recycle-successor) while the finding is non-empty — not a one-time notice a restart can silently
 * outlive. This is deliberately NOT a board-card escalation (`platform_escalate`): that surface requires
 * a live MANAGER session as its caller (`sessions/service.ts`, off-limits to this card — see its own
 * `caller.role !== "manager"` guard) and has no headless/daemon-internal entry point; reusing this
 * already-established prompt-injection channel avoids either reimplementing that machinery's dedupe/
 * severity/attention-push wiring by hand from unrelated code, or bypassing it.
 */

/** Basename of the persisted tool-drift state file, written under the codescape home dir
 *  (`paths.ts`'s `CODESCAPE_HOME_DIR`, i.e. `<LOOM_HOME>/codescape`). */
export const TOOL_DRIFT_STATE_BASENAME = "tool-drift-state.json";

export interface ToolDriftState {
  /** ISO timestamp of the probe that produced this state. */
  checkedAt: string;
  /** Tool names {@link codescapeUnclassifiedTools} (`pty/host.ts`) found in neither CODESCAPE_TOOL_ALLOW
   *  nor CODESCAPE_WRITE_TOOLS. Empty when the last successful probe found the partition complete. */
  unclassified: string[];
  /** Total tool count the server advertised on this probe — context for the note, not itself acted on. */
  advertisedCount: number;
}

/** Absolute path of the state file, given the codescape HOME dir (e.g. `CodescapeSupervisor.getHomeDir()`). */
export function toolDriftStatePath(codescapeHomeDir: string): string {
  return path.join(codescapeHomeDir, TOOL_DRIFT_STATE_BASENAME);
}

/**
 * Persist the latest probe result. Best-effort, NEVER throws — DoD-3 (fail soft): a write failure (a
 * missing/unwritable home dir) must never propagate into the health-probe tick that calls this; it just
 * means the next Lead kickoff sees stale (or no) state instead of this tick's finding.
 */
export function writeToolDriftState(codescapeHomeDir: string, state: ToolDriftState): void {
  try {
    fs.mkdirSync(codescapeHomeDir, { recursive: true });
    fs.writeFileSync(toolDriftStatePath(codescapeHomeDir), JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

/**
 * Read back the latest persisted finding and compose the `[loom:codescape-tool-drift]` note, or `""`
 * when there's nothing to report (no state yet, codescape off, an unreadable/corrupt file, or the last
 * probe found the partition complete) — DoD-3: fail soft, never throws, never blocks a spawn.
 *
 * `loomHomeDir` is `LOOM_HOME` itself (what `composeResumeDocOperationalNotes` already receives as
 * `homePath`) — the join to the codescape subdirectory mirrors `paths.ts`'s
 * `CODESCAPE_HOME_DIR = path.join(LOOM_HOME, "codescape")` verbatim; grep that constant first if this
 * ever needs to move.
 */
export function readCodescapeToolDriftNote(loomHomeDir: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(toolDriftStatePath(path.join(loomHomeDir, "codescape")), "utf-8");
  } catch {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  const state = parsed as Partial<ToolDriftState> | null;
  const unclassified = Array.isArray(state?.unclassified) ? state.unclassified.filter((t): t is string => typeof t === "string") : [];
  if (unclassified.length === 0) return "";
  const checkedAt = typeof state?.checkedAt === "string" ? state.checkedAt : "an unknown time";
  return (
    `[loom:codescape-tool-drift] The RUNNING Codescape MCP server currently advertises ${unclassified.length} ` +
    `tool(s) classified as NEITHER read nor write in packages/daemon/src/pty/host.ts's CODESCAPE_TOOL_ALLOW / ` +
    `CODESCAPE_WRITE_TOOLS: ${unclassified.join(", ")}. An unclassified tool is mounted but unallowlisted — under ` +
    `acceptEdits it PROMPTS rather than auto-approving or auto-denying, and a Loom-driven worker/setup/auditor ` +
    `session (AskUserQuestion disallowed) has no way to answer that prompt, so a stray call wedges the turn. ` +
    `Classify each name into the correct list — reuse codescapeUnclassifiedTools, never re-derive the set ` +
    `difference — then own or file the fix and record the outcome. Checked ${checkedAt} against the LIVE server: ` +
    `this is a running-process reading, not a source-code one — the daemon serving this kickoff may itself be ` +
    `running older code than what's merged on main.`
  );
}

/**
 * Card `ce1bed6e`: the SAME ADDRESSED-signal shape as {@link ToolDriftState} above, for the drift-restart
 * starvation problem — a build-drift restart deferred (or its one allowance already spent) with nobody
 * told the actual remaining window, so the party doing the rebuilding has no way to know a further rebuild
 * would replace the stability-window candidate and starve the restart indefinitely (card `9e6f984d`'s
 * debounce, `545ef479`'s state machine). Reaches the SAME Platform Lead kickoff channel as the tool-drift
 * note above, for the SAME reason: private by construction (no REST field, no MCP tool response, no
 * description text — the Platform Lead session type itself does not exist without `LOOM_DEV=1`), so this
 * needed zero new disclosure surface and (per the accepted-baseline provenance notes in
 * codescape-privacy-guard.mjs) zero new entry there — this file and `sessions/platform-lead-prompt.ts` are
 * already on it (card `350bc307`).
 *
 * ⚠️ Deliberately NOT a fix for the PREVENTION audience (the party actually doing the rebuilding, on a
 * codescape-enabled project) — that is a shared channel reaching ordinary sessions and needs its own
 * `CODESCAPE_PROMPT_BLOCK_ASSET`-style review; out of scope here. This is the REMEDIATION audience only,
 * and only reaches it WHEN a Platform Lead actually spawns — see this note's own caller for that bound.
 */
export const BUILD_DRIFT_STATE_BASENAME = "build-drift-state.json";

/**
 * Mirrors `CodescapeSupervisor.getDriftDetail()`'s own return shape (supervisor.ts) FIELD FOR FIELD, but
 * deliberately re-declared here rather than imported — same discipline as {@link ToolDriftState}, which
 * has no dependency on supervisor.ts's own types either. `message` is the pre-composed, ready-to-surface
 * line `getDriftDetail()` already builds (states BOTH the remaining window and that the SAME commit does
 * not reset it, or the UNRESOLVED/exhausted wording) — persisted verbatim so the wording is derived in
 * exactly ONE place, never re-derived here.
 */
export interface BuildDriftState {
  /** ISO timestamp of the probe tick that produced this state. */
  checkedAt: string;
  message: string | null;
}

/** Absolute path of the persisted build-drift state file, given the codescape HOME dir. */
export function buildDriftStatePath(codescapeHomeDir: string): string {
  return path.join(codescapeHomeDir, BUILD_DRIFT_STATE_BASENAME);
}

/**
 * Persist the latest probe result. Best-effort, NEVER throws — same DoD-3 fail-soft discipline as
 * {@link writeToolDriftState}: a write failure just means the next Lead kickoff sees stale (or no) state
 * instead of this tick's finding, never a probe-tick failure.
 */
export function writeBuildDriftState(codescapeHomeDir: string, state: BuildDriftState): void {
  try {
    fs.mkdirSync(codescapeHomeDir, { recursive: true });
    fs.writeFileSync(buildDriftStatePath(codescapeHomeDir), JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

/**
 * Read back the latest persisted finding and compose the `[loom:codescape-build-drift]` note, or `""` when
 * there's nothing to report (no state yet, codescape off, an unreadable/corrupt file, or the last probe
 * found no pending/unresolved drift) — same fail-soft discipline as {@link readCodescapeToolDriftNote}.
 *
 * `loomHomeDir` is `LOOM_HOME` itself, exactly as {@link readCodescapeToolDriftNote} receives it.
 */
export function readCodescapeBuildDriftNote(loomHomeDir: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(buildDriftStatePath(path.join(loomHomeDir, "codescape")), "utf-8");
  } catch {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  const state = parsed as Partial<BuildDriftState> | null;
  const message = typeof state?.message === "string" ? state.message : null;
  if (!message) return "";
  const checkedAt = typeof state?.checkedAt === "string" ? state.checkedAt : "an unknown time";
  return `[loom:codescape-build-drift] ${message} Checked ${checkedAt} against the LIVE server: this is a running-process reading, not a source-code one — the daemon serving this kickoff may itself be running older code than what's merged on main.`;
}
