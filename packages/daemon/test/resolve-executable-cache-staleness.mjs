import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8e08eec1: resolveExecutable (pty/resolve-bin.ts) caches a resolved bare-name -> absolute-path hit
// for the life of the process, with NO re-verification. registry.ts's resolveCapabilityServer re-runs
// resolveExecutable on every spawn specifically so a bundled/"command" capability's bare PATH-searched
// name (e.g. an npx shim managed by fnm/nvm/volta) self-heals if the real binary moves, is uninstalled,
// or becomes available later — but that re-run was defeated one layer down by resolveExecutable's own
// cache, which served the first hit forever even after the file on disk was gone.
//
// Hermetic: every binary here is a throwaway empty file under a per-run temp dir, named with this
// process's own pid to avoid collision with anything real on PATH. Never depends on, or assumes the
// presence/absence of, any real installed tool.
//
// Run: 1) build (turbo builds shared first), 2) node test/resolve-executable-cache-staleness.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-resolvebin-"));
const dirA = path.join(tmpRoot, "a");
const dirB = path.join(tmpRoot, "b");
fs.mkdirSync(dirA, { recursive: true });
fs.mkdirSync(dirB, { recursive: true });

const sep = process.platform === "win32" ? ";" : ":";
const ext = process.platform === "win32" ? ".CMD" : "";

// Preserve + restore whichever PATH env var key this process actually uses (Windows can carry "Path").
const pathKey = process.env.PATH !== undefined ? "PATH" : "Path";
const origPath = process.env[pathKey] ?? "";

try {
  // --- Case 1: the cached binary is DELETED outright, nowhere else on PATH. -----------------------
  const binDeleted = `loomrbtest-deleted-${process.pid}`;
  const fileDeletedA = path.join(dirA, binDeleted + ext);
  process.env[pathKey] = [dirA, origPath].join(sep);
  fs.writeFileSync(fileDeletedA, "");

  const firstDeleted = resolveExecutable(binDeleted);
  check(`(setup) first resolution finds the real binary (${firstDeleted})`, firstDeleted === fileDeletedA);

  fs.rmSync(fileDeletedA);
  const afterDeleted = resolveExecutable(binDeleted);
  check(
    `after the cached binary is deleted, resolveExecutable does NOT keep serving the now-dead cached path (got "${afterDeleted}")`,
    afterDeleted !== fileDeletedA,
  );
  check(
    `after deletion with nowhere else on PATH, resolveExecutable falls back to the bare, unresolved name (got "${afterDeleted}")`,
    afterDeleted === binDeleted,
  );

  // --- Case 2: the cached binary MOVES from dirA to dirB (the fnm/nvm/volta-shim-relocates shape). --
  const binMoved = `loomrbtest-moved-${process.pid}`;
  const fileMovedA = path.join(dirA, binMoved + ext);
  const fileMovedB = path.join(dirB, binMoved + ext);
  fs.writeFileSync(fileMovedA, "");

  const firstMoved = resolveExecutable(binMoved);
  check(`(setup) second binary resolves to dirA first (${firstMoved})`, firstMoved === fileMovedA);

  fs.rmSync(fileMovedA);
  fs.writeFileSync(fileMovedB, "");
  process.env[pathKey] = [dirA, dirB, origPath].join(sep);

  const afterMoved = resolveExecutable(binMoved);
  check(
    `after the binary moves from dirA to dirB, resolveExecutable re-resolves to the NEW location instead of the stale dead dirA path (got "${afterMoved}")`,
    afterMoved === fileMovedB,
  );

  // --- Positive control: a genuinely still-valid, untouched cache entry stays correct. --------------
  const stillWarm = resolveExecutable(binMoved);
  check(`a still-valid cache entry keeps resolving correctly on a second call (${stillWarm})`, stillWarm === fileMovedB);
} finally {
  process.env[pathKey] = origPath;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resolveExecutable re-verifies a cached hit with existsSync and re-resolves a moved/deleted binary instead of serving a stale path forever."
  : `\n❌ ${failures} FAILURE(S) — resolveExecutable served a stale cached path for a binary that moved or was deleted. See docs/decisions/8e08eec1-resolveexecutable-cache-revalidates-on-hit.md.`);
process.exit(failures === 0 ? 0 : 1);
