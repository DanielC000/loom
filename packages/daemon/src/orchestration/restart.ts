import path from "node:path";
import fs from "node:fs";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { SessionRole } from "@loom/shared";
import { LOOM_HOME } from "../paths.js";
import { writeJsonAtomic } from "../pty/claude-config.js";
import { DEPLOY_PACKAGES } from "../deploy-packages.js";
import type { CapQueuedSpawn } from "./cap-queue.js";
import { boundedSimpleGit } from "../git/bounded.js";
import { readBuildInfo } from "../deploy-staleness.js";

const require = createRequire(import.meta.url);

/**
 * Absolute path to turbo's node entry (`turbo/bin/turbo`, a JS shim that execs the platform binary).
 * Resolving it lets buildDaemon run the build via `node <turbo>` with NO shell and NO reliance on
 * `pnpm`/`PATH` — the fragility that made the build fail with EMPTY output only inside the daemon's
 * spawned-process env (ticket 51522f05). Falls back to the conventional node_modules path.
 */
function turboBin(): string {
  try { return require.resolve("turbo/bin/turbo"); }
  catch { return path.join(repoRoot(), "node_modules", "turbo", "bin", "turbo"); }
}

/**
 * Self-host daemon restart support (the `daemon_restart` manager tool). Orchestrating Loom WITH Loom,
 * a manager that merges daemon-`src` worker branches can't see that code run until the daemon is
 * rebuilt + restarted — but restarting kills its own pty. This module is the coordination layer:
 *   - the daemon exits with RESTART_EXIT_CODE; the supervisor (scripts/daemon-supervisor.mjs)
 *     rebuilds and relaunches ONLY on that code;
 *   - a restart-intent file persists who to re-resume across the gap so boot can bring the manager
 *     (and its live workers) back and tell it the merged code is now live.
 * Only valid under the supervisor (LOOM_SUPERVISED=1) — otherwise nothing relaunches the daemon.
 */

/** Exit code that asks the supervisor to rebuild + relaunch. MUST match scripts/daemon-supervisor.mjs. */
export const RESTART_EXIT_CODE = 75;

const INTENT_PATH = path.join(LOOM_HOME, "restart-intent.json");

/**
 * One member of the live fleet to bring back on boot. The daemon is ONE process for ALL projects, so
 * a restart tears down every project's sessions — the resume set therefore spans all projects, each
 * entry carrying the identity needed to re-spawn it with the SAME role + lineage (a worker under its
 * manager). (P1 17df54c5 — was previously only the requesting manager's own flat workerSessionIds.)
 */
export interface RestartResumeEntry {
  sessionId: string;
  /** The session's orchestration role, re-passed on resume so its MCP surface comes back. null = plain. */
  role: SessionRole | null;
  /** For a worker, the manager that spawned it (preserves manager↔worker linkage across the restart). */
  parentSessionId: string | null;
  /**
   * Whether the session was BUSY (mid-turn / mid-run) at capture time (card b5664b5b, Problem B). Used by
   * resumeFleetOnBoot to gate the standing-reviewer (auditor/workspace-auditor/setup) resume nudge: a
   * reviewer that was mid-run when the restart hit is nudged to continue (it has no startup prompt and its
   * in-flight turn would otherwise strand), but an already-IDLE reviewer between scheduled runs resumes
   * SILENTLY — its next due wake/schedule re-engages it via the durable WakeService/Scheduler tickers, so a
   * "continue your work" nudge to it only burned a wasted turn. Optional + defaults falsy so an OLD on-disk
   * intent (pre-this-field) degrades to the silent path for reviewers, never crashes.
   */
  busy?: boolean;
  /**
   * Whether this session's raw-terminal composer held an UNSENT human draft at capture time
   * (PtyHost.isComposerDirty — composerLen > 0). That draft (commonly a large paste the terminal has
   * collapsed to a "[Pasted text #N]" placeholder) lives only in the now-dead pty's in-memory composer
   * state — unlike the `pending` FIFO, there is nothing to replay. Used by resumeFleetOnBoot to tell the
   * resumed agent this loss explicitly (card: pasted-text-attachment-survives-restart) instead of leaving
   * it silently unaccounted for. Optional + defaults falsy so an OLD on-disk intent (pre-this-field)
   * degrades to no note, never crashes.
   */
  hadUnsentDraft?: boolean;
}

