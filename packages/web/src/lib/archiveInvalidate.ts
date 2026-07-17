// Query keys the Archive page invalidates on Restore/Delete. Must match the canonical keys exactly
// ("archive" per api.archivedSessions/Archive/Overview/RunHistory, "allArchivedSessions" per
// api.allArchivedSessions/MissionControl) or those views silently show stale data until a manual refetch
// (UI-audit finding #12). "archivedSessionById" is SessionView's by-id lookup (repointed off the full
// list — see api.archivedSessionById). React Query invalidates by PREFIX MATCH, so each bare key here
// also covers its own parameterized variants (e.g. ["archive", projectId, limit], ["archivedSessionById",
// id]).
export const ARCHIVE_INVALIDATE_KEYS: string[][] = [
  ["archive"],             // per-project archived page (Archive/Overview/RunHistory, every scope+limit)
  ["allArchivedSessions"], // cross-project god-eye archive (MissionControl)
  ["archivedSessionById"], // SessionView's by-id archived lookup
  ["allSessions"],         // god-eye live views
  ["sessions"],            // every agent's rail
];
