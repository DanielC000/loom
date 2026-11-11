/**
 * Loom Companion — the `attention-push` WATCHER (Companion Capability & Permission-Lever Framework §4).
 *
 * Deliberately NOT a capability-registry lever (companion/capabilities.ts): it never registers an MCP tool,
 * so there is no `register()`/`CompanionCapability` descriptor for it in `COMPANION_CAPABILITIES`. Instead
 * it is a daemon-owned, per-companion, per-tick WATCHER — a sibling of `CompanionHeartbeatWatcher` /
 * `CompanionReminderWatcher` — armed/disarmed by `CompanionController` exactly like those two. It still
 * reads its grant through the SAME `resolveCompanionGrant(db, sessionId, "attention-push")` chokepoint
 * (companion/capabilities.ts) every tick, so it is default-off + per-project-scoped identically to every
 * other lever, WITHOUT being mounted by `registerCompanionCapabilities`.
 *
 * MECHANISM: a tail-poll over the durable `orchestration_events` log keyed on `Db.listEventsSince`'s `seq`
 * cursor — NEVER sqlite's own `rowid` (a hard-deleted row's rowid can be REUSED, which would silently
 * retire the watermark past a reused id and drop a real alert forever; `seq` is never-reused and monotonic
 * — see its doc in db.ts's SCHEMA).
 *
 * @decision sha:31ca9b5d
 *
 * Also NOT the single-slot
 * `Db.setEventListener` the alert-webhook emitter (orchestration/alert-webhook.ts) already occupies — that
 * slot can hold only one subscriber, and this watcher needs its OWN per-session watermark anyway (a
 * listener callback has no natural per-companion cursor). Each tick: resolve the grant, gate on
 * live/not-parked/not-stacking (mirroring the heartbeat's disciplines), union-merge the granted projects'
 * `{alertClasses, digestMinutes}` config, scan new events since the watermark, classify + scope-filter them,
 * then either push each immediately or accumulate into a digest — see `tick()`.
 *
 * DEFAULT-OFF: `resolveCompanionGrant` returns null with no `attention-push` grant row for this session, so
 * an ungranted companion's tick is a single cheap grant lookup and nothing else — no event scan, no push,
 * byte-identical to a world where this watcher doesn't exist. The CompanionController only builds/starts one
 * per session that resolves a grant at all (see controller.ts's `rearmAttentionPushFor`).
 */
import { randomUUID } from "node:crypto";
import { columnKeyForRole, resolveConfig as resolveLoomConfig, type OrchestrationEvent } from "@loom/shared";
import type { Db } from "../db.js";
import { MODAL_RESOLVE_STEPS } from "../pty/modal-hold-text.js";
import type { HeartbeatPty } from "./heartbeat.js";
import { resolveCompanionGrant, type ResolvedGrantScope } from "./capabilities.js";
import { inAppHomeRoute } from "./in-app.js";
// CR round 4, item 7 (card 015fdb23): imported from the LEAF module, never `../skills/permission-scan.js`
// — that file pulls in `inject.js` + pty-doctrine transitively, weight this module has no need for.
import { CWD_SKILLS_SCAN_SCOPE } from "../pty/claude-dirname.js";
// Card f39341d5, item 4: VECTOR_TEXT is permissionWidening.ts's own shared label source (card f39341d5,
// item 3 — the SAME source permission-scan.ts's SKILL_PERMISSION_FIELD_LABEL now derives its `.terse`
// half from). Imported from THIS leaf module rather than permission-scan.ts for the same weight reason
// as CWD_SKILLS_SCAN_SCOPE just above — permissionWidening.ts has no fs/pty-doctrine imports at all.
import { VECTOR_TEXT } from "../skills/permissionWidening.js";

/** The trusted-daemon framing tag — also the marker the no-stacking guard matches in the pending queue
 *  (mirrors HEARTBEAT_TAG/REMINDER_TAG). */
export const ALERT_TAG = "[loom:alert]";

/** The alert-class allowlist (Framework §4's `attention-push` config schema: `alertClasses: string[]`) —
 *  exported so the grants config validator (gateway/server.ts) can reject an unknown/typo'd class at write
 *  time, and so this module's own classify() stays the single source of truth for what's valid. */
export const ATTENTION_ALERT_CLASSES = [
  "merge-gate", "worker-blocked", "worker-crashed", "decision-pending",
  "manager-idle", "context-overflow", "escalation", "usage-limit", "notice",
] as const;
export type AttentionAlertClass = (typeof ATTENTION_ALERT_CLASSES)[number];

/**
 * FLEET-OPS classes — routine day-to-day fleet operations a manager handles autonomously, distinct from
 * the remaining OWNER-SIGNAL classes, which genuinely need the owner's attention. Excluded ONLY from
 * Companion "lead mode"'s `"*"` wildcard PUSH subscription (the `"*"` branch in `resolveConfig` below, the
 * ONE place this list is consulted) — an explicit `alertClasses` entry naming one of these classes always
 * still gets pushed, wildcard or not.
 *
 * @decision b5c606aa
 */
export const FLEET_OPS_ALERT_CLASSES: ReadonlySet<AttentionAlertClass> = new Set(["merge-gate", "worker-blocked", "worker-crashed", "manager-idle"]);

/** Bounds one tick's tail-scan — a long-idle watermark reads at most this many rows per tick rather than
 *  an unbounded backlog (the injection-exposed-adjacent posture this repo applies to every scan surface). */
const EVENT_TAIL_LIMIT = 200;
/** Digest turn cap (Lead build sequence step 4: "bulleted, cap ~20 + '+N more'"). */
const DIGEST_MAX_LINES = 20;
/** CR fold-in [3]: immediate mode has no per-turn cap by default (unlike digest, which caps at
 *  DIGEST_MAX_LINES) — a single tick finding MORE than this many qualifying events coalesces them into ONE
 *  digest-style turn instead of firing one companion turn (one owner-facing message) PER event, so a fleet
 *  burst can't spam dozens of separate turns from a single tick. */
const IMMEDIATE_BURST_CAP = 10;
/** CR fold-in [5]: a hard cap on one rendered alert line, so an unbounded source field (e.g. question_ask's
 *  `title`, an agent-authored `z.string()` with no length limit) can never produce a pathologically long
 *  chat line. Applied once, at the end of `alertLine`, regardless of which case produced the text. */
const ALERT_LINE_MAX_CHARS = 200;
/** CR fold-in [5]: a tighter cap on the title specifically (nested inside the quoted "..." in the
 *  decision-pending line) — keeps a long title from dominating the line before the overall cap even
 *  applies. */
const ALERT_TITLE_MAX_CHARS = 100;
/** @decision 015fdb23 — CR round 4, item 5: bounds how many truncated-skill names one
 *  `skill_permission_frontmatter_warning` truncation entry names in the Companion alert line, so a
 *  pathological entries-cap hit doesn't dominate the line before `ALERT_LINE_MAX_CHARS` even applies. */
const TRUNC_NOTE_NAMES_MAX = 3;
/** Card f39341d5, round 3 (second Code Review, Major 2): each truncNote name is a skill DIRECTORY name
 *  read straight from the scanned repo — unbounded on its own even after TRUNC_NOTE_NAMES_MAX limits how
 *  MANY are shown. Two realistic ~80-char names were enough to push the who id and the incomplete note
 *  past the final ALERT_LINE_MAX_CHARS trim before this cap existed. */
const TRUNC_NOTE_NAME_MAX_CHARS = 24;
/** Card f39341d5, round 3 (second Code Review, Major 2): this case's own line carries more fixed + free
 *  text (role, who, the incomplete/truncation notes, the scope clause) than any other `alertLine` case,
 *  so an ordinary-length project name that's harmless everywhere else can still crowd the who id out of
 *  this one. Capped ONLY for this case — every other case leaves `projectName` exactly as the caller
 *  passed it. */
const SKILL_WARNING_PROJECT_NAME_MAX_CHARS = 40;
/** Card ee05750e: same pattern as ALERT_TITLE_MAX_CHARS. By the time a reason reaches this surface it has
 *  already passed `normalizeResumeOneResult`'s allowlist (resume-nudge.ts) — never an arbitrary re-thrown
 *  message — but one of the 7 allowlisted messages is itself up to ~140 chars; this keeps ANY one reason
 *  from dominating the fleet_resume_failed/manager_crash_resume_failed line before the overall
 *  ALERT_LINE_MAX_CHARS cap even applies. */
const ALERT_RESUME_REASON_MAX_CHARS = 60;
/** Cap on `projectName` for the title-bearing lines (question_asked/amended, request_escalated,
 *  platform_escalate), same precedent as SKILL_WARNING_PROJECT_NAME_MAX_CHARS. The worst-case fixed part of
 *  those lines (verb, a task ref with two full UUIDs, the cut flag, separators, the `(m:…)` suffix) is ~160
 *  chars before the name, so an uncapped name used to leave the title no room and let the final end-trim
 *  chop the flag / suffix. 30 keeps the worst case under ALERT_LINE_MAX_CHARS with room for a title stub. */
const TITLED_ALERT_PROJECT_NAME_MAX_CHARS = 30;

/** Assemble `${head} [flag] — "title"${tail}` within ALERT_LINE_MAX_CHARS BY CONSTRUCTION: `head` (verb, refs,
 *  capped project name) and `tail` (the `(m:…)` suffix) are never trimmed; only the title shrinks to what
 *  room remains, and when it is cut (by ALERT_TITLE_MAX_CHARS or by lack of room) `hint` is inserted. The
 *  caller's final end-trim therefore never removes the flag or suffix. "≤200 by construction" assumes
 *  daemon-stamped UUID-length ids in `head` (and the 30-char project-name cap); a pathologically long
 *  head can still leave the title no room, and only then does the caller's end-trim apply.
 *
 *  `optionals` are droppable suffixes rendered after `tail`, in the given order, LOWEST priority FIRST:
 *  over budget they are dropped from the front of the array (one at a time) BEFORE the title is shrunk, so
 *  priority is head + hint + tail > title > optionals (last element highest). */
