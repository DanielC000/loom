import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5eace211 — every project's Loom-owned, shared work dir (paths.ts). Pure-seam + real-fs hermetic
// test, mirroring scratch-gc-sweep-outcome.mjs's own tmp-LOOM_HOME pattern.
//
// Proves:
//   (0) PROJECTS_WORK_ROOT is a SIBLING of LOOM_HOME (never nested inside it) by default — the
//       @decision sha:e1c6ef65 shape WORKTREES_DIR already established, mirrored here deliberately.
//   (1) `projectWorkDir(id)` is a pure join of the root + id — rename-safe (keyed on id, not name).
//   (2) `projectWorkDirEnv(id)` is PURE — calling it never touches disk (no mkdir), unlike
//       `ensureProjectWorkDir`, which does.
//   (3) `ensureProjectWorkDir` creates the dir + writes a marker when given a name, and leaves an
//       EXISTING marker untouched when called again with no name (never clobbers a good name with null).
//   (4) a local synchronous ground-truth byte-sum (this file's own helper — the production equivalent,
//       `measureProjectsWorkRootBytes`, was test-only and moved out of src/paths.ts, card 5eace211 Code
//       Review MINOR 8) sums real on-disk bytes under a given root, scoped — a sibling project's bytes
//       never leak into another project's count.
//   (5) `deleteProjectWorkDir` removes the whole dir, best-effort (never throws on a dir that doesn't
//       exist), ASYNC (card 5eace211 Code Review MAJOR), and REFUSES a non-UUID-shaped or traversal-
//       shaped projectId outright (leaving whatever's there untouched).
//   (6) `LOOM_PROJECT_WORK_ROOT` overrides the default root — proven via a real child process (the root
//       is a module-level `const`, computed once at import time, so the override must be set BEFORE
//       paths.js is ever imported in that process).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-work-dir.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pwd-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Card 5eace211 (Code Review, CRITICAL): clear any AMBIENT LOOM_PROJECT_WORK_ROOT (a human may set this
// to point at the REAL shared project-work-dir root — Decision 2) BEFORE importing dist/paths.js, which
// reads it at module load. Falling through to the default derives PROJECTS_WORK_ROOT as a sibling of
// `tmpHome` above instead — this whole file's own ensure/measure/delete calls below then mutate only
// that throwaway sibling, never a human's real one.
delete process.env.LOOM_PROJECT_WORK_ROOT;

const { requireHermeticEnv, assertUnderOsTmpdir } = await import("./_guard.mjs");
requireHermeticEnv(); // confirms LOOM_HOME (and, now, LOOM_PROJECT_WORK_ROOT if still ambient) are isolated

const {
  PROJECTS_WORK_ROOT,
  projectWorkDir,
  projectWorkDirMarkerPath,
  ensureProjectWorkDir,
  projectWorkDirEnv,
  deleteProjectWorkDir,
} = await import("../dist/paths.js");
const { WORKTREES_DIR, LOOM_HOME } = await import("../dist/paths.js");

// Card 5eace211 Code Review MINOR 8: `measureProjectsWorkRootBytes` was test-only (its own doc said so)
// and moved out of src/paths.ts entirely — this is the SAME synchronous ground-truth recursive sum,
// local to this file (its only real consumer), so production code carries no test-only export.
function measureProjectsWorkRootBytesSync(root) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += measureProjectsWorkRootBytesSync(full);
    } else if (entry.isFile()) {
      try { total += fs.statSync(full).size; } catch { /* best-effort */ }
    }
  }
  return total;
}

// Card 5eace211 (Code Review, CRITICAL): assert this is GENUINELY a temp-derived root before it's ever
// registered for recursive removal below — defense in depth on top of the delete+requireHermeticEnv
// above, in case a future edit to this file ever reorders past that pin.
assertUnderOsTmpdir("PROJECTS_WORK_ROOT", PROJECTS_WORK_ROOT);
const cleanupRoots = [PROJECTS_WORK_ROOT];

