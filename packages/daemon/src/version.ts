import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The SINGLE source of truth for the user-facing Loom version = the published `loom` package's
 * `version` (the umbrella root package.json — internal `@loom/*` packages stay private `0.0.0`).
 * Read at RUNTIME so there is never a second hardcoded copy that can drift from package.json.
 *
 * Resolution — chosen so it works in BOTH forms with no code change (⚠️ Part 2 must preserve this,
 * since the packaged npm form moves where this file lives):
 *   0. `LOOM_VERSION` env — explicit override (highest priority), the escape hatch for any packaging
 *      shape that can't place a `name:"loom"` package.json on the walk-up path.
 *   1. Walk UP from THIS built file looking for the FIRST package.json whose `name === "loom"`, and
 *      return its `version`. This resolves:
 *        - monorepo: dist/version.js → … → repo-root package.json (name "loom", the real version);
 *        - packaged npm form: the published `loom` package's own root package.json sits ABOVE the
 *          bundled daemon, so the same upward walk finds it.
 *   2. Fallback `"0.0.0"` if nothing is found (a dev/dist edge case — never crashes the boot).
 */
function readLoomVersion(): string {
  const override = process.env.LOOM_VERSION;
  if (override && override.trim()) return override.trim();
  let dir = __dirname;
  // Bounded walk to the filesystem root — the umbrella package.json is only a few levels up in either form.
  for (let i = 0; i < 12; i++) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "loom" && typeof pkg.version === "string") return pkg.version;
      }
    } catch { /* skip an unreadable/malformed package.json and keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  return "0.0.0";
}

// The package.json never changes during a daemon run, so resolve once and cache.
let cached: string | null = null;

/** The user-facing Loom version (the `loom` umbrella package version), resolved at runtime + cached. */
export function loomVersion(): string {
  if (cached === null) cached = readLoomVersion();
  return cached;
}
