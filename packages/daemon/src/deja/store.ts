import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The path to Deja's own global mockup store — the SAME `<home>/.deja/store.sqlite` the
 * deja-capture.mjs PostToolUse relay writes into (`resolveDejaDbPath` there) and `deja mcp`/
 * `retrieve` read from, both via `os.homedir()`. Duplicated here (rather than imported from the
 * shipped `assets/deja-capture.mjs` relay) to keep this daemon-side read decoupled from that
 * asset script's module boundary — it's two lines, not worth a cross-package import.
 */
export function resolveDejaStorePath(): string {
  return path.join(os.homedir(), ".deja", "store.sqlite");
}

/**
 * Count of mockups ever captured into Deja's global store, for the dejaCapture toggle's
 * self-explaining status line (card 1c0c1a2c) — turns a silently-empty ON toggle into "0 mockups
 * seen yet" / "N mockups captured". READ-ONLY peek at Deja's own `mockups` table (Deja's
 * `src/store.ts`, an external product Loom does not own — see deja-capture.mjs's header for why
 * the daemon has no say over this store's location or schema). Best-effort: the store may not
 * exist yet (dejaCapture just turned on, nothing captured), or Deja's schema could differ from
 * what's expected — either way this degrades to 0 rather than throwing, so a broken read never
 * takes down the status endpoint that serves it.
 */
export function getDejaCaptureCount(): number {
  const dbPath = resolveDejaStorePath();
  if (!fs.existsSync(dbPath)) return 0;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT COUNT(*) AS n FROM mockups").get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