try {
  // ── (0) sibling, never nested ──────────────────────────────────────────────────────────────────────
  check("(0) PROJECTS_WORK_ROOT is NOT nested inside LOOM_HOME", !PROJECTS_WORK_ROOT.startsWith(LOOM_HOME + path.sep));
  check("(0) PROJECTS_WORK_ROOT is a SIBLING of LOOM_HOME (same parent dir)", path.dirname(PROJECTS_WORK_ROOT) === path.dirname(LOOM_HOME));
  check("(0) PROJECTS_WORK_ROOT differs from WORKTREES_DIR (distinct sibling roots)", PROJECTS_WORK_ROOT !== WORKTREES_DIR);
  check("(0) PROJECTS_WORK_ROOT basename carries '-projects'", path.basename(PROJECTS_WORK_ROOT).endsWith("-projects"));

  // ── (1) projectWorkDir is a pure id-keyed join ─────────────────────────────────────────────────────
  // Card 5eace211 Code Review: `deleteProjectWorkDir`'s own hardening (section (5) below) refuses a
  // non-UUID-shaped id outright (logs a warning, never throws) — these must be real UUID-shaped strings
  // or section (5)'s removal assertion fails for a reason that has nothing to do with the behavior it's
  // meant to prove.
  const idA = "aaaaaaaa-1111-4111-8111-111111111111";
  const idB = "bbbbbbbb-2222-4222-8222-222222222222";
  check("(1) projectWorkDir(id) joins the root + id", projectWorkDir(idA) === path.join(PROJECTS_WORK_ROOT, idA));
  check("(1) two different ids resolve to two different dirs", projectWorkDir(idA) !== projectWorkDir(idB));

  // ── (2) projectWorkDirEnv is PURE — no disk I/O ────────────────────────────────────────────────────
  check("(2) projectWorkDirEnv(id) does NOT create the dir (purity)", !fs.existsSync(projectWorkDir(idA)));
  const env = projectWorkDirEnv(idA);
  check("(2) projectWorkDirEnv returns LOOM_PROJECT_WORK_DIR === projectWorkDir(id)", env.LOOM_PROJECT_WORK_DIR === projectWorkDir(idA));
  check("(2) calling projectWorkDirEnv STILL never created the dir", !fs.existsSync(projectWorkDir(idA)));

  // ── (3) ensureProjectWorkDir: mkdir + marker, non-destructive name refresh ────────────────────────
  ensureProjectWorkDir(idA, "Alpha Project");
  check("(3) ensureProjectWorkDir creates the dir", fs.existsSync(projectWorkDir(idA)) && fs.statSync(projectWorkDir(idA)).isDirectory());
  const marker1 = JSON.parse(fs.readFileSync(projectWorkDirMarkerPath(idA), "utf8"));
  check("(3) marker carries the given id + name", marker1.id === idA && marker1.name === "Alpha Project");

  // Calling again with NO name must NOT clobber the existing marker's name with null.
  ensureProjectWorkDir(idA, undefined);
  const marker2 = JSON.parse(fs.readFileSync(projectWorkDirMarkerPath(idA), "utf8"));
  check("(3) ensureProjectWorkDir with no name leaves an EXISTING marker's name untouched (never nulled)", marker2.name === "Alpha Project");

  // Calling again WITH a new name (a rename) DOES refresh it.
  ensureProjectWorkDir(idA, "Alpha Project Renamed");
  const marker3 = JSON.parse(fs.readFileSync(projectWorkDirMarkerPath(idA), "utf8"));
  check("(3) ensureProjectWorkDir WITH a new name refreshes the marker (a rename reaches it)", marker3.name === "Alpha Project Renamed");
  check("(3) idempotent re-create doesn't throw / still exists", fs.existsSync(projectWorkDir(idA)));

  // ── (4) local ground-truth byte-sum, scoped per project ───────────────────────────────────────────
  ensureProjectWorkDir(idB, "Beta Project");
  fs.writeFileSync(path.join(projectWorkDir(idA), "a.bin"), Buffer.alloc(1000, 1));
  fs.writeFileSync(path.join(projectWorkDir(idB), "b.bin"), Buffer.alloc(2500, 2));
  const bytesA = measureProjectsWorkRootBytesSync(projectWorkDir(idA));
  const bytesB = measureProjectsWorkRootBytesSync(projectWorkDir(idB));
  // Each dir also carries its own small marker file, so assert >= the payload size, not equality.
  check("(4) measureProjectsWorkRootBytesSync(A) counts A's own payload, NOT B's (scoped, not root-wide)", bytesA >= 1000 && bytesA < 2000);
  check("(4) measureProjectsWorkRootBytesSync(B) counts B's own payload, NOT A's", bytesB >= 2500 && bytesB < 3500);
  const bytesRoot = measureProjectsWorkRootBytesSync(PROJECTS_WORK_ROOT);
  check("(4) measureProjectsWorkRootBytesSync(root) sums BOTH A and B", bytesRoot >= bytesA + bytesB);
  check("(4) an unreadable/missing dir contributes 0, not a thrown error", measureProjectsWorkRootBytesSync(path.join(PROJECTS_WORK_ROOT, "does-not-exist")) === 0);

  // ── (5) deleteProjectWorkDir — ASYNC, best-effort removal ─────────────────────────────────────────
  await deleteProjectWorkDir(idA);
  check("(5) deleteProjectWorkDir actually removes the dir", !fs.existsSync(projectWorkDir(idA)));
  check("(5) B's dir is untouched by deleting A's (scoped, not root-wide)", fs.existsSync(projectWorkDir(idB)));
  // Never throws/rejects on an ALREADY-missing dir (best-effort contract).
  let threw = false;
  try { await deleteProjectWorkDir(idA); } catch { threw = true; }
  check("(5) deleting an already-missing project work dir does NOT throw", threw === false);

  // ── (5b) deleteProjectWorkDir's REFUSAL branch (card 5eace211 Code Review MINOR 5) ────────────────
  // A non-UUID-shaped id is refused outright (logged, never thrown) — whatever's on disk at the
  // COMPUTED path (there's no real project by this name, but prove the refusal itself, not just its
  // absence) is left untouched. Uses a real dir created directly (bypassing ensureProjectWorkDir, which
  // has no such shape requirement) so there's something concrete to prove survives.
  const nonUuidId = "not-a-real-uuid";
  const nonUuidDir = projectWorkDir(nonUuidId);
  fs.mkdirSync(nonUuidDir, { recursive: true });
  fs.writeFileSync(path.join(nonUuidDir, "canary.bin"), Buffer.alloc(100, 9));
  await deleteProjectWorkDir(nonUuidId);
  check("(5b) a non-UUID-shaped id is REFUSED — the dir survives untouched", fs.existsSync(nonUuidDir) && fs.existsSync(path.join(nonUuidDir, "canary.bin")));

  // A traversal-shaped id (resolves OUTSIDE PROJECTS_WORK_ROOT via `path.join`) is refused too — proven
  // against a real canary file placed at the ESCAPE TARGET itself (a sibling of PROJECTS_WORK_ROOT),
  // never merely "nothing happened", which could just as well mean a wrong computed path.
  const escapeTargetDir = path.join(path.dirname(PROJECTS_WORK_ROOT), "escape-target-canary");
  fs.mkdirSync(escapeTargetDir, { recursive: true });
  fs.writeFileSync(path.join(escapeTargetDir, "canary.bin"), Buffer.alloc(100, 9));
  cleanupRoots.push(escapeTargetDir);
  const traversalId = path.join("..", path.basename(escapeTargetDir));
  // Precondition: projectWorkDir(traversalId) really does resolve OUTSIDE PROJECTS_WORK_ROOT (the exact
  // shape deleteProjectWorkDir's own path.relative/".."-prefix check exists to catch) — otherwise this
  // section would pass vacuously regardless of whether the guard does anything at all.
  check("(5b) precondition — the traversal id's computed path genuinely escapes PROJECTS_WORK_ROOT", projectWorkDir(traversalId) === escapeTargetDir);
  await deleteProjectWorkDir(traversalId);
  check("(5b) a traversal-shaped id is REFUSED — the escape target survives untouched", fs.existsSync(escapeTargetDir) && fs.existsSync(path.join(escapeTargetDir, "canary.bin")));

  // ── (6) LOOM_PROJECT_WORK_ROOT override — proven via a real child process ─────────────────────────
  const overrideHome = path.join(os.tmpdir(), `loom-pwd-override-home-${Date.now()}-${randomUUID()}`);
  const overrideRoot = path.join(os.tmpdir(), `loom-pwd-override-root-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(overrideHome, { recursive: true });
  cleanupRoots.push(overrideHome, overrideRoot);
  // CLAUDE.md gotcha: a bare drive-letter path in a dynamic import() throws ERR_UNSUPPORTED_ESM_URL_SCHEME
  // on Windows — pass the file:// URL itself (never fileURLToPath'd) into the probe script's import.
  const probeScript =
    `import {PROJECTS_WORK_ROOT} from ${JSON.stringify(new URL("../dist/paths.js", import.meta.url).href)};` +
    `process.stdout.write(PROJECTS_WORK_ROOT);`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", probeScript], {
    env: { ...process.env, LOOM_HOME: overrideHome, LOOM_PROJECT_WORK_ROOT: overrideRoot },
    encoding: "utf8",
  });
  check("(6) LOOM_PROJECT_WORK_ROOT overrides the computed default root", out.trim() === overrideRoot);

  // Negative control for (6): WITHOUT the override env var, the SAME child process computes the
  // ordinary sibling-of-LOOM_HOME default instead — proves the override isn't a no-op that always wins.
  const outNoOverride = execFileSync(process.execPath, ["--input-type=module", "-e", probeScript], {
    env: { ...process.env, LOOM_HOME: overrideHome, LOOM_PROJECT_WORK_ROOT: "" },
    encoding: "utf8",
  });
  check("(6 — negative control) with NO override set, the default sibling root is computed instead", outNoOverride.trim() === path.join(path.dirname(overrideHome), `${path.basename(overrideHome)}-projects`) && outNoOverride.trim() !== overrideRoot);
} finally {
  for (const root of cleanupRoots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PROJECTS_WORK_ROOT is a sibling of LOOM_HOME (never nested), projectWorkDir is a pure id-keyed join, projectWorkDirEnv is pure (no disk I/O), ensureProjectWorkDir creates the dir and refreshes its marker non-destructively (a rename reaches it, a no-name call never nulls an existing one), a local ground-truth sum counts real bytes scoped correctly, deleteProjectWorkDir removes scoped and best-effort (async) while REFUSING a non-UUID-shaped or traversal-shaped id outright (leaving a real canary untouched), and LOOM_PROJECT_WORK_ROOT overrides the default root in a real child process."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
