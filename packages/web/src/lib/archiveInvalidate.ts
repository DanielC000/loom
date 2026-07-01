// Query keys the Archive page invalidates on Restore/Delete. Must match the canonical god-eye key
// exactly ("allArchivedSessions", per api.allArchivedSessions/MissionControl/RunHistory/SessionView) or
// those views silently show stale data until a manual refetch (UI-audit finding #12).
export const ARCHIVE_INVALIDATE_KEYS: string[][] = [
  ["archive"],             // this page (every project scope)
  ["allArchivedSessions"], // god-eye archive views
  ["allSessions"],         // god-eye live views
  ["sessions"],            // every agent's rail
];
