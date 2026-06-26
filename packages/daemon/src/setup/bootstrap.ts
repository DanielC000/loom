import path from "node:path";
import fs from "node:fs";
import { simpleGit } from "simple-git";
import { WORKSPACE_ROOT, LOOM_HOME } from "../paths.js";

/**
 * Host-bootstrap for the ungated Setup/Platform operator's `project_init` tool — the ONLY host-write the
 * `loom-setup` surface holds, and a deliberately TINY, FAIL-CLOSED one. The operator can create a fresh
 * project directory ONLY strictly under the SANCTIONED base ({@link WORKSPACE_ROOT}, inside LOOM_HOME):
 *
 *   - The caller NEVER supplies an absolute or arbitrary host path. The leaf directory is derived from the
 *     project name (or an explicit `dirName`), and is validated to be a SINGLE safe path segment (no
 *     separators, no `..`, not absolute).
 *   - The resolved target is then re-checked to live STRICTLY under the sanctioned base (defence in depth:
 *     even if leaf validation missed something, a `path.resolve` that escaped the base is rejected). It can
 *     never equal LOOM_HOME or any reserved/system home — the confinement makes that structurally impossible.
 *   - It refuses to clobber an existing path (fail-closed) and best-effort-cleans the dir it just made if a
 *     `git init` then fails, so a half-bootstrapped project never strands an empty dir.
 *
 * This adds NO general host-writer/escalation surface: it is bounded to one fixed base, hardcoded ops, and
 * returns a structured result (never throws for an expected failure) the MCP tool surfaces as data.
 */

/** Bounded ceiling for the lone `git init` (mirrors git/worktrees.ts GIT_OP_TIMEOUT_MS — a local ref op). */
const GIT_INIT_TIMEOUT_MS = 15_000;

export type BootstrapResult = { ok: true; dir: string } | { ok: false; error: string };

/** Reject `p` after `ms` so a wedged git child can't hang the daemon (mirrors the git writers' guard). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms (hung git child?)`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Derive a filesystem-safe leaf directory name from a project name: lowercase, non-alphanumerics collapsed
 * to single dashes, trimmed, capped. Returns null when nothing usable remains (e.g. an all-symbol name) —
 * the caller then asks for an explicit `dirName`.
 */
export function slugifyProjectDir(name: string): string | null {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug.length > 0 ? slug : null;
}

/** Is `leaf` a single, safe path segment (no separators, no `.`/`..`, not absolute)? The traversal guard. */
function isSafeLeaf(leaf: string): boolean {
  if (!leaf || leaf === "." || leaf === "..") return false;
  if (leaf.includes("/") || leaf.includes("\\")) return false;
  if (path.isAbsolute(leaf)) return false;
  return path.basename(leaf) === leaf; // basename strips any path component — must be a no-op
}

/** True if `p` exists and is a directory (used by project_create's vault-only path; never throws). */
export function isExistingDir(p: string): boolean {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create a fresh project directory under the sanctioned base (and `git init` it when `git` is true).
 * `base`/`gitInit` are injectable test seams (default: {@link WORKSPACE_ROOT} + the real simple-git).
 * Returns the created absolute dir on success, or a structured error (nothing is created on rejection).
 */
export async function bootstrapProjectDir(opts: {
  name: string;
  dirName?: string;
  git: boolean;
  base?: string;
  gitInit?: (dir: string) => Promise<void>;
}): Promise<BootstrapResult> {
  const base = path.resolve(opts.base ?? WORKSPACE_ROOT);
  const leaf = (opts.dirName ?? slugifyProjectDir(opts.name) ?? "").trim();
  if (!leaf) {
    return { ok: false, error: "could not derive a directory name from the project name — pass an explicit dirName (letters, digits, dashes)" };
  }
  if (!isSafeLeaf(leaf)) {
    return { ok: false, error: `invalid directory name "${leaf}" — must be a single path segment (no separators, no "..", not absolute)` };
  }
  const target = path.resolve(base, leaf);
  // Confinement (defence in depth on top of isSafeLeaf): the target must live STRICTLY under the sanctioned
  // base — never the base itself, never an escape. This structurally precludes LOOM_HOME / any reserved home.
  if (target === base || !target.startsWith(base + path.sep)) {
    return { ok: false, error: "refused: the target directory escapes the sanctioned workspace base" };
  }
  if (path.resolve(target) === path.resolve(LOOM_HOME)) {
    return { ok: false, error: "refused: cannot initialize a project at the reserved daemon home" };
  }
  if (fs.existsSync(target)) {
    return { ok: false, error: `a directory already exists at ${target} — choose a different name` };
  }
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (e) {
    return { ok: false, error: `could not create the project directory: ${(e as Error).message}` };
  }
  if (opts.git) {
    try {
      const gitInit = opts.gitInit ?? (async (dir: string) => {
        await withTimeout(simpleGit(dir, { timeout: { block: GIT_INIT_TIMEOUT_MS } }).init(), GIT_INIT_TIMEOUT_MS, "git init");
      });
      await gitInit(target);
    } catch (e) {
      // Don't strand an empty dir if init fails — best-effort cleanup so a retry under the same name works.
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best-effort */ }
      return { ok: false, error: `git init failed: ${(e as Error).message}` };
    }
  }
  return { ok: true, dir: target };
}
