import type { Project } from "@loom/shared";
import type { Db } from "../db.js";

/**
 * Daemon-GLOBAL app_meta keys: each holds the ONE reserved home's own project id — a stable
 * discriminator that survives a later rename — plus the two homes' own display names, kept in this
 * neutral module (never in `setup/seed.ts` or `platform/seed.ts` themselves) so each seeder can
 * cross-validate its own marker/name against the OTHER home's without the two files importing one
 * another.
 *
 * @decision a47dd144 — never resolve a reserved home by name alone (a human can rename one via PATCH
 * /api/projects/:id); never move these names back into the seed files. See record for the full
 * rationale.
 */
export const SETUP_HOME_PROJECT_ID_KEY = "setup.homeProjectId";
export const PLATFORM_HOME_PROJECT_ID_KEY = "platform.homeProjectId";

/** The reserved setup home's current display name — see `setup/seed.ts`'s re-export for the full doc. */
export const SETUP_PROJECT_NAME = "Platform";
/** The setup home's pre-rebrand legacy name — see `setup/seed.ts`'s re-export for the full doc. Typed
 * `string` (not a literal) so `SETUP_PROJECT_NAME === LEGACY_SETUP_PROJECT_NAME` type-checks there. */
export const LEGACY_SETUP_PROJECT_NAME: string = "Getting Started";
/** The reserved platform home's display name — see `platform/seed.ts`'s re-export for the full doc. */
export const PLATFORM_PROJECT_NAME = "Loom Platform";

/**
 * Resolve ONE reserved home by its stable marker, falling back to a NAME match for an install that
 * pre-dates the marker (or whose marker fails validation) and BACKFILLING the marker the instant a name
 * match is found — so a name match is needed at most once per LOOM_HOME, ever.
 *
 * The marked row is VALIDATED before it's trusted (card a47dd144): it must actually exist and be
 * `reserved`, and must NOT be the id currently marked for the OTHER home (`otherMarkerKey`). The id check
 * is the PRIMARY, always-on signal — a marker whose own id doesn't collide with an ALREADY-STAMPED other
 * marker is genuinely this home's own row, however it is currently NAMED, so a human rename (via `PATCH
 * /api/projects/:id`) of one reserved home to overlap with the OTHER home's name/legacy-name must never
 * un-trust an otherwise-valid marker.
 *
 * @decision 5dff8d08 — when OTHER is unset, reject only when BOTH hold: marked looks like the OTHER
 * home's name, AND a distinct LIVE row matches THIS home's PRIMARY (non-legacy) name. See record.
 *
 * `nameCandidates` is tried in order (the current display name first, then any legacy literal); the
 * first reserved project matching ANY of them wins, EXCLUDING the id the OTHER marker already holds
 * (never backfill this marker onto a row the other one already owns — that would stamp both markers onto
 * one row, card 5dff8d08 round 3). The name fallback is ARCHIVE-AGNOSTIC
 * (`getReservedProjectByNameIncludingArchived`), matching the pre-marker `hasReservedProjectNamed` gate
 * it replaces — an archived legacy home must still count as "already seeded", never as grounds to mint
 * a second, live one beside it. Returns undefined when no home exists yet.
 */
export function resolveReservedHomeByMarker(
  db: Db,
  markerKey: string,
  otherMarkerKey: string,
  nameCandidates: readonly string[],
  otherNameCandidates: readonly string[],
): Project | undefined {
  const otherId = db.getMeta(otherMarkerKey);
  const markedId = db.getMeta(markerKey);
  if (markedId) {
    const marked = db.getProject(markedId);
    const collidesById = otherId != null && markedId === otherId;
    // BOTH signals required (card 5dff8d08 round 4) — see the function doc + decision record for why
    // either alone misfires: name-only rejects a home merely renamed; distinct-candidate-only rejects a
    // validly-marked, UNTOUCHED home just because a stale duplicate or archived orphan happens to carry
    // one of ITS OWN candidate names (fires on every normal LOOM_DEV-off install, forever). The second
    // signal checks ONLY nameCandidates[0] (the PRIMARY, current name) — NEVER any legacy candidate: a
    // legacy-name match is migration-compatibility evidence, not a reliable "a real distinct home exists"
    // signal, and checking every candidate let an unrelated live orphan squatting on the LEGACY name alone
    // (while the marked row vacated the PRIMARY name via an ordinary rename) wrongly count as "distinct"
    // (round 4's own P5 finding).
    const looksLikeOtherHome = otherId == null && !!marked && otherNameCandidates.includes(marked.name);
    const primaryName = nameCandidates[0];
    const distinctLiveCandidateExists = looksLikeOtherHome && primaryName !== undefined && (() => {
      const row = db.getReservedProjectByName(primaryName); // LIVE-only — an archived orphan never counts
      return !!row && row.id !== markedId;
    })();
    if (marked && marked.reserved && !collidesById && !distinctLiveCandidateExists) return marked;
    // Stale (row gone), mis-stamped (not reserved), id-colliding, or BOTH name-overlap AND a genuinely
    // distinct LIVE home exist — fall through to the name match below rather than trusting it.
  }
  for (const name of nameCandidates) {
    const byName = db.getReservedProjectByNameIncludingArchived(name);
    if (byName && byName.id !== otherId) {
      db.setMeta(markerKey, byName.id); // backfill/repair — self-heals a missing or bad marker too
      return byName;
    }
  }
  return undefined;
}
