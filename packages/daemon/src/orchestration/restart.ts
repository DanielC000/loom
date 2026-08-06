import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { simpleGit } from "simple-git";
import type { SessionRole } from "@loom/shared";
import { LOOM_HOME } from "../paths.js";
import { writeJsonAtomic } from "../pty/claude-config.js";
import { DEPLOY_PACKAGES } from "../deploy-packages.js";
import type { CapQueuedSpawn } from "./cap-queue.js";

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
   * Card 9e27f4d2 — the give-up HOLD half of `pending`'s snapshot, kept in a wholly separate, ADDITIVE
   * field rather than folding it into `pending`'s own element type. `pending[id][i]` still within its
   * post-give-up hold window (host.ts's `isGiveUpHeld`/`GIVE_UP_HOLD_MS`) has its `giveUpHeldUntil`
   * deadline recorded here as `pendingHolds[id][i]` — SAME session key, SAME index into that session's
   * `pending` array — instead of on the entry itself.
   *
   * WHY NOT JUST WIDEN `pending`'S ELEMENT TYPE (code review on this same card measured the alternative
   * and rejected it): `RestartIntent` is un-versioned JSON on disk (`readRestartIntent` is a bare
   * `JSON.parse(...) as RestartIntent`, no schema/version check) that an OLDER daemon binary can read —
   * this project's own documented pattern of running a second stable daemon from a separate checkout
   * sharing `~/.loom`, or a rollback landing in the gap between this daemon's exit-75 and the supervisor's
   * relaunch. An older daemon's replay expects `pending[id][i]` to always be a plain string; handed an
   * object instead, `enqueueStdin`'s `kind:"agent"` path short-circuits BOTH pre-fix shape guards
   * (`sanitizeLoneSurrogates`/`isUntaggedSystemNudge`) before either inspects the value, and the eventual
   * `.map(m=>m.text).join()` silently string-coerces it to `"[object Object]"` — the real message TEXT is
   * gone, with no throw and no log. That is exactly the LOSS class this card's own constraint forbids
   * ("fail toward a duplicate, never a loss"), reintroduced by the FIX meant to prevent a duplicate.
   * Keeping `pending` a bare `string[]` and carrying the hold as this wholly separate, additive field
   * means an older daemon reading a newer intent sees only strings it already knows how to handle — an
   * unheld duplicate (the ALREADY-ACCEPTED pre-this-card behavior), never a garbled loss. Absent when
   * nothing captured was still held (the overwhelmingly common case).
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
 * part 2). Used to correlate a deploy restart's `reason` (which a manager typically stamps with the
 * deployed SHA) against a later "X COMPLETE + DEPLOYED" completion escalation that names the SAME SHA —
 * so the second turn can be suppressed once the restart wake already delivered that SHA. Lower-cased +
 * de-duped. PURE + exported for the hermetic test. False positives are mild (the de-dup only fires when
 * the SAME token appears in BOTH the deploy reason and the escalation, and the durable board task is
 * always still filed), so a permissive hex match is the right trade.
 */
