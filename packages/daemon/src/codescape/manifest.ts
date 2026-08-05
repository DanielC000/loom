import fs from "node:fs";
import path from "node:path";

/**
 * Card 088afc94 (P4 wiring) — resolve CODESCAPE's OWN project id for a repo path by reading back the
 * plain-JSON manifest `codescape ingest` already writes, rather than reimplementing their id-generation
 * algorithm (`slugify(basename) + '-' + sha256(lowercased resolved path).slice(0,8)`, projectStore.ts
 * `projectIdFor`) here in TypeScript — CONFIRMED with the Codescape manager: never reimplement their id
 * algorithm. Reimplementing it would be a FRAGILE duplication that silently breaks the day their
 * algorithm changes, with no compile error to catch it. This is also the confirmed root cause of an
 * EARLIER abandoned HTTP-mount attempt (see pty/host.ts's `codescapeMcpServer` doc): scoping by Loom's
 * own project.id (a UUID, unrelated to codescape's path-derived id) meant the MCP mount never
 * registered — sessions 404'd silently. Reading the manifest sidesteps that class of bug entirely:
 * whatever id codescape assigned is whatever this reads back.
 *
 * PATH — CONFIRMED with Codescape, this is the part that was NOT obvious from the card alone: the
 * manifest is resolved from the SERVE PROCESS'S OWN CWD (`path.resolve(".codescape")` on their side),
 * NOT some fixed Loom-side location. Loom SUPERVISES that process and pins its launch cwd to
 * `CODESCAPE_HOME_DIR` (the CWD CONTRACT — see codescape/supervisor.ts: both `ingest` and `serve` spawn
 * from the SAME `homeDir`), which is exactly why this resolves to `<homeDir>/.codescape/projects/
 * index.json` — e.g. `<LOOM_HOME>/codescape/.codescape/projects/index.json`. This function takes
 * `homeDir` as a param rather than defaulting to `CODESCAPE_HOME_DIR` internally so it can never drift
 * from whatever cwd a given `CodescapeSupervisor` instance actually launched from (see that class's
 * `getHomeDir()` — callers should pass `codescape.getHomeDir()`, not re-derive it).
 *
 * SHAPE: `{version, projects: [{id, name, path, branch?, lastIngested, graphPath}]}`. `version` is
 * bumped on a breaking change (Codescape-confirmed) — this reads it and clean-skips + logs loudly on an
 * unexpected version rather than parsing blindly into a shape that may no longer match.
 *
 * JUNK ROWS: Codescape-confirmed — their manifest can genuinely contain a junk entry (a known arg-parse
 * bug on their side, e.g. a stray `--help` row) with a missing/malformed `path`. Every entry is
 * shape-checked before use; a junk row is skipped, never thrown on — a crash here would take out every
 * session's MCP wiring for the whole daemon, which is a wildly disproportionate blast radius for one bad
 * manifest row. See test/codescape-manifest.mjs for the junk-row coverage.
 *
 * FUTURE SWAP: Codescape is carding `GET /projects` (a live lookup) and `POST /project` (returns the id
 * directly) as conveniences, not prerequisites — this manifest-file read is what unblocks P4 today. Kept
 * as the ONE seam (`resolveCodescapeProjectId`) so swapping to a live lookup later is a one-function
 * change, not a grep-and-replace across every call site.
 */
export interface CodescapeManifestEntry {
  id: string;
  name: string;
  path: string;
  branch?: string;
  lastIngested: string;
  graphPath: string;
}

export interface CodescapeManifest {
  version: number;
  projects: CodescapeManifestEntry[];
}

/** The only manifest shape this module understands. Codescape-confirmed: `version` bumps on a breaking
 *  change — an unrecognized version must clean-skip (never parse blindly into a shape that may have
 *  moved on). */
const SUPPORTED_MANIFEST_VERSION = 1;

function manifestPath(homeDir: string): string {
  return path.join(homeDir, ".codescape", "projects", "index.json");
}

/** A manifest row is usable only if `id` and `path` are both non-empty strings — every other field is
 *  informational. Guards the junk-row case (a malformed entry with a missing/non-string `path`) from
 *  ever reaching `path.resolve` (which throws on a non-string) or a false id resolution. */
function isUsableEntry(p: unknown): p is CodescapeManifestEntry {
  const e = p as Partial<CodescapeManifestEntry> | null;
  return !!e && typeof e.id === "string" && e.id.length > 0 && typeof e.path === "string" && e.path.length > 0;
}

/**
 * Reads + parses the manifest, or `null` on ANY read/parse failure (missing file — never ingested yet;
 * a corrupt/mid-write file; an unreadable dir; an unrecognized `version`) — never throws. Junk rows are
 * filtered out here (not left for every caller to re-guard) so `resolveCodescapeProjectId` only ever
 * sees shape-valid entries.
 */
export function readCodescapeManifest(homeDir: string): CodescapeManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(homeDir), "utf-8"));
    if (!parsed || parsed.version !== SUPPORTED_MANIFEST_VERSION || !Array.isArray(parsed.projects)) {
      if (parsed && parsed.version !== SUPPORTED_MANIFEST_VERSION) {
        console.warn(`[codescape] manifest version ${parsed.version} is not the supported version ${SUPPORTED_MANIFEST_VERSION} — skipping (never parsing blindly)`);
      }
      return null;
    }
    return { version: parsed.version, projects: parsed.projects.filter(isUsableEntry) };
  } catch {
    return null;
  }
}

/** Case-insensitive, resolved-path comparison — mirrors `projectIdFor`'s own `.toLowerCase()` on the
 *  resolved path (their comment: "Windows paths are case-insensitive"). The manifest's stored `path` is
 *  the exact-case resolved repo path, so this only widens the match to tolerate case/separator drift
 *  between however Loom and codescape each resolved the same directory — it does not change WHICH id
 *  wins when paths genuinely differ. */
function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Resolve codescape's project id for `repoPath`, or `null` if that repo has no (usable) manifest entry
 * (not yet ingested, ingested under a since-changed path, or only a junk row exists). A `null` here is a
 * CLEAN SKIP for every caller — an unresolved id must never be guessed at or fall back to Loom's own
 * project.id (see this module's own doc for why that's the exact bug that sank an earlier attempt).
 * Callers must LOG the outcome (resolved id, or "unresolved") rather than silently no-op — an unresolved
 * id that only shows up as "the MCP mount is just missing" is invisible until an agent notices, same as
 * the incident this card exists to fix.
 */
export function resolveCodescapeProjectId(repoPath: string, homeDir: string): string | null {
  const manifest = readCodescapeManifest(homeDir);
  if (!manifest) return null;
  const entry = manifest.projects.find((p) => samePath(p.path, repoPath));
  return entry?.id ?? null;
}

/**
 * Card 0e4a859a — resolve the freshness stamp (the manifest entry's own `lastIngested`) for a repo's
 * ingested graph, or `null` if that repo has no (usable) manifest entry. A SEPARATE read from
 * {@link resolveCodescapeProjectId} (not folded into its return): most callers only need the id, and this
 * is read only by the few call sites that also need to show a human-readable "graph last indexed" stamp
 * (the manager/worker prompt block — see `sessions/service.ts` `resolveCodescapeGraphContext`). Same
 * clean-skip contract as `resolveCodescapeProjectId` — never throws, never guesses.
 */
export function resolveCodescapeLastIngested(repoPath: string, homeDir: string): string | null {
  const manifest = readCodescapeManifest(homeDir);
  if (!manifest) return null;
  const entry = manifest.projects.find((p) => samePath(p.path, repoPath));
  return entry?.lastIngested ?? null;
}
