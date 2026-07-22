import fs from "node:fs";
import path from "node:path";
import type { RepoRegistryEntry } from "@loom/shared";
import { isGitRepo } from "../git/reader.js";
import { expandTilde } from "../paths.js";

/**
 * Canonicalize a path that is KNOWN (or expected) to exist on disk, for both COMPARISON and STORAGE.
 * `expandTilde` alone leaves separator style, trailing slashes, drive-letter case, and symlinks/junctions
 * untouched — on Windows two spellings of the identical directory (`C:\work\api` vs `C:/work/api` vs
 * `c:\work\api\`) are NOT `===`-equal even though the filesystem treats them as the same repo, which let
 * the anti-alias guards below fail open (code-review catch: two registry keys — or a registry key and
 * `repoPath` — could point at the same git dir under different spellings and pass every `===` check).
 * `fs.realpathSync.native` resolves symlinks/junctions AND returns the path in its real on-disk form —
 * PREFERRED because a Windows-first project has a known junction hazard (see CLAUDE.md's worktree
 * doctrine) and this collapses that class too, not just spelling differences. Falls back to a plain
 * `path.resolve` (fixes separators + trailing slash, though not case/symlinks) if realpath fails — a
 * defensive backstop, not the expected path, since every caller here has already confirmed the target
 * exists (via `isGitRepo`) before this runs.
 */
function canonicalizeExistingPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The comparison KEY for a canonicalized path — case-FOLDED on win32 (NTFS is case-preserving but
 * case-INSENSITIVE, so `C:\work\api` and `c:\work\api` are the same directory to the OS even though
 * `canonicalizeExistingPath` alone would preserve whichever case each spelling's realpath call happens to
 * return). Used ONLY for equality checks (aliasing / dedup) — the STORED path keeps its real on-disk case
 * from `canonicalizeExistingPath`, never lowercased, so stored registry paths stay human-readable.
 */
function comparisonKey(canonicalPath: string): string {
  return process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
}

/** Result of {@link validateRepoRegistry}. `ok:false` names the FIRST offending entry. */
export type RepoRegistryCheck =
  | { ok: true; value: RepoRegistryEntry[] }
  | { ok: false; error: string };

/**
 * The SHARED validator for a project's `repos` registry (multi-repo epic 49136451, phase 1) — used by
 * the HUMAN-only REST create (POST /api/projects) + update (PATCH /api/projects/:id) paths, the ONLY
 * surfaces that may ever set this field (see db.ts's `updateProject` doc + CLAUDE.md: each entry carries
 * its own `gateCommand`, so this inherits the host-RCE trust class of `repoPath`/`gateCommand`/
 * `python.interpreterPath`). Modeled on {@link validateReferenceRepos}, plus the registry-specific
 * invariants a plain string-array field doesn't need: unique keys, a reserved key, and no path aliasing.
 *
 * Each entry must be:
 *  (1) a non-empty `key` (TRIMMED before any check/store, so `" api"` and `"api"` are the same key — a
 *      previously-untrimmed key would silently never match a manager typing the trimmed form back),
 *      UNIQUE across the array, and not the reserved `"primary"` (which always means `repoPath` — a
 *      registry entry can never shadow it);
 *  (2) an ABSOLUTE, {@link expandTilde}-expanded host `path` — a worker's cwd is a worktree elsewhere on
 *      disk, so a relative path is meaningless to it;
 *  (3) an EXISTING git repository (`isGitRepo`, mirroring the repoPath / referenceRepos guards);
 *  (4) not aliasing another entry's path, the project's `vaultPath`, or the project's `repoPath` itself —
 *      two keys resolving to the same repo buys nothing and phase 2 adds a repo axis to worktree/branch
 *      keying, so an alias would mean two worktrees racing on the same git dir and branch namespace. This
 *      alias check runs on {@link canonicalizeExistingPath}-resolved + {@link comparisonKey}-folded forms
 *      of every path involved (entries AND `opts.repoPath`/`opts.vaultPath`), not raw `===`, so a
 *      differently-spelled/-cased/symlinked alias can't slip through (code-review catch — see
 *      `canonicalizeExistingPath`'s own doc). `opts.repoPath`/`opts.vaultPath` themselves are used
 *      READ-ONLY for this comparison and are NEVER rewritten — canonicalizing an EXISTING project's
 *      stored `repoPath`/`vaultPath` is a migration concern, out of scope here.
 *
 * The STORED `path` for each accepted entry is the canonicalized (`canonicalizeExistingPath`) form, not
 * the raw input — desirable here specifically because `repos` is a brand-new field with no pre-existing
 * data to preserve/migrate, unlike `repoPath`/`vaultPath`.
 *
 * `gateCommand`, when given, must be a non-empty string — deliberately NOT validated as an executable
 * (same posture as the project-level `orchestration.gateCommand`, which is opaque shell text). Omitted
 * means this repo has no configured gate; {@link resolveRepo} surfaces that as `gateCommand: undefined`
 * rather than inheriting the project-level command (see `RepoRegistryEntry`'s own doc).
 *
 * Rejects the WHOLE array on the first bad entry (naming it), never a partial accept.
 */