export interface RestartIntent {
  reason: string;
  /**
   * The session that REQUESTED the restart — a manager, OR (card 39fcaad3) the platform Lead calling
   * its own `daemon_restart` twin. Kept named `managerSessionId` for on-disk compat (an in-flight
   * intent written by an older daemon must still deserialize on the new one across exactly the
   * upgrade this field's meaning widened in) — read it as "the requester", not literally "a manager".
   * It alone is re-prompted ("your merged code is now live — continue/verify"); every OTHER captured
   * session resumes as-is. Always present in `resume` too (it is itself a live session) — this field
   * only marks WHICH of them is the requester.
   */
  managerSessionId: string;
  /**
   * The FULL live fleet captured at restart time (every manager, worker, and plain/platform session
   * that was live, across ALL projects). Boot re-resumes each with its role + linkage and protects
   * each one's worktree from boot-reconcile GC. Absent on an OLD (pre-deploy) intent — boot then falls
   * back to {managerSessionId} + workerSessionIds for that one file (see resumeSetFromIntent).
   */
  resume?: RestartResumeEntry[];
  /**
   * @deprecated superseded by `resume` (P1 17df54c5). Retained ONLY so an OLD on-disk intent written by
   * a pre-deploy daemon still resumes the requester + its workers on the first boot after deploy.
   */
  workerSessionIds?: string[];
  /**
   * Per-session snapshot (sessionId → its in-memory pending inbound FIFO) taken at restart time, so the
   * undelivered queue survives the process death and is replayed on boot (index.ts) — the persisted
   * analogue of recycle's in-process carriedPending. Only non-empty FIFOs of resumed sessions are
   * included; absent when nothing was queued. Element type is a bare `string[]` — see `pendingHolds`
   * (card 9e27f4d2) for why this field's own shape must never change to carry more than that.
   */
  pending?: Record<string, string[]>;
  /**
   * The give-up HOLD half of `pending`'s snapshot, kept in a wholly separate, ADDITIVE field rather than
   * folding it into `pending`'s own element type. `pending[id][i]` still within its post-give-up hold
   * window (host.ts's `isGiveUpHeld`/`GIVE_UP_HOLD_MS`) has its `giveUpHeldUntil` deadline recorded here
   * as `pendingHolds[id][i]` — SAME session key, SAME index into that session's `pending` array — instead
   * of on the entry itself. Absent when nothing captured was still held (the overwhelmingly common case).
   *
   * @decision 9e27f4d2 — do NOT widen `pending`'s element type to carry this; an older daemon reading a
   * widened entry would silently string-coerce it to `"[object Object]"`, losing the message with no
   * throw and no log.
   */
  pendingHolds?: Record<string, Record<number, number>>;
  /**
   * Card 1c47454b — a THIRD, wholly separate additive sibling field alongside `pending`/`pendingHolds`,
   * same shape and same on-disk-compat reasoning as `pendingHolds` (see its own doc): `pending[id][i]`'s
   * `mintedAtWallClock` (the paste-recovery mint's absolute wall-clock time — see
   * `PtyHost.QueuedMessage.mintedAtWallClock`'s doc), keyed by that entry's index into `pending[id]`,
   * carried here instead of folded into `pending`'s own element type. Without this, a still-pending
   * paste-recovery notice that survives a `daemon_restart` (via `pending` itself) would lose its ONLY
   * evidence that it's old — `mintedAtGen` was ALREADY, correctly, never carried across this boundary
   * (a fresh resumed session's `submitGeneration` restarts at 0, making a carried predecessor generation
   * count meaningless — see that field's own doc), so this is the sole surviving signal. Absent when
   * nothing captured carried an age stamp (the overwhelmingly common case — this field is set ONLY by
   * the paste-recovery mint).
   */
  pendingMintedAt?: Record<string, Record<number, number>>;
  /**
   * Card a1b79655 — the PUBLIC projection (never the full kickoffPrompt — mirrors
   * `CapQueueRegistry.listByManager`'s own read contract) of each captured manager's/platform's still-live
   * cap-queued worker_spawn intents, snapshotted right before exit. `CapQueueRegistry` is DELIBERATELY
   * in-memory-only (see its own class doc) and is never re-populated on boot — a fresh instance is
   * constructed empty every process start, so anything queued here is gone the instant this process exits,
   * with or without this field. This field exists purely so boot can TELL each affected manager/platform
   * what was silently dropped (resumeFleetOnBoot appends a note naming each entry) instead of leaving it to
   * notice a stale card on its own — it is INFORMATIONAL ONLY and never re-drives or re-queues anything.
   * Keyed by managerSessionId/platformSessionId; absent when nothing was queued for anyone captured.
   */
  capQueued?: Record<string, CapQueuedSpawn[]>;
  /**
   * Card db2179f6 — the {@link supervisorScriptChangedSince} result computed at request time, carried
   * across the restart so resumeFleetOnBoot's requester nudge can say so instead of unconditionally
   * claiming "your merged daemon code is now LIVE": a deploy touching the supervisor script leaves those
   * lines inert until a human runs `pnpm daemon:stable` (see SUPERVISOR_CHANGED_WARNING). Absent/false on
   * the overwhelmingly common case (no supervisor change) and on any OLD on-disk intent pre-dating this
   * field, which degrades to the old unconditional wording — never a crash.
   */
  supervisorChanged?: boolean;
  /**
   * The sibling of {@link RestartIntent.supervisorChanged}: set when {@link supervisorScriptChangedSince}
   * resolved `"could-not-check"` rather than a confirmed changed/unchanged. Mutually exclusive with
   * `supervisorChanged` (at most one is ever true). resumeFleetOnBoot's requester nudge surfaces this as
   * SUPERVISOR_CHECK_FAILED_WARNING instead of the unconditional "now LIVE" claim.
   *
   * @decision 2e84a250 — kept as a SEPARATE field, not a `supervisorChanged: boolean | "unknown"` union,
   * so an old on-disk intent (or a reader that only knows `supervisorChanged`) degrades exactly as
   * before: absent/false, never a crash or a misread "unknown".
   */
  supervisorCheckFailed?: boolean;
  /**
   * Card 3af8674e DoD-4: the REAL git sha of the code this deploy just built — read structurally from
   * `dist/build-info.json`'s fresh "stamp" (buildDaemon, right after a green build) — never scraped from
   * `reason`'s free text. Before this field existed, `resumeFleetOnBoot` derived the completion-escalation
   * dedup's "delivered SHA" set by regexing ANY 7-40 hex token out of `reason` (a manager-typed string),
   * which matches an 8-hex Loom card id just as readily as a real commit sha — a reason mentioning a card
   * id "delivered" that id as if it were a deploy SHA, and a later escalation legitimately citing the SAME
   * card id (routine, since both texts describe the same piece of work) collided and was wrongly
   * suppressed (the 2026-08-23 specimen). Absent/undefined on an OLD on-disk intent (pre-this-field) or
   * when the stamp couldn't be read — resumeFleetOnBoot then seeds an EMPTY delivered-SHA set for this
   * deploy rather than falling back to the old prose-regex, so a missed dedup is the accepted, harmless
   * cost (one extra turn), never a resurrected false-positive.
   */
  deploySha?: string;
  requestedAt: string;
}

/**
 * The fleet to resume, tolerant of BOTH the current shape (`resume`) and the OLD on-disk shape
 * (`workerSessionIds` only) — so the first boot after deploy reading a pre-deploy intent does NOT
 * crash; it degrades to today's behavior (the requester + its workers) for that one file.
 */
export function resumeSetFromIntent(intent: RestartIntent): RestartResumeEntry[] {
  if (intent.resume && intent.resume.length > 0) return intent.resume;
  // OLD-format fallback: synthesize the requester (manager) + its flat workers.
  const out: RestartResumeEntry[] = [
    { sessionId: intent.managerSessionId, role: "manager", parentSessionId: null },
  ];
  for (const w of intent.workerSessionIds ?? []) {
    out.push({ sessionId: w, role: "worker", parentSessionId: intent.managerSessionId });
  }
  return out;
}

/**
 * Every session id boot must PROTECT from reconcile worktree-GC — the whole resume set plus the
 * requester and any legacy workerSessionIds (belt-and-suspenders across both intent shapes). Boot
 * seeds `protectedSessionIds` from this so Pass B skips ALL their worktrees.
 */
export function protectedIdsFromIntent(intent: RestartIntent): Set<string> {
  const ids = new Set<string>(resumeSetFromIntent(intent).map((e) => e.sessionId));
  ids.add(intent.managerSessionId);
  for (const w of intent.workerSessionIds ?? []) ids.add(w);
  return ids;
}

/** True only when running under the restart supervisor — i.e. `daemon_restart` can safely relaunch. */
export function isSupervised(): boolean {
  return process.env.LOOM_SUPERVISED === "1";
}

/**
 * Card 83718377: `isSupervised()` above only proves this process was SPAWNED under the supervisor — the
 * env var is inherited once at spawn and never rechecked, so it stays `true` forever even if the
 * supervisor process has since died. Before card 3fba0cd2 that gap was harmless: a dead supervisor took
 * the whole process tree (incl. this daemon) down with it via an unguarded EPIPE crash, so the orphaned
 * state — supervisor dead, daemon alive — was unreachable. 3fba0cd2 makes the daemon survive that crash,
 * which means it can now genuinely outlive its supervisor. `isSupervisorProcessAlive` closes that gap by
 * re-deriving, from the live OS process table, whether a real `daemon-supervisor.mjs` process still sits
 * above this one — see its own doc below for the mechanism and why it's an ancestry WALK, not a single
 * captured-pid check.
 */

