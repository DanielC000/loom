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
 * The marked row is VALIDATED before it's trusted (card a47dd144): it must actually exist, be
 * `reserved`, must NOT be the id currently marked for the OTHER home (`otherMarkerKey`), and (round 2)
 * must NOT be named for the OTHER home either (`otherNameCandidates`) — the id check alone misses the
 * case where the other home's OWN marker was never stamped (e.g. a pre-marker row, or a marker mis-set
 * by a bug) and so has no id to collide against; checking the name too catches that even then. On any
 * validation failure the marked row is silently ignored and the name-match fallback below re-derives
 * (and re-stamps) the correct id instead — so a stale, mis-stamped, id-colliding, or name-colliding
 * marker is rejected rather than trusted, but a marker whose row is named for something OTHER than
 * either home's own candidates is still accepted (there's nothing left to disambiguate it against).
 *
 * `nameCandidates` is tried in order (the current display name first, then any legacy literal); the
 * first reserved project matching ANY of them wins. The name fallback is ARCHIVE-AGNOSTIC
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
  const markedId = db.getMeta(markerKey);
  if (markedId) {
    const marked = db.getProject(markedId);
    const otherId = db.getMeta(otherMarkerKey);
    const collidesById = otherId != null && markedId === otherId;
    const collidesByName = !!marked && otherNameCandidates.includes(marked.name);
    if (marked && marked.reserved && !collidesById && !collidesByName) return marked;
    // Stale (row gone), mis-stamped (not reserved), or colliding with the other home's marker id/name —
    // fall through to the name match below rather than trusting it.
  }
  for (const name of nameCandidates) {
    const byName = db.getReservedProjectByNameIncludingArchived(name);
    if (byName) {
      db.setMeta(markerKey, byName.id); // backfill/repair — self-heals a missing or bad marker too
      return byName;
    }
  }
  return undefined;
}