export async function validateRepoRegistry(
  input: unknown,
  opts: { repoPath: string; vaultPath: string },
): Promise<RepoRegistryCheck> {
  if (!Array.isArray(input)) return { ok: false, error: "repos must be an array" };
  const repoPathKey = comparisonKey(canonicalizeExistingPath(opts.repoPath));
  const vaultPathKey = opts.vaultPath ? comparisonKey(canonicalizeExistingPath(opts.vaultPath)) : "";
  const seenKeys = new Set<string>();
  const seenPathKeys = new Set<string>();
  const out: RepoRegistryEntry[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "each repos entry must be an object with key + path" };
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.key !== "string" || !entry.key.trim()) {
      return { ok: false, error: "each repos entry needs a non-empty string key" };
    }
    const key = entry.key.trim();
    if (key === "primary") {
      return { ok: false, error: `repos entry key "primary" is reserved (it always means repoPath)` };
    }
    // CHARSET GUARD (multi-repo epic 49136451 phase 2, Code Review Major 2): phase 2 promotes `key` to a
    // FILESYSTEM PATH SEGMENT — worktrees.ts's createWorktree joins it straight into
    // `WORKTREES_DIR/projectId/<repoKey>/<taskKey>` with no further sanitization. An unrestricted key
    // (e.g. "..", "../shared", or anything containing `/`/`\`) would cut that worktree OUTSIDE the
    // project's worktree namespace — and boot-reconcile's Pass B then FORCE-REMOVES at whatever path it
    // resolves to (gcWorktreeDir), turning a typo into a force-remove outside the intended directory. This
    // input is human-only (REST create/PATCH), so it isn't a privilege-escalation vector, but the
    // data-loss SHAPE is new in this phase and cheap to close now, before real registries exist in the
    // wild that would need a migration to retrofit it onto. `.`/`..` both match the charset below on their
    // own, so they're rejected explicitly rather than relying on the regex to catch them.
    if (!/^[A-Za-z0-9._-]+$/.test(key)) {
      return { ok: false, error: `repos entry key "${key}" must match [A-Za-z0-9._-]+ — it is used as a filesystem path segment for the worktree axis, so slashes, backslashes, and other special characters are rejected` };
    }
    if (key === "." || key === "..") {
      return { ok: false, error: `repos entry key "${key}" is reserved — a filesystem path segment cannot be "." or ".."` };
    }
    if (seenKeys.has(key)) {
      return { ok: false, error: `repos entry key "${key}" is duplicated — keys must be unique` };
    }
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      return { ok: false, error: `repos entry "${key}" needs a non-empty string path` };
    }
    const expandedPath = expandTilde(entry.path);
    if (!path.isAbsolute(expandedPath)) {
      return { ok: false, error: `repos entry "${key}" path must be absolute: ${expandedPath}` };
    }
    if (!(await isGitRepo(expandedPath))) {
      return { ok: false, error: `repos entry "${key}" path is not an existing git repository: ${expandedPath}` };
    }
    const canonicalPath = canonicalizeExistingPath(expandedPath);
    const pathKey = comparisonKey(canonicalPath);
    if (pathKey === repoPathKey) {
      return { ok: false, error: `repos entry "${key}" path aliases the project's primary repoPath — give it a distinct repo or drop it (use the reserved "primary" key implicitly instead)` };
    }
    if (vaultPathKey && pathKey === vaultPathKey) {
      return { ok: false, error: `repos entry "${key}" path aliases the project's vaultPath` };
    }
    if (seenPathKeys.has(pathKey)) {
      return { ok: false, error: `repos entry "${key}" path duplicates another registry entry's path: ${canonicalPath}` };
    }
    let gateCommand: string | undefined;
    if (entry.gateCommand !== undefined) {
      if (typeof entry.gateCommand !== "string" || !entry.gateCommand.trim()) {
        return { ok: false, error: `repos entry "${key}" gateCommand must be a non-empty string when given` };
      }
      gateCommand = entry.gateCommand;
    }
    seenKeys.add(key);
    seenPathKeys.add(pathKey);
    out.push(gateCommand === undefined ? { key, path: canonicalPath } : { key, path: canonicalPath, gateCommand });
  }
  return { ok: true, value: out };
}

/** Result of {@link diffRepoRegistry} — a project's live manager/platform sessions need to be told which
 *  keys changed, not just that "something changed" (card 540a3281). Keyed by `key` (the stable identity
 *  of an entry across a PATCH), never by array position. */