/** One row of the bulk OS process snapshot {@link isSupervisorProcessAlive} walks. */
export interface SupervisorProcRow {
  ppid: number;
  commandLine: string;
  /** Best-effort process start time, epoch ms. null when the OS/enumerator couldn't report it. */
  createdAtMs: number | null;
}

/** Bound the OS enumeration (PowerShell `Get-CimInstance`/`ps`) so a hung/slow call can't wedge a restart
 * request indefinitely — a timeout REFUSES the restart (see {@link isSupervisorProcessAlive}), it never
 * silently treats "couldn't check in time" as "must be fine". */
const SUPERVISOR_ENUM_TIMEOUT_MS = 8_000;

/**
 * How many ancestor hops {@link walkSupervisorAncestry} climbs before giving up. MEASURED against this
 * project's own real, live supervisor+daemon pair (Windows): the daemon's `process.ppid` is the
 * `cmd.exe /c "node ... dist/index.js"` shell wrapper `runDaemon` spawns it through (Windows `shell:true`
 * has no exec-replace, so that wrapper stays alive as a real intermediate process) — 1 hop — and ITS
 * ppid is the real `node scripts/daemon-supervisor.mjs` process — 2 hops total. On POSIX, `sh -c` often
 * exec-replaces itself for a single simple command, which would put the supervisor at hop 0 or 1 instead
 * — untested from this host (win32-only), but bounding at 4 gives slack for either shape without
 * "climbing to the root" and risking an unrelated coincidental match far up the tree.
 */
export const SUPERVISOR_MAX_ANCESTOR_HOPS = 4;

/**
 * Tolerance for the parent/child creation-time monotonicity check {@link walkSupervisorAncestry} runs at
 * every hop (card 83718377 amendment 1). A genuine parent must have started at or before its child;
 * POSIX creation times are derived from `ps`'s 1-second-resolution `etime`, so a few seconds of slack
 * absorbs that rounding plus ordinary scheduling jitter without opening the door to a real pid-reuse
 * case (which we still care about at second-plus granularity, not millisecond).
 */
export const SUPERVISOR_CREATION_SLOP_MS = 5_000;

/**
 * Card 83718377 amendment 2 — "match an invocation, not a mention": requires the command line's own
 * EXECUTABLE be `node`/`node.exe` (optionally path-qualified, optionally quoted) AND its FINAL token
 * name a path ending in `daemon-supervisor.mjs`. This deliberately does NOT match a `cmd.exe /c "node
 * scripts/daemon-supervisor.mjs"` wrapper (the executable there is cmd.exe, not node — see MEASURED
 * cases in the committed test) nor a node process that merely mentions the string as a stray mid-line
 * argument (e.g. a flag value, or a shim naming the real script further down the line) — only a process
 * whose own argv actually terminates in that script path counts as the supervisor.
 */
export const SUPERVISOR_INVOCATION_RE =
  /^\s*"?(?:[^"<>|]*[\\/])?node(?:\.exe)?"?\s+(?:[^\s]+\s+)*"?[^\s"]*daemon-supervisor\.mjs"?\s*$/i;

/** Windows bulk process enumerator: one line per LIVE process, `pid|ppid|createdAtEpochMs|commandLine`
 * (createdAtEpochMs empty when `CreationDate` is unavailable for that process). Mirrors the bulk
 * pid/ppid enumeration style `pty/host.ts`'s `reapOrphanedDescendants` already uses, extended to also
 * carry CommandLine + CreationDate (needed for the identity + monotonicity checks here). */
function enumerateWindowsProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { $ct=''; if ($_.CreationDate) { $ct=[long]([datetimeoffset]$_.CreationDate).ToUnixTimeMilliseconds() }; \"$($_.ProcessId)|$($_.ParentProcessId)|$ct|$($_.CommandLine)\" }",
      ],
      { timeout: SUPERVISOR_ENUM_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => { if (err) reject(err); else resolve(stdout); },
    );
  });
}

/** POSIX bulk process enumerator: `pid ppid etime command` per line (no header, `=` suffix suppresses
 * it) — same technique `git/worktrees.ts`-adjacent code and `scripts/daemon-supervisor-stop.mjs`'s
 * `commandLineOf` already use for a single pid, here enumerating every live process in one call.
 * Card 83718377 Code Review fix: uses `etime` (POSIX-standard, `[[dd-]hh:]mm:ss`), NOT `etimes` — that's
 * a GNU procps-ng extension absent on macOS/BSD `ps` and on a minimal/busybox `ps`, which would make
 * EVERY POSIX self-host restart permanently checkFailed. `etime` is parsed by {@link parseEtimeToSeconds}. */
function enumeratePosixProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-eo", "pid=,ppid=,etime=,command="],
      { timeout: SUPERVISOR_ENUM_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => { if (err) reject(err); else resolve(stdout); },
    );
  });
}

/**
 * Parse a POSIX `ps -o etime` value — `[[dd-]hh:]mm:ss` — into whole seconds. Exported + given its own
 * seam so the POSIX parse path (otherwise only ever exercised on a POSIX CI runner) can be unit-tested
 * directly from any host. Returns null on anything that doesn't match the documented shape (never
 * throws) — a caller treats that the same as an unknown creation time.
 */
export function parseEtimeToSeconds(etime: string): number | null {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] ? Number(m[2]) : 0;
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

function parseWindowsProcessRows(out: string): Map<number, SupervisorProcRow> {
  const rows = new Map<number, SupervisorProcRow>();
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\|(\d+)\|(\d*)\|([\s\S]*)$/);
    if (!m) continue;
    rows.set(Number(m[1]), { ppid: Number(m[2]), createdAtMs: m[3] ? Number(m[3]) : null, commandLine: m[4] ?? "" });
  }
  return rows;
}

function parsePosixProcessRows(out: string, nowMs: number): Map<number, SupervisorProcRow> {
  const rows = new Map<number, SupervisorProcRow>();
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // etime's own shape ([[dd-]hh:]mm:ss) contains `:`/`-`, so its field can't be matched with `\d+` —
    // `[^\s]+` bounds it to one whitespace-free token, same as pid/ppid's own fields.
    const m = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\s\S]*)$/);
    if (!m) continue;
    const elapsedSeconds = parseEtimeToSeconds(m[3] ?? "");
    rows.set(Number(m[1]), { ppid: Number(m[2]), createdAtMs: elapsedSeconds == null ? null : nowMs - elapsedSeconds * 1000, commandLine: m[4] ?? "" });
  }
  return rows;
}