function fitTitledLine(head: string, rawTitle: string, hint: string, tail: string, optionals: string[] = []): string {
  const wrap = (t: string, flag: string, sfx: string): string => `${head}${flag} — "${t}"${tail}${sfx}`;
  const plain = truncateText(rawTitle, ALERT_TITLE_MAX_CHARS);
  const flag = plain === rawTitle ? "" : hint;
  for (let k = 0; k <= optionals.length; k++) {
    const candidate = wrap(plain, flag, optionals.slice(k).join(""));
    if (candidate.length <= ALERT_LINE_MAX_CHARS) return candidate;
  }
  const room = ALERT_LINE_MAX_CHARS - wrap("", hint, "").length;
  return wrap(truncateText(rawTitle, Math.min(ALERT_TITLE_MAX_CHARS, Math.max(room, 1))), hint, "");
}

/** Truncate `s` to at most `maxChars`, appending an ellipsis marker when cut. A no-op when already short
 *  enough — never lengthens or otherwise mutates a line that's already within bounds. */
function truncateText(s: string, maxChars: number): string {
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
}

/** Card f39341d5 (CR MAJOR fix, `skill_permission_frontmatter_warning`; round 3 correction — second
 *  Code Review, Major 1): fit a "name1, name2 (label1, label2)"-shaped segment into `budget` characters.
 *  NAMES take priority: at least the first name, or a "+N more" tail, is kept before labels get any of
 *  what's left, and a labels suffix is NEVER emitted when no name survives — the opposite of the
 *  original round, which degraded labels first and could starve names entirely (a realistic 3-finding
 *  case rendered "… frontmatter in  (allowed-tools:, hooks:, …)", naming no skill at all). The caller
 *  reserves room for every other, non-degradable part of the line FIRST — the who id, the incomplete-
 *  scan note, the scope clause, the truncation note — so this segment, being the one genuinely
 *  unbounded field, is what the final ALERT_LINE_MAX_CHARS trim ends up cutting if anything still
 *  overflows. Labels are deduplicated across every finding by the caller, so in practice this almost
 *  never needs to touch them — only names (which can be arbitrarily many) usually need bounding. */
function fitNamesAndLabels(names: string[], labels: string[], budget: number): string {
  let namesOut = "";
  for (let keep = names.length; keep >= 0; keep--) {
    const shown = names.slice(0, keep);
    const more = names.length - keep;
    const candidate = more > 0
      ? `${shown.length ? `${shown.join(", ")}, ` : ""}+${more} more`
      : shown.join(", ");
    if (candidate.length <= budget) { namesOut = candidate; break; }
    // Even the bare "+N more" marker doesn't fit this budget — omit names entirely rather than ever
    // exceeding it (a forced "last resort" that still overflows would defeat the whole point).
    if (keep === 0) { namesOut = ""; break; }
  }
  if (!namesOut) return ""; // no room for even one name/"+N more" — never show a labels-only suffix.
  let labelsSuffix = "";
  const labelsBudget = Math.max(0, budget - namesOut.length);
  for (let keep = labels.length; keep >= 0; keep--) {
    const shown = labels.slice(0, keep);
    const more = labels.length - keep;
    const parts = more > 0 ? [...shown, `+${more} more`] : shown;
    const candidate = parts.length ? ` (${parts.join(", ")})` : "";
    if (candidate.length <= labelsBudget) { labelsSuffix = candidate; break; }
    if (keep === 0) { labelsSuffix = ""; break; }
  }
  return `${namesOut}${labelsSuffix}`;
}

/** Frame a single immediate alert as a clearly-marked, no-stacking-guarded turn. */
export function framedAlert(text: string): string {
  return `${ALERT_TAG} ${text}`;
}

/** Frame a bundled digest turn — bulleted, capped at DIGEST_MAX_LINES with a "+N more" tail. Also reused by
 *  the immediate-mode burst cap (IMMEDIATE_BURST_CAP) for its own coalesced turn — same shape, different
 *  caller. */
export function framedDigest(lines: string[]): string {
  const shown = lines.slice(0, DIGEST_MAX_LINES);
  const extra = lines.length - shown.length;
  const bullets = shown.map((l) => `• ${l}`).join("\n");
  return `${ALERT_TAG} ${lines.length} alert${lines.length === 1 ? "" : "s"}:\n${bullets}${extra > 0 ? `\n+${extra} more` : ""}`;
}

/**
 * Classify one orchestration event into an `AttentionAlertClass`, or null if it isn't a subscribed signal
 * source (see the build spec's ALERT-CLASS MAP). `detail` is read through a cast — matches every other
 * `detail` consumer in this codebase (attention.ts, alert-webhook.ts). NOTE: `merge_done` is a signal the
 * spec's build sequence names in its SIGNAL SOURCES inventory but the ALERT-CLASS MAP deliberately does NOT
 * map to any class ("merge-gate" lists only merge_rejected/merge_request) — a landed merge is the
 * RESOLUTION of a merge_request, not its own alert (matches web/attention.ts's latestMerge pairing, which
 * treats merge_done as clearing the pending state rather than raising a new one) — confirmed correct by
 * Code Review, KEEP AS-IS.
 *
 * @decision b4080777 — `merge_landing_aborted` is likewise DELIBERATELY excluded (no case below): a
 * refused batch ff may still land via a real per-candidate solo fallback, so pushing a "merge-gate" alert
 * here would be a spurious companion notification for an outcome that may not hold moments later.
 */
export function classify(kind: string, detail: Record<string, unknown> | undefined): AttentionAlertClass | null {
  switch (kind) {
    case "merge_rejected":
    case "merge_request":
      return "merge-gate";
    case "worker_stuck":
      return "worker-blocked";
    case "worker_report":
      return detail?.status === "blocked" ? "worker-blocked" : null;
    case "worker_exited_without_report":
    case "session_recovery_abandoned":
    // Card 9e4205f5: same family as `session_recovery_abandoned` — sessions that did not come back. This
    // is the ONLY owner a fleet-resume failure has in the shipped (non-LOOM_DEV) product, where no
    // `role === "platform"` session can ever exist to receive the identified nudge `resumeFleetOnBoot`
    // sends when a Lead IS live (see sessions/service.ts's `liveLead` branch — unchanged by this card).
    case "fleet_resume_failed":
      return "worker-crashed";
    // Card 0c90ebe4: `fleet_resume_failed`'s crash-path sibling — a manager `recoverCrashOrphanedWorkers`
    // could not resume after a genuine crash. Same class: the manager itself has no live pty left to
    // receive a direct nudge, and no platform-role session may exist to receive a Lead-only notice.
    case "manager_crash_resume_failed":
      return "worker-crashed";
    // Card c5415a04: the per-entry sibling of `fleet_resume_failed` above — gated on `detail.resumeFailed`
    // (set by `recordEntryCrash`, sessions/service.ts), NEVER on matching `detail.reason`'s free text,
    // which is free to keep changing wording. `resumeFailed:true` means a GENUINE resume failure; `false`
    // means the entry actually resumed and only its continuation nudge failed to compose/deliver — that
    // case is already a live, healthy session (its manager gets a targeted worker_message prompt instead,
    // via the parent-nudge text) and must never alert as "crashed".
    case "fleet_resume_entry_failed":
      return detail?.resumeFailed === true ? "worker-crashed" : null;
    // Card e07b1b1a: a manager/platform recycle whose successor died before SessionStart — the fleet was
    // either recovered back onto the (still-live) predecessor or left in an unresolved state; either way
    // this is the same "unexpected fleet-ownership fault, human should know" shape as fleet_resume_failed.
    case "recycle_fleet_recovered":
    case "recycle_fleet_unresolved":
      return "worker-crashed";
    // Code Review round 2 (m2): a human who got the "unresolved" push for this same recycle never heard it
    // was later resolved without this — map it into the SAME class as its siblings above so it reaches
    // whatever surface already carries them, rather than being silently dropped by the `default: null` below.
    case "recycle_fleet_resolved":
      return "worker-crashed";
    // @decision 08c81809 — the settle loop that would have fired recycle_fleet_recovered/unresolved
    // above never ran at all (lost to a daemon restart mid-window); the boot-time reconcile found no
    // possible automatic owner. Same "unexpected fleet-ownership fault" shape, same class.
    case "recycle_fleet_stranded_across_restart":
      return "worker-crashed";
    // Card 4775165f: a halted recycle's both-dead lineage consolidated onto the predecessor at boot
    // (`a4c5f234`) — same "unexpected fleet-ownership fault, human should know" shape as its recycle_fleet_*
    // siblings above. Dedup against a genuinely duplicate filing of the SAME lineage is handled separately,
    // in `tick()`/`stampConsolidatedLineage` below — never assume the source event fires at most once.
    case "recycle_split_lineage_consolidated":
      return "worker-crashed";
    // Card 68f27faf: a `type:"notice"` ask is a distinct, owner-signal class of its own — "notice" — never
    // "decision-pending" (nothing is pending for a self-terminal notice; see its own `state:"notice"`,
    // b13df292). Discriminated on `detail.type`, stamped into the event's own detail by the shared
    // `appendQuestionAskedEvent` helper (mcp/questionTool.ts) — card c0c9ca4a: called from BOTH the
    // manager's question_ask (mcp/orchestration.ts) and the Platform Lead's (mcp/platform.ts), never
    // re-derived from the question row itself, which this event's detail is the only trace of by the
    // time a tail-poll tick classifies it.
    case "question_asked":
      return detail?.type === "notice" ? "notice" : "decision-pending";
    // Card 5ea0153c: a still-pending ask's content just changed IN PLACE (question_amend) — same class as
    // the original ask, since the human still owes the SAME decision, just with fresher wording.
    case "question_amended":
      return "decision-pending";
    // Card 99d41588: a Request going STALE is still fundamentally "a decision needs the human" — same
    // class as the original ask, not a new one; what differs is the LINE (see alertLine below), which
    // must carry the age so this reads as an escalation, not a duplicate of the original push.
    case "request_escalated":
      return "decision-pending";
    case "idle_escalated":
      return "manager-idle";
    case "idle_report":
      return detail?.state === "done" ? "manager-idle" : null;
    case "context_escalated":
    // Card fdf1291f: same alert class as context_escalated — both are "this manager's context is at
    // risk and the queued nudge can't reach it," just detected via a different, turn-boundary-
    // independent signal (see the kind's own doc in shared/src/types.ts).
    case "context_blind_turn":
    // Card 66ff7321: the manager/platform twin of worker_context_exhausted below — a manager/platform
    // session's own context EXHAUSTED (the terminal "Prompt is too long" api-error, not merely high).
    // Same class as its context_escalated/context_blind_turn siblings: nothing automated is left to
    // notify (no parent to push into), so this is the human-attention surface's job via lastError too.
    case "manager_context_exhausted":
    // Companion (assistant-role) twin of the above: a distinct kind so the web/fleet "recycle it" surfaces
    // never misread it, but the same human-attention class.
    case "assistant_context_exhausted":
      return "context-overflow";
    // Card 66ff7321: a WORKER's own context EXHAUSTED — same "the owning manager already got a direct
    // nudge, this is the secondary attention-surface sighting" shape as worker_stuck above.
    case "worker_context_exhausted":
      return "worker-blocked";
    case "platform_escalate":
      return "escalation";
    case "session_rate_limited":
      return "usage-limit";
    // Card e2a3c613: only when nobody else was addressed (`parentNudged:false` — a manager, the platform
    // Lead, or a parentless worker/setup/run/assistant; a covered case with a live manager parent is
    // handled by that parent's own nudge instead, matching 01160ae3's scope).
    // Round 2 ruling (ownership-reversible): this event is BY DEFINITION the no-manager-addressed case —
    // the one party left to tell is the owner. "worker-crashed" is a FLEET_OPS class (see
    // FLEET_OPS_ALERT_CLASSES above), EXCLUDED from Companion lead-mode's `"*"` wildcard push subscription
    // — a lead-mode companion, the surface most likely to be the owner's actual attention channel here,
    // would silently never see it unless they'd also explicitly enumerated the class. Reuses "escalation"
    // instead (platform_escalate's class, not FLEET_OPS) — the same shape: nothing automated is left to
    // resolve this, a human must. See docs/decisions/e2a3c613-*.md for the full reasoning.
    case "claude_boot_dialog_stuck":
      return detail?.parentNudged === false ? "escalation" : null;
    // Card 015fdb23: "assistant" is the one locked role that runs in an ordinary, worker-writable user
    // project (see the background report behind this card) — its warning gets the owner-visible push;
    // every other in-scope role's is "notice" (durable, visible on the event log, not pushed by default).
    // Card 979f29b9: `detail.isRepeat` (stamped by SessionService.handleSkillPermissionFrontmatterWarning,
    // never re-derived here) suppresses the push on a repeat of the SAME (cwd, skill-content) set — the
    // durable event still lands every spawn either way, only the owner push is gated on this.
    case "skill_permission_frontmatter_warning":
      return detail?.role === "assistant" && detail?.isRepeat !== true ? "escalation" : "notice";
    // Card ab3c965d: a MANAGER's own turn-1 kickoff exhausted its give-up budget with no parent to
    // notify — same shape/reasoning as claude_boot_dialog_stuck immediately above (a manager always
    // sets parentNudged:false, since it never has a parent at all), reusing "escalation" for the same
    // reason: the owner is the one party left to tell, and this must reach a lead-mode companion's
    // wildcard push the same way (see claude_boot_dialog_stuck's own comment on FLEET_OPS_ALERT_CLASSES).
    // Card 5c2f8108 widened this kind to also cover role "platform" (the Platform Lead's own kickoff
    // drop) — unaffected here, since this gate is already role-agnostic (`parentNudged`, not `role`).
    case "manager_kickoff_dropped":
      return detail?.parentNudged === false ? "escalation" : null;
    // Card b1da256d: the RESOLVE half of the pair above — a resolve clears an already-filed alert, it is
    // never itself a fresh owner-facing one. Falls to `default` (null) structurally either way; named
    // explicitly so a reader doesn't have to re-derive that from the switch's fallthrough.
    case "claude_boot_dialog_resolved":
    // Card 5c2f8108: same reasoning, for `manager_kickoff_dropped`'s own RESOLVE half.
    case "manager_kickoff_dropped_resolved":
      return null;
    default:
      return null;
  }
}

