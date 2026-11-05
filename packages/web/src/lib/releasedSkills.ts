// The vocabulary and derived copy for the released-skill panel (card 75ea3f73, over card 8b38b920's
// three human-only REST routes). JSX-free so `test/released-skills.mjs` can import it under Node's type
// stripping — same split as lib/mergeGate.ts, whose panel keeps its own state vocabulary here too.
//
// Everything in this file is DERIVED COPY, never a second source of truth: the three reasons and the
// tri-state `tracked` are the daemon's own (skills/inject.ts `ReleaseReason` / `GitTrackedState`),
// mirrored as types in lib/api.ts. A reason the daemon adds without a gloss here still renders — see
// `releaseReasonGloss`'s fallback — so the panel can never go blank on an unrecognised value.
// Type-only imports, both of them: this module is loaded by `test/released-skills.mjs` under Node's
// type stripping, which erases an `import type` statement entirely — a VALUE import of either module
// would make the test resolve `../theme`/`./api` (and, through api.ts, the whole fetch client) at
// runtime. Same discipline, same reason, as lib/mergeGate.ts's own `import type { Tone }`.
import type { Tone } from "../theme";
import type { GitTrackedState, ReleaseReason } from "./api";

/**
 * What each reason actually MEANS for the reader, in their terms. Taken from the daemon's own
 * `ReleaseReason` doc and docs/decisions/8b38b920-*.md.
 *
 * ⛔ `abandoned` must NEVER be worded as an edit. The decision record is explicit that it is a distinct
 * reason precisely because the content may be byte-identical to what Loom placed — it is an age/cap
 * give-up, not a claim that anyone touched anything. Wording it as "changed" would send a reader
 * hunting for a diff that does not exist.
 */
const REASON_GLOSS: Record<ReleaseReason, string> = {
  modified: "Something changed this copy after Loom placed it, so Loom stopped overwriting it and the edit is safe.",
  "unverifiable-legacy": "Loom has no record of placing this copy, so it cannot prove the content is its own.",
  abandoned: "No live session claimed this copy for long enough that Loom gave up on it. The content may still be Loom's own.",
};

/** The gloss for `reason`, or a plain honest fallback for a reason this build does not know about. */
export function releaseReasonGloss(reason: string): string {
  return REASON_GLOSS[reason as ReleaseReason]
    ?? "Loom stopped managing this copy for a reason this version of the UI does not recognise.";
}

/**
 * Severity colour for the reason badge. `modified` is amber (something diverged and a human is the
 * likely cause); the other two are informational — an unverifiable copy is a bookkeeping gap (cyan) and
 * an abandoned one is routine housekeeping (muted). None of the three is an ERROR, so none is red: red
 * on this page is reserved for a refusal the reader has actually run into.
 */
export function releaseReasonTone(reason: string): Tone {
  if (reason === "modified") return "busy";
  if (reason === "unverifiable-legacy") return "info";
  return "muted";
}

/**
 * Why a re-adopt of this copy will be REFUSED by the server, stated before the reader clicks — or
 * `null` when nothing stands in the way. Mirrors `reAdoptReleasedSkill`'s own `"tracked"` /
 * `"track-unknown"` refusals (both 409); the server stays the authority and its message is still shown
 * verbatim if a click gets that far, but a reader should not have to click to learn this.
 *
 * ⛔ Never fold `"unknown"` into the `"tracked"` wording. The daemon tri-stated this deliberately (card
 * 8b38b920 fix round 2): "has a git-tracked file" is a FALSE claim about a check that never completed.
 */
export function trackedBlockReason(tracked: GitTrackedState): string | null {
  if (tracked === "tracked") return "a file under this copy is tracked by git, so it is repo-owned content Loom will not overwrite";
  // Worded to avoid any form of "is tracked": this state is a check that did not COMPLETE, and even
  // inside a hedge ("whether it is tracked") that phrasing reads as a finding at a glance.
  if (tracked === "unknown") return "Loom could not verify this copy's git status, so it will not overwrite it";
  return null;
}

/** Short badge text for the tracked state — `untracked` gets no badge at all (it is the ordinary case). */
export function trackedBadgeLabel(tracked: GitTrackedState): string | null {
  if (tracked === "tracked") return "git-tracked";
  if (tracked === "unknown") return "tracked state unknown";
  return null;
}

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/**
 * How long this copy has been frozen, as a reader-facing phrase. `firstSeenAt` is never refreshed on a
 * repeat sighting (the daemon's own discipline), so this is genuinely "since Loom first stopped managing
 * it" and not "since the last time anything happened".
 *
 * A future `firstSeenAt` (a clock skew, a hand-edited sidecar) reads as "just now" rather than a
 * negative age — the age is context here, not a measurement worth rendering nonsense for.
 */
export function releasedAgeLabel(firstSeenAt: number, now: number = Date.now()): string {
  const ms = now - firstSeenAt;
  if (!Number.isFinite(ms) || ms < MINUTE) return "frozen just now";
  if (ms < HOUR) { const n = Math.floor(ms / MINUTE); return `frozen ${n} ${n === 1 ? "minute" : "minutes"} ago`; }
  if (ms < DAY) { const n = Math.floor(ms / HOUR); return `frozen ${n} ${n === 1 ? "hour" : "hours"} ago`; }
  const n = Math.floor(ms / DAY);
  return `frozen ${n} ${n === 1 ? "day" : "days"} ago`;
}

/** A fingerprint is a long hash; the reader only ever needs enough of it to tell two apart. */
export function shortFingerprint(fp: string | null): string {
  if (!fp) return "unreadable";
  return fp.length <= 12 ? fp : `${fp.slice(0, 12)}…`;
}
