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
 * The reserved setup home's operator agent DISPLAY name (also the name-scoped anchor several runtime
 * call sites resolve by) — see `setup/seed.ts`'s re-export for the full rebrand history.
 *
 * Card b2b69ec8: moved here from `setup/seed.ts`, alongside `SETUP_HOME_LEAD_AGENT_ID_KEY` and
 * `resolveLiveSetupHome` below, to break the `setup/seed.ts` <-> `projects/live-lead-home.ts` import
 * cycle those two needed — `live-lead-home.ts` now imports all three from this neutral module instead
 * of from `setup/seed.ts`, while `setup/seed.ts` keeps re-exporting them for its own existing importers.
 */
export const SETUP_AGENT_NAME = "Platform";

/**
 * Daemon-GLOBAL app_meta marker holding the id of the setup home's OWN operator agent whenever one is
 * identified — see `setup/seed.ts`'s re-export for the full stamping-sites doc. Moved here for the same
 * import-cycle reason as `SETUP_AGENT_NAME` above (card b2b69ec8).
 */
export const SETUP_HOME_LEAD_AGENT_ID_KEY = "setup.platformLeadAgentId";

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

/**
 * Resolve the reserved setup home by its stable app_meta id marker, falling back to a NAME match
 * (current, then the pre-rebrand legacy literal) for an install that pre-dates the marker or whose
 * marker fails validation, backfilling the marker the instant a name match is found.
 *
 * Moved here from `setup/seed.ts` (card b2b69ec8) so `projects/live-lead-home.ts` can resolve the setup
 * home WITHOUT importing `setup/seed.ts` — see `resolveLiveSetupHome` below for why that import had to
 * go. `setup/seed.ts` re-exports this for its own seeders/migrations; ARCHIVE-AGNOSTIC by design, so a
 * seeder's own idempotency gate treats an archived reserved home as already-seeded rather than minting a
 * live duplicate beside it. Do NOT call this directly from a runtime (non-seeder) call site — an archived
 * reserved project is not a valid target to act on even though its marker still resolves it; use the
 * exported `resolveLiveSetupHome` instead.
 */
export function resolveSetupHome(db: Db): Project | undefined {
  return resolveReservedHomeByMarker(
    db,
    SETUP_HOME_PROJECT_ID_KEY,
    PLATFORM_HOME_PROJECT_ID_KEY,
    [SETUP_PROJECT_NAME, LEGACY_SETUP_PROJECT_NAME],
    [PLATFORM_PROJECT_NAME],
  );
}

/**
 * Card 5dff8d08: the LIVE-only twin of `resolveSetupHome` above, for every RUNTIME (non-seeder) call
 * site — mirrors the pre-card `db.getReservedProjectByName`'s archive-EXCLUSIVE contract, now surviving
 * a human rename too. An archived reserved home (unreachable via any write surface today — both
 * `DELETE /api/projects/:id` and the Platform Lead's `project_archive` refuse a `p.reserved` project)
 * must still read as "no home" to a runtime call site, rather than being treated as actionable just
 * because its stable marker still resolves it.
 *
 * Moved here from `setup/seed.ts` (card b2b69ec8), alongside `resolveSetupHome`, `SETUP_AGENT_NAME` and
 * `SETUP_HOME_LEAD_AGENT_ID_KEY` above — `projects/live-lead-home.ts` needs all four, and importing them
 * from `setup/seed.ts` is what created that file's import cycle with `setup/seed.ts` (which itself needs
 * `resolveHomeLeadAgent` from `live-lead-home.ts`). `setup/seed.ts` re-exports this for its own existing
 * importers (`sessions/service.ts`, `gateway/server.ts`, `setup/first-run.ts`).
 */
export function resolveLiveSetupHome(db: Db): Project | undefined {
  const home = resolveSetupHome(db);
  return home && !home.archivedAt ? home : undefined;
}