/** Render ONE terse chat line for a classified event: `{project}: <what> — <who>` (8-char id slices),
 *  bounded to ALERT_LINE_MAX_CHARS (CR fold-in [5] — an unbounded source field, e.g. question_ask's title,
 *  must never produce a pathologically long line). */
export interface AlertLineOpts {
  /** `last_surfaced_at` of a reminder's question (global across recipients — see the reminder case). */
  lastReadAt?: string | null;
  /** The recipient holds a decisions-relay grant covering the event's project, so naming `decision_get`
   *  is actionable. Default false: the hint is omitted (a tool the recipient lacks is noise). */
  canFetchDecision?: boolean;
  /** `platform_escalate` only: the escalation card is in its home project's terminal column AS OF DELIVERY
   *  (a fresh re-read, not the enqueue-time stamp). Absent when the card can't be read. */
  taskTerminalNow?: boolean;
}

export function alertLine(e: OrchestrationEvent, alertClass: AttentionAlertClass, projectName: string, taskIdResolvable = true, opts: AlertLineOpts = {}): string {
  const canFetch = opts.canFetchDecision === true && alertClass !== "notice"; // decision_get refuses notices
  const truncHint = canFetch ? " [title TRUNCATED — fetch it with decision_get before answering]" : " [title TRUNCATED]";
  const detail = e.detail ?? {};
  const w8 = e.workerSessionId ? `w:${e.workerSessionId.slice(0, 8)}` : null;
  const m8 = `m:${e.managerSessionId.slice(0, 8)}`;
  const task8 = e.taskId ? `task:${e.taskId.slice(0, 8)}` : null;
  const who = [w8 ?? m8, task8].filter((s): s is string => !!s).join(" ");
  let line: string;
  switch (e.kind) {
    case "merge_rejected":
      line = `${projectName}: merge rejected — ${who}`;
      break;
    case "merge_request":
      line = `${projectName}: merge request awaiting review — ${who}`;
      break;
    case "worker_report":
      line = `${projectName}: worker blocked — ${who}`;
      break;
    case "worker_stuck":
      line = `${projectName}: worker stuck${typeof detail.minutesBusy === "number" ? ` (${detail.minutesBusy}m)` : ""} — ${who}`;
      break;
    case "worker_exited_without_report":
      line = `${projectName}: worker exited without report — ${who}`;
      break;
    case "session_recovery_abandoned":
      line = `${projectName}: crash-loop, auto-resume gave up — ${who}`;
      break;
    case "fleet_resume_failed": {
      // Card 9e4205f5: full cross-project identity is DELIBERATE here — this event's only consumer is
      // this human-facing surface (see the doc on the "fleet_resume_failed" kind in shared/src/types.ts),
      // unlike the count-only text the same restart sends a requesting manager (5a9a963b's invariant,
      // untouched). `detail.failed` entries are read defensively (a stale/foreign row is never trusted).
      const rawFailed = Array.isArray(detail.failed) ? detail.failed : [];
      const count = typeof detail.count === "number" ? detail.count : rawFailed.length;
      const idPreview = rawFailed
        .slice(0, 3)
        .map((f) => {
          const d = (f ?? {}) as Record<string, unknown>;
          const proj = typeof d.projectId === "string" ? d.projectId.slice(0, 8) : "?";
          const sess = typeof d.sessionId === "string" ? d.sessionId.slice(0, 8) : "?";
          const role = typeof d.role === "string" ? d.role : "plain";
          return `${role}@${proj}/${sess}`;
        })
        .join(", ");
      const more = rawFailed.length > 3 ? `, +${rawFailed.length - 3} more` : "";
      // Card ee05750e (Code Review S2): rendered AFTER the full id preview + more tail, never interleaved
      // per-entry — the ids (and the +N-more count) are the resolvable, load-bearing identity and must
      // survive the final ALERT_LINE_MAX_CHARS trim; a reason is free text that should be what's
      // sacrificed first on overflow, matching the same id-before-truncatable-text discipline
      // question_asked/request_escalated already use below. One representative reason (the first failed
      // entry that has one), not all of them — already allowlist-sanitized at the source, re-bounded here.
      const firstReasoned = rawFailed.find((f) => typeof (f as Record<string, unknown> | null)?.reason === "string" && (f as Record<string, unknown>).reason);
      const reasonSuffix = firstReasoned ? ` (${truncateText((firstReasoned as Record<string, unknown>).reason as string, ALERT_RESUME_REASON_MAX_CHARS)})` : "";
      line = `${projectName}: ${count} session(s) elsewhere in the fleet failed to resume after a restart` +
        (idPreview ? ` — ${idPreview}${more}` : "") + reasonSuffix;
      break;
    }
    case "manager_crash_resume_failed": {
      // Card 0c90ebe4: `detail.workers` describes only THIS event's own manager's stranded workers —
      // no cross-project identity to redact, unlike `fleet_resume_failed` above (see the kind's own doc).
      const rawWorkers = Array.isArray(detail.workers) ? detail.workers : [];
      const workerCount = typeof detail.workerCount === "number" ? detail.workerCount : rawWorkers.length;
      const idPreview2 = rawWorkers
        .slice(0, 3)
        .map((w) => {
          const d = (w ?? {}) as Record<string, unknown>;
          const sess = typeof d.workerSessionId === "string" ? d.workerSessionId.slice(0, 8) : "?";
          const task = typeof d.taskId === "string" ? `/task:${d.taskId.slice(0, 8)}` : "";
          return `w:${sess}${task}`;
        })
        .join(", ");
      const more2 = rawWorkers.length > 3 ? `, +${rawWorkers.length - 3} more` : "";
      // Card ee05750e (Code Review S2): the manager's OWN resume-failure reason — this is the specimen
      // the card names ("could not be resumed" with no reason) — rendered AFTER the worker id preview +
      // more tail (never before), same id-before-truncatable-text discipline as fleet_resume_failed above.
      // Already allowlist-sanitized + bounded at the source (normalizeResumeOneResult), re-bounded here.
      const reason2 = typeof detail.reason === "string" && detail.reason ? ` — ${truncateText(detail.reason, ALERT_RESUME_REASON_MAX_CHARS)}` : "";
      line = `${projectName}: manager could not be resumed after a crash, ${workerCount} in-flight worker(s) stranded — ${m8}` +
        (idPreview2 ? ` (${idPreview2}${more2})` : "") + reason2;
      break;
    }
    case "question_asked": {
      const rawTitle = typeof detail.title === "string" ? detail.title : "untitled";
      const pn = truncateText(projectName, TITLED_ALERT_PROJECT_NAME_MAX_CHARS);
      // Card e9688b1b: generalizes the platform_escalate fold-in below — carry the FULL questionId (not
      // an 8-char slice) so a decisions-relay-granted recipient can decisions_list() to resolve the full
      // title/body/options/recommendation; a truncated slice can't resolve. Placed BEFORE the (unbounded)
      // title, same placement discipline as platform_escalate's taskRef, so this id survives both the
      // title's own truncation AND the final ALERT_LINE_MAX_CHARS trim. And when the title itself was
      // cut, SAY SO explicitly rather than relying on the bare "…" to be noticed — a silent cut reads
      // exactly like a genuinely short question, and the measured incident (a Companion answering from
      // half a sentence, then retracting) is exactly this ambiguity turning into a wrong decision.
      const qRef = typeof detail.questionId === "string" ? ` (question:${detail.questionId})` : "";
      // Card 68f27faf: a notice needs no answer — "decision needed" would be actively wrong wording for it.
      line = fitTitledLine(
        alertClass === "notice" ? `${pn}: FYI${qRef}` : `${pn}: decision needed${qRef}`,
        rawTitle, truncHint, ` (${m8})`);
      break;
    }
    case "question_amended": {
      // Card 5ea0153c: same placement/truncation discipline as question_asked above — the resolvable
      // questionId goes BEFORE the (unbounded, truncatable) title, and a cut title says so explicitly.
      // Worded "amended", not "needed", so a recipient who already saw the original ask doesn't read this
      // as a duplicate — it is the SAME decision, updated wording, never a new row.
      const rawTitle = typeof detail.title === "string" ? detail.title : "untitled";
      const qRef = typeof detail.questionId === "string" ? ` (question:${detail.questionId})` : "";
      line = fitTitledLine(`${truncateText(projectName, TITLED_ALERT_PROJECT_NAME_MAX_CHARS)}: pending decision amended${qRef}`,
        rawTitle, truncHint, ` (${m8})`);
      break;
    }
    case "request_escalated": {
      // Card 99d41588: same placement discipline as question_asked above — the resolvable questionId goes
      // BEFORE the (unbounded, truncatable) title, so it survives both the title's own truncation and the
      // final ALERT_LINE_MAX_CHARS trim. Without an explicit case here this event would fall through to
      // the bare `default:` below (`${projectName}: decision-pending — ${m8}`) — no request id, no age, no
      // title — degrading this escalation to exactly the contentless passive signal the card exists to
      // defeat: live, but nothing a human could act on from the push alone.
      const rawTitle = typeof detail.title === "string" ? detail.title : "untitled";
      const qRef = typeof detail.questionId === "string" ? ` (question:${detail.questionId})` : "";
      const ageDays = typeof detail.ageMinutes === "number" ? Math.floor(detail.ageMinutes / 1440) : null;
      const ageStr = ageDays !== null
        ? ageDays >= 1 ? `${ageDays}d` : `${Math.round((detail.ageMinutes as number))}m`
        : "?";
      // `last_surfaced_at` is GLOBAL (not per-recipient) and stamped on every decisions_list row, so this
      // only says the decision was LISTED before — never that this recipient read or acted on it. Shown
      // only to a recipient that can list/fetch decisions, and placed LAST (after the title) so the final
      // trim can only ever eat the note, never the title.
      const listedNote = canFetch && opts.lastReadAt ? ` [listed before at ${opts.lastReadAt}]` : "";
      // Priority when over budget: verb + question ref + truncation hint > title > note > boilerplate tail.
      // fitTitledLine drops the optionals lowest-priority first (tail, then note) BEFORE shrinking the
      // title, so the final ALERT_LINE_MAX_CHARS end-trim is never what keeps the line in bounds.
      line = fitTitledLine(
        `${truncateText(projectName, TITLED_ALERT_PROJECT_NAME_MAX_CHARS)}: Request pending ${ageStr}, unanswered${qRef}`,
        rawTitle, truncHint, "", [" — please answer or dismiss it", listedNote]);
      break;
    }
    case "idle_escalated":
      line = `${projectName}: manager asleep, unanswered idle nudges — ${m8}`;
      break;
    case "idle_report":
      line = `${projectName}: manager queue drained — ${m8}`;
      break;
    case "context_escalated":
      line = `${projectName}: manager context overflow risk — ${m8}`;
      break;
    case "context_blind_turn":
      line = `${projectName}: manager mid-turn ${typeof detail.minutesBusy === "number" ? `~${detail.minutesBusy}m ` : ""}with no context reading — ${m8}`;
      break;
    case "platform_escalate": {
      const rawTitle = typeof detail.title === "string" ? detail.title : "untitled";
      // CR fold-in (companion re-delivery card): the FULL taskId (not the 8-char `task8` slice every other
      // case uses for human display) — a board-reach-granted companion (e.g. lead mode, which grants
      // board-reach act-mode on every project incl. the reserved Platform home) needs the EXACT id to
      // board_get(project:<platformProjectId>, taskId:<this>) the full escalation body; a truncated slice
      // can't resolve. Placed BEFORE the (unbounded) title so a long title's truncation (ALERT_LINE_MAX_CHARS)
      // trims the title's tail, never this id.
      // Card 91b9105e: a `platform_escalate` taskId lives on the Platform HOME project, never the
      // escalating manager's own origin project (see `canResolveEscalationTask`'s doc in tick()) — the
      // per-tick scope filter above only checked the ORIGIN project against this grant, saying nothing
      // about whether THIS recipient can actually resolve the home-project id. `taskIdResolvable` (computed
      // by the caller BEFORE this render) is false exactly when neither this session's own project nor its
      // `board-reach` grant can reach the home project — in that case the id is dropped from the line
      // rather than naming an id this recipient is structurally forbidden to resolve.
      const homeId = typeof detail.platformProjectId === "string" && detail.platformProjectId ? `@${detail.platformProjectId}` : "";
      const taskRef = e.taskId && taskIdResolvable ? ` (task:${e.taskId}${homeId})` : "";
      // Card f8abb6fb: `@<homeProjectId>` is the id platformEscalate stamped from its resolved Platform
      // home (never a name compare); it renders only with the task ref and is absent if never stamped.
      // Card e9688b1b DoD-3: when the title itself was cut, say so explicitly (same discipline applied to
      // question_asked above) — the bare "…" a plain truncateText() leaves behind reads exactly like a
      // genuinely short title, not a cut one.
      const escCutHint = " [title TRUNCATED]";
      // Card 16cf2365: a follow-up on a closed card is an UPDATE, not a fresh escalation. Closed = the
      // enqueue-time stamp OR the delivery-time re-read (`opts.taskTerminalNow`; undefined = card not
      // found ⇒ the stamp alone decides, never a crash).
      const followedUp = detail.followedUp === true;
      const closed = detail.targetWasTerminal === true || opts.taskTerminalNow === true;
      const verb = followedUp && closed
        ? "update on a closed platform escalation"
        : closed ? "escalated to platform (card since closed)" : "escalated to platform";
      // Size the title against the room LEFT after the prefix (verb, task ref, home id) and the `(m:…)`
      // suffix, same as request_escalated above — the final ALERT_LINE_MAX_CHARS end-trim must never be what
      // silently chops the title (and the flag / `(m:…)` with it).
      line = fitTitledLine(`${truncateText(projectName, TITLED_ALERT_PROJECT_NAME_MAX_CHARS)}: ${verb}${taskRef}`,
        rawTitle, escCutHint, ` (${m8})`);
      break;
    }
    case "session_rate_limited":
      line = `${projectName}: usage limit reached, parked — s:${e.managerSessionId.slice(0, 8)}`;
      break;
    // Card c5415a04: only reaches alertLine at all when classify() returned non-null, i.e.
    // detail.resumeFailed===true (a genuine per-entry resume failure) — never the resumed-but-nudge-
    // not-delivered case. Same id-before-truncatable-reason discipline as fleet_resume_failed above.
    case "fleet_resume_entry_failed": {
      const roleStr = typeof detail.role === "string" ? detail.role : "plain";
      const reasonSuffix3 = typeof detail.reason === "string" && detail.reason
        ? ` (${truncateText(detail.reason, ALERT_RESUME_REASON_MAX_CHARS)})` : "";
      line = `${projectName}: ${roleStr} entry failed to resume after a restart — ${who}${reasonSuffix3}`;
      break;
    }
    // Card e07b1b1a: named explicitly as a MANAGER/PLATFORM recycle failure, never as "worker crashed" —
    // reusing the worker-crashed CLASS (above) is fine, but this event's own subject is the predecessor
    // manager/Lead named by managerSessionId, not a worker.
    case "recycle_fleet_recovered":
      line = `${projectName}: manager/Lead recycle failed (successor died before SessionStart) — fleet recovered onto the predecessor — ${m8}`;
      break;
    case "recycle_fleet_unresolved": {
      const oldStillLive = detail.oldStillLive === true;
      // Card 91ac2b79: a halted successor down but durably resumable with a completed turn is a THIRD,
      // distinct shape — the predecessor is always still live here (the halt branch never stops it) and the
      // successor DID reach SessionStart, so neither of the other two clauses is accurate for it.
      const reasonClause = detail.reason === "halted-waiting-crash-recovery"
        ? "halted successor is down but completed a turn and is durably resumable — awaiting automatic crash recovery (or recycle_reattempt)"
        : detail.reason === "timeout"
          ? `successor's fate never confirmed — fleet still parented to it${oldStillLive ? "" : ", predecessor also not live"}`
          : "successor died before SessionStart, predecessor also not live — fleet may be stranded, unowned";
      line = `${projectName}: manager/Lead recycle unresolved (${reasonClause}) — ${m8}`;
      break;
    }
    // Code Review round 2 (m2): the resolution counterpart to recycle_fleet_unresolved above — a late
    // genuine success after an "unresolved" push already fired for the same recycle. Named explicitly, same
    // discipline as the other two recycle_fleet_* cases (never generic "worker crashed" wording).
    case "recycle_fleet_resolved":
      line = `${projectName}: manager/Lead recycle resolved late — the successor took over — ${m8}`;
      break;
    // @decision 08c81809 — distinct from recycle_fleet_unresolved on purpose: that case still has a live
    // predecessor watching and the loop still running; this one has neither — a daemon restart lost the
    // settle loop entirely, and the boot-time reconcile confirmed no automatic owner exists.
    case "recycle_fleet_stranded_across_restart":
      line = `${projectName}: manager/Lead recycle settle lost to a daemon restart — no automatic owner exists for its fleet, human intervention needed — ${m8}`;
      break;
    // Card 4775165f: a halted recycle whose successor ALSO turned out unresumable this boot — the fleet was
    // reclaimed back onto this (also-dead) predecessor as bookkeeping only (`a4c5f234`); never resumed. Named
    // distinctly from recycle_fleet_stranded_across_restart above (that case lost its settle loop to a
    // daemon restart; this one never had a resumable owner on either side of the lineage to begin with).
    case "recycle_split_lineage_consolidated": {
      // @decision 54434e27: mirrors the predecessor's own banner exactly — "child session(s)", never
      // "worker(s)" (listChildSessions counts every current child, unscoped to role or task state; the
      // threaded reparentedWorkers value is unreliable here — see that record for why).
      const deadSuccessor8 = typeof detail.deadSuccessorId === "string" ? detail.deadSuccessorId.slice(0, 8) : "?";
      const childCount3 = typeof detail.childSessionCount === "number" ? ` (${detail.childSessionCount} child session(s))` : "";
      line = `${projectName}: halted recycle lineage consolidated — successor ${deadSuccessor8} is unresumable too, fleet${childCount3} reclaimed onto the predecessor — no automatic owner, human must intervene — ${m8}`;
      break;
    }
    case "claude_boot_dialog_stuck": {
      const sigName = typeof detail.signatureName === "string" ? detail.signatureName : "none recognized";
      const roleLabel = typeof detail.role === "string" ? detail.role : "session";
      // Card 20ff76de: mid-session episodes share this kind — never word them as a boot failure.
      line = detail.phase === "mid-session"
        ? `${projectName}: ${roleLabel} is held on an unrecognized on-screen prompt (${sigName}) — its writes are paused until the owner does this: ${MODAL_RESOLVE_STEPS} — ${who}`
        : `${projectName}: ${roleLabel} never reached SessionStart — possible blocking CLI dialog (${sigName}) — ${who}`;
      break;
    }
    case "skill_permission_frontmatter_warning": {
      const roleLabel = typeof detail.role === "string" ? detail.role : "session";
      const scope = typeof detail.scope === "string" ? detail.scope : CWD_SKILLS_SCAN_SCOPE;
      // Card f39341d5, item 4 (+ the MAJOR fix round below): collect every flagged skill's NAME, and the
      // UNION of distinct vectors seen across ALL findings — rendered ONCE as "name1, name2 (label1,
      // label2)" rather than per-skill ("name1 (label1), name2 (label2)"), so a vector repeated across
      // many skills doesn't multiply the same label. `fields` is already on every `detail.findings[i]`
      // (set at `SessionService.handleSkillPermissionFrontmatterWarning`'s own event-append call); an id
      // with no VECTOR_TEXT entry (never expected — detectPermissionWidening's own union is exhaustive
      // here) falls back to the bare id rather than silently dropping it. Owner-visible text only — no
      // routing/classification change.
      const rawFindings = Array.isArray(detail.findings) ? detail.findings : [];
      const skillNames: string[] = [];
      const vectorIds: string[] = [];
      const seenVectors = new Set<string>();
      for (const f of rawFindings) {
        if (!f || typeof f !== "object" || !("name" in f)) { skillNames.push("?"); continue; }
        skillNames.push(String((f as { name: unknown }).name));
        const rawFields = (f as { fields?: unknown }).fields;
        const fields = Array.isArray(rawFields) ? rawFields.map(String) : [];
        for (const v of fields) if (!seenVectors.has(v)) { seenVectors.add(v); vectorIds.push(v); }
      }
      const labels = vectorIds.map((v) => VECTOR_TEXT[v as keyof typeof VECTOR_TEXT]?.terse ?? v);
      // CR round 3, finding 1: a bound hit (`detail.truncated`) escalates for the Companion exactly
      // like a real finding — a padded repo must not evade this push just because the finding it was
      // hiding fell past the scan's own cap. CR round 4, item 5: name the affected skill(s) (bounded)
      // and skippedCount too — a bare "scan truncated at its X cap" told the owner nothing about WHICH
      // skill(s) or how many were skipped.
      // Round 3 (second Code Review, Major 2): each shown name is itself capped — two realistic ~80-char
      // skill-directory names were otherwise enough to blow the line's budget on their own, independent
      // of TRUNC_NOTE_NAMES_MAX (which bounds how MANY names are shown, never how LONG each one is).
      const truncNote = Array.isArray(detail.truncated) && detail.truncated.length
        ? detail.truncated.map((t) => {
            if (!t || typeof t !== "object") return "scan truncated";
            const tt = t as { cap?: unknown; names?: unknown; skippedCount?: unknown };
            const cap = typeof tt.cap === "string" ? tt.cap : "?";
            const tNames = Array.isArray(tt.names) ? tt.names.map(String) : [];
            const shown = tNames.slice(0, TRUNC_NOTE_NAMES_MAX).map((n) => truncateText(n, TRUNC_NOTE_NAME_MAX_CHARS));
            const more = tNames.length > shown.length ? `, +${tNames.length - shown.length} more` : "";
            const skippedCount = typeof tt.skippedCount === "number" ? tt.skippedCount : null;
            return `scan truncated at its ${cap} cap${shown.length ? `: ${shown.join(", ")}${more}` : ""}${skippedCount !== null ? ` (${skippedCount} skipped)` : ""}`;
          }).join("; ")
        : null;
      const incompleteNote = detail.incomplete === true ? "scan INCOMPLETE (I/O error) — may be missing a finding" : null;
      // Round 3 (second Code Review, Major 2): the original fix only bounded the names+labels segment —
      // but the parts it RESERVED room for (projectName, the scope clause) were themselves unbounded, so
      // a realistic long project name or a long truncNote name could still push the who id / incomplete
      // note past the final ALERT_LINE_MAX_CHARS trim, which cuts from the END. Fixing this with budget
      // arithmetic alone just moves the same race to a different field, so the guarantee is now
      // STRUCTURAL instead: the who id and the incomplete-scan note are placed BEFORE every unbounded or
      // free-text part of the line (mirroring `platform_escalate`'s taskRef-before-title placement), and
      // `projectName` is capped for this case specifically (every other case leaves it uncapped). The
      // end-trim can then only ever cut the free text that remains at the end — names, labels, truncNote,
      // the scope clause — never the who id or the incomplete note.
      const projectNameCapped = truncateText(projectName, SKILL_WARNING_PROJECT_NAME_MAX_CHARS);
      const prefix = `${projectNameCapped}: ${roleLabel} spawn (${who})${incompleteNote ? ` — ${incompleteNote}` : ""} found `;
      const suffix = ` (${scope}, unmanaged by Loom)`;
      let names: string | null = null;
      if (skillNames.length) {
        const reserved = prefix.length + suffix.length
          + (truncNote ? ` — ${truncNote}`.length : 0)
          + "permission-widening frontmatter in ".length;
        const budget = Math.max(0, ALERT_LINE_MAX_CHARS - reserved);
        names = fitNamesAndLabels(skillNames, labels, budget);
      }
      const what = [names ? `permission-widening frontmatter in ${names}` : null, truncNote].filter(Boolean).join(" — ") || "a permission-widening concern";
      line = `${prefix}${what}${suffix}`;
      break;
    }
    // Code Review 5f95e7a1: named explicitly, same discipline as claude_boot_dialog_stuck immediately
    // above — the generic default's bare `${alertClass} — ${m8}` gave no indication this is specifically
    // a NEVER-CONFIRMED kickoff, not a boot-dialog hang or any other escalation shape.
    // Card 5c2f8108: `roleLabel` reads `detail.role` (same pattern as claude_boot_dialog_stuck's own
    // roleLabel above) so a Platform Lead's own dropped kickoff isn't misreported as a manager's.
    case "manager_kickoff_dropped": {
      const roleLabel = detail.role === "platform" ? "Platform Lead's" : "manager's";
      line = `${projectName}: ${roleLabel} turn-1 kickoff was never confirmed delivered — it may have booted with no brief — ${who}`;
      break;
    }
    case "manager_context_exhausted":
      line = `${projectName}: manager/platform session ran out of context and cannot reply — recycle it — ${who}`;
      break;
    case "assistant_context_exhausted":
      line = `${projectName}: Companion ran out of context and cannot reply — owner notice filed in the inbox — ${who}`;
      break;
    default:
      line = `${projectName}: ${alertClass} — ${m8}`;
  }
  return truncateText(line, ALERT_LINE_MAX_CHARS);
}