/** Real (non-test) process snapshot: enumerate + parse for whichever platform this process runs on. */
async function defaultSupervisorProcessRows(): Promise<Map<number, SupervisorProcRow>> {
  const nowMs = Date.now();
  const out = process.platform === "win32" ? await enumerateWindowsProcesses() : await enumeratePosixProcesses();
  return process.platform === "win32" ? parseWindowsProcessRows(out) : parsePosixProcessRows(out, nowMs);
}

/**
 * Walk the OS ancestry from `startPpid` upward (bounded, cycle-guarded) for a live `node ...
 * daemon-supervisor.mjs` invocation. PURE + exported for a hermetic test (no spawning). Every hop must
 * also pass a parent-not-younger-than-child creation-time check (an unknown creation time counts as a
 * failure) before its command line is even tested — without it the walk could continue THROUGH a pid the
 * OS reused for an unrelated process into that process's own real ancestry and match a coincidental
 * daemon-supervisor.mjs further up. A dead/missing hop refuses too.
 */
export function walkSupervisorAncestry(
  startPpid: number,
  startCreatedAtMs: number | null,
  rows: Map<number, SupervisorProcRow>,
): SupervisorLivenessResult {
  const seen = new Set<number>();
  let pid = startPpid;
  let childCreatedAtMs = startCreatedAtMs;
  for (let hop = 0; hop < SUPERVISOR_MAX_ANCESTOR_HOPS; hop++) {
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) {
      return { alive: false, reason: `reached the top of the process ancestry (or a cycle) after ${hop} hop(s) without finding a live daemon-supervisor.mjs process — refusing to restart` };
    }
    seen.add(pid);
    const row = rows.get(pid);
    if (!row) {
      return { alive: false, reason: `pid ${pid} in the supervisor ancestry chain is no longer running — the supervisor (or an intermediate process) has died; refusing to restart` };
    }
    if (row.createdAtMs == null) {
      return { alive: false, reason: `could not determine pid ${pid}'s start time, so pid reuse can't be ruled out for this hop; refusing to restart` };
    }
    if (childCreatedAtMs != null && row.createdAtMs > childCreatedAtMs + SUPERVISOR_CREATION_SLOP_MS) {
      return { alive: false, reason: `pid ${pid} started AFTER the process it's claimed to be the parent of — the ancestry chain is broken (the pid was likely reused by an unrelated process); refusing to restart` };
    }
    if (SUPERVISOR_INVOCATION_RE.test(row.commandLine)) {
      return { alive: true };
    }
    childCreatedAtMs = row.createdAtMs;
    pid = row.ppid;
  }
  return { alive: false, reason: `no live daemon-supervisor.mjs process found within ${SUPERVISOR_MAX_ANCESTOR_HOPS} ancestor hop(s) — refusing to restart rather than climb further up the process tree` };
}

/** Injectable seam for {@link isSupervisorProcessAlive} — a hermetic test swaps in a synthetic `rows`
 * snapshot (and/or a fake `self`) instead of spawning a real OS enumerator. */
export interface SupervisorLivenessDeps {
  rows?: () => Promise<Map<number, SupervisorProcRow>>;
  self?: { ppid: number; createdAtMs: number | null };
}

export interface SupervisorLivenessResult {
  alive: boolean;
  /** Present whenever alive is false. */
  reason?: string;
  /** True ONLY when the check itself could not be completed (enumeration timed out, exited non-zero, or
   * returned nothing parseable) — distinct from a CONFIRMED dead/mismatched supervisor. A manager should
   * read this as "retry", not "the supervisor is gone". */
  checkFailed?: boolean;
}

/**
 * Card 83718377: is a genuine, live `daemon-supervisor.mjs` process still an ancestor of this one? Used
 * by `requestDaemonRestart` (sessions/service.ts) as a SECOND gate alongside `isSupervised()` — that
 * function only proves this process was spawned under supervision once; this re-derives, right now, from
 * the live OS process table, whether that supervisor is still there. Fails CLOSED: any inability to
 * complete the check (enumerator timeout/non-zero-exit/unparseable output) is `{alive:false,
 * checkFailed:true}`, never treated as "assume fine" — exiting into an orphaned daemon that nothing
 * relaunches is far worse than a refused restart a manager can simply retry.
 */
export async function isSupervisorProcessAlive(deps: SupervisorLivenessDeps = {}): Promise<SupervisorLivenessResult> {
  let rows: Map<number, SupervisorProcRow>;
  try {
    rows = deps.rows ? await deps.rows() : await defaultSupervisorProcessRows();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean };
    const reason = err.killed
      ? `could not verify supervisor liveness (process enumeration timed out after ${SUPERVISOR_ENUM_TIMEOUT_MS}ms) — refusing to restart; retry`
      : `could not verify supervisor liveness (process enumeration failed: ${err.message ?? String(e)}) — refusing to restart; retry once the check itself can succeed`;
    return { alive: false, checkFailed: true, reason };
  }
  if (rows.size === 0) {
    return { alive: false, checkFailed: true, reason: "could not verify supervisor liveness (process enumeration returned no parseable rows) — refusing to restart; retry once the check itself can succeed" };
  }
  const ppid = deps.self?.ppid ?? process.ppid;
  // Card 83718377 Code Review fix: derive OUR OWN creation time from the SAME enumeration/clock as every
  // ancestor row below, rather than Node's Date.now()-process.uptime() arithmetic — that reads a DIFFERENT
  // clock source than the OS enumerator's own CreationDate/etime, and the two can disagree (a backward
  // wall-clock step after boot from an NTP/RTC correction, or a DST-fold-back-ambiguous local-time
  // conversion), spuriously tripping the parent-younger-than-child check in walkSupervisorAncestry and
  // producing a FALSE refusal that would recur for this daemon's whole remaining lifetime (self's
  // Node-derived time relative to boot doesn't change on its own). Sourcing both sides from one snapshot
  // makes them consistent by construction.
  let createdAtMs: number | null;
  if (deps.self) {
    createdAtMs = deps.self.createdAtMs; // explicit test override — trusted as-is, including a deliberate null
  } else {
    const selfRow = rows.get(process.pid);
    if (!selfRow) {
      // A real host always finds itself in its own enumeration — this is a failed CHECK, not evidence
      // the supervisor is dead.
      return { alive: false, checkFailed: true, reason: "could not verify supervisor liveness (this process's own pid was not found in the process enumeration) — refusing to restart; retry once the check itself can succeed" };
    }
    createdAtMs = selfRow.createdAtMs;
  }
  return walkSupervisorAncestry(ppid, createdAtMs, rows);
}