export function extractCommitShas(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(/\b[0-9a-f]{7,40}\b/gi)) out.add(m[0].toLowerCase());
  return [...out];
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
    // source). Invoke turbo via ABSOLUTE node + ABSOLUTE turbo JS, NO shell — the 51522f05 fix (the old
    // `pnpm exec turbo …` form failed inside the daemon's spawned-process env with EMPTY captured output).
    // `--force` is a DIRECT turbo argument here (`node <turbo> build … --force`), which is what actually
    // bypasses turbo's content-keyed cache so a deploy ALWAYS does a real compile. ⚠️ Do NOT "simplify"
    // this to `pnpm --filter @loom/web build --force`: there `--force` is forwarded to the package's build
    // SCRIPT (vite), NOT to turbo, so the cache is NOT defeated and a stale build replays green (the
    // aad5fff3 footgun). Filters come from DEPLOY_PACKAGES (../deploy-packages.js) — the single source of
    // truth this deploy build shares with deploy-staleness.ts's signal (card c3ce92ea), so the two can't
    // silently diverge on which packages a deploy actually rebuilds. Covers @loom/daemon, @loom/shared, AND
    // @loom/web — the daemon serves packages/web/dist statically, so a deploy that only rebuilt the daemon
    // left the SERVED UI stale.
    { label: "build", command: process.execPath, args: [turboBin(), "build", ...DEPLOY_PACKAGES.map((p) => `--filter=${p.name}`), "--force"], shell: false, timeoutMs: 0 },
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
 * Snapshot packages/web/dist before the build step that can wipe it out from under a failure — card
 * 0eb97fa1: turbo.json's `clean` task runs unconditionally ahead of `@loom/web`'s `build` task, so a
 * deploy build that then fails (tests, typecheck, or vite itself) currently leaves the daemon serving a
 * broken/missing UI while reporting itself healthy (the old dist was already deleted; nothing rebuilt
 * it). Called only immediately before the "build" step — never before "install", which never touches
 * dist, so an install failure (the common lockfile-drift case) pays zero snapshot cost.
 *
 * Best-effort: never throws past its own call site (wrapped in try/catch by {@link buildDaemon}) — a
 * snapshot failure must never block the deploy itself, only leave that one deploy unprotected.
 *
 * INTERRUPTED-DEPLOY CASE: if the daemon process dies mid-build (after this snapshot is taken but before
 * the matching restore/discard runs — see buildDaemon), the backup is simply left on disk. It is not a
 * growing leak: the FIRST line here unconditionally clears any existing backup before taking a new one,
 * so the very next deploy attempt that reaches the build step overwrites the orphan with a fresh
 * snapshot. Worst case is one extra dist-sized copy sitting under LOOM_HOME until then — never served,
 * never user-visible, never accumulating. A crash between the wipe and a restore does mean the UI stays
 * broken until that next deploy attempt (successful or not) resolves it; that gap needs a human to notice
 * the crash and re-run the supervisor regardless (see CLAUDE.md), so it isn't made worse by this design.
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
 */
export function buildDaemon(deps: BuildDeps = {}): Promise<{ code: number; tail: string }> {
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
    return { code: 0, tail: lastOut.trim().slice(-1500) };
  })();
}

/** The one file daemon_restart cannot make live itself — see {@link supervisorScriptChangedSince}. */
export const SUPERVISOR_SCRIPT_REL_PATH = "scripts/daemon-supervisor.mjs";

/** Bound the deploy-time supervisor-diff check so a hung/slow git call can't wedge the restart. */
const SUPERVISOR_CHECK_TIMEOUT_MS = 10_000;

/** Injectable git seam for {@link supervisorScriptChangedSince} — a hermetic test swaps in a fake
 * `git log` so it can assert the detection logic without a real repo/spawn. */
export interface SupervisorChangeDeps {
  gitLogSince?: (root: string, sinceIso: string, file: string) => Promise<string>;
}

async function defaultGitLogSince(root: string, sinceIso: string, file: string): Promise<string> {
  const git = simpleGit(root, { timeout: { block: SUPERVISOR_CHECK_TIMEOUT_MS } }).env({ ...process.env, GIT_TERMINAL_PROMPT: "0" });
  return git.raw(["log", `--since=${sinceIso}`, "--format=%H", "--", file]);
}

/**
 * Whether the deploy about to go live touches `scripts/daemon-supervisor.mjs` — the daemon_restart
 * path (install → buildDaemon → relaunch) re-execs the DAEMON but NOT the outer supervisor process
 * that spawned it, so a committed change to that script (or its launch env — the env is set INSIDE
 * this script, e.g. a `UV_THREADPOOL_SIZE` bump, so watching the file covers the env case too, no
 * separate env-diff mechanism needed) is silently inert until a human does a manual `pnpm
 * daemon:stable`. Scope: everything committed since `bootTime` — a daemon only ever loses its
 * in-memory code on a restart, so "since this process booted" IS "since the last deploy"; no separate
 * last-deployed-SHA bookkeeping is needed. BEST-EFFORT + BOUNDED + NEVER throws: a git failure (no
 * repo, git unavailable, timeout) degrades to `false` — this is an ADVISORY warning only, so an
 * inability to check must never block the restart itself.
 */
export async function supervisorScriptChangedSince(bootTime: Date, deps: SupervisorChangeDeps = {}): Promise<boolean> {
  try {
    const log = deps.gitLogSince ?? defaultGitLogSince;
    const out = await log(repoRoot(), bootTime.toISOString(), SUPERVISOR_SCRIPT_REL_PATH);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Advisory message surfaced on `daemon_restart`'s result when {@link supervisorScriptChangedSince} is true. */
export const SUPERVISOR_CHANGED_WARNING =
  `this deploy modifies the supervisor (${SUPERVISOR_SCRIPT_REL_PATH}); a manual \`pnpm daemon:stable\` restart is required for those lines to take effect.`;