export interface AttentionPushWatcherDeps {
  db: Db;
  pty: HeartbeatPty;
  /** The bound companion session id this watcher pushes into (an EXISTING long-lived session). */
  sessionId: string;
  /** Watcher tick cadence in ms; defaults to 60s (mirrors the other per-tick watchers). */
  tickMs?: number;
}

type EventWithSeq = OrchestrationEvent & { seq: number };
type Qualifying = { e: EventWithSeq; cls: AttentionAlertClass; projectName: string; taskIdResolvable: boolean };

export class AttentionPushWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The tail-poll cursor — every event with seq <= this has been examined. Seeded on start() from the
   *  durable log (own prior pushes, or a fresh baseline); advanced as pushes/flushes land. Tracks
   *  `orchestration_events.seq` (a never-reused monotonic column), NEVER sqlite's own rowid — see the
   *  module doc for why rowid is unsafe here. */
  private watermark = 0;
  /** Epoch ms of the last digest flush; null until the first flush (digest mode only). */
  private lastDigestFlushAt: number | null = null;
  /** Defer-once-per-streak tracking (mirrors the heartbeat's deferredSinceLastFire — see its doc for the
   *  bounded-log-growth rationale). Cleared on any real push (immediate or digest flush). */
  private deferredSinceLastPush = false;
  /** Per-recipient "escalation" re-delivery suppression (companion re-delivery card, defense-in-depth
   *  alongside the server-side platformEscalate() title+severity-aware dedup, sessions/service.ts): taskId → the
   *  {@link escalationSignature} last pushed to THIS session for that task. `orchestration_events` rows are
   *  immutable once written (never mutated after insert — same premise `decisionSurfaceSignature`'s doc
   *  relies on for questions), so a repeat "escalation"-class event carrying a taskId+signature already in
   *  this map is, by construction, an UNCHANGED re-delivery of something this recipient already saw — never
   *  a genuine update (a real change would carry a different title/severity and therefore a different
   *  signature, and is never suppressed). Seeded on start() from this session's own durable
   *  `companion_alert_pushed` history (seedWatermark) — never cross-recipient (each companion's own watcher
   *  instance holds its own map), so two companions granted attention-push on the same project each still
   *  get their own first alert. */
  private escalationSurfaced = new Map<string, string>();

  /** Card 4775165f: per-lineage dedupe for `recycle_split_lineage_consolidated`, keyed on
   *  `(predecessorId, deadSuccessorId)` (see {@link consolidatedLineageKey}) — defense in depth against the
   *  source event firing more than once for the SAME lineage. The source event is believed to fire at most
   *  once ever (an idempotency guard at its one filing site), but that is NOT assumed safe here: a future
   *  change to that guard (or a genuinely re-run boot phase) must never be able to double-page the owner for
   *  a lineage it already paged. Unlike `escalationSurfaced` (a Map — a REAL content change legitimately
   *  re-fires for the same taskId), this is a plain Set — the lineage either was already surfaced or wasn't,
   *  there is no "updated content" shape for a repeat filing of this kind to carry. Seeded on start() from
   *  this session's own durable `companion_alert_pushed` history (seedWatermark) — never cross-recipient. */
  private consolidatedLineagesSurfaced = new Set<string>();

  constructor(private deps: AttentionPushWatcherDeps) {}

  /** Deterministic per-lineage dedupe key for a `recycle_split_lineage_consolidated` event — the
   *  predecessor (`managerSessionId`, the event's own subject) plus the dead successor it was consolidated
   *  against (`detail.deadSuccessorId`). Returns null when the id is missing/malformed (defensive — never
   *  dedupe against an empty-string key that could collide across genuinely different lineages). */
  private consolidatedLineageKey(e: { managerSessionId: string; detail?: Record<string, unknown> }): string | null {
    const deadSuccessorId = typeof e.detail?.deadSuccessorId === "string" ? e.detail.deadSuccessorId : null;
    return deadSuccessorId ? `${e.managerSessionId}|${deadSuccessorId}` : null;
  }

  /** Deterministic "as of this event" fingerprint for an escalation (mirrors decisionSurfaceSignature's
   *  doc): title+severity are set once at `platform_escalate` filing time and never mutated afterward, so
   *  this can only change across a GENUINELY new/re-escalated occurrence, never a re-read of the same one.
   *  The closed-follow-up variant keys on the filing-time `targetWasTerminal` STAMP ONLY — never a live
   *  re-read of the card, which would flip a suppressed open-time follow-up to `|closed-followup` once its
   *  card later closes (restart reseed, held digest) and deliver it as a false "update on a closed" item.
   *  The live re-read is for RENDERING only (`alertOptsFor`). */
  private escalationSignature(e: { taskId?: string | null; detail?: Record<string, unknown> }): string {
    const d = e.detail ?? {};
    const title = typeof d.title === "string" ? d.title : "";
    const severity = typeof d.severity === "string" ? d.severity : "";
    // Card 16cf2365 (owner decision): a follow-up on a CLOSED card is a distinct state — it must reach the
    // owner as "update on a closed platform escalation" even when an earlier OPEN escalation with the same
    // title|severity was already surfaced. Ordinary repeats of an open escalation keep the bare signature.
    const closedFollowUp = d.followedUp === true && d.targetWasTerminal === true;
    return closedFollowUp ? `${title}|${severity}|closed-followup` : `${title}|${severity}`;
  }

  /** Delivery-time re-read of an escalation card's column (same terminal-role test as
   *  `SessionService.columnEscalationStatus`). Any failure / missing card ⇒ undefined ⇒ the safe form. */
  private taskTerminalNow(taskId: string | null | undefined): boolean | undefined {
    if (!taskId) return undefined;
    try {
      const task = this.deps.db.getTask(taskId);
      if (!task) return undefined;
      const home = this.deps.db.getProject(task.projectId);
      const terminalKey = columnKeyForRole(resolveLoomConfig(home?.config).kanbanColumns, "terminal");
      return terminalKey !== undefined && task.columnKey === terminalKey;
    } catch { return undefined; }
  }

  /**
   * One trigger pass. Conservative order: grant → live → session exists → not parked → not stacking →
   * config → scan → classify/scope-filter → push. Never throws (the interval swallows anyway; the
   * controller's caller also wraps every tick — belt and suspenders, matching the sibling watchers).
   */
  tick(now: Date = new Date()): void {
    const { db, pty, sessionId } = this.deps;

    // DEFAULT-OFF fast path: no grant ⇒ one cheap lookup, nothing else (no event scan, no db.getSession).
    const scope = resolveCompanionGrant(db, sessionId, "attention-push");
    if (!scope) return;

    // Not live → SKIP (do NOT resume a stopped companion just to alert it). Retry next tick, no event.
    if (!pty.isAlive(sessionId)) return;

    const session = db.getSession(sessionId);
    if (!session) return; // the companion session row is gone — nothing to push to.

    // Rate-limit PARKED → DEFER (respect the park; don't enqueue → no spam). Watermark untouched (the whole
    // tick bails BEFORE reading any events), so the next non-deferred tick re-scans from the same point.
    if (session.rateLimitedUntil != null) {
      this.deferOnce(now, { reason: "rate-limited", until: session.rateLimitedUntil });
      return;
    }
    // No-stacking: a prior unconsumed [loom:alert] turn → don't stack a second. Same watermark-preserving
    // bail as the park branch above.
    if (pty.getPending(sessionId).some((t) => t.startsWith(ALERT_TAG))) {
      this.deferOnce(now, { reason: "pending" });
      return;
    }

    const { alertClasses, digestMinutes } = this.resolveConfig(scope);
    if (alertClasses.size === 0) return; // nothing subscribed (no config set on any granted project) — no-op.

    const scanned = db.listEventsSince(this.watermark, EVENT_TAIL_LIMIT) as EventWithSeq[];
    if (scanned.length === 0) return; // nothing new since the watermark.

    // Card 4775165f: a THIS-TICK-ONLY guard for consolidatedLineageKey, separate from the persistent
    // `consolidatedLineagesSurfaced` set below. Two genuinely duplicate `recycle_split_lineage_consolidated`
    // rows for the SAME lineage can land in the SAME `scanned` window (e.g. a re-run boot phase filing it
    // twice) — the persistent set is only stamped at actual PUSH time, which happens AFTER this whole
    // classify/qualify loop finishes, so checking only the persistent set here would let every duplicate in
    // one window through. This local set catches that within-tick case without touching the persistent one
    // prematurely — doing that instead would reopen the exact "not-yet-flushed digest row gets wrongly
    // self-suppressed before ever delivered" hazard escalationSurfaced's own doc already warns against for
    // the same reason, since a still-buffered (not-yet-due) row gets rescanned on every later tick until it
    // actually flushes.
    const seenConsolidatedLineageKeysThisTick = new Set<string>();
    const qualifying: Qualifying[] = [];
    for (const e of scanned) {
      const cls = classify(e.kind, e.detail);
      if (!cls || !alertClasses.has(cls)) continue;
      // A Companion that is itself context-exhausted must not enqueue an alert ABOUT ITSELF into its own
      // held queue (it can never answer it; the owner already has the inbox notice). A different, healthy
      // Companion still gets the alert.
      if (e.kind === "assistant_context_exhausted" && e.managerSessionId === sessionId) continue;
      const projectId = db.getSession(e.managerSessionId)?.projectId;
      if (!projectId || !scope.projectIds.has(projectId)) continue; // out of this grant's scope
      // Escalation re-delivery suppression (defense-in-depth alongside the server-side title-dedup) — see
      // `escalationSurfaced`'s doc. Checked here (classification time), STAMPED only at actual push time
      // (tickImmediate/tickDigest's emit calls) — never here — so a digest's "not yet due" re-scan of the
      // SAME not-yet-flushed row (tickDigest keeps it visible until the flush) isn't wrongly self-suppressed
      // before it's ever actually delivered.
      // Card e2a3c613 round 3: scoped to `e.kind === "platform_escalate"`, NOT `cls === "escalation"` —
      // since round 2, `claude_boot_dialog_stuck` also classifies into "escalation" but its detail carries
      // no title/severity, so `escalationSignature` always returns the same "|" for it; keying the dedup on
      // `cls` let a worker's FIRST boot-stuck episode stamp taskId→"|" and silently suppress every LATER
      // episode for that same task forever. `platform_escalate` is the only kind this title+severity
      // signature was ever designed to fingerprint.
      if (e.kind === "platform_escalate" && e.taskId && this.escalationSurfaced.get(e.taskId) === this.escalationSignature(e)) {
        continue;
      }
      // Card 4775165f: per-lineage dedupe, checked here (classification time), STAMPED only at actual push
      // time (stampConsolidatedLineage, called from the same three emit sites as stampEscalation) — same
      // discipline as the platform_escalate check above, for the same reason: a digest's "not yet due"
      // re-scan of a still-unflushed row must not self-suppress before it's ever actually delivered.
      if (e.kind === "recycle_split_lineage_consolidated") {
        const lineageKey = this.consolidatedLineageKey(e);
        if (lineageKey) {
          if (this.consolidatedLineagesSurfaced.has(lineageKey) || seenConsolidatedLineageKeysThisTick.has(lineageKey)) continue;
          seenConsolidatedLineageKeysThisTick.add(lineageKey);
        }
      }
      // Card 3d5fcd00: `idle_report(done)` is the one kind this far down the switch whose SOURCE repeats
      // within a single episode — it's agent-filed, so a manager that stays drained re-files
      // `state:"done"` on every nudge cycle (classify() already narrowed `cls === "manager-idle"` to
      // exactly this shape for `idle_report`; `idle_escalated` also classifies "manager-idle" but fires
      // at most once per episode at its own source, so it's excluded from this check by kind, same
      // discipline as the platform_escalate/claude_boot_dialog_stuck split above).
      //
      // @decision 3d5fcd00 — never derive this from the manager's CURRENT state as of now (e.g. via the
      // web's `idleDoneEpisodeStarts`, which reads the whole history and can be wrong by the time `e` is
      // classified if the run already ended) — look only BACKWARD from `e`'s own fixed position instead.
      //
      // `e.kind === "idle_report"` only — `idle_escalated` also classifies "manager-idle" but fires at
      // most once per episode at its own source (same discipline as the platform_escalate/
      // claude_boot_dialog_stuck split above), so it's never suppressed here and always pushes. For a
      // qualifying `idle_report(done)`, push `e` unless the latest `idle_report`/`idle_escalated` for
      // this SAME manager, strictly BEFORE `e` (by `seq`, never sqlite's rowid —
      // `getLatestIdleEpisodeEventBefore`, db.ts), is ITSELF an `idle_report(done)` — a continuation of a
      // run already surfaced. Looking only backward means this can never be invalidated by anything that
      // happens AFTER `e` (a digest's not-yet-due re-scan, a no-stacking/rate-limit defer, or two events
      // landing in one tail-scan window can all put a later `working`/`waiting`/`idle_escalated` durably
      // on record before `e` is ever looked at) — it fails toward VISIBLE (a since-ended drain still
      // pages once) rather than toward silently dropping `e`.
      if (e.kind === "idle_report") {
        const prior = db.getLatestIdleEpisodeEventBefore(e.managerSessionId, e.seq);
        const priorIsDone = !!prior && prior.kind === "idle_report" && (prior.detail as { state?: string } | undefined)?.state === "done";
        if (priorIsDone) continue; // a 'done' immediately precedes this one — a continuation, already surfaced
      }
      const projectName = db.getProject(projectId)?.name ?? "?";
      // Card 91b9105e: `cls === "escalation"` is NOT only ever `platform_escalate` any more — round 2
      // (card e2a3c613) added `claude_boot_dialog_stuck` to the same class. Only `platform_escalate`'s
      // taskId lives on the Platform HOME project (not the origin project just scoped-checked above), so
      // the resolvability check below must stay keyed on the KIND, not the class.
      const taskIdResolvable = e.kind === "platform_escalate" ? this.canResolveEscalationTask(session.projectId, e.detail) : true;
      qualifying.push({ e, cls, projectName, taskIdResolvable });
    }

    if (digestMinutes > 0) this.tickDigest(now, qualifying, digestMinutes, scanned);
    else this.tickImmediate(now, qualifying, scanned);
  }

  /**
   * Arm the interval. Seeds the watermark from the durable log so a daemon restart never replays history —
   * see `seedWatermark`'s doc.
   */
  start(): void {
    this.seedWatermark();
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.tickMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * Card 91b9105e: can THIS recipient actually resolve a `platform_escalate` event's `taskId`? That id
   * always lives on the Platform HOME project (`detail.platformProjectId`, stamped by
   * `SessionService.platformEscalate` — never the escalating manager's own origin project), so the
   * per-event origin-project scope check in `tick()` (which gates on `attention-push`'s OWN grant) says
   * nothing about whether this session can read a card on that DIFFERENT, home project. Two read paths
   * can reach it: (1) this session's own plain `loom-tasks` board — `mcp/tasks.ts`'s `resolveProjectTaskId`
   * resolves ONLY against the session's own bound `projectId` (strict single-project equality, never a
   * set), so that path works only when this companion IS bound to the Platform home itself; or (2) a
   * `board-reach` grant (companion/capabilities.ts) whose OWN scope includes the Platform home —
   * `board_get` performs the identical `ctx.scope.projectIds.has(project)` check this mirrors. Returns
   * `true` (never withholds) when the event carries no home-project id to check in the first place.
   */
  private canResolveEscalationTask(sessionProjectId: string, detail: Record<string, unknown> | undefined): boolean {
    const platformProjectId = typeof detail?.platformProjectId === "string" ? detail.platformProjectId : undefined;
    if (!platformProjectId) return true;
    if (sessionProjectId === platformProjectId) return true;
    const boardScope = resolveCompanionGrant(this.deps.db, this.deps.sessionId, "board-reach");
    return !!boardScope && boardScope.projectIds.has(platformProjectId);
  }

  // ---- internals -------------------------------------------------------------------------------

  /** Union-merge the granted projects' `attention-push` config (Lead fork 4): the union of every granted
   *  project's `alertClasses` (invalid/unknown entries silently dropped — the REST validator already
   *  rejects those at write time; this is defense-in-depth, never throws on a stale/bad row), and the MIN
   *  of every granted project's POSITIVE `digestMinutes` (0/absent excluded from the min — digest mode is
   *  OFF unless at least one granted project opted into it). An empty/absent `alertClasses` on a project
   *  contributes NOTHING to the union (confirmed correct by Code Review, KEEP AS-IS — matches the
   *  framework's default-deny posture: an owner must explicitly opt into the classes they want pushed). */
  private resolveConfig(scope: ResolvedGrantScope): { alertClasses: Set<AttentionAlertClass>; digestMinutes: number } {
    const alertClasses = new Set<AttentionAlertClass>();
    let digestMinutes = 0;
    for (const pid of scope.projectIds) {
      const cfg = scope.configFor(pid) as { alertClasses?: unknown; digestMinutes?: unknown };
      if (Array.isArray(cfg.alertClasses)) {
        // Companion "lead mode" wildcard (companion/capabilities.ts's synthesizeLeadModeScope) — "*" is
        // reachable ONLY through that internal synthesis path (the REST grant-config validator only ever
        // accepts a literal class name), and expands here rather than being duplicated as a literal list in
        // capabilities.ts (which would drift if a class is ever added/renamed here without a matching edit
        // there). Owner ruling (2026-07-21, request d024eda7): the wildcard expansion excludes
        // FLEET_OPS_ALERT_CLASSES (see its doc) — lead mode still gets every OWNER-SIGNAL class, but not
        // the routine fleet-ops noise. This is the ONE place that exclusion applies; an explicitly-named
        // class in the `else` branch below is NEVER filtered, wildcard or not.
        if (cfg.alertClasses.includes("*")) {
          for (const c of ATTENTION_ALERT_CLASSES) {
            // Card 68f27faf, owner ruling: "notice" is excluded from the wildcard too, but deliberately
            // NOT via FLEET_OPS_ALERT_CLASSES — the semantics differ (fleet-ops = "the manager handles
            // this autonomously"; notice = "nobody asked to hear about this by default"). A human opts a
            // companion into notices by adding "notice" to that companion's OWN (non-lead-mode)
            // attention-push grant's alertClasses — lead mode synthesizes a full `["*"]` scope that
            // supersedes any real grant row while it's on (see `synthesizeLeadModeScope`'s own doc, card
            // b5c606aa), so the explicit opt-in can only ever take effect for a companion NOT in lead mode.
            if (!FLEET_OPS_ALERT_CLASSES.has(c) && c !== "notice") alertClasses.add(c);
          }
        } else {
          for (const c of cfg.alertClasses) {
            if (typeof c === "string" && (ATTENTION_ALERT_CLASSES as readonly string[]).includes(c)) {
              alertClasses.add(c as AttentionAlertClass);
            }
          }
        }
      }
      if (typeof cfg.digestMinutes === "number" && cfg.digestMinutes > 0) {
        digestMinutes = digestMinutes === 0 ? cfg.digestMinutes : Math.min(digestMinutes, cfg.digestMinutes);
      }
    }
    return { alertClasses, digestMinutes };
  }

  /**
   * Immediate mode: push each qualifying event as its OWN framed turn, oldest-first — UNLESS this single
   * tick found MORE than IMMEDIATE_BURST_CAP qualifying events (CR fold-in [3]), in which case they're
   * coalesced into ONE digest-style turn instead of one companion turn PER event (a fleet burst must not
   * spam dozens of separate owner-facing messages from a single tick — digest mode already caps its bundled
   * turn at DIGEST_MAX_LINES; immediate mode had no equivalent cap before this fold-in).
   *
   * Every row in `scanned` is TERMINAL by the time this runs — a qualifying row is delivered, a
   * non-qualifying row (wrong class or out of scope) is a PERMANENT skip (never re-classifies differently on
   * a later tick) — so the watermark always advances to the LAST SCANNED row's seq, even when `qualifying`
   * is empty. Never revert to advancing only past DELIVERED rows.
   *
   * @decision sha:31ca9b5d
   *
   * Only a TRANSIENT
   * defer (rate-limit park / no-stacking) may hold the watermark, and both of those bail the whole tick
   * BEFORE `scanned` is ever read (see `tick()`) — so every row that reaches this method is unconditionally
   * consumed.
   */
  private tickImmediate(now: Date, qualifying: Qualifying[], scanned: EventWithSeq[]): void {
    if (qualifying.length > IMMEDIATE_BURST_CAP) {
      // No home configured ⇒ fall back to the session's implicit in-app route (always deliverable — see
      // inAppHomeRoute's doc) so this proactive push still lands somewhere instead of chat_reply resolving
      // `no-target`.
      const home = this.deps.db.getCompanionHome(this.deps.sessionId) ?? inAppHomeRoute(this.deps.sessionId);
      const lines = qualifying.map(({ e, cls, projectName, taskIdResolvable }) => alertLine(e, cls, projectName, taskIdResolvable, this.alertOptsFor(e)));
      // proactive:true (proactive event-line producer) — a daemon-driven alert push, tagged for the web
      // chat's amber event line.
      this.deps.pty.enqueueStdin(this.deps.sessionId, framedDigest(lines), "system", undefined, home, "agent", undefined, undefined, true);
      this.deferredSinceLastPush = false;
      for (const { e, cls } of qualifying) {
        this.emit(now, "companion_alert_pushed", { sourceSeq: e.seq, alertClass: cls, sourceKind: e.kind, ...this.stampEscalation(e), ...this.stampConsolidatedLineage(e) });
      }
    } else if (qualifying.length > 0) {
      // Same in-app fallback as the digest branch above.
      const home = this.deps.db.getCompanionHome(this.deps.sessionId) ?? inAppHomeRoute(this.deps.sessionId);
      for (const { e, cls, projectName, taskIdResolvable } of qualifying) {
        // kind:"agent" — a daemon-driven push turn, must land as its own turn (never mashed with a sibling).
        // proactive:true — see the digest branch above.
        this.deps.pty.enqueueStdin(this.deps.sessionId, framedAlert(alertLine(e, cls, projectName, taskIdResolvable, this.alertOptsFor(e))), "system", undefined, home, "agent", undefined, undefined, true);
        this.deferredSinceLastPush = false;
        this.emit(now, "companion_alert_pushed", { sourceSeq: e.seq, alertClass: cls, sourceKind: e.kind, ...this.stampEscalation(e), ...this.stampConsolidatedLineage(e) });
      }
    }
    this.watermark = scanned[scanned.length - 1]!.seq; // consume the WHOLE scanned window — see doc above.
  }

  /**
   * Digest mode (Lead fork 5, v1 = the RE-SCAN BUFFER): the "buffer" is re-derived from
   * `listEventsSince(watermark)` every tick — there is no separately-persisted buffer, ONE source of truth.
   * A NOT-YET-DUE flush must keep every UN-FLUSHED qualifying row visible for the next re-scan (the
   * accumulating buffer), but — same stall fix as `tickImmediate` — must still consume any non-qualifying
   * rows in the window (permanent skips), or a long run of unsubscribed noise ahead of the qualifying rows
   * would wedge the watermark just as badly. So: a pure non-qualifying window advances past all of it; a
   * not-yet-due window with qualifying rows advances to JUST BEFORE the first qualifying row (seq values are
   * integers and `listEventsSince` is strictly `> watermark`, so that row — and everything after it — is
   * still re-scanned next tick); a DUE flush delivers one bundled turn, records a `companion_alert_pushed`
   * row PER underlying source (not one row per digest — keeps the audit trail as granular as immediate
   * mode; a restart-reseed via `seedWatermark`'s MAX sourceSeq converges correctly either way), then
   * advances past the WHOLE scanned window (qualifying flushed, non-qualifying permanently skipped).
   */
  private tickDigest(now: Date, qualifying: Qualifying[], digestMinutes: number, scanned: EventWithSeq[]): void {
    if (qualifying.length === 0) {
      this.watermark = scanned[scanned.length - 1]!.seq; // pure non-qualifying window — nothing to buffer.
      return;
    }
    const dueFlush = this.lastDigestFlushAt == null || now.getTime() - this.lastDigestFlushAt >= digestMinutes * 60_000;
    if (!dueFlush) {
      this.watermark = qualifying[0]!.e.seq - 1; // consume leading non-qualifying rows; keep the buffer visible.
      return;
    }
    // No home configured ⇒ fall back to the session's implicit in-app route — see tickImmediate's digest
    // branch above.
    const home = this.deps.db.getCompanionHome(this.deps.sessionId) ?? inAppHomeRoute(this.deps.sessionId);
    const lines = qualifying.map(({ e, cls, projectName, taskIdResolvable }) => alertLine(e, cls, projectName, taskIdResolvable, this.alertOptsFor(e)));
    // proactive:true — see tickImmediate's digest branch above.
    this.deps.pty.enqueueStdin(this.deps.sessionId, framedDigest(lines), "system", undefined, home, "agent", undefined, undefined, true);
    this.lastDigestFlushAt = now.getTime();
    this.deferredSinceLastPush = false;
    for (const { e, cls } of qualifying) {
      this.emit(now, "companion_alert_pushed", { sourceSeq: e.seq, alertClass: cls, sourceKind: e.kind, ...this.stampEscalation(e), ...this.stampConsolidatedLineage(e) });
    }
    this.watermark = scanned[scanned.length - 1]!.seq;
  }

  /** Per-event `alertLine` options: whether this recipient holds a decisions-relay grant covering the
   *  event's project (read through the same `resolveCompanionGrant` chokepoint as the tick's own grant), and
   *  — for a `request_escalated` reminder only — the question's `last_surfaced_at`. Best-effort: any lookup
   *  failure degrades to "no hint, no note", never blocks the push. */
  private alertOptsFor(e: OrchestrationEvent): AlertLineOpts {
    let canFetchDecision = false;
    try {
      const projectId = this.deps.db.getSession(e.managerSessionId)?.projectId;
      const g = resolveCompanionGrant(this.deps.db, this.deps.sessionId, "decisions-relay");
      canFetchDecision = !!(projectId && g && g.projectIds.has(projectId));
    } catch { /* degrade: no decision_get hint */ }
    let lastReadAt: string | null = null;
    if (canFetchDecision && e.kind === "request_escalated") {
      const qid = (e.detail ?? {}).questionId;
      if (typeof qid === "string") {
        try { lastReadAt = this.deps.db.getQuestionLastSurfacedAt(qid); } catch { lastReadAt = null; }
      }
    }
    // Card 16cf2365: delivery-time re-read of the escalation card's column (same terminal-role test as
    // `SessionService.columnEscalationStatus`). Any failure / missing card ⇒ undefined ⇒ the safe form.
    const taskTerminalNow = e.kind === "platform_escalate" ? this.taskTerminalNow(e.taskId) : undefined;
    return { canFetchDecision, lastReadAt, ...(taskTerminalNow !== undefined ? { taskTerminalNow } : {}) };
  }

  /** Stamps `escalationSurfaced` at the moment a `platform_escalate` event is ACTUALLY pushed (never at
   *  classification time — see the suppression check in `tick()`), and returns the extra
   *  `companion_alert_pushed` detail fields (`escalationTaskId`/`escalationSignature`) that let a restart's
   *  `seedWatermark` reconstruct the map from the durable log alone, with no new table/column. A no-op
   *  (returns `{}`) for every other kind (including `claude_boot_dialog_stuck`, which shares the
   *  "escalation" CLASS since round 2 but has no title/severity to fingerprint — card e2a3c613 round 3) or
   *  a taskId-less event. */
  private stampEscalation(e: EventWithSeq): { escalationTaskId?: string; escalationSignature?: string } {
    if (e.kind !== "platform_escalate" || !e.taskId) return {};
    const signature = this.escalationSignature(e);
    this.escalationSurfaced.set(e.taskId, signature);
    return { escalationTaskId: e.taskId, escalationSignature: signature };
  }

  /** Card 4775165f: the `recycle_split_lineage_consolidated` sibling of {@link stampEscalation} — stamps
   *  `consolidatedLineagesSurfaced` at the moment the event is ACTUALLY pushed (never at classification
   *  time — see the dedupe check in `tick()`), and returns the extra `companion_alert_pushed` detail field
   *  that lets a restart's `seedWatermark` reconstruct the set from the durable log alone. A no-op for every
   *  other kind, or a malformed/missing `deadSuccessorId`. */
  private stampConsolidatedLineage(e: EventWithSeq): { consolidatedLineageKey?: string } {
    if (e.kind !== "recycle_split_lineage_consolidated") return {};
    const key = this.consolidatedLineageKey(e);
    if (!key) return {};
    this.consolidatedLineagesSurfaced.add(key);
    return { consolidatedLineageKey: key };
  }

  /**
   * Restart-safe watermark seed: the MAX `sourceSeq` across this session's own durable
   * `companion_alert_pushed` events (never replay an alert already pushed), else — a companion that has
   * NEVER pushed one — the current global max event seq (`Db.getMaxEventSeq`), so a brand-new grant fires
   * nothing for pre-existing backlog and only reacts to activity from this point forward. A never-pushed
   * companion re-armed after a restart re-seeds to the CURRENT max, not its original start() max — a
   * narrow, accepted window.
   *
   * @decision sha:31ca9b5d
   *
   * Also reconstructs `escalationSurfaced` from the SAME scan (no second read, no new table): each
   * `companion_alert_pushed` row's `escalationTaskId`/`escalationSignature` (stamped by `stampEscalation` at
   * push time) is replayed in chronological order (listEvents' own ORDER BY), so the map ends up holding
   * each taskId's LATEST pushed signature — correct even in the (currently unreachable, but not assumed
   * impossible) case of two distinct pushes for the same taskId.
   *
   * Card 4775165f: also reconstructs `consolidatedLineagesSurfaced` from the SAME scan — each
   * `companion_alert_pushed` row's `consolidatedLineageKey` (stamped by `stampConsolidatedLineage` at push
   * time) is added back to the set, so a restarted watcher never re-pushes a lineage it already surfaced.
   */
  private seedWatermark(): void {
    let max = 0;
    for (const e of this.deps.db.listEvents(this.deps.sessionId)) {
      if (e.kind !== "companion_alert_pushed") continue;
      const detail = e.detail as { sourceSeq?: number; escalationTaskId?: string; escalationSignature?: string; consolidatedLineageKey?: string } | undefined;
      const seq = detail?.sourceSeq;
      if (typeof seq === "number" && seq > max) max = seq;
      if (typeof detail?.escalationTaskId === "string" && typeof detail?.escalationSignature === "string") {
        this.escalationSurfaced.set(detail.escalationTaskId, detail.escalationSignature);
      }
      if (typeof detail?.consolidatedLineageKey === "string") {
        this.consolidatedLineagesSurfaced.add(detail.consolidatedLineageKey);
      }
    }
    this.watermark = max > 0 ? max : this.deps.db.getMaxEventSeq();
  }

  /** Emit a `companion_alert_deferred` event AT MOST ONCE per defer streak (bounded log growth — mirrors
   *  the heartbeat/reminder watchers' identical discipline). */
  private deferOnce(now: Date, detail: Record<string, unknown>): void {
    if (this.deferredSinceLastPush) return;
    this.deferredSinceLastPush = true;
    this.emit(now, "companion_alert_deferred", detail);
  }

  private emit(now: Date, kind: "companion_alert_pushed" | "companion_alert_deferred", detail: Record<string, unknown>): void {
    this.deps.db.appendEvent({
      id: randomUUID(), ts: now.toISOString(),
      managerSessionId: this.deps.sessionId, kind, detail,
    });
  }
}