export interface RepoRegistryDiff {
  added: string[];
  removed: string[];
  /** A key present in BOTH before/after but whose `path` or `gateCommand` differs — a repo that MOVED or
   *  gained/lost its gate is exactly as significant to a manager holding the OLD registry as an add/remove
   *  (a stale path assumption, or a merge that now reports unverified for a reason the manager can't see). */
  updated: string[];
}

/**
 * Pure key-level diff between a project's `repos` registry before/after a PATCH — the shared basis for
 * both the "is this actually a change" gate and the human-readable notification (card 540a3281: notify
 * live manager/platform sessions when the registry changes). Deliberately NOT the same thing as the
 * PATCH handler's own `JSON.stringify(...) !== JSON.stringify(...)` no-op guard (array order differences
 * would trip that but produce an empty diff here) — this is the finer-grained "what do I tell a manager"
 * view, always computed only after that coarser guard has already confirmed SOME change exists.
 */
export function diffRepoRegistry(before: RepoRegistryEntry[], after: RepoRegistryEntry[]): RepoRegistryDiff {
  const beforeByKey = new Map(before.map((e) => [e.key, e]));
  const afterByKey = new Map(after.map((e) => [e.key, e]));
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  for (const [key, entry] of afterByKey) {
    const prior = beforeByKey.get(key);
    if (!prior) added.push(key);
    else if (JSON.stringify(prior) !== JSON.stringify(entry)) updated.push(key);
  }
  for (const key of beforeByKey.keys()) if (!afterByKey.has(key)) removed.push(key);
  return { added: added.sort(), removed: removed.sort(), updated: updated.sort() };
}

/**
 * Compose the `[loom:repo-registry-changed]` operational note (card 540a3281) — enqueued `kind:"warning"`
 * (an FYI that coalesces with other Loom nudges, never interrupts a directive) into live manager/platform
 * sessions on a REAL `repos` registry change. Names every added/removed/UPDATED key explicitly (a bare
 * "the registry changed" makes the reader re-derive state it can't see), and always restates the dispatch
 * mechanism (`repoKey` at card-creation time; unset = primary; a removed key 400s if still targeted) since
 * that's the actionable part regardless of which keys moved.
 *
 * `opts.projectName`, when given, prefixes the note with the project's name — for a platform (Lead)
 * session, which spans every project and so is never implicitly scoped to the one that changed (unlike a
 * manager session, which IS scoped to exactly this project and would find its own name redundant).
 */
export function composeRepoRegistryChangeNote(diff: RepoRegistryDiff, opts: { projectName?: string } = {}): string {
  const fmt = (keys: string[]) => keys.map((k) => `\`${k}\``).join(", ");
  const parts: string[] = [];
  if (diff.added.length) parts.push(`added: ${fmt(diff.added)}`);
  if (diff.removed.length) parts.push(`removed: ${fmt(diff.removed)}`);
  if (diff.updated.length) parts.push(`reconfigured (path/gateCommand changed): ${fmt(diff.updated)}`);
  const changeSummary = parts.length ? parts.join("; ") : "its entries were updated";
  const scope = opts.projectName ? `Project "${opts.projectName}"'s` : "This project's";
  return `[loom:repo-registry-changed] ${scope} repo registry changed (${changeSummary}). Cards are routed to a repo at CREATION time via \`repoKey\` (tasks_create/tasks_update); a card with no repoKey targets \`primary\`. A removed key can no longer be targeted — a card still carrying one will 400 at write time, so re-route or hold anything you were about to file at a removed key. A reconfigured key's new path/gate applies to any card routed there going forward.`;
}

/** Result of {@link resolveRepoKeyOrError}. */
export type RepoKeyCheck =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * The SHARED validator for `Task.repoKey` against a project's registry — used by both agent-facing write
 * surfaces (`mcp/tasks.ts` `createProjectTask`/`updateProjectTask`, `mcp/platform.ts`
 * `project_task_create`/`project_task_update`) and the human REST task routes (`gateway/server.ts`), so
 * "unknown key" reads identically everywhere a task can be written. `null`/`undefined`/omitted always
 * means "primary" and needs no registry lookup. A non-null key must name an entry in `repos` (or the
 * reserved `"primary"`, accepted as an explicit spelling of the default) — anything else is an explicit
 * error, never a silent fallback (a typo'd key should never silently land on the wrong repo).
 */
export function resolveRepoKeyOrError(repos: RepoRegistryEntry[], repoKey: string | null | undefined): RepoKeyCheck {
  if (repoKey === undefined || repoKey === null || repoKey === "primary") return { ok: true, value: null };
  if (!repos.some((r) => r.key === repoKey)) {
    return { ok: false, error: `repoKey "${repoKey}" does not name a registered repo on this project (registered: ${repos.map((r) => r.key).join(", ") || "none"})` };
  }
  return { ok: true, value: repoKey };
}
