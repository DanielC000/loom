import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The umbrella package resolved by walking UP from a built daemon file. ONE walk, shared by
 * {@link loomVersion} (the user-facing version) and {@link isPackagedInstall} / {@link umbrellaRootDir}
 * (Epic 2c-2 — the packaged-vs-source gate for the UI update flow). Resolves in BOTH shapes with no code
 * change (⚠️ Part 2 must preserve this — the packaged npm form moves where this file lives):
 *   - monorepo: dist/version.js → … → repo-root package.json (name "loom", the real version);
 *   - packaged npm form: the published `loomctl` package's own root package.json sits ABOVE the bundled
 *     daemon (dist-npm/package.json, name "loomctl"), so the same upward walk finds it.
 * `dir` is the directory that holds the matched package.json — for the packaged form that is the package
 * root (where `bin/loom.mjs` lives, the CLI the self-update spawns).
 */
export interface UmbrellaPackage {
  /** "loom" (monorepo root) or "loomctl" (the published npm name). */
  name: "loom" | "loomctl";
  version: string;
  dir: string;
}

/**
 * Walk UP from `startDir` (default: this built file's dir) to the FIRST package.json whose `name` is the
 * umbrella package — "loom" (monorepo root) OR "loomctl" (the published npm name, since the `loom` name is
 * taken). Bounded walk (12 levels — the umbrella package.json is only a few up in either form). Returns
 * null if nothing matches. `startDir` is injectable so a hermetic test can stage a throwaway package tree
 * and assert resolution against it (mirrors version.mjs's packaged-form check).
 */
export function resolveUmbrellaPackage(startDir: string = __dirname): UmbrellaPackage | null {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
        if ((pkg.name === "loom" || pkg.name === "loomctl") && typeof pkg.version === "string") {
          return { name: pkg.name, version: pkg.version, dir };
        }
      }
    } catch { /* skip an unreadable/malformed package.json and keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  return null;
}

/**
 * The SINGLE source of truth for the user-facing Loom version = the umbrella package's `version` (read at
 * RUNTIME so there is never a second hardcoded copy that can drift). Resolution:
 *   0. `LOOM_VERSION` env — explicit override (highest priority), the escape hatch for any packaging shape
 *      that can't place a `name:"loom"`/`"loomctl"` package.json on the walk-up path.
 *   1. the umbrella package's version (the {@link resolveUmbrellaPackage} walk-up);
 *   2. fallback "0.0.0" if nothing is found (a dev/dist edge case — never crashes the boot).
 */
function readLoomVersion(): string {
  const override = process.env.LOOM_VERSION;
  if (override && override.trim()) return override.trim();
  return resolveUmbrellaPackage()?.version ?? "0.0.0";
}

// The package.json never changes during a daemon run, so resolve once and cache.
let cached: string | null = null;

/** The user-facing Loom version (the `loom` umbrella package version), resolved at runtime + cached. */
export function loomVersion(): string {
  if (cached === null) cached = readLoomVersion();
  return cached;
}

/**
 * Epic 2c-2 — is this a PACKAGED (npm-global `loomctl`) install, vs a from-source/monorepo dev daemon?
 * Load-bearing for the UI update flow: an `npm i -g loomctl@<tag>` reinstall is valid ONLY for a packaged
 * install — npm-installing OVER a checkout would be wrong — so the registry-check, the "update available"
 * banner, and the update&restart endpoint are all gated to packaged installs (a source daemon refuses).
 *
 * Detection reuses the umbrella walk-up: a packaged install resolves the published "loomctl" package.json
 * (sits above the bundled daemon); the dev monorepo resolves the root "loom" package.json. The
 * `LOOM_PACKAGED` env (1/0) is an explicit override — the escape hatch for a packaging shape the walk-up
 * can't classify, and the seam a hermetic test uses to exercise BOTH paths in one process (mirrors
 * `LOOM_VERSION`). Read at CALL time (like paths.ts's `isLoomDev`) so the override + a relocated dist both
 * reflect immediately; the walk is cheap and called only on a slow watcher tick / a human REST request.
 */
export function isPackagedInstall(): boolean {
  const override = process.env.LOOM_PACKAGED;
  if (override === "1") return true;
  if (override === "0") return false;
  return resolveUmbrellaPackage()?.name === "loomctl";
}

/**
 * The umbrella package root directory (where `package.json` + `bin/loom.mjs` live), or null if the walk-up
 * finds nothing. The self-update spawns `node <dir>/bin/loom.mjs update` — resolving the bin via this walk
 * (rather than a fixed relative path) works in BOTH the monorepo and the packaged form, whose dist sits at
 * different depths below the package root.
 */
export function umbrellaRootDir(): string | null {
  return resolveUmbrellaPackage()?.dir ?? null;
}