/**
 * Which pass of the restart supervisor's `for(;;)` loop (scripts/daemon-supervisor.mjs) this boot is
 * running under, if any. Iteration 1 means the supervisor PROCESS ITSELF was just started (the loop's
 * first pass) — on the self-host path that means a human ran `pnpm daemon:stable` (or
 * `:stable:detach`), since nothing else launches that process. An iteration >1 means the supervisor's
 * OWN loop relaunched the daemon in-process, without the supervisor process itself restarting — today
 * that only ever follows the RESTART_EXIT_CODE `continue` (see the loop's own restart-policy comment:
 * any OTHER exit ends the loop for good).
 * Returns null when not running under the supervisor at all (the shipped, supervisor-less loomctl path,
 * an OS service manager, or a bare `tsx watch` dev daemon) — never fabricate an iteration for a boot the
 * supervisor never saw. Also null on a malformed/non-positive value (defensive: the env var crosses a
 * process boundary written by a sibling script, not a compile-time-checked contract).
 *
 * @decision 572dd777 — this value is recorded directly at boot, never re-derived from the
 * restart-intent/exit-code chain, so a reader doesn't have to trust that chain to see it.
 */
export function supervisorIterationAtBoot(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.LOOM_SUPERVISOR_ITERATION;
  if (typeof raw !== "string" || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Cause/impact of a `[loom:daemon-restarted]` wake, for ONE resumed session (card 5907b71e part 1, refined
 * by 61cc91c6). A single self-hosting session takes ~10 restart wakes, most for routine deploys/
 * version-syncs another session triggered — and each currently burns a FULL re-check turn confirming
 * "nothing for me". This classification lets an UNAFFECTED bystander no-op cheaply instead: it answers,
 * per session, the questions the wake should — did THIS session cause the restart, did it touch anything
 * of its own (workers, queued I/O, a genuinely pending answer), and is there board work that NOTHING ELSE
 * will ever re-surface?
 */
export interface RestartWakeImpact {
  /** This session REQUESTED the restart (the deploying manager) — never short-circuited; always full. */
  causal: boolean;
  /** How many of this manager's/platform's workers were resumed alongside it (their worktrees are live). */
  liveWorkersResumed: number;
  /** How many queued inbound messages were replayed onto this session by the restart (real work waiting). */
  queuedIoReplayed: number;
  /** This session itself has an ANSWERED, not-yet-`question_pull`ed question — a genuinely new event for
   *  it specifically, distinct from generic board content. */
  hasUnconsumedAnswer: boolean;
  /**
   * This session has actionable board work that NO OTHER mechanism will ever re-surface — 61cc91c6
   * narrowed this from "any non-terminal/non-held/non-deferred card exists" (which fired on ordinary
   * backlog almost every restart) to "and nothing else is watching it". See
   * SessionService.resumeFleetOnBoot's `strandedBoardWork` for the exact per-role/per-policy derivation.
   */
  strandedBoardWork: boolean;
}

/**
 * A non-causal manager/platform whose restart touched NOTHING of its own — no workers resumed, no queued
 * I/O replayed, no genuinely new answer, and no stranded board work — has nothing to re-check this
 * restart, so it gets the lightweight "no action needed" FYI instead of the full "re-check your workers"
 * re-orient. PURE + exported for the hermetic test. `strandedBoardWork` FORCES the full nudge (safety: a
 * session nothing else re-engages must not have its queue silently dropped) — but ordinary, actively-
 * watched backlog no longer counts (61cc91c6: it was forcing the full nudge on virtually every restart,
 * since the idle-watcher already independently covers a 'watching'/'snoozed' manager on its own cadence).
 * Supersedes the older board-AND-stale-idle-policy "converged" gate (card 90058589): impact, not raw
 * idle-policy, decides.
 */
export function isNoOpManagerWake(impact: RestartWakeImpact): boolean {
  return !impact.causal
    && impact.liveWorkersResumed === 0
    && impact.queuedIoReplayed === 0
    && !impact.hasUnconsumedAnswer
    && !impact.strandedBoardWork;
}

/**
 * Extract candidate git commit SHAs (7–40 hex chars on a word boundary) from free text (card 5907b71e
 * part 2). Used ONLY on the MATCHING side — a completion escalation's own title/detail — to find which
 * token(s) it names, for comparison against the delivered-SHA window a restart wake seeded. Lower-cased +
 * de-duped. PURE + exported for the hermetic test. Card 3af8674e DoD-4: this is deliberately NEVER applied
 * to a restart's `reason` any more (the SEEDING side) — `reason` is free text a manager types, and any
 * hex-looking token in it (a Loom card id is 8 hex chars, same shape as a short commit sha) used to be
 * regexed out and recorded as if it were a delivered deploy SHA; see `RestartIntent.deploySha`'s own doc
 * for the structural replacement. A permissive match stays fine here because the matching side alone can
 * only ever produce a MISS (a redundant nudge, the safe direction), never a false suppression on its own —
 * `announcesDeploy` (below) is the second, independent gate that closes the false-HIT direction.
 */
export function extractCommitShas(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(/\b[0-9a-f]{7,40}\b/gi)) out.add(m[0].toLowerCase());
  return [...out];
}

/**
 * Whether `text` plausibly ANNOUNCES a deploy having gone live (card 3af8674e DoD-3) — distinct from
 * merely containing a hex-looking token that happens to match a delivered deploy SHA. The 2026-08-23
 * specimen: a completion escalation reported a green CI run (naming the SAME Loom card id the restart
 * `reason` had also happened to name) and was suppressed anyway on that bare token collision — it never
 * claimed a deploy at all. `platformEscalate` may only suppress a live nudge as a duplicate when the
 * escalation's OWN text actually says a deploy/restart happened. Permissive by design (a handful of common
 * phrasings) — a MISS here only costs a redundant nudge (the safe direction; the durable board task is
 * filed either way), while a false HIT would wrongly swallow a genuine report. PURE + exported for the
 * hermetic test.
 */
export function announcesDeploy(text: string): boolean {
  return /\b(?:re)?deploy(?:ed|ment|s)?\b|\brestart(?:ed|ing)?\s+the\s+daemon\b|\b(?:is|now|went)\s+live\b/i.test(text ?? "");
}

export function writeRestartIntent(intent: RestartIntent): void {
  writeJsonAtomic(INTENT_PATH, intent);
}

/** Read the pending restart intent (consume with clearRestartIntent after acting on it). */
export function readRestartIntent(): RestartIntent | null {
  try {
    return JSON.parse(fs.readFileSync(INTENT_PATH, "utf8")) as RestartIntent;
  } catch {
    return null; // absent or unreadable → no pending restart
  }
}

export function clearRestartIntent(): void {
  try {
    fs.rmSync(INTENT_PATH, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Repo root, derived from this module's built location (dist/orchestration/restart.js → ../../../..). */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/**
 * Bound the deploy-time `pnpm install` so a hung registry fetch can't wedge the restart while the
 * daemon waits on the build (mirrors PROVISION_TIMEOUT_MS in git/worktrees.ts). The build itself is
 * left UNBOUNDED — a real tsc compile can legitimately run long and has no interactive-hang vector.
 */
const DEPLOY_INSTALL_TIMEOUT_MS = 180_000;

/**
 * One ordered step of a deploy build. `shell` selects the spawn form: shell:true runs `command` through
 * the OS shell (PATH-resolves `pnpm`, exactly like the worktree provisioner + the merge-gate runner);
 * shell:false execs `command` with `args` directly — NO shell, NO PATH reliance — the 51522f05-proof
 * turbo invocation. Exported (with {@link deployBuildSteps}) so a hermetic test can assert the exact
 * commands + flags WITHOUT spawning anything.
 */
export interface BuildStep {
  label: "install" | "build";
  command: string;
  args: string[];
  shell: boolean;
  /** Kill the child past this many ms; 0 = unbounded. */
  timeoutMs: number;
}

/**
 * The exact, ordered steps a daemon deploy runs — as DATA, so a regression test can prove the gate's
 * integrity without running a real build. STEP 1 installs (closes face B), STEP 2 force-builds (closes
 * face A). Both faces let a BROKEN/STALE main pass the deploy gate green; see each step's note.
 */
export function deployBuildSteps(root: string): BuildStep[] {
  return [
    // STEP 1 — INSTALL (closes face B: a merged dep-add that was never linked). daemon_restart used to
    // jump straight to the build, so a merge that ADDED a dependency (package.json + pnpm-lock.yaml)
    // compiled against a node_modules that still lacked it → the deploy build couldn't resolve the new
    // import and failed (the "daemon_restart never installs" gap — buildDaemon's repoRoot is the MAIN
    // checkout, whose node_modules is otherwise only ever installed by hand / the supervisor's cold boot).
    // `--frozen-lockfile` makes the deploy REPRODUCIBLE + FAIL-CLOSED: it installs exactly the committed
    // lockfile and ABORTS (rather than silently mutating the tree) if package.json drifted from the
    // lockfile — surfacing a half-committed dep-add instead of masking it. A near no-op when already in
    // sync, so a normal code-only deploy pays only a quick verify. CI=1 keeps pnpm non-interactive.
    { label: "install", command: "pnpm install --frozen-lockfile --prefer-offline", args: [], shell: true, timeoutMs: DEPLOY_INSTALL_TIMEOUT_MS },
    // STEP 2 — BUILD (closes face A: a stale FULL TURBO cache replaying a green build over broken/stale
    // source). Invoke turbo via ABSOLUTE node + ABSOLUTE turbo JS, NO shell — see below.
    // `--force` is a DIRECT turbo argument here (`node <turbo> build … --force`), which is what actually
    // bypasses turbo's content-keyed cache so a deploy ALWAYS does a real compile. ⚠️ Do NOT "simplify"
    // this to `pnpm --filter @loom/web build --force`: there `--force` is forwarded to the package's build
    // SCRIPT (vite), NOT to turbo, so the cache is NOT defeated and a stale build replays green (the
    // aad5fff3 footgun). Filters come from DEPLOY_PACKAGES (../deploy-packages.js) — the single source of
    // truth this deploy build shares with deploy-staleness.ts's signal (card c3ce92ea), so the two can't
    // silently diverge on which packages a deploy actually rebuilds. Covers @loom/daemon, @loom/shared, AND
    // @loom/web — the daemon serves packages/web/dist statically, so a deploy that only rebuilt the daemon
    // left the SERVED UI stale.
    // @decision 51522f05 — do NOT revert to a shell-invoked `pnpm exec turbo …` form: inside the daemon's
    // own spawned-process env that produced EMPTY captured output, turning a real build failure into an
    // undebuggable error.
    // @decision 3d7dccb9 — do NOT remove/bypass "stamp" from this invocation or let it run cached: an
    // uncached, same-invocation stamp is what guarantees the deploy's artifact identity reflects THIS
    // checkout, not a replayed cache entry from a different git worktree (turbo's cache is shared across all).
    // @decision 24f53a72 — `--force` on "build" does NOT also protect "build"'s own CACHE WRITE: turbo.json
    // excludes "!dist/build-info.json" from "build"'s outputs so a cache hit/restore, forced or not, can
    // never clobber what "stamp" (cache:false) most recently wrote.
    // Card bce50c22 — "skills-sync" (turbo.json: cache:false, dependsOn:["build"], same shape as "stamp")
    // rides the SAME invocation for the same reason: it used to run INSIDE @loom/daemon's cached "build"
    // script, so a cache hit (even --force'd builds still WRITE a cache entry a later non-forced deploy
    // could read) could leave this checkout's .claude/skills mirror unrefreshed. Omitting it here would
    // silently stop self-hosting deploys from ever picking up a merged assets/skills/** change.
    { label: "build", command: process.execPath, args: [turboBin(), "build", "stamp", "skills-sync", ...DEPLOY_PACKAGES.map((p) => `--filter=${p.name}`), "--force"], shell: false, timeoutMs: 0 },
  ];
}

/** Real, bounded, never-throws runner for one {@link BuildStep}. Resolves {code, out}; a spawn error or
 * timeout-kill resolves as a non-zero code (never rejects), so buildDaemon's loop stays simple. */
function runBuildStep(step: BuildStep, cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    const cap = (b: Buffer) => { out += b.toString(); if (out.length > 8000) out = out.slice(-8000); };
    const child = step.shell
      ? spawn(step.command, { cwd, shell: true, env: { ...process.env, CI: "1" } })
      : spawn(step.command, step.args, { cwd });
    let settled = false;
    const done = (r: { code: number; out: string }) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(r); };
    const timer = step.timeoutMs > 0
      ? setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } done({ code: 1, out: `${out}\n(${step.label} exceeded ${step.timeoutMs}ms — killed)` }); }, step.timeoutMs)
      : undefined;
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    child.on("error", (e) => done({ code: 1, out: `${out}\n${step.label} could not start: ${e.message}` }));
    child.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

/** Injectable seam for {@link buildDaemon} — a test swaps in a fake runner to record the steps + force
 * results (prove install→build order, the --force/--frozen-lockfile flags, and install-fail short-circuit)
 * without a real spawn. Defaults to {@link runBuildStep}. */
export interface BuildDeps {
  runStep?: (step: BuildStep, cwd: string) => Promise<{ code: number; out: string }>;
  /** Test-only repo-root override, so a hermetic test can point the snapshot/restore logic below (and the
   * build steps' cwd) at an isolated temp dir instead of the real checkout. Defaults to {@link repoRoot}. */
  root?: string;
}

/** packages/web/dist, relative to the repo root — the one directory the deploy build can actually wipe
 * out from under a failure (card 0eb97fa1). See the module comment above {@link snapshotWebDist} for why
 * only this path, not packages/daemon/dist or packages/shared/dist, needs protecting. */
const WEB_DIST_REL = path.join("packages", "web", "dist");

/**
 * Where a deploy's pre-build packages/web/dist snapshot lives — under LOOM_HOME (same home as
 * restart-intent.json), never inside the repo tree, so it can't collide with anything turbo/vite reads
 * or writes. A FIXED path, overwritten (never accumulated) by every deploy attempt that reaches the
 * build step — see {@link snapshotWebDist} for why that's also what makes an interrupted deploy
 * self-healing without any extra recovery code.
 */
function webDistBackupDir(): string {
  return path.join(LOOM_HOME, "deploy-backup", "web-dist");
}

/**
 * Snapshot packages/web/dist before the build step that can wipe it out from under a failure. Called
 * only immediately before the "build" step — never before "install", which never touches dist, so an
 * install failure (the common lockfile-drift case) pays zero snapshot cost. Best-effort: never throws
 * past its own call site (wrapped in try/catch by {@link buildDaemon}) — a snapshot failure must never
 * block the deploy itself, only leave that one deploy unprotected.
 *
 * @decision 0eb97fa1 — turbo's `clean` task wipes dist before EITHER a real build or a cache-hit
 * restore, so a failed deploy can leave the daemon serving a broken/missing UI; do NOT "fix" this by
 * removing/weakening `clean` — this snapshot/restore pair is the deliberate fix instead.
 */
function snapshotWebDist(root: string): void {
  const backup = webDistBackupDir();
  fs.rmSync(backup, { recursive: true, force: true }); // drop any orphaned backup from a crashed prior attempt
  const dist = path.join(root, WEB_DIST_REL);
  if (!fs.existsSync(dist)) return; // nothing pre-existing to protect (e.g. a brand-new checkout's first deploy)
  copyDirAtomic(dist, backup);
}

/**
 * Roll packages/web/dist back to its pre-build snapshot after a failed deploy build, then discard the
 * (now-consumed) snapshot. No-ops if no snapshot was taken (dist didn't exist pre-deploy — nothing to
 * roll back to, so a failed very-first deploy behaves exactly as it did before this fix). Best-effort:
 * never throws past its own call site — a restore failure must never mask the real build error.
 */
function restoreWebDist(root: string): void {
  const backup = webDistBackupDir();
  if (!fs.existsSync(backup)) return;
  copyDirAtomic(backup, path.join(root, WEB_DIST_REL));
  fs.rmSync(backup, { recursive: true, force: true });
}

/** Discard the pre-build snapshot after a successful deploy — the freshly-built dist is what needs
 * protecting NEXT time, so the old snapshot must not linger and bloat disk. Best-effort. */
function discardWebDistBackup(): void {
  fs.rmSync(webDistBackupDir(), { recursive: true, force: true });
}

/**
 * Copy `src` into `dest` atomically: build the copy at a sibling tmp path first, then swap it into place
 * with a rename, so a copy interrupted partway (crash, disk full) never leaves `dest` half-written.
 * Mirrors the tmp+rename pattern skills/inject.ts's copySkillAtomic uses for the same reason. Throws on
 * failure — callers decide how that's handled (see snapshotWebDist/restoreWebDist).
 */
function copyDirAtomic(src: string, dest: string): void {
  const tmp = `${dest}.loom-tmp`;
  fs.rmSync(tmp, { recursive: true, force: true }); // clear a stale tmp left by a prior interrupted attempt
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, tmp, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
}

/**
 * Rebuild the daemon for a deploy (the `daemon_restart` tool) WHILE the current daemon still runs its
 * in-memory code, so a broken/incomplete deploy aborts the restart and leaves the manager alive to fix
 * it — rather than exiting into a daemon that won't come back up. Runs {@link deployBuildSteps} IN ORDER
 * and SHORT-CIRCUITS on the first non-zero step (a failed install never reaches the build). Resolves the
 * exit code + a tail of output for the failure message; never throws (a spawn error → a non-zero code).
 *
 * Also snapshots/restores packages/web/dist around the "build" step (card 0eb97fa1) — see
 * {@link snapshotWebDist} — so a failed build leaves the previously-served UI intact instead of wiped.
 *
 * On a green build also returns `deploySha` — `dist/build-info.json`'s freshly-written stamp, read the
 * SAME way `deploy-staleness.ts` reads it for the running process (card 3af8674e DoD-4: a real, structural
 * sha, never scraped from a manager's free-text restart `reason`). `null` if the stamp can't be read.
 */
export function buildDaemon(deps: BuildDeps = {}): Promise<{ code: number; tail: string; deploySha?: string | null }> {
  const root = deps.root ?? repoRoot();
  const run = deps.runStep ?? runBuildStep;
  return (async () => {
    let lastOut = "";
    for (const step of deployBuildSteps(root)) {
      if (step.label === "build") {
        try { snapshotWebDist(root); }
        catch (e) { console.log(`[restart] pre-build dist snapshot failed (deploy continues unprotected): ${e instanceof Error ? e.message : String(e)}`); }
      }
      const r = await run(step, root);
      lastOut = r.out;
      if (r.code === 0) continue;
      let restoreNote = "";
      if (step.label === "build") {
        try { restoreWebDist(root); }
        catch (e) {
          restoreNote = `\n(warning: could not restore the pre-deploy packages/web/dist snapshot — ${e instanceof Error ? e.message : String(e)}. The previously-served UI may now be missing; the next successful deploy will rebuild it fresh.)`;
        }
      }
      // NEVER resolve with an empty failure tail — an empty spawn-env output would otherwise leave the
      // manager an UNDEBUGGABLE "build failed: <empty>" (exactly what 51522f05 hit). Always include the
      // command, cwd, exit code, and a marker when no output was captured.
      const captured = r.out.trim() ? r.out.trim().slice(-2500) : `(no ${step.label} output captured)`;
      const cmdStr = step.shell ? step.command : `${step.command} ${step.args.join(" ")}`;
      const hint = step.label === "install"
        ? "\nA merged package.json/lockfile change is likely out of sync — commit the updated pnpm-lock.yaml (or run `pnpm install` on main), then retry."
        : "";
      return { code: r.code, tail: `daemon ${step.label} FAILED (code=${r.code})\ncmd: ${cmdStr}\ncwd: ${root}${hint}${restoreNote}\n${captured}`.trim() };
    }
    try { discardWebDistBackup(); }
    catch (e) { console.log(`[restart] post-deploy snapshot cleanup failed (harmless): ${e instanceof Error ? e.message : String(e)}`); }
    const deploySha = readBuildInfo(path.join(root, "packages", "daemon", "dist")).sha;
    return { code: 0, tail: lastOut.trim().slice(-1500), deploySha };
  })();
}

/** The one file daemon_restart cannot make live itself — see {@link supervisorScriptChangedSince}. */
export const SUPERVISOR_SCRIPT_REL_PATH = "scripts/daemon-supervisor.mjs";

/**
 * Bound the deploy-time supervisor-diff check so a genuinely HUNG git call can't wedge the restart.
 * ⚠️ `boundedSimpleGit`'s `block` is an IDLE timeout, not a total-elapsed one (card 40a264d3 measured a
 * still-producing child run to 8.3x its block budget) — this does NOT bound a merely SLOW git log, only
 * one that stops producing output entirely. Exposure is low in practice: a single-pathspec `git log` is a
 * quiet child, so a hang here is almost always the idle kind `block` catches.
 */
const SUPERVISOR_CHECK_TIMEOUT_MS = 10_000;

/** Injectable git seam for {@link supervisorScriptChangedSince} — a hermetic test swaps in a fake
 * `git log` so it can assert the detection logic without a real repo/spawn. */
export interface SupervisorChangeDeps {
  gitLogSince?: (root: string, sinceIso: string, file: string) => Promise<string>;
}

/**
 * Card 469b5e67: this site used to call {@link boundedSimpleGit} with `.env({ ...process.env,
 * GIT_TERMINAL_PROMPT: "0" })`, which threw `GitPluginError` (`allowUnsafeEditor`/`allowUnsafePager`) on
 * an ambient `GIT_EDITOR`/`GIT_PAGER`/`PAGER`/`EDITOR`/`GIT_SEQUENCE_EDITOR`/`GIT_EXTERNAL_DIFF` (this
 * repo's own session spawn recipe sets `GIT_PAGER`/`PAGER`) and was silently swallowed into a
 * permanently-false "unchanged" advisory. simple-git's unsafe-operations check inspects only what's
 * EXPLICITLY PASSED to `.env()`, not the process's own inherited env, so omitting `.env()` entirely
 * sidesteps it altogether — the smaller fix than stripping those six keys.
 *
 * @decision 54b839c5 — do NOT reintroduce a `.env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })` override
 * here: `git log` performs no network operation, so `GIT_TERMINAL_PROMPT` has no live effect on it
 * regardless — same reasoning `vault/versioner.ts`'s `boundedVaultGit` documents for its own no-`.env()` call.
 */
async function defaultGitLogSince(root: string, sinceIso: string, file: string): Promise<string> {
  const git = boundedSimpleGit(root, SUPERVISOR_CHECK_TIMEOUT_MS);
  return git.raw(["log", `--since=${sinceIso}`, "--format=%H", "--", file]);
}

/**
 * The three states `supervisorScriptChangedSince` can resolve to. `reason` on `"could-not-check"` carries
 * the same message already logged by {@link supervisorScriptChangedSince}'s own `console.warn`, so an
 * up-stack caller that wants to surface WHY doesn't need to re-derive it.
 *
 * @decision 2e84a250 — deliberately a discriminated union, NOT a second boolean: a caller that folds this
 * back into a bare true/false is a TYPE ERROR, not a silent possibility.
 */
export type SupervisorCheckResult =
  | { status: "changed" }
  | { status: "unchanged" }
  | { status: "could-not-check"; reason: string };

/**
 * Whether the deploy about to go live touches `scripts/daemon-supervisor.mjs` — the daemon_restart
 * path (install → buildDaemon → relaunch) re-execs the DAEMON but NOT the outer supervisor process
 * that spawned it, so a committed change to that script (or its launch env — the env is set INSIDE
 * this script, e.g. a `UV_THREADPOOL_SIZE` bump, so watching the file covers the env case too, no
 * separate env-diff mechanism needed) is silently inert until a human does a manual `pnpm
 * daemon:stable`. Scope: everything committed since `bootTime` — a daemon only ever loses its
 * in-memory code on a restart, so "since this process booted" IS "since the last deploy"; no separate
 * last-deployed-SHA bookkeeping is needed. BEST-EFFORT + BOUNDED + NEVER throws: a git failure (no
 * repo, git unavailable, a genuinely HUNG child hitting {@link defaultGitLogSince}'s idle `block`
 * timeout — NOT a merely slow-but-producing one, see that function's own doc) resolves to
 * `{status:"could-not-check"}` — this is an ADVISORY warning only, so an inability to check must never
 * block the restart itself. A check failure is still logged here too (never thrown), so the daemon log
 * keeps its own independently-findable trace.
 *
 * @decision 2e84a250 — "checked, unchanged" and "could not check" must not be indistinguishable to a
 * caller: the two used to fold into one silent `false` with no trace of which happened — exactly the
 * failure mode that made an env bug in {@link defaultGitLogSince} invisible for as long as it was.
 */
export async function supervisorScriptChangedSince(bootTime: Date, deps: SupervisorChangeDeps = {}): Promise<SupervisorCheckResult> {
  try {
    const log = deps.gitLogSince ?? defaultGitLogSince;
    const out = await log(repoRoot(), bootTime.toISOString(), SUPERVISOR_SCRIPT_REL_PATH);
    return { status: out.trim().length > 0 ? "changed" : "unchanged" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(
      `[restart] could NOT check whether this deploy touches ${SUPERVISOR_SCRIPT_REL_PATH} — ` +
      `treating as unchanged, but this is a FAILED CHECK, not a confirmed negative: ${reason}`,
    );
    return { status: "could-not-check", reason };
  }
}

/** Advisory message surfaced on `daemon_restart`'s result when {@link supervisorScriptChangedSince} resolves `"changed"`. */
export const SUPERVISOR_CHANGED_WARNING =
  `this deploy modifies the supervisor (${SUPERVISOR_SCRIPT_REL_PATH}); a manual \`pnpm daemon:stable\` restart is required for those lines to take effect.`;

/**
 * Card 2e84a250: surfaced on `daemon_restart`'s result (and the post-restart nudge) when
 * {@link supervisorScriptChangedSince} resolves `"could-not-check"` — deliberately worded as blunt as
 * {@link SUPERVISOR_CHANGED_WARNING}, not softened into "may not have been verified": the defect this
 * closes was exactly a failure reading as a clean negative, so this must read as unmistakably UNKNOWN.
 */
export const SUPERVISOR_CHECK_FAILED_WARNING =
  `could not confirm whether this deploy touches the supervisor (${SUPERVISOR_SCRIPT_REL_PATH}) — the check itself failed (see the daemon log for the underlying error); treat this as UNKNOWN, not confirmed unchanged — verify directly or run \`pnpm daemon:stable\` if in doubt.`;

/**
 * Card 2e84a250: pure derivation of the manager-facing response fields from a {@link SupervisorCheckResult}
 * — factored out of `requestDaemonRestart` so the "could-not-check must be distinguishable from a genuine
 * unchanged" invariant (card DoD-4) is unit-testable directly, without a real build/spawn. `"unchanged"`
 * returns `{}` — byte-identical to the pre-card behavior on the common case, so every existing consumer
 * that only ever checked `supervisorChanged` truthiness keeps working unmodified.
 */
export function supervisorCheckResponseFields(
  check: SupervisorCheckResult,
): { supervisorChanged?: boolean; supervisorCheckFailed?: boolean; supervisorWarning?: string } {
  switch (check.status) {
    case "changed": return { supervisorChanged: true, supervisorWarning: SUPERVISOR_CHANGED_WARNING };
    case "could-not-check": return { supervisorCheckFailed: true, supervisorWarning: SUPERVISOR_CHECK_FAILED_WARNING };
    case "unchanged": return {};
  }
}
